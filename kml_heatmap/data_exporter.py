"""Data export functionality for flight heatmaps.

Exports flight data to JS files for the browser frontend:
- <year>/data.js: per-year path info and segments (window.KML_DATA_<year>)
- airports.js: deduplicated airport locations (window.KML_AIRPORTS)
- metadata.js: statistics, years and the groundspeed range (KML_METADATA)

Years are processed in parallel; each worker writes its year's file and
returns a compact statistics aggregate instead of the segments themselves.
Path ids are globally unique: years are processed in ascending order and
each year's ids continue after the previous years' path count.
"""

import logging
import os
import re
from concurrent.futures import ProcessPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

from .cache import atomic_js_write
from .export_pipeline import build_path_info, process_path_segments
from .export_reconciler import YearAggregate
from .export_writers import export_airports_data, export_metadata
from .logger import logger
from .workers import init_worker

if TYPE_CHECKING:
    from .types import (
        AirportData,
        FlightPath,
        FlightPathGroup,
        PathInfo,
        PathMetadata,
        PathSegments,
        Statistics,
    )

YEAR_DIR_PATTERN = re.compile(r"^\d{4}$")
TOOL_OWNED_FILES = ("airports.js", "metadata.js")


@dataclass
class YearExportResult:
    """Result of exporting one year (picklable, no segment data)."""

    year: int
    path_count: int
    original_points: int
    file_bytes: int
    aggregate: YearAggregate


def process_year_data(
    year: int,
    year_path_groups: FlightPathGroup,
    year_path_metadata: list[PathMetadata],
    path_id_offset: int,
    output_dir: str,
    quiet: bool = False,
) -> YearExportResult:
    """Export a single year's data to <output_dir>/<year>/data.js."""
    if not quiet:
        logger.info("\n  Processing year %s (%d paths)...", year, len(year_path_groups))

    original_points = sum(len(path) for path in year_path_groups)
    aggregate = YearAggregate(total_points=original_points)
    segments: dict[str, PathSegments] = {}
    path_info: list[PathInfo] = []
    path_id = path_id_offset

    for path, metadata in zip(year_path_groups, year_path_metadata, strict=True):
        if not is_exportable_path(path):
            continue

        info, path_duration_seconds, path_distance_km = build_path_info(
            path, metadata, path_id, year
        )
        start, rows, distances = process_path_segments(
            path, path_distance_km, path_duration_seconds
        )
        # Zero-length segments are not exported, so report the exported count
        info["segment_count"] = len(rows)

        path_info.append(info)
        segments[str(path_id)] = {"start": start, "rows": rows}
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
        path_id += 1

    data: dict[str, Any] = {
        "year": year,
        "original_points": original_points,
        "path_info": path_info,
        "segments": segments,
    }

    year_dir = Path(output_dir) / str(year)
    year_dir.mkdir(parents=True, exist_ok=True)
    output_file = year_dir / "data.js"
    atomic_js_write(output_file, f"KML_DATA_{year}", data)

    file_bytes = output_file.stat().st_size

    if not quiet:
        logger.info(
            "    ✓ %d path(s), %s points (%.1f KB)",
            len(path_info),
            f"{original_points:,}",
            file_bytes / 1024,
        )

    return YearExportResult(
        year=year,
        path_count=len(path_info),
        original_points=original_points,
        file_bytes=file_bytes,
        aggregate=aggregate,
    )


def is_exportable_path(path: FlightPath) -> bool:
    """Whether a path gets an id and an entry in the export.

    The same predicate decides the per-year path ids (see
    ``_path_id_offsets``), so both must never drift apart: ids are persisted
    in shared links and would then point at different flights.
    """
    return len(path) > 1


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


def _path_id_offsets(
    paths_by_year: dict[int, list[int]], all_path_groups: FlightPathGroup
) -> dict[int, int]:
    """Assign each year the number of exported paths of all earlier years."""
    offsets: dict[int, int] = {}
    offset = 0
    for year in sorted(paths_by_year):
        offsets[year] = offset
        offset += sum(
            1 for idx in paths_by_year[year] if is_exportable_path(all_path_groups[idx])
        )
    return offsets


def _process_years_parallel(
    paths_by_year: dict[int, list[int]],
    all_path_groups: FlightPathGroup,
    all_path_metadata: list[PathMetadata],
    path_id_offsets: dict[int, int],
    output_dir: str,
) -> list[YearExportResult]:
    """Process all years in parallel and return results sorted by year."""
    year_results: list[YearExportResult] = []
    debug = logger.isEnabledFor(logging.DEBUG)

    if len(paths_by_year) == 1:
        year = next(iter(paths_by_year))
        indices = paths_by_year[year]
        try:
            result = process_year_data(
                year,
                [all_path_groups[i] for i in indices],
                [all_path_metadata[i] for i in indices],
                path_id_offsets[year],
                output_dir,
            )
        except Exception as exc:
            logger.exception("  Error processing year %s", year)
            raise RuntimeError(f"Failed to process year {year}") from exc
        logger.info(
            "  [1/1] Year %s: %s points",
            year,
            f"{result.original_points:,}",
        )
        return [result]

    with ProcessPoolExecutor(
        max_workers=max(1, min(len(paths_by_year), os.cpu_count() or 4)),
        initializer=init_worker,
        initargs=(debug,),
    ) as executor:
        futures = {}
        for year in sorted(paths_by_year):
            indices = paths_by_year[year]
            future = executor.submit(
                process_year_data,
                year,
                [all_path_groups[i] for i in indices],
                [all_path_metadata[i] for i in indices],
                path_id_offsets[year],
                output_dir,
                True,
            )
            futures[future] = year

        total_years = len(futures)
        for completed_count, future in enumerate(as_completed(futures), start=1):
            year = futures[future]
            try:
                result = future.result()
            except Exception as exc:
                logger.exception("  Error processing year %s", year)
                raise RuntimeError(f"Failed to process year {year}") from exc
            year_results.append(result)
            logger.info(
                "  [%d/%d] Year %s: %s points",
                completed_count,
                total_years,
                year,
                f"{result.original_points:,}",
            )

    year_results.sort(key=lambda result: result.year)
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
    stats: Statistics,
    output_dir: str = "data",
) -> dict[str, str]:
    """Orchestrate the full data export pipeline."""
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

    offsets = _path_id_offsets(paths_by_year, all_path_groups)

    logger.info("\n  Processing %d year(s) in parallel...", len(paths_by_year))
    year_results = _process_years_parallel(
        paths_by_year, all_path_groups, all_path_metadata, offsets, output_dir
    )

    aggregate = YearAggregate()
    year_file_bytes: dict[str, int] = {}
    for result in year_results:
        aggregate.merge(result.aggregate)
        year_file_bytes[str(result.year)] = result.file_bytes

    logger.info("\n  Reconciling statistics from segment data...")
    aggregate.apply_to_stats(stats)

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

    return files
