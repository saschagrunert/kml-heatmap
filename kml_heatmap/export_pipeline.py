"""Per-path export helpers: path info entries and segment rows."""

from itertools import pairwise
from typing import TYPE_CHECKING

from .constants import METERS_TO_FEET
from .geometry import haversine_distance
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
from .types import COORDINATE_DECIMALS

if TYPE_CHECKING:
    from .types import FlightPath, PathInfo, PathMetadata, SegmentRow


def path_metrics(path: FlightPath, metadata: PathMetadata) -> tuple[float, float]:
    """The duration (from the metadata timestamps) and distance of a path.

    Returns:
        Tuple of (path_duration_seconds, path_distance_km); the duration is 0
        when the metadata carries no usable start and end timestamp.
    """
    path_duration_seconds = 0.0
    start_ts = metadata.get("timestamp")
    end_ts = metadata.get("end_timestamp")

    if start_ts and end_ts:
        path_duration_seconds = calculate_duration_seconds(start_ts, end_ts)
        if path_duration_seconds == 0:
            logger.debug("  Could not parse timestamps '%s' -> '%s'", start_ts, end_ts)

    return path_duration_seconds, calculate_path_distance(path)


def build_path_info(
    path: FlightPath,
    metadata: PathMetadata,
    path_id: int,
    year: int,
    segment_count: int,
) -> PathInfo:
    """Build the path info entry of an exported path.

    ``segment_count`` is the number of exported rows, which the caller knows
    once ``process_path_segments`` has dropped the zero-length segments. Keys
    without a value are omitted from the entry.
    """
    airport_name = metadata.get("airport_name") or ""
    start_airport = None
    end_airport = None

    if " - " in airport_name:
        parts = airport_name.split(" - ")
        if len(parts) == 2:
            start_airport = parts[0].strip()
            end_airport = parts[1].strip()

    info: PathInfo = {
        "id": path_id,
        "year": year,
        "start_coords": [path[0].lat, path[0].lon],
        "end_coords": [path[-1].lat, path[-1].lon],
        "segment_count": segment_count,
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

    return info


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


def process_path_segments(
    path: FlightPath,
    path_distance_km: float,
    path_duration_seconds: float,
) -> tuple[list[float], list[SegmentRow], list[float]]:
    """Build the exported segment rows of a path.

    Only zero-length segments are skipped. Because their two endpoints are the
    same coordinate, dropping them keeps the remaining rows geometrically
    contiguous: every row continues where the previous one ended. Each row
    therefore stores only its END point, and the start of the first row is
    returned separately.

    Coordinates are rounded to ``COORDINATE_DECIMALS`` (~1 m). The returned
    distances are measured between those rounded points, because the exported
    segments are the only flight data the frontend sees: it recomputes the
    distance from exactly these numbers, and the reconciled statistics have to
    agree with what it gets. The groundspeeds keep using the unrounded
    geometry, which is about the aircraft rather than about the export.

    Returns:
        Tuple of (start point, segment rows, segment distances in km).
        The start point is empty when the path has no exported rows.
    """
    path_start_time = next((point.ts for point in path if point.ts is not None), None)

    segment_speeds = extract_segment_speeds(path, path_start_time)
    timestamp_list, time_indexed_segments = build_time_indexed_segments(segment_speeds)

    start: list[float] = []
    rows: list[SegmentRow] = []
    distances: list[float] = []
    altitude_ft: float = 0.0
    previous: tuple[float, float] | None = None

    for segment, (p1, p2) in zip(segment_speeds, pairwise(path), strict=True):
        if p1.lat == p2.lat and p1.lon == p2.lon:
            continue

        altitudes = [alt for alt in (p1.alt, p2.alt) if alt is not None]
        if altitudes:
            avg_alt_m = sum(altitudes) / len(altitudes)
            altitude_ft = round(avg_alt_m * METERS_TO_FEET / 100) * 100
        else:
            # Flight paths only carry points with a known altitude (see
            # types.FlightPath), so this is unreachable in practice. Carry the
            # previous altitude over instead of skipping the segment: a skipped
            # row would break the end-to-start chain the row format relies on.
            logger.debug("Segment without altitude at index %d", segment.index)

        groundspeed_knots = _segment_groundspeed(
            segment,
            timestamp_list,
            time_indexed_segments,
            path_distance_km,
            path_duration_seconds,
        )

        if previous is None:
            previous = (
                round(p1.lat, COORDINATE_DECIMALS),
                round(p1.lon, COORDINATE_DECIMALS),
            )
            start = [previous[0], previous[1]]

        end = (
            round(p2.lat, COORDINATE_DECIMALS),
            round(p2.lon, COORDINATE_DECIMALS),
        )
        row: SegmentRow = [
            end[0],
            end[1],
            altitude_ft,
            round(groundspeed_knots, 1),
        ]
        if segment.relative_time is not None:
            row.append(round(segment.relative_time, 1))

        rows.append(row)
        distances.append(haversine_distance(previous[0], previous[1], *end))
        previous = end

    return start, rows, distances
