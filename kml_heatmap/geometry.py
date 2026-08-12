"""Geometric calculations and coordinate manipulations."""

from math import radians, sin, cos, sqrt, atan2

__all__ = [
    "EARTH_RADIUS_KM",
    "haversine_distance",
    "extract_altitudes",
]

EARTH_RADIUS_KM = 6371


def extract_altitudes(paths: list[list[list[float]]]) -> list[float]:
    """Extract all altitude values from a list of paths."""
    return [coord[2] for path in paths for coord in path if len(coord) >= 3]


def haversine_distance(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Calculate great circle distance in kilometers between two points."""
    lat1, lon1, lat2, lon2 = map(radians, [lat1, lon1, lat2, lon2])
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    a = sin(dlat / 2) ** 2 + cos(lat1) * cos(lat2) * sin(dlon / 2) ** 2
    c = 2 * atan2(sqrt(a), sqrt(1 - a))
    return EARTH_RADIUS_KM * c
