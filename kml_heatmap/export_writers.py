"""Airport and metadata export writers."""

import json
import math
from pathlib import Path
from typing import Any

from .airports import extract_airport_name
from .constants import HEATMAP_GRADIENT
from .logger import logger
from .types import AirportData, PathMetadata, Statistics


def export_airports_data(
    unique_airports: list[AirportData],
    output_dir: str,
    strip_timestamps: bool = False,
) -> tuple[str, int]:
    """Export airport data to JSON file."""
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

        if not strip_timestamps:
            airport_data["timestamps"] = apt.get("timestamps", [])

        valid_airports.append(airport_data)

    airports_data = {"airports": valid_airports}
    airports_file = str(Path(output_dir) / "airports.js")

    with open(airports_file, "w") as f:
        f.write("window.KML_AIRPORTS = ")
        json.dump(airports_data, f, separators=(",", ":"), sort_keys=True)
        f.write(";")

    file_size = Path(airports_file).stat().st_size

    logger.info(
        f"  ✓ Airports: {len(valid_airports)} locations ({file_size / 1024:.1f} KB)"
    )

    return airports_file, file_size


def export_metadata(
    stats: Statistics,
    min_alt_m: float,
    max_alt_m: float,
    min_groundspeed_knots: float,
    max_groundspeed_knots: float,
    available_years: list[int],
    output_dir: str,
    file_structure: dict[str, Any] | None = None,
) -> tuple[str, int]:
    """Export metadata including statistics and ranges."""
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
        "gradient": HEATMAP_GRADIENT,
        "available_years": available_years,
    }

    if file_structure is not None:
        meta_data["file_structure"] = file_structure

    meta_file = str(Path(output_dir) / "metadata.js")

    with open(meta_file, "w") as f:
        f.write("window.KML_METADATA = ")
        json.dump(meta_data, f, separators=(",", ":"), sort_keys=True)
        f.write(";")

    file_size = Path(meta_file).stat().st_size

    logger.info(f"  ✓ Metadata: {file_size / 1024:.1f} KB")

    return meta_file, file_size


def collect_unique_years(all_path_metadata: list[PathMetadata]) -> list[int]:
    """Collect unique years from path metadata."""
    unique_years: set[int] = set()

    for meta in all_path_metadata:
        year = meta.get("year")
        if year:
            unique_years.add(year)

    return sorted(list(unique_years))
