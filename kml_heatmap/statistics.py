"""Statistics skeleton built from path metadata.

All numeric flight statistics (distances, altitudes, times, speeds) are
derived from the exported segments by ``export_reconciler.YearAggregate``.
This module builds the base structure and the per-aircraft list.
"""

from typing import TYPE_CHECKING, TypedDict

from .aircraft import lookup_aircraft_model
from .helpers import format_flight_time
from .logger import logger

if TYPE_CHECKING:
    from collections.abc import Mapping

    from .types import AircraftInfo, PathMetadata, Statistics

__all__ = [
    "AircraftStats",
    "aggregate_aircraft_stats",
    "calculate_statistics",
]


class _AircraftFlights(TypedDict):
    type: str | None
    count: int
    files: set[str]


class AircraftStats(TypedDict):
    """Aircraft summary derived from path metadata."""

    num_aircraft: int
    aircraft_types: list[str]
    aircraft_list: list[AircraftInfo]


def _build_aircraft_flights_map(
    all_path_metadata: list[PathMetadata],
) -> tuple[dict[str, _AircraftFlights], set[str]]:
    """Count flights (unique files) per aircraft registration."""
    aircraft_types: set[str] = set()
    aircraft_flights: dict[str, _AircraftFlights] = {}

    for metadata in all_path_metadata:
        reg = metadata.get("aircraft_registration")
        atype = metadata.get("aircraft_type")
        filename = metadata.get("filename")

        if reg:
            entry = aircraft_flights.setdefault(
                reg, {"type": atype, "count": 0, "files": set()}
            )
            # Only count unique filenames (each file = one flight)
            if filename and filename not in entry["files"]:
                entry["files"].add(filename)
                entry["count"] += 1

        if atype:
            aircraft_types.add(atype)

    return aircraft_flights, aircraft_types


def _create_aircraft_list_with_models(
    aircraft_flights: dict[str, _AircraftFlights],
    aircraft_data: Mapping[str, str] | None = None,
) -> list[AircraftInfo]:
    """Create sorted aircraft list with model lookups."""
    aircraft_list: list[AircraftInfo] = []
    logger.info("✈️  Looking up aircraft model information...")

    for reg, info in sorted(
        aircraft_flights.items(), key=lambda item: item[1]["count"], reverse=True
    ):
        full_model = lookup_aircraft_model(reg, aircraft_data)
        if full_model:
            logger.info("  ✓ %s: %s", reg, full_model)
        else:
            full_model = info["type"]  # Fallback to basic type if lookup fails
            if full_model:
                logger.info(
                    "  ⚠ %s: %s (lookup failed, using KML type)", reg, full_model
                )

        aircraft_list.append(
            {
                "registration": reg,
                "type": info["type"],
                "model": full_model,
                "flights": info["count"],
                "flight_time_seconds": 0.0,
                "flight_time_str": format_flight_time(0.0),
                "flight_distance_km": 0.0,
            }
        )

    return aircraft_list


def aggregate_aircraft_stats(
    all_path_metadata: list[PathMetadata],
    aircraft_data: Mapping[str, str] | None = None,
) -> AircraftStats:
    """Aggregate aircraft statistics from metadata."""
    aircraft_flights, aircraft_types = _build_aircraft_flights_map(all_path_metadata)
    aircraft_list = _create_aircraft_list_with_models(aircraft_flights, aircraft_data)

    return {
        "num_aircraft": len(aircraft_flights),
        "aircraft_types": sorted(aircraft_types),
        "aircraft_list": aircraft_list,
    }


def calculate_statistics(
    all_path_metadata: list[PathMetadata] | None = None,
    aircraft_data: Mapping[str, str] | None = None,
) -> Statistics:
    """Build the base statistics structure (numbers are filled by the exporter)."""
    stats: Statistics = {
        "total_points": 0,
        "num_paths": 0,
        "total_distance_km": 0.0,
        "total_distance_nm": 0.0,
        "total_altitude_gain_m": 0.0,
        "total_altitude_gain_ft": 0.0,
        "min_altitude_m": None,
        "max_altitude_m": None,
        "min_altitude_ft": None,
        "max_altitude_ft": None,
        "total_flight_time_seconds": 0.0,
        "total_flight_time_str": format_flight_time(0.0),
        "avg_groundspeed_knots": 0.0,
        "max_groundspeed_knots": 0.0,
    }

    if all_path_metadata:
        aircraft_stats = aggregate_aircraft_stats(all_path_metadata, aircraft_data)
        stats["num_aircraft"] = aircraft_stats["num_aircraft"]
        stats["aircraft_types"] = aircraft_stats["aircraft_types"]
        stats["aircraft_list"] = aircraft_stats["aircraft_list"]

    return stats
