"""KML parse result caching.

Cache files are keyed by the content and name of the KML file, the cache
format version, a fingerprint of the parser code and a fingerprint of the
airport database, so any change invalidates the entry. The content rather
than the modification time is hashed so that entries survive git checkouts
and CI clones; hashing costs little next to parsing. The name is part of the
key because the parse result carries it (and the aircraft taken from it). The
airport database is part of the key because the parser standardizes airport
names with it: a file parsed while the database was unavailable would
otherwise keep its raw names until the KML changed.

Stale entries are not removed on the fly. ``prune_stale_cache_entries`` does
that in one pass over the cache directory before a run: entries that another
parser, format version or airport database wrote can never be read again,
and any other entry goes once it has not been used for ``CACHE_MAX_AGE_DAYS``.
"""

import contextlib
import functools
import hashlib
import json
import os
import re
import time
from pathlib import Path
from typing import TYPE_CHECKING, Any

from .airport_lookup import database_fingerprint
from .cache import CACHE_DIR, atomic_json_write
from .logger import logger
from .types import FlightPath, FlightPathGroup, PathMetadata, TrackPoint

if TYPE_CHECKING:
    from collections.abc import Iterable

__all__ = [
    "CACHE_FORMAT_VERSION",
    "CACHE_MAX_AGE_DAYS",
    "KML_CACHE_DIR",
    "get_cache_key",
    "load_cached_parse",
    "parser_fingerprint",
    "prune_stale_cache_entries",
    "save_to_cache",
]

# Bump whenever the serialized structure changes.
CACHE_FORMAT_VERSION = 4

# Entries not read or written for this long are removed
CACHE_MAX_AGE_DAYS = 30

# KML parse cache subdirectory
KML_CACHE_DIR = CACHE_DIR / "kml"

# The modules whose code decides what a parse returns
_PARSER_MODULES = (
    "aircraft",
    "airport_lookup",
    "constants",
    "helpers",
    "parser",
    "parser_cache",
    "parser_common",
    "parser_gx_track",
    "parser_standard",
    "types",
)

_ENTRY_NAME = re.compile(
    r"^[0-9a-f]{32}_v(?P<version>\d+)_(?P<parser>[0-9a-f]{8})"
    r"_(?P<database>[0-9a-f]{8}|nodb)\.json$"
)
_HASH_CHUNK_BYTES = 1024 * 1024


@functools.cache
def parser_fingerprint() -> str:
    """A short token that changes whenever the parser code does."""
    digest = hashlib.sha256()
    package = Path(__file__).parent
    for module in _PARSER_MODULES:
        digest.update(module.encode())
        try:
            digest.update((package / f"{module}.py").read_bytes())
        except OSError:
            # No sources (a bytecode-only install): the format version
            # still invalidates entries on structural changes
            continue
    return digest.hexdigest()[:8]


def _content_digest(kml_path: Path) -> str | None:
    """Hash the file name and content of a KML file (None when unreadable)."""
    digest = hashlib.blake2b(kml_path.name.encode() + b"\0", digest_size=16)
    try:
        with open(kml_path, "rb") as f:
            while chunk := f.read(_HASH_CHUNK_BYTES):
                digest.update(chunk)
    except OSError:
        return None
    return digest.hexdigest()


def _cache_name(kml_path: Path) -> str | None:
    content = _content_digest(kml_path)
    if content is None:
        return None
    return (
        f"{content}_v{CACHE_FORMAT_VERSION}_{parser_fingerprint()}"
        f"_{database_fingerprint()}.json"
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


def _is_stale(entry: Path, now: float) -> bool:
    match = _ENTRY_NAME.match(entry.name)
    if match is None:
        if entry.suffix == ".json":
            # An older naming scheme, which no current key produces
            return True
        if entry.suffix != ".tmp":
            return False
        # A temp file an interrupted write left behind goes by its age
    elif (
        int(match["version"]) != CACHE_FORMAT_VERSION
        or match["parser"] != parser_fingerprint()
        or match["database"] != database_fingerprint()
    ):
        return True
    try:
        age_seconds = now - entry.stat().st_mtime
    except OSError:
        return False
    return age_seconds > CACHE_MAX_AGE_DAYS * 24 * 3600


def prune_stale_cache_entries(
    kml_files: Iterable[str] = (), cache_dir: Path | None = None
) -> int:
    """Remove the cache entries that are no longer useful in one directory pass.

    An entry goes when no current key can produce it (a legacy name, another
    format version, parser or airport database) or when it has not been used
    for ``CACHE_MAX_AGE_DAYS``, like a temp file an interrupted write left.
    Reading an entry renews it. Other files are left alone. Returns the
    number of removed entries.

    ``kml_files`` is not needed any more: content keys cannot be matched to
    input paths without hashing every input again.
    """
    del kml_files
    if cache_dir is None:
        cache_dir = KML_CACHE_DIR

    try:
        entries = list(cache_dir.iterdir())
    except OSError:
        return 0

    now = time.time()
    removed = 0
    for entry in entries:
        if not _is_stale(entry, now):
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
    they are after parsing. A loaded entry is touched, which keeps it from
    being pruned for its age.
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

    with contextlib.suppress(OSError):
        os.utime(cache_path)
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
