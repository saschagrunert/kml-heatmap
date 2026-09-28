"""Geometric calculations and coordinate manipulations."""

from math import atan2, cos, degrees, radians, sin, sqrt

__all__ = [
    "EARTH_RADIUS_KM",
    "haversine_distance",
    "longitude_difference",
    "true_bearing",
]

EARTH_RADIUS_KM = 6371


def haversine_distance(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Calculate great circle distance in kilometers between two points."""
    lat1, lon1, lat2, lon2 = map(radians, [lat1, lon1, lat2, lon2])
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    a = sin(dlat / 2) ** 2 + cos(lat1) * cos(lat2) * sin(dlon / 2) ** 2
    a = min(1.0, max(0.0, a))
    c = 2 * atan2(sqrt(a), sqrt(1 - a))
    return EARTH_RADIUS_KM * c


def longitude_difference(lon0: float, lon1: float) -> float:
    """``lon1 - lon0`` the short way round, from -180 to 180 degrees."""
    return (lon1 - lon0 + 180) % 360 - 180


def true_bearing(lat0: float, lon0: float, lat1: float, lon1: float) -> float:
    """True bearing from the first point to the second, in degrees.

    On a plane, which is close enough for points a few kilometres apart (the
    ends of a runway, the last half minute of an approach), and the short
    way round across the antimeridian.
    """
    dx = longitude_difference(lon0, lon1) * cos(radians((lat0 + lat1) / 2))
    return degrees(atan2(dx, lat1 - lat0)) % 360
