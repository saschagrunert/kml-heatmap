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


def process_single_path(args):
    """
    Process a single path at all resolution levels.

    This function is designed to be called in parallel for maximum CPU utilization.

    Args:
        args: Tuple of (path_idx, path, metadata, min_alt_m, max_alt_m,
                        resolutions, resolution_order, epsilon_values)

    Returns:
        Dictionary with processed path data for all resolutions
    """
    (
        path_idx,
        path,
        metadata,
        min_alt_m,
        max_alt_m,
        resolutions,
        resolution_order,
        epsilon_values,
    ) = args

    if len(path) <= 1:
        return None

    # Extract metadata
    airport_name = metadata.get("airport_name", "")
    start_airport = None
    end_airport = None

    if airport_name and " - " in airport_name:
        parts = airport_name.split(" - ")
        if len(parts) == 2:
            start_airport = parts[0].strip()
            end_airport = parts[1].strip()

    path_year = metadata.get("year")

    # Calculate path duration and distance
    path_duration_seconds = 0
    path_distance_km = 0

    start_ts = metadata.get("timestamp")
    end_ts = metadata.get("end_timestamp")

    if start_ts and end_ts:
        path_duration_seconds = calculate_duration_seconds(start_ts, end_ts)

    # Calculate total path distance
    for i in range(len(path) - 1):
        lat1, lon1 = path[i][0], path[i][1]
        lat2, lon2 = path[i + 1][0], path[i + 1][1]
        path_distance_km += haversine_distance(lat1, lon1, lat2, lon2)

    path_distance_nm = path_distance_km * KM_TO_NAUTICAL_MILES

    # Calculate ground level for this path
    ground_level_m = min([coord[2] for coord in path]) if path else 0

    # Find path start time for relative time calculation
    path_start_time = None
    for coord in path:
        if len(coord) >= 4:
            path_start_time = parse_iso_timestamp(coord[3])
            if path_start_time:
                break

    # Calculate instantaneous speeds and timestamps (once for all resolutions)
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
                    segment_distance_nm = segment_distance_km * KM_TO_NAUTICAL_MILES
                    instant_speed = (segment_distance_nm / time_delta) * 3600
                    if instant_speed > MAX_GROUNDSPEED_KNOTS:
                        instant_speed = 0

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

    # Process path at each resolution level
    resolution_data = {}
    for res_name in resolution_order:
        res_config = resolutions[res_name]

        # Use pre-calculated year-level epsilon for consistent downsampling
        adaptive_epsilon = epsilon_values.get(res_name, res_config["epsilon"])

        if adaptive_epsilon > 0:
            downsampled_path = downsample_path_rdp(path, adaptive_epsilon)
        else:
            downsampled_path = path

        # Generate segments for this resolution
        path_segments = []
        max_groundspeed = 0
        min_groundspeed = float("inf")
        cruise_distance = 0
        cruise_time = 0
        cruise_altitude_histogram = {}

        for i in range(len(downsampled_path) - 1):
            coord1 = downsampled_path[i]
            coord2 = downsampled_path[i + 1]
            lat1, lon1, alt1_m = coord1[0], coord1[1], coord1[2]
            lat2, lon2, alt2_m = coord2[0], coord2[1], coord2[2]

            avg_alt_m = (alt1_m + alt2_m) / 2
            avg_alt_ft = round(avg_alt_m * METERS_TO_FEET / 100) * 100
            color = get_altitude_color(avg_alt_m, min_alt_m, max_alt_m)

            # Find corresponding segment in original path for speed calculation
            groundspeed_knots = 0
            current_relative_time = None
            window_time = 0
            window_distance = 0

            # For downsampled paths, find nearest segment in original
            if i < len(segment_speeds):
                current_segment = segment_speeds[min(i, len(segment_speeds) - 1)]
                current_timestamp = current_segment["timestamp"]
                current_relative_time = current_segment["relative_time"]

                if current_timestamp is not None and timestamp_list:
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

            # Track statistics (only for z14_plus to avoid duplication)
            if res_name == "z14_plus" and groundspeed_knots > 0:
                if groundspeed_knots > max_groundspeed:
                    max_groundspeed = groundspeed_knots
                if groundspeed_knots < min_groundspeed:
                    min_groundspeed = groundspeed_knots

                # Track cruise speed (only segments >1000ft AGL)
                altitude_agl_m = avg_alt_m - ground_level_m
                altitude_agl_ft = altitude_agl_m * METERS_TO_FEET
                if altitude_agl_ft > CRUISE_ALTITUDE_THRESHOLD_FT:
                    if window_time >= MIN_SEGMENT_TIME_SECONDS:
                        cruise_distance += window_distance * KM_TO_NAUTICAL_MILES
                        cruise_time += window_time

                        altitude_bin_ft = (
                            int(altitude_agl_ft / ALTITUDE_BIN_SIZE_FT)
                            * ALTITUDE_BIN_SIZE_FT
                        )
                        if altitude_bin_ft not in cruise_altitude_histogram:
                            cruise_altitude_histogram[altitude_bin_ft] = 0
                        cruise_altitude_histogram[altitude_bin_ft] += window_time

            # Skip zero-length segments
            if lat1 != lat2 or lon1 != lon2:
                segment_data = {
                    "coords": [[lat1, lon1], [lat2, lon2]],
                    "color": color,
                    "altitude_ft": avg_alt_ft,
                    "altitude_m": round(avg_alt_m, 0),
                    "groundspeed_knots": round(groundspeed_knots, 1),
                    "path_id": path_idx,  # Will be remapped later
                }
                if current_relative_time is not None:
                    segment_data["time"] = round(current_relative_time, 1)
                path_segments.append(segment_data)

        # Store path info
        path_info = {
            "id": path_idx,  # Will be remapped later
            "start_airport": start_airport,
            "end_airport": end_airport,
            "start_coords": [path[0][0], path[0][1]],
            "end_coords": [path[-1][0], path[-1][1]],
            "segment_count": len(path_segments),
            "year": path_year,
        }
        if "aircraft_registration" in metadata:
            path_info["aircraft_registration"] = metadata["aircraft_registration"]
        if "aircraft_type" in metadata:
            path_info["aircraft_type"] = metadata["aircraft_type"]

        # Store resolution data
        resolution_data[res_name] = {
            "segments": path_segments,
            "path_info": path_info,
            "downsampled_coords": [[p[0], p[1]] for p in downsampled_path],
        }

        # Store statistics only for z14_plus
        if res_name == "z14_plus":
            resolution_data[res_name]["max_groundspeed"] = max_groundspeed
            resolution_data[res_name]["min_groundspeed"] = (
                min_groundspeed if min_groundspeed != float("inf") else 0
            )
            resolution_data[res_name]["cruise_distance"] = cruise_distance
            resolution_data[res_name]["cruise_time"] = cruise_time
            resolution_data[res_name]["cruise_altitude_histogram"] = (
                cruise_altitude_histogram
            )
            resolution_data[res_name]["path_distance_nm"] = path_distance_nm

    return {
        "path_idx": path_idx,
        "year": str(path_year) if path_year else "unknown",
        "resolution_data": resolution_data,
    }


def aggregate_results_by_year(path_results, resolutions, resolution_order, output_dir):
    """
    Aggregate path processing results by year and write to files.

    Args:
        path_results: List of results from process_single_path
        resolutions: Resolution configuration
        resolution_order: Order to process resolutions
        output_dir: Output directory

    Returns:
        Dictionary with aggregated statistics per year
    """
    # Group results by year
    years_data = {}

    for result in path_results:
        if result is None:  # Skip empty paths
            continue

        year = result["year"]
        if year not in years_data:
            years_data[year] = {
                "paths": [],
                "max_groundspeed": 0,
                "min_groundspeed": float("inf"),
                "cruise_distance": 0,
                "cruise_time": 0,
                "max_path_distance": 0,
                "cruise_altitude_histogram": {},
            }

        years_data[year]["paths"].append(result)

        # Aggregate z14_plus statistics
        z14_data = result["resolution_data"].get("z14_plus", {})
        if z14_data:
            year_data = years_data[year]
            year_data["max_groundspeed"] = max(
                year_data["max_groundspeed"], z14_data.get("max_groundspeed", 0)
            )
            year_data["min_groundspeed"] = min(
                year_data["min_groundspeed"],
                z14_data.get("min_groundspeed", float("inf")),
            )
            year_data["cruise_distance"] += z14_data.get("cruise_distance", 0)
            year_data["cruise_time"] += z14_data.get("cruise_time", 0)
            year_data["max_path_distance"] = max(
                year_data["max_path_distance"], z14_data.get("path_distance_nm", 0)
            )

            # Merge cruise altitude histograms
            for altitude_bin, time_spent in z14_data.get(
                "cruise_altitude_histogram", {}
            ).items():
                if altitude_bin not in year_data["cruise_altitude_histogram"]:
                    year_data["cruise_altitude_histogram"][altitude_bin] = 0
                year_data["cruise_altitude_histogram"][altitude_bin] += time_spent

    # Write files for each year
    year_results = []
    for year in sorted(years_data.keys()):
        year_data = years_data[year]
        year_file_structure = []
        year_z14_segments = None
        year_z14_path_info = None

        # Create year directory
        year_dir = os.path.join(output_dir, year)
        os.makedirs(year_dir, exist_ok=True)

        # Sort paths by original path_idx for deterministic output
        year_data["paths"].sort(key=lambda x: x["path_idx"])

        # Write each resolution level
        for res_name in resolution_order:
            res_config = resolutions[res_name]

            # Collect all segments and paths for this resolution
            all_segments = []
            all_path_info = []
            all_downsampled_coords = []
            path_id_remap = {}  # Map old path_idx to new sequential IDs

            for path_result in year_data["paths"]:
                res_data = path_result["resolution_data"].get(res_name, {})
                if not res_data:
                    continue

                old_path_idx = path_result["path_idx"]
                new_path_id = len(all_path_info)
                path_id_remap[old_path_idx] = new_path_id

                # Add path info with remapped ID
                path_info = res_data["path_info"].copy()
                path_info["id"] = new_path_id
                all_path_info.append(path_info)

                # Add segments with remapped path_id
                for segment in res_data["segments"]:
                    segment_copy = segment.copy()
                    segment_copy["path_id"] = new_path_id
                    all_segments.append(segment_copy)

                # Add downsampled coordinates
                all_downsampled_coords.extend(res_data["downsampled_coords"])

            # Apply uniform sampling if over target
            target_points = TARGET_POINTS_PER_RESOLUTION[res_name]
            if len(all_segments) > target_points:
                step = len(all_segments) // target_points
                if step > 1:
                    all_segments = all_segments[::step]
                    logger.debug(
                        f"    {year}/{res_name}: Uniform sampling of segments "
                        f"({len(all_segments):,} segments, step={step})"
                    )

            # Filter path_info to only include paths with segments
            if len(all_segments) < len(all_path_info):
                used_path_ids = set(seg["path_id"] for seg in all_segments)
                all_path_info = [p for p in all_path_info if p["id"] in used_path_ids]

            # Export data
            data = {
                "coordinates": all_downsampled_coords,
                "path_segments": all_segments,
                "path_info": all_path_info,
                "resolution": res_name,
                "original_points": len(all_downsampled_coords),
                "downsampled_points": len(all_downsampled_coords),
                "compression_ratio": 100.0,
            }

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
                year_z14_segments = all_segments
                year_z14_path_info = all_path_info

            logger.info(
                f"    ✓ {year}/{res_config['description']}: "
                f"{len(all_downsampled_coords):,} points ({file_size / 1024:.1f} KB)"
            )

        # Handle infinity case for min_groundspeed
        min_gs = year_data["min_groundspeed"]
        if min_gs == float("inf"):
            min_gs = 0

        year_results.append(
            {
                "year": year,
                "max_groundspeed": year_data["max_groundspeed"],
                "min_groundspeed": min_gs,
                "cruise_distance": year_data["cruise_distance"],
                "cruise_time": year_data["cruise_time"],
                "max_path_distance": year_data["max_path_distance"],
                "cruise_altitude_histogram": year_data["cruise_altitude_histogram"],
                "file_structure": year_file_structure,
                "z14_segments": year_z14_segments,
                "z14_path_info": year_z14_path_info,
            }
        )

    return year_results


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
