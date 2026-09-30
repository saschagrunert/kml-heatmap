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

Nothing here fails a build unless asked to: a tile that cannot be fetched
or decoded leaves the positions under it without ground, and a path with a
position without ground gets no ground column at all, so the page falls back
to the line between the fields for it. A build that publishes the site sets
``KML_HEATMAP_REQUIRE_TERRAIN=1``, which fails it instead (see
``sample_path_elevations``).

Decoding a PNG takes a few tens of milliseconds of pure Python, which a few
hundred tiles turn into seconds on every build. The pixels of a decoded tile
are therefore kept next to its PNG as well (see ``_read_pixel_planes``).
"""

import base64
import contextlib
import math
import os
import ssl
import struct
import threading
import time
import zlib
from array import array
from compression import zstd
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor
from concurrent.futures.process import BrokenProcessPool
from http.client import HTTPException, HTTPSConnection
from itertools import compress, pairwise
from statistics import median_high
from typing import TYPE_CHECKING, NamedTuple, Protocol
from urllib.parse import unquote, urljoin, urlsplit
from urllib.request import getproxies, proxy_bypass

from . import __version__
from .cache import CACHE_DIR, atomic_bytes_write
from .constants import METERS_TO_FEET
from .exceptions import TerrainUnavailableError
from .geometry import METRES_PER_DEGREE, TERRAIN_MAX_LATITUDE, planar_metres
from .logger import logger
from .png import PNG_SIGNATURE, PngError, chunks
from .segment_codec import ALTITUDE, GROUND_STEP, LAT, LON, SPEED
from .types import COORDINATE_DECIMALS
from .workers import default_worker_count

if TYPE_CHECKING:
    from collections.abc import Iterable, Mapping, Sequence
    from pathlib import Path

    from .types import FlightPath, SegmentRow

__all__ = [
    "METRES_PER_DEGREE",
    "REQUIRE_TERRAIN_ENV",
    "TERRAIN_CACHE_DIR",
    "TERRAIN_ZOOM",
    "DecodeFailedError",
    "PngError",
    "TerrariumTiles",
    "TileKey",
    "TileSource",
    "decode_png",
    "elevations_by_coordinate",
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
# A request that fails on the way (a dropped connection, a timeout) or that
# the host answers with a server error is tried this often, waiting
# FETCH_RETRY_SECONDS before the second attempt and twice as long before each
# one after: one glitch must not leave every other tile of the run unfetched
FETCH_ATTEMPTS = 4
FETCH_RETRY_SECONDS = 1.0
# Too many requests, and the server errors worth another attempt
_RETRIED_HTTP_CODES = frozenset({429, 500, 502, 503, 504})
# Tiles in a row, across the fetch threads, that used up their attempts on
# server errors before the host is given up for the run. One such tile
# costs only itself; a host that answers every tile so would otherwise cost
# every tile of the run its attempts and pauses, minutes for a few hundred.
SERVER_ERROR_TILES_TO_GIVE_UP = 3
# Redirects followed to the same host over https, and how many in a row: the
# tiles never move, and a redirect elsewhere would hand the request to a host
# nobody chose
_REDIRECT_CODES = frozenset({301, 302, 303, 307, 308})
MAX_REDIRECTS = 3


def _https_proxy(host: str) -> tuple[str, int, dict[str, str]] | None:
    """The proxy the environment sets for https to ``host``, None for none.

    ``urlopen`` honours HTTPS_PROXY and NO_PROXY (and the lowercase names),
    and a build behind a mandatory proxy reaches no tile without it. The
    proxy is spoken to in plain http and asked to CONNECT to the host, as
    ``urlopen`` does; a URL without a scheme is taken as http, and one
    without a port gets that of its scheme. Credentials in the URL are sent
    as basic Proxy-Authorization.
    """
    proxy = getproxies().get("https")
    if not proxy or proxy_bypass(host):
        return None
    parts = urlsplit(proxy if "://" in proxy else f"http://{proxy}")
    if not parts.hostname:
        return None
    headers: dict[str, str] = {}
    if parts.username is not None:
        credentials = f"{unquote(parts.username)}:{unquote(parts.password or '')}"
        headers["Proxy-Authorization"] = "Basic " + base64.b64encode(
            credentials.encode()
        ).decode("ascii")
    port = parts.port or (443 if parts.scheme == "https" else 80)
    return parts.hostname, port, headers


class _RefusedURLError(ValueError):
    """A URL the fetch does not follow: not https, or a redirect elsewhere.

    The host answered, so like a status that is not tried again it costs
    only this tile, and the host stays online for the others.
    """


# Set to "1", a tile that cannot be fetched or decoded fails the build
REQUIRE_TERRAIN_ENV = "KML_HEATMAP_REQUIRE_TERRAIN"
# A tile is about 100 KB; anything far larger is not a tile
MAX_TILE_BYTES = 4 * 1024 * 1024
USER_AGENT = (
    f"kml-heatmap/{__version__} (+https://github.com/saschagrunert/kml-heatmap)"
)
# Below this many tiles decoding them in this process beats starting a pool
DECODE_POOL_MIN_TILES = 8

# Groundspeed below which a fix is taxiing, and the fixes of taxiing it takes
# to tell where a field is: the values of groundProfileFt in the frontend
# (calculations/groundProfile.ts), which this mirrors
TAXI_KNOTS = 40
TAXI_MIN_FIXES = 3


class TileKey(NamedTuple):
    """A tile of the elevation model: zoom, column and row."""

    z: int
    x: int
    y: int


class TileSource(Protocol):
    """Where the elevations come from.

    ``pixels`` answers, for every tile asked for, the elevation in metres of
    each of its pixels given by index (``row * TILE_SIZE + column``), in that
    order. A tile that is not available is left out of the answer. An
    ``array("d")`` holds a few million of them in a fraction of the memory
    a list takes.
    """

    def pixels(
        self, wanted: Mapping[TileKey, Sequence[int]]
    ) -> dict[TileKey, Sequence[float]]: ...


# --- PNG ----------------------------------------------------------------

# Colour types this decoder reads, by the channels of a pixel: truecolour
# and truecolour with alpha, which is what elevation tiles are
_CHANNELS = {2: 3, 6: 4}
# The widest and highest PNG this decoder reads: an elevation tile is 256 or
# 512 pixels a side, and a header that claims more than this is no tile
MAX_PNG_SIDE = 4096


class DecodeFailedError(RuntimeError):
    """The tiles could not be decoded at all: the decoding pool died."""


def _unfilter(raw: bytes, width: int, height: int, bpp: int) -> bytearray:  # noqa: C901
    """Undo the per-line filters of a non-interlaced 8-bit image.

    Every line starts with its filter type; the filters predict a byte from
    the one ``bpp`` bytes to the left (a), the one above (b) and the one
    above and to the left (c). One branch per filter type in one loop
    (hence the complexity exemption): a function call per byte would cost
    what the pool of decoders saves.
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


def _header(body: bytes) -> tuple[int, ...]:
    """The seven fields of an IHDR chunk."""
    if len(body) != 13:
        raise PngError("PNG header has the wrong length")
    return struct.unpack(">IIBBBBB", body)


def is_tile_png(data: bytes) -> bool:
    """Whether ``data`` is a complete PNG of a tile's size.

    Every chunk against its CRC, the header at ``TILE_SIZE`` a side and the
    IEND chunk in place: a body cut short on the way, or one the host
    filled with something else, must not be cached as a tile and decoded
    again on every build after.
    """
    if not data.startswith(PNG_SIGNATURE):
        return False
    try:
        for kind, body in chunks(data):
            if kind == b"IHDR" and _header(body)[:2] != (TILE_SIZE, TILE_SIZE):
                return False
            if kind == b"IEND":
                return True
    except PngError:
        return False
    return False


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
    for kind, body in chunks(data):
        if kind == b"IHDR":
            header = _header(body)
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
    if width > MAX_PNG_SIDE or height > MAX_PNG_SIDE:
        raise PngError(f"PNG of {width}x{height} pixels is too large")
    channels = _CHANNELS[colour]
    # A line is its filter type and its pixels. The image data is inflated
    # no further than one byte beyond that, which _unfilter refuses: a few
    # kilobytes of zeros inflate to gigabytes otherwise.
    expected = height * (width * channels + 1)
    try:
        raw = zlib.decompressobj().decompress(compressed, expected + 1)
    except zlib.error as e:
        raise PngError(f"PNG image data is corrupt: {e}") from e
    return width, height, channels, _unfilter(raw, width, height, channels)


def terrarium_elevation(red: int, green: int, blue: int) -> float:
    """The elevation in metres a Terrarium pixel encodes."""
    return red * 256 + green + blue / 256 - 32768


def decode_tile_pixels(data: bytes, indices: Sequence[int]) -> list[float]:
    """The elevations of the pixels at ``indices`` of a Terrarium tile."""
    return list(_elevations_at(_decode_planes(data), indices))


# The decoded pixels of a tile, next to its PNG: a header, then the red,
# the green and the blue value of every pixel, one plane after the other,
# compressed with zstd. Planes compress better than the PNG itself (the red
# one is all but constant) and inflate in a fraction of a millisecond. The
# header holds the CRC of the PNG the pixels are of, so a tile fetched
# again is decoded again. Bump the version whenever the layout or the
# compression changes (version 1 was zlib): a file of an older version is
# decoded again and replaced.
PIXELS_SUFFIX = ".pixels"
_PIXELS_HEADER = struct.Struct(">4sBI")
_PIXELS_MAGIC = b"KHTP"
_PIXELS_VERSION = 2
_PIXELS_ZSTD_LEVEL = 3
_PLANES_BYTES = 3 * TILE_SIZE * TILE_SIZE


def _pixels_path(path: Path) -> Path:
    return path.with_suffix(PIXELS_SUFFIX)


def _has_current_pixels(path: Path) -> bool:
    """Whether the pixels kept of the tile at ``path`` are of this version.

    Only the header's magic and version: whether they are of this PNG
    takes reading the PNG, which the decoding does anyway.
    """
    try:
        with _pixels_path(path).open("rb") as kept:
            head = kept.read(len(_PIXELS_MAGIC) + 1)
    except OSError:
        return False
    return head == _PIXELS_MAGIC + bytes([_PIXELS_VERSION])


def _decode_planes(data: bytes) -> bytes:
    """The red, green and blue planes of a Terrarium tile's PNG."""
    width, height, channels, pixels = decode_png(data)
    if width != TILE_SIZE or height != TILE_SIZE:
        raise PngError(f"tile is {width}x{height} pixels, not {TILE_SIZE}")
    return (
        bytes(pixels[0::channels])
        + bytes(pixels[1::channels])
        + bytes(pixels[2::channels])
    )


def _read_pixel_planes(path: Path, data: bytes) -> bytes | None:
    """The kept planes of the tile at ``path`` whose PNG is ``data``.

    None when there are none, or none of this PNG, or they are damaged:
    the tile is then decoded again.
    """
    try:
        kept = _pixels_path(path).read_bytes()
        magic, version, crc = _PIXELS_HEADER.unpack_from(kept)
        if (magic, version, crc) != (_PIXELS_MAGIC, _PIXELS_VERSION, zlib.crc32(data)):
            return None
        # Inflated no further than the planes and a byte, like the PNG
        planes = zstd.ZstdDecompressor().decompress(
            kept[_PIXELS_HEADER.size :], _PLANES_BYTES + 1
        )
    except OSError, struct.error, zstd.ZstdError:
        return None
    return planes if len(planes) == _PLANES_BYTES else None


def _keep_pixel_planes(path: Path, data: bytes, planes: bytes) -> None:
    """Keep the planes of a decoded tile next to its PNG, atomically."""
    header = _PIXELS_HEADER.pack(_PIXELS_MAGIC, _PIXELS_VERSION, zlib.crc32(data))
    try:
        atomic_bytes_write(
            _pixels_path(path),
            header + zstd.compress(planes, level=_PIXELS_ZSTD_LEVEL),
        )
    except OSError as e:
        # Only the next build pays for it: it decodes the tile again
        logger.debug("Cannot keep the pixels of %s: %s", path.name, e)


def _elevations_at(planes: bytes, indices: Sequence[int]) -> array[float]:
    """``terrarium_elevation`` of the pixels at ``indices`` of the planes."""
    green = TILE_SIZE * TILE_SIZE
    blue = 2 * green
    return array(
        "d",
        [
            planes[index] * 256
            + planes[green + index]
            + planes[blue + index] / 256
            - 32768
            for index in indices
        ],
    )


def _decode_cached_tile(path: Path, indices: Sequence[int]) -> array[float] | None:
    """The elevations of the pixels at ``indices`` of a cached tile.

    From the pixels kept of it when there are any, from its PNG otherwise,
    whose pixels are then kept. None when the tile is unusable. A
    module-level function, so the decoding pool can run it. A file that does
    not decode is removed, so the next build fetches it again.
    """
    try:
        data = path.read_bytes()
        planes = _read_pixel_planes(path, data)
        if planes is None:
            planes = _decode_planes(data)
            _keep_pixel_planes(path, data, planes)
        return _elevations_at(planes, indices)
    except (OSError, PngError) as e:
        logger.debug("Elevation tile %s is unusable: %s", path.name, e)
        for unusable in (path, _pixels_path(path)):
            with contextlib.suppress(OSError):
                unusable.unlink()
        return None


# --- Tiles from AWS -----------------------------------------------------


class TerrariumTiles:
    """Terrarium tiles from AWS, kept in a cache directory.

    A tile is fetched once and kept as the PNG it arrived as, and its
    pixels once decoded next to it. A request that fails on the way or with
    a server error is tried again (see ``FETCH_ATTEMPTS``); the first one
    that fails every time (offline, DNS, the host down) stops the other
    downloads of the run, and so do ``SERVER_ERROR_TILES_TO_GIVE_UP`` tiles
    in a row that got server errors every time. A tile the host answers with
    another error is only missing itself. None of it fails the build on its
    own.
    """

    def __init__(self, cache_dir: Path | None = None) -> None:
        """Keep the tiles in ``cache_dir`` (by default ``TERRAIN_CACHE_DIR``)."""
        self.cache_dir = cache_dir if cache_dir is not None else TERRAIN_CACHE_DIR
        self._offline = threading.Event()
        # Tiles in a row that used up their attempts on server errors (see
        # SERVER_ERROR_TILES_TO_GIVE_UP), across the fetch threads
        self._server_error_tiles = 0
        self._server_error_lock = threading.Lock()
        # One context for the run: building it reads the system's
        # certificates, a few milliseconds every tile would pay again
        self._ssl_context = ssl.create_default_context()
        # One connection per fetch thread, reused from tile to tile: a TLS
        # handshake with S3 takes longer than a tile does
        self._local = threading.local()
        # Every connection opened, so the ones the threads leave open are
        # closed when the downloads are done (see fetch)
        self._opened: list[HTTPSConnection] = []
        self._opened_lock = threading.Lock()

    def path(self, tile: TileKey) -> Path:
        """Where a tile is kept."""
        return self.cache_dir / f"{tile.z}-{tile.x}-{tile.y}.png"

    def _connection(self, host: str) -> HTTPSConnection:
        """This thread's connection to ``host``, opened when there is none.

        Through the proxy of the environment, when it sets one for the host
        (see ``_https_proxy``).
        """
        connection: HTTPSConnection | None = getattr(self._local, "connection", None)
        # The host the connection reaches, which through a proxy is not
        # the one it connects to
        if connection is None or getattr(self._local, "host", None) != host:
            self._close_connection()
            proxy = _https_proxy(host)
            if proxy is None:
                connection = HTTPSConnection(
                    host, timeout=FETCH_TIMEOUT_SECONDS, context=self._ssl_context
                )
            else:
                proxy_host, proxy_port, headers = proxy
                connection = HTTPSConnection(
                    proxy_host,
                    proxy_port,
                    timeout=FETCH_TIMEOUT_SECONDS,
                    context=self._ssl_context,
                )
                connection.set_tunnel(host, headers=headers)
            self._local.connection = connection
            self._local.host = host
            with self._opened_lock:
                self._opened.append(connection)
        return connection

    def _close_connection(self) -> None:
        """Drop this thread's connection; the next request opens one again."""
        connection: HTTPSConnection | None = getattr(self._local, "connection", None)
        if connection is not None:
            connection.close()
            self._local.connection = None

    def _get(self, url: str) -> tuple[int, bytes]:
        """The status and the body of ``url``, redirects on the host followed.

        A redirect that leaves https or the host is not followed: the tiles
        never move, and the request must not end up at a host nobody chose.
        Raises ``_RefusedURLError`` for such a redirect, and the errors of
        ``http.client`` for a connection that fails.
        """
        for _ in range(MAX_REDIRECTS + 1):
            parts = urlsplit(url)
            if parts.scheme != "https" or not parts.netloc:
                raise _RefusedURLError(f"refusing to fetch {url}: not https")
            connection = self._connection(parts.netloc)
            connection.request(
                "GET",
                parts.path + (f"?{parts.query}" if parts.query else ""),
                headers={"User-Agent": USER_AGENT},
            )
            response = connection.getresponse()
            data: bytes = response.read(MAX_TILE_BYTES + 1)
            if not response.isclosed():
                # The body was cut short at MAX_TILE_BYTES. Its rest would
                # stay on the connection and the next tile of this thread
                # would fail on it (ResponseNotReady), count as the host
                # unreachable and, repeated, give the host up for the run.
                # The next request opens a fresh connection instead.
                self._close_connection()
            if response.status not in _REDIRECT_CODES:
                return response.status, data
            location = response.getheader("Location") or ""
            # A Location may be relative to the URL it answers
            target = urljoin(url, location)
            target_parts = urlsplit(target)
            if (
                not location
                or target_parts.scheme != "https"
                or target_parts.netloc != parts.netloc
            ):
                raise _RefusedURLError(
                    f"refusing the redirect from {url} to {location!r}"
                )
            url = target
        raise _RefusedURLError(f"too many redirects from {url}")

    def _fetch(self, url: str) -> bytes | None:
        """The body the host answers ``url`` with, None when there is none.

        Tries again with a growing pause after a failure on the way or a
        server error, and gives the host up for the run (see ``_offline``)
        once the last attempt failed on the way as well. A server error is
        the host answering: the other tiles may well get through, unless
        ``SERVER_ERROR_TILES_TO_GIVE_UP`` tiles in a row got nothing else.
        """
        error: Exception | str | None = None
        unreachable = False
        for attempt in range(FETCH_ATTEMPTS):
            if attempt:
                time.sleep(FETCH_RETRY_SECONDS * 2 ** (attempt - 1))
            if self._offline.is_set():
                return None
            try:
                status, data = self._get(url)
            except _RefusedURLError as e:
                logger.debug("Elevation tile %s: %s", url, e)
                return None
            # http.client.IncompleteRead (a connection dropped mid-body) is
            # no OSError
            except (OSError, HTTPException, ValueError) as e:
                # Whatever state the connection is in, the next attempt
                # starts a fresh one
                self._close_connection()
                error = e
                unreachable = True
            else:
                if status == 200:
                    with self._server_error_lock:
                        self._server_error_tiles = 0
                    return data
                if status not in _RETRIED_HTTP_CODES:
                    # The host answered: this tile is missing, the others
                    # may not be
                    logger.debug("Elevation tile %s: HTTP %s", url, status)
                    return None
                error = f"HTTP {status}"
                unreachable = False
            logger.debug(
                "Elevation tile %s, attempt %d of %d: %s",
                url,
                attempt + 1,
                FETCH_ATTEMPTS,
                error,
            )
        if unreachable and not self._offline.is_set():
            self._offline.set()
            logger.debug("Elevation tiles unreachable: %s", error)
        elif not unreachable:
            with self._server_error_lock:
                self._server_error_tiles += 1
                given_up = self._server_error_tiles >= SERVER_ERROR_TILES_TO_GIVE_UP
            if given_up and not self._offline.is_set():
                self._offline.set()
                logger.debug(
                    "Elevation tiles: %d tiles in a row got %s, giving the host up",
                    SERVER_ERROR_TILES_TO_GIVE_UP,
                    error,
                )
        return None

    def _download(self, tile: TileKey) -> int:
        """Fetch a tile into the cache; the bytes fetched, 0 when it failed."""
        if self._offline.is_set():
            return 0
        url = TILE_URL.format(z=tile.z, x=tile.x, y=tile.y)
        data = self._fetch(url)
        if data is None:
            return 0
        if len(data) > MAX_TILE_BYTES or not is_tile_png(data):
            logger.debug("Elevation tile %s is not a PNG tile", url)
            return 0
        try:
            # Readable like a regular write, for a shared cache (a build
            # container, a CI runner)
            atomic_bytes_write(self.path(tile), data)
        except OSError as e:
            logger.debug("Cannot cache elevation tile %s: %s", url, e)
            return 0
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
        try:
            with ThreadPoolExecutor(max_workers=FETCH_WORKERS) as pool:
                fetched = [size for size in pool.map(self._download, missing) if size]
        finally:
            # The threads are gone; their connections would only wait for
            # the host to drop them
            with self._opened_lock:
                opened, self._opened = self._opened, []
            for connection in opened:
                connection.close()
        logger.info(
            "  Downloaded %d of %d elevation tile(s), %.1f MB in %.1f s",
            len(fetched),
            len(missing),
            sum(fetched) / 1024 / 1024,
            time.monotonic() - started,
        )

    def pixels(
        self, wanted: Mapping[TileKey, Sequence[int]]
    ) -> dict[TileKey, Sequence[float]]:
        """Fetch what is missing, then decode the pixels of every tile."""
        self.fetch(wanted)
        cached = [
            (tile, self.path(tile)) for tile in wanted if self.path(tile).is_file()
        ]
        paths = [path for _, path in cached]
        indices = [wanted[tile] for tile, _ in cached]
        # Decoding a tile takes a few tens of milliseconds of pure Python,
        # which adds up over hundreds of them; the cores share it. Once the
        # pixels of every tile are kept, reading them takes less time than
        # starting the pool.
        # The pixels of an older version count: after an upgrade every tile
        # is decoded again, which the pool takes a tenth of the time for
        to_decode = sum(not _has_current_pixels(path) for path in paths)
        if to_decode < DECODE_POOL_MIN_TILES:
            decoded = list(map(_decode_cached_tile, paths, indices, strict=True))
        else:
            workers = min(default_worker_count(), len(cached))
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
# The ground under the points of a path, in metres: one value per point, in
# the order of the points, and NaN for a point the tiles do not cover. An
# array rather than a mapping of coordinates, because a million points in
# Python objects take a gigabyte and are pickled into every export chunk.
type PointElevations = array[float]
TILE_PIXELS = TILE_SIZE * TILE_SIZE


def _position(lat: float, lon: float, zoom: int) -> tuple[int, int, float, float]:
    """Where a point is among the pixels around it.

    Pixels are counted across the whole world at ``zoom``. Returns the
    column and the row of the pixel whose centre is up and to the left of
    the point, then the fractions of the way from it to the next column and
    the next row. The column wraps across the antimeridian; the row is -1
    above the centre of the top row.
    """
    world = TILE_SIZE << zoom
    # Web Mercator in the form the tests and the frontend measure a pixel
    # position in: the projection of geometry.web_mercator, but another
    # formula for it rounds differently, which moves a point by a bit and,
    # once in a few million, into the next pixel
    lat = max(min(lat, TERRAIN_MAX_LATITUDE), -TERRAIN_MAX_LATITUDE)
    sin = math.sin(math.radians(lat))
    x = (lon + 180) / 360 * world - 0.5
    y = (0.5 - math.log((1 + sin) / (1 - sin)) / (4 * math.pi)) * world - 0.5
    left = math.floor(x)
    top = math.floor(y)
    return left % world, top, x - left, y - top


def _corner_pixels(left: int, top: int, zoom: int) -> list[tuple[int, int]]:
    """The four pixels around a point of ``_position``, as tile and index.

    Top left, top right, bottom left, bottom right; a tile is numbered row
    by row across the world (``y * tiles + x``) and a pixel within it the
    same way. Across the antimeridian the world wraps; at the top and bottom
    the edge row stands in for the one beyond.
    """
    world = TILE_SIZE << zoom
    right = (left + 1) % world
    bottom = min(top + 1, world - 1)
    top = max(top, 0)
    tiles = 1 << zoom
    return [
        (
            row // TILE_SIZE * tiles + column // TILE_SIZE,
            row % TILE_SIZE * TILE_SIZE + column % TILE_SIZE,
        )
        for row in (top, bottom)
        for column in (left, right)
    ]


def sample_elevations(
    coordinates: Iterable[Coordinate],
    source: TileSource,
    zoom: int = TERRAIN_ZOOM,
) -> tuple[PointElevations, int, int]:
    """The ground elevation in metres at every coordinate, in their order.

    Bilinear between the four pixels around a coordinate, which can be in
    up to four tiles: the relief runs on across tile edges. A coordinate
    with a pixel of a missing tile is NaN. Also returns how many tiles were
    asked for and how many of them were missing.

    Every pixel is asked for once. Nothing is kept per coordinate but four
    numbers in arrays, and the pixels of one tile at a time are looked up
    in a dense array; only the rare coordinate whose pixels are in several
    tiles goes through a mapping.
    """
    tiles_across = 1 << zoom
    last = TILE_SIZE - 1
    lefts = array("i")
    tops = array("i")
    fractions_x = array("d")
    fractions_y = array("d")
    # The pixels each tile is asked for, one byte per pixel
    wanted_pixels: dict[int, bytearray] = {}
    # The points whose four pixels are all in one tile, by that tile
    inner: dict[int, array[int]] = {}
    # The other points, and the pixels they need of each tile
    across: list[int] = []
    across_pixels: dict[int, set[int]] = {}

    def tile_pixels(tile: int) -> bytearray:
        pixels = wanted_pixels.get(tile)
        if pixels is None:
            pixels = wanted_pixels[tile] = bytearray(TILE_PIXELS)
        return pixels

    previous: Coordinate | None = None
    position = (0, 0, 0.0, 0.0)
    # The tile of the last point: the next one is mostly in it as well
    current = -1
    current_pixels = bytearray()
    current_points = array("i")
    for point, coordinate in enumerate(coordinates):
        # Consecutive points of a slow flight often round to the same place
        if coordinate != previous:
            position = _position(coordinate[0], coordinate[1], zoom)
            previous = coordinate
        left, top, fraction_x, fraction_y = position
        lefts.append(left)
        tops.append(top)
        fractions_x.append(fraction_x)
        fractions_y.append(fraction_y)
        if left & last != last and top >= 0 and top & last != last:
            tile = top // TILE_SIZE * tiles_across + left // TILE_SIZE
            if tile != current:
                current = tile
                current_pixels = tile_pixels(tile)
                current_points = inner.setdefault(tile, array("i"))
            index = (top & last) * TILE_SIZE + (left & last)
            current_pixels[index] = current_pixels[index + 1] = 1
            current_pixels[index + TILE_SIZE] = 1
            current_pixels[index + TILE_SIZE + 1] = 1
            current_points.append(point)
        else:
            across.append(point)
            for tile, index in _corner_pixels(left, top, zoom):
                tile_pixels(tile)[index] = 1
                across_pixels.setdefault(tile, set()).add(index)

    keys = {
        tile: TileKey(zoom, tile % tiles_across, tile // tiles_across)
        for tile in wanted_pixels
    }
    wanted = {
        keys[tile]: array("H", compress(range(TILE_PIXELS), wanted_pixels.pop(tile)))
        for tile in list(wanted_pixels)
    }
    answered = source.pixels(wanted)

    elevations = array("d", [math.nan]) * len(lefts)
    unknown_tile = array("d", [math.nan]) * TILE_PIXELS
    across_values: dict[tuple[int, int], float] = {}
    for tile, key in keys.items():
        values = answered.get(key)
        if values is None:
            continue
        dense = array("d", unknown_tile)
        for index, value in zip(wanted[key], values, strict=True):
            dense[index] = value
        for index in across_pixels.get(tile, ()):
            across_values[tile, index] = dense[index]
        for point in inner.get(tile, ()):
            index = (tops[point] & last) * TILE_SIZE + (lefts[point] & last)
            top_left = dense[index]
            bottom_left = dense[index + TILE_SIZE]
            fraction_x = fractions_x[point]
            upper = top_left + (dense[index + 1] - top_left) * fraction_x
            lower = (
                bottom_left + (dense[index + TILE_SIZE + 1] - bottom_left) * fraction_x
            )
            elevations[point] = upper + (lower - upper) * fractions_y[point]
    for point in across:
        top_left, top_right, bottom_left, bottom_right = (
            across_values.get(pixel, math.nan)
            for pixel in _corner_pixels(lefts[point], tops[point], zoom)
        )
        upper = top_left + (top_right - top_left) * fractions_x[point]
        lower = bottom_left + (bottom_right - bottom_left) * fractions_x[point]
        elevations[point] = upper + (lower - upper) * fractions_y[point]
    return elevations, len(wanted), len(wanted) - len(answered)


def _rounded(path: FlightPath) -> Iterable[Coordinate]:
    return (
        (round(point.lat, COORDINATE_DECIMALS), round(point.lon, COORDINATE_DECIMALS))
        for point in path
    )


def sample_path_elevations(
    paths: Mapping[int, FlightPath], source: TileSource
) -> dict[int, PointElevations]:
    """The ground under every point of the given paths, keyed like them.

    Each path gets the elevations in metres of its points, in their order,
    at the coordinate as the exporter rounds it, which is what its segment
    rows carry. A point the tiles do not cover is NaN, and a path none of
    whose points they cover is left out. Logs one summary, and one warning
    when tiles were missing; never raises for a tile it could not get,
    unless ``KML_HEATMAP_REQUIRE_TERRAIN`` is "1": then a missing tile or a
    decoding pool that died raises ``TerrainUnavailableError``.
    """
    started = time.monotonic()
    required = os.environ.get(REQUIRE_TERRAIN_ENV) == "1"
    try:
        elevations, tiles, missing = sample_elevations(
            (coordinate for path in paths.values() for coordinate in _rounded(path)),
            source,
        )
    except DecodeFailedError as e:
        if required:
            raise TerrainUnavailableError(
                f"The elevation tiles could not be decoded ({e}), and "
                f"{REQUIRE_TERRAIN_ENV}=1 requires them"
            ) from e
        logger.warning(
            "Terrain: the elevation tiles could not be decoded (%s); every "
            "flight keeps the ground between its airfields",
            e,
        )
        return {}
    by_path: dict[int, PointElevations] = {}
    uncovered = 0
    offset = 0
    for index, path in paths.items():
        own = elevations[offset : offset + len(path)]
        offset += len(path)
        gaps = sum(map(math.isnan, own))
        if gaps:
            uncovered += 1
        if gaps < len(own):
            by_path[index] = own
    logger.info(
        "  Sampled the ground under %s point(s) from %d elevation tile(s) in %.1f s",
        f"{len(elevations):,}",
        tiles,
        time.monotonic() - started,
    )
    if missing and required:
        raise TerrainUnavailableError(
            f"{missing} of {tiles} elevation tile(s) are unavailable, and "
            f"{REQUIRE_TERRAIN_ENV}=1 requires every one"
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


def elevations_by_coordinate(
    path: FlightPath, elevations: PointElevations
) -> dict[Coordinate, float]:
    """The elevations of ``sample_path_elevations`` by rounded coordinate.

    What ``ground_profile_ft`` looks the rows of the path up in; the points
    the tiles do not cover are left out.
    """
    return {
        coordinate: elevation
        for coordinate, elevation in zip(_rounded(path), elevations, strict=True)
        if not math.isnan(elevation)
    }


# --- The ground of a flight ---------------------------------------------


def _field_offset_ft(
    rows: Sequence[SegmentRow], dem_ft: Sequence[float], order: Iterable[int]
) -> float | None:
    """How far the recorded field is above the model at one end of a path.

    The rows from that end up to the first fast one are its taxiing: the
    middle of their altitudes is the field as the recorder saw it, the
    middle of the model under them the field as the model has it. None for
    a path that starts or ends in the air, or without speeds to tell. A
    speed of 0 is no speed (see ``process_path_segments``), which ends the
    taxiing like a fast one, here and in the frontend (fieldFt).
    """
    altitudes: list[float] = []
    grounds: list[float] = []
    for index in order:
        row = rows[index]
        if not 0 < row[SPEED] < TAXI_KNOTS:
            break
        altitudes.append(row[ALTITUDE])
        grounds.append(dem_ft[index])
    if len(altitudes) < TAXI_MIN_FIXES:
        return None
    # The upper median, as the frontend takes it
    return median_high(altitudes) - median_high(grounds)


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
    the field, and the altitudes are rounded to 20 ft anyway.

    None when the path has no rows or a row without an elevation: a ground
    with a hole in it would be worse than the line between the fields.
    """
    if not rows or not start:
        return None
    dem_ft: list[float] = []
    for row in rows:
        elevation = elevations.get((row[LAT], row[LON]))
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
    points = [(start[0], start[1]), *((row[LAT], row[LON]) for row in rows)]
    for (lat0, lon0), (lat1, lon1) in pairwise(points):
        total += planar_metres(lat0, lon0, lat1, lon1)
        along.append(total)

    ground: list[float] = []
    for dem, distance in zip(dem_ft, along, strict=True):
        t = distance / total if total > 0 else 0.0
        feet = dem + from_ft + (to_ft - from_ft) * t
        ground.append(float(round(feet / GROUND_STEP) * GROUND_STEP))
    return ground
