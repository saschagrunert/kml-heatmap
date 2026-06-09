"""Aircraft registration and model lookup functionality."""

import json
from pathlib import Path
from typing import Dict, Optional

from .logger import logger

__all__ = [
    "lookup_aircraft_model",
    "parse_aircraft_from_filename",
]


_aircraft_cache: Optional[Dict[str, str]] = None
_aircraft_cache_path: Optional[Path] = None


def load_aircraft_data(aircraft_file: Path) -> Dict[str, str]:
    """Load aircraft data from JSON file, with caching.

    Args:
        aircraft_file: Path to aircraft.json

    Returns:
        Dict mapping registration to model name, empty dict on error
    """
    global _aircraft_cache, _aircraft_cache_path
    if _aircraft_cache is not None and _aircraft_cache_path == aircraft_file:
        return _aircraft_cache

    try:
        data: Dict[str, str] = json.loads(aircraft_file.read_text())
        _aircraft_cache = data
        _aircraft_cache_path = aircraft_file
        return data
    except (json.JSONDecodeError, OSError) as e:
        logger.warning(f"Failed to read aircraft data from {aircraft_file}: {e}")
        return {}


def lookup_aircraft_model(
    registration: str, aircraft_file: Optional[Path] = None
) -> Optional[str]:
    """Look up aircraft model from the aircraft.json data file.

    Args:
        registration: Aircraft registration (e.g., 'D-EAGJ')
        aircraft_file: Path to aircraft.json

    Returns:
        Full aircraft model name or None if not found
    """
    if not aircraft_file:
        return None

    data = load_aircraft_data(aircraft_file)
    return data.get(registration)


def parse_aircraft_from_filename(filename: str) -> Dict[str, str | None]:
    """
    Parse aircraft information from KML filename.

    Supports two formats:
    1. Numbered: N_REGISTRATION_TYPE.kml
       Example: 1_DEHYL_DA40.kml
    2. Charterware: YYYY-MM-DD_HHMMh_REGISTRATION_ROUTE.kml
       Example: 2026-01-12_1513h_OE-AKI_LOAV-LOAV.kml

    Args:
        filename: KML filename (without path)

    Returns:
        Dict with keys: 'registration', 'type' (optional), 'route' (optional), 'format'
        Returns empty dict if parsing fails
    """
    # Remove .kml extension
    name = filename.replace(".kml", "")

    # Split by underscore
    parts = name.split("_")

    # Numbered format: N_REGISTRATION_TYPE (e.g., 1_DEHYL_DA40)
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

    # Charterware format detection: date has hyphens (YYYY-MM-DD)
    if len(parts) >= 3 and "-" in parts[0]:
        # Format: YYYY-MM-DD_HHMMh_REGISTRATION_ROUTE
        # Example: 2026-01-12_1513h_OE-AKI_LOAV-LOAV.kml
        if len(parts) >= 4:
            registration = parts[2]  # Already has hyphen (OE-AKI)
            route = parts[3] if len(parts) > 3 else None

            return {
                "registration": registration,
                "type": None,  # Charterware doesn't include type in filename
                "route": route if route else None,  # DEPARTURE-ARRIVAL format
                "format": "charterware",
            }

    return {}
