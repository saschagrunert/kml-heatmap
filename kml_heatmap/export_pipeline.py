"""Per-path export helpers: path info entries and segment rows."""

from itertools import pairwise
from typing import TYPE_CHECKING

from .constants import METERS_TO_FEET
from .helpers import calculate_duration_seconds
from .logger import logger
from .segment_calculator import (
    SegmentSpeed,
    build_time_indexed_segments,
    calculate_fallback_groundspeed,
    calculate_path_distance,
    calculate_windowed_groundspeed,
    extract_segment_speeds,
)

if TYPE_CHECKING:
    from .types import FlightPath, PathInfo, PathMetadata, SegmentRow


def _build_path_info(
    path: FlightPath,
    metadata: PathMetadata,
    path_id: int,
    year: int,
) -> tuple[PathInfo, float, float]:
    """Build the path info entry and compute path metrics.

    Keys without a value are omitted from the entry.

    Returns:
        Tuple of (info, path_duration_seconds, path_distance_km)
    """
    airport_name = metadata.get("airport_name") or ""
    start_airport = None
    end_airport = None

    if " - " in airport_name:
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
            logger.debug("  Could not parse timestamps '%s' -> '%s'", start_ts, end_ts)

    path_distance_km = calculate_path_distance(path)

    info: PathInfo = {
        "id": path_id,
        "year": year,
        "start_coords": [path[0].lat, path[0].lon],
        "end_coords": [path[-1].lat, path[-1].lon],
        "segment_count": len(path) - 1,
    }

    # Segment altitudes are rounded to 100 ft for rendering, so the exact
    # range is carried per path to keep the statistics accurate
    altitudes_m = [point.alt for point in path if point.alt is not None]
    if altitudes_m:
        info["min_altitude_ft"] = round(min(altitudes_m) * METERS_TO_FEET, 1)
        info["max_altitude_ft"] = round(max(altitudes_m) * METERS_TO_FEET, 1)
    if start_airport:
        info["start_airport"] = start_airport
    if end_airport:
        info["end_airport"] = end_airport

    registration = metadata.get("aircraft_registration")
    if registration:
        info["aircraft_registration"] = registration
    aircraft_type = metadata.get("aircraft_type")
    if aircraft_type:
        info["aircraft_type"] = aircraft_type

    return info, path_duration_seconds, path_distance_km


def _segment_groundspeed(
    segment: SegmentSpeed,
    timestamp_list: list[float],
    time_indexed_segments: list[SegmentSpeed],
    path_distance_km: float,
    path_duration_seconds: float,
) -> float:
    """Calculate the groundspeed of a single segment in knots."""
    groundspeed_knots = 0.0
    if segment.timestamp is not None and timestamp_list:
        groundspeed_knots, _, _ = calculate_windowed_groundspeed(
            segment.timestamp, timestamp_list, time_indexed_segments
        )

    if groundspeed_knots == 0:
        groundspeed_knots = calculate_fallback_groundspeed(
            segment.distance, path_distance_km, path_duration_seconds
        )

    return groundspeed_knots


def _process_path_segments(
    path: FlightPath,
    path_distance_km: float,
    path_duration_seconds: float,
) -> tuple[list[SegmentRow], list[float]]:
    """Build the exported segment rows of a path.

    Zero-length segments are skipped, as are segments without any altitude.

    Returns:
        Tuple of (segment rows, segment distances in km)
    """
    path_start_time = next((point.ts for point in path if point.ts is not None), None)

    segment_speeds = extract_segment_speeds(path, path_start_time)
    timestamp_list, time_indexed_segments = build_time_indexed_segments(segment_speeds)

    rows: list[SegmentRow] = []
    distances: list[float] = []

    for segment, (p1, p2) in zip(segment_speeds, pairwise(path), strict=True):
        if p1.lat == p2.lat and p1.lon == p2.lon:
            continue

        altitudes = [alt for alt in (p1.alt, p2.alt) if alt is not None]
        if not altitudes:
            logger.debug("Skipping segment without altitude at index %d", segment.index)
            continue

        avg_alt_m = sum(altitudes) / len(altitudes)
        altitude_ft = round(avg_alt_m * METERS_TO_FEET / 100) * 100

        groundspeed_knots = _segment_groundspeed(
            segment,
            timestamp_list,
            time_indexed_segments,
            path_distance_km,
            path_duration_seconds,
        )

        row: SegmentRow = [
            p1.lat,
            p1.lon,
            p2.lat,
            p2.lon,
            altitude_ft,
            round(groundspeed_knots, 1),
        ]
        if segment.relative_time is not None:
            row.append(round(segment.relative_time, 1))

        rows.append(row)
        distances.append(segment.distance)

    return rows, distances
