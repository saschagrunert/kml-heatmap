"""Geometric calculations and coordinate manipulations."""

from math import radians, sin, cos, sqrt, atan2

__all__ = [
    "EARTH_RADIUS_KM",
    "Coordinate2D",
    "Coordinate3D",
    "haversine_distance",
    "get_altitude_color",
    "extract_altitudes",
]

EARTH_RADIUS_KM = 6371

Coordinate2D = list[float]  # [lat, lon]
Coordinate3D = list[float]  # [lat, lon, alt]


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


def get_altitude_color(altitude: float, min_alt: float, max_alt: float) -> str:
    """Get color for altitude value based on gradient from blue (low) to red (high)."""
    if max_alt == min_alt:
        return "#00AA88"

    normalized = max(0.0, min(1.0, (altitude - min_alt) / (max_alt - min_alt)))

    if normalized < 0.2:
        ratio = normalized * 5
        r, g, b = 0, int(ratio * 180), int(150 + ratio * 105)
    elif normalized < 0.4:
        ratio = (normalized - 0.2) * 5
        r, g, b = 0, int(180 + ratio * 75), int(255 - ratio * 155)
    elif normalized < 0.6:
        ratio = (normalized - 0.4) * 5
        r, g, b = int(ratio * 255), 255, int(100 - ratio * 100)
    elif normalized < 0.8:
        ratio = (normalized - 0.6) * 5
        r, g, b = 255, int(255 - ratio * 100), 0
    else:
        ratio = (normalized - 0.8) * 5
        r, g, b = 255, int(155 - ratio * 155), 0

    return f"#{r:02x}{g:02x}{b:02x}"
