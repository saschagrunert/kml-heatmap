"""Airport and metadata export writers."""

import json
import math
from pathlib import Path
from typing import TYPE_CHECKING, Any

from .airport_lookup import extract_icao_codes_from_name, lookup_airport_country
from .airports import extract_airport_name
from .logger import logger

if TYPE_CHECKING:
    from .types import AirportData, Statistics


def export_airports_data(
    unique_airports: list[AirportData],
    output_dir: str,
) -> tuple[str, int]:
    """Export airport data to airports.js (window.KML_AIRPORTS)."""
    valid_airports = []
    seen_locations: set[str] = set()

    for apt in unique_airports:
        full_name = apt.get("name") or "Unknown"
        is_at_path_end = apt.get("is_at_path_end", False)
        airport_name = extract_airport_name(full_name, is_at_path_end)

        if not airport_name:
            continue

        location_key = f"{apt['lat']:.4f},{apt['lon']:.4f}"

        if location_key in seen_locations:
            continue

        seen_locations.add(location_key)

        airport_data: dict[str, Any] = {
            "lat": apt["lat"],
            "lon": apt["lon"],
            "name": airport_name,
            "flight_count": len(apt["timestamps"]) if apt.get("timestamps") else 1,
        }

        icao_codes = extract_icao_codes_from_name(airport_name)
        if icao_codes:
            country = lookup_airport_country(icao_codes[0])
            if country:
                airport_data["country"] = country

        valid_airports.append(airport_data)

    airports_file = Path(output_dir) / "airports.js"

    with open(airports_file, "w", encoding="utf-8") as f:
        f.write("window.KML_AIRPORTS = ")
        json.dump(
            {"airports": valid_airports}, f, separators=(",", ":"), sort_keys=True
        )
        f.write(";")

    file_size = airports_file.stat().st_size

    logger.info(
        "  ✓ Airports: %d locations (%.1f KB)", len(valid_airports), file_size / 1024
    )

    return str(airports_file), file_size


def export_metadata(
    stats: Statistics,
    min_alt_m: float,
    max_alt_m: float,
    min_groundspeed_knots: float,
    max_groundspeed_knots: float,
    available_years: list[int],
    year_file_bytes: dict[str, int],
    output_dir: str,
) -> tuple[str, int]:
    """Export metadata.js (window.KML_METADATA) with statistics and ranges."""
    if not math.isfinite(min_groundspeed_knots):
        min_groundspeed_knots = 0.0
    if not math.isfinite(max_groundspeed_knots):
        max_groundspeed_knots = 0.0

    meta_data: dict[str, Any] = {
        "stats": stats,
        "min_alt_m": min_alt_m,
        "max_alt_m": max_alt_m,
        "min_groundspeed_knots": round(min_groundspeed_knots, 1),
        "max_groundspeed_knots": round(max_groundspeed_knots, 1),
        "available_years": sorted(available_years),
        "year_file_bytes": year_file_bytes,
    }

    meta_file = Path(output_dir) / "metadata.js"

    with open(meta_file, "w", encoding="utf-8") as f:
        f.write("window.KML_METADATA = ")
        json.dump(meta_data, f, separators=(",", ":"), sort_keys=True)
        f.write(";")

    file_size = meta_file.stat().st_size

    logger.info("  ✓ Metadata: %.1f KB", file_size / 1024)

    return str(meta_file), file_size
