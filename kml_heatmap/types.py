"""Type definitions for KML Heatmap."""

from typing import NamedTuple, NotRequired, TypedDict


class TrackPoint(NamedTuple):
    """A single parsed track point.

    ``alt`` is the altitude in meters (``None`` when the source had no usable
    altitude) and ``ts`` is the point's timestamp as Unix epoch seconds in UTC
    (``None`` when unavailable).

    Flight paths (the ``FlightPath`` entries of a ``FlightPathGroup``) only
    contain points with a known altitude. The flat ``coordinates`` list
    returned by the parser may also contain points without one.
    """

    lat: float
    lon: float
    alt: float | None = None
    ts: float | None = None


FlightPath = list[TrackPoint]

FlightPathGroup = list[FlightPath]

# Exported segment row: [lat, lon, altitude_ft, groundspeed_knots] followed by
# an optional relative time in seconds (omitted when unavailable). ``lat``/``lon``
# are the segment's END point; its start is the end of the previous row, and
# the first row continues from ``PathSegments.start``.
SegmentRow = list[float]

# Number of decimals kept for exported coordinates (~1 m at the equator)
COORDINATE_DECIMALS = 5


class PathSegments(TypedDict):
    """Exported segments of one path: a start point and the rows after it."""

    start: list[float]
    rows: list[SegmentRow]


class PlacemarkMetadata(TypedDict):
    """Metadata extracted from a KML Placemark element.

    ``airport_name`` is the display name; for a route ``start_airport`` and
    ``end_airport`` hold its two airports (both None otherwise).
    """

    airport_name: str | None
    start_airport: str | None
    end_airport: str | None
    timestamp: str | None
    end_timestamp: str | None
    year: int | None


class PathMetadata(TypedDict):
    """Metadata for a flight path.

    The parser always sets ``start_airport`` and ``end_airport``: the two
    airports of a route, or None when the name is not one. Metadata without
    these keys only comes from code that builds it by hand.
    """

    start_point: list[float]
    airport_name: str
    year: NotRequired[int | None]
    aircraft_registration: NotRequired[str | None]
    aircraft_type: NotRequired[str | None]
    start_airport: NotRequired[str | None]
    end_airport: NotRequired[str | None]
    timestamp: NotRequired[str | None]
    end_timestamp: NotRequired[str | None]
    filename: NotRequired[str | None]


class PathInfo(TypedDict):
    """Information about a complete flight path (keys with no value are omitted)."""

    id: int
    year: NotRequired[int]
    aircraft_registration: NotRequired[str]
    aircraft_type: NotRequired[str]
    start_airport: NotRequired[str]
    end_airport: NotRequired[str]
    min_altitude_ft: NotRequired[float]
    max_altitude_ft: NotRequired[float]


class AirportData(TypedDict):
    """Airport location and metadata."""

    name: str | None
    lat: float
    lon: float
    path_index: NotRequired[int]
    is_at_path_end: NotRequired[bool]


__all__ = [
    "COORDINATE_DECIMALS",
    "AirportData",
    "FlightPath",
    "FlightPathGroup",
    "PathInfo",
    "PathMetadata",
    "PathSegments",
    "PlacemarkMetadata",
    "SegmentRow",
    "TrackPoint",
]
