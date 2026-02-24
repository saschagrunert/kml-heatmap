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
from bisect import bisect_left, bisect_right
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import List, Dict, Any, Optional, Tuple

from .airports import extract_airport_name
from .logger import logger
from .constants import (
    DATA_RESOLUTION,
    HEATMAP_GRADIENT,
    KM_TO_NAUTICAL_MILES,
    METERS_TO_FEET,
    SPEED_WINDOW_SECONDS,
    CRUISE_ALTITUDE_THRESHOLD_FT,
)
from .geometry import haversine_distance
from .helpers import parse_iso_timestamp, calculate_duration_seconds, format_flight_time
from .segment_calculator import (
    extract_segment_speeds,
    build_time_indexed_segments,
    calculate_windowed_groundspeed,
    calculate_fallback_groundspeed,
    calculate_path_distance,
    update_cruise_statistics,
)


def export_airports_data(
    unique_airports: List[Dict[str, Any]],
    output_dir: str,
    strip_timestamps: bool = False,
) -> Tuple[str, int]:
    """
    Export airport data to JSON file.

    Args:
        unique_airports: List of airport dictionaries
        output_dir: Output directory
        strip_timestamps: Whether to strip timestamps for privacy

    Returns:
        Tuple of (output_file_path, file_size_bytes)
    """
    valid_airports = []
    seen_locations = set()

    for apt in unique_airports:
        full_name = apt.get("name", "Unknown")
        is_at_path_end = apt.get("is_at_path_end", False)
        airport_name = extract_airport_name(full_name, is_at_path_end)

        if not airport_name:
            continue

        location_key = f"{apt['lat']:.4f},{apt['lon']:.4f}"

        if location_key in seen_locations:
            continue

        seen_locations.add(location_key)

        airport_data = {
            "lat": apt["lat"],
            "lon": apt["lon"],
            "name": airport_name,
            "flight_count": len(apt["timestamps"]) if apt["timestamps"] else 1,
        }

        if not strip_timestamps:
            airport_data["timestamps"] = apt["timestamps"]

        valid_airports.append(airport_data)

    airports_data = {"airports": valid_airports}
    airports_file = os.path.join(output_dir, "airports.js")

    with open(airports_file, "w") as f:
        f.write("window.KML_AIRPORTS = ")
        json.dump(airports_data, f, separators=(",", ":"), sort_keys=True)
        f.write(";")

    file_size = os.path.getsize(airports_file)

    logger.info(
        f"  ✓ Airports: {len(valid_airports)} locations ({file_size / 1024:.1f} KB)"
    )

    return airports_file, file_size


def export_metadata(
    stats: Dict[str, Any],
    min_alt_m: float,
    max_alt_m: float,
    min_groundspeed_knots: float,
    max_groundspeed_knots: float,
    available_years: List[int],
    output_dir: str,
    file_structure: Optional[Dict[str, Any]] = None,
) -> Tuple[str, int]:
    """
    Export metadata including statistics and ranges.

    Args:
        stats: Statistics dictionary
        min_alt_m: Minimum altitude in meters
        max_alt_m: Maximum altitude in meters
        min_groundspeed_knots: Minimum groundspeed
        max_groundspeed_knots: Maximum groundspeed
        available_years: List of available years
        output_dir: Output directory
        file_structure: File structure mapping (year -> resolution list)

    Returns:
        Tuple of (output_file_path, file_size_bytes)
    """
    # Handle infinity case
    if min_groundspeed_knots == float("inf"):
        min_groundspeed_knots = 0.0

    meta_data = {
        "stats": stats,
        "min_alt_m": min_alt_m,
        "max_alt_m": max_alt_m,
        "min_groundspeed_knots": round(min_groundspeed_knots, 1),
        "max_groundspeed_knots": round(max_groundspeed_knots, 1),
        "gradient": HEATMAP_GRADIENT,
        "available_years": available_years,
    }

    if file_structure is not None:
        meta_data["file_structure"] = file_structure

    meta_file = os.path.join(output_dir, "metadata.js")

    with open(meta_file, "w") as f:
        f.write("window.KML_METADATA = ")
        json.dump(meta_data, f, separators=(",", ":"), sort_keys=True)
        f.write(";")

    file_size = os.path.getsize(meta_file)

    logger.info(f"  ✓ Metadata: {file_size / 1024:.1f} KB")

    return meta_file, file_size


def collect_unique_years(all_path_metadata: List[Dict[str, Any]]) -> List[int]:
    """
    Collect unique years from path metadata.

    Args:
        all_path_metadata: List of path metadata dictionaries

    Returns:
        Sorted list of unique years
    """
    unique_years = set()

    for meta in all_path_metadata:
        year = meta.get("year")
        if year:
            unique_years.add(year)

    return sorted(list(unique_years))


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
        path_segments = []
        path_info = []

        # Iterate using original path indices to access metadata correctly
        for local_idx, (orig_path_idx, path) in enumerate(
            zip(year_path_indices, full_paths)
        ):
            if len(path) <= 1:
                continue

            # Get original path metadata if available
            metadata = (
                all_path_metadata[orig_path_idx]
                if orig_path_idx < len(all_path_metadata)
                else {}
            )

            # Extract airport information from metadata
            airport_name = metadata.get("airport_name", "")
            start_airport = None
            end_airport = None

            if airport_name and " - " in airport_name:
                parts = airport_name.split(" - ")
                if len(parts) == 2:
                    start_airport = parts[0].strip()
                    end_airport = parts[1].strip()

            # Get year from metadata
            path_year = (
                all_path_metadata[orig_path_idx].get("year")
                if orig_path_idx < len(all_path_metadata)
                else None
            )

            # Calculate path duration and distance
            path_duration_seconds = 0.0
            path_distance_km = 0.0

            start_ts = metadata.get("timestamp")
            end_ts = metadata.get("end_timestamp")

            if start_ts and end_ts:
                path_duration_seconds = calculate_duration_seconds(start_ts, end_ts)
                if path_duration_seconds == 0:
                    logger.debug(
                        f"  Could not parse timestamps '{start_ts}' -> '{end_ts}'"
                    )

            # Calculate total path distance
            path_distance_km = calculate_path_distance(path)

            # Track longest single flight distance
            path_distance_nm = path_distance_km * KM_TO_NAUTICAL_MILES
            if path_distance_nm > year_max_path_distance:
                year_max_path_distance = path_distance_nm

            # Store path info with airport relationships and aircraft info
            info = {
                "id": local_idx,
                "start_airport": start_airport,
                "end_airport": end_airport,
                "start_coords": [path[0][0], path[0][1]],
                "end_coords": [path[-1][0], path[-1][1]],
                "segment_count": len(path) - 1,
                "year": path_year,
            }
            if "aircraft_registration" in metadata:
                info["aircraft_registration"] = metadata["aircraft_registration"]
            if "aircraft_type" in metadata:
                info["aircraft_type"] = metadata["aircraft_type"]
            path_info.append(info)

            # Calculate ground level for this path
            ground_level_m = min([coord[2] for coord in path]) if path else 0

            # Find path start time for relative time calculation
            path_start_time = None
            for coord in path:
                if len(coord) >= 4:
                    path_start_time = parse_iso_timestamp(coord[3])
                    if path_start_time:
                        break

            # First pass: calculate instantaneous speeds and timestamps
            segment_speeds = extract_segment_speeds(path, path_start_time)

            # Build time-sorted list for efficient window queries
            timestamp_list, time_indexed_segments = build_time_indexed_segments(
                segment_speeds
            )

            # Second pass: calculate rolling average speeds using time window
            for i in range(len(path) - 1):
                coord1 = path[i]
                coord2 = path[i + 1]
                lat1, lon1, alt1_m = coord1[0], coord1[1], coord1[2]
                lat2, lon2, alt2_m = coord2[0], coord2[1], coord2[2]

                avg_alt_m = (alt1_m + alt2_m) / 2
                avg_alt_ft = round(avg_alt_m * METERS_TO_FEET / 100) * 100

                # Calculate windowed average groundspeed
                groundspeed_knots = 0.0
                current_segment = segment_speeds[i]
                current_timestamp = current_segment["timestamp"]
                current_relative_time = current_segment["relative_time"]

                if current_timestamp is not None and timestamp_list:
                    groundspeed_knots = calculate_windowed_groundspeed(
                        current_timestamp, timestamp_list, time_indexed_segments
                    )

                # Fall back to path average if no timestamp-based calculation
                if groundspeed_knots == 0:
                    segment_distance_km = haversine_distance(lat1, lon1, lat2, lon2)
                    groundspeed_knots = calculate_fallback_groundspeed(
                        segment_distance_km, path_distance_km, path_duration_seconds
                    )

                # Track maximum and minimum groundspeed
                if groundspeed_knots > 0:
                    if groundspeed_knots > year_max_groundspeed:
                        year_max_groundspeed = groundspeed_knots
                    if groundspeed_knots < year_min_groundspeed:
                        year_min_groundspeed = groundspeed_knots

                    # Track cruise speed (only segments >1000ft AGL)
                    altitude_agl_m = avg_alt_m - ground_level_m
                    altitude_agl_ft = altitude_agl_m * METERS_TO_FEET
                    if altitude_agl_ft > CRUISE_ALTITUDE_THRESHOLD_FT:
                        # Compute window distance/time for cruise stats
                        if current_timestamp is not None and timestamp_list:
                            current_ts = current_timestamp.timestamp()
                            half_window = SPEED_WINDOW_SECONDS / 2
                            w_start = bisect_left(
                                timestamp_list, current_ts - half_window
                            )
                            w_end = bisect_right(
                                timestamp_list, current_ts + half_window
                            )
                            w_distance = sum(
                                time_indexed_segments[j]["distance"]
                                for j in range(w_start, w_end)
                            )
                            w_time = sum(
                                time_indexed_segments[j]["time_delta"]
                                for j in range(w_start, w_end)
                            )
                        else:
                            w_distance = 0.0
                            w_time = 0.0

                        cruise_stats: Dict[str, Any] = {
                            "total_distance": 0.0,
                            "total_time": 0.0,
                            "altitude_histogram": {},
                        }
                        update_cruise_statistics(
                            altitude_agl_ft, w_time, w_distance, cruise_stats
                        )
                        year_cruise_distance += float(cruise_stats["total_distance"])
                        year_cruise_time += float(cruise_stats["total_time"])
                        hist: Dict[int, float] = cruise_stats["altitude_histogram"]
                        for alt_bin, time_spent in hist.items():
                            if alt_bin not in year_cruise_altitude_histogram:
                                year_cruise_altitude_histogram[alt_bin] = 0.0
                            year_cruise_altitude_histogram[alt_bin] += time_spent

                # Skip zero-length segments
                if lat1 != lat2 or lon1 != lon2:
                    segment_data = {
                        "coords": [[lat1, lon1], [lat2, lon2]],
                        "altitude_ft": avg_alt_ft,
                        "altitude_m": round(avg_alt_m, 0),
                        "groundspeed_knots": round(groundspeed_knots, 1),
                        "path_id": local_idx,
                    }
                    if current_relative_time is not None:
                        segment_data["time"] = round(current_relative_time, 1)
                    path_segments.append(segment_data)

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


def _recalculate_stats_from_segments(
    stats: Dict[str, Any],
    segments: List[Dict[str, Any]],
    path_info_list: List[Dict[str, Any]],
) -> None:
    """Recalculate statistics from exported segment data for frontend consistency.

    This ensures the statistics panel and filtered stats show consistent values
    with the frontend JavaScript calculations. Stats dict is modified in place.

    Args:
        stats: Statistics dictionary (modified in place)
        segments: Full resolution path segments
        path_info_list: Full resolution path info entries
    """
    stats["total_points"] = len(segments) * 2

    if not segments:
        return

    altitudes_m = [seg.get("altitude_m", 0) for seg in segments]
    min_alt_m = min(altitudes_m)
    max_alt_m = max(altitudes_m)
    stats["min_altitude_m"] = min_alt_m
    stats["max_altitude_m"] = max_alt_m
    stats["min_altitude_ft"] = min_alt_m * METERS_TO_FEET
    stats["max_altitude_ft"] = max_alt_m * METERS_TO_FEET

    cruise_threshold = min_alt_m * METERS_TO_FEET + 1000

    total_gain_m = 0.0
    prev_alt = None
    groundspeed_sum = 0.0
    groundspeed_count = 0
    cruise_speed_sum = 0.0
    cruise_speed_count = 0
    altitude_bins: Dict[int, int] = {}
    path_durations: Dict[int, List[float]] = {}

    for seg in segments:
        alt_m = seg.get("altitude_m", 0)
        alt_ft = seg.get("altitude_ft", 0)
        gs = seg.get("groundspeed_knots", 0)

        if prev_alt is not None and alt_m > prev_alt:
            total_gain_m += alt_m - prev_alt
        prev_alt = alt_m

        if gs > 0:
            groundspeed_sum += gs
            groundspeed_count += 1

        if alt_ft > cruise_threshold:
            if gs > 0:
                cruise_speed_sum += gs
                cruise_speed_count += 1
            if "time" in seg:
                bin_alt = round(alt_ft / 100) * 100
                altitude_bins[bin_alt] = altitude_bins.get(bin_alt, 0) + 1

        if "time" in seg and "path_id" in seg:
            path_id = seg["path_id"]
            if path_id not in path_durations:
                path_durations[path_id] = []
            path_durations[path_id].append(seg["time"])

    stats["total_altitude_gain_m"] = total_gain_m
    stats["total_altitude_gain_ft"] = total_gain_m * METERS_TO_FEET
    stats["average_groundspeed_knots"] = (
        groundspeed_sum / groundspeed_count if groundspeed_count > 0 else 0
    )
    stats["cruise_speed_knots"] = (
        cruise_speed_sum / cruise_speed_count if cruise_speed_count > 0 else 0
    )

    if altitude_bins:
        stats["most_common_cruise_altitude_ft"] = max(
            altitude_bins.keys(), key=lambda k: altitude_bins[k]
        )
        stats["most_common_cruise_altitude_m"] = round(
            stats["most_common_cruise_altitude_ft"] * 0.3048
        )

    total_flight_time = 0.0
    for times in path_durations.values():
        if len(times) >= 2:
            total_flight_time += max(times) - min(times)
    stats["total_flight_time_seconds"] = total_flight_time

    if stats.get("aircraft_list"):
        aircraft_times: Dict[str, float] = {}
        aircraft_distances: Dict[str, float] = {}

        for pi in path_info_list:
            reg = pi.get("aircraft_registration")
            path_id = pi.get("id")
            if reg and path_id is not None and path_id in path_durations:
                if reg not in aircraft_times:
                    aircraft_times[reg] = 0
                    aircraft_distances[reg] = 0.0
                times = path_durations[path_id]
                if len(times) >= 2:
                    aircraft_times[reg] += max(times) - min(times)

        for segment in segments:
            path_id = segment.get("path_id")
            if path_id is not None and path_id < len(path_info_list):
                pi = path_info_list[path_id]
                reg = pi.get("aircraft_registration")
                if reg and reg in aircraft_distances:
                    coords = segment.get("coords", [])
                    if len(coords) == 2:
                        lat1, lon1 = coords[0]
                        lat2, lon2 = coords[1]
                        aircraft_distances[reg] += haversine_distance(
                            lat1, lon1, lat2, lon2
                        )

        for aircraft in stats["aircraft_list"]:
            reg = aircraft["registration"]
            if reg in aircraft_times:
                flight_time_seconds = aircraft_times[reg]
                flight_distance_km = aircraft_distances.get(reg, 0.0)
                aircraft["flight_time_seconds"] = flight_time_seconds
                aircraft["flight_distance_km"] = flight_distance_km
                aircraft["flight_time_str"] = format_flight_time(flight_time_seconds)


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
