"""Data export functionality for full resolution flight heatmaps.

This module handles the export of flight data to JSON files for web browsers.
All data is exported at full resolution without downsampling.

File Structure:
- {year}/data.js: Full resolution path and segment data per year
- airports.js: Deduplicated airport locations
- metadata.js: Statistics and configuration

Performance Optimizations:
- JSON files use compact separators (no whitespace)
- Sorted keys for better compression
- Coordinates rounded to appropriate precision
- Privacy mode strips timestamps when requested
- Year-based file splitting for efficient loading

This approach ensures:
- Maximum data fidelity (no information loss)
- Simplified architecture (no zoom-based switching)
- Per-year filtering capabilities
"""

import os
import json
import shutil
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import List, Dict, Any

from .logger import logger
from .constants import DATA_RESOLUTION
from .export_writers import export_airports_data, export_metadata, collect_unique_years
from .export_reconciler import _recalculate_stats_from_segments
from .export_pipeline import _build_path_info, _process_path_segments


def process_year_data(
    year: str,
    year_path_indices: List[int],
    all_coordinates: List[List[float]],
    all_path_groups: List[List[List[Any]]],
    all_path_metadata: List[Dict[str, Any]],
    min_alt_m: float,
    max_alt_m: float,
    output_dir: str,
    resolutions: Dict[str, Dict[str, Any]],
    resolution_order: List[str],
    quiet: bool = False,
) -> Dict[str, Any]:
    """
    Process a single year's data and export to files.

    Args:
        year: Year string or "unknown"
        year_path_indices: List of path indices for this year
        all_coordinates: Full coordinate list
        all_path_groups: Full path groups list
        all_path_metadata: Full metadata list
        min_alt_m: Minimum altitude
        max_alt_m: Maximum altitude
        output_dir: Output directory
        resolutions: Resolution configuration
        resolution_order: Order to process resolutions
        quiet: If True, suppress verbose logging (for parallel execution)

    Returns:
        Dictionary with year statistics and data
    """
    if not quiet:
        logger.info(f"\n  Processing year {year} ({len(year_path_indices)} paths)...")

    # Initialize statistics for this year
    year_max_groundspeed = 0.0
    year_min_groundspeed = float("inf")
    year_cruise_distance = 0.0
    year_cruise_time = 0.0
    year_max_path_distance = 0.0
    year_cruise_altitude_histogram: Dict[int, float] = {}
    year_file_structure: List[str] = []
    year_full_res_segments = None
    year_full_res_path_info = None

    # Calculate total points for this year
    year_total_points = sum(
        len(all_path_groups[path_idx]) for path_idx in year_path_indices
    )
    if not quiet:
        logger.info(f"    Total points for {year}: {year_total_points:,}")

    # Process single full resolution export (no downsampling)
    for res_name in resolution_order:
        res_config = resolutions[res_name]

        # Use full resolution paths without any downsampling
        full_paths = []
        for path_idx in year_path_indices:
            path = all_path_groups[path_idx]
            full_paths.append(path)

        # Extract 2D coordinates from year's paths only
        full_coords = []
        for path in full_paths:
            for point in path:
                full_coords.append([point[0], point[1]])

        # Prepare path segments with colors and track relationships
        path_segments: List[Dict[str, Any]] = []
        path_info: List[Dict[str, Any]] = []

        # Iterate using original path indices to access metadata correctly
        for local_idx, (orig_path_idx, path) in enumerate(
            zip(year_path_indices, full_paths)
        ):
            if len(path) <= 1:
                continue

            metadata = (
                all_path_metadata[orig_path_idx]
                if orig_path_idx < len(all_path_metadata)
                else {}
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

        # Export data (no downsampling or filtering)
        data = {
            "coordinates": full_coords,
            "path_segments": path_segments,
            "path_info": path_info,
            "resolution": res_name,
            "original_points": len(full_coords),
        }

        # Create year directory if it doesn't exist
        year_dir = os.path.join(output_dir, year)
        os.makedirs(year_dir, exist_ok=True)

        # Export to year directory with simple filename
        output_file = os.path.join(year_dir, f"{res_name}.js")
        with open(output_file, "w") as f:
            var_name = f"KML_DATA_{year}_{res_name.upper().replace('-', '_')}"
            f.write(f"window.{var_name} = ")
            json.dump(data, f, separators=(",", ":"), sort_keys=True)
            f.write(";")

        file_size = os.path.getsize(output_file)
        year_file_structure.append(res_name)

        # Store data for return
        year_full_res_segments = path_segments
        year_full_res_path_info = path_info

        if not quiet:
            logger.info(
                f"    ✓ {res_config['description']}: {len(full_coords):,} points ({file_size / 1024:.1f} KB)"
            )

    return {
        "year": year,
        "max_groundspeed": year_max_groundspeed,
        "min_groundspeed": year_min_groundspeed,
        "cruise_distance": year_cruise_distance,
        "cruise_time": year_cruise_time,
        "max_path_distance": year_max_path_distance,
        "cruise_altitude_histogram": year_cruise_altitude_histogram,
        "file_structure": year_file_structure,
        "full_res_segments": year_full_res_segments,
        "full_res_path_info": year_full_res_path_info,
    }


def export_all_data(
    all_coordinates: List[List[float]],
    all_path_groups: List[List[List[float]]],
    all_path_metadata: List[Dict[str, Any]],
    unique_airports: List[Dict[str, Any]],
    stats: Dict[str, Any],
    output_dir: str = "data",
    strip_timestamps: bool = False,
) -> Dict[str, str]:
    """
    Orchestrate the full data export pipeline.

    Cleans the output directory, groups paths by year, processes each year
    in parallel, exports airports and metadata, and aggregates statistics.

    Args:
        all_coordinates: List of [lat, lon] pairs
        all_path_groups: List of path groups with altitude data
        all_path_metadata: List of metadata dicts for each path
        unique_airports: List of airport dicts
        stats: Statistics dictionary (modified in place with aggregated data)
        output_dir: Directory to save data files
        strip_timestamps: If True, remove timestamps for privacy

    Returns:
        Dict mapping file types to output paths (e.g., {"airports": "...", "metadata": "..."}).
    """
    # Clean up existing output directory
    if os.path.exists(output_dir):
        logger.info(f"\n  Cleaning up output directory: {output_dir}")
        shutil.rmtree(output_dir)

    os.makedirs(output_dir, exist_ok=True)

    logger.info("\n  Exporting data to JS files...")
    if strip_timestamps:
        logger.info("  Privacy mode: Stripping all date/time information")

    # Calculate min/max altitude for color mapping
    if all_path_groups:
        all_altitudes = [coord[2] for path in all_path_groups for coord in path]
        min_alt_m = min(all_altitudes)
        max_alt_m = max(all_altitudes)
    else:
        min_alt_m = 0
        max_alt_m = 1000

    # Single full resolution
    resolutions = {
        DATA_RESOLUTION: {"factor": 1, "epsilon": 0, "description": "Full resolution"}
    }
    resolution_order = [DATA_RESOLUTION]

    # Group paths by year
    paths_by_year: Dict[str, List[int]] = {}
    for path_idx, metadata in enumerate(all_path_metadata):
        year = metadata.get("year")
        if year is None:
            year = "unknown"
        else:
            year = str(year)
        if year not in paths_by_year:
            paths_by_year[year] = []
        paths_by_year[year].append(path_idx)

    logger.info(f"\n  Splitting data by year: {sorted(paths_by_year.keys())}")

    # Aggregate tracking
    files: Dict[str, str] = {}
    file_structure: Dict[str, Any] = {}
    max_groundspeed_knots = 0.0
    min_groundspeed_knots = float("inf")
    cruise_speed_total_distance = 0.0
    cruise_speed_total_time = 0.0
    max_path_distance_nm = 0.0
    cruise_altitude_histogram: Dict[int, float] = {}
    all_full_res_segments: List[Dict[str, Any]] = []
    all_full_res_path_info: List[Dict[str, Any]] = []

    # Process years in parallel
    logger.info(f"\n  Processing {len(paths_by_year)} year(s) in parallel...")

    year_results = []
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
                resolutions,
                resolution_order,
                True,  # quiet=True for parallel execution
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
            except Exception as e:
                logger.error(f"  Error processing year {year}: {e}")

    # Aggregate results from all years
    for result in year_results:
        year = result["year"]
        file_structure[year] = result["file_structure"]

        if result["max_groundspeed"] > max_groundspeed_knots:
            max_groundspeed_knots = result["max_groundspeed"]
        if result["min_groundspeed"] < min_groundspeed_knots:
            min_groundspeed_knots = result["min_groundspeed"]

        cruise_speed_total_distance += result["cruise_distance"]
        cruise_speed_total_time += result["cruise_time"]

        if result["max_path_distance"] > max_path_distance_nm:
            max_path_distance_nm = result["max_path_distance"]

        for altitude_bin, time_spent in result["cruise_altitude_histogram"].items():
            if altitude_bin not in cruise_altitude_histogram:
                cruise_altitude_histogram[altitude_bin] = 0
            cruise_altitude_histogram[altitude_bin] += time_spent

        # Collect full resolution data from all years with remapped path_ids
        year_segments = result["full_res_segments"]
        year_path_info = result["full_res_path_info"]
        if year_segments and year_path_info:
            path_id_offset = len(all_full_res_path_info)
            for seg in year_segments:
                remapped = dict(seg)
                remapped["path_id"] = seg["path_id"] + path_id_offset
                all_full_res_segments.append(remapped)
            for pi in year_path_info:
                remapped = dict(pi)
                remapped["id"] = pi["id"] + path_id_offset
                all_full_res_path_info.append(remapped)

    # Export airports
    airports_file, _ = export_airports_data(
        unique_airports, output_dir, strip_timestamps
    )
    files["airports"] = airports_file

    # Collect unique years
    available_years = collect_unique_years(all_path_metadata)

    # Update stats with aggregated data
    stats["max_groundspeed_knots"] = round(max_groundspeed_knots, 1)

    if min_groundspeed_knots == float("inf"):
        min_groundspeed_knots = 0.0

    if cruise_speed_total_time > 0:
        cruise_speed_knots = (
            cruise_speed_total_distance / cruise_speed_total_time
        ) * 3600
        stats["cruise_speed_knots"] = round(cruise_speed_knots, 1)
    else:
        stats["cruise_speed_knots"] = 0

    if cruise_altitude_histogram:
        most_common_altitude_ft = max(
            cruise_altitude_histogram.items(), key=lambda x: x[1]
        )[0]
        stats["most_common_cruise_altitude_ft"] = most_common_altitude_ft
        stats["most_common_cruise_altitude_m"] = round(
            most_common_altitude_ft * 0.3048, 1
        )
    else:
        stats["most_common_cruise_altitude_ft"] = 0
        stats["most_common_cruise_altitude_m"] = 0

    stats["longest_flight_nm"] = round(max_path_distance_nm, 1)
    stats["longest_flight_km"] = round(max_path_distance_nm * 1.852, 1)

    # Recalculate stats from segment data for frontend consistency
    if all_full_res_segments and all_full_res_path_info:
        logger.info("\n  Reconciling statistics from segment data...")
        _recalculate_stats_from_segments(
            stats, all_full_res_segments, all_full_res_path_info
        )

    # Export metadata (final, consistent values)
    meta_file, _ = export_metadata(
        stats,
        min_alt_m,
        max_alt_m,
        min_groundspeed_knots,
        max_groundspeed_knots,
        available_years,
        output_dir,
        file_structure,
    )
    files["metadata"] = meta_file

    total_size = sum(os.path.getsize(f) for f in files.values())
    logger.info(f"  Total data size: {total_size / 1024:.1f} KB")

    return files
