"""Coordinate validation shared by the KML parsers."""

import math

from .constants import ALT_MAX_M, ALT_MIN_M, LAT_MAX, LAT_MIN, LON_MAX, LON_MIN
from .logger import logger

__all__ = [
    "validate_and_normalize_coordinate",
]


def validate_and_normalize_coordinate(
    lat: float, lon: float, alt: float | None, filename: str
) -> tuple[float, float, float | None] | None:
    """Validate a coordinate point.

    Returns None if the latitude/longitude are invalid. An altitude that is
    non-finite or outside the plausible range is treated as missing (None);
    valid negative altitudes (down to ALT_MIN_M) are kept.
    """
    if not (
        math.isfinite(lat)
        and math.isfinite(lon)
        and LAT_MIN <= lat <= LAT_MAX
        and LON_MIN <= lon <= LON_MAX
    ):
        logger.debug("Invalid coordinates [%s, %s] in %s", lat, lon, filename)
        return None

    normalized_alt = alt
    if alt is not None and not (math.isfinite(alt) and ALT_MIN_M <= alt <= ALT_MAX_M):
        logger.debug("Invalid altitude %sm in %s, treating as missing", alt, filename)
        normalized_alt = None

    return (lat, lon, normalized_alt)
