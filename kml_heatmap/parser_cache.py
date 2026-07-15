"""KML parse result caching."""

import json
from pathlib import Path

from .cache import CACHE_DIR, atomic_json_write
from .types import PathMetadata

# KML parse cache subdirectory
KML_CACHE_DIR = CACHE_DIR / "kml"


def get_cache_key(
    kml_file: str, cache_dir: Path | None = None
) -> tuple[Path | None, bool]:
    """Generate cache key based on file path and modification time."""
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
) -> tuple[list[list[float]], list[list[list[float]]], list[PathMetadata]] | None:
    """Load cached parse results, or None if cache is invalid."""
    try:
        with open(cache_path, "r") as f:
            cached = json.load(f)
        return cached["coordinates"], cached["path_groups"], cached["path_metadata"]
    except (json.JSONDecodeError, KeyError, OSError):
        return None


def save_to_cache(
    cache_path: Path,
    coordinates: list[list[float]],
    path_groups: list[list[list[float]]],
    path_metadata: list[PathMetadata],
    cache_dir: Path | None = None,
) -> None:
    """Save parse results to cache."""
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
