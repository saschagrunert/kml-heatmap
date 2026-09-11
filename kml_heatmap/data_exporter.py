"""Data export functionality for flight heatmaps.

Exports flight data to JS files for the browser frontend:
- <year>/data.js: per-year path info and segments (window.KML_DATA_<year>)
- airports.js: deduplicated airport locations (window.KML_AIRPORTS)
- metadata.js: statistics, years and the groundspeed range (KML_METADATA)

The work is split into chunks that run in parallel: a year with many paths is
cut into several chunks so that the export scales with the number of CPU
cores even when there are only one or two years. Each worker writes its share
of the year file as JSON fragments and returns a compact statistics aggregate
instead of the segments themselves; the main process concatenates the
fragments into the year file without parsing them.

Path ids are globally unique and deterministic: years are processed in
ascending order, each year's ids continue after the previous years' path
count, and within a year the ids follow the input order.
"""

import json
import logging
import math
import os
import re
import shutil
from concurrent.futures import ProcessPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from typing import IO, TYPE_CHECKING

from .cache import atomic_write
from .export_pipeline import build_path_info, path_metrics, process_path_segments
from .export_reconciler import YearAggregate
from .export_writers import (
    export_airports_data,
    export_metadata,
    exported_airport_names,
)
from .logger import logger
from .statistics import build_statistics
from .workers import init_worker

if TYPE_CHECKING:
    from collections.abc import Mapping

    from .types import (
        AirportData,
        FlightPath,
        FlightPathGroup,
        PathMetadata,
        Statistics,
    )

__all__ = [
    "MIN_PATHS_PER_CHUNK",
    "ChunkResult",
    "ExportResult",
    "YearExportResult",
    "export_all_data",
    "is_exportable_path",
    "process_year_chunk",
    "process_year_data",
]

YEAR_DIR_PATTERN = re.compile(r"^\d{4}$")
TOOL_OWNED_FILES = ("airports.js", "metadata.js")
# Fragments written by the chunk workers, assembled into data.js afterwards
PART_PATTERN = re.compile(r"^\.data\.\d+\.(info|segments)\.part$")
# A year is not split below this many paths per chunk: a worker process only
# pays off when it has real work to do
MIN_PATHS_PER_CHUNK = 50
JSON_SEPARATORS = (",", ":")


@dataclass
class ChunkResult:
    """Result of exporting one chunk of a year (picklable, no segment data)."""

    year: int
    index: int
    path_count: int
    original_points: int
    aggregate: YearAggregate


@dataclass
class YearExportResult:
    """Result of exporting one year (picklable, no segment data)."""

    year: int
    path_count: int
    original_points: int
    file_bytes: int
    aggregate: YearAggregate


@dataclass
class ExportResult:
    """Everything ``export_all_data`` produced."""

    files: dict[str, str]
    stats: Statistics


@dataclass
class _ChunkPlan:
    year: int
    index: int
    path_indices: list[int]
    path_id_offset: int


def is_exportable_path(path: FlightPath) -> bool:
    """Whether a path gets an id and an entry in the export.

    The same predicate decides the path id offsets (see ``_plan_chunks``), so
    both must never drift apart: ids are persisted in shared links and would
    then point at different flights.
    """
    return len(path) > 1


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
    path_id_offset: int,
    output_dir: str,
    index: int = 0,
) -> ChunkResult:
    """Export a chunk of a year's paths into JSON fragments.

    Writes ``<output_dir>/<year>/.data.<index>.info.part`` (the path_info
    entries, comma separated) and ``.data.<index>.segments.part`` (the
    ``"<id>":{...}`` entries of the segments object, comma separated). The
    fragments are streamed path by path, so the chunk never holds all of its
    segment rows in memory at once.
    """
    original_points = sum(len(path) for path in year_path_groups)
    aggregate = YearAggregate(total_points=original_points)
    info_part, segments_part = _part_paths(output_dir, year, index)
    info_part.parent.mkdir(parents=True, exist_ok=True)

    path_count = 0
    path_id = path_id_offset
    with (
        open(info_part, "w", encoding="utf-8") as info_out,
        open(segments_part, "w", encoding="utf-8") as segments_out,
    ):
        for path, metadata in zip(year_path_groups, year_path_metadata, strict=True):
            if not is_exportable_path(path):
                continue

            path_duration_seconds, path_distance_km = path_metrics(path, metadata)
            start, rows, distances = process_path_segments(
                path, path_distance_km, path_duration_seconds
            )
            info = build_path_info(path, metadata, path_id, year, len(rows))

            separator = "," if path_count else ""
            info_out.write(separator)
            json.dump(info, info_out, separators=JSON_SEPARATORS)
            segments_out.write(f'{separator}"{path_id}":')
            json.dump(
                {"start": start, "rows": rows}, segments_out, separators=JSON_SEPARATORS
            )

            path_min_ft = info.get("min_altitude_ft")
            path_max_ft = info.get("max_altitude_ft")
            aggregate.add_path(
                rows,
                distances,
                metadata.get("aircraft_registration"),
                (path_min_ft, path_max_ft)
                if path_min_ft is not None and path_max_ft is not None
                else None,
            )
            path_count += 1
            path_id += 1

    return ChunkResult(
        year=year,
        index=index,
        path_count=path_count,
        original_points=original_points,
        aggregate=aggregate,
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
    """Write <output_dir>/<year>/data.js from the chunk fragments."""
    chunks = sorted(chunks, key=lambda chunk: chunk.index)
    original_points = sum(chunk.original_points for chunk in chunks)
    output_file = Path(output_dir) / str(year) / "data.js"

    def write(out: IO[str]) -> None:
        out.write(
            f'window.KML_DATA_{year} = {{"year":{year},'
            f'"original_points":{original_points},"path_info":['
        )
        _copy_fragments(
            out, [_part_paths(output_dir, year, chunk.index)[0] for chunk in chunks]
        )
        out.write('],"segments":{')
        _copy_fragments(
            out, [_part_paths(output_dir, year, chunk.index)[1] for chunk in chunks]
        )
        out.write("}};")

    try:
        atomic_write(output_file, write)
    finally:
        _remove_parts(output_dir, year, [chunk.index for chunk in chunks])

    aggregate = YearAggregate()
    for chunk in chunks:
        aggregate.merge(chunk.aggregate)

    return YearExportResult(
        year=year,
        path_count=sum(chunk.path_count for chunk in chunks),
        original_points=original_points,
        file_bytes=output_file.stat().st_size,
        aggregate=aggregate,
    )


def process_year_data(
    year: int,
    year_path_groups: FlightPathGroup,
    year_path_metadata: list[PathMetadata],
    path_id_offset: int,
    output_dir: str,
    quiet: bool = False,
) -> YearExportResult:
    """Export a single year's data to <output_dir>/<year>/data.js in one go."""
    if not quiet:
        logger.info("\n  Processing year %s (%d paths)...", year, len(year_path_groups))

    chunk = process_year_chunk(
        year, year_path_groups, year_path_metadata, path_id_offset, output_dir
    )
    result = _assemble_year_file(year, [chunk], output_dir)

    if not quiet:
        logger.info(
            "    ✓ %d path(s), %s points (%.1f KB)",
            result.path_count,
            f"{result.original_points:,}",
            result.file_bytes / 1024,
        )

    return result


def _group_paths_by_year(
    all_path_metadata: list[PathMetadata],
) -> dict[int, list[int]]:
    """Group path indices by year; paths without a year are skipped."""
    paths_by_year: dict[int, list[int]] = {}
    for path_idx, metadata in enumerate(all_path_metadata):
        year = metadata.get("year")
        if year is None:
            # The pipeline drops these in renderer._drop_paths_without_year,
            # which also keeps them out of the airports and the statistics.
            # This guard only covers direct calls to export_all_data.
            logger.debug(
                "Skipping path without year: %s", metadata.get("filename", path_idx)
            )
            continue
        paths_by_year.setdefault(year, []).append(path_idx)
    return paths_by_year


def _chunk_count(path_count: int, year_count: int, max_workers: int) -> int:
    """How many chunks a year is split into."""
    wanted = max(1, math.ceil(max_workers / max(1, year_count)))
    by_size = max(1, path_count // MIN_PATHS_PER_CHUNK)
    return max(1, min(wanted, by_size))


def _plan_chunks(
    paths_by_year: dict[int, list[int]],
    all_path_groups: FlightPathGroup,
    max_workers: int,
) -> list[_ChunkPlan]:
    """Cut the years into chunks and assign every chunk its first path id.

    Ids only depend on the order of the paths, never on the chunking: chunk
    boundaries fall between paths and each chunk starts where the previous
    one (in year and input order) ended.
    """
    plans: list[_ChunkPlan] = []
    offset = 0
    for year in sorted(paths_by_year):
        indices = paths_by_year[year]
        chunks = _chunk_count(len(indices), len(paths_by_year), max_workers)
        size = max(1, math.ceil(len(indices) / chunks))
        for index, start in enumerate(range(0, max(1, len(indices)), size)):
            chunk_indices = indices[start : start + size]
            plans.append(_ChunkPlan(year, index, chunk_indices, offset))
            offset += sum(
                1 for i in chunk_indices if is_exportable_path(all_path_groups[i])
            )
    return plans


def _run_chunk(
    plan: _ChunkPlan,
    all_path_groups: FlightPathGroup,
    all_path_metadata: list[PathMetadata],
    output_dir: str,
) -> ChunkResult:
    return process_year_chunk(
        plan.year,
        [all_path_groups[i] for i in plan.path_indices],
        [all_path_metadata[i] for i in plan.path_indices],
        plan.path_id_offset,
        output_dir,
        plan.index,
    )


def _export_chunks(
    plans: list[_ChunkPlan],
    all_path_groups: FlightPathGroup,
    all_path_metadata: list[PathMetadata],
    output_dir: str,
    max_workers: int,
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

    def fail(plan: _ChunkPlan, exc: BaseException) -> RuntimeError:
        for year, indices in parts_per_year.items():
            _remove_parts(output_dir, year, indices)
        logger.exception("  Error processing year %s", plan.year)
        return RuntimeError(f"Failed to process year {plan.year}")

    chunk_results: list[ChunkResult] = []
    if len(plans) == 1:
        plan = plans[0]
        try:
            result = _run_chunk(plan, all_path_groups, all_path_metadata, output_dir)
        except Exception as exc:
            raise fail(plan, exc) from exc
        chunk_results.append(result)
        logger.info(
            "  [1/1] %s: %s points", describe(plan), f"{result.original_points:,}"
        )
    elif plans:
        debug = logger.isEnabledFor(logging.DEBUG)
        with ProcessPoolExecutor(
            max_workers=max(1, min(len(plans), max_workers)),
            initializer=init_worker,
            initargs=(debug,),
        ) as executor:
            futures = {
                executor.submit(
                    process_year_chunk,
                    plan.year,
                    [all_path_groups[i] for i in plan.path_indices],
                    [all_path_metadata[i] for i in plan.path_indices],
                    plan.path_id_offset,
                    output_dir,
                    plan.index,
                ): plan
                for plan in plans
            }
            for completed, future in enumerate(as_completed(futures), start=1):
                plan = futures[future]
                try:
                    result = future.result()
                except Exception as exc:
                    raise fail(plan, exc) from exc
                chunk_results.append(result)
                logger.info(
                    "  [%d/%d] %s: %s points",
                    completed,
                    len(futures),
                    describe(plan),
                    f"{result.original_points:,}",
                )

    year_results = []
    for year in sorted(parts_per_year):
        chunks = [chunk for chunk in chunk_results if chunk.year == year]
        year_results.append(_assemble_year_file(year, chunks, output_dir))
    return year_results


def _protected_directories() -> tuple[Path, ...]:
    """Directories that must never be used as the data output directory."""
    try:
        return (Path("/"), Path.home())
    except RuntimeError:  # no HOME and no passwd entry (containers)
        return (Path("/"),)


def _clean_output_dir(output_path: Path) -> None:
    """Remove tool-owned outputs only; anything else is left with a warning."""
    if not output_path.is_dir():
        return

    for name in TOOL_OWNED_FILES:
        target = output_path / name
        if target.is_symlink():
            raise ValueError(
                f"Refusing to write through the symlink {target}; "
                "remove it or choose a different output directory"
            )
        if target.is_file():
            target.unlink()

    for child in sorted(output_path.iterdir()):
        # "unknown" is the year-less directory written by older versions
        if (
            child.is_dir()
            and not child.is_symlink()
            and (YEAR_DIR_PATTERN.match(child.name) or child.name == "unknown")
        ):
            data_file = child / "data.js"
            if data_file.is_symlink():
                raise ValueError(
                    f"Refusing to write through the symlink {data_file}; "
                    "remove it or choose a different output directory"
                )
            if data_file.is_file():
                data_file.unlink()
            # Fragments left behind by an interrupted run
            for stale in child.iterdir():
                if stale.is_file() and PART_PATTERN.match(stale.name):
                    stale.unlink()
            try:
                child.rmdir()
            except OSError:
                logger.warning("Leaving non-empty year directory: %s", child)
            continue
        logger.warning("Leaving unexpected item in output directory: %s", child)


def export_all_data(
    all_path_groups: FlightPathGroup,
    all_path_metadata: list[PathMetadata],
    unique_airports: list[AirportData],
    output_dir: str = "data",
    aircraft_data: Mapping[str, str] | None = None,
) -> ExportResult:
    """Orchestrate the full data export pipeline and build the statistics."""
    output_path = Path(output_dir).resolve()
    if output_path in _protected_directories():
        raise ValueError(f"Refusing to use dangerous output directory: {output_dir}")

    if output_path.exists():
        logger.info("\n  Cleaning tool-owned files in: %s", output_dir)
        _clean_output_dir(output_path)

    output_path.mkdir(parents=True, exist_ok=True)

    logger.info("\n  Exporting data to JS files...")

    paths_by_year = _group_paths_by_year(all_path_metadata)
    logger.info("\n  Splitting data by year: %s", sorted(paths_by_year))

    max_workers = os.cpu_count() or 4
    plans = _plan_chunks(paths_by_year, all_path_groups, max_workers)

    logger.info(
        "\n  Processing %d year(s) in %d chunk(s)...", len(paths_by_year), len(plans)
    )
    year_results = _export_chunks(
        plans, all_path_groups, all_path_metadata, output_dir, max_workers
    )

    aggregate = YearAggregate()
    year_file_bytes: dict[str, int] = {}
    for result in year_results:
        aggregate.merge(result.aggregate)
        year_file_bytes[str(result.year)] = result.file_bytes

    logger.info("\n  Reconciling statistics from segment data...")
    stats = build_statistics(
        aggregate,
        all_path_metadata,
        exported_airport_names(unique_airports),
        aircraft_data,
    )

    files: dict[str, str] = {}

    airports_file, _ = export_airports_data(unique_airports, output_dir)
    files["airports"] = airports_file

    meta_file, _ = export_metadata(
        stats,
        aggregate.min_groundspeed_or_zero,
        aggregate.max_groundspeed_knots,
        [result.year for result in year_results],
        year_file_bytes,
        output_dir,
    )
    files["metadata"] = meta_file

    total_size = sum(Path(f).stat().st_size for f in files.values()) + sum(
        year_file_bytes.values()
    )
    logger.info("  Total data size: %.1f KB", total_size / 1024)

    return ExportResult(files=files, stats=stats)
