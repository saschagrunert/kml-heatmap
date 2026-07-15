"""Input validation utilities."""

import os
from pathlib import Path

from .logger import logger

__all__ = [
    "validate_coordinates",
    "validate_kml_file",
    "validate_api_keys",
    "validate_altitude",
]


def validate_coordinates(
    lat: float, lon: float, context: str = ""
) -> tuple[bool, str | None]:
    """Validate latitude and longitude values."""
    if not isinstance(lat, (int, float)):
        return False, f"Latitude must be a number{context}"

    if not isinstance(lon, (int, float)):
        return False, f"Longitude must be a number{context}"

    if lat < -90 or lat > 90:
        return False, f"Latitude {lat} out of bounds (-90 to 90){context}"

    if lon < -180 or lon > 180:
        return False, f"Longitude {lon} out of bounds (-180 to 180){context}"

    return True, None


def validate_kml_file(file_path: str) -> tuple[bool, str | None]:
    """Validate KML file exists and is readable."""
    path = Path(file_path)

    if not path.exists():
        return False, f"File not found: {file_path}"

    if not path.is_file():
        return False, f"Not a file: {file_path}"

    if not os.access(path, os.R_OK):
        return False, f"File not readable: {file_path}"

    if not str(path).lower().endswith(".kml"):
        return False, f"File does not have .kml extension: {file_path}"

    if path.stat().st_size == 0:
        return False, f"File is empty: {file_path}"

    return True, None


def validate_api_keys(
    stadia_key: str, openaip_key: str, verbose: bool = True
) -> dict[str, bool]:
    """Validate API keys and warn if missing."""
    status = {"stadia": bool(stadia_key), "openaip": bool(openaip_key)}

    if verbose:
        if not stadia_key:
            logger.warning(
                "STADIA_API_KEY not set - map tiles will use fallback (CartoDB). "
                "Get a free key at: https://client.stadiamaps.com/"
            )

        if not openaip_key:
            logger.warning(
                "OPENAIP_API_KEY not set - aviation data layer will be disabled. "
                "Get a free key at: https://www.openaip.net/"
            )

    return status


def validate_altitude(altitude: float, context: str = "") -> tuple[bool, str | None]:
    """Validate altitude value."""
    if not isinstance(altitude, (int, float)):
        return False, f"Altitude must be a number{context}"

    # Tighter bounds than coordinate clamping: Dead Sea (~-430m) to commercial aviation max (~13,000m)
    min_altitude = -500
    max_altitude = 15000

    if altitude < min_altitude or altitude > max_altitude:
        return (
            False,
            f"Altitude {altitude}m seems unrealistic (expected {min_altitude} to {max_altitude}m){context}",
        )

    return True, None
