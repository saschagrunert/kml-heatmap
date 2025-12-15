"""Data export functionality for progressive loading heatmaps.

This module handles the export of flight data to JSON files optimized for
progressive loading in web browsers. The export system creates multiple
resolution levels to balance detail with file size.

Multi-Resolution Strategy:
The system exports data at 5 different resolution levels:
1. z0-4 (continent): Highly simplified for initial map load
2. z5-7 (country): Medium simplification for country-level view
3. z8-10 (regional): Lower simplification for regional detail
4. z11-13 (city): Minimal simplification for city-level detail
5. z14+ (full): Complete data for maximum zoom

Each level uses:
- Ramer-Douglas-Peucker (RDP) algorithm for path simplification
- Different epsilon values for varying detail levels
- Separate JSON files loaded on-demand based on zoom level

File Structure:
- data_z0_4.json through data_z14_plus.json: Path and segment data
- airports.json: Deduplicated airport locations
- metadata.json: Statistics and configuration

Performance Optimizations:
- JSON files use compact separators (no whitespace)
- Sorted keys for better compression
- Coordinates rounded to appropriate precision
- Privacy mode strips timestamps when requested

This progressive loading approach dramatically improves:
- Initial page load time (loads only coarse data first)
- Mobile performance (less data transferred)
- User experience (map renders immediately)
"""

import os
import json
from typing import List, Dict, Any, Tuple

from .airports import extract_airport_name
from .logger import logger
from .constants import HEATMAP_GRADIENT


def downsample_coordinates(
    coordinates: List[List[float]], factor: int
) -> List[List[float]]:
    """
    Simple downsampling by keeping every Nth point.

    Args:
        coordinates: List of [lat, lon] coordinates
        factor: Keep every Nth point

    Returns:
        Downsampled coordinates
    """
    if factor <= 1:
        return coordinates
    return [coordinates[i] for i in range(0, len(coordinates), factor)]


def export_resolution_data(
    resolution_name: str,
    resolution_config: Dict[str, Any],
    all_coordinates: List[List[float]],
    path_segments: List[Dict[str, Any]],
    path_info: List[Dict[str, Any]],
    output_dir: str,
) -> Tuple[str, int]:
    """
    Export data for a single resolution level.

    Args:
        resolution_name: Name of the resolution (e.g., 'z14_plus')
        resolution_config: Resolution configuration dict
        all_coordinates: Original coordinates
        path_segments: Calculated path segments
        path_info: Path metadata
        output_dir: Output directory

    Returns:
        Tuple of (output_file_path, file_size_bytes)
    """
    data = {
        "coordinates": all_coordinates,
        "path_segments": path_segments,
        "path_info": path_info,
        "resolution": resolution_name,
        "original_points": len(all_coordinates),
        "downsampled_points": len(all_coordinates),
        "compression_ratio": 100.0,
    }

    output_file = os.path.join(output_dir, f"data_{resolution_name}.json")

    with open(output_file, "w") as f:
        json.dump(data, f, separators=(",", ":"), sort_keys=True)

    file_size = os.path.getsize(output_file)

    logger.info(
        f"  ✓ {resolution_config['description']}: "
        f"{len(all_coordinates):,} points ({file_size / 1024:.1f} KB)"
    )

    return output_file, file_size


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
    airports_file = os.path.join(output_dir, "airports.json")

    with open(airports_file, "w") as f:
        json.dump(airports_data, f, separators=(",", ":"), sort_keys=True)

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

    Returns:
        Tuple of (output_file_path, file_size_bytes)
    """
    # Handle infinity case
    if min_groundspeed_knots == float("inf"):
        min_groundspeed_knots = 0.0

    meta_data = {
        "stats": stats,
        "min_alt_m": min_alt_m,
        "max_alt_m": max_alt_m,
        "min_groundspeed_knots": round(min_groundspeed_knots, 1),
        "max_groundspeed_knots": round(max_groundspeed_knots, 1),
        "gradient": HEATMAP_GRADIENT,
        "available_years": available_years,
    }

    meta_file = os.path.join(output_dir, "metadata.json")

    with open(meta_file, "w") as f:
        json.dump(meta_data, f, separators=(",", ":"), sort_keys=True)

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
