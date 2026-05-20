"""Airport and metadata export writers."""

import math
import os
import json
from typing import Any, Dict, List, Optional, Tuple

from .airports import extract_airport_name
from .logger import logger
from .constants import HEATMAP_GRADIENT


def export_airports_data(
    unique_airports: List[Dict[str, Any]],
    output_dir: str,
    strip_timestamps: bool = False,
) -> Tuple[str, int]:
    """
    Export airport data to JSON file.

    Args:
        unique_airports: List of airport dictionaries
        output_dir: Output directory
        strip_timestamps: Whether to strip timestamps for privacy

    Returns:
        Tuple of (output_file_path, file_size_bytes)
    """
    valid_airports = []
    seen_locations = set()

    for apt in unique_airports:
        full_name = apt.get("name", "Unknown")
        is_at_path_end = apt.get("is_at_path_end", False)
        airport_name = extract_airport_name(full_name, is_at_path_end)

        if not airport_name:
            continue

        location_key = f"{apt['lat']:.4f},{apt['lon']:.4f}"

        if location_key in seen_locations:
            continue

        seen_locations.add(location_key)

        airport_data = {
            "lat": apt["lat"],
            "lon": apt["lon"],
            "name": airport_name,
            "flight_count": len(apt["timestamps"]) if apt["timestamps"] else 1,
        }

        if not strip_timestamps:
            airport_data["timestamps"] = apt["timestamps"]

        valid_airports.append(airport_data)

    airports_data = {"airports": valid_airports}
    airports_file = os.path.join(output_dir, "airports.js")

    with open(airports_file, "w") as f:
        f.write("window.KML_AIRPORTS = ")
        json.dump(airports_data, f, separators=(",", ":"), sort_keys=True)
        f.write(";")

    file_size = os.path.getsize(airports_file)

    logger.info(
        f"  ✓ Airports: {len(valid_airports)} locations ({file_size / 1024:.1f} KB)"
    )

    return airports_file, file_size


def export_metadata(
    stats: Dict[str, Any],
    min_alt_m: float,
    max_alt_m: float,
    min_groundspeed_knots: float,
    max_groundspeed_knots: float,
    available_years: List[int],
    output_dir: str,
    file_structure: Optional[Dict[str, Any]] = None,
) -> Tuple[str, int]:
    """
    Export metadata including statistics and ranges.

    Args:
        stats: Statistics dictionary
        min_alt_m: Minimum altitude in meters
        max_alt_m: Maximum altitude in meters
        min_groundspeed_knots: Minimum groundspeed
        max_groundspeed_knots: Maximum groundspeed
        available_years: List of available years
        output_dir: Output directory
        file_structure: File structure mapping (year -> resolution list)

    Returns:
        Tuple of (output_file_path, file_size_bytes)
    """
    if not math.isfinite(min_groundspeed_knots):
        min_groundspeed_knots = 0.0
    if not math.isfinite(max_groundspeed_knots):
        max_groundspeed_knots = 0.0

    meta_data = {
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

    meta_file = os.path.join(output_dir, "metadata.js")

    with open(meta_file, "w") as f:
        f.write("window.KML_METADATA = ")
        json.dump(meta_data, f, separators=(",", ":"), sort_keys=True)
        f.write(";")

    file_size = os.path.getsize(meta_file)

    logger.info(f"  ✓ Metadata: {file_size / 1024:.1f} KB")

    return meta_file, file_size


def collect_unique_years(all_path_metadata: List[Dict[str, Any]]) -> List[int]:
    """
    Collect unique years from path metadata.

    Args:
        all_path_metadata: List of path metadata dictionaries

    Returns:
        Sorted list of unique years
    """
    unique_years = set()

    for meta in all_path_metadata:
        year = meta.get("year")
        if year:
            unique_years.add(year)

    return sorted(list(unique_years))
