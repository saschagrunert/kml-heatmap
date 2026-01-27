"""Type definitions for KML Heatmap.

This module provides TypedDict definitions for complex data structures
used throughout the application. Using TypedDict provides better type
checking and IDE autocomplete support compared to plain dictionaries.

Example:
    >>> from kml_heatmap.types import PathMetadata
    >>> metadata: PathMetadata = {
    ...     "start_point": [50.0, 8.0, 100.0],
    ...     "airport_name": "EDDF",
    ...     "year": 2025,
    ... }
"""

from typing import TypedDict, List, Optional, Any
from typing_extensions import NotRequired


class PathMetadata(TypedDict):
    """Metadata for a flight path."""

    start_point: List[float]  # [lat, lon, alt]
    airport_name: str
    year: NotRequired[Optional[int]]
    aircraft_registration: NotRequired[Optional[str]]
    aircraft_type: NotRequired[Optional[str]]
    start_airport: NotRequired[Optional[str]]
    end_airport: NotRequired[Optional[str]]
    route: NotRequired[Optional[str]]
    timestamp: NotRequired[Optional[str]]


class PathSegment(TypedDict):
    """Represents a segment of a flight path with computed properties."""

    path_id: int
    coords: List[List[float]]  # [[lat, lon], [lat, lon]]
    altitude_ft: NotRequired[Optional[float]]
    altitude_m: NotRequired[Optional[float]]
    groundspeed_knots: NotRequired[Optional[float]]
    time: NotRequired[Optional[float]]  # Unix timestamp


class PathInfo(TypedDict):
    """Information about a complete flight path."""

    id: int
    year: NotRequired[Optional[int]]
    aircraft_registration: NotRequired[Optional[str]]
    aircraft_type: NotRequired[Optional[str]]
    start_airport: NotRequired[Optional[str]]
    end_airport: NotRequired[Optional[str]]
    route: NotRequired[Optional[str]]


class AirportData(TypedDict):
    """Airport location and metadata."""

    name: str
    lat: float
    lon: float
    flight_count: NotRequired[int]
    timestamps: NotRequired[List[str]]
    is_at_path_end: NotRequired[bool]


class Statistics(TypedDict):
    """Flight statistics."""

    total_distance_km: float
    total_distance_nm: float
    total_points: int
    num_paths: int
    min_altitude_m: float
    max_altitude_m: float
    min_altitude_ft: float
    max_altitude_ft: float
    total_altitude_gain_m: NotRequired[float]
    total_altitude_gain_ft: NotRequired[float]
    total_flight_time_seconds: NotRequired[float]
    average_groundspeed_knots: NotRequired[float]
    max_groundspeed_knots: NotRequired[float]
    cruise_speed_knots: NotRequired[float]
    most_common_cruise_altitude_ft: NotRequired[float]
    most_common_cruise_altitude_m: NotRequired[float]
    longest_flight_nm: NotRequired[float]
    longest_flight_km: NotRequired[float]
    num_airports: NotRequired[int]
    airport_names: NotRequired[List[str]]
    aircraft_list: NotRequired[List[Any]]


class ResolutionConfig(TypedDict):
    """Configuration for a data resolution level."""

    factor: int
    epsilon: float
    description: str


class CacheEntry(TypedDict):
    """Cache entry for parsed KML data."""

    coordinates: List[List[float]]
    path_groups: List[List[List[float]]]
    path_metadata: List[PathMetadata]
    mtime: float
    version: str


__all__ = [
    "PathMetadata",
    "PathSegment",
    "PathInfo",
    "AirportData",
    "Statistics",
    "ResolutionConfig",
    "CacheEntry",
]
