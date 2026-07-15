"""Statistics calculation for flight data."""

from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from .geometry import haversine_distance, extract_altitudes
from .aircraft import lookup_aircraft_model
from .airports import is_point_marker
from .constants import METERS_TO_FEET, KM_TO_NAUTICAL_MILES, SECONDS_PER_HOUR
from .helpers import parse_iso_timestamp, format_flight_time
from .logger import logger
from .types import PathMetadata, Statistics

__all__ = [
    "calculate_statistics",
    "calculate_basic_stats",
    "calculate_altitude_stats",
    "calculate_flight_time",
    "aggregate_aircraft_stats",
    "extract_timestamps_from_path",
]


def extract_timestamps_from_path(path: list[list[Any]]) -> list[float]:
    """Extract timestamps from a path's coordinates."""
    timestamps = []
    for coord in path:
        if len(coord) >= 4 and coord[3] is not None:
            timestamp = coord[3]
            # Parse timestamp if it's a string (ISO format)
            if isinstance(timestamp, str):
                dt = parse_iso_timestamp(timestamp)
                if dt:
                    timestamp = dt.timestamp()
                else:
                    continue
            timestamps.append(timestamp)
    return timestamps


def calculate_basic_stats(valid_paths: list[list[list[float]]]) -> dict[str, float]:
    """Calculate basic distance and altitude gain statistics."""
    total_distance_km = 0.0
    total_gain_m = 0.0

    for path in valid_paths:
        for i in range(len(path) - 1):
            # Handle both 3-element [lat,lon,alt] and 4-element [lat,lon,alt,timestamp]
            lat1, lon1, alt1 = path[i][0], path[i][1], path[i][2]
            lat2, lon2, alt2 = path[i + 1][0], path[i + 1][1], path[i + 1][2]

            # Add to total distance
            total_distance_km += haversine_distance(lat1, lon1, lat2, lon2)

            # Calculate altitude change (only track gain)
            alt_change = alt2 - alt1
            if alt_change > 0:
                total_gain_m += alt_change

    return {
        "total_distance_km": total_distance_km,
        "total_altitude_gain_m": total_gain_m,
    }


def calculate_altitude_stats(
    valid_paths: list[list[list[float]]],
) -> dict[str, float | None]:
    """Calculate altitude statistics from valid paths."""
    # Collect all altitudes
    all_altitudes = extract_altitudes(valid_paths)

    if not all_altitudes:
        return {
            "min_altitude_m": None,
            "max_altitude_m": None,
            "min_altitude_ft": None,
            "max_altitude_ft": None,
        }

    min_alt_m = min(all_altitudes)
    max_alt_m = max(all_altitudes)

    return {
        "min_altitude_m": min_alt_m,
        "max_altitude_m": max_alt_m,
        "min_altitude_ft": min_alt_m * METERS_TO_FEET,
        "max_altitude_ft": max_alt_m * METERS_TO_FEET,
    }


def calculate_flight_time(valid_paths: list[list[list[float]]]) -> dict[str, Any]:
    """Calculate total flight time from path timestamps."""
    total_seconds = 0.0
    paths_with_timestamps = 0

    for path in valid_paths:
        timestamps = extract_timestamps_from_path(path)

        # Calculate flight duration from min/max timestamps
        if len(timestamps) >= 2:
            min_time = min(timestamps)
            max_time = max(timestamps)
            duration = max_time - min_time
            if duration > 0:
                total_seconds += duration
                paths_with_timestamps += 1

    return {
        "total_seconds": total_seconds,
        "paths_with_timestamps": paths_with_timestamps,
    }


def _build_aircraft_flights_map(
    all_path_metadata: list[PathMetadata],
) -> tuple[dict[str, dict[str, Any]], dict[int, str], set, set]:
    """Build aircraft flights mapping from metadata."""
    aircraft_registrations = set()
    aircraft_types = set()
    aircraft_flights: dict[str, dict[str, Any]] = {}
    path_to_aircraft = {}

    for idx, metadata in enumerate(all_path_metadata):
        reg = metadata.get("aircraft_registration")
        atype = metadata.get("aircraft_type")
        filename = metadata.get("filename")

        if reg:
            aircraft_registrations.add(reg)
            if reg not in aircraft_flights:
                aircraft_flights[reg] = {
                    "type": atype,
                    "count": 0,
                    "files": set(),
                    "flight_time_seconds": 0,
                }

            # Only count unique filenames (each file = one flight)
            if filename and filename not in aircraft_flights[reg]["files"]:
                aircraft_flights[reg]["files"].add(filename)
                aircraft_flights[reg]["count"] += 1

            # Store the mapping for later use
            path_to_aircraft[idx] = reg

        if atype:
            aircraft_types.add(atype)

    return aircraft_flights, path_to_aircraft, aircraft_registrations, aircraft_types


def _calculate_aircraft_flight_times(
    all_path_groups: list[list[list[float]]],
    path_to_aircraft: dict[int, str],
    aircraft_flights: dict[str, dict[str, Any]],
) -> None:
    """Calculate flight times and distances for each aircraft."""
    for idx, path in enumerate(all_path_groups):
        # Skip short paths
        if len(path) < 2 or idx not in path_to_aircraft:
            continue

        reg = path_to_aircraft[idx]
        timestamps = extract_timestamps_from_path(path)

        # Calculate path distance
        path_distance_km = 0.0
        for i in range(len(path) - 1):
            lat1, lon1 = path[i][0], path[i][1]
            lat2, lon2 = path[i + 1][0], path[i + 1][1]
            path_distance_km += haversine_distance(lat1, lon1, lat2, lon2)

        # Initialize distance tracking if needed
        if "flight_distance_km" not in aircraft_flights[reg]:
            aircraft_flights[reg]["flight_distance_km"] = 0.0

        aircraft_flights[reg]["flight_distance_km"] += path_distance_km

        # Calculate flight duration from min/max timestamps
        if len(timestamps) >= 2:
            min_time = min(timestamps)
            max_time = max(timestamps)
            duration = max_time - min_time
            if duration > 0:
                aircraft_flights[reg]["flight_time_seconds"] += duration

                # Track years seen for this aircraft
                if "years" not in aircraft_flights[reg]:
                    aircraft_flights[reg]["years"] = set()

                # Extract year from timestamp
                dt = datetime.fromtimestamp(min_time, tz=timezone.utc)
                aircraft_flights[reg]["years"].add(str(dt.year))


def _create_aircraft_list_with_models(
    aircraft_flights: dict[str, dict[str, Any]],
    aircraft_file: Path | None = None,
) -> list[dict[str, Any]]:
    """Create sorted aircraft list with model lookups."""
    aircraft_list = []
    logger.info("✈️  Looking up aircraft model information...")

    for reg, info in sorted(
        aircraft_flights.items(), key=lambda x: x[1]["count"], reverse=True
    ):
        full_model = lookup_aircraft_model(reg, aircraft_file)
        if full_model:
            logger.info(f"  ✓ {reg}: {full_model}")
        else:
            full_model = info["type"]  # Fallback to basic type if lookup fails
            if full_model:
                logger.info(f"  ⚠ {reg}: {full_model} (lookup failed, using KML type)")

        flight_time_str = format_flight_time(info["flight_time_seconds"])

        aircraft_list.append(
            {
                "registration": reg,
                "type": info["type"],
                "model": full_model,
                "flights": info["count"],
                "flight_time_seconds": info["flight_time_seconds"],
                "flight_time_str": flight_time_str,
                "flight_distance_km": info.get("flight_distance_km", 0.0),
            }
        )

    return aircraft_list


def aggregate_aircraft_stats(
    all_path_metadata: list[PathMetadata],
    all_path_groups: list[list[list[float]]],
    aircraft_file: Path | None = None,
) -> dict[str, Any]:
    """Aggregate aircraft statistics from metadata and paths."""
    # Build aircraft flights map
    aircraft_flights, path_to_aircraft, aircraft_registrations, aircraft_types = (
        _build_aircraft_flights_map(all_path_metadata)
    )

    # Calculate flight times per aircraft
    _calculate_aircraft_flight_times(
        all_path_groups, path_to_aircraft, aircraft_flights
    )

    # Create aircraft list with model lookups
    aircraft_list = _create_aircraft_list_with_models(aircraft_flights, aircraft_file)

    return {
        "num_aircraft": len(aircraft_registrations),
        "aircraft_types": sorted(aircraft_types),
        "aircraft_list": aircraft_list,
    }


def calculate_statistics(
    all_coordinates: list[list[float]],
    all_path_groups: list[list[list[float]]],
    all_path_metadata: list[PathMetadata] | None = None,
    aircraft_file: Path | None = None,
) -> Statistics:
    """Calculate statistics from coordinate and path data."""
    # Count only actual flight paths, not point markers
    num_flight_paths = 0
    if all_path_metadata:
        num_flight_paths = sum(
            1
            for metadata in all_path_metadata
            if not is_point_marker(metadata.get("airport_name", ""))
        )
    else:
        # Fallback if no metadata available
        num_flight_paths = len(all_path_groups)

    # Initialize base stats
    stats: Statistics = {
        "total_points": len(all_coordinates),
        "num_paths": num_flight_paths,
        "total_distance_km": 0.0,
        "total_distance_nm": 0.0,
        "total_altitude_gain_m": 0.0,
        "total_altitude_gain_ft": 0.0,
        "min_altitude_m": None,
        "max_altitude_m": None,
        "min_altitude_ft": None,
        "max_altitude_ft": None,
        "total_flight_time_seconds": 0,
        "total_flight_time_str": None,
        "average_groundspeed_knots": 0,
        "max_groundspeed_knots": 0,
    }

    if not all_path_groups:
        return stats

    # Filter out short paths
    valid_paths = [path for path in all_path_groups if len(path) >= 2]
    if not valid_paths:
        return stats

    # Calculate basic distance and altitude gain statistics
    basic_stats = calculate_basic_stats(valid_paths)
    stats["total_distance_km"] = basic_stats["total_distance_km"]
    stats["total_distance_nm"] = basic_stats["total_distance_km"] * KM_TO_NAUTICAL_MILES
    stats["total_altitude_gain_m"] = basic_stats["total_altitude_gain_m"]
    stats["total_altitude_gain_ft"] = (
        basic_stats["total_altitude_gain_m"] * METERS_TO_FEET
    )

    # Calculate altitude statistics
    altitude_stats = calculate_altitude_stats(valid_paths)
    stats["min_altitude_m"] = altitude_stats["min_altitude_m"]
    stats["max_altitude_m"] = altitude_stats["max_altitude_m"]
    stats["min_altitude_ft"] = altitude_stats["min_altitude_ft"]
    stats["max_altitude_ft"] = altitude_stats["max_altitude_ft"]

    # Calculate flight time statistics
    time_stats = calculate_flight_time(valid_paths)
    total_seconds = float(time_stats["total_seconds"])
    stats["total_flight_time_seconds"] = total_seconds
    stats["total_flight_time_str"] = format_flight_time(total_seconds)

    # Debug output
    if time_stats["paths_with_timestamps"] > 0:
        logger.debug(
            f"Calculated flight time from {time_stats['paths_with_timestamps']}/{len(valid_paths)} "
            f"paths with timestamps"
        )

    # Aggregate aircraft statistics
    if all_path_metadata:
        aircraft_stats = aggregate_aircraft_stats(
            all_path_metadata, all_path_groups, aircraft_file
        )
        stats["num_aircraft"] = aircraft_stats["num_aircraft"]
        stats["aircraft_types"] = aircraft_stats["aircraft_types"]
        stats["aircraft_list"] = aircraft_stats["aircraft_list"]

    # Calculate average groundspeed
    flight_time = stats.get("total_flight_time_seconds", 0)
    distance_nm = stats.get("total_distance_nm", 0)
    if isinstance(flight_time, (int, float)) and isinstance(distance_nm, (int, float)):
        if flight_time > 0 and distance_nm > 0:
            hours = flight_time / SECONDS_PER_HOUR
            stats["average_groundspeed_knots"] = distance_nm / hours

    return stats
