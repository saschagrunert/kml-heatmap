"""Data export functionality for full resolution flight heatmaps.

Exports flight data to JS files for the browser frontend:
- {year}/data.js: full resolution path and segment data per year
- airports.js: deduplicated airport locations
- metadata.js: statistics and configuration

Years are processed in parallel. JSON uses compact separators and sorted keys
for better compression. Privacy mode strips timestamps when requested.
"""

import json
import os
import shutil
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, cast

from .constants import (
    DATA_RESOLUTION,
    FEET_TO_METERS,
    NAUTICAL_MILES_TO_KM,
    SECONDS_PER_HOUR,
)
from .export_pipeline import _build_path_info, _process_path_segments
from .export_reconciler import _recalculate_stats_from_segments
from .export_writers import export_airports_data, export_metadata, collect_unique_years
from .geometry import extract_altitudes
from .logger import logger
from .types import (
    AirportData,
    PathMetadata,
    PathSegment,
    PathInfo,
    Statistics,
)


def process_year_data(
    year: str,
    year_path_indices: list[int],
    all_coordinates: list[list[float]],
    all_path_groups: list[list[list[Any]]],
    all_path_metadata: list[PathMetadata],
    min_alt_m: float,
    max_alt_m: float,
    output_dir: str,
    quiet: bool = False,
) -> dict[str, Any]:
    """Process a single year's data and export to files."""
    if not quiet:
        logger.info(f"\n  Processing year {year} ({len(year_path_indices)} paths)...")

    year_max_groundspeed = 0.0
    year_min_groundspeed = float("inf")
    year_cruise_distance = 0.0
    year_cruise_time = 0.0
    year_max_path_distance = 0.0
    year_cruise_altitude_histogram: dict[int, float] = {}

    year_total_points = sum(
        len(all_path_groups[path_idx]) for path_idx in year_path_indices
    )
    if not quiet:
        logger.info(f"    Total points for {year}: {year_total_points:,}")

    full_paths = []
    for path_idx in year_path_indices:
        path = all_path_groups[path_idx]
        full_paths.append(path)

    full_coords = []
    for path in full_paths:
        for point in path:
            full_coords.append([point[0], point[1]])

    path_segments: list[PathSegment] = []
    path_info: list[PathInfo] = []

    for local_idx, (orig_path_idx, path) in enumerate(
        zip(year_path_indices, full_paths)
    ):
        if len(path) <= 1:
            continue

        metadata = (
            all_path_metadata[orig_path_idx]
            if orig_path_idx < len(all_path_metadata)
            else PathMetadata(start_point=[], airport_name="")
        )
        path_year = (
            all_path_metadata[orig_path_idx].get("year")
            if orig_path_idx < len(all_path_metadata)
            else None
        )

        info, path_duration_seconds, path_distance_km, path_distance_nm = (
            _build_path_info(path, metadata, local_idx, path_year)
        )
        path_info.append(info)

        if path_distance_nm > year_max_path_distance:
            year_max_path_distance = path_distance_nm

        (
            segments,
            seg_max_gs,
            seg_min_gs,
            seg_cruise_dist,
            seg_cruise_time,
            seg_cruise_hist,
        ) = _process_path_segments(
            path, local_idx, path_distance_km, path_duration_seconds
        )
        path_segments.extend(segments)

        if seg_max_gs > year_max_groundspeed:
            year_max_groundspeed = seg_max_gs
        if seg_min_gs < year_min_groundspeed:
            year_min_groundspeed = seg_min_gs
        year_cruise_distance += seg_cruise_dist
        year_cruise_time += seg_cruise_time
        for alt_bin, time_spent in seg_cruise_hist.items():
            if alt_bin not in year_cruise_altitude_histogram:
                year_cruise_altitude_histogram[alt_bin] = 0.0
            year_cruise_altitude_histogram[alt_bin] += time_spent

    data: dict[str, Any] = {
        "coordinates": full_coords,
        "path_segments": path_segments,
        "path_info": path_info,
        "resolution": DATA_RESOLUTION,
        "original_points": len(full_coords),
    }

    year_dir = Path(output_dir) / year
    year_dir.mkdir(parents=True, exist_ok=True)

    output_file = str(year_dir / f"{DATA_RESOLUTION}.js")
    with open(output_file, "w") as f:
        var_name = f"KML_DATA_{year}_{DATA_RESOLUTION.upper().replace('-', '_')}"
        f.write(f"window.{var_name} = ")
        json.dump(data, f, separators=(",", ":"), sort_keys=True)
        f.write(";")

    file_size = Path(output_file).stat().st_size

    if not quiet:
        logger.info(
            f"    ✓ Full resolution: {len(full_coords):,} points ({file_size / 1024:.1f} KB)"
        )

    return {
        "year": year,
        "max_groundspeed": year_max_groundspeed,
        "min_groundspeed": year_min_groundspeed,
        "cruise_distance": year_cruise_distance,
        "cruise_time": year_cruise_time,
        "max_path_distance": year_max_path_distance,
        "cruise_altitude_histogram": year_cruise_altitude_histogram,
        "file_structure": [DATA_RESOLUTION],
        "full_res_segments": path_segments,
        "full_res_path_info": path_info,
    }


def _calculate_altitude_range(
    all_path_groups: list[list[list[float]]],
) -> tuple[float, float]:
    """Calculate min/max altitude across all path groups."""
    if all_path_groups:
        all_altitudes = extract_altitudes(all_path_groups)
        if all_altitudes:
            return min(all_altitudes), max(all_altitudes)
    return 0.0, 1000.0


def _group_paths_by_year(
    all_path_metadata: list[PathMetadata],
) -> dict[str, list[int]]:
    """Group path indices by year from metadata."""
    paths_by_year: dict[str, list[int]] = {}
    for path_idx, metadata in enumerate(all_path_metadata):
        year = metadata.get("year")
        if year is None:
            year_str = "unknown"
        else:
            year_str = str(year)
        if year_str not in paths_by_year:
            paths_by_year[year_str] = []
        paths_by_year[year_str].append(path_idx)
    return paths_by_year


def _process_years_parallel(
    paths_by_year: dict[str, list[int]],
    all_coordinates: list[list[float]],
    all_path_groups: list[list[list[float]]],
    all_path_metadata: list[PathMetadata],
    min_alt_m: float,
    max_alt_m: float,
    output_dir: str,
) -> list[dict[str, Any]]:
    """Process all years in parallel and return results."""
    year_results: list[dict[str, Any]] = []

    with ThreadPoolExecutor(
        max_workers=min(len(paths_by_year), os.cpu_count() or 4)
    ) as executor:
        futures = {}
        for year in sorted(paths_by_year.keys()):
            year_path_indices = paths_by_year[year]
            future = executor.submit(
                process_year_data,
                year,
                year_path_indices,
                all_coordinates,
                all_path_groups,
                all_path_metadata,
                min_alt_m,
                max_alt_m,
                output_dir,
                True,
            )
            futures[future] = year

        completed_count = 0
        total_years = len(futures)
        for future in as_completed(futures):
            year = futures[future]
            try:
                result = future.result()
                year_results.append(result)
                completed_count += 1

                year_points = sum(
                    len(all_path_groups[idx]) for idx in paths_by_year[year]
                )
                logger.info(
                    f"  [{completed_count}/{total_years}] Year {year}: {year_points:,} points"
                )
            except Exception:
                logger.exception(f"  Error processing year {year}")

    return year_results


@dataclass
class AggregatedYearResults:
    """Aggregated statistics from all year results."""

    file_structure: dict[str, Any] = field(default_factory=dict)
    max_groundspeed_knots: float = 0.0
    min_groundspeed_knots: float = field(default_factory=lambda: float("inf"))
    cruise_speed_total_distance: float = 0.0
    cruise_speed_total_time: float = 0.0
    max_path_distance_nm: float = 0.0
    cruise_altitude_histogram: dict[int, float] = field(default_factory=dict)
    all_full_res_segments: list[PathSegment] = field(default_factory=list)
    all_full_res_path_info: list[PathInfo] = field(default_factory=list)


def _aggregate_year_results(
    year_results: list[dict[str, Any]],
) -> AggregatedYearResults:
    """Aggregate statistics from all year results."""
    agg = AggregatedYearResults()

    for result in year_results:
        year = result["year"]
        agg.file_structure[year] = result["file_structure"]

        if result["max_groundspeed"] > agg.max_groundspeed_knots:
            agg.max_groundspeed_knots = result["max_groundspeed"]
        if result["min_groundspeed"] < agg.min_groundspeed_knots:
            agg.min_groundspeed_knots = result["min_groundspeed"]

        agg.cruise_speed_total_distance += result["cruise_distance"]
        agg.cruise_speed_total_time += result["cruise_time"]

        if result["max_path_distance"] > agg.max_path_distance_nm:
            agg.max_path_distance_nm = result["max_path_distance"]

        for altitude_bin, time_spent in result["cruise_altitude_histogram"].items():
            if altitude_bin not in agg.cruise_altitude_histogram:
                agg.cruise_altitude_histogram[altitude_bin] = 0
            agg.cruise_altitude_histogram[altitude_bin] += time_spent

        year_segments = result["full_res_segments"]
        year_path_info = result["full_res_path_info"]
        if year_segments and year_path_info:
            path_id_offset = len(agg.all_full_res_path_info)
            for seg in year_segments:
                remapped_seg = cast(PathSegment, dict(seg))
                remapped_seg["path_id"] = seg["path_id"] + path_id_offset
                agg.all_full_res_segments.append(remapped_seg)
            for pi in year_path_info:
                remapped_pi = cast(PathInfo, dict(pi))
                remapped_pi["id"] = pi["id"] + path_id_offset
                agg.all_full_res_path_info.append(remapped_pi)

    return agg


def _finalize_stats(
    stats: Statistics,
    max_groundspeed_knots: float,
    min_groundspeed_knots: float,
    cruise_speed_total_distance: float,
    cruise_speed_total_time: float,
    max_path_distance_nm: float,
    cruise_altitude_histogram: dict[int, float],
) -> None:
    """Update stats dict with aggregated cruise/groundspeed/altitude data."""
    stats["max_groundspeed_knots"] = round(max_groundspeed_knots, 1)

    if cruise_speed_total_time > 0:
        cruise_speed_knots = (
            cruise_speed_total_distance / cruise_speed_total_time
        ) * SECONDS_PER_HOUR
        stats["cruise_speed_knots"] = round(cruise_speed_knots, 1)
    else:
        stats["cruise_speed_knots"] = 0

    if cruise_altitude_histogram:
        most_common_altitude_ft = max(
            cruise_altitude_histogram.items(), key=lambda x: x[1]
        )[0]
        stats["most_common_cruise_altitude_ft"] = most_common_altitude_ft
        stats["most_common_cruise_altitude_m"] = round(
            most_common_altitude_ft * FEET_TO_METERS, 1
        )
    else:
        stats["most_common_cruise_altitude_ft"] = 0
        stats["most_common_cruise_altitude_m"] = 0

    stats["longest_flight_nm"] = round(max_path_distance_nm, 1)
    stats["longest_flight_km"] = round(max_path_distance_nm * NAUTICAL_MILES_TO_KM, 1)


def export_all_data(
    all_coordinates: list[list[float]],
    all_path_groups: list[list[list[float]]],
    all_path_metadata: list[PathMetadata],
    unique_airports: list[AirportData],
    stats: Statistics,
    output_dir: str = "data",
    strip_timestamps: bool = False,
) -> dict[str, str]:
    """Orchestrate the full data export pipeline."""
    if Path(output_dir).exists():
        logger.info(f"\n  Cleaning up output directory: {output_dir}")
        shutil.rmtree(output_dir)

    Path(output_dir).mkdir(parents=True, exist_ok=True)

    logger.info("\n  Exporting data to JS files...")
    if strip_timestamps:
        logger.info("  Privacy mode: Stripping all date/time information")

    min_alt_m, max_alt_m = _calculate_altitude_range(all_path_groups)

    paths_by_year = _group_paths_by_year(all_path_metadata)
    logger.info(f"\n  Splitting data by year: {sorted(paths_by_year.keys())}")

    logger.info(f"\n  Processing {len(paths_by_year)} year(s) in parallel...")
    year_results = _process_years_parallel(
        paths_by_year,
        all_coordinates,
        all_path_groups,
        all_path_metadata,
        min_alt_m,
        max_alt_m,
        output_dir,
    )

    agg = _aggregate_year_results(year_results)

    if agg.min_groundspeed_knots == float("inf"):
        agg.min_groundspeed_knots = 0.0

    _finalize_stats(
        stats,
        agg.max_groundspeed_knots,
        agg.min_groundspeed_knots,
        agg.cruise_speed_total_distance,
        agg.cruise_speed_total_time,
        agg.max_path_distance_nm,
        agg.cruise_altitude_histogram,
    )

    if agg.all_full_res_segments and agg.all_full_res_path_info:
        logger.info("\n  Reconciling statistics from segment data...")
        _recalculate_stats_from_segments(
            stats, agg.all_full_res_segments, agg.all_full_res_path_info
        )

    files: dict[str, str] = {}

    airports_file, _ = export_airports_data(
        unique_airports, output_dir, strip_timestamps
    )
    files["airports"] = airports_file

    available_years = collect_unique_years(all_path_metadata)

    meta_file, _ = export_metadata(
        stats,
        min_alt_m,
        max_alt_m,
        agg.min_groundspeed_knots,
        agg.max_groundspeed_knots,
        available_years,
        output_dir,
        agg.file_structure,
    )
    files["metadata"] = meta_file

    total_size = sum(Path(f).stat().st_size for f in files.values())
    logger.info(f"  Total data size: {total_size / 1024:.1f} KB")

    return files
