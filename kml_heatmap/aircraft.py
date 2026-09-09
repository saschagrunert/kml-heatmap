"""Aircraft registration and model lookup functionality."""

import json
import re
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING

from .logger import logger

if TYPE_CHECKING:
    from collections.abc import Iterable, Mapping

__all__ = [
    "load_aircraft_data",
    "lookup_aircraft_model",
    "merge_aircraft_data",
    "normalize_registration",
    "parse_aircraft_from_filename",
]

# ICAO nationality prefixes that are written with a hyphen. Longer prefixes are
# matched first. "N" (United States) is written without a hyphen and is
# intentionally absent.
REGISTRATION_PREFIXES: tuple[str, ...] = (
    "9A",
    "CS",
    "EC",
    "EI",
    "ES",
    "HA",
    "HB",
    "LN",
    "LX",
    "LY",
    "LZ",
    "OE",
    "OH",
    "OK",
    "OM",
    "OO",
    "OY",
    "PH",
    "S5",
    "SE",
    "SP",
    "SX",
    "TC",
    "YL",
    "YR",
    "YU",
    "D",
    "F",
    "G",
    "I",
)

_CHARTERWARE_DATE = re.compile(r"\d{4}-\d{2}-\d{2}")
_CHARTERWARE_TIME = re.compile(r"(?:[01]\d|2[0-3])[0-5]\dh")


def load_aircraft_data(aircraft_file: Path) -> dict[str, str]:
    """Load an aircraft.json mapping of registration to model name."""
    try:
        data = json.loads(aircraft_file.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as e:
        logger.warning("Failed to read aircraft data from %s: %s", aircraft_file, e)
        return {}

    if not isinstance(data, dict):
        logger.warning("Ignoring %s: expected a JSON object", aircraft_file)
        return {}

    return {str(key): str(value) for key, value in data.items()}


def merge_aircraft_data(aircraft_files: Iterable[Path]) -> dict[str, str]:
    """Merge several aircraft.json files; the first file wins on conflicts."""
    merged: dict[str, str] = {}
    for aircraft_file in aircraft_files:
        for registration, model in load_aircraft_data(aircraft_file).items():
            merged.setdefault(registration, model)
    return merged


def lookup_aircraft_model(
    registration: str, aircraft_data: Mapping[str, str] | None = None
) -> str | None:
    """Look up an aircraft model from merged aircraft.json data."""
    if not aircraft_data:
        return None
    return aircraft_data.get(registration)


def normalize_registration(raw: str) -> str:
    """Insert the nationality hyphen into a registration written without one."""
    if not raw or "-" in raw:
        return raw

    for prefix in REGISTRATION_PREFIXES:
        if raw.startswith(prefix) and len(raw) > len(prefix):
            return f"{prefix}-{raw[len(prefix) :]}"

    return raw


def parse_aircraft_from_filename(filename: str) -> dict[str, str | None]:
    """Parse aircraft information from KML filename.

    Supports two formats:
    1. Numbered: N_REGISTRATION_TYPE.kml (e.g., 1_DEHYL_DA40.kml)
    2. Charterware: YYYY-MM-DD_HHMMh_REGISTRATION_ROUTE.kml
    """
    name = Path(filename).stem
    parts = name.split("_")

    if len(parts) >= 3 and parts[0].isdigit():
        if len(parts) > 3:
            logger.warning(
                "Ignoring extra filename parts in %s (expected N_REGISTRATION_TYPE)",
                filename,
            )
        return {
            "registration": normalize_registration(parts[1]),
            "type": parts[2],
            "format": "numbered",
        }

    if (
        len(parts) >= 4
        and _CHARTERWARE_DATE.fullmatch(parts[0])
        and _CHARTERWARE_TIME.fullmatch(parts[1])
    ):
        try:
            datetime.strptime(parts[0], "%Y-%m-%d")
        except ValueError:
            logger.warning("Invalid date in Charterware filename: %s", filename)
            return {}

        return {
            "registration": normalize_registration(parts[2]),
            "type": None,
            "route": parts[3] or None,
            "format": "charterware",
        }

    logger.debug("No aircraft information in filename: %s", filename)
    return {}
