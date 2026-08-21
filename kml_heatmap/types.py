"""Type definitions for KML Heatmap."""

from typing import NotRequired, TypedDict

FlightPath = list[list[float]]

FlightPathGroup = list[FlightPath]


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


class PathSegment(TypedDict):
    """Represents a segment of a flight path with computed properties."""

    path_id: int
    coords: FlightPath
    altitude_ft: NotRequired[float | None]
    altitude_m: NotRequired[float | None]
    groundspeed_knots: NotRequired[float | None]
    time: NotRequired[float | None]


class PathInfo(TypedDict):
    """Information about a complete flight path."""

    id: int
    year: NotRequired[int | None]
    aircraft_registration: NotRequired[str | None]
    aircraft_type: NotRequired[str | None]
    start_airport: NotRequired[str | None]
    end_airport: NotRequired[str | None]
    route: NotRequired[str | None]
    start_coords: NotRequired[list[float]]
    end_coords: NotRequired[list[float]]
    segment_count: NotRequired[int]


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
    most_common_cruise_altitude_ft: NotRequired[float]
    most_common_cruise_altitude_m: NotRequired[float]
    longest_flight_nm: NotRequired[float]
    longest_flight_km: NotRequired[float]
    num_airports: NotRequired[int]
    airport_names: NotRequired[list[str]]
    num_aircraft: NotRequired[int]
    aircraft_types: NotRequired[list[str]]
    aircraft_list: NotRequired[list[AircraftInfo]]


class CacheEntry(TypedDict):
    """Cache entry for parsed KML data."""

    coordinates: FlightPath
    path_groups: FlightPathGroup
    path_metadata: list[PathMetadata]
    mtime: float
    version: str


__all__ = [
    "AircraftInfo",
    "AirportData",
    "CacheEntry",
    "FlightPath",
    "FlightPathGroup",
    "PathInfo",
    "PathMetadata",
    "PathSegment",
    "Statistics",
]
