"""Geometric calculations and coordinate manipulations."""

from math import radians, sin, cos, sqrt, atan2

# Constants
EARTH_RADIUS_KM = 6371


def haversine_distance(lat1, lon1, lat2, lon2):
    """Calculate great circle distance in kilometers between two points."""
    lat1, lon1, lat2, lon2 = map(radians, [lat1, lon1, lat2, lon2])
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    a = sin(dlat/2)**2 + cos(lat1) * cos(lat2) * sin(dlon/2)**2
    c = 2 * atan2(sqrt(a), sqrt(1-a))
    return EARTH_RADIUS_KM * c


def downsample_path_rdp(path, epsilon=0.0001):
    """
    Downsample a path using Ramer-Douglas-Peucker algorithm (iterative).

    Args:
        path: List of [lat, lon] or [lat, lon, alt] coordinates
        epsilon: Tolerance for simplification (smaller = more detail)

    Returns:
        Simplified path
    """
    if len(path) <= 2:
        return path

    def perpendicular_distance(point, line_start, line_end):
        """Calculate perpendicular distance from point to line."""
        # For circular paths where start == end, use haversine distance from start
        if line_start[:2] == line_end[:2]:
            return haversine_distance(point[0], point[1], line_start[0], line_start[1])

        # Using simple Euclidean approximation for small distances
        x0, y0 = point[0], point[1]
        x1, y1 = line_start[0], line_start[1]
        x2, y2 = line_end[0], line_end[1]

        num = abs((y2 - y1) * x0 - (x2 - x1) * y0 + x2 * y1 - y2 * x1)
        den = sqrt((y2 - y1)**2 + (x2 - x1)**2)

        if den == 0:
            # Shouldn't happen if we checked line_start == line_end above, but safety fallback
            return haversine_distance(point[0], point[1], line_start[0], line_start[1])
        return num / den

    # Iterative RDP using stack (avoids recursion overhead and stack limits)
    stack = [(0, len(path) - 1)]
    keep_indices = {0, len(path) - 1}  # Use set for O(1) lookups

    while stack:
        start_idx, end_idx = stack.pop()

        # Find point with maximum distance from line
        dmax = 0
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


def downsample_coordinates(coordinates, factor=5):
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


def get_altitude_color(altitude, min_alt, max_alt):
    """
    Get color for altitude value based on gradient from blue (low) to red (high).
    Balanced saturation for visibility without being too bright.
    """
    if max_alt == min_alt:
        return '#00AA88'  # Teal if all altitudes are the same

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

    return f'#{r:02x}{g:02x}{b:02x}'
