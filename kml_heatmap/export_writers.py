"""Airport and metadata export writers."""

import math
from pathlib import Path
from typing import TYPE_CHECKING, Any

from .airport_lookup import extract_icao_codes_from_name, lookup_airport_country
from .airports import extract_airport_name
from .cache import atomic_data_write
from .logger import logger

if TYPE_CHECKING:
    from collections.abc import Mapping

    from .types import AirportData

__all__ = [
    "export_airports_data",
    "export_metadata",
    "exported_airport_names",
    "exported_country_codes",
]


def _exported_airports(
    unique_airports: list[AirportData],
) -> list[tuple[AirportData, str]]:
    """Pair every airport that has a displayable name with that name.

    Nearby airports were already merged by ``airports.deduplicate_airports``,
    so no further deduplication happens here.
    """
    exported = []
    for apt in unique_airports:
        full_name = apt.get("name") or "Unknown"
        is_at_path_end = apt.get("is_at_path_end", False)
        airport_name = extract_airport_name(full_name, is_at_path_end)
        if airport_name:
            exported.append((apt, airport_name))
    return exported


def exported_airport_names(unique_airports: list[AirportData]) -> frozenset[str]:
    """The names of the airport markers ``export_airports_data`` writes."""
    return frozenset(name for _, name in _exported_airports(unique_airports))


def exported_country_codes(unique_airports: list[AirportData]) -> list[str]:
    """The countries the exported airports are in, as ISO codes.

    The same lookup ``export_airports_data`` writes into each airport, kept
    here so the site can publish a flag for each of them without reading its
    own export back.
    """
    codes: set[str] = set()
    for _, airport_name in _exported_airports(unique_airports):
        icao_codes = extract_icao_codes_from_name(airport_name)
        if not icao_codes:
            continue
        country = lookup_airport_country(icao_codes[0])
        if country:
            codes.add(country)
    return sorted(codes)


def export_airports_data(
    unique_airports: list[AirportData],
    output_dir: str,
) -> tuple[str, int]:
    """Export airport data to airports.json."""
    valid_airports = []

    for apt, airport_name in _exported_airports(unique_airports):
        # No flight count here: the frontend derives it per airport from the
        # path info of the active year/aircraft filter, so an exported count
        # would only ever be shown for the instant before the first refresh
        airport_data: dict[str, Any] = {
            "lat": apt["lat"],
            "lon": apt["lon"],
            "name": airport_name,
        }

        icao_codes = extract_icao_codes_from_name(airport_name)
        if icao_codes:
            country = lookup_airport_country(icao_codes[0])
            if country:
                airport_data["country"] = country

        valid_airports.append(airport_data)

    airports_file = Path(output_dir) / "airports.json"
    atomic_data_write(airports_file, {"airports": valid_airports}, sort_keys=True)

    file_size = airports_file.stat().st_size

    logger.info(
        "  ✓ Airports: %d locations (%.1f KB)", len(valid_airports), file_size / 1024
    )

    return str(airports_file), file_size


def export_metadata(
    min_groundspeed_knots: float,
    max_groundspeed_knots: float,
    available_years: list[int],
    year_file_bytes: dict[str, int],
    aircraft_models: Mapping[str, str],
    output_dir: str,
    available_flags: list[str] | None = None,
) -> tuple[str, int]:
    """Export metadata.json.

    No statistics: the frontend computes them from the year files for every
    filter. It needs the years and their file sizes before loading any year,
    the groundspeed range for the speed scale, the aircraft models, which
    only aircraft.json knows, and the flags the site was able to publish.
    """
    if not math.isfinite(min_groundspeed_knots):
        min_groundspeed_knots = 0.0
    if not math.isfinite(max_groundspeed_knots):
        max_groundspeed_knots = 0.0

    meta_data: dict[str, Any] = {
        "min_groundspeed_knots": round(min_groundspeed_knots, 1),
        "max_groundspeed_knots": round(max_groundspeed_knots, 1),
        "available_years": sorted(available_years),
        "year_file_bytes": year_file_bytes,
        "aircraft_models": dict(aircraft_models),
        # Which countries the site carries a flag for. A build without the
        # flag files publishes none, and the frontend falls back to the code.
        "available_flags": list(available_flags or []),
    }

    meta_file = Path(output_dir) / "metadata.json"
    atomic_data_write(meta_file, meta_data, sort_keys=True)

    file_size = meta_file.stat().st_size

    logger.info("  ✓ Metadata: %.1f KB", file_size / 1024)

    return str(meta_file), file_size
