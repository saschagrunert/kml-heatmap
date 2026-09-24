"""The ground under the flights, sampled from an elevation model at build time.

The 3D view of the page draws every flight at its height above the ground.
Without an elevation model the ground of a flight can only be a line from
the field it left to the one it landed on, which knows nothing of the hills
in between: a flight across a ridge sits too high or too low over it, the
more so the lower it was. The exporter therefore samples the ground under
every exported position here and writes it next to the altitude (the ground
column of ``segment_codec``), so the page reads it and computes nothing.

The elevations come from the Terrarium tiles of the AWS open data terrain
tiles (Mapzen's Joerd, from SRTM and other sources), fetched once and kept in
the cache directory. The page never loads a tile: the ground reaches it as
numbers in the year files.

A digital elevation model and the altitudes a recorder logs never agree to
the foot: GPS altitudes are off by tens of feet, a barometric one by the
pressure of the day. The ground is therefore anchored where the flight
itself shows where it is: at the field it left and the one it landed on,
the altitudes it recorded taxiing there are the ground (see
``ground_profile_ft``), and in between the model is shifted from the one
offset to the other in proportion to the distance flown. A flight taxis on
the map at both ends, and follows the relief in between.

Nothing here may fail a build: a tile that cannot be fetched or decoded
leaves the positions under it without ground, and a path with a position
without ground gets no ground column at all, so the page falls back to the
line between the fields for it.
"""

from __future__ import annotations

import contextlib
import http.client
import math
import os
import ssl
import struct
import tempfile
import threading
import time
import urllib.error
import zlib
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor
from concurrent.futures.process import BrokenProcessPool
from itertools import pairwise
from typing import TYPE_CHECKING, NamedTuple, Protocol
from urllib.request import Request, urlopen

from . import __version__
from .cache import CACHE_DIR, REGULAR_FILE_MODE
from .constants import METERS_TO_FEET
from .logger import logger
from .segment_codec import GROUND_STEP
from .types import COORDINATE_DECIMALS

if TYPE_CHECKING:
    from collections.abc import Iterable, Mapping, Sequence
    from pathlib import Path

    from .types import FlightPath, SegmentRow

__all__ = [
    "TERRAIN_CACHE_DIR",
    "TERRAIN_ZOOM",
    "DecodeFailedError",
    "FlatTiles",
    "PngError",
    "TerrariumTiles",
    "TileKey",
    "TileSource",
    "decode_png",
    "ground_profile_ft",
    "sample_path_elevations",
    "terrarium_elevation",
]

# The zoom level the ground is sampled at. Its pixels are about 100 m across
# at 50 degrees north (153 m at the equator), which is finer than anything a
# flight a few hundred feet up shows of the relief under it, and the flights
# of a few years of logs touch a few hundred tiles of it. Every level more
# takes about 2.5 times the tiles, the download and the decoding time.
TERRAIN_ZOOM = 10
TILE_SIZE = 256
TILE_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
TERRAIN_CACHE_DIR = CACHE_DIR / "terrain"

# Downloads in flight at once: S3 answers each in a fraction of a second, so
# a few overlap the latency without hammering the host
FETCH_WORKERS = 8
FETCH_TIMEOUT_SECONDS = 20
# A tile is about 100 KB; anything far larger is not a tile
MAX_TILE_BYTES = 4 * 1024 * 1024
USER_AGENT = (
    f"kml-heatmap/{__version__} (+https://github.com/saschagrunert/kml-heatmap)"
)
# Below this many tiles decoding them in this process beats starting a pool
DECODE_POOL_MIN_TILES = 8

# Groundspeed below which a fix is taxiing, and the fixes of taxiing it takes
# to tell where a field is: the values of groundProfileFt in the frontend
# (calculations/lift.ts), which this mirrors
TAXI_KNOTS = 40
TAXI_MIN_FIXES = 3

# Planar distances along a path, as the frontend measures them
METRES_PER_DEGREE = 111320

# Column indices of an exported segment row, see types.SegmentRow
_LAT, _LON, _ALTITUDE, _SPEED = range(4)


class TileKey(NamedTuple):
    """A tile of the elevation model: zoom, column and row."""

    z: int
    x: int
    y: int


class TileSource(Protocol):
    """Where the elevations come from.

    ``pixels`` answers, for every tile asked for, the elevation in metres of
    each of its pixels given by index (``row * TILE_SIZE + column``), in that
    order. A tile that is not available is left out of the answer.
    """

    def pixels(
        self, wanted: Mapping[TileKey, Sequence[int]]
    ) -> dict[TileKey, list[float]]: ...


class FlatTiles:
    """Ground at one elevation everywhere, without any tile.

    For builds that must not depend on the network (the pipeline tests):
    with a flat model the ground of a flight is the line between its fields,
    as the page draws it without a ground column.
    """

    def __init__(self, elevation_m: float = 0.0) -> None:
        """Answer ``elevation_m`` for every pixel."""
        self.elevation_m = elevation_m

    def pixels(
        self, wanted: Mapping[TileKey, Sequence[int]]
    ) -> dict[TileKey, list[float]]:
        """Every pixel of every tile at the one elevation."""
        return {
            tile: [self.elevation_m] * len(indices) for tile, indices in wanted.items()
        }


# --- PNG ----------------------------------------------------------------

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
# Colour types this decoder reads, by the channels of a pixel: truecolour
# and truecolour with alpha, which is what elevation tiles are
_CHANNELS = {2: 3, 6: 4}


class PngError(ValueError):
    """A PNG this decoder cannot or will not read."""


class DecodeFailedError(RuntimeError):
    """The tiles could not be decoded at all: the decoding pool died."""


def _chunks(data: bytes) -> Iterable[tuple[bytes, bytes]]:
    """The chunks of a PNG after its signature, each checked against its CRC."""
    pos = len(PNG_SIGNATURE)
    while pos + 12 <= len(data):
        (length,) = struct.unpack_from(">I", data, pos)
        kind = data[pos + 4 : pos + 8]
        body = data[pos + 8 : pos + 8 + length]
        if len(body) != length or pos + 12 + length > len(data):
            break
        (crc,) = struct.unpack_from(">I", data, pos + 8 + length)
        if zlib.crc32(kind + body) != crc:
            raise PngError(f"PNG chunk {kind!r} is corrupt")
        yield kind, body
        pos += 12 + length
    raise PngError("PNG ends before its IEND chunk")


def _unfilter(raw: bytes, width: int, height: int, bpp: int) -> bytearray:
    """Undo the per-line filters of a non-interlaced 8-bit image.

    Every line starts with its filter type; the filters predict a byte from
    the one ``bpp`` bytes to the left (a), the one above (b) and the one
    above and to the left (c).
    """
    stride = width * bpp
    if len(raw) != height * (stride + 1):
        raise PngError("PNG image data has the wrong length")
    out = bytearray(height * stride)
    previous = bytearray(stride)
    for y in range(height):
        start = y * (stride + 1)
        kind = raw[start]
        line = bytearray(raw[start + 1 : start + 1 + stride])
        if kind == 1:  # Sub
            for i in range(bpp, stride):
                line[i] = (line[i] + line[i - bpp]) & 0xFF
        elif kind == 2:  # Up
            for i in range(stride):
                line[i] = (line[i] + previous[i]) & 0xFF
        elif kind == 3:  # Average
            for i in range(bpp):
                line[i] = (line[i] + (previous[i] >> 1)) & 0xFF
            for i in range(bpp, stride):
                line[i] = (line[i] + ((line[i - bpp] + previous[i]) >> 1)) & 0xFF
        elif kind == 4:  # Paeth
            for i in range(bpp):
                line[i] = (line[i] + previous[i]) & 0xFF
            for i in range(bpp, stride):
                a = line[i - bpp]
                b = previous[i]
                c = previous[i - bpp]
                # The distances of a + b - c to a, b and c
                pa = abs(b - c)
                pb = abs(a - c)
                pc = abs(a + b - c - c)
                if pa <= pb and pa <= pc:
                    predictor = a
                elif pb <= pc:
                    predictor = b
                else:
                    predictor = c
                line[i] = (line[i] + predictor) & 0xFF
        elif kind != 0:
            raise PngError(f"PNG line {y} has the unknown filter type {kind}")
        out[y * stride : (y + 1) * stride] = line
        previous = line
    return out


def decode_png(data: bytes) -> tuple[int, int, int, bytearray]:
    """Decode an 8-bit RGB or RGBA PNG without interlacing.

    Returns the width, the height, the channels per pixel (3 or 4) and the
    pixels, line by line. Anything else (another bit depth, a palette, grey,
    interlacing) raises ``PngError``: an elevation tile is never one of them,
    and a decoder for all of PNG is not worth its code here.
    """
    if not data.startswith(PNG_SIGNATURE):
        raise PngError("not a PNG file")
    header: tuple[int, ...] | None = None
    compressed = bytearray()
    for kind, body in _chunks(data):
        if kind == b"IHDR":
            if len(body) != 13:
                raise PngError("PNG header has the wrong length")
            header = struct.unpack(">IIBBBBB", body)
        elif kind == b"IDAT":
            compressed += body
        elif kind == b"IEND":
            break
    if header is None:
        raise PngError("PNG has no header")
    width, height, depth, colour, compression, filtering, interlace = header
    if depth != 8 or colour not in _CHANNELS:
        raise PngError(
            f"PNG of bit depth {depth} and colour type {colour}: only 8-bit "
            "RGB and RGBA are supported"
        )
    if compression != 0 or filtering != 0:
        raise PngError("PNG uses an unknown compression or filter method")
    if interlace != 0:
        raise PngError("interlaced PNGs are not supported")
    if width == 0 or height == 0:
        raise PngError("PNG has no pixels")
    channels = _CHANNELS[colour]
    try:
        raw = zlib.decompress(compressed)
    except zlib.error as e:
        raise PngError(f"PNG image data is corrupt: {e}") from e
    return width, height, channels, _unfilter(raw, width, height, channels)


def terrarium_elevation(red: int, green: int, blue: int) -> float:
    """The elevation in metres a Terrarium pixel encodes."""
    return red * 256 + green + blue / 256 - 32768


def decode_tile_pixels(data: bytes, indices: Sequence[int]) -> list[float]:
    """The elevations of the pixels at ``indices`` of a Terrarium tile."""
    width, height, channels, pixels = decode_png(data)
    if width != TILE_SIZE or height != TILE_SIZE:
        raise PngError(f"tile is {width}x{height} pixels, not {TILE_SIZE}")
    return [
        terrarium_elevation(
            pixels[index * channels],
            pixels[index * channels + 1],
            pixels[index * channels + 2],
        )
        for index in indices
    ]


def _decode_cached_tile(path: Path, indices: Sequence[int]) -> list[float] | None:
    """``decode_tile_pixels`` of a cached tile, None when it is unusable.

    A module-level function, so the decoding pool can run it. A file that
    does not decode is removed, so the next build fetches it again.
    """
    try:
        return decode_tile_pixels(path.read_bytes(), indices)
    except (OSError, PngError) as e:
        logger.debug("Elevation tile %s is unusable: %s", path.name, e)
        with contextlib.suppress(OSError):
            path.unlink()
        return None


# --- Tiles from AWS -----------------------------------------------------


class TerrariumTiles:
    """Terrarium tiles from AWS, kept in a cache directory.

    A tile is fetched once and kept as the PNG it arrived as. The first
    request that cannot reach the host (offline, DNS, a timeout) stops the
    other downloads of the run; a tile the host answers with an error is
    only missing itself. Neither fails the build.
    """

    def __init__(self, cache_dir: Path | None = None) -> None:
        """Keep the tiles in ``cache_dir`` (by default ``TERRAIN_CACHE_DIR``)."""
        self.cache_dir = cache_dir if cache_dir is not None else TERRAIN_CACHE_DIR
        self._offline = threading.Event()

    def path(self, tile: TileKey) -> Path:
        """Where a tile is kept."""
        return self.cache_dir / f"{tile.z}-{tile.x}-{tile.y}.png"

    def _download(self, tile: TileKey) -> int:
        """Fetch a tile into the cache; the bytes fetched, 0 when it failed."""
        if self._offline.is_set():
            return 0
        url = TILE_URL.format(z=tile.z, x=tile.x, y=tile.y)
        request = Request(url, headers={"User-Agent": USER_AGENT})  # noqa: S310
        try:
            with urlopen(  # noqa: S310 # nosec B310
                request,
                timeout=FETCH_TIMEOUT_SECONDS,
                context=ssl.create_default_context(),
            ) as response:
                data = response.read(MAX_TILE_BYTES + 1)
        except urllib.error.HTTPError as e:
            # The host answered: this tile is missing, the others may not be
            logger.debug("Elevation tile %s: HTTP %s", url, e.code)
            e.close()
            return 0
        # http.client.IncompleteRead (a connection dropped mid-body) is no OSError
        except (OSError, http.client.HTTPException, ValueError) as e:
            if not self._offline.is_set():
                self._offline.set()
                logger.debug("Elevation tiles unreachable: %s", e)
            return 0
        if len(data) > MAX_TILE_BYTES or not data.startswith(PNG_SIGNATURE):
            logger.debug("Elevation tile %s is not a PNG tile", url)
            return 0
        tmp_path: str | None = None
        try:
            with tempfile.NamedTemporaryFile(
                dir=self.cache_dir, prefix=".tile.", suffix=".tmp", delete=False
            ) as tmp:
                tmp_path = tmp.name
                tmp.write(data)
            # A shared cache (a build container, a CI runner) needs it readable
            os.chmod(tmp_path, REGULAR_FILE_MODE)
            os.replace(tmp_path, self.path(tile))
            tmp_path = None
        except OSError as e:
            logger.debug("Cannot cache elevation tile %s: %s", url, e)
            return 0
        finally:
            if tmp_path is not None:
                with contextlib.suppress(OSError):
                    os.unlink(tmp_path)
        return len(data)

    def fetch(self, tiles: Iterable[TileKey]) -> None:
        """Download the tiles that are not in the cache yet."""
        missing = [tile for tile in tiles if not self.path(tile).is_file()]
        if not missing:
            return
        try:
            self.cache_dir.mkdir(parents=True, exist_ok=True)
        except OSError as e:
            logger.debug("Cannot create %s: %s", self.cache_dir, e)
            return
        started = time.monotonic()
        with ThreadPoolExecutor(max_workers=FETCH_WORKERS) as pool:
            fetched = [size for size in pool.map(self._download, missing) if size]
        logger.info(
            "  Downloaded %d of %d elevation tile(s), %.1f MB in %.1f s",
            len(fetched),
            len(missing),
            sum(fetched) / 1024 / 1024,
            time.monotonic() - started,
        )

    def pixels(
        self, wanted: Mapping[TileKey, Sequence[int]]
    ) -> dict[TileKey, list[float]]:
        """Fetch what is missing, then decode the pixels of every tile."""
        self.fetch(wanted)
        cached = [
            (tile, self.path(tile)) for tile in wanted if self.path(tile).is_file()
        ]
        paths = [path for _, path in cached]
        indices = [wanted[tile] for tile, _ in cached]
        # Decoding a tile takes a few tens of milliseconds of pure Python,
        # which adds up over hundreds of them; the cores share it
        if len(cached) < DECODE_POOL_MIN_TILES:
            decoded = list(map(_decode_cached_tile, paths, indices, strict=True))
        else:
            workers = min(os.process_cpu_count() or 1, len(cached))
            # A worker killed for its memory, or a pool that cannot start
            # (no semaphores in a sandbox), must not fail the build
            try:
                with ProcessPoolExecutor(max_workers=workers) as pool:
                    decoded = list(
                        pool.map(
                            _decode_cached_tile,
                            paths,
                            indices,
                            chunksize=max(1, len(cached) // (workers * 4)),
                        )
                    )
            except (BrokenProcessPool, OSError) as e:
                raise DecodeFailedError(str(e) or type(e).__name__) from e
        return {
            tile: values
            for (tile, _), values in zip(cached, decoded, strict=True)
            if values is not None
        }


# --- Sampling -----------------------------------------------------------

# A coordinate as the exporter rounds it (see COORDINATE_DECIMALS)
Coordinate = tuple[float, float]
# Web Mercator ends here, in a square
MAX_LATITUDE = 85.0511


def _corners(lat: float, lon: float, zoom: int) -> tuple[tuple[int, ...], float, float]:
    """The four pixels whose centres surround a point, and its place among them.

    Pixels are numbered across the whole world at ``zoom``, row by row
    (``y * world + x``): top left, top right, bottom left, bottom right,
    then the fractions of the way from the left to the right ones and from
    the top to the bottom ones. Across the antimeridian the world wraps; at
    the top and bottom the edge row stands in for the one beyond.
    """
    world = TILE_SIZE << zoom
    lat = max(min(lat, MAX_LATITUDE), -MAX_LATITUDE)
    sin = math.sin(math.radians(lat))
    x = (lon + 180) / 360 * world - 0.5
    y = (0.5 - math.log((1 + sin) / (1 - sin)) / (4 * math.pi)) * world - 0.5
    left = math.floor(x)
    top = math.floor(y)
    tx = x - left
    ty = y - top
    right = (left + 1) % world
    left %= world
    bottom = min(top + 1, world - 1) * world
    top = max(top, 0) * world
    return (top + left, top + right, bottom + left, bottom + right), tx, ty


def sample_elevations(
    coordinates: Iterable[Coordinate],
    source: TileSource,
    zoom: int = TERRAIN_ZOOM,
) -> tuple[dict[Coordinate, float], int, int]:
    """The ground elevation in metres at every coordinate the tiles cover.

    Bilinear between the four pixels around a coordinate, which can be in
    up to four tiles: the relief runs on across tile edges. A coordinate
    with a pixel of a missing tile is left out. Also returns how many tiles
    were asked for and how many of them were missing.
    """
    world = TILE_SIZE << zoom
    corners = {coordinate: _corners(*coordinate, zoom) for coordinate in coordinates}
    by_tile: dict[TileKey, list[int]] = {}
    for pixel in {pixel for pixels, _, _ in corners.values() for pixel in pixels}:
        y, x = divmod(pixel, world)
        by_tile.setdefault(TileKey(zoom, x // TILE_SIZE, y // TILE_SIZE), []).append(
            pixel
        )
    answered = source.pixels(
        {
            tile: [
                (pixel // world % TILE_SIZE) * TILE_SIZE + pixel % TILE_SIZE
                for pixel in pixels
            ]
            for tile, pixels in by_tile.items()
        }
    )
    values: dict[int, float] = {}
    for tile, elevations in answered.items():
        values.update(zip(by_tile[tile], elevations, strict=True))

    result: dict[Coordinate, float] = {}
    for coordinate, (pixels, tx, ty) in corners.items():
        try:
            top_left, top_right, bottom_left, bottom_right = (
                values[pixel] for pixel in pixels
            )
        except KeyError:
            continue
        top = top_left + (top_right - top_left) * tx
        bottom = bottom_left + (bottom_right - bottom_left) * tx
        result[coordinate] = top + (bottom - top) * ty
    return result, len(by_tile), len(by_tile) - len(answered)


def _rounded(path: FlightPath) -> list[Coordinate]:
    return [
        (round(point.lat, COORDINATE_DECIMALS), round(point.lon, COORDINATE_DECIMALS))
        for point in path
    ]


def sample_path_elevations(
    paths: Mapping[int, FlightPath], source: TileSource
) -> dict[int, dict[Coordinate, float]]:
    """The ground under every point of the given paths, keyed like them.

    Each path gets the elevations in metres of its points, by the
    coordinate as the exporter rounds it, which is what its segment rows
    carry. A point the tiles do not cover is left out, and so is a path
    none of whose points they cover. Logs one summary, and one warning when
    tiles were missing; never raises for a tile it could not get.
    """
    started = time.monotonic()
    rounded = {index: _rounded(path) for index, path in paths.items()}
    everything = {coordinate for points in rounded.values() for coordinate in points}
    try:
        elevations, tiles, missing = sample_elevations(everything, source)
    except DecodeFailedError as e:
        logger.warning(
            "Terrain: the elevation tiles could not be decoded (%s); every "
            "flight keeps the ground between its airfields",
            e,
        )
        return {}
    by_path: dict[int, dict[Coordinate, float]] = {}
    uncovered = 0
    for index, points in rounded.items():
        own = {point: elevations[point] for point in points if point in elevations}
        if len(own) < len(set(points)):
            uncovered += 1
        if own:
            by_path[index] = own
    logger.info(
        "  Sampled the ground under %s position(s) from %d elevation tile(s) in %.1f s",
        f"{len(everything):,}",
        tiles,
        time.monotonic() - started,
    )
    if missing:
        logger.warning(
            "Terrain: %d of %d elevation tile(s) are unavailable (offline?); "
            "%d flight(s) keep the ground between their airfields",
            missing,
            tiles,
            uncovered,
        )
    return by_path


# --- The ground of a flight ---------------------------------------------


def _median(values: list[float]) -> float:
    """The upper median, as the frontend takes it."""
    return sorted(values)[len(values) // 2]


def _field_offset_ft(
    rows: Sequence[SegmentRow], dem_ft: Sequence[float], order: Iterable[int]
) -> float | None:
    """How far the recorded field is above the model at one end of a path.

    The rows from that end up to the first fast one are its taxiing: the
    middle of their altitudes is the field as the recorder saw it, the
    middle of the model under them the field as the model has it. None for
    a path that starts or ends in the air, or without speeds to tell. A
    speed of 0 is no speed (see ``process_path_segments``), which ends the
    taxiing like a fast one; the frontend, which never sees a path without
    speeds from this exporter, counts it as taxiing.
    """
    altitudes: list[float] = []
    grounds: list[float] = []
    for index in order:
        row = rows[index]
        if not 0 < row[_SPEED] < TAXI_KNOTS:
            break
        altitudes.append(row[_ALTITUDE])
        grounds.append(dem_ft[index])
    if len(altitudes) < TAXI_MIN_FIXES:
        return None
    return _median(altitudes) - _median(grounds)


def ground_profile_ft(
    start: Sequence[float],
    rows: Sequence[SegmentRow],
    elevations: Mapping[Coordinate, float],
) -> list[float] | None:
    """The ground under the end of every row of a path, in feet.

    The model's elevation under each row (``elevations``, in metres, by the
    coordinate), shifted to meet the flight's own fields: at each end by as
    much as the altitudes it recorded taxiing there are above the model
    (``_field_offset_ft``), and in between from the one offset to the other
    in proportion to the distance flown, measured like groundProfileFt does
    in the frontend. With a field at one end only, its offset holds all the
    way; with none, the model is the ground. Rounded to ``GROUND_STEP``, the
    step the year file stores.

    The taxiing rows then stand on the ground as they do without a model,
    since the ground under them is their own altitudes up to the relief of
    the field, and the altitudes are rounded to 100 ft anyway.

    None when the path has no rows or a row without an elevation: a ground
    with a hole in it would be worse than the line between the fields.
    """
    if not rows or not start:
        return None
    dem_ft: list[float] = []
    for row in rows:
        elevation = elevations.get((row[_LAT], row[_LON]))
        if elevation is None:
            return None
        dem_ft.append(elevation * METERS_TO_FEET)

    first = _field_offset_ft(rows, dem_ft, range(len(rows)))
    last = _field_offset_ft(rows, dem_ft, reversed(range(len(rows))))
    from_ft = first if first is not None else last if last is not None else 0.0
    to_ft = last if last is not None else from_ft

    # Metres flown to the end of each row, as the frontend measures them
    along: list[float] = []
    total = 0.0
    points = [(start[0], start[1]), *((row[_LAT], row[_LON]) for row in rows)]
    for (lat0, lon0), (lat1, lon1) in pairwise(points):
        # The short way round across the antimeridian
        dlon = (lon1 - lon0 + 180) % 360 - 180
        total += math.hypot(
            dlon * METRES_PER_DEGREE * math.cos(math.radians((lat0 + lat1) / 2)),
            (lat1 - lat0) * METRES_PER_DEGREE,
        )
        along.append(total)

    ground: list[float] = []
    for dem, distance in zip(dem_ft, along, strict=True):
        t = distance / total if total > 0 else 0.0
        feet = dem + from_ft + (to_ft - from_ft) * t
        ground.append(float(round(feet / GROUND_STEP) * GROUND_STEP))
    return ground
