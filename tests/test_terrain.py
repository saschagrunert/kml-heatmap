"""Tests for the ground under the flights (kml_heatmap.terrain).

No test reaches the network: the tiles are made here, as PNGs written by a
small encoder of this file with every filter type, or answered by a tile
source of the test's own. conftest.py makes any download fail loudly.
"""

import http.client
import io
import logging
import math
import os
import re
import struct
import urllib.error
import zlib
from array import array
from concurrent.futures.process import BrokenProcessPool
from email.message import Message
from pathlib import Path
from unittest.mock import MagicMock

import pytest

import kml_heatmap.terrain as terrain_module
from kml_heatmap.constants import METERS_TO_FEET
from kml_heatmap.segment_codec import (
    ALTITUDE_STEP,
    COORDINATE_SCALE,
    FORMAT_VERSION,
    GROUND_STEP,
    SPEED_SCALE,
    TIME_SCALE,
)
from kml_heatmap.terrain import (
    TERRAIN_ZOOM,
    TILE_SIZE,
    FlatTiles,
    PngError,
    TerrariumTiles,
    TileKey,
    decode_png,
    decode_tile_pixels,
    elevations_by_coordinate,
    ground_profile_ft,
    sample_elevations,
    sample_path_elevations,
    terrarium_elevation,
)
from kml_heatmap.types import TrackPoint

# --- A PNG encoder, the decoder's counterpart ---------------------------


def _paeth(a: int, b: int, c: int) -> int:
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    return b if pb <= pc else c


def _filtered(line: bytes, previous: bytes, kind: int, bpp: int) -> bytes:
    out = bytearray()
    for i, x in enumerate(line):
        a = line[i - bpp] if i >= bpp else 0
        b = previous[i]
        c = previous[i - bpp] if i >= bpp else 0
        predictor = (0, a, b, (a + b) // 2, _paeth(a, b, c))[kind]
        out.append((x - predictor) & 0xFF)
    return bytes(out)


def _chunk(kind: bytes, body: bytes) -> bytes:
    return (
        struct.pack(">I", len(body))
        + kind
        + body
        + struct.pack(">I", zlib.crc32(kind + body))
    )


def encode_png(
    width,
    height,
    pixels,
    *,
    channels=3,
    filters=(0, 1, 2, 3, 4),
    header=None,
    raw=None,
):
    """A PNG of 8-bit ``pixels``, line ``y`` filtered with ``filters[y % n]``.

    ``header`` replaces the IHDR fields and ``raw`` the filtered image data,
    for the PNGs the decoder has to refuse.
    """
    stride = width * channels
    if raw is None:
        raw = bytearray()
        previous = bytes(stride)
        for y in range(height):
            line = bytes(pixels[y * stride : (y + 1) * stride])
            kind = filters[y % len(filters)]
            raw += bytes([kind]) + _filtered(line, previous, kind, channels)
            previous = line
    colour = {3: 2, 4: 6}.get(channels, 0)
    fields = header or (width, height, 8, colour, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + _chunk(b"IHDR", struct.pack(">IIBBBBB", *fields))
        + _chunk(b"tEXt", b"Comment\x00made by the test")
        + _chunk(b"IDAT", zlib.compress(bytes(raw))[:10])
        + _chunk(b"IDAT", zlib.compress(bytes(raw))[10:])
        + _chunk(b"IEND", b"")
    )


def _noise(count, seed=7):
    """Bytes that exercise every predictor, reproducibly."""
    value = seed
    out = bytearray()
    for _ in range(count):
        value = (value * 1103515245 + 12345) & 0x7FFFFFFF
        out.append(value >> 16 & 0xFF)
    return bytes(out)


def terrarium_png(elevation_of, channels=3):
    """A Terrarium tile whose pixel (x, y) encodes ``elevation_of(x, y)``."""
    pixels = bytearray()
    for y in range(TILE_SIZE):
        for x in range(TILE_SIZE):
            value = elevation_of(x, y) + 32768
            red = int(value // 256)
            green = int(value % 256)
            blue = round((value - math.floor(value)) * 256)
            pixels += bytes([red, green, blue, 255][:channels])
    return encode_png(TILE_SIZE, TILE_SIZE, pixels, channels=channels)


# --- Tile sources of the tests ------------------------------------------


class FunctionTiles:
    """Every pixel at ``elevation(gx, gy)``, of its global pixel position.

    ``missing`` tiles are left out of the answer. The tiles asked for are
    kept in ``asked``.
    """

    def __init__(self, elevation, missing=()):
        self.elevation = elevation
        self.missing = set(missing)
        self.asked = []

    def pixels(self, wanted):
        self.asked.append(dict(wanted))
        return {
            tile: [
                self.elevation(
                    tile.x * TILE_SIZE + index % TILE_SIZE,
                    tile.y * TILE_SIZE + index // TILE_SIZE,
                )
                for index in indices
            ]
            for tile, indices in wanted.items()
            if tile not in self.missing
        }


def _global_pixel(lat, lon, zoom=TERRAIN_ZOOM):
    """Where a point is in global pixels, measured from the pixel centres."""
    world = TILE_SIZE << zoom
    sin = math.sin(math.radians(lat))
    x = (lon + 180) / 360 * world - 0.5
    y = (0.5 - math.log((1 + sin) / (1 - sin)) / (4 * math.pi)) * world - 0.5
    return x, y


def _lon_of_pixel(gx, zoom=TERRAIN_ZOOM):
    """The longitude of a global pixel column's centre."""
    return (gx + 0.5) / (TILE_SIZE << zoom) * 360 - 180


# --- PNG ----------------------------------------------------------------


class TestDecodePng:
    @pytest.mark.parametrize("channels", [3, 4])
    @pytest.mark.parametrize("kind", [0, 1, 2, 3, 4])
    def test_every_filter_type(self, kind, channels):
        width, height = 7, 5
        pixels = _noise(width * height * channels)
        data = encode_png(width, height, pixels, channels=channels, filters=(kind,))

        assert decode_png(data) == (width, height, channels, bytearray(pixels))

    @pytest.mark.parametrize("channels", [3, 4])
    def test_filter_types_mixed_line_by_line(self, channels):
        width, height = 9, 11
        pixels = _noise(width * height * channels, seed=3)
        data = encode_png(width, height, pixels, channels=channels)

        assert decode_png(data)[3] == bytearray(pixels)

    @pytest.mark.parametrize(
        ("header", "message"),
        [
            ((2, 2, 16, 2, 0, 0, 0), "bit depth 16"),
            ((2, 2, 8, 3, 0, 0, 0), "colour type 3"),
            ((2, 2, 8, 0, 0, 0, 0), "colour type 0"),
            ((2, 2, 8, 2, 0, 0, 1), "interlaced"),
            ((2, 2, 8, 2, 1, 0, 0), "compression or filter"),
            ((2, 2, 8, 2, 0, 1, 0), "compression or filter"),
            ((0, 2, 8, 2, 0, 0, 0), "no pixels"),
        ],
    )
    def test_refuses_what_it_does_not_read(self, header, message):
        data = encode_png(2, 2, bytes(12), header=header)

        with pytest.raises(PngError, match=message):
            decode_png(data)

    def test_refuses_what_is_not_a_png(self):
        with pytest.raises(PngError, match="not a PNG"):
            decode_png(b"GIF89a")

    def test_refuses_a_corrupt_chunk(self):
        data = bytearray(encode_png(2, 2, bytes(12)))
        # A byte of the IHDR body, which its CRC no longer matches
        data[20] ^= 0xFF

        with pytest.raises(PngError, match="corrupt"):
            decode_png(bytes(data))

    @pytest.mark.parametrize("cut", [1, 12, 40])
    def test_refuses_a_cut_off_file(self, cut):
        data = encode_png(2, 2, bytes(12))

        with pytest.raises(PngError, match="IEND"):
            decode_png(data[:-cut])

    def test_refuses_an_unknown_filter_type(self):
        data = encode_png(1, 1, None, raw=b"\x05\x00\x00\x00")

        with pytest.raises(PngError, match="filter type 5"):
            decode_png(data)

    def test_refuses_image_data_of_the_wrong_length(self):
        data = encode_png(2, 2, None, raw=b"\x00" * 7)

        with pytest.raises(PngError, match="wrong length"):
            decode_png(data)

    def test_refuses_a_header_too_large_for_a_tile(self):
        side = terrain_module.MAX_PNG_SIDE + 1
        data = encode_png(2, 2, bytes(12), header=(side, 1, 8, 2, 0, 0, 0))

        with pytest.raises(PngError, match="too large"):
            decode_png(data)

    def test_inflates_no_further_than_the_image(self, monkeypatch):
        """A small bomb of zeros must not inflate beyond the header's size."""
        bomb = zlib.compress(bytes(64 * 1024 * 1024), 9)
        data = (
            b"\x89PNG\r\n\x1a\n"
            + _chunk(b"IHDR", struct.pack(">IIBBBBB", 2, 2, 8, 2, 0, 0, 0))
            + _chunk(b"IDAT", bomb)
            + _chunk(b"IEND", b"")
        )
        inflated = []
        real = zlib.decompressobj

        class Recording:
            def __init__(self):
                self.inner = real()

            def decompress(self, data, max_length=0):
                out = self.inner.decompress(data, max_length)
                inflated.append(len(out))
                return out

        monkeypatch.setattr(zlib, "decompressobj", Recording)

        with pytest.raises(PngError, match="wrong length"):
            decode_png(data)
        # Two lines of a filter byte and two RGB pixels, and one byte more
        assert inflated == [2 * (2 * 3 + 1) + 1]

    def test_refuses_image_data_that_does_not_inflate(self):
        signature = b"\x89PNG\r\n\x1a\n"
        data = (
            signature
            + _chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0))
            + _chunk(b"IDAT", b"not zlib")
            + _chunk(b"IEND", b"")
        )

        with pytest.raises(PngError, match="image data is corrupt"):
            decode_png(data)

    def test_refuses_a_png_without_or_with_a_short_header(self):
        signature = b"\x89PNG\r\n\x1a\n"
        without = signature + _chunk(b"IEND", b"")
        short = signature + _chunk(b"IHDR", b"\x00" * 12) + _chunk(b"IEND", b"")

        with pytest.raises(PngError, match="no header"):
            decode_png(without)
        with pytest.raises(PngError, match="header has the wrong length"):
            decode_png(short)


class TestTerrarium:
    def test_elevation_of_a_pixel(self):
        assert terrarium_elevation(128, 0, 0) == 0
        assert terrarium_elevation(129, 44, 128) == 300.5
        assert terrarium_elevation(127, 255, 0) == -1

    @pytest.mark.parametrize("channels", [3, 4])
    def test_decodes_the_pixels_asked_for(self, channels):
        data = terrarium_png(lambda x, y: x + y * 0.5 - 100, channels)

        values = decode_tile_pixels(data, [0, 1, 256, 256 * 255 + 255])

        assert values == [-100, -99, -99.5, 282.5]

    def test_refuses_a_tile_of_another_size(self):
        data = encode_png(2, 2, bytes(12))

        with pytest.raises(PngError, match="not 256"):
            decode_tile_pixels(data, [0])


# --- Sampling -----------------------------------------------------------


class TestSampleElevations:
    def test_bilinear_between_pixel_centres(self):
        # A plane: bilinear interpolation reproduces it exactly
        source = FunctionTiles(lambda gx, gy: 2.0 * gx - 3.0 * gy)
        points = [(50.0, 8.0), (51.12345, 9.87654), (-33.9, 151.2)]

        elevations, tiles, missing = sample_elevations(points, source)

        for (lat, lon), elevation in zip(points, elevations, strict=True):
            x, y = _global_pixel(lat, lon)
            assert elevation == pytest.approx(2 * x - 3 * y, abs=1e-6)
        assert (tiles, missing) == (len(source.asked[0]), 0)

    def test_across_a_tile_edge(self):
        source = FunctionTiles(lambda gx, gy: float(gx))
        # Half way between the last column of one tile and the first of the
        # next: the two pixels are in different tiles
        edge = 546 * TILE_SIZE
        lon = (_lon_of_pixel(edge - 1) + _lon_of_pixel(edge)) / 2

        elevations, tiles, _ = sample_elevations([(50.0, lon)], source)

        assert elevations[0] == pytest.approx(edge - 0.5)
        assert {tile.x for tile in source.asked[0]} == {545, 546}
        assert tiles == len(source.asked[0])

    def test_across_the_antimeridian(self):
        world = TILE_SIZE << TERRAIN_ZOOM
        source = FunctionTiles(lambda gx, gy: 100.0 if gx == world - 1 else 0.0)

        elevations, _, _ = sample_elevations([(0.0, 180.0)], source)

        # Half way between the last column and the first, which wraps
        assert elevations[0] == pytest.approx(50.0)
        assert {tile.x for tile in source.asked[0]} == {0, (world - 1) // TILE_SIZE}

    def test_beyond_the_mercator_square(self):
        source = FunctionTiles(lambda gx, gy: float(gy))

        elevations, _, _ = sample_elevations([(89.0, 0.0), (-89.0, 0.0)], source)

        # The edge rows stand in for the ones beyond
        world = TILE_SIZE << TERRAIN_ZOOM
        assert elevations[0] == pytest.approx(0.0, abs=0.5)
        assert elevations[1] == pytest.approx(world - 1, abs=0.5)

    def test_leaves_out_what_a_missing_tile_covers(self):
        covered = (50.0, 8.0)
        uncovered = (50.0, 12.0)
        x, y = _global_pixel(*uncovered)
        missing = TileKey(TERRAIN_ZOOM, int(x) // TILE_SIZE, int(y) // TILE_SIZE)
        source = FunctionTiles(lambda gx, gy: 1.0, missing=[missing])

        elevations, tiles, count = sample_elevations([covered, uncovered], source)

        assert elevations[0] == 1.0
        assert math.isnan(elevations[1])
        assert count >= 1
        assert tiles == len(source.asked[0])

    def test_asks_for_every_pixel_once(self):
        source = FunctionTiles(lambda gx, gy: 1.0)

        sample_elevations([(50.0, 8.0), (50.0, 8.0), (50.00001, 8.0)], source)

        for indices in source.asked[0].values():
            assert len(indices) == len(set(indices))

    def test_flat_tiles(self):
        elevations, _, missing = sample_elevations([(50.0, 8.0)], FlatTiles(123.0))

        assert list(elevations) == [123.0]
        assert missing == 0


class TestSamplePathElevations:
    def test_one_elevation_per_point_keyed_by_path(self):
        paths = {
            3: [TrackPoint(50.000001, 8.0, 100.0), TrackPoint(50.1, 8.1, 200.0)],
            7: [TrackPoint(51.0, 9.0, 100.0)],
        }

        by_path = sample_path_elevations(paths, FlatTiles(42.0))

        assert {index: list(values) for index, values in by_path.items()} == {
            3: [42.0, 42.0],
            7: [42.0],
        }

    def test_by_coordinate_as_the_rows_carry_it(self):
        path = [
            TrackPoint(50.000001, 8.0, 100.0),
            TrackPoint(50.1, 8.1, 200.0),
            TrackPoint(50.2, 8.2, 200.0),
        ]

        by_coordinate = elevations_by_coordinate(path, array("d", [1.0, 2.0, math.nan]))

        # Rounded like the rows, and without the point the tiles miss
        assert by_coordinate == {(50.0, 8.0): 1.0, (50.1, 8.1): 2.0}

    def test_the_same_elevations_as_one_coordinate_at_a_time(self):
        """Points in one tile, across tile edges and repeated, alike."""
        source = FunctionTiles(lambda gx, gy: math.sin(gx / 7.0) * 300 + gy % 13)
        edge = 546 * TILE_SIZE
        lons = [
            8.0,
            8.0,
            _lon_of_pixel(edge - 1),
            (_lon_of_pixel(edge - 1) + _lon_of_pixel(edge)) / 2,
            8.3,
            180.0,
            -179.99,
        ]
        points = [(50.0 + i * 0.013, lon) for i, lon in enumerate(lons)]

        together, _, _ = sample_elevations(points, source)

        world = TILE_SIZE << TERRAIN_ZOOM

        def at(gx, gy):
            return source.elevation(gx % world, gy)

        for point, elevation in zip(points, together, strict=True):
            alone, _, _ = sample_elevations([point], source)
            assert elevation == alone[0]
            x, y = _global_pixel(*point)
            left, top = math.floor(x), math.floor(y)
            tx, ty = x - left, y - top
            upper = at(left, top) + (at(left + 1, top) - at(left, top)) * tx
            lower = at(left, top + 1) + (at(left + 1, top + 1) - at(left, top + 1)) * tx
            assert elevation == upper + (lower - upper) * ty

    def test_warns_once_about_missing_tiles(self, caplog):
        paths = {1: [TrackPoint(50.0, 8.0, 0.0)], 2: [TrackPoint(50.0, 12.0, 0.0)]}
        x, y = _global_pixel(50.0, 12.0)
        missing = TileKey(TERRAIN_ZOOM, int(x) // TILE_SIZE, int(y) // TILE_SIZE)

        with caplog.at_level(logging.WARNING, logger="kml_heatmap"):
            by_path = sample_path_elevations(
                paths, FunctionTiles(lambda gx, gy: 5.0, missing=[missing])
            )

        assert list(by_path) == [1]
        warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
        assert len(warnings) == 1
        assert "1 flight(s)" in warnings[0].getMessage()


# --- Tiles from AWS -----------------------------------------------------


def _response(body):
    response = MagicMock()
    response.read.return_value = body
    response.__enter__.return_value = response
    return response


def _tile_png(elevation=250.0):
    return terrarium_png(lambda x, y: elevation)


class TestTerrariumTiles:
    def test_fetches_a_tile_once_and_reuses_the_cache(self, tmp_path, monkeypatch):
        body = _tile_png(250.0)
        fetch = MagicMock(return_value=_response(body))
        monkeypatch.setattr(terrain_module, "urlopen", fetch)
        tiles = TerrariumTiles(tmp_path / "terrain")
        tile = TileKey(10, 546, 341)

        first = tiles.pixels({tile: [0, 65535]})
        second = TerrariumTiles(tmp_path / "terrain").pixels({tile: [7]})

        assert first == {tile: array("d", [250.0, 250.0])}
        assert second == {tile: array("d", [250.0])}
        fetch.assert_called_once()
        request = fetch.call_args.args[0]
        assert request.full_url.endswith("/terrarium/10/546/341.png")
        assert request.get_header("User-agent").startswith("kml-heatmap/")
        assert fetch.call_args.kwargs["timeout"] > 0
        assert tiles.path(tile).read_bytes() == body

    def test_a_tile_the_host_does_not_have_is_missing(self, tmp_path, monkeypatch):
        def fetch(request, **kwargs):
            if request.full_url.endswith("/1/1.png"):
                raise urllib.error.HTTPError(
                    request.full_url, 403, "Forbidden", Message(), io.BytesIO()
                )
            return _response(_tile_png(10.0))

        monkeypatch.setattr(terrain_module, "urlopen", fetch)
        wanted = {TileKey(10, 1, 1): [0], TileKey(10, 2, 1): [0]}

        answered = TerrariumTiles(tmp_path).pixels(wanted)

        assert answered == {TileKey(10, 2, 1): array("d", [10.0])}

    @pytest.mark.parametrize(
        "error",
        [
            urllib.error.URLError("no network"),
            TimeoutError("timed out"),
            http.client.IncompleteRead(b""),
        ],
    )
    def test_offline_stops_asking_and_does_not_fail(self, tmp_path, monkeypatch, error):
        fetch = MagicMock(side_effect=error)
        monkeypatch.setattr(terrain_module, "urlopen", fetch)
        monkeypatch.setattr(terrain_module, "FETCH_WORKERS", 1)
        wanted = {TileKey(10, x, 1): [0] for x in range(5)}

        assert TerrariumTiles(tmp_path).pixels(wanted) == {}
        fetch.assert_called_once()

    @pytest.mark.parametrize(
        "body", [b"<html>not found</html>", b"\x89PNG\r\n\x1a\n" + b"junk"]
    )
    def test_refuses_a_body_that_is_no_tile(self, tmp_path, monkeypatch, body):
        monkeypatch.setattr(
            terrain_module, "urlopen", MagicMock(return_value=_response(body))
        )
        tiles = TerrariumTiles(tmp_path)
        tile = TileKey(10, 1, 1)

        assert tiles.pixels({tile: [0]}) == {}
        # The second is PNG-shaped, and is removed once it fails to decode
        assert not tiles.path(tile).exists()

    def test_refuses_an_oversized_body(self, tmp_path, monkeypatch):
        monkeypatch.setattr(terrain_module, "MAX_TILE_BYTES", 10)
        monkeypatch.setattr(
            terrain_module, "urlopen", MagicMock(return_value=_response(_tile_png()))
        )

        assert TerrariumTiles(tmp_path).pixels({TileKey(10, 1, 1): [0]}) == {}

    def test_an_unwritable_cache_degrades(self, tmp_path, monkeypatch):
        blocker = tmp_path / "file"
        blocker.write_text("")
        fetch = MagicMock()
        monkeypatch.setattr(terrain_module, "urlopen", fetch)

        answered = TerrariumTiles(blocker / "terrain").pixels({TileKey(10, 1, 1): [0]})

        assert answered == {}
        fetch.assert_not_called()

    def test_a_tile_that_cannot_be_stored_is_missing(self, tmp_path, monkeypatch):
        monkeypatch.setattr(
            terrain_module, "urlopen", MagicMock(return_value=_response(_tile_png()))
        )
        monkeypatch.setattr(os, "replace", MagicMock(side_effect=OSError("full")))

        assert TerrariumTiles(tmp_path).pixels({TileKey(10, 1, 1): [0]}) == {}
        assert list(tmp_path.iterdir()) == []

    def test_a_corrupt_cached_tile_is_removed(self, tmp_path):
        tiles = TerrariumTiles(tmp_path)
        tile = TileKey(10, 1, 1)
        tiles.path(tile).write_bytes(_tile_png()[:-20])

        assert tiles.pixels({tile: [0]}) == {}
        assert not tiles.path(tile).exists()

    def test_decodes_many_tiles_in_a_pool(self, tmp_path):
        tiles = TerrariumTiles(tmp_path)
        wanted = {}
        for x in range(terrain_module.DECODE_POOL_MIN_TILES):
            tile = TileKey(10, x, 1)
            tiles.path(tile).write_bytes(_tile_png(float(x)))
            wanted[tile] = [0, 1]

        answered = tiles.pixels(wanted)

        assert answered == {tile: array("d", [tile.x, tile.x]) for tile in wanted}

    @pytest.mark.parametrize(
        "failure",
        [BrokenProcessPool("a worker died"), OSError("no semaphores")],
    )
    def test_a_decoding_pool_that_dies_leaves_the_ground_out(
        self, tmp_path, monkeypatch, caplog, failure
    ):
        tiles = TerrariumTiles(tmp_path)
        # A point in each of as many tiles as start the pool
        points = [
            TrackPoint(50.0, 8.0 + x * 0.5, 0.0)
            for x in range(terrain_module.DECODE_POOL_MIN_TILES)
        ]
        for point in points:
            gx, gy = _global_pixel(point.lat, point.lon)
            tiles.path(
                TileKey(TERRAIN_ZOOM, int(gx) // TILE_SIZE, int(gy) // TILE_SIZE)
            ).write_bytes(_tile_png())
        pool = MagicMock(side_effect=failure)
        monkeypatch.setattr(terrain_module, "ProcessPoolExecutor", pool)

        with caplog.at_level(logging.WARNING, logger="kml_heatmap"):
            by_path = sample_path_elevations({1: points}, tiles)

        assert by_path == {}
        pool.assert_called_once()
        warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
        assert len(warnings) == 1
        assert "could not be decoded" in warnings[0].getMessage()

    def test_a_download_in_a_test_fails_loudly(self, tmp_path):
        # conftest.py refuses every download; the tile code must not swallow
        # that as an offline network
        with pytest.raises(AssertionError, match="network"):
            TerrariumTiles(tmp_path).pixels({TileKey(10, 1, 1): [0]})

    def test_the_default_cache_is_below_the_cache_directory(self):
        from kml_heatmap.cache import CACHE_DIR

        assert TerrariumTiles().cache_dir == CACHE_DIR / "terrain"


# --- The ground of a flight ---------------------------------------------


def _row(lon, altitude_ft, speed, lat=50.0):
    return [lat, lon, altitude_ft, speed]


def _flight(from_ft, to_ft):
    """Taxiing at a field, a flight east, taxiing at another field."""
    return [
        _row(8.01, from_ft, 5),
        _row(8.02, from_ft, 10),
        _row(8.03, from_ft + 100, 8),
        _row(8.04, 3000, 110),
        _row(8.05, 3000, 115),
        _row(8.06, to_ft, 12),
        _row(8.07, to_ft, 6),
        _row(8.08, to_ft, 3),
    ]


def _elevations(rows, metres_of):
    return {(row[0], row[1]): metres_of(row[1]) for row in rows}


START = [50.0, 8.0]


class TestGroundProfile:
    def test_a_flat_model_gives_the_line_between_the_fields(self):
        rows = _flight(400, 2000)

        ground = ground_profile_ft(START, rows, _elevations(rows, lambda lon: 0.0))

        # What groundProfileFt draws without a ground column: the fields at
        # both ends and the line in proportion to the distance between them
        expected = [400 + 1600 * (i + 1) / 8 for i in range(8)]
        assert ground == [round(feet / 10) * 10 for feet in expected]

    def test_follows_the_relief_and_meets_the_fields(self):
        rows = _flight(400, 400)
        # The model is 30 m below the recorded fields and has a ridge between
        ridge = {8.04: 300.0, 8.05: 300.0}
        elevations = _elevations(
            rows, lambda lon: ridge.get(lon, 400 / METERS_TO_FEET - 30)
        )

        ground = ground_profile_ft(START, rows, elevations)

        assert ground is not None
        assert ground[0] == 400
        assert ground[-1] == 400
        # The ridge, lifted by the same 30 m the fields are off by
        assert ground[3] == round((300 + 30) * METERS_TO_FEET / 10) * 10

    def test_shifts_from_the_one_offset_to_the_other(self):
        rows = _flight(400, 1000)

        # The model rises by 100 m from the one field to the other, less
        # than the recorded fields do
        def metres(lon):
            return 0.0 if lon <= 8.03 else 100.0 if lon >= 8.06 else 50.0

        ground = ground_profile_ft(START, rows, _elevations(rows, metres))

        start_offset = 400
        end_offset = 1000 - 100 * METERS_TO_FEET
        expected = [
            metres(row[1]) * METERS_TO_FEET
            + start_offset
            + (end_offset - start_offset) * (i + 1) / 8
            for i, row in enumerate(rows)
        ]
        assert ground == [round(feet / 10) * 10 for feet in expected]
        assert ground[-1] == 1000

    def test_one_field_holds_all_the_way(self):
        rows = _flight(400, 1000)[3:]

        ground = ground_profile_ft(
            [50.0, 8.03], rows, _elevations(rows, lambda lon: 100.0)
        )

        offset = 1000 - 100 * METERS_TO_FEET
        assert ground == [round((100 * METERS_TO_FEET + offset) / 10) * 10] * 5

    def test_without_fields_the_model_is_the_ground(self):
        rows = [_row(8.01 + i / 100, 3000, 110) for i in range(4)]

        ground = ground_profile_ft(START, rows, _elevations(rows, lambda lon: 100.0))

        assert ground == [round(100 * METERS_TO_FEET / 10) * 10] * 4

    def test_a_speed_of_zero_is_no_speed(self):
        # A path without timing: every speed is 0, none of it is taxiing
        rows = [_row(8.01 + i / 100, 3000, 0.0) for i in range(4)]

        ground = ground_profile_ft(START, rows, _elevations(rows, lambda lon: 0.0))

        assert ground == [0, 0, 0, 0]

    def test_too_little_taxiing_is_no_field(self):
        rows = [_row(8.01, 400, 5), _row(8.02, 400, 5), *_flight(0, 0)[3:5]]

        ground = ground_profile_ft(START, rows, _elevations(rows, lambda lon: 0.0))

        assert ground == [0, 0, 0, 0]

    def test_no_ground_with_a_hole_in_the_model(self):
        rows = _flight(400, 400)
        elevations = _elevations(rows, lambda lon: 0.0)
        del elevations[(50.0, 8.05)]

        assert ground_profile_ft(START, rows, elevations) is None

    def test_no_ground_without_rows(self):
        assert ground_profile_ft([], [], {}) is None

    def test_measures_the_way_across_the_antimeridian(self):
        rows = [
            _row(179.99, 400, 5),
            _row(179.995, 400, 5),
            _row(179.999, 400, 5),
            _row(-179.99, 3000, 110),
            _row(-179.98, 1200, 5),
            _row(-179.97, 1200, 5),
            _row(-179.96, 1200, 5),
        ]

        ground = ground_profile_ft(
            [50.0, 179.98], rows, _elevations(rows, lambda lon: 0.0)
        )

        # Seven short legs, not one round the world: the ground climbs
        # steadily rather than jumping to the far field at once
        assert ground is not None
        assert ground[3] < 1000
        assert ground == sorted(ground)


# --- Parity with the frontend -------------------------------------------

FRONTEND = Path(__file__).parent.parent / "kml_heatmap" / "frontend"


def _ts_constant(relative, name):
    source = (FRONTEND / relative).read_text(encoding="utf-8")
    match = re.search(rf"\bconst {name} = ([\d.e]+);", source)
    assert match, f"{name} not found in {relative}"
    return float(match.group(1))


@pytest.mark.parametrize(
    ("relative", "name", "value"),
    [
        ("services/yearDecode.ts", "DATA_FORMAT_VERSION", FORMAT_VERSION),
        ("services/yearDecode.ts", "GROUND_STEP", GROUND_STEP),
        ("services/yearDecode.ts", "ALTITUDE_STEP", ALTITUDE_STEP),
        ("calculations/lift.ts", "TAXI_KNOTS", terrain_module.TAXI_KNOTS),
        ("calculations/lift.ts", "TAXI_MIN_FIXES", terrain_module.TAXI_MIN_FIXES),
        (
            "utils/geometry.ts",
            "METRES_PER_DEGREE",
            terrain_module.METRES_PER_DEGREE,
        ),
        ("services/yearDecode.ts", "COORDINATE_SCALE", COORDINATE_SCALE),
        ("services/yearDecode.ts", "SPEED_SCALE", SPEED_SCALE),
        ("services/yearDecode.ts", "TIME_SCALE", TIME_SCALE),
        # The page draws the relief from the tiles the ground was sampled
        # from, and no finer
        ("calculations/lift.ts", "TERRAIN_TILE_MAX_ZOOM", TERRAIN_ZOOM),
    ],
)
def test_the_frontend_reads_what_the_exporter_writes(relative, name, value):
    """The two sides of the ground column share their numbers."""
    assert _ts_constant(relative, name) == value


def test_the_frontend_draws_the_relief_from_the_same_tiles():
    source = (FRONTEND / "ui" / "terrain.ts").read_text(encoding="utf-8")
    match = re.search(r'\bconst TERRAIN_TILE_URL =\s*"([^"]+)";', source)
    assert match, "TERRAIN_TILE_URL not found in ui/terrain.ts"
    assert match.group(1) == terrain_module.TILE_URL
