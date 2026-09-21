"""Airport coordinate lookup from ICAO codes using OurAirports with local caching."""

import contextlib
import csv
import hashlib
import http.client
import os
import re
import ssl
import tempfile
import threading
import time
import urllib.error
from pathlib import Path
from typing import NamedTuple
from urllib.request import urlopen

# Try to import fcntl for Unix-like systems (for process-safe file locking)
try:
    import fcntl

    HAS_FCNTL = True
except ImportError:
    # Windows doesn't have fcntl
    HAS_FCNTL = False

from .cache import CACHE_DIR, REGULAR_FILE_MODE
from .constants import FEET_TO_METERS, ICAO_REGION_PREFIXES
from .exceptions import AirportDatabaseError
from .helpers import DATE_PATTERN
from .logger import logger

# Pre-compiled pattern for ICAO code extraction
_ICAO_PATTERN = re.compile(r"\b([A-Z]{4})\b")

# Route names: "EDDS Stuttgart - EDDP Leipzig" or "EDDS to EDDP - 16 Aug 2026"
_ROUTE_SEPARATOR = re.compile(r"\s+(?:-|to)\s+")
_ROUTE_DATE_SUFFIX = re.compile(rf"\s+-\s+{DATE_PATTERN.pattern}\s*$")

__all__ = [
    "REQUIRE_DATABASE_ENV",
    "AirportNames",
    "airport_icao_code",
    "database_fingerprint",
    "extract_icao_codes_from_name",
    "load_airport_database",
    "lookup_airport_coordinates",
    "lookup_airport_country",
    "lookup_airport_elevation",
    "split_route_name",
    "standardize_airport_names",
    "standardize_route",
    "use_airport_database",
]

# OurAirports database URL
OURAIRPORTS_URL = "https://davidmegginson.github.io/ourairports-data/airports.csv"

# Cache settings
CACHE_FILE = CACHE_DIR / "airports.csv"
CACHE_LOCK_FILE = CACHE_DIR / "airports.lock"
# Touched when a download fails so that the other processes of the same run
# (and the next runs within DOWNLOAD_RETRY_SECONDS) do not each wait for the
# timeout again while offline
DOWNLOAD_FAILED_MARKER = CACHE_DIR / "airports.download-failed"
CACHE_MAX_AGE_DAYS = 30
DOWNLOAD_TIMEOUT_SECONDS = 30
DOWNLOAD_RETRY_SECONDS = 3600
MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024
# The database has about 86,000 rows; a body far below that was cut off
MIN_DOWNLOAD_ROWS = 50_000
REQUIRED_COLUMNS = ("ident", "name", "latitude_deg", "longitude_deg")
# Set to "1" to fail instead of running without airport names (CI, deploys)
REQUIRE_DATABASE_ENV = "KML_HEATMAP_REQUIRE_AIRPORT_DB"


class AirportRecord(NamedTuple):
    """One airport of the database; the elevation is missing for some."""

    lat: float
    lon: float
    name: str
    country: str
    elevation_m: float | None = None


# Global cache for parsed airport data
_airport_cache: dict[str, AirportRecord] | None = None

# Thread lock for database loading (prevents race conditions within a single process)
_cache_lock = threading.Lock()


def _is_valid_csv_file(path: Path) -> bool:
    """Check that a CSV file is non-empty, complete and has the required header."""
    try:
        if path.stat().st_size == 0:
            return False
        with open(path, "rb") as f:
            header_line = f.readline()
            f.seek(-1, os.SEEK_END)
            last_byte = f.read(1)
        if last_byte != b"\n":
            return False  # truncated download
        header = header_line.decode("utf-8", errors="replace").strip()
        columns = next(csv.reader([header]))
    except OSError, csv.Error, StopIteration, UnicodeDecodeError:
        return False

    return all(column in columns for column in REQUIRED_COLUMNS)


def _is_cache_valid() -> bool:
    """Check if cached airport data is present, recent and well-formed."""
    if not CACHE_FILE.exists():
        return False

    file_age_seconds = time.time() - CACHE_FILE.stat().st_mtime
    file_age_days = file_age_seconds / (24 * 3600)
    if file_age_days >= CACHE_MAX_AGE_DAYS:
        return False

    return _is_valid_csv_file(CACHE_FILE)


def _recent_download_failure() -> bool:
    """True when a download failed less than DOWNLOAD_RETRY_SECONDS ago."""
    try:
        age = time.time() - DOWNLOAD_FAILED_MARKER.stat().st_mtime
    except OSError:
        return False
    return 0 <= age < DOWNLOAD_RETRY_SECONDS


def _record_download_failure() -> None:
    with contextlib.suppress(OSError):
        DOWNLOAD_FAILED_MARKER.touch()


def _clear_download_failure() -> None:
    with contextlib.suppress(OSError):
        DOWNLOAD_FAILED_MARKER.unlink()


def _fetch_airport_database(cache_dir: Path) -> bool:
    """Download the database into the cache; False on any failure."""
    tmp_path: Path | None = None
    try:
        logger.info("📥 Downloading OurAirports database...")
        context = ssl.create_default_context()
        with urlopen(  # nosec B310
            OURAIRPORTS_URL, timeout=DOWNLOAD_TIMEOUT_SECONDS, context=context
        ) as response:
            data = response.read(MAX_DOWNLOAD_BYTES + 1)
            content_length = response.headers.get("Content-Length")

        if len(data) > MAX_DOWNLOAD_BYTES:
            logger.warning(
                "✗ Airport database exceeds %d MB, refusing to cache it",
                MAX_DOWNLOAD_BYTES // (1024 * 1024),
            )
            return False

        # A body shorter than announced ends the read without an error, and a
        # cut at a line boundary still looks like a complete CSV file
        if (
            content_length is not None
            and content_length.isdigit()
            and len(data) != int(content_length)
        ):
            logger.warning(
                "✗ Airport database download is incomplete (%d of %s bytes)",
                len(data),
                content_length,
            )
            return False
        rows = data.count(b"\n")
        if rows < MIN_DOWNLOAD_ROWS:
            logger.warning(
                "✗ Airport database download has only %d rows, expected at least %d",
                rows,
                MIN_DOWNLOAD_ROWS,
            )
            return False

        with tempfile.NamedTemporaryFile(
            dir=cache_dir, prefix="airports.", suffix=".tmp", delete=False
        ) as tmp:
            tmp_path = Path(tmp.name)
            tmp.write(data)

        if not _is_valid_csv_file(tmp_path):
            logger.warning("✗ Downloaded airport database is empty or invalid")
            return False

        # NamedTemporaryFile creates the file with mode 0600; a shared cache
        # directory (a build container, a CI runner) needs it readable
        os.chmod(tmp_path, REGULAR_FILE_MODE)
        os.replace(tmp_path, CACHE_FILE)
        tmp_path = None
        logger.info("✓ Downloaded %.1f MB airport database", len(data) / 1024 / 1024)
        return True

    # http.client.IncompleteRead (a connection dropped mid-body) is no OSError
    except (
        OSError,
        urllib.error.URLError,
        http.client.HTTPException,
        ValueError,
    ) as e:
        logger.warning("✗ Failed to download airport database: %s", e)
        return False
    finally:
        if tmp_path is not None:
            with contextlib.suppress(OSError):
                tmp_path.unlink()


def _download_airport_database() -> bool:
    """Download the OurAirports database into the cache atomically.

    A failed attempt is remembered in the cache directory and not retried
    for DOWNLOAD_RETRY_SECONDS, so an offline run pays the timeout once
    instead of once per worker process.
    """
    cache_dir = CACHE_FILE.parent
    try:
        cache_dir.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        logger.warning("✗ Cannot create airport cache directory %s: %s", cache_dir, e)
        return False

    if not os.access(cache_dir, os.W_OK):
        logger.warning("✗ Airport cache directory is not writable: %s", cache_dir)
        return False

    if _recent_download_failure():
        logger.debug(
            "Skipping airport database download: the last attempt failed less "
            "than %d s ago",
            DOWNLOAD_RETRY_SECONDS,
        )
        return False

    if _fetch_airport_database(cache_dir):
        _clear_download_failure()
        return True

    _record_download_failure()
    return False


def _read_airport_csv(path: Path) -> dict[str, AirportRecord]:
    """Parse the airports CSV into a mapping of ICAO code to record."""
    airports: dict[str, AirportRecord] = {}
    with open(path, encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            icao = (row.get("ident") or "").strip().upper()
            # Only include airports with valid ICAO codes (4 characters)
            if not icao or len(icao) != 4:
                continue
            try:
                lat = float(row.get("latitude_deg") or "")
                lon = float(row.get("longitude_deg") or "")
            except ValueError:
                continue
            name = (row.get("name") or "").strip()
            country = (row.get("iso_country") or "").strip()
            try:
                elevation_m: float | None = (
                    float(row.get("elevation_ft") or "") * FEET_TO_METERS
                )
            except ValueError:
                elevation_m = None
            if name:
                airports[icao] = AirportRecord(lat, lon, name, country, elevation_m)
    return airports


def _ensure_cache_file() -> None:
    """Download the database when the cache is stale, under a file lock.

    The lock coordinates the processes of one run (Unix only). A cache
    directory that cannot be written (read-only mount, foreign owner) only
    disables the lock; loading continues. Only the download runs under the
    lock: parsing the CSV is per process and must not serialize the workers.
    """
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        logger.debug("Cannot create cache directory %s: %s", CACHE_DIR, e)

    lock_file = None
    if HAS_FCNTL:
        try:
            lock_file = open(CACHE_LOCK_FILE, "w", encoding="utf-8")  # noqa: SIM115
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
        except OSError as e:
            logger.debug("Cannot lock %s, continuing without: %s", CACHE_LOCK_FILE, e)
            if lock_file is not None:
                lock_file.close()
            lock_file = None

    try:
        # Check again after acquiring the lock: another process might have
        # downloaded the database while we waited
        if not _is_cache_valid():
            logger.debug("Airport database cache is stale, missing or invalid")
            _download_airport_database()
    finally:
        if lock_file:
            try:
                if HAS_FCNTL:
                    fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
            except OSError:
                pass
            finally:
                # Closing releases the lock as well; a failed unlock must not
                # leak the descriptor
                with contextlib.suppress(OSError):
                    lock_file.close()


def _database_required() -> bool:
    return os.environ.get(REQUIRE_DATABASE_ENV) == "1"


def load_airport_database() -> dict[str, AirportRecord]:
    """Load the airport database from the cache, downloading it when needed.

    The parsed database is kept per process; the first call in a process
    pays for the parse (and possibly the download).

    Raises:
        AirportDatabaseError: When ``KML_HEATMAP_REQUIRE_AIRPORT_DB`` is "1"
            and no complete database could be loaded. Without it the run
            continues with raw airport names.
    """
    global _airport_cache

    # Fast path: return cached data if already loaded (no lock needed)
    if _airport_cache is not None:
        return _airport_cache

    # Only one thread per process loads the database
    with _cache_lock:
        # Double-check: another thread might have loaded it while we waited
        if _airport_cache is not None:
            return _airport_cache

        _ensure_cache_file()
        required = _database_required()

        # A stale but complete cache is still used when the download failed
        if CACHE_FILE.exists() and (not required or _is_valid_csv_file(CACHE_FILE)):
            try:
                airports = _read_airport_csv(CACHE_FILE)
            except (OSError, csv.Error, ValueError, UnicodeDecodeError) as e:
                logger.warning("Failed to load airport cache: %s", e)
            else:
                if airports or not required:
                    _airport_cache = airports
                    logger.debug("Loaded %s airports from cache", f"{len(airports):,}")
                    return airports

        if required:
            raise AirportDatabaseError(
                f"The OurAirports database could not be loaded from {CACHE_FILE}, "
                f"and {REQUIRE_DATABASE_ENV}=1 requires it"
            )
        logger.warning("Airport database unavailable - airport lookups will fail")
        _airport_cache = {}
        return _airport_cache


def use_airport_database(airports: dict[str, AirportRecord]) -> None:
    """Use a database another process loaded instead of loading it here."""
    global _airport_cache
    _airport_cache = airports


# The last fingerprint computed in this process, keyed by the file's path
# and stat: hashing the database takes a few milliseconds, and the parse
# cache asks for the fingerprint once per KML file
_fingerprint_memo: tuple[tuple[str, int, int, int], str] | None = None


def database_fingerprint() -> str:
    """A short token that changes whenever the cached airport database does.

    A hash of the content: the database is downloaded again every
    ``CACHE_MAX_AGE_DAYS``, and a download with the same bytes must not
    invalidate every parse cache entry, as its new modification time would.

    Returns ``"nodb"`` while there is no cached database, so results computed
    without one are told apart from results computed with it.
    """
    global _fingerprint_memo
    try:
        stat = CACHE_FILE.stat()
    except OSError:
        return "nodb"
    key = (str(CACHE_FILE), stat.st_size, stat.st_mtime_ns, stat.st_ino)
    if _fingerprint_memo is not None and _fingerprint_memo[0] == key:
        return _fingerprint_memo[1]
    try:
        with open(CACHE_FILE, "rb") as database:
            digest = hashlib.file_digest(database, "sha256").hexdigest()[:8]
    except OSError:
        return "nodb"
    _fingerprint_memo = (key, digest)
    return digest


def lookup_airport_coordinates(icao_code: str) -> tuple[float, float, str] | None:
    """Look up airport coordinates from ICAO code using OurAirports."""
    if not icao_code or len(icao_code) != 4:
        logger.debug("Invalid ICAO code: %s", icao_code)
        return None

    airports = load_airport_database()

    icao_upper = icao_code.upper()
    if icao_upper in airports:
        record = airports[icao_upper]
        logger.debug(
            "Found airport %s: %s at (%s, %s)",
            icao_upper,
            record.name,
            record.lat,
            record.lon,
        )
        return (record.lat, record.lon, record.name)

    logger.debug("Airport %s not found in database", icao_upper)
    return None


def lookup_airport_country(icao_code: str) -> str | None:
    """Look up airport country code from ICAO code using OurAirports."""
    if not icao_code or len(icao_code) != 4:
        return None

    airports = load_airport_database()

    icao_upper = icao_code.upper()
    if icao_upper in airports:
        country = airports[icao_upper].country
        return country if country else None

    return None


def lookup_airport_elevation(icao_code: str | None) -> float | None:
    """The field elevation of an airport in meters, None when unknown."""
    if not icao_code or len(icao_code) != 4:
        return None
    record = load_airport_database().get(icao_code.upper())
    return record.elevation_m if record is not None else None


def extract_icao_codes_from_name(airport_name: str | None) -> list[str]:
    """Extract potential ICAO airport codes from an airport name string."""
    if not airport_name:
        return []

    matches = _ICAO_PATTERN.findall(airport_name)

    # Filter to valid ICAO region prefixes (excludes I, J, Q, X which are not
    # assigned to airport codes), helping reject false positives like month names
    return [code for code in matches if code[0] in ICAO_REGION_PREFIXES]


def _starts_with_icao_code(text: str) -> bool:
    match = _ICAO_PATTERN.match(text)
    return match is not None and match.group(1)[0] in ICAO_REGION_PREFIXES


def airport_icao_code(airport_name: str | None) -> str | None:
    """The ICAO code of a single airport name, or None.

    Flight logs and standardized names lead with the code, so "EGDY RNAS
    Yeovilton" is EGDY. A name that does not start with a code has to hold
    exactly one.
    """
    codes = extract_icao_codes_from_name(airport_name)
    if not codes:
        return None
    if len(codes) == 1 or (airport_name and _starts_with_icao_code(airport_name)):
        return codes[0]
    return None


_AIRPORT_SUFFIXES = (
    " International Airport",
    " Regional Airport",
    " Municipal Airport",
    " Airport",
    " Airfield",
    " Air Base",
    " Heliport",
)


def _strip_airport_suffix(name: str) -> str:
    """Remove common airport suffixes for cleaner display."""
    for suffix in _AIRPORT_SUFFIXES:
        if name.endswith(suffix):
            return name[: -len(suffix)]
    return name


def _database_name(icao_code: str) -> str | None:
    """The standardized name of an airport ("EDDS Stuttgart"), or None."""
    coords = lookup_airport_coordinates(icao_code)
    if coords is None:
        return None
    return f"{icao_code} {_strip_airport_suffix(coords[2])}"


def split_route_name(name: str | None) -> tuple[str, str] | None:
    """Split a route name into its departure and arrival, or return None.

    A trailing date ("EDDS to EDDP - 16 Aug 2026") is not part of the route.
    Airport names may contain " - " themselves (LFBN "Niort - Marais
    Poitevin"), so in a name with ICAO codes only a separator (" - " or
    " to ") followed by a code can split it, and exactly one such separator
    must exist. A standardized single airport name is never a route. A name
    without any code splits at its only " - ".
    """
    if not name:
        return None
    name = _ROUTE_DATE_SUFFIX.sub("", name).strip()

    if not extract_icao_codes_from_name(name):
        parts = [part.strip() for part in name.split(" - ")]
        if len(parts) == 2 and all(parts):
            return parts[0], parts[1]
        return None

    icao_code = airport_icao_code(name)
    if icao_code is not None and _database_name(icao_code) == name:
        return None

    separators = [
        match
        for match in _ROUTE_SEPARATOR.finditer(name)
        if _starts_with_icao_code(name[match.end() :])
    ]
    if len(separators) != 1:
        return None
    # The name is stripped and a separator starts with whitespace, so neither
    # side can be empty
    return name[: separators[0].start()], name[separators[0].end() :]


class AirportNames(NamedTuple):
    """A standardized placemark name and, for a route, its two airports."""

    name: str | None
    start_airport: str | None = None
    end_airport: str | None = None


def _standardize_single_airport(name: str) -> str:
    icao_code = airport_icao_code(name)
    standardized = _database_name(icao_code) if icao_code else None
    if standardized is None:
        return name
    logger.debug("Standardized airport: %s -> %s", name, standardized)
    return standardized


def standardize_route(departure: str, arrival: str) -> AirportNames:
    """Standardize both airports of a route and build its display name."""
    start = _standardize_single_airport(departure)
    end = _standardize_single_airport(arrival)
    return AirportNames(f"{start} - {end}", start, end)


def standardize_airport_names(airport_name: str | None) -> AirportNames:
    """Standardize a placemark name using the OurAirports database.

    ICAO codes become "CODE Name". A route also returns its departure and
    arrival airport, so that nothing downstream has to split the display
    name (``split_route_name`` explains why that is ambiguous).
    """
    if not airport_name:
        return AirportNames(airport_name)

    route = split_route_name(airport_name)
    if route is not None:
        return standardize_route(*route)

    single = _ROUTE_DATE_SUFFIX.sub("", airport_name).strip() or airport_name
    return AirportNames(_standardize_single_airport(single))
