"""Airport coordinate lookup from ICAO codes using OurAirports with local caching."""

import contextlib
import csv
import os
import re
import ssl
import tempfile
import threading
import time
import urllib.error
from pathlib import Path
from typing import Any
from urllib.request import urlopen

# Try to import fcntl for Unix-like systems (for process-safe file locking)
try:
    import fcntl

    HAS_FCNTL = True
except ImportError:
    # Windows doesn't have fcntl
    HAS_FCNTL = False

from .cache import CACHE_DIR
from .constants import ICAO_REGION_PREFIXES
from .logger import logger

# Pre-compiled pattern for ICAO code extraction
_ICAO_PATTERN = re.compile(r"\b([A-Z]{4})\b")

__all__ = [
    "extract_icao_codes_from_name",
    "get_cache_info",
    "lookup_airport_coordinates",
    "lookup_airport_country",
    "standardize_airport_name",
]

# OurAirports database URL
OURAIRPORTS_URL = "https://davidmegginson.github.io/ourairports-data/airports.csv"

# Cache settings
CACHE_FILE = CACHE_DIR / "airports.csv"
CACHE_LOCK_FILE = CACHE_DIR / "airports.lock"
CACHE_MAX_AGE_DAYS = 30
DOWNLOAD_TIMEOUT_SECONDS = 30
MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024
REQUIRED_COLUMNS = ("ident", "name", "latitude_deg", "longitude_deg")

AirportRecord = tuple[float, float, str, str]

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


def _download_airport_database() -> bool:
    """Download the OurAirports database into the cache atomically."""
    tmp_path: Path | None = None
    try:
        cache_dir = CACHE_FILE.parent
        cache_dir.mkdir(parents=True, exist_ok=True)

        if not os.access(cache_dir, os.W_OK):
            logger.warning("✗ Airport cache directory is not writable: %s", cache_dir)
            return False

        logger.info("📥 Downloading OurAirports database...")
        context = ssl.create_default_context()
        with urlopen(  # nosec B310
            OURAIRPORTS_URL, timeout=DOWNLOAD_TIMEOUT_SECONDS, context=context
        ) as response:
            data = response.read(MAX_DOWNLOAD_BYTES + 1)

        if len(data) > MAX_DOWNLOAD_BYTES:
            logger.warning(
                "✗ Airport database exceeds %d MB, refusing to cache it",
                MAX_DOWNLOAD_BYTES // (1024 * 1024),
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

        os.replace(tmp_path, CACHE_FILE)
        tmp_path = None
        logger.info("✓ Downloaded %.1f MB airport database", len(data) / 1024 / 1024)
        return True

    except (OSError, urllib.error.URLError, ValueError) as e:
        logger.warning("✗ Failed to download airport database: %s", e)
        return False
    finally:
        if tmp_path is not None:
            with contextlib.suppress(OSError):
                tmp_path.unlink()


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
            if name:
                airports[icao] = (lat, lon, name, country)
    return airports


def _load_airport_database() -> dict[str, AirportRecord]:
    """Load airport database from cache or download if needed."""
    global _airport_cache

    # Fast path: return cached data if already loaded (no lock needed)
    if _airport_cache is not None:
        return _airport_cache

    # Acquire thread lock to ensure only one thread in this process loads the database
    with _cache_lock:
        # Double-check: another thread might have loaded it while we waited for the lock
        if _airport_cache is not None:
            return _airport_cache

        # Use file-based lock to coordinate across processes (Unix only). A cache
        # directory that cannot be written (read-only mount, foreign owner) only
        # disables the lock; loading continues.
        try:
            CACHE_DIR.mkdir(parents=True, exist_ok=True)
        except OSError as e:
            logger.debug("Cannot create cache directory %s: %s", CACHE_DIR, e)

        lock_file = None
        try:
            if HAS_FCNTL:
                try:
                    lock_file = open(CACHE_LOCK_FILE, "w", encoding="utf-8")  # noqa: SIM115
                    fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
                except OSError as e:
                    logger.debug(
                        "Cannot lock %s, continuing without: %s", CACHE_LOCK_FILE, e
                    )
                    if lock_file is not None:
                        lock_file.close()
                    lock_file = None

            # Check again if cache is valid after acquiring lock
            # (another process might have downloaded it while we waited)
            if not _is_cache_valid():
                logger.debug("Airport database cache is stale, missing or invalid")
                _download_airport_database()

            if CACHE_FILE.exists():
                try:
                    airports = _read_airport_csv(CACHE_FILE)
                    _airport_cache = airports
                    logger.debug("Loaded %s airports from cache", f"{len(airports):,}")
                    return airports
                except (OSError, csv.Error, ValueError, UnicodeDecodeError) as e:
                    logger.warning("Failed to load airport cache: %s", e)

            logger.warning("Airport database unavailable - airport lookups will fail")
            _airport_cache = {}
            return _airport_cache

        finally:
            if lock_file:
                try:
                    if HAS_FCNTL:
                        fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
                    lock_file.close()
                except OSError:
                    pass


def lookup_airport_coordinates(icao_code: str) -> tuple[float, float, str] | None:
    """Look up airport coordinates from ICAO code using OurAirports."""
    if not icao_code or len(icao_code) != 4:
        logger.debug("Invalid ICAO code: %s", icao_code)
        return None

    airports = _load_airport_database()

    icao_upper = icao_code.upper()
    if icao_upper in airports:
        lat, lon, name, _ = airports[icao_upper]
        logger.debug("Found airport %s: %s at (%s, %s)", icao_upper, name, lat, lon)
        return (lat, lon, name)

    logger.debug("Airport %s not found in database", icao_upper)
    return None


def lookup_airport_country(icao_code: str) -> str | None:
    """Look up airport country code from ICAO code using OurAirports."""
    if not icao_code or len(icao_code) != 4:
        return None

    airports = _load_airport_database()

    icao_upper = icao_code.upper()
    if icao_upper in airports:
        _, _, _, country = airports[icao_upper]
        return country if country else None

    return None


def get_cache_info() -> dict[str, Any]:
    """Get information about the airport database cache."""
    info: dict[str, Any] = {
        "cache_file": str(CACHE_FILE),
        "cache_exists": CACHE_FILE.exists(),
        "cache_valid": _is_cache_valid(),
        "database_loaded": _airport_cache is not None,
    }

    if CACHE_FILE.exists():
        stat = CACHE_FILE.stat()
        info["cache_size_mb"] = stat.st_size / 1024 / 1024
        info["cache_age_days"] = (time.time() - stat.st_mtime) / (24 * 3600)

    if _airport_cache is not None:
        info["airport_count"] = len(_airport_cache)

    return info


def extract_icao_codes_from_name(airport_name: str | None) -> list[str]:
    """Extract potential ICAO airport codes from an airport name string."""
    if not airport_name:
        return []

    matches = _ICAO_PATTERN.findall(airport_name)

    # Filter to valid ICAO region prefixes (excludes I, J, Q, X which are not
    # assigned to airport codes), helping reject false positives like month names
    return [code for code in matches if code[0] in ICAO_REGION_PREFIXES]


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


def standardize_airport_name(airport_name: str | None) -> str | None:
    """Standardize airport name using OurAirports database."""
    if not airport_name:
        return airport_name

    icao_codes = extract_icao_codes_from_name(airport_name)

    if not icao_codes:
        return airport_name

    # Handle route format "AIRPORT1 Name1 - AIRPORT2 Name2"
    if " - " in airport_name and len(icao_codes) == 2:
        coords1 = lookup_airport_coordinates(icao_codes[0])
        coords2 = lookup_airport_coordinates(icao_codes[1])
        parts = airport_name.split(" - ")

        if coords1 and coords2:
            clean_name1 = _strip_airport_suffix(coords1[2])
            clean_name2 = _strip_airport_suffix(coords2[2])
            standardized = (
                f"{icao_codes[0]} {clean_name1} - {icao_codes[1]} {clean_name2}"
            )
            logger.debug("Standardized route: %s -> %s", airport_name, standardized)
            return standardized
        if coords1:
            clean_name1 = _strip_airport_suffix(coords1[2])
            standardized = f"{icao_codes[0]} {clean_name1} - {parts[1]}"
            logger.debug("Standardized start: %s -> %s", airport_name, standardized)
            return standardized
        if coords2:
            clean_name2 = _strip_airport_suffix(coords2[2])
            standardized = f"{parts[0]} - {icao_codes[1]} {clean_name2}"
            logger.debug("Standardized end: %s -> %s", airport_name, standardized)
            return standardized

    # Single airport format
    elif len(icao_codes) == 1:
        coords = lookup_airport_coordinates(icao_codes[0])
        if coords:
            clean_name = _strip_airport_suffix(coords[2])
            standardized = f"{icao_codes[0]} {clean_name}"
            logger.debug("Standardized airport: %s -> %s", airport_name, standardized)
            return standardized

    return airport_name
