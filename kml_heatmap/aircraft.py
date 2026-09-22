"""Aircraft registration and model lookup functionality."""

import json
import re
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING

from .constants import ICAO_REGION_PREFIXES
from .logger import logger

if TYPE_CHECKING:
    from collections.abc import Iterable, Mapping

__all__ = [
    "load_aircraft_data",
    "merge_aircraft_data",
    "normalize_registration",
    "parse_aircraft_from_filename",
    "resolve_aircraft_models",
]

# ICAO nationality prefixes that are written with a hyphen. Longer prefixes are
# matched first. "N" (United States) is written without a hyphen and is
# intentionally absent.
REGISTRATION_PREFIXES: tuple[str, ...] = tuple(
    sorted(
        (
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
        ),
        key=len,
        reverse=True,
    )
)

# A registration: a nationality prefix of one or two characters (D, OE, 9A,
# N), with or without its hyphen, then letters and digits (D-EHYL, OEAKI,
# N12345, N123AB). In capitals, and with at least one letter: "summer" in
# "2025_summer_trip.kml" is none.
_REGISTRATION = re.compile(r"[A-Z0-9]{1,2}-[A-Z0-9]{1,5}|[A-Z0-9]{3,7}")
_ICAO_CODE = re.compile(rf"[{ICAO_REGION_PREFIXES}][A-Z]{{3}}")
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

    # Keyed the way registrations from file names are written ("DEAGJ" is
    # D-EAGJ); the first spelling of a registration wins
    aircraft: dict[str, str] = {}
    for key, value in data.items():
        aircraft.setdefault(normalize_registration(str(key)), str(value))
    return aircraft


def merge_aircraft_data(aircraft_files: Iterable[Path]) -> dict[str, str]:
    """Merge several aircraft.json files; the first file wins on conflicts."""
    merged: dict[str, str] = {}
    for aircraft_file in aircraft_files:
        for registration, model in load_aircraft_data(aircraft_file).items():
            merged.setdefault(registration, model)
    return merged


def resolve_aircraft_models(
    registrations: Iterable[str | None],
    aircraft_data: Mapping[str, str] | None = None,
) -> dict[str, str]:
    """The model of every registration that aircraft.json knows.

    Registrations without a model are left out; the frontend shows the
    aircraft type from the KML file for them.
    """
    models: dict[str, str] = {}
    for registration in sorted({reg for reg in registrations if reg}):
        model = aircraft_data.get(registration) if aircraft_data else None
        if model:
            logger.info("  ✓ %s: %s", registration, model)
            models[registration] = model
        else:
            logger.info("  ⚠ %s: no model in aircraft.json", registration)
    return models


def normalize_registration(raw: str) -> str:
    """Insert the nationality hyphen into a registration written without one."""
    if not raw or "-" in raw:
        return raw

    for prefix in REGISTRATION_PREFIXES:
        if raw.startswith(prefix) and len(raw) > len(prefix):
            return f"{prefix}-{raw[len(prefix) :]}"

    return raw


def _is_date(text: str) -> bool:
    """Whether a leading number of a file name is a date (20250601) or year."""
    if len(text) == 8:
        try:
            datetime.strptime(text, "%Y%m%d")
        except ValueError:
            return False
        return True
    return len(text) == 4 and text.isascii() and 1900 <= int(text) <= 2099


def _is_registration(text: str, after_date: bool) -> bool:
    """Whether the second part of a numbered file name is a registration.

    After a date it must not be an ICAO airport code either:
    "20250601_EDDS_EDDP.kml" is a route, not the aircraft EDDS.
    """
    if not _REGISTRATION.fullmatch(text) or not any(c.isalpha() for c in text):
        return False
    return not (after_date and _ICAO_CODE.fullmatch(text))


def parse_aircraft_from_filename(filename: str) -> dict[str, str | None]:
    """Parse aircraft information from KML filename.

    Supports two formats:
    1. Numbered: N_REGISTRATION_TYPE.kml (e.g., 1_DEHYL_DA40.kml)
    2. Charterware: YYYY-MM-DD_HHMMh_REGISTRATION_ROUTE.kml

    A numbered name whose second part is no registration (see
    ``_is_registration``) names no aircraft.
    """
    name = Path(filename).stem
    parts = name.split("_")

    if len(parts) >= 3 and parts[0].isascii() and parts[0].isdigit():
        if not _is_registration(parts[1], _is_date(parts[0])):
            logger.debug("No aircraft registration in filename: %s", filename)
            return {}
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
