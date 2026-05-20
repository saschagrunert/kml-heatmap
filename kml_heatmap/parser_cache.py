"""KML parse result caching."""

import json
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from .cache import CACHE_DIR, atomic_json_write

# KML parse cache subdirectory
KML_CACHE_DIR = CACHE_DIR / "kml"


def get_cache_key(
    kml_file: str, cache_dir: Optional[Path] = None
) -> Tuple[Optional[Path], bool]:
    """Generate cache key based on file path and modification time.

    Args:
        kml_file: Path to KML file
        cache_dir: Cache directory override (defaults to KML_CACHE_DIR)

    Returns:
        Tuple of (cache_path, is_valid) where is_valid indicates if cached data can be used
    """
    if cache_dir is None:
        cache_dir = KML_CACHE_DIR

    kml_path = Path(kml_file)

    # Create cache directory if it doesn't exist
    cache_dir.mkdir(parents=True, exist_ok=True)

    # Get file modification time
    try:
        mtime = kml_path.stat().st_mtime
    except (OSError, FileNotFoundError):
        return None, False

    # Create cache filename from KML filename and modification time
    cache_name = f"{kml_path.stem}_{int(mtime)}.json"
    cache_path = cache_dir / cache_name

    # Check if cache file exists
    if cache_path.exists():
        return cache_path, True

    # Clean up old cache files for this KML file (different mtime)
    for old_cache in cache_dir.glob(f"{kml_path.stem}_*.json"):
        if old_cache != cache_path:  # Don't delete the one we're about to write
            try:
                old_cache.unlink()
            except OSError:
                pass

    return cache_path, False


def load_cached_parse(
    cache_path: Path,
) -> Optional[Tuple[List[List[float]], List[List[List[float]]], List[Dict[str, Any]]]]:
    """Load cached parse results.

    Args:
        cache_path: Path to cache file

    Returns:
        Tuple of (coordinates, path_groups, path_metadata) or None if cache invalid
    """
    try:
        with open(cache_path, "r") as f:
            cached = json.load(f)
        return cached["coordinates"], cached["path_groups"], cached["path_metadata"]
    except (json.JSONDecodeError, KeyError, OSError):
        return None


def save_to_cache(
    cache_path: Path,
    coordinates: List[List[float]],
    path_groups: List[List[List[float]]],
    path_metadata: List[Dict[str, Any]],
    cache_dir: Optional[Path] = None,
) -> None:
    """Save parse results to cache.

    Args:
        cache_path: Path to cache file
        coordinates: List of coordinates
        path_groups: List of path groups
        path_metadata: List of path metadata dicts
        cache_dir: Cache directory override (defaults to KML_CACHE_DIR)
    """
    if cache_dir is None:
        cache_dir = KML_CACHE_DIR

    atomic_json_write(
        cache_path,
        {
            "coordinates": coordinates,
            "path_groups": path_groups,
            "path_metadata": path_metadata,
        },
        cache_dir,
    )
