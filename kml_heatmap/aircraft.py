"""Aircraft registration and model lookup functionality."""

import json
import re
from datetime import date
from pathlib import Path
from typing import TYPE_CHECKING, NamedTuple

from .constants import ICAO_REGION_PREFIXES
from .date_tokens import strip_dates
from .logger import logger

if TYPE_CHECKING:
    from collections.abc import Iterable, Mapping

__all__ = [
    "REGISTRATION_PREFIXES",
    "AircraftInfo",
    "load_aircraft_data",
    "merge_aircraft_data",
    "normalize_registration",
    "parse_aircraft_from_filename",
    "resolve_aircraft_models",
]

# ICAO nationality prefixes that are written with a hyphen, in Europe and
# around it (doc/usage.md lists them). Longer prefixes are matched first, so
# "9H" (Malta) wins over nothing shorter and "2" (Guernsey) or "M" (Isle of
# Man) only apply where no two-character prefix does. "N" (United States) is
# written without a hyphen and is intentionally absent; any other prefix is
# used as written, so a registration outside this table has to be written
# with its hyphen in the file name.
REGISTRATION_PREFIXES: tuple[str, ...] = tuple(
    sorted(
        (
            "2",
            "4O",
            "5B",
            "9A",
            "9H",
            "CS",
            "E7",
            "EC",
            "EI",
            "ES",
            "EW",
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
            "TF",
            "UR",
            "YL",
            "YR",
            "YU",
            "Z3",
            "ZA",
            "D",
            "F",
            "G",
            "I",
            "M",
        ),
        key=len,
        reverse=True,
    )
)


class AircraftInfo(NamedTuple):
    """What a KML file name says about the aircraft (see the parser below).

    ``registration`` is None when the name has the shape of one but no
    registration in it; ``route`` is the DEPARTURE-ARRIVAL part of a
    Charterware name.
    """

    registration: str | None
    type: str | None = None
    route: str | None = None
    format: str = "numbered"


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
    # D-EAGJ, "d-eagj" too: the names are read in capitals); the first
    # spelling of a registration wins
    aircraft: dict[str, str] = {}
    for key, value in data.items():
        # A null or an object would reach metadata.json as "None" or as a
        # Python dict, and the page would show it as the model
        if not isinstance(value, str) or not value.strip() or not key.strip():
            logger.warning(
                "Ignoring %r in %s: the model must be a non-empty string",
                key,
                aircraft_file,
            )
            continue
        aircraft.setdefault(normalize_registration(key.strip().upper()), value)
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
            date.fromisoformat(text)
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


def _dated_registration(text: str, filename: str) -> bool:
    """Whether a registration holds a date, which it would publish.

    "16AUG26" in "1_16AUG26_DA40.kml" has the shape of a registration, but
    it is the day of the flight, and the registration is published with
    every path. Warns about it.
    """
    if strip_dates(text) == text:
        return False
    logger.warning(
        "Ignoring the registration %s in %s: it holds a date", text, filename
    )
    return True


def parse_aircraft_from_filename(filename: str) -> AircraftInfo | None:
    """Parse aircraft information from KML filename, None for a name without.

    Supports two formats:
    1. Numbered: N_REGISTRATION_TYPE.kml (e.g., 1_DEHYL_DA40.kml)
    2. Charterware: YYYY-MM-DD_HHMMh_REGISTRATION_ROUTE.kml

    A numbered name whose second part is no registration (see
    ``_is_registration``) names no aircraft; a Charterware name without one
    keeps its route. A registration that holds a date is none either (see
    ``_dated_registration``), but the type and route stay.
    """
    name = Path(filename).stem
    parts = name.split("_")

    if len(parts) >= 3 and parts[0].isascii() and parts[0].isdigit():
        if not _is_registration(parts[1], _is_date(parts[0])):
            logger.debug("No aircraft registration in filename: %s", filename)
            return None
        if len(parts) > 3:
            logger.warning(
                "Ignoring extra filename parts in %s (expected N_REGISTRATION_TYPE)",
                filename,
            )
        return AircraftInfo(
            registration=None
            if _dated_registration(parts[1], filename)
            else normalize_registration(parts[1]),
            type=parts[2],
            format="numbered",
        )

    if (
        len(parts) >= 4
        and _CHARTERWARE_DATE.fullmatch(parts[0])
        and _CHARTERWARE_TIME.fullmatch(parts[1])
    ):
        try:
            date.fromisoformat(parts[0])
        except ValueError:
            logger.warning("Invalid date in Charterware filename: %s", filename)
            return None

        # The same rules as for a numbered name: "constructor" in
        # "2026-01-12_1513h_constructor_LOAV-LOAV.kml" is no aircraft, but
        # the route still names the airports
        registration = None
        if _is_registration(parts[2], after_date=False) and not _dated_registration(
            parts[2], filename
        ):
            registration = normalize_registration(parts[2])
        else:
            logger.debug("No aircraft registration in filename: %s", filename)
        return AircraftInfo(registration, None, parts[3] or None, "charterware")

    logger.debug("No aircraft information in filename: %s", filename)
    return None
