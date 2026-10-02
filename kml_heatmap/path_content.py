"""Which paths are exported, the exact copies among them and their ids.

A path is exported when it moves at the exported precision
(``is_exportable_path``). Its content is its coordinates, rounded the way
they are exported, and its altitudes (``exported_contents``): two paths of
the same content are the same recording under two file names, of which
``drop_duplicate_paths`` keeps the first, and a hash of it is the id the
path keeps from one export to the next (``assign_path_ids``). The ids end
up in shared links and in the saved state of the frontend.
"""

import hashlib
import math
import struct
from typing import TYPE_CHECKING

from .logger import logger
from .types import COORDINATE_DECIMALS

if TYPE_CHECKING:
    from collections.abc import Collection, Container, Mapping, Sequence

    from .types import FlightPath, FlightPathGroup, PathMetadata

__all__ = [
    "PATH_ID_BITS",
    "assign_path_ids",
    "drop_duplicate_paths",
    "exported_contents",
    "is_exportable_path",
    "path_content_id",
    "without_paths",
]

# Path ids are this wide: exact JavaScript numbers, short enough for a link,
# and wide enough that 100,000 flights rarely need a collision resolved
PATH_ID_BITS = 40


def is_exportable_path(path: FlightPath) -> bool:
    """Whether a path gets an id and an entry in the export.

    It has to move at the exported precision: points that all round to one
    coordinate make no segment row, and a flight without rows would still
    count in the frontend with its airports and aircraft.
    """
    if len(path) < 2:
        return False
    start = (
        round(path[0].lat, COORDINATE_DECIMALS),
        round(path[0].lon, COORDINATE_DECIMALS),
    )
    return any(
        (round(point.lat, COORDINATE_DECIMALS), round(point.lon, COORDINATE_DECIMALS))
        != start
        for point in path[1:]
    )


def _path_content(path: FlightPath) -> bytes:
    """The coordinates, rounded the way they are exported, and altitudes."""
    values: list[float] = []
    for point in path:
        values.append(round(point.lat, COORDINATE_DECIMALS))
        values.append(round(point.lon, COORDINATE_DECIMALS))
        values.append(math.nan if point.alt is None else round(point.alt, 1))
    return struct.pack(f"<{len(values)}d", *values)


def _content_id(content: bytes) -> int:
    digest = hashlib.blake2b(content, digest_size=8).digest()
    return int.from_bytes(digest, "big") >> (64 - PATH_ID_BITS)


def path_content_id(path: FlightPath) -> int:
    """The id a path gets unless an earlier path already holds it.

    A hash of the coordinates, rounded the way they are exported, and of the
    altitudes. It survives a re-export, flights added or removed around it
    and the renaming of Charterware files, none of which a position in the
    input or a file name would.
    """
    return _content_id(_path_content(path))


def exported_contents(
    paths_by_year: Mapping[int, list[int]],
    all_path_groups: FlightPathGroup,
    exportable: Sequence[bool],
) -> dict[int, bytes]:
    """The content of every exportable path (see ``_path_content``), by index.

    In input order. Packed once here for ``drop_duplicate_paths``, which
    compares it, and ``assign_path_ids``, which hashes it.
    """
    return {
        index: _path_content(all_path_groups[index])
        for index in sorted(
            index for indices in paths_by_year.values() for index in indices
        )
        if exportable[index]
    }


def drop_duplicate_paths(
    paths_by_year: Mapping[int, list[int]],
    contents: Mapping[int, bytes],
    all_path_metadata: Sequence[PathMetadata],
) -> dict[int, list[int]]:
    """Leave out every exported path that repeats an earlier one exactly.

    ``contents`` are those of the exported paths (see ``exported_contents``).
    The same recording under two file names (a copy, a renamed export)
    would otherwise count twice in every statistic. Paths are compared by
    their exported content itself, not by its hash, so two different
    flights that share a hash both stay. The first one in input order is
    kept and a warning names both files. A year left without an exported
    path is left out.
    """
    first_by_content: dict[bytes, int] = {}
    duplicates: set[int] = set()
    for index in sorted(contents):
        first = first_by_content.setdefault(contents[index], index)
        if first != index:
            duplicates.add(index)
            logger.warning(
                "Skipping a flight in %s: the same flight as in %s",
                all_path_metadata[index].get("filename") or f"path {index}",
                all_path_metadata[first].get("filename") or f"path {first}",
            )
    return without_paths(paths_by_year, duplicates, contents)


def without_paths(
    paths_by_year: Mapping[int, list[int]],
    dropped: Collection[int],
    exported: Container[int],
) -> dict[int, list[int]]:
    """The paths of every year less those ``dropped``.

    A year left without a path in ``exported`` is left out.
    """
    if not dropped:
        return dict(paths_by_year)
    kept = {
        year: [index for index in indices if index not in dropped]
        for year, indices in paths_by_year.items()
    }
    return {
        year: indices
        for year, indices in kept.items()
        if any(index in exported for index in indices)
    }


def assign_path_ids(
    paths_by_year: Mapping[int, list[int]], contents: Mapping[int, bytes]
) -> dict[int, int]:
    """The id of every exported path, keyed by its index in the input.

    ``contents`` are those of the exported paths (see ``exported_contents``).
    A path whose content id an earlier path (in input order) already holds,
    a real collision (``drop_duplicate_paths`` removes exact duplicates
    before), takes the next free id. The ids therefore only depend on the
    paths and their order, never on the chunking or the number of workers.
    """
    exported = sorted(
        index
        for indices in paths_by_year.values()
        for index in indices
        if index in contents
    )
    ids: dict[int, int] = {}
    taken: set[int] = set()
    for index in exported:
        path_id = _content_id(contents[index])
        while path_id in taken:
            path_id = (path_id + 1) % (1 << PATH_ID_BITS)
        taken.add(path_id)
        ids[index] = path_id
    return ids
