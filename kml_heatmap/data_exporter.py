"""Data export functionality for flight heatmaps.

Exports flight data to JSON files for the browser frontend:
- <year>/data.json: per-year path info and segments
- airports.json: deduplicated airport locations
- metadata.json: years, year file sizes, the groundspeed range and the aircraft
  models

The frontend computes every flight statistic from the year files, so the
export keeps no statistics of its own beyond the groundspeed range.

The work is split into chunks that run in parallel: a year with many paths is
cut into several chunks so that the export scales with the number of CPU
cores even when there are only one or two years. Each worker writes its share
of the year file as JSON fragments and returns its counts and groundspeed
range instead of the segments themselves; the main process concatenates the
fragments into the year file without parsing them.

Path ids are derived from the path content (see ``path_content_id``) in the
main process, before the work is chunked. They end up in shared links and in
the saved state of the frontend, so a re-export has to keep the id of every
flight that is still there, whatever was added or removed around it. Within a
year file the paths keep the input order.

``SiteOutput`` has every file written into staging directories and moves them
into place only once all of them were written, so a run that fails while
writing leaves the previous site as it was. One run at a time writes to an
output directory.
"""

import contextlib
import errno
import hashlib
import json
import logging
import math
import os
import re
import shutil
import struct
import tempfile
from concurrent.futures import (
    FIRST_COMPLETED,
    Executor,
    Future,
    ProcessPoolExecutor,
    wait,
)
from concurrent.futures.process import BrokenProcessPool
from dataclasses import dataclass, field
from pathlib import Path
from typing import IO, TYPE_CHECKING, Self

from .aircraft import resolve_aircraft_models
from .cache import atomic_write
from .exceptions import KMLHeatmapError
from .export_pipeline import build_path_info, path_duration, process_path_segments
from .export_writers import (
    export_airports_data,
    export_metadata,
    exported_airport_names,
    exported_country_codes,
)
from .logger import logger
from .segment_codec import FORMAT_VERSION, encode_ground, encode_rows, encode_start
from .site_assets import available_country_flags
from .terrain import ground_profile_ft, sample_path_elevations
from .types import COORDINATE_DECIMALS
from .validation import protected_directories
from .workers import init_worker

try:
    import fcntl
except ImportError:  # pragma: no cover - Windows has no fcntl
    # Without file locks two runs on one output directory are not detected;
    # the export itself works
    fcntl = None  # type: ignore[assignment]

if TYPE_CHECKING:
    from collections.abc import Iterable, Mapping, Sequence

    from .terrain import Coordinate, TileSource
    from .types import (
        AirportData,
        FlightPath,
        FlightPathGroup,
        PathMetadata,
        YearFileHeader,
    )

__all__ = [
    "MIN_PATHS_PER_CHUNK",
    "PATH_ID_BITS",
    "ChunkResult",
    "ExportResult",
    "GroundspeedRange",
    "SiteOutput",
    "YearExportResult",
    "assign_path_ids",
    "drop_duplicate_paths",
    "export_all_data",
    "exported_contents",
    "is_exportable_path",
    "path_content_id",
    "process_year_chunk",
]

YEAR_DIR_PATTERN = re.compile(r"^\d{4}$")
YEAR_FILE = "data.json"
TOOL_OWNED_FILES = ("airports.json", "metadata.json")
# Written by the versions whose page loaded its data with script tags, and
# removed when such a site is regenerated
LEGACY_DATA_FILES = ("airports.js", "metadata.js")
LEGACY_YEAR_FILE = "data.js"
# Fragments written by the chunk workers, assembled into the year file afterwards
PART_PATTERN = re.compile(r"^\.data\.\d+\.(info|segments)\.part$")
# Hidden directories a run writes its files into before publishing them
STAGING_PREFIX = ".kml-heatmap-staging-"
# Published last: they reference the other files, so a page loaded while the
# files are moved never points at one that is not in place yet
ENTRY_POINT_FILES = ("metadata.json", "index.html")
# A year is not split below this many paths per chunk: a worker process only
# pays off when it has real work to do
MIN_PATHS_PER_CHUNK = 50
# Chunks handed to the process pool ahead of time, per worker
MAX_QUEUED_CHUNKS_PER_WORKER = 2
JSON_SEPARATORS = (",", ":")
# Path ids are this wide: exact JavaScript numbers, short enough for a link,
# and wide enough that 100,000 flights rarely need a collision resolved
PATH_ID_BITS = 40
# Segment row layout: [lat, lon, altitude_ft, groundspeed_knots, time?]
SEGMENT_SPEED_INDEX = 3


@dataclass
class GroundspeedRange:
    """The lowest positive and the highest groundspeed of exported rows.

    Only the extremes are kept, and they merge to the same values in any
    order, so the range does not depend on how the years were chunked.
    """

    min_knots: float | None = None
    max_knots: float = 0.0

    def include(self, low: float, high: float) -> None:
        """Widen the range to cover ``low`` and ``high``."""
        self.min_knots = low if self.min_knots is None else min(self.min_knots, low)
        self.max_knots = max(self.max_knots, high)

    def merge(self, other: GroundspeedRange) -> None:
        """Widen the range to cover ``other``."""
        if other.min_knots is not None:
            self.include(other.min_knots, other.max_knots)


@dataclass
class ChunkResult:
    """Result of exporting one chunk of a year (picklable, no segment data)."""

    year: int
    index: int
    path_count: int
    original_points: int
    groundspeed: GroundspeedRange = field(default_factory=GroundspeedRange)


@dataclass
class YearExportResult:
    """Result of exporting one year (picklable, no segment data)."""

    year: int
    path_count: int
    original_points: int
    file_bytes: int
    groundspeed: GroundspeedRange = field(default_factory=GroundspeedRange)


@dataclass
class ExportResult:
    """Everything ``export_all_data`` produced."""

    years: list[int]
    #: ISO codes of the countries the exported airports are in, for the
    #: flags the site publishes
    countries: list[str] = field(default_factory=list)


@dataclass
class _ChunkPlan:
    year: int
    index: int
    path_indices: list[int]
    # One entry per path index: its id, or None when it is not exported
    path_ids: list[int | None]
    # One entry per path index: the ground under its points, see terrain
    elevations: list[Mapping[Coordinate, float] | None]


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
    if not duplicates:
        return dict(paths_by_year)
    kept = {
        year: [index for index in indices if index not in duplicates]
        for year, indices in paths_by_year.items()
    }
    return {
        year: indices
        for year, indices in kept.items()
        if any(index in contents for index in indices)
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


def _part_paths(output_dir: str, year: int, index: int) -> tuple[Path, Path]:
    year_dir = Path(output_dir) / str(year)
    return (
        year_dir / f".data.{index}.info.part",
        year_dir / f".data.{index}.segments.part",
    )


def process_year_chunk(
    year: int,
    year_path_groups: FlightPathGroup,
    year_path_metadata: list[PathMetadata],
    path_ids: Sequence[int | None],
    output_dir: str,
    index: int = 0,
    airport_names: frozenset[str] | None = None,
    path_elevations: Sequence[Mapping[Coordinate, float] | None] | None = None,
) -> ChunkResult:
    """Export a chunk of a year's paths into JSON fragments.

    ``path_ids`` holds the id of each path, None for the paths that are not
    exported (see ``assign_path_ids``). ``airport_names`` are the exported
    airport markers (see ``export_pipeline.build_path_info``).
    ``path_elevations`` holds the ground under the points of each path (see
    ``terrain.sample_path_elevations``), None for a path without; a path
    gets a ground column when they cover every row of it. Writes
    ``<output_dir>/<year>/.data.<index>.info.part`` (the path_info entries,
    comma separated) and ``.data.<index>.segments.part`` (the
    ``"<id>":{...}`` entries of the segments object, comma separated). The
    fragments are streamed path by path, so the chunk never holds all of its
    segment rows in memory at once.
    """
    original_points = sum(len(path) for path in year_path_groups)
    groundspeed = GroundspeedRange()
    info_part, segments_part = _part_paths(output_dir, year, index)
    info_part.parent.mkdir(parents=True, exist_ok=True)

    if path_elevations is None:
        path_elevations = [None] * len(path_ids)
    path_count = 0
    with (
        open(info_part, "w", encoding="utf-8") as info_out,
        open(segments_part, "w", encoding="utf-8") as segments_out,
    ):
        for path, metadata, path_id, elevations in zip(
            year_path_groups, year_path_metadata, path_ids, path_elevations, strict=True
        ):
            if path_id is None:
                continue

            start, rows = process_path_segments(path, path_duration(metadata))
            info = build_path_info(path, metadata, path_id, year, airport_names)

            # json.dumps rather than json.dump: only the one-shot encoder is
            # the C implementation, dumping to a file uses the Python one
            separator = "," if path_count else ""
            info_out.write(separator + json.dumps(info, separators=JSON_SEPARATORS))
            # Scaled to integers, stored as differences and written column
            # by column, see segment_codec
            segments: dict[str, object] = {
                "start": encode_start(start),
                "columns": encode_rows(start, rows),
            }
            ground = ground_profile_ft(start, rows, elevations) if elevations else None
            if ground is not None:
                segments["ground"] = encode_ground(ground)
            segments_out.write(
                f'{separator}"{path_id}":'
                + json.dumps(segments, separators=JSON_SEPARATORS)
            )

            speeds = [
                row[SEGMENT_SPEED_INDEX] for row in rows if row[SEGMENT_SPEED_INDEX] > 0
            ]
            if speeds:
                groundspeed.include(min(speeds), max(speeds))
            path_count += 1

    return ChunkResult(
        year=year,
        index=index,
        path_count=path_count,
        original_points=original_points,
        groundspeed=groundspeed,
    )


def _copy_fragments(out: IO[str], parts: list[Path]) -> None:
    """Concatenate non-empty fragment files, comma separated."""
    first = True
    for part in parts:
        if part.stat().st_size == 0:
            continue
        if not first:
            out.write(",")
        first = False
        with open(part, encoding="utf-8") as fragment:
            shutil.copyfileobj(fragment, out)


def _remove_parts(output_dir: str, year: int, indices: list[int]) -> None:
    for index in indices:
        for part in _part_paths(output_dir, year, index):
            part.unlink(missing_ok=True)


def _assemble_year_file(
    year: int, chunks: list[ChunkResult], output_dir: str
) -> YearExportResult:
    """Write <output_dir>/<year>/data.json from the chunk fragments."""
    chunks = sorted(chunks, key=lambda chunk: chunk.index)
    original_points = sum(chunk.original_points for chunk in chunks)
    output_file = Path(output_dir) / str(year) / YEAR_FILE

    header: YearFileHeader = {
        "format": FORMAT_VERSION,
        "year": year,
        "original_points": original_points,
    }
    # The object stays open for the paths that follow
    head = json.dumps(header, separators=JSON_SEPARATORS).removesuffix("}")

    def write(out: IO[str]) -> None:
        out.write(head + ',"path_info":[')
        _copy_fragments(
            out, [_part_paths(output_dir, year, chunk.index)[0] for chunk in chunks]
        )
        out.write('],"segments":{')
        _copy_fragments(
            out, [_part_paths(output_dir, year, chunk.index)[1] for chunk in chunks]
        )
        out.write("}}")

    try:
        atomic_write(output_file, write)
    finally:
        _remove_parts(output_dir, year, [chunk.index for chunk in chunks])

    groundspeed = GroundspeedRange()
    for chunk in chunks:
        groundspeed.merge(chunk.groundspeed)

    return YearExportResult(
        year=year,
        path_count=sum(chunk.path_count for chunk in chunks),
        original_points=original_points,
        file_bytes=output_file.stat().st_size,
        groundspeed=groundspeed,
    )


def _group_paths_by_year(
    all_path_metadata: list[PathMetadata], exportable: Sequence[bool]
) -> dict[int, list[int]]:
    """Group path indices by year; paths without a year are skipped.

    ``exportable`` tells for each path whether it is exported (see
    ``is_exportable_path``).

    A year without a single exportable path is left out, so that a file with
    nothing but point markers does not add an empty year. In the other years
    the markers stay in the groups, where they count for ``original_points``
    and for the chunk sizes as before.
    """
    paths_by_year: dict[int, list[int]] = {}
    for path_idx, metadata in enumerate(all_path_metadata):
        year = metadata.get("year")
        if year is None:
            # The pipeline drops these in renderer._drop_paths_without_year,
            # which also keeps them out of the airports.
            # This guard only covers direct calls to export_all_data.
            logger.debug(
                "Skipping path without year: %s", metadata.get("filename", path_idx)
            )
            continue
        paths_by_year.setdefault(year, []).append(path_idx)
    return {
        year: indices
        for year, indices in paths_by_year.items()
        if any(exportable[i] for i in indices)
    }


def _chunk_count(path_count: int, year_count: int, max_workers: int) -> int:
    """How many chunks a year is split into."""
    wanted = max(1, math.ceil(max_workers / max(1, year_count)))
    by_size = max(1, path_count // MIN_PATHS_PER_CHUNK)
    return max(1, min(wanted, by_size))


def _plan_chunks(
    paths_by_year: dict[int, list[int]],
    path_ids: Mapping[int, int],
    max_workers: int,
    elevations: Mapping[int, Mapping[Coordinate, float]] | None = None,
) -> list[_ChunkPlan]:
    """Cut the years into chunks, in input order, and hand each its path ids.

    ``path_ids`` are the ids of the exported paths by input index (see
    ``assign_path_ids``); the chunk boundaries do not change them.
    ``elevations`` are the ground under the points of the paths, by input
    index (see ``terrain.sample_path_elevations``).
    """
    elevations = elevations or {}
    plans: list[_ChunkPlan] = []
    for year in sorted(paths_by_year):
        indices = paths_by_year[year]
        chunks = _chunk_count(len(indices), len(paths_by_year), max_workers)
        size = max(1, math.ceil(len(indices) / chunks))
        for index, start in enumerate(range(0, max(1, len(indices)), size)):
            chunk_indices = indices[start : start + size]
            chunk_ids = [path_ids.get(i) for i in chunk_indices]
            chunk_elevations = [elevations.get(i) for i in chunk_indices]
            plans.append(
                _ChunkPlan(year, index, chunk_indices, chunk_ids, chunk_elevations)
            )
    return plans


def _run_chunk(
    plan: _ChunkPlan,
    all_path_groups: FlightPathGroup,
    all_path_metadata: list[PathMetadata],
    output_dir: str,
    airport_names: frozenset[str] | None,
) -> ChunkResult:
    return process_year_chunk(
        plan.year,
        [all_path_groups[i] for i in plan.path_indices],
        [all_path_metadata[i] for i in plan.path_indices],
        plan.path_ids,
        output_dir,
        plan.index,
        airport_names,
        plan.elevations,
    )


def _export_chunks(
    plans: list[_ChunkPlan],
    all_path_groups: FlightPathGroup,
    all_path_metadata: list[PathMetadata],
    output_dir: str,
    max_workers: int,
    airport_names: frozenset[str] | None = None,
) -> list[YearExportResult]:
    """Run the chunks (in a process pool when there are several) and assemble
    the year files. Returns the results sorted by year."""
    parts_per_year: dict[int, list[int]] = {}
    for plan in plans:
        parts_per_year.setdefault(plan.year, []).append(plan.index)

    def describe(plan: _ChunkPlan) -> str:
        parts = len(parts_per_year[plan.year])
        if parts == 1:
            return f"Year {plan.year}"
        return f"Year {plan.year} (part {plan.index + 1}/{parts})"

    def fail(
        plan: _ChunkPlan, exc: Exception, executor: Executor | None = None
    ) -> RuntimeError:
        if executor is not None:
            # Chunks that are still running (or already handed to a worker)
            # would write their fragments after the cleanup below
            executor.shutdown(wait=True, cancel_futures=True)
        for year, indices in parts_per_year.items():
            _remove_parts(output_dir, year, indices)
        if isinstance(exc, OSError | KMLHeatmapError | BrokenProcessPool):
            # Expected failures (a full disk, a worker killed for running out
            # of memory) are reported in one line
            logger.debug("Error processing year %s", plan.year, exc_info=exc)
        else:
            logger.exception("  Error processing year %s", plan.year)
        return RuntimeError(f"Failed to process year {plan.year}: {exc}")

    chunk_results: list[ChunkResult] = []
    if len(plans) == 1:
        plan = plans[0]
        try:
            result = _run_chunk(
                plan, all_path_groups, all_path_metadata, output_dir, airport_names
            )
        except Exception as exc:
            raise fail(plan, exc) from exc
        chunk_results.append(result)
        logger.info(
            "  [1/1] %s: %s points", describe(plan), f"{result.original_points:,}"
        )
    elif plans:
        debug = logger.isEnabledFor(logging.DEBUG)
        workers = max(1, min(len(plans), max_workers))
        with ProcessPoolExecutor(
            max_workers=workers,
            initializer=init_worker,
            initargs=(debug,),
        ) as executor:
            # Submitting every chunk at once would pickle the whole dataset
            # into the executor's queue while the main process still holds
            # it; a bounded number of chunks is in flight at any time
            pending: dict[Future[ChunkResult], _ChunkPlan] = {}
            queued = iter(plans)

            def submit_next() -> None:
                plan = next(queued, None)
                if plan is not None:
                    pending[
                        executor.submit(
                            process_year_chunk,
                            plan.year,
                            [all_path_groups[i] for i in plan.path_indices],
                            [all_path_metadata[i] for i in plan.path_indices],
                            plan.path_ids,
                            output_dir,
                            plan.index,
                            airport_names,
                            plan.elevations,
                        )
                    ] = plan

            for _ in range(workers * MAX_QUEUED_CHUNKS_PER_WORKER):
                submit_next()
            completed = 0
            while pending:
                done, _ = wait(pending, return_when=FIRST_COMPLETED)
                for future in done:
                    plan = pending.pop(future)
                    try:
                        result = future.result()
                    except Exception as exc:
                        raise fail(plan, exc, executor) from exc
                    chunk_results.append(result)
                    completed += 1
                    logger.info(
                        "  [%d/%d] %s: %s points",
                        completed,
                        len(plans),
                        describe(plan),
                        f"{result.original_points:,}",
                    )
                    submit_next()

    year_results = []
    for year in sorted(parts_per_year):
        chunks = [chunk for chunk in chunk_results if chunk.year == year]
        year_results.append(_assemble_year_file(year, chunks, output_dir))
    return year_results


def _refuse_symlink(path: Path) -> ValueError:
    return ValueError(
        f"Refusing to write through the symlink {path}; "
        "remove it or choose a different output directory"
    )


def _check_target(root: Path, relative: Path) -> None:
    """Refuse a destination that a staged file cannot safely be moved to.

    Symlinks are neither written through nor replaced, and nothing but a
    regular file (or a directory on the way to one) is replaced. The
    permission to create the file is checked as well, so that a read-only
    directory stops the run before the first file was moved.
    """
    directory = root
    for part in relative.parts[:-1]:
        child = directory / part
        if child.is_symlink():
            raise _refuse_symlink(child)
        if not child.exists():
            break
        if not child.is_dir():
            raise ValueError(f"Refusing to write into {child}: not a directory")
        directory = child
    else:
        target = root / relative
        if target.is_symlink():
            raise _refuse_symlink(target)
        if target.exists() and not target.is_file():
            raise ValueError(f"Refusing to replace {target}: not a regular file")
    if not os.access(directory, os.W_OK | os.X_OK):
        raise PermissionError(errno.EACCES, os.strerror(errno.EACCES), str(directory))


def _staged_files(stage: Path) -> list[Path]:
    """The files of a staging directory, relative to it, in publishing order.

    Files in subdirectories (the year files) come first and the entry points
    last, see ``ENTRY_POINT_FILES``.
    """
    files = [path.relative_to(stage) for path in stage.rglob("*") if path.is_file()]
    return sorted(
        files,
        key=lambda relative: (
            len(relative.parts) == 1,
            relative.name in ENTRY_POINT_FILES,
            relative.as_posix(),
        ),
    )


def _remove_stale_file(path: Path) -> None:
    """Remove a tool-owned file that the published run did not produce.

    The new site is already in place at this point, so a file that cannot be
    removed only gets a warning; a symlink is somebody else's and left alone.
    """
    if path.is_symlink():
        logger.warning("Leaving symlink in output directory: %s", path)
    elif path.is_file():
        try:
            path.unlink()
        except OSError as e:
            logger.warning("Could not remove stale output %s: %s", path, e)


def _remove_stale_data(data_dir: Path, years: set[str]) -> None:
    """Remove year files that are not part of the site any more.

    Anything the tool does not own is left in place with a warning.
    """
    for child in sorted(data_dir.iterdir()):
        if child.name in TOOL_OWNED_FILES or child.name.startswith(STAGING_PREFIX):
            continue
        if child.name in LEGACY_DATA_FILES:
            _remove_stale_file(child)
            continue
        # "unknown" is the year-less directory written by older versions
        if (
            child.is_dir()
            and not child.is_symlink()
            and (YEAR_DIR_PATTERN.match(child.name) or child.name == "unknown")
        ):
            stale = child.name not in years
            for item in sorted(child.iterdir()):
                # Fragments are left behind by interrupted older versions,
                # which wrote them into the output directory itself
                if (
                    (stale and item.name == YEAR_FILE)
                    or item.name == LEGACY_YEAR_FILE
                    or PART_PATTERN.match(item.name)
                ):
                    _remove_stale_file(item)
            if stale:
                try:
                    child.rmdir()
                except OSError:
                    logger.warning("Leaving non-empty year directory: %s", child)
            continue
        logger.warning("Leaving unexpected item in output directory: %s", child)


def _lock_directory(directory: Path) -> int:
    """Take the lock of an output directory, or fail when a run holds it.

    Two runs writing one site would delete each other's staging directories.
    The lock is on the directory itself, so no lock file ends up published
    with the site. It is released when the returned descriptor is closed.
    """
    fd = os.open(directory, os.O_RDONLY)
    if fcntl is None:
        return fd
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(fd)
        raise KMLHeatmapError(
            f"Another run is writing to {directory}; wait for it to finish"
        ) from None
    except OSError:
        # A file system without locks: run unguarded, as before
        pass
    return fd


def _remove_leftover_stages(directory: Path) -> None:
    """Remove the staging directories of runs that were killed.

    Only called with the directory's lock held, so no stage of a running
    run is among them.
    """
    for child in directory.iterdir():
        if (
            child.name.startswith(STAGING_PREFIX)
            and child.is_dir()
            and not child.is_symlink()
        ):
            shutil.rmtree(child, ignore_errors=True)


class SiteOutput:
    """Write a site into staging directories and publish it all at once.

    Every file is written into a hidden staging directory inside its
    destination, which keeps the final renames on one filesystem, and moved
    into place only once all files were written. A failed run leaves the
    previous site untouched instead of deleting it or mixing two versions.
    Files the tool does not own are never touched.

    Use it as a context manager: write the data files into ``data_stage`` and
    the page and its assets into ``site_stage``, then call ``publish``. The
    staging directories are removed on exit, published or not.
    """

    site_stage: Path
    data_stage: Path

    def __init__(
        self,
        output_dir: str | Path,
        data_dir: str | Path,
        site_files: Iterable[str] = (),
        site_patterns: Iterable[str] = (),
    ) -> None:
        """Prepare the output of a site.

        ``site_files`` are the paths the tool owns in ``output_dir``, each
        relative to it and with forward slashes; the ones a run does not
        produce are removed when it is published. ``site_patterns`` are glob
        patterns of owned files whose names are not known in advance, such
        as the flag of each country visited: every match that a run does
        not produce is removed as well, or a flight removed from the input
        would still give away its country.
        """
        self.output_dir = Path(output_dir).resolve()
        self.data_dir = Path(data_dir).resolve()
        for given, resolved in (
            (output_dir, self.output_dir),
            (data_dir, self.data_dir),
        ):
            if resolved in protected_directories():
                raise ValueError(f"Refusing to use dangerous output directory: {given}")
        self.site_files = tuple(site_files)
        self.site_patterns = tuple(site_patterns)
        self._cleanup = contextlib.ExitStack()

    def __enter__(self) -> Self:
        try:
            for destination in dict.fromkeys((self.output_dir, self.data_dir)):
                destination.mkdir(parents=True, exist_ok=True)
                self._cleanup.callback(os.close, _lock_directory(destination))
                _remove_leftover_stages(destination)
            self.site_stage = self._stage(self.output_dir)
            self.data_stage = self._stage(self.data_dir)
        except BaseException:
            self._cleanup.close()
            raise
        return self

    def __exit__(self, *exc_info: object) -> None:
        self._cleanup.close()

    def _stage(self, destination: Path) -> Path:
        stage = Path(tempfile.mkdtemp(prefix=STAGING_PREFIX, dir=destination))
        self._cleanup.callback(shutil.rmtree, stage, ignore_errors=True)
        return stage

    def publish(self, years: Iterable[int]) -> None:
        """Move the staged files into place, then remove stale outputs.

        Every destination is checked before the first file moves, so that a
        refusal leaves the previous site as it was. The data files move
        first and the page last. ``years`` are the years of the new site.
        """
        for stage, required in (
            (self.site_stage, "index.html"),
            (self.data_stage, "metadata.json"),
        ):
            # A stage that lost its page or metadata is a bug or a stage
            # removed from under the run; publishing it would break the site
            if not (stage / required).is_file():
                raise KMLHeatmapError(f"Staged site is incomplete: {required} missing")
        site_files = _staged_files(self.site_stage)
        moves = [
            (self.data_stage, self.data_dir, relative)
            for relative in _staged_files(self.data_stage)
        ] + [(self.site_stage, self.output_dir, relative) for relative in site_files]

        for _, destination, relative in moves:
            _check_target(destination, relative)
        for stage, destination, relative in moves:
            target = destination / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            os.replace(stage / relative, target)

        # Compared as relative paths, not base names: the vendored files sit
        # in a subdirectory, and two of them could share a name
        produced = {relative.as_posix() for relative in site_files}
        for name in self.site_files:
            if name not in produced:
                _remove_stale_file(self.output_dir / name)
        for pattern in self.site_patterns:
            self._remove_stale_matches(pattern, produced)
        _remove_stale_data(self.data_dir, {str(year) for year in years})

    def _remove_stale_matches(self, pattern: str, produced: set[str]) -> None:
        """Remove the files matching ``pattern`` that were not produced.

        A directory on the way that is a symlink is somebody else's and not
        searched; one that ends up empty is removed.
        """
        directory = self.output_dir
        for part in Path(pattern).parent.parts:
            directory = directory / part
            if directory.is_symlink() or not directory.is_dir():
                return
        for match in sorted(directory.glob(Path(pattern).name)):
            if match.relative_to(self.output_dir).as_posix() not in produced:
                _remove_stale_file(match)
        if directory != self.output_dir:
            with contextlib.suppress(OSError):
                directory.rmdir()


def export_all_data(
    all_path_groups: FlightPathGroup,
    all_path_metadata: list[PathMetadata],
    unique_airports: list[AirportData],
    output_dir: str | Path = "data",
    aircraft_data: Mapping[str, str] | None = None,
    exportable: Sequence[bool] | None = None,
    terrain: TileSource | None = None,
) -> ExportResult:
    """Write the data files into ``output_dir``.

    ``output_dir`` is expected to hold no previous export: the pipeline
    passes the data staging directory of a ``SiteOutput``, which publishes
    the files. ``exportable`` is ``is_exportable_path`` of every path, when
    the caller has it already. ``terrain`` is where the ground under the
    flights comes from (see ``kml_heatmap.terrain``); without it the year
    files carry no ground and the page takes it from the airfields.
    """
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)

    logger.info("\n  Exporting data to JSON files...")

    if exportable is None:
        exportable = [is_exportable_path(path) for path in all_path_groups]
    paths_by_year = _group_paths_by_year(all_path_metadata, exportable)
    contents = exported_contents(paths_by_year, all_path_groups, exportable)
    paths_by_year = drop_duplicate_paths(paths_by_year, contents, all_path_metadata)
    logger.info("\n  Splitting data by year: %s", sorted(paths_by_year))

    path_ids = assign_path_ids(paths_by_year, contents)
    # Once for all paths, in this process: every tile is fetched and decoded
    # once, and a chunk only gets the elevations of its own paths
    elevations = (
        sample_path_elevations(
            {index: all_path_groups[index] for index in path_ids}, terrain
        )
        if terrain is not None and path_ids
        else None
    )
    max_workers = os.process_cpu_count() or 4
    plans = _plan_chunks(paths_by_year, path_ids, max_workers, elevations)

    logger.info(
        "\n  Processing %d year(s) in %d chunk(s)...", len(paths_by_year), len(plans)
    )
    year_results = _export_chunks(
        plans,
        all_path_groups,
        all_path_metadata,
        str(output_path),
        max_workers,
        exported_airport_names(unique_airports),
    )

    groundspeed = GroundspeedRange()
    year_file_bytes: dict[str, int] = {}
    for result in year_results:
        groundspeed.merge(result.groundspeed)
        year_file_bytes[str(result.year)] = result.file_bytes

    # Only the aircraft of exported paths: the frontend never shows another
    aircraft_models = resolve_aircraft_models(
        (all_path_metadata[index].get("aircraft_registration") for index in path_ids),
        aircraft_data,
    )

    years = [result.year for result in year_results]
    _, airports_bytes = export_airports_data(unique_airports, str(output_path))
    countries = exported_country_codes(unique_airports)
    _, metadata_bytes = export_metadata(
        groundspeed.min_knots or 0.0,
        groundspeed.max_knots,
        years,
        year_file_bytes,
        aircraft_models,
        str(output_path),
        available_country_flags(countries),
    )

    total_size = airports_bytes + metadata_bytes + sum(year_file_bytes.values())
    logger.info("  Total data size: %.1f KB", total_size / 1024)

    return ExportResult(years=years, countries=countries)
