"""Data export functionality for progressive loading heatmaps.

This module handles the export of flight data to JSON files optimized for
progressive loading in web browsers. The export system creates multiple
resolution levels to balance detail with file size.

Multi-Resolution Strategy:
The system exports data at 5 different resolution levels:
1. z0-4 (continent): Highly simplified for initial map load
2. z5-7 (country): Medium simplification for country-level view
3. z8-10 (regional): Lower simplification for regional detail
4. z11-13 (city): Minimal simplification for city-level detail
5. z14+ (full): Complete data for maximum zoom

Each level uses:
- Ramer-Douglas-Peucker (RDP) algorithm for path simplification
- Different epsilon values for varying detail levels
- Separate JSON files loaded on-demand based on zoom level

File Structure:
- data_z0_4.json through data_z14_plus.json: Path and segment data
- airports.json: Deduplicated airport locations
- metadata.json: Statistics and configuration

Performance Optimizations:
- JSON files use compact separators (no whitespace)
- Sorted keys for better compression
- Coordinates rounded to appropriate precision
- Privacy mode strips timestamps when requested

This progressive loading approach dramatically improves:
- Initial page load time (loads only coarse data first)
- Mobile performance (less data transferred)
- User experience (map renders immediately)
"""

import os
import json
from typing import List, Dict, Any, Tuple

from .airports import extract_airport_name
from .logger import logger
from .constants import (
    HEATMAP_GRADIENT,
    KM_TO_NAUTICAL_MILES,
    METERS_TO_FEET,
    MIN_SEGMENT_TIME_SECONDS,
    SPEED_WINDOW_SECONDS,
    MAX_GROUNDSPEED_KNOTS,
    CRUISE_ALTITUDE_THRESHOLD_FT,
    ALTITUDE_BIN_SIZE_FT,
    TARGET_POINTS_PER_RESOLUTION,
)
from .geometry import (
    haversine_distance,
    downsample_path_rdp,
    get_altitude_color,
    calculate_adaptive_epsilon,
)
from .helpers import parse_iso_timestamp, calculate_duration_seconds


def downsample_coordinates(
    coordinates: List[List[float]], factor: int
) -> List[List[float]]:
    """
    Simple downsampling by keeping every Nth point.

    Args:
        coordinates: List of [lat, lon] coordinates
        factor: Keep every Nth point

    Returns:
        Downsampled coordinates
    """
    if factor <= 1:
        return coordinates
    return [coordinates[i] for i in range(0, len(coordinates), factor)]


def export_resolution_data(
    resolution_name: str,
    resolution_config: Dict[str, Any],
    all_coordinates: List[List[float]],
    path_segments: List[Dict[str, Any]],
    path_info: List[Dict[str, Any]],
    output_dir: str,
) -> Tuple[str, int]:
    """
    Export data for a single resolution level.

    Args:
        resolution_name: Name of the resolution (e.g., 'z14_plus')
        resolution_config: Resolution configuration dict
        all_coordinates: Original coordinates
        path_segments: Calculated path segments
        path_info: Path metadata
        output_dir: Output directory

    Returns:
        Tuple of (output_file_path, file_size_bytes)
    """
    data = {
        "coordinates": all_coordinates,
        "path_segments": path_segments,
        "path_info": path_info,
        "resolution": resolution_name,
        "original_points": len(all_coordinates),
        "downsampled_points": len(all_coordinates),
        "compression_ratio": 100.0,
    }

    output_file = os.path.join(output_dir, f"data_{resolution_name}.json")

    with open(output_file, "w") as f:
        json.dump(data, f, separators=(",", ":"), sort_keys=True)

    file_size = os.path.getsize(output_file)

    logger.info(
        f"  ✓ {resolution_config['description']}: "
        f"{len(all_coordinates):,} points ({file_size / 1024:.1f} KB)"
    )

    return output_file, file_size


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
    airports_file = os.path.join(output_dir, "airports.json")

    with open(airports_file, "w") as f:
        json.dump(airports_data, f, separators=(",", ":"), sort_keys=True)

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

    meta_file = os.path.join(output_dir, "metadata.json")

    with open(meta_file, "w") as f:
        json.dump(meta_data, f, separators=(",", ":"), sort_keys=True)

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
    quiet=False,
):
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
    year_max_groundspeed = 0
    year_min_groundspeed = float("inf")
    year_cruise_distance = 0
    year_cruise_time = 0
    year_max_path_distance = 0
    year_cruise_altitude_histogram = {}
    year_file_structure = []
    year_z14_segments = None
    year_z14_path_info = None

    # Calculate total points for this year (for adaptive downsampling)
    year_total_points = sum(
        len(all_path_groups[path_idx]) for path_idx in year_path_indices
    )
    if not quiet:
        logger.info(f"    Total points for {year}: {year_total_points:,}")

    for res_name in resolution_order:
        res_config = resolutions[res_name]

        # Calculate adaptive epsilon based on dataset size
        base_epsilon = res_config["epsilon"]
        target_points = TARGET_POINTS_PER_RESOLUTION[res_name]
        adaptive_epsilon = calculate_adaptive_epsilon(
            year_total_points, target_points, base_epsilon
        )

        # Log adaptive behavior if epsilon was adjusted
        if adaptive_epsilon != base_epsilon and not quiet:
            logger.info(
                f"    {res_name}: Adaptive downsampling "
                f"(ε={adaptive_epsilon:.6f}, target={target_points:,} points)"
            )

        # OPTIMIZATION: Downsample paths once (with altitude), then extract 2D coords
        downsampled_paths = []
        for path_idx in year_path_indices:
            path = all_path_groups[path_idx]
            if adaptive_epsilon > 0:
                simplified = downsample_path_rdp(path, adaptive_epsilon)
                downsampled_paths.append(simplified)
            else:
                downsampled_paths.append(path)

        # Extract 2D coordinates from already-downsampled paths
        if adaptive_epsilon > 0:
            downsampled_coords = [
                [p[0], p[1]] for path in downsampled_paths for p in path
            ]
            if not downsampled_coords:
                downsampled_coords = downsample_coordinates(
                    all_coordinates, res_config["factor"]
                )
        else:
            downsampled_coords = all_coordinates

        # ADDITIONAL: Uniform sampling if RDP didn't get us under target
        if len(downsampled_coords) > target_points:
            # Sample every Nth point to stay under target
            step = len(downsampled_coords) // target_points
            if step > 1:
                downsampled_coords = downsampled_coords[::step]
                if not quiet:
                    logger.info(
                        f"    {res_name}: Uniform sampling applied "
                        f"({len(downsampled_coords):,} points, step={step})"
                    )

        # Prepare path segments with colors and track relationships
        path_segments = []
        path_info = []

        # Iterate using original path indices to access metadata correctly
        for local_idx, (orig_path_idx, path) in enumerate(
            zip(year_path_indices, downsampled_paths)
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
            path_duration_seconds = 0
            path_distance_km = 0

            start_ts = metadata.get("timestamp")
            end_ts = metadata.get("end_timestamp")

            if start_ts and end_ts:
                path_duration_seconds = calculate_duration_seconds(start_ts, end_ts)
                if path_duration_seconds == 0:
                    logger.debug(
                        f"  Could not parse timestamps '{start_ts}' -> '{end_ts}'"
                    )

            # Calculate total path distance
            for i in range(len(path) - 1):
                lat1, lon1 = path[i][0], path[i][1]
                lat2, lon2 = path[i + 1][0], path[i + 1][1]
                path_distance_km += haversine_distance(lat1, lon1, lat2, lon2)

            # Track longest single flight distance (only for z14_plus to avoid duplication)
            if res_name == "z14_plus":
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
            segment_speeds = []

            for i in range(len(path) - 1):
                coord1 = path[i]
                coord2 = path[i + 1]

                lat1, lon1 = coord1[0], coord1[1]
                lat2, lon2 = coord2[0], coord2[1]
                segment_distance_km = haversine_distance(lat1, lon1, lat2, lon2)

                instant_speed = 0
                timestamp = None
                time_delta = 0
                relative_time = None

                if len(coord1) >= 4 and len(coord2) >= 4:
                    ts1, ts2 = coord1[3], coord2[3]
                    dt1 = parse_iso_timestamp(ts1)
                    dt2 = parse_iso_timestamp(ts2)
                    if dt1 and dt2:
                        time_delta = (dt2 - dt1).total_seconds()
                        timestamp = dt1

                        if path_start_time is not None:
                            relative_time = (dt1 - path_start_time).total_seconds()

                        if time_delta >= MIN_SEGMENT_TIME_SECONDS:
                            segment_distance_nm = (
                                segment_distance_km * KM_TO_NAUTICAL_MILES
                            )
                            instant_speed = (segment_distance_nm / time_delta) * 3600
                            if instant_speed > MAX_GROUNDSPEED_KNOTS:
                                instant_speed = 0
                    else:
                        logger.debug(
                            f"  Could not parse segment timestamps '{ts1}' -> '{ts2}'"
                        )

                segment_speeds.append(
                    {
                        "index": i,
                        "timestamp": timestamp,
                        "relative_time": relative_time,
                        "speed": instant_speed,
                        "distance": segment_distance_km,
                        "time_delta": time_delta,
                    }
                )

            # Build time-sorted list for efficient window queries
            time_indexed_segments = []
            timestamp_list = []
            for seg in segment_speeds:
                if seg["timestamp"] is not None and seg["speed"] != 0:
                    ts = seg["timestamp"].timestamp()
                    timestamp_list.append(ts)
                    time_indexed_segments.append(seg)

            # Sort both lists together
            if timestamp_list:
                sorted_pairs = sorted(
                    zip(timestamp_list, time_indexed_segments),
                    key=lambda x: x[0],
                )
                timestamp_list, time_indexed_segments = zip(*sorted_pairs)
                timestamp_list = list(timestamp_list)
                time_indexed_segments = list(time_indexed_segments)

            # Second pass: calculate rolling average speeds using time window
            for i in range(len(path) - 1):
                coord1 = path[i]
                coord2 = path[i + 1]
                lat1, lon1, alt1_m = coord1[0], coord1[1], coord1[2]
                lat2, lon2, alt2_m = coord2[0], coord2[1], coord2[2]

                avg_alt_m = (alt1_m + alt2_m) / 2
                avg_alt_ft = round(avg_alt_m * METERS_TO_FEET / 100) * 100
                color = get_altitude_color(avg_alt_m, min_alt_m, max_alt_m)

                # Calculate windowed average groundspeed
                groundspeed_knots = 0
                current_segment = segment_speeds[i]
                current_timestamp = current_segment["timestamp"]
                current_relative_time = current_segment["relative_time"]

                if current_timestamp is not None and timestamp_list:
                    window_distance = 0
                    window_time = 0
                    current_ts = current_timestamp.timestamp()
                    half_window = SPEED_WINDOW_SECONDS / 2

                    from bisect import bisect_left, bisect_right

                    start_idx = bisect_left(timestamp_list, current_ts - half_window)
                    end_idx = bisect_right(timestamp_list, current_ts + half_window)

                    for j in range(start_idx, end_idx):
                        seg = time_indexed_segments[j]
                        window_distance += seg["distance"]
                        window_time += seg["time_delta"]

                    if window_time >= MIN_SEGMENT_TIME_SECONDS:
                        window_distance_nm = window_distance * KM_TO_NAUTICAL_MILES
                        groundspeed_knots = (window_distance_nm / window_time) * 3600
                        if groundspeed_knots > MAX_GROUNDSPEED_KNOTS:
                            groundspeed_knots = 0

                # Fall back to path average if no timestamp-based calculation
                if (
                    groundspeed_knots == 0
                    and path_duration_seconds > 0
                    and path_distance_km > 0
                ):
                    segment_distance_km = haversine_distance(lat1, lon1, lat2, lon2)
                    segment_time_seconds = (
                        segment_distance_km / path_distance_km
                    ) * path_duration_seconds
                    if segment_time_seconds >= MIN_SEGMENT_TIME_SECONDS:
                        segment_distance_nm = segment_distance_km * KM_TO_NAUTICAL_MILES
                        calculated_speed = (
                            segment_distance_nm / segment_time_seconds
                        ) * 3600
                        if 0 < calculated_speed <= MAX_GROUNDSPEED_KNOTS:
                            groundspeed_knots = calculated_speed

                # Track maximum and minimum groundspeed (only for z14_plus)
                if res_name == "z14_plus" and groundspeed_knots > 0:
                    if groundspeed_knots > year_max_groundspeed:
                        year_max_groundspeed = groundspeed_knots
                    if groundspeed_knots < year_min_groundspeed:
                        year_min_groundspeed = groundspeed_knots

                    # Track cruise speed (only segments >1000ft AGL)
                    altitude_agl_m = avg_alt_m - ground_level_m
                    altitude_agl_ft = altitude_agl_m * METERS_TO_FEET
                    if altitude_agl_ft > CRUISE_ALTITUDE_THRESHOLD_FT:
                        if window_time >= MIN_SEGMENT_TIME_SECONDS:
                            year_cruise_distance += (
                                window_distance * KM_TO_NAUTICAL_MILES
                            )
                            year_cruise_time += window_time

                            altitude_bin_ft = (
                                int(altitude_agl_ft / ALTITUDE_BIN_SIZE_FT)
                                * ALTITUDE_BIN_SIZE_FT
                            )
                            if altitude_bin_ft not in year_cruise_altitude_histogram:
                                year_cruise_altitude_histogram[altitude_bin_ft] = 0
                            year_cruise_altitude_histogram[altitude_bin_ft] += (
                                window_time
                            )

                # For downsampled resolutions, clamp to the max from z14_plus
                if (
                    res_name != "z14_plus"
                    and year_max_groundspeed > 0
                    and groundspeed_knots > year_max_groundspeed
                ):
                    groundspeed_knots = year_max_groundspeed

                # Skip zero-length segments
                if lat1 != lat2 or lon1 != lon2:
                    segment_data = {
                        "coords": [[lat1, lon1], [lat2, lon2]],
                        "color": color,
                        "altitude_ft": avg_alt_ft,
                        "altitude_m": round(avg_alt_m, 0),
                        "groundspeed_knots": round(groundspeed_knots, 1),
                        "path_id": local_idx,
                    }
                    if current_relative_time is not None:
                        segment_data["time"] = round(current_relative_time, 1)
                    path_segments.append(segment_data)

        # ADDITIONAL: Uniform sampling of path_segments if over target
        if len(path_segments) > target_points:
            step = len(path_segments) // target_points
            if step > 1:
                path_segments = path_segments[::step]
                if not quiet:
                    logger.info(
                        f"    {res_name}: Uniform sampling of segments "
                        f"({len(path_segments):,} segments, step={step})"
                    )

        # ADDITIONAL: Filter path_info to only include paths present in downsampled segments
        # This dramatically reduces file size by removing metadata for unused paths
        if len(path_segments) < len(path_info):
            used_path_ids = set(seg["path_id"] for seg in path_segments)
            filtered_path_info = [p for p in path_info if p["id"] in used_path_ids]
            if not quiet and len(filtered_path_info) < len(path_info):
                logger.info(
                    f"    {res_name}: Filtered path_info "
                    f"({len(filtered_path_info):,} paths, was {len(path_info):,})"
                )
            path_info = filtered_path_info

        # Export data
        data = {
            "coordinates": downsampled_coords,
            "path_segments": path_segments,
            "path_info": path_info,
            "resolution": res_name,
            "original_points": len(all_coordinates),
            "downsampled_points": len(downsampled_coords),
            "compression_ratio": round(
                len(downsampled_coords) / max(len(all_coordinates), 1) * 100, 1
            ),
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

        # Store z14_plus data
        if res_name == "z14_plus":
            year_z14_segments = path_segments
            year_z14_path_info = path_info

        if not quiet:
            logger.info(
                f"    ✓ {res_config['description']}: {len(downsampled_coords):,} points ({file_size / 1024:.1f} KB)"
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
        "z14_segments": year_z14_segments,
        "z14_path_info": year_z14_path_info,
    }
