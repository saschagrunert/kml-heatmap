"""KML parse result caching.

Cache files are keyed by the KML path, its size and modification time, the
cache format version and a fingerprint of the airport database, so any change
invalidates the entry. The airport database is part of the key because the
parser standardizes airport names with it: a file parsed while the database
was unavailable would otherwise keep its raw names until the KML changed.

Stale entries are not removed on the fly. ``prune_stale_cache_entries`` does
that in one pass over the cache directory before a run, which keeps a cold run
over many files linear instead of listing the directory once per file.
"""

import contextlib
import hashlib
import json
import re
from pathlib import Path
from typing import Any

from .airport_lookup import database_fingerprint
from .cache import CACHE_DIR, atomic_json_write
from .logger import logger
from .types import FlightPath, FlightPathGroup, PathMetadata, TrackPoint

__all__ = [
    "CACHE_FORMAT_VERSION",
    "KML_CACHE_DIR",
    "get_cache_key",
    "load_cached_parse",
    "prune_stale_cache_entries",
    "save_to_cache",
]

# Bump whenever the serialized structure changes.
CACHE_FORMAT_VERSION = 3

# KML parse cache subdirectory
KML_CACHE_DIR = CACHE_DIR / "kml"


_HASH_TOKEN = re.compile(r"^[0-9a-f]{12}$")
_VERSION_TOKEN = re.compile(r"^v\d+$")


def _path_hash(kml_path: Path) -> str:
    return hashlib.sha256(str(kml_path.resolve()).encode()).hexdigest()[:12]


def _cache_prefix(kml_path: Path) -> str:
    """The part of a cache file name that identifies the KML file itself."""
    return f"{kml_path.stem}_{_path_hash(kml_path)}_"


def _entry_prefix(name: str) -> str | None:
    """Recover the file prefix from a cache entry name of any format version.

    The stem may contain underscores, so the prefix ends at the 12 hex digit
    path hash that is followed by the version token.
    """
    if not name.endswith(".json"):
        return None
    tokens = name[: -len(".json")].split("_")
    for index in range(1, len(tokens) - 1):
        if _HASH_TOKEN.match(tokens[index]) and _VERSION_TOKEN.match(tokens[index + 1]):
            return "_".join(tokens[: index + 1]) + "_"
    return None


def _cache_name(kml_path: Path) -> str | None:
    try:
        stat = kml_path.stat()
    except OSError:
        return None
    return (
        f"{_cache_prefix(kml_path)}v{CACHE_FORMAT_VERSION}"
        f"_{stat.st_mtime_ns}_{stat.st_size}_{database_fingerprint()}.json"
    )


def get_cache_key(
    kml_file: str, cache_dir: Path | None = None
) -> tuple[Path | None, bool]:
    """Return the cache path for a KML file and whether a cache entry exists."""
    if cache_dir is None:
        cache_dir = KML_CACHE_DIR

    try:
        cache_dir.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        logger.debug("Parse cache unavailable (%s): %s", cache_dir, e)
        return None, False

    cache_name = _cache_name(Path(kml_file))
    if cache_name is None:
        return None, False

    cache_path = cache_dir / cache_name
    return cache_path, cache_path.exists()


def prune_stale_cache_entries(
    kml_files: list[str], cache_dir: Path | None = None
) -> int:
    """Remove outdated cache entries of the given files in one directory pass.

    An entry is outdated when it belongs to one of the files but is not the
    entry the current size, modification time, version and airport database
    would produce. Entries of files outside this run are left alone. Returns
    the number of removed entries.
    """
    if cache_dir is None:
        cache_dir = KML_CACHE_DIR

    current: dict[str, str] = {}
    for kml_file in kml_files:
        kml_path = Path(kml_file)
        cache_name = _cache_name(kml_path)
        if cache_name is not None:
            current[_cache_prefix(kml_path)] = cache_name

    try:
        entries = list(cache_dir.iterdir())
    except OSError:
        return 0

    removed = 0
    for entry in entries:
        prefix = _entry_prefix(entry.name)
        if prefix is None or prefix not in current or entry.name == current[prefix]:
            continue
        with contextlib.suppress(OSError):
            entry.unlink()
            removed += 1

    if removed:
        logger.debug("Removed %d stale parse cache entries", removed)
    return removed


def _point_from_json(item: Any) -> TrackPoint:
    lat, lon, alt, ts = item
    return TrackPoint(float(lat), float(lon), alt, ts)


def load_cached_parse(
    cache_path: Path,
) -> tuple[FlightPath, FlightPathGroup, list[PathMetadata]] | None:
    """Load cached parse results, or None if the cache entry is invalid.

    Path points are stored as indices into the coordinate list, so a path
    point and its coordinate entry are the same object after loading, as
    they are after parsing.
    """
    try:
        with open(cache_path, encoding="utf-8") as f:
            cached = json.load(f)
        if cached.get("version") != CACHE_FORMAT_VERSION:
            logger.debug("Cache file %s has an unsupported version", cache_path)
            return None
        coordinates = [_point_from_json(item) for item in cached["coordinates"]]
        path_groups = [
            [
                coordinates[item] if isinstance(item, int) else _point_from_json(item)
                for item in path
            ]
            for path in cached["path_groups"]
        ]
        path_metadata: list[PathMetadata] = cached["path_metadata"]
        if not isinstance(path_metadata, list):
            raise TypeError("path_metadata must be a list")
    except (
        json.JSONDecodeError,
        IndexError,
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
) -> None:
    """Save parse results to cache.

    The parser appends every path point to the coordinate list as well, so a
    path is stored as the indices of its points. A point that is not in the
    coordinate list (results built by hand) is stored in full instead.
    """
    index_by_id = {id(point): index for index, point in enumerate(coordinates)}

    def encode(point: TrackPoint) -> int | list[Any]:
        index = index_by_id.get(id(point))
        return list(point) if index is None else index

    atomic_json_write(
        cache_path,
        {
            "version": CACHE_FORMAT_VERSION,
            "coordinates": [list(point) for point in coordinates],
            "path_groups": [[encode(point) for point in path] for path in path_groups],
            "path_metadata": path_metadata,
        },
    )
