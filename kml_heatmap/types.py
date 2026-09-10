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

# Exported segment row: [lat1, lon1, lat2, lon2, altitude_ft, groundspeed_knots]
# followed by an optional relative time in seconds (omitted when unavailable).
SegmentRow = list[float]


class PlacemarkMetadata(TypedDict):
    """Metadata extracted from a KML Placemark element."""

    airport_name: str | None
    timestamp: str | None
    end_timestamp: str | None
    year: int | None


class PathMetadata(TypedDict):
    """Metadata for a flight path."""

    start_point: list[float]
    airport_name: str
    year: NotRequired[int | None]
    aircraft_registration: NotRequired[str | None]
    aircraft_type: NotRequired[str | None]
    start_airport: NotRequired[str | None]
    end_airport: NotRequired[str | None]
    route: NotRequired[str | None]
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
    start_coords: NotRequired[list[float]]
    end_coords: NotRequired[list[float]]
    segment_count: NotRequired[int]
    min_altitude_ft: NotRequired[float]
    max_altitude_ft: NotRequired[float]


class AirportData(TypedDict):
    """Airport location and metadata."""

    name: str | None
    lat: float
    lon: float
    flight_count: NotRequired[int]
    path_index: NotRequired[int]
    timestamps: NotRequired[list[str]]
    is_at_path_end: NotRequired[bool]


class AircraftInfo(TypedDict):
    """Aircraft statistics entry."""

    registration: str
    type: str | None
    model: str | None
    flights: int
    flight_time_seconds: float
    flight_time_str: str
    flight_distance_km: float


class Statistics(TypedDict):
    """Flight statistics."""

    total_distance_km: float
    total_distance_nm: float
    total_points: int
    num_paths: int
    min_altitude_m: float | None
    max_altitude_m: float | None
    min_altitude_ft: float | None
    max_altitude_ft: float | None
    total_altitude_gain_m: NotRequired[float]
    total_altitude_gain_ft: NotRequired[float]
    total_flight_time_seconds: NotRequired[float]
    total_flight_time_str: NotRequired[str | None]
    avg_groundspeed_knots: NotRequired[float]
    max_groundspeed_knots: NotRequired[float]
    cruise_speed_knots: NotRequired[float]
    most_common_cruise_altitude_ft: NotRequired[float | None]
    most_common_cruise_altitude_m: NotRequired[float | None]
    longest_flight_nm: NotRequired[float]
    longest_flight_km: NotRequired[float]
    num_airports: NotRequired[int]
    airport_names: NotRequired[list[str]]
    num_aircraft: NotRequired[int]
    aircraft_types: NotRequired[list[str]]
    aircraft_list: NotRequired[list[AircraftInfo]]


__all__ = [
    "AircraftInfo",
    "AirportData",
    "FlightPath",
    "FlightPathGroup",
    "PathInfo",
    "PathMetadata",
    "PlacemarkMetadata",
    "SegmentRow",
    "Statistics",
    "TrackPoint",
]
