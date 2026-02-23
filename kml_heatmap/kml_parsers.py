"""Specialized parsers for different KML coordinate formats.

This module provides coordinate validation and normalization for KML parsing.

Coordinate Validation:
- Validates latitude and longitude ranges
- Validates altitude range
- Clamps negative altitudes to 0 (below sea level)
"""

from typing import Optional, Tuple

from .logger import logger
from .constants import LAT_MIN, LAT_MAX, LON_MIN, LON_MAX, ALT_MIN_M, ALT_MAX_M

__all__ = [
    "validate_and_normalize_coordinate",
]

# Pre-computed validation ranges
LAT_RANGE = (LAT_MIN, LAT_MAX)
LON_RANGE = (LON_MIN, LON_MAX)
ALT_RANGE = (ALT_MIN_M, ALT_MAX_M)


def validate_and_normalize_coordinate(
    lat: float, lon: float, alt: Optional[float], filename: str
) -> Optional[Tuple[float, float, Optional[float]]]:
    """
    Validate and normalize a coordinate point.

    This function combines validation and normalization in one step:
    - Validates latitude and longitude ranges
    - Validates altitude range (if provided)
    - Clamps negative altitudes to 0 (below sea level)
    - Returns None if coordinates are invalid

    Args:
        lat: Latitude
        lon: Longitude
        alt: Altitude in meters (can be None)
        filename: Source filename for error messages

    Returns:
        Tuple of (lat, lon, normalized_alt) or None if invalid

    Example:
        >>> coord = validate_and_normalize_coordinate(50.0, 8.0, -10.0, "test.kml")
        >>> coord
        (50.0, 8.0, 0.0)  # Negative altitude clamped to 0
    """
    # Validate latitude and longitude
    if not (
        LAT_RANGE[0] <= lat <= LAT_RANGE[1] and LON_RANGE[0] <= lon <= LON_RANGE[1]
    ):
        logger.debug(f"Invalid coordinates [{lat}, {lon}] in {filename}")
        return None

    # Validate and normalize altitude
    normalized_alt = alt
    if alt is not None:
        if not (ALT_RANGE[0] <= alt <= ALT_RANGE[1]):
            logger.debug(f"Invalid altitude {alt}m in {filename}")
            normalized_alt = None
        elif alt < 0:
            # Clamp negative altitudes to 0 (below sea level = 0)
            normalized_alt = 0.0

    return (lat, lon, normalized_alt)
