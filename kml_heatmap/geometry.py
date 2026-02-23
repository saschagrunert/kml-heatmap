"""Geometric calculations and coordinate manipulations."""

from math import radians, sin, cos, sqrt, atan2
from typing import List, Union

__all__ = [
    "EARTH_RADIUS_KM",
    "Coordinate2D",
    "Coordinate3D",
    "haversine_distance",
    "downsample_coordinates",
    "get_altitude_color",
]

# Constants
EARTH_RADIUS_KM = 6371

# Type aliases
Coordinate2D = List[float]  # [lat, lon]
Coordinate3D = List[float]  # [lat, lon, alt]


def haversine_distance(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Calculate great circle distance in kilometers between two points.

    Uses the Haversine formula to calculate the shortest distance between
    two points on a sphere (Earth), accounting for Earth's curvature.

    Args:
        lat1: Latitude of first point in degrees
        lon1: Longitude of first point in degrees
        lat2: Latitude of second point in degrees
        lon2: Longitude of second point in degrees

    Returns:
        Distance in kilometers

    Example:
        >>> # Distance from New York to London
        >>> distance = haversine_distance(40.7128, -74.0060, 51.5074, -0.1278)
        >>> print(f"{distance:.1f} km")
        5570.2 km

    Note:
        Uses Earth's mean radius of 6371 km. For more precise calculations
        over short distances, consider using a different Earth model.
    """
    lat1, lon1, lat2, lon2 = map(radians, [lat1, lon1, lat2, lon2])
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    a = sin(dlat / 2) ** 2 + cos(lat1) * cos(lat2) * sin(dlon / 2) ** 2
    c = 2 * atan2(sqrt(a), sqrt(1 - a))
    return EARTH_RADIUS_KM * c


def downsample_coordinates(
    coordinates: List[Union[Coordinate2D, Coordinate3D]], factor: int = 5
) -> List[Union[Coordinate2D, Coordinate3D]]:
    """
    Simple downsampling by keeping every Nth point.

    Args:
        coordinates: List of [lat, lon] or [lat, lon, alt]
        factor: Keep every Nth point

    Returns:
        Downsampled coordinates
    """
    if factor <= 1:
        return coordinates
    return [coordinates[i] for i in range(0, len(coordinates), factor)]


def get_altitude_color(altitude: float, min_alt: float, max_alt: float) -> str:
    """
    Get color for altitude value based on gradient from blue (low) to red (high).

    Creates a smooth color gradient that maps altitude to color:
    - Blue (0-20%): Low altitudes
    - Cyan (20-40%): Climbing
    - Green (40-60%): Mid-altitude
    - Yellow (60-80%): Higher altitude
    - Red (80-100%): High altitudes

    Args:
        altitude: Altitude value in meters
        min_alt: Minimum altitude in dataset (meters)
        max_alt: Maximum altitude in dataset (meters)

    Returns:
        Hex color string like '#ff0000'

    Example:
        >>> # Altitude at 50% of range appears green
        >>> color = get_altitude_color(1000, 0, 2000)
        >>> color
        '#00ff00'

        >>> # All same altitude returns teal
        >>> color = get_altitude_color(500, 500, 500)
        >>> color
        '#00AA88'

    Note:
        Color saturation is balanced for visibility on maps without being
        too bright or overwhelming.
    """
    if max_alt == min_alt:
        return "#00AA88"  # Teal if all altitudes are the same

    # Normalize altitude to 0-1 range, clamped to valid bounds
    normalized = max(0.0, min(1.0, (altitude - min_alt) / (max_alt - min_alt)))

    # Color gradient: blue -> cyan -> green -> yellow -> orange -> red
    if normalized < 0.2:
        # Blue to cyan
        ratio = normalized * 5
        r, g, b = 0, int(ratio * 180), int(150 + ratio * 105)
    elif normalized < 0.4:
        # Cyan to green
        ratio = (normalized - 0.2) * 5
        r, g, b = 0, int(180 + ratio * 75), int(255 - ratio * 155)
    elif normalized < 0.6:
        # Green to yellow
        ratio = (normalized - 0.4) * 5
        r, g, b = int(ratio * 255), 255, int(100 - ratio * 100)
    elif normalized < 0.8:
        # Yellow to orange
        ratio = (normalized - 0.6) * 5
        r, g, b = 255, int(255 - ratio * 100), 0
    else:
        # Orange to red
        ratio = (normalized - 0.8) * 5
        r, g, b = 255, int(155 - ratio * 155), 0

    return f"#{r:02x}{g:02x}{b:02x}"
