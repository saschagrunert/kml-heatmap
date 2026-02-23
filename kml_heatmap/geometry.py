"""Geometric calculations and coordinate manipulations."""

from math import radians, sin, cos, sqrt, atan2
from typing import List, Union

__all__ = [
    "EARTH_RADIUS_KM",
    "Coordinate2D",
    "Coordinate3D",
    "Coordinate4D",
    "PathCoordinate",
    "haversine_distance",
    "downsample_path_rdp",
    "downsample_coordinates",
    "get_altitude_color",
]

# Constants
EARTH_RADIUS_KM = 6371

# Type aliases
Coordinate2D = List[float]  # [lat, lon]
Coordinate3D = List[float]  # [lat, lon, alt]
Coordinate4D = List[Union[float, str]]  # [lat, lon, alt, timestamp]
PathCoordinate = Union[Coordinate3D, Coordinate4D]


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


def downsample_path_rdp(
    path: List[PathCoordinate], epsilon: float = 0.0001
) -> List[PathCoordinate]:
    """
    Downsample a path using Ramer-Douglas-Peucker algorithm (iterative).

    The RDP algorithm simplifies a path by removing points that don't
    significantly affect the path's shape. It works by recursively finding
    the point furthest from a line segment and keeping it if the distance
    exceeds epsilon.

    Args:
        path: List of [lat, lon] or [lat, lon, alt] or [lat, lon, alt, timestamp]
        epsilon: Tolerance for simplification in degrees (smaller = more detail)
                Default 0.0001 ≈ 11 meters at equator

    Returns:
        Simplified path with same coordinate format as input

    Example:
        >>> path = [[0, 0, 100], [0, 0.0001, 100], [0, 0.001, 100]]
        >>> simplified = downsample_path_rdp(path, epsilon=0.0002)
        >>> len(simplified)  # Middle point removed as it's within tolerance
        2

    Complexity:
        Best case: O(n) when path is already simplified
        Worst case: O(n²) for complex paths
        Average: O(n log n) for typical GPS tracks

    Note:
        This implementation uses an iterative approach with a stack instead
        of recursion to avoid stack overflow on very long paths.
    """
    if len(path) <= 2:
        return path

    def perpendicular_distance(
        point: PathCoordinate, line_start: PathCoordinate, line_end: PathCoordinate
    ) -> float:
        """Calculate perpendicular distance from point to line."""
        # Coordinates are always floats at indices 0 and 1 (lat, lon)
        p0 = float(point[0])
        p1 = float(point[1])
        s0 = float(line_start[0])
        s1 = float(line_start[1])
        e0 = float(line_end[0])
        e1 = float(line_end[1])

        # For circular paths where start == end, use haversine distance from start
        if s0 == e0 and s1 == e1:
            return haversine_distance(p0, p1, s0, s1)

        # Using simple Euclidean approximation for small distances
        num = abs((e1 - s1) * p0 - (e0 - s0) * p1 + e0 * s1 - e1 * s0)
        den = sqrt((e1 - s1) ** 2 + (e0 - s0) ** 2)

        if den == 0:
            return haversine_distance(p0, p1, s0, s1)
        return num / den

    # Iterative RDP using stack (avoids recursion overhead and stack limits)
    stack = [(0, len(path) - 1)]
    keep_indices = {0, len(path) - 1}  # Use set for O(1) lookups

    while stack:
        start_idx, end_idx = stack.pop()

        # Find point with maximum distance from line
        dmax = 0.0
        max_idx = 0

        for i in range(start_idx + 1, end_idx):
            d = perpendicular_distance(path[i], path[start_idx], path[end_idx])
            if d > dmax:
                max_idx = i
                dmax = d

        # If max distance exceeds epsilon, keep the point and subdivide
        if dmax > epsilon:
            keep_indices.add(max_idx)
            stack.append((start_idx, max_idx))
            stack.append((max_idx, end_idx))

    # Build result from kept indices in order
    return [path[i] for i in sorted(keep_indices)]


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

    # Normalize altitude to 0-1 range
    normalized = (altitude - min_alt) / (max_alt - min_alt)

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
