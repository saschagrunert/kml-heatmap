"""Input validation utilities."""

import os
from pathlib import Path
from typing import Tuple, Optional, Dict

__all__ = [
    "validate_coordinates",
    "validate_kml_file",
    "validate_api_keys",
    "validate_altitude",
]


def validate_coordinates(
    lat: float, lon: float, context: str = ""
) -> Tuple[bool, Optional[str]]:
    """
    Validate latitude and longitude values.

    Args:
        lat: Latitude value
        lon: Longitude value
        context: Optional context string for error messages

    Returns:
        tuple: (is_valid, error_message)
    """
    if not isinstance(lat, (int, float)):
        return False, f"Latitude must be a number{context}"

    if not isinstance(lon, (int, float)):
        return False, f"Longitude must be a number{context}"

    if lat < -90 or lat > 90:
        return False, f"Latitude {lat} out of bounds (-90 to 90){context}"

    if lon < -180 or lon > 180:
        return False, f"Longitude {lon} out of bounds (-180 to 180){context}"

    return True, None


def validate_kml_file(file_path: str) -> Tuple[bool, Optional[str]]:
    """
    Validate KML file exists and is readable.

    Args:
        file_path: Path to KML file

    Returns:
        tuple: (is_valid, error_message)
    """
    path = Path(file_path)

    if not path.exists():
        return False, f"File not found: {file_path}"

    if not path.is_file():
        return False, f"Not a file: {file_path}"

    if not os.access(path, os.R_OK):
        return False, f"File not readable: {file_path}"

    # Check if it looks like a KML file
    if not str(path).lower().endswith(".kml"):
        return False, f"File does not have .kml extension: {file_path}"

    # Check file is not empty
    if path.stat().st_size == 0:
        return False, f"File is empty: {file_path}"

    return True, None


def validate_api_keys(
    stadia_key: str, openaip_key: str, verbose: bool = True
) -> Dict[str, bool]:
    """
    Validate API keys and warn if missing.

    Args:
        stadia_key: Stadia Maps API key
        openaip_key: OpenAIP API key
        verbose: Whether to print warnings

    Returns:
        dict: Status of each key
    """
    status = {"stadia": bool(stadia_key), "openaip": bool(openaip_key)}

    if verbose:
        if not stadia_key:
            print(
                "⚠️  Warning: STADIA_API_KEY not set - map tiles will use fallback (CartoDB)"
            )
            print("   Get a free key at: https://client.stadiamaps.com/")

        if not openaip_key:
            print(
                "⚠️  Warning: OPENAIP_API_KEY not set - aviation data layer will be disabled"
            )
            print("   Get a free key at: https://www.openaip.net/")

    return status


def validate_altitude(altitude: float, context: str = "") -> Tuple[bool, Optional[str]]:
    """
    Validate altitude value.

    Args:
        altitude: Altitude in meters
        context: Optional context string for error messages

    Returns:
        tuple: (is_valid, error_message)
    """
    if not isinstance(altitude, (int, float)):
        return False, f"Altitude must be a number{context}"

    # Reasonable altitude limits (in meters)
    # Dead Sea is ~-430m, commercial aviation max is ~13,000m
    MIN_ALTITUDE = -500
    MAX_ALTITUDE = 15000

    if altitude < MIN_ALTITUDE or altitude > MAX_ALTITUDE:
        return (
            False,
            f"Altitude {altitude}m seems unrealistic (expected {MIN_ALTITUDE} to {MAX_ALTITUDE}m){context}",
        )

    return True, None
