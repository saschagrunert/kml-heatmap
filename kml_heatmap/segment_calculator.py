"""Segment calculation for path data with groundspeed and altitude analysis.

Groundspeed uses a two-pass approach: instantaneous speeds for all segments,
then rolling window averages for smoothing. The windowing system uses binary
search on sorted timestamps for O(log n) lookups.
"""

from typing import Any
from datetime import datetime
from bisect import bisect_left, bisect_right

from .geometry import haversine_distance
from .helpers import parse_iso_timestamp
from .constants import (
    KM_TO_NAUTICAL_MILES,
    MAX_GROUNDSPEED_KNOTS,
    MIN_SEGMENT_TIME_SECONDS,
    SPEED_WINDOW_SECONDS,
    CRUISE_ALTITUDE_THRESHOLD_FT,
    ALTITUDE_BIN_SIZE_FT,
)


class SegmentData:
    """Container for segment calculation results."""

    def __init__(self) -> None:
        """Initialize segment data with default values."""
        self.segments: list[dict[str, Any]] = []
        self.max_groundspeed_knots: float = 0.0
        self.min_groundspeed_knots: float = float("inf")
        self.cruise_speed_total_distance: float = 0.0
        self.cruise_speed_total_time: float = 0.0
        self.cruise_altitude_histogram: dict[int, float] = {}
        self.max_path_distance_nm: float = 0.0


def calculate_path_distance(path: list[list[float]]) -> float:
    """Calculate total distance along a path in kilometers."""
    if len(path) < 2:
        return 0.0

    distance_km = 0.0
    for i in range(len(path) - 1):
        lat1, lon1 = path[i][0], path[i][1]
        lat2, lon2 = path[i + 1][0], path[i + 1][1]
        distance_km += haversine_distance(lat1, lon1, lat2, lon2)

    return distance_km


def extract_segment_speeds(
    path: list[list[float | str]], path_start_time: datetime | None
) -> list[dict[str, Any]]:
    """Calculate instantaneous speeds for all segments in a path."""
    segment_speeds = []

    for i in range(len(path) - 1):
        coord1 = path[i]
        coord2 = path[i + 1]

        lat1, lon1 = float(coord1[0]), float(coord1[1])
        lat2, lon2 = float(coord2[0]), float(coord2[1])
        segment_distance_km = haversine_distance(lat1, lon1, lat2, lon2)

        instant_speed = 0.0
        timestamp = None
        time_delta = 0.0
        relative_time = None

        if len(coord1) >= 4 and len(coord2) >= 4:
            ts1 = coord1[3]
            ts2 = coord2[3]
            if isinstance(ts1, str) and isinstance(ts2, str):
                dt1 = parse_iso_timestamp(ts1)
                dt2 = parse_iso_timestamp(ts2)
            else:
                dt1 = None
                dt2 = None

            if dt1 and dt2:
                time_delta = (dt2 - dt1).total_seconds()
                timestamp = dt1

                if path_start_time:
                    relative_time = (dt1 - path_start_time).total_seconds()

                if time_delta >= MIN_SEGMENT_TIME_SECONDS:
                    segment_distance_nm = segment_distance_km * KM_TO_NAUTICAL_MILES
                    instant_speed = (segment_distance_nm / time_delta) * 3600

                    if instant_speed > MAX_GROUNDSPEED_KNOTS:
                        instant_speed = 0.0  # Ignore unrealistic speeds

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

    return segment_speeds


def build_time_indexed_segments(
    segment_speeds: list[dict[str, Any]],
) -> tuple[list[float], list[dict[str, Any]]]:
    """Build time-sorted lists for efficient window queries."""
    time_indexed_segments = []
    timestamp_list = []

    for seg in segment_speeds:
        if seg["timestamp"] is not None and seg["speed"] != 0:
            ts = seg["timestamp"].timestamp()
            timestamp_list.append(ts)
            time_indexed_segments.append(seg)

    if timestamp_list:
        sorted_pairs = sorted(
            zip(timestamp_list, time_indexed_segments), key=lambda x: x[0]
        )
        unzipped = list(zip(*sorted_pairs))
        timestamp_list = list(unzipped[0])
        time_indexed_segments = list(unzipped[1])

    return timestamp_list, time_indexed_segments


def calculate_windowed_groundspeed(
    current_timestamp: datetime,
    timestamp_list: list[float],
    time_indexed_segments: list[dict[str, Any]],
) -> float:
    """Calculate rolling average groundspeed using a time window."""
    if not timestamp_list:
        return 0.0

    window_distance = 0.0
    window_time = 0.0
    current_ts = current_timestamp.timestamp()
    half_window = SPEED_WINDOW_SECONDS / 2

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
            return 0.0

        return groundspeed_knots

    return 0.0


def calculate_fallback_groundspeed(
    segment_distance_km: float, path_distance_km: float, path_duration_seconds: float
) -> float:
    """Calculate groundspeed from path averages when timestamps are unavailable."""
    if path_duration_seconds <= 0 or path_distance_km <= 0:
        return 0.0

    segment_time_seconds = (
        segment_distance_km / path_distance_km
    ) * path_duration_seconds

    if segment_time_seconds < MIN_SEGMENT_TIME_SECONDS:
        return 0.0

    segment_distance_nm = segment_distance_km * KM_TO_NAUTICAL_MILES
    calculated_speed = (segment_distance_nm / segment_time_seconds) * 3600

    if 0 < calculated_speed <= MAX_GROUNDSPEED_KNOTS:
        return calculated_speed

    return 0.0


def update_cruise_statistics(
    altitude_agl_ft: float,
    window_time: float,
    window_distance: float,
    cruise_stats: dict[str, Any],
) -> None:
    """Update cruise speed and altitude statistics."""
    if altitude_agl_ft <= CRUISE_ALTITUDE_THRESHOLD_FT:
        return

    if window_time < MIN_SEGMENT_TIME_SECONDS:
        return

    # Update cruise speed totals
    cruise_stats["total_distance"] += window_distance * KM_TO_NAUTICAL_MILES
    cruise_stats["total_time"] += window_time

    # Update altitude histogram
    altitude_bin_ft = int(altitude_agl_ft / ALTITUDE_BIN_SIZE_FT) * ALTITUDE_BIN_SIZE_FT

    if altitude_bin_ft not in cruise_stats["altitude_histogram"]:
        cruise_stats["altitude_histogram"][altitude_bin_ft] = 0

    cruise_stats["altitude_histogram"][altitude_bin_ft] += window_time
