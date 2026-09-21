"""Per-path export helpers: path info entries and segment rows."""

from itertools import pairwise
from typing import TYPE_CHECKING

from .airports import route_airports
from .constants import METERS_TO_FEET
from .helpers import calculate_duration_seconds
from .logger import logger
from .segment_calculator import (
    SegmentSpeed,
    SpeedWindow,
    calculate_fallback_groundspeed,
    extract_segment_speeds,
)
from .types import COORDINATE_DECIMALS

if TYPE_CHECKING:
    from collections.abc import Collection

    from .types import FlightPath, PathInfo, PathMetadata, SegmentRow


def path_duration(metadata: PathMetadata) -> float:
    """The duration of a path in seconds, from the metadata timestamps.

    0 when the metadata carries no usable start and end timestamp.
    """
    path_duration_seconds = 0.0
    start_ts = metadata.get("timestamp")
    end_ts = metadata.get("end_timestamp")

    if start_ts and end_ts:
        path_duration_seconds = calculate_duration_seconds(start_ts, end_ts)
        if path_duration_seconds == 0:
            logger.debug("  Could not parse timestamps '%s' -> '%s'", start_ts, end_ts)

    return path_duration_seconds


def build_path_info(
    path: FlightPath,
    metadata: PathMetadata,
    path_id: int,
    year: int,
    airport_names: Collection[str] | None = None,
) -> PathInfo:
    """Build the path info entry of an exported path.

    Keys without a value are omitted from the entry.

    ``airport_names`` are the names of the exported airport markers. An end
    of a path counts as an airport if and only if it has a marker: the
    frontend counts the airports of the path info in its statistics and
    shows the markers of the names it finds there, so a name without a
    marker ("Home", "Aunt Martha" when the path never landed there) would
    count as an airport nobody can see. The marker rules are those of
    ``airports.deduplicate_airports`` and ``airports.extract_airport_name``:
    a name holding an ICAO code or of more than one word, at a real start
    or landing. None keeps every name (for callers without airports).
    """
    # The names match the airport markers of airports.json exactly
    start_airport, end_airport = route_airports(metadata)
    if airport_names is not None:
        start_airport = start_airport if start_airport in airport_names else None
        end_airport = end_airport if end_airport in airport_names else None

    info: PathInfo = {"id": path_id, "year": year}

    # Segment altitudes are rounded to 100 ft for rendering, so the exact
    # range is carried per path to keep the frontend statistics accurate
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
    window: SpeedWindow,
    path_distance_km: float,
    path_duration_seconds: float,
) -> float | None:
    """The groundspeed of a single segment in knots, None when unknown.

    The rolling window average where the segment is timed, the path's
    average speed otherwise.
    """
    if segment.timestamp is not None:
        groundspeed_knots = window.groundspeed(segment.timestamp)
        if groundspeed_knots is not None:
            return groundspeed_knots
    return calculate_fallback_groundspeed(
        segment.distance, path_distance_km, path_duration_seconds
    )


def process_path_segments(
    path: FlightPath,
    path_duration_seconds: float,
) -> tuple[list[float], list[SegmentRow]]:
    """Build the exported segment rows of a path.

    Coordinates are rounded to ``COORDINATE_DECIMALS`` (~1 m), and only the
    segments that are zero-length at that precision are skipped: standing
    still, including GPS jitter below the precision. Because their two
    exported endpoints are the same coordinate, dropping them keeps the
    remaining rows geometrically contiguous: every row continues where the
    previous one ended. Each row therefore stores only its END point, and the
    start of the first row is returned separately.

    The groundspeeds use the unrounded geometry, which is about the aircraft
    rather than about the export. A groundspeed that is unknown (no timing,
    or only implausible values) is exported as 0, which the frontend reads
    as "no speed" rather than as standing still.

    Returns:
        Tuple of (start point, segment rows). The start point is empty when
        the path has no exported rows.
    """
    path_start_time = next((point.ts for point in path if point.ts is not None), None)

    segment_speeds = extract_segment_speeds(path, path_start_time)
    window = SpeedWindow(segment_speeds)
    path_distance_km = sum(segment.distance for segment in segment_speeds)

    start: list[float] = []
    rows: list[SegmentRow] = []
    altitude_ft: float = 0.0
    # The rounded start of the current segment, which is also the end of the
    # last exported row: a skipped segment starts and ends on it
    previous: tuple[float, float] | None = None

    for segment, (p1, p2) in zip(segment_speeds, pairwise(path), strict=True):
        if previous is None:
            previous = (
                round(p1.lat, COORDINATE_DECIMALS),
                round(p1.lon, COORDINATE_DECIMALS),
            )
        end = (
            round(p2.lat, COORDINATE_DECIMALS),
            round(p2.lon, COORDINATE_DECIMALS),
        )
        if end == previous:
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
            segment, window, path_distance_km, path_duration_seconds
        )

        if not rows:
            start = [previous[0], previous[1]]

        row: SegmentRow = [
            end[0],
            end[1],
            altitude_ft,
            round(groundspeed_knots, 1) if groundspeed_knots is not None else 0.0,
        ]
        if segment.relative_time is not None:
            row.append(round(segment.relative_time, 1))

        rows.append(row)
        previous = end

    return start, rows
