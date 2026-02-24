"""Airport coordinate lookup from ICAO codes.

This module provides functionality to look up airport coordinates from
ICAO codes using the OurAirports database with local caching.
"""

import csv
import time
import threading
import urllib.error
from typing import Any, Dict, Optional, Tuple
from urllib.request import urlretrieve

# Try to import fcntl for Unix-like systems (for process-safe file locking)
try:
    import fcntl

    HAS_FCNTL = True
except ImportError:
    # Windows doesn't have fcntl
    HAS_FCNTL = False

from .cache import CACHE_DIR
from .logger import logger

__all__ = ["lookup_airport_coordinates", "get_cache_info"]

# OurAirports database URL
OURAIRPORTS_URL = "https://davidmegginson.github.io/ourairports-data/airports.csv"

# Cache settings
CACHE_FILE = CACHE_DIR / "airports.csv"
CACHE_LOCK_FILE = CACHE_DIR / "airports.lock"
CACHE_MAX_AGE_DAYS = 30

# Global cache for parsed airport data
_airport_cache: Optional[Dict[str, Tuple[float, float, str]]] = None

# Thread lock for database loading (prevents race conditions within a single process)
_cache_lock = threading.Lock()


def _is_cache_valid() -> bool:
    """Check if cached airport data is still valid.

    Returns:
        True if cache exists and is not too old
    """
    if not CACHE_FILE.exists():
        return False

    # Check file age
    file_age_seconds = time.time() - CACHE_FILE.stat().st_mtime
    file_age_days = file_age_seconds / (24 * 3600)

    return file_age_days < CACHE_MAX_AGE_DAYS


def _download_airport_database() -> bool:
    """Download OurAirports database to cache.

    Returns:
        True if download succeeded, False otherwise
    """
    try:
        # Create cache directory if it doesn't exist
        CACHE_DIR.mkdir(parents=True, exist_ok=True)

        logger.info("📥 Downloading OurAirports database...")
        urlretrieve(OURAIRPORTS_URL, CACHE_FILE)

        # Verify downloaded file
        if CACHE_FILE.exists() and CACHE_FILE.stat().st_size > 0:
            logger.info(
                f"✓ Downloaded {CACHE_FILE.stat().st_size / 1024 / 1024:.1f} MB airport database"
            )
            return True
        else:
            logger.warning("✗ Downloaded file is empty")
            return False

    except (OSError, urllib.error.URLError, ValueError) as e:
        logger.warning(f"✗ Failed to download airport database: {e}")
        return False


def _load_airport_database() -> Dict[str, Tuple[float, float, str]]:
    """Load airport database from cache or download if needed.

    This function is thread-safe and process-safe. It will only download
    the database once even when called from multiple threads or processes
    simultaneously.

    Returns:
        Dictionary mapping ICAO codes to (lat, lon, name) tuples
    """
    global _airport_cache

    # Fast path: return cached data if already loaded (no lock needed)
    if _airport_cache is not None:
        return _airport_cache

    # Acquire thread lock to ensure only one thread in this process loads the database
    with _cache_lock:
        # Double-check: another thread might have loaded it while we waited for the lock
        if _airport_cache is not None:
            return _airport_cache

        # Use file-based lock to coordinate across processes (Unix only)
        # Create cache directory if it doesn't exist
        CACHE_DIR.mkdir(parents=True, exist_ok=True)

        lock_file = None
        try:
            # Acquire exclusive lock if supported (works across processes on Unix)
            if HAS_FCNTL:
                lock_file = open(CACHE_LOCK_FILE, "w")
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)

            # Check again if cache is valid after acquiring lock
            # (another process might have downloaded it while we waited)
            if not _is_cache_valid():
                logger.debug("Airport database cache is stale or missing")
                _download_airport_database()

            # Try to load from cache
            if CACHE_FILE.exists():
                try:
                    airports = {}
                    with open(CACHE_FILE, "r", encoding="utf-8") as f:
                        reader = csv.DictReader(f)
                        for row in reader:
                            icao = row.get("ident", "").strip().upper()
                            # Only include airports with valid ICAO codes (4 characters)
                            if icao and len(icao) == 4:
                                try:
                                    lat = float(row.get("latitude_deg", ""))
                                    lon = float(row.get("longitude_deg", ""))
                                    name = row.get("name", "").strip()
                                    if name:
                                        airports[icao] = (lat, lon, name)
                                except (ValueError, TypeError):
                                    # Skip invalid entries
                                    continue

                    _airport_cache = airports
                    logger.debug(f"Loaded {len(airports):,} airports from cache")
                    return airports

                except (OSError, csv.Error, ValueError, UnicodeDecodeError) as e:
                    logger.warning(f"Failed to load airport cache: {e}")

            # Return empty dict if cache loading failed
            logger.warning("Airport database unavailable - airport lookups will fail")
            _airport_cache = {}
            return _airport_cache

        finally:
            # Release file lock if we acquired one
            if lock_file and HAS_FCNTL:
                try:
                    fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
                    lock_file.close()
                except Exception:
                    pass
            elif lock_file:
                try:
                    lock_file.close()
                except Exception:
                    pass


def lookup_airport_coordinates(icao_code: str) -> Optional[Tuple[float, float, str]]:
    """
    Look up airport coordinates from ICAO code.

    This function uses the OurAirports database (50,000+ airports worldwide)
    with local caching. The database is automatically downloaded on first use
    and refreshed every 30 days.

    Args:
        icao_code: 4-letter ICAO airport code (e.g., "EDDP")

    Returns:
        Tuple of (latitude, longitude, name) if found, None otherwise
    """
    if not icao_code or len(icao_code) != 4:
        logger.debug(f"Invalid ICAO code: {icao_code}")
        return None

    # Load database (from cache or download)
    airports = _load_airport_database()

    # Look up airport
    icao_upper = icao_code.upper()
    if icao_upper in airports:
        lat, lon, name = airports[icao_upper]
        logger.debug(f"Found airport {icao_upper}: {name} at ({lat}, {lon})")
        return (lat, lon, name)

    logger.debug(f"Airport {icao_upper} not found in database")
    return None


def get_cache_info() -> Dict[str, Any]:
    """Get information about the airport database cache.

    Returns:
        Dictionary with cache status information
    """
    info = {
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
