"""Aircraft registration and model lookup functionality."""

import json
from pathlib import Path

from .logger import logger

__all__ = [
    "lookup_aircraft_model",
    "parse_aircraft_from_filename",
]


_aircraft_cache: dict[str, str] | None = None
_aircraft_cache_path: Path | None = None


def load_aircraft_data(aircraft_file: Path) -> dict[str, str]:
    """Load aircraft data from JSON file, with caching."""
    global _aircraft_cache, _aircraft_cache_path
    if _aircraft_cache is not None and _aircraft_cache_path == aircraft_file:
        return _aircraft_cache

    try:
        data: dict[str, str] = json.loads(aircraft_file.read_text())
        _aircraft_cache = data
        _aircraft_cache_path = aircraft_file
        return data
    except (json.JSONDecodeError, OSError) as e:
        logger.warning(f"Failed to read aircraft data from {aircraft_file}: {e}")
        return {}


def lookup_aircraft_model(
    registration: str, aircraft_file: Path | None = None
) -> str | None:
    """Look up aircraft model from the aircraft.json data file."""
    if not aircraft_file:
        return None

    data = load_aircraft_data(aircraft_file)
    return data.get(registration)


def parse_aircraft_from_filename(filename: str) -> dict[str, str | None]:
    """Parse aircraft information from KML filename.

    Supports two formats:
    1. Numbered: N_REGISTRATION_TYPE.kml (e.g., 1_DEHYL_DA40.kml)
    2. Charterware: YYYY-MM-DD_HHMMh_REGISTRATION_ROUTE.kml
    """
    name = filename.replace(".kml", "")
    parts = name.split("_")

    if len(parts) == 3 and parts[0].isdigit():
        registration_raw = parts[1]
        aircraft_type = parts[2]

        registration = registration_raw
        if registration_raw.startswith("D") and len(registration_raw) > 1:
            registration = registration_raw[0] + "-" + registration_raw[1:]

        return {
            "registration": registration,
            "type": aircraft_type,
            "format": "numbered",
        }

    if len(parts) >= 3 and "-" in parts[0]:
        if len(parts) >= 4:
            registration = parts[2]
            route = parts[3] if len(parts) > 3 else None

            return {
                "registration": registration,
                "type": None,
                "route": route if route else None,
                "format": "charterware",
            }

    return {}
