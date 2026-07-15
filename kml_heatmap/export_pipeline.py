"""Year-based data processing helpers."""

from bisect import bisect_left, bisect_right
from typing import Any

from .constants import (
    KM_TO_NAUTICAL_MILES,
    METERS_TO_FEET,
    SPEED_WINDOW_SECONDS,
    CRUISE_ALTITUDE_THRESHOLD_FT,
)
from .geometry import haversine_distance
from .helpers import parse_iso_timestamp, calculate_duration_seconds
from .logger import logger
from .segment_calculator import (
    extract_segment_speeds,
    build_time_indexed_segments,
    calculate_windowed_groundspeed,
    calculate_fallback_groundspeed,
    calculate_path_distance,
    update_cruise_statistics,
)
from .types import PathInfo, PathMetadata, PathSegment


def _build_path_info(
    path: list[list[Any]],
    metadata: PathMetadata,
    local_idx: int,
    path_year: Any,
) -> tuple[PathInfo, float, float, float]:
    """Build path info entry and compute path metrics.

    Returns:
        Tuple of (info_dict, path_duration_seconds, path_distance_km, path_distance_nm)
    """
    airport_name = metadata.get("airport_name", "")
    start_airport = None
    end_airport = None

    if airport_name and " - " in airport_name:
        parts = airport_name.split(" - ")
        if len(parts) == 2:
            start_airport = parts[0].strip()
            end_airport = parts[1].strip()

    path_duration_seconds = 0.0
    start_ts = metadata.get("timestamp")
    end_ts = metadata.get("end_timestamp")

    if start_ts and end_ts:
        path_duration_seconds = calculate_duration_seconds(start_ts, end_ts)
        if path_duration_seconds == 0:
            logger.debug(f"  Could not parse timestamps '{start_ts}' -> '{end_ts}'")

    path_distance_km = calculate_path_distance(path)
    path_distance_nm = path_distance_km * KM_TO_NAUTICAL_MILES

    info: PathInfo = {
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

    return info, path_duration_seconds, path_distance_km, path_distance_nm


def _calculate_segment_groundspeed(
    i: int,
    segment_speeds: list[dict[str, Any]],
    timestamp_list: list[float],
    time_indexed_segments: list[dict[str, Any]],
    path_distance_km: float,
    path_duration_seconds: float,
    lat1: float,
    lon1: float,
    lat2: float,
    lon2: float,
) -> float:
    """Calculate groundspeed for a single segment."""
    current_segment = segment_speeds[i]
    current_timestamp = current_segment["timestamp"]

    groundspeed_knots = 0.0
    if current_timestamp is not None and timestamp_list:
        groundspeed_knots = calculate_windowed_groundspeed(
            current_timestamp, timestamp_list, time_indexed_segments
        )

    if groundspeed_knots == 0:
        segment_distance_km = haversine_distance(lat1, lon1, lat2, lon2)
        groundspeed_knots = calculate_fallback_groundspeed(
            segment_distance_km, path_distance_km, path_duration_seconds
        )

    return groundspeed_knots


def _accumulate_cruise_stats(
    current_timestamp: Any,
    timestamp_list: list[float],
    time_indexed_segments: list[dict[str, Any]],
    altitude_agl_ft: float,
) -> tuple[float, float, dict[int, float]]:
    """Accumulate cruise statistics for a single segment.

    Returns:
        Tuple of (cruise_distance, cruise_time, altitude_histogram)
    """
    if current_timestamp is not None and timestamp_list:
        current_ts = current_timestamp.timestamp()
        half_window = SPEED_WINDOW_SECONDS / 2
        w_start = bisect_left(timestamp_list, current_ts - half_window)
        w_end = bisect_right(timestamp_list, current_ts + half_window)
        w_distance = sum(
            time_indexed_segments[j]["distance"] for j in range(w_start, w_end)
        )
        w_time = sum(
            time_indexed_segments[j]["time_delta"] for j in range(w_start, w_end)
        )
    else:
        w_distance = 0.0
        w_time = 0.0

    cruise_stats: dict[str, Any] = {
        "total_distance": 0.0,
        "total_time": 0.0,
        "altitude_histogram": {},
    }
    update_cruise_statistics(altitude_agl_ft, w_time, w_distance, cruise_stats)
    return (
        float(cruise_stats["total_distance"]),
        float(cruise_stats["total_time"]),
        cruise_stats["altitude_histogram"],
    )


def _process_path_segments(
    path: list[list[Any]],
    local_idx: int,
    path_distance_km: float,
    path_duration_seconds: float,
) -> tuple[list[PathSegment], float, float, float, float, dict[int, float]]:
    """Process path segments calculating groundspeed and cruise statistics.

    Returns:
        Tuple of (segments, max_groundspeed, min_groundspeed,
                  cruise_distance, cruise_time, cruise_altitude_histogram)
    """
    segments: list[PathSegment] = []
    max_groundspeed = 0.0
    min_groundspeed = float("inf")
    cruise_distance = 0.0
    cruise_time = 0.0
    cruise_altitude_histogram: dict[int, float] = {}

    ground_level_m = min(coord[2] for coord in path) if path else 0

    path_start_time = None
    for coord in path:
        if len(coord) >= 4:
            path_start_time = parse_iso_timestamp(coord[3])
            if path_start_time:
                break

    segment_speeds = extract_segment_speeds(path, path_start_time)
    timestamp_list, time_indexed_segments = build_time_indexed_segments(segment_speeds)

    for i in range(len(path) - 1):
        coord1 = path[i]
        coord2 = path[i + 1]
        lat1, lon1, alt1_m = coord1[0], coord1[1], coord1[2]
        lat2, lon2, alt2_m = coord2[0], coord2[1], coord2[2]

        avg_alt_m = (alt1_m + alt2_m) / 2
        avg_alt_ft = round(avg_alt_m * METERS_TO_FEET / 100) * 100

        groundspeed_knots = _calculate_segment_groundspeed(
            i,
            segment_speeds,
            timestamp_list,
            time_indexed_segments,
            path_distance_km,
            path_duration_seconds,
            lat1,
            lon1,
            lat2,
            lon2,
        )

        if groundspeed_knots > 0:
            if groundspeed_knots > max_groundspeed:
                max_groundspeed = groundspeed_knots
            if groundspeed_knots < min_groundspeed:
                min_groundspeed = groundspeed_knots

            altitude_agl_m = avg_alt_m - ground_level_m
            altitude_agl_ft = altitude_agl_m * METERS_TO_FEET
            if altitude_agl_ft > CRUISE_ALTITUDE_THRESHOLD_FT:
                current_timestamp = segment_speeds[i]["timestamp"]
                seg_cruise_dist, seg_cruise_time, seg_hist = _accumulate_cruise_stats(
                    current_timestamp,
                    timestamp_list,
                    time_indexed_segments,
                    altitude_agl_ft,
                )
                cruise_distance += seg_cruise_dist
                cruise_time += seg_cruise_time
                for alt_bin, time_spent in seg_hist.items():
                    if alt_bin not in cruise_altitude_histogram:
                        cruise_altitude_histogram[alt_bin] = 0.0
                    cruise_altitude_histogram[alt_bin] += time_spent

        if lat1 != lat2 or lon1 != lon2:
            current_segment = segment_speeds[i]
            current_relative_time = current_segment["relative_time"]
            segment_data: PathSegment = {
                "coords": [[lat1, lon1], [lat2, lon2]],
                "altitude_ft": avg_alt_ft,
                "altitude_m": round(avg_alt_m, 0),
                "groundspeed_knots": round(groundspeed_knots, 1),
                "path_id": local_idx,
            }
            if current_relative_time is not None:
                segment_data["time"] = round(current_relative_time, 1)
            segments.append(segment_data)

    return (
        segments,
        max_groundspeed,
        min_groundspeed,
        cruise_distance,
        cruise_time,
        cruise_altitude_histogram,
    )
