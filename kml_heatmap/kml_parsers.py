"""Specialized parsers for different KML coordinate formats."""

from .logger import logger
from .constants import LAT_MIN, LAT_MAX, LON_MIN, LON_MAX, ALT_MIN_M, ALT_MAX_M

__all__ = [
    "validate_and_normalize_coordinate",
]

LAT_RANGE = (LAT_MIN, LAT_MAX)
LON_RANGE = (LON_MIN, LON_MAX)
ALT_RANGE = (ALT_MIN_M, ALT_MAX_M)


def validate_and_normalize_coordinate(
    lat: float, lon: float, alt: float | None, filename: str
) -> tuple[float, float, float | None] | None:
    """Validate and normalize a coordinate point.

    Clamps negative altitudes to 0. Returns None if coordinates are invalid.
    """
    if not (
        LAT_RANGE[0] <= lat <= LAT_RANGE[1] and LON_RANGE[0] <= lon <= LON_RANGE[1]
    ):
        logger.debug(f"Invalid coordinates [{lat}, {lon}] in {filename}")
        return None

    normalized_alt = alt
    if alt is not None:
        if not (ALT_RANGE[0] <= alt <= ALT_RANGE[1]):
            logger.debug(f"Invalid altitude {alt}m in {filename}")
            normalized_alt = None
        elif alt < 0:
            normalized_alt = 0.0

    return (lat, lon, normalized_alt)
