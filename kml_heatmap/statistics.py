"""Statistics of the generated site.

All numeric flight statistics (distances, altitudes, times, speeds) come from
the exported segments through ``export_reconciler.YearAggregate``; the
aircraft list and the airport names come from the path metadata and the
deduplicated airports. ``build_statistics`` assembles all of it once, so no
other module patches the dictionary afterwards.
"""

from typing import TYPE_CHECKING, TypedDict

from .aircraft import lookup_aircraft_model
from .constants import FEET_TO_METERS, KM_TO_NAUTICAL_MILES, METERS_TO_FEET
from .helpers import format_flight_time
from .logger import logger

if TYPE_CHECKING:
    from collections.abc import Iterable, Mapping

    from .export_reconciler import YearAggregate
    from .types import AircraftInfo, PathMetadata, Statistics

__all__ = [
    "AircraftStats",
    "aggregate_aircraft_stats",
    "build_statistics",
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
            if entry["type"] is None and atype is not None:
                entry["type"] = atype
            # Only count unique filenames (each file = one flight)
            if filename and filename not in entry["files"]:
                entry["files"].add(filename)
                entry["count"] += 1

        if atype:
            aircraft_types.add(atype)

    return aircraft_flights, aircraft_types


def _create_aircraft_list_with_models(
    aircraft_flights: dict[str, _AircraftFlights],
    aircraft_data: Mapping[str, str] | None,
    aggregate: YearAggregate | None,
) -> list[AircraftInfo]:
    """Create sorted aircraft list with model lookups and per-aircraft totals."""
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

        seconds = aggregate.aircraft_time_seconds.get(reg, 0.0) if aggregate else 0.0
        distance = aggregate.aircraft_distance_km.get(reg, 0.0) if aggregate else 0.0
        aircraft_list.append(
            {
                "registration": reg,
                "type": info["type"],
                "model": full_model,
                "flights": info["count"],
                "flight_time_seconds": seconds,
                "flight_time_str": format_flight_time(seconds),
                "flight_distance_km": distance,
            }
        )

    return aircraft_list


def aggregate_aircraft_stats(
    all_path_metadata: list[PathMetadata],
    aircraft_data: Mapping[str, str] | None = None,
    aggregate: YearAggregate | None = None,
) -> AircraftStats:
    """Aggregate aircraft statistics from metadata (and the segment totals)."""
    aircraft_flights, aircraft_types = _build_aircraft_flights_map(all_path_metadata)
    aircraft_list = _create_aircraft_list_with_models(
        aircraft_flights, aircraft_data, aggregate
    )

    return {
        "num_aircraft": len(aircraft_flights),
        "aircraft_types": sorted(aircraft_types),
        "aircraft_list": aircraft_list,
    }


def build_statistics(
    aggregate: YearAggregate,
    all_path_metadata: list[PathMetadata],
    airport_names: Iterable[str] = (),
    aircraft_data: Mapping[str, str] | None = None,
) -> Statistics:
    """Assemble the complete statistics dictionary.

    ``aggregate`` holds the numbers reconciled from the exported segments,
    ``all_path_metadata`` feeds the aircraft list and ``airport_names`` are
    the names that made it into the airports export.
    """
    aircraft = aggregate_aircraft_stats(all_path_metadata, aircraft_data, aggregate)
    names = sorted(airport_names)

    if aggregate.min_altitude_ft is not None and aggregate.max_altitude_ft is not None:
        min_altitude_ft: float | None = aggregate.min_altitude_ft
        max_altitude_ft: float | None = aggregate.max_altitude_ft
        min_altitude_m: float | None = aggregate.min_altitude_ft * FEET_TO_METERS
        max_altitude_m: float | None = aggregate.max_altitude_ft * FEET_TO_METERS
    else:
        min_altitude_ft = max_altitude_ft = None
        min_altitude_m = max_altitude_m = None

    most_common_ft: float | None = None
    most_common_m: float | None = None
    if aggregate.cruise_altitude_bins:
        most_common_bin = min(
            aggregate.cruise_altitude_bins,
            key=lambda k: (-aggregate.cruise_altitude_bins[k], k),
        )
        most_common_ft = most_common_bin
        most_common_m = round(most_common_bin * FEET_TO_METERS, 1)

    return {
        "total_points": aggregate.total_points,
        "num_paths": aggregate.num_paths,
        "total_distance_km": aggregate.total_distance_km,
        "total_distance_nm": aggregate.total_distance_km * KM_TO_NAUTICAL_MILES,
        "min_altitude_m": min_altitude_m,
        "max_altitude_m": max_altitude_m,
        "min_altitude_ft": min_altitude_ft,
        "max_altitude_ft": max_altitude_ft,
        "total_altitude_gain_m": aggregate.total_altitude_gain_m,
        "total_altitude_gain_ft": aggregate.total_altitude_gain_m * METERS_TO_FEET,
        "total_flight_time_seconds": aggregate.total_flight_time_seconds,
        "total_flight_time_str": format_flight_time(
            aggregate.total_flight_time_seconds
        ),
        "avg_groundspeed_knots": (
            aggregate.groundspeed_sum / aggregate.groundspeed_count
            if aggregate.groundspeed_count > 0
            else 0.0
        ),
        "max_groundspeed_knots": round(aggregate.max_groundspeed_knots, 1),
        "cruise_speed_knots": (
            aggregate.cruise_distance_nm / aggregate.cruise_time_hours
            if aggregate.cruise_time_hours > 0
            else 0.0
        ),
        "most_common_cruise_altitude_ft": most_common_ft,
        "most_common_cruise_altitude_m": most_common_m,
        "longest_flight_km": round(aggregate.longest_flight_km, 1),
        "longest_flight_nm": round(
            aggregate.longest_flight_km * KM_TO_NAUTICAL_MILES, 1
        ),
        "num_airports": len(names),
        "airport_names": names,
        "num_aircraft": aircraft["num_aircraft"],
        "aircraft_types": aircraft["aircraft_types"],
        "aircraft_list": aircraft["aircraft_list"],
    }
