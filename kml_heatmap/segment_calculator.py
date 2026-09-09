"""Segment calculation for path data with groundspeed and altitude analysis.

Groundspeed uses a two-pass approach: instantaneous speeds for all segments,
then rolling window averages for smoothing. The windowing system uses binary
search on sorted timestamps for O(log n) lookups. Timestamps are Unix epoch
seconds that were parsed once by the KML parser.
"""

from bisect import bisect_left, bisect_right
from dataclasses import dataclass
from itertools import pairwise
from typing import TYPE_CHECKING

from .constants import (
    KM_TO_NAUTICAL_MILES,
    MAX_GROUNDSPEED_KNOTS,
    MIN_SEGMENT_TIME_SECONDS,
    SECONDS_PER_HOUR,
    SPEED_WINDOW_SECONDS,
)
from .geometry import haversine_distance

if TYPE_CHECKING:
    from .types import FlightPath

__all__ = [
    "SegmentSpeed",
    "build_time_indexed_segments",
    "calculate_fallback_groundspeed",
    "calculate_path_distance",
    "calculate_windowed_groundspeed",
    "extract_segment_speeds",
]


@dataclass(slots=True)
class SegmentSpeed:
    """Instantaneous speed information for one path segment."""

    index: int
    timestamp: float | None
    relative_time: float | None
    speed: float
    distance: float
    time_delta: float


def calculate_path_distance(path: FlightPath) -> float:
    """Calculate total distance along a path in kilometers."""
    if len(path) < 2:
        return 0.0

    return sum(
        haversine_distance(p1.lat, p1.lon, p2.lat, p2.lon) for p1, p2 in pairwise(path)
    )


def extract_segment_speeds(
    path: FlightPath, path_start_time: float | None
) -> list[SegmentSpeed]:
    """Calculate instantaneous speeds for all segments in a path."""
    segment_speeds: list[SegmentSpeed] = []

    for i, (p1, p2) in enumerate(pairwise(path)):
        segment_distance_km = haversine_distance(p1.lat, p1.lon, p2.lat, p2.lon)

        instant_speed = 0.0
        timestamp = None
        time_delta = 0.0
        relative_time = None

        if p1.ts is not None and p2.ts is not None:
            time_delta = p2.ts - p1.ts
            timestamp = p1.ts

            if path_start_time is not None:
                relative_time = p1.ts - path_start_time

            if time_delta >= MIN_SEGMENT_TIME_SECONDS:
                segment_distance_nm = segment_distance_km * KM_TO_NAUTICAL_MILES
                instant_speed = (segment_distance_nm / time_delta) * SECONDS_PER_HOUR

                if instant_speed > MAX_GROUNDSPEED_KNOTS:
                    instant_speed = 0.0  # Ignore unrealistic speeds

        segment_speeds.append(
            SegmentSpeed(
                index=i,
                timestamp=timestamp,
                relative_time=relative_time,
                speed=instant_speed,
                distance=segment_distance_km,
                time_delta=time_delta,
            )
        )

    return segment_speeds


def build_time_indexed_segments(
    segment_speeds: list[SegmentSpeed],
) -> tuple[list[float], list[SegmentSpeed]]:
    """Build time-sorted lists for efficient window queries."""
    timed = sorted(
        (seg for seg in segment_speeds if seg.timestamp is not None and seg.speed != 0),
        key=lambda seg: seg.timestamp or 0.0,
    )
    timestamp_list = [seg.timestamp for seg in timed if seg.timestamp is not None]
    return timestamp_list, timed


def calculate_windowed_groundspeed(
    current_timestamp: float,
    timestamp_list: list[float],
    time_indexed_segments: list[SegmentSpeed],
) -> tuple[float, float, float]:
    """Calculate rolling average groundspeed using a time window.

    Returns:
        Tuple of (groundspeed_knots, window_distance_km, window_time_seconds)
    """
    if not timestamp_list:
        return 0.0, 0.0, 0.0

    window_distance = 0.0
    window_time = 0.0
    half_window = SPEED_WINDOW_SECONDS / 2

    start_idx = bisect_left(timestamp_list, current_timestamp - half_window)
    end_idx = bisect_right(timestamp_list, current_timestamp + half_window)

    for j in range(start_idx, end_idx):
        seg = time_indexed_segments[j]
        window_distance += seg.distance
        window_time += seg.time_delta

    if window_time >= MIN_SEGMENT_TIME_SECONDS:
        window_distance_nm = window_distance * KM_TO_NAUTICAL_MILES
        groundspeed_knots = (window_distance_nm / window_time) * SECONDS_PER_HOUR

        if groundspeed_knots > MAX_GROUNDSPEED_KNOTS:
            return 0.0, 0.0, 0.0

        return groundspeed_knots, window_distance, window_time

    return 0.0, 0.0, 0.0


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
    calculated_speed = (segment_distance_nm / segment_time_seconds) * SECONDS_PER_HOUR

    if 0 < calculated_speed <= MAX_GROUNDSPEED_KNOTS:
        return calculated_speed

    return 0.0
