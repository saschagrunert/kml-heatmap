"""Data export functionality - refactored from monolithic export_data_json."""

import os
import json
import numpy as np
from datetime import datetime
from bisect import bisect_left, bisect_right

from typing import List, Dict, Any, Tuple
from .geometry import haversine_distance, get_altitude_color
from .airports import extract_airport_name
from .logger import logger
from .constants import (
    METERS_TO_FEET,
    KM_TO_NAUTICAL_MILES,
    MAX_GROUNDSPEED_KNOTS,
    MIN_SEGMENT_TIME_SECONDS,
    SPEED_WINDOW_SECONDS,
    CRUISE_ALTITUDE_THRESHOLD_FT,
    ALTITUDE_BIN_SIZE_FT,
    SECONDS_PER_HOUR,
)


class SegmentSpeedCalculator:
    """Calculate ground speeds for flight path segments using NumPy optimization."""

    def __init__(self, path, ground_level_m):
        """
        Initialize speed calculator for a flight path.

        Args:
            path: List of coordinates [[lat, lon, alt, timestamp], ...]
            ground_level_m: Ground level altitude in meters
        """
        self.path = path
        self.ground_level_m = ground_level_m
        self.path_start_time = self._find_path_start_time()
        self.segment_speeds = []

    def _find_path_start_time(self):
        """Find the first valid timestamp in the path."""
        for coord in self.path:
            if len(coord) >= 4:
                try:
                    if "T" in coord[3]:
                        return datetime.fromisoformat(coord[3].replace("Z", "+00:00"))
                except (ValueError, TypeError):
                    continue
        return None

    def calculate_instantaneous_speeds(self):
        """
        Calculate instantaneous speeds for all segments using NumPy.

        Returns:
            List of segment speed dictionaries
        """
        n_segments = len(self.path) - 1
        if n_segments <= 0:
            return []

        # Pre-allocate arrays
        distances_km = np.zeros(n_segments)
        time_deltas = np.zeros(n_segments)
        timestamps = []
        relative_times = []

        # Vectorized distance calculation where possible
        for i in range(n_segments):
            coord1, coord2 = self.path[i], self.path[i + 1]
            lat1, lon1 = coord1[0], coord1[1]
            lat2, lon2 = coord2[0], coord2[1]

            distances_km[i] = haversine_distance(lat1, lon1, lat2, lon2)

            # Parse timestamps
            timestamp = None
            relative_time = None
            if len(coord1) >= 4 and len(coord2) >= 4:
                ts1, ts2 = coord1[3], coord2[3]
                try:
                    if "T" in ts1 and "T" in ts2:
                        dt1 = datetime.fromisoformat(ts1.replace("Z", "+00:00"))
                        dt2 = datetime.fromisoformat(ts2.replace("Z", "+00:00"))
                        time_deltas[i] = (dt2 - dt1).total_seconds()
                        timestamp = dt1

                        if self.path_start_time is not None:
                            relative_time = (dt1 - self.path_start_time).total_seconds()
                except (ValueError, TypeError) as e:
                    logger.debug(
                        f"Could not parse segment timestamps '{ts1}' -> '{ts2}': {e}"
                    )

            timestamps.append(timestamp)
            relative_times.append(relative_time)

        # Calculate speeds using NumPy (vectorized)
        distances_nm = distances_km * KM_TO_NAUTICAL_MILES
        mask = time_deltas >= MIN_SEGMENT_TIME_SECONDS
        speeds = np.zeros(n_segments)
        speeds[mask] = (distances_nm[mask] / time_deltas[mask]) * SECONDS_PER_HOUR

        # Cap unrealistic speeds
        speeds[speeds > MAX_GROUNDSPEED_KNOTS] = 0

        # Build segment_speeds list
        self.segment_speeds = []
        for i in range(n_segments):
            self.segment_speeds.append(
                {
                    "index": i,
                    "timestamp": timestamps[i],
                    "relative_time": relative_times[i],
                    "speed": speeds[i],
                    "distance": distances_km[i],
                    "time_delta": time_deltas[i],
                }
            )

        return self.segment_speeds

    def calculate_rolling_average_speeds(self):
        """
        Calculate rolling average speeds using time window.

        Returns:
            Tuple of (groundspeeds, relative_times) arrays
        """
        if not self.segment_speeds:
            self.calculate_instantaneous_speeds()

        n_segments = len(self.segment_speeds)
        groundspeeds = np.zeros(n_segments)
        relative_times = []

        # Build time-sorted index for efficient window queries
        time_indexed_segments = []
        timestamp_list = []
        for seg in self.segment_speeds:
            if seg["timestamp"] is not None and seg["speed"] != 0:
                timestamp_list.append(seg["timestamp"].timestamp())
                time_indexed_segments.append(seg)

        # Sort by timestamp
        if timestamp_list:
            sorted_pairs = sorted(
                zip(timestamp_list, time_indexed_segments), key=lambda x: x[0]
            )
            timestamp_list, time_indexed_segments = zip(*sorted_pairs)
            timestamp_list = list(timestamp_list)
            time_indexed_segments = list(time_indexed_segments)

        # Calculate rolling averages
        half_window = SPEED_WINDOW_SECONDS / 2

        for i, seg in enumerate(self.segment_speeds):
            current_timestamp = seg["timestamp"]
            relative_times.append(seg["relative_time"])

            if current_timestamp is not None and timestamp_list:
                current_ts = current_timestamp.timestamp()

                # Binary search for window bounds
                start_idx = bisect_left(timestamp_list, current_ts - half_window)
                end_idx = bisect_right(timestamp_list, current_ts + half_window)

                # Accumulate segments in window
                window_distance = sum(
                    time_indexed_segments[j]["distance"]
                    for j in range(start_idx, end_idx)
                )
                window_time = sum(
                    time_indexed_segments[j]["time_delta"]
                    for j in range(start_idx, end_idx)
                )

                # Calculate average speed
                if window_time >= MIN_SEGMENT_TIME_SECONDS:
                    window_distance_nm = window_distance * KM_TO_NAUTICAL_MILES
                    speed = (window_distance_nm / window_time) * SECONDS_PER_HOUR
                    if speed <= MAX_GROUNDSPEED_KNOTS:
                        groundspeeds[i] = speed

        return groundspeeds, relative_times


def calculate_path_duration_and_distance(
    path: List[List[float]], metadata: Dict[str, Any]
) -> Tuple[float, float]:
    """
    Calculate total duration and distance for a flight path.

    Args:
        path: List of coordinates [[lat, lon, alt], ...]
        metadata: Path metadata dictionary with 'timestamp' and 'end_timestamp'

    Returns:
        Tuple of (duration_seconds, distance_km)
    """
    duration_seconds = 0.0
    distance_km = 0.0

    # Calculate duration from timestamps
    start_ts = metadata.get("timestamp")
    end_ts = metadata.get("end_timestamp")

    if start_ts and end_ts:
        try:
            if "T" in start_ts and "T" in end_ts:
                start_dt = datetime.fromisoformat(start_ts.replace("Z", "+00:00"))
                end_dt = datetime.fromisoformat(end_ts.replace("Z", "+00:00"))
                duration_seconds = float((end_dt - start_dt).total_seconds())
        except (ValueError, TypeError) as e:
            logger.debug(
                f"Could not parse path timestamps '{start_ts}' -> '{end_ts}': {e}"
            )

    # Calculate total distance
    for i in range(len(path) - 1):
        lat1, lon1 = path[i][0], path[i][1]
        lat2, lon2 = path[i + 1][0], path[i + 1][1]
        distance_km += float(haversine_distance(lat1, lon1, lat2, lon2))

    return duration_seconds, distance_km


def _update_speed_statistics(
    groundspeed_knots: float, speed_stats: Dict[str, float]
) -> None:
    """
    Update speed statistics with new groundspeed reading.

    Args:
        groundspeed_knots: Groundspeed in knots
        speed_stats: Dictionary to update with max/min speeds
    """
    if groundspeed_knots > 0:
        if groundspeed_knots > speed_stats["max"]:
            speed_stats["max"] = groundspeed_knots
        if groundspeed_knots < speed_stats["min"]:
            speed_stats["min"] = groundspeed_knots


def _update_cruise_statistics(
    avg_alt_m: float,
    ground_level_m: float,
    seg_info: Dict[str, Any],
    cruise_stats: Dict[str, Any],
) -> None:
    """
    Update cruise statistics for segments at cruise altitude.

    Args:
        avg_alt_m: Average altitude in meters
        ground_level_m: Ground level altitude in meters
        seg_info: Segment information with distance and time_delta
        cruise_stats: Dictionary to accumulate cruise statistics
    """
    altitude_agl_m = avg_alt_m - ground_level_m
    altitude_agl_ft = altitude_agl_m * METERS_TO_FEET

    if altitude_agl_ft > CRUISE_ALTITUDE_THRESHOLD_FT:
        if seg_info["time_delta"] >= MIN_SEGMENT_TIME_SECONDS:
            cruise_stats["total_distance_nm"] += (
                seg_info["distance"] * KM_TO_NAUTICAL_MILES
            )
            cruise_stats["total_time_s"] += seg_info["time_delta"]

            # Track cruise altitude histogram
            altitude_bin_ft = (
                int(altitude_agl_ft / ALTITUDE_BIN_SIZE_FT) * ALTITUDE_BIN_SIZE_FT
            )
            if altitude_bin_ft not in cruise_stats["altitude_histogram"]:
                cruise_stats["altitude_histogram"][altitude_bin_ft] = 0
            cruise_stats["altitude_histogram"][altitude_bin_ft] += seg_info[
                "time_delta"
            ]


def _build_path_info(
    path: List[List[float]], path_idx: int, metadata: Dict[str, Any]
) -> Dict[str, Any]:
    """
    Build path information dictionary from metadata.

    Args:
        path: Path coordinates
        path_idx: Path index
        metadata: Path metadata

    Returns:
        Dictionary with path information
    """
    # Extract airport names
    airport_name = metadata.get("airport_name", "")
    start_airport, end_airport = None, None
    if airport_name and " - " in airport_name:
        parts = airport_name.split(" - ")
        if len(parts) == 2:
            start_airport = parts[0].strip()
            end_airport = parts[1].strip()

    path_info = {
        "id": path_idx,
        "start_airport": start_airport,
        "end_airport": end_airport,
        "start_coords": [path[0][0], path[0][1]],
        "end_coords": [path[-1][0], path[-1][1]],
        "segment_count": len(path) - 1,
        "year": metadata.get("year"),
    }

    # Add aircraft info if available
    if "aircraft_registration" in metadata:
        path_info["aircraft_registration"] = metadata["aircraft_registration"]
    if "aircraft_type" in metadata:
        path_info["aircraft_type"] = metadata["aircraft_type"]

    return path_info


def process_path_segments_full_resolution(
    path: List[List[float]],
    path_idx: int,
    metadata: Dict[str, Any],
    min_alt_m: float,
    max_alt_m: float,
    cruise_stats: Dict[str, Any],
    speed_stats: Dict[str, float],
) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    """
    Process a single path at full resolution with detailed speed calculations.

    Args:
        path: Path coordinates
        path_idx: Path index
        metadata: Path metadata
        min_alt_m: Minimum altitude in meters
        max_alt_m: Maximum altitude in meters
        cruise_stats: Dictionary to accumulate cruise statistics
        speed_stats: Dictionary to accumulate speed statistics

    Returns:
        Tuple of (segments_list, path_info_dict)
    """
    segments = []

    # Calculate ground level
    ground_level_m = min([coord[2] for coord in path]) if path else 0

    # Initialize speed calculator
    speed_calc = SegmentSpeedCalculator(path, ground_level_m)
    speed_calc.calculate_instantaneous_speeds()
    groundspeeds, relative_times = speed_calc.calculate_rolling_average_speeds()

    # Process each segment
    for i in range(len(path) - 1):
        coord1 = path[i]
        coord2 = path[i + 1]
        lat1, lon1, alt1_m = coord1[0], coord1[1], coord1[2]
        lat2, lon2, alt2_m = coord2[0], coord2[1], coord2[2]

        # Skip zero-length segments
        if lat1 == lat2 and lon1 == lon2:
            continue

        avg_alt_m = (alt1_m + alt2_m) / 2
        avg_alt_ft = (
            round(avg_alt_m * METERS_TO_FEET / ALTITUDE_BIN_SIZE_FT)
            * ALTITUDE_BIN_SIZE_FT
        )
        color = get_altitude_color(avg_alt_m, min_alt_m, max_alt_m)
        groundspeed_knots = groundspeeds[i]

        # Update statistics
        _update_speed_statistics(groundspeed_knots, speed_stats)
        if groundspeed_knots > 0:
            seg_info = speed_calc.segment_speeds[i]
            _update_cruise_statistics(avg_alt_m, ground_level_m, seg_info, cruise_stats)

        # Build segment data
        segment_data = {
            "coords": [[lat1, lon1], [lat2, lon2]],
            "color": color,
            "altitude_ft": avg_alt_ft,
            "altitude_m": round(avg_alt_m, 0),
            "groundspeed_knots": round(groundspeed_knots, 1),
            "path_id": path_idx,
        }

        # Add relative time for replay
        if relative_times[i] is not None:
            segment_data["time"] = round(relative_times[i], 1)

        segments.append(segment_data)

    # Build path info
    path_info = _build_path_info(path, path_idx, metadata)

    return segments, path_info


def process_path_segments_downsampled(
    path: List[List[float]],
    path_idx: int,
    metadata: Dict[str, Any],
    min_alt_m: float,
    max_alt_m: float,
) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    """
    Process a single path at reduced resolution (no speed calculation).

    Args:
        path: Path coordinates
        path_idx: Path index
        metadata: Path metadata
        min_alt_m: Minimum altitude in meters
        max_alt_m: Maximum altitude in meters

    Returns:
        Tuple of (segments_list, path_info_dict)
    """
    segments = []

    for i in range(len(path) - 1):
        coord1 = path[i]
        coord2 = path[i + 1]
        lat1, lon1, alt1_m = coord1[0], coord1[1], coord1[2]
        lat2, lon2, alt2_m = coord2[0], coord2[1], coord2[2]

        # Skip zero-length segments
        if lat1 == lat2 and lon1 == lon2:
            continue

        avg_alt_m = (alt1_m + alt2_m) / 2
        avg_alt_ft = (
            round(avg_alt_m * METERS_TO_FEET / ALTITUDE_BIN_SIZE_FT)
            * ALTITUDE_BIN_SIZE_FT
        )
        color = get_altitude_color(avg_alt_m, min_alt_m, max_alt_m)

        segments.append(
            {
                "coords": [[lat1, lon1], [lat2, lon2]],
                "color": color,
                "altitude_ft": avg_alt_ft,
                "altitude_m": round(avg_alt_m, 0),
                "groundspeed_knots": 0,
                "path_id": path_idx,
            }
        )

    # Extract path info (same as full resolution)
    airport_name = metadata.get("airport_name", "")
    start_airport, end_airport = None, None
    if airport_name and " - " in airport_name:
        parts = airport_name.split(" - ")
        if len(parts) == 2:
            start_airport = parts[0].strip()
            end_airport = parts[1].strip()

    path_info = {
        "id": path_idx,
        "start_airport": start_airport,
        "end_airport": end_airport,
        "start_coords": [path[0][0], path[0][1]],
        "end_coords": [path[-1][0], path[-1][1]],
        "segment_count": len(path) - 1,
        "year": metadata.get("year"),
    }

    if "aircraft_registration" in metadata:
        path_info["aircraft_registration"] = metadata["aircraft_registration"]
    if "aircraft_type" in metadata:
        path_info["aircraft_type"] = metadata["aircraft_type"]

    return segments, path_info


def export_airports_json(
    unique_airports: List[Dict[str, Any]],
    output_dir: str,
    strip_timestamps: bool = False,
) -> str:
    """
    Export airport data to JSON file.

    Args:
        unique_airports: List of airport dictionaries
        output_dir: Output directory path
        strip_timestamps: If True, remove timestamp data

    Returns:
        Path to exported file
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

    airports_file = os.path.join(output_dir, "airports.json")
    with open(airports_file, "w") as f:
        json.dump(
            {"airports": valid_airports}, f, separators=(",", ":"), sort_keys=True
        )

    logger.info(
        f"  ✓ Airports: {len(valid_airports)} locations ({os.path.getsize(airports_file) / 1024:.1f} KB)"
    )
    return airports_file


def export_metadata_json(
    stats: Dict[str, Any],
    min_alt_m: float,
    max_alt_m: float,
    speed_stats: Dict[str, float],
    heatmap_gradient: Dict[float, str],
    available_years: List[int],
    output_dir: str,
) -> str:
    """
    Export metadata and statistics to JSON file.

    Args:
        stats: Statistics dictionary
        min_alt_m: Minimum altitude in meters
        max_alt_m: Maximum altitude in meters
        speed_stats: Speed statistics dictionary
        heatmap_gradient: Heatmap color gradient
        available_years: List of available years
        output_dir: Output directory path

    Returns:
        Path to exported file
    """
    meta_data = {
        "stats": stats,
        "min_alt_m": min_alt_m,
        "max_alt_m": max_alt_m,
        "min_groundspeed_knots": round(speed_stats["min"], 1)
        if speed_stats["min"] != float("inf")
        else 0,
        "max_groundspeed_knots": round(speed_stats["max"], 1),
        "gradient": heatmap_gradient,
        "available_years": available_years,
    }

    meta_file = os.path.join(output_dir, "metadata.json")
    with open(meta_file, "w") as f:
        json.dump(meta_data, f, separators=(",", ":"), sort_keys=True)

    logger.info(f"  ✓ Metadata: {os.path.getsize(meta_file) / 1024:.1f} KB")
    return meta_file
