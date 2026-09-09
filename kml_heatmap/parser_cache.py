"""KML parse result caching.

Cache files are keyed by the KML path, its size and modification time, and
the cache format version, so any change invalidates the entry.
"""

import contextlib
import hashlib
import json
from pathlib import Path
from typing import Any

from .cache import CACHE_DIR, atomic_json_write
from .logger import logger
from .types import FlightPath, FlightPathGroup, PathMetadata, TrackPoint

__all__ = [
    "CACHE_FORMAT_VERSION",
    "KML_CACHE_DIR",
    "get_cache_key",
    "load_cached_parse",
    "save_to_cache",
]

# Bump whenever the serialized structure changes.
CACHE_FORMAT_VERSION = 2

# KML parse cache subdirectory
KML_CACHE_DIR = CACHE_DIR / "kml"


def get_cache_key(
    kml_file: str, cache_dir: Path | None = None
) -> tuple[Path | None, bool]:
    """Return the cache path for a KML file and whether a cache entry exists."""
    if cache_dir is None:
        cache_dir = KML_CACHE_DIR

    kml_path = Path(kml_file)

    try:
        cache_dir.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        logger.debug("Parse cache unavailable (%s): %s", cache_dir, e)
        return None, False

    try:
        stat = kml_path.stat()
    except OSError:
        return None, False

    path_hash = hashlib.sha256(str(kml_path.resolve()).encode()).hexdigest()[:12]
    cache_name = (
        f"{kml_path.stem}_{path_hash}_v{CACHE_FORMAT_VERSION}"
        f"_{stat.st_mtime_ns}_{stat.st_size}.json"
    )
    cache_path = cache_dir / cache_name

    if cache_path.exists():
        return cache_path, True

    # Clean up stale cache files for this KML file (older mtime/size/version)
    for old_cache in cache_dir.glob(f"{kml_path.stem}_{path_hash}_*.json"):
        if old_cache != cache_path:
            with contextlib.suppress(OSError):
                old_cache.unlink()

    return cache_path, False


def _point_from_json(item: Any) -> TrackPoint:
    lat, lon, alt, ts = item
    return TrackPoint(float(lat), float(lon), alt, ts)


def load_cached_parse(
    cache_path: Path,
) -> tuple[FlightPath, FlightPathGroup, list[PathMetadata]] | None:
    """Load cached parse results, or None if the cache entry is invalid."""
    try:
        with open(cache_path, encoding="utf-8") as f:
            cached = json.load(f)
        if cached.get("version") != CACHE_FORMAT_VERSION:
            logger.debug("Cache file %s has an unsupported version", cache_path)
            return None
        coordinates = [_point_from_json(item) for item in cached["coordinates"]]
        path_groups = [
            [_point_from_json(item) for item in path] for path in cached["path_groups"]
        ]
        path_metadata: list[PathMetadata] = cached["path_metadata"]
        if not isinstance(path_metadata, list):
            raise TypeError("path_metadata must be a list")
    except (
        json.JSONDecodeError,
        KeyError,
        OSError,
        TypeError,
        ValueError,
        AttributeError,
    ) as e:
        logger.debug("Cache file %s is corrupt or unreadable: %s", cache_path, e)
        return None
    return coordinates, path_groups, path_metadata


def save_to_cache(
    cache_path: Path,
    coordinates: FlightPath,
    path_groups: FlightPathGroup,
    path_metadata: list[PathMetadata],
    cache_dir: Path | None = None,
) -> None:
    """Save parse results to cache."""
    if cache_dir is None:
        cache_dir = KML_CACHE_DIR

    atomic_json_write(
        cache_path,
        {
            "version": CACHE_FORMAT_VERSION,
            "coordinates": [list(point) for point in coordinates],
            "path_groups": [[list(point) for point in path] for path in path_groups],
            "path_metadata": path_metadata,
        },
        cache_dir,
    )
