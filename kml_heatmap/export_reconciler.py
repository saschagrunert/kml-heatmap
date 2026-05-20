"""Statistics reconciliation from exported segment data."""

from typing import Any, Dict, List

from .constants import METERS_TO_FEET
from .geometry import haversine_distance
from .helpers import format_flight_time


def _recalculate_stats_from_segments(
    stats: Dict[str, Any],
    segments: List[Dict[str, Any]],
    path_info_list: List[Dict[str, Any]],
) -> None:
    """Recalculate statistics from exported segment data (authoritative source).

    The initial stats from statistics.py are computed from raw parsed data, but
    the frontend only sees the exported segments. This function overwrites stats
    to match the segment data exactly, ensuring the statistics panel is consistent
    with what the frontend can independently verify. Fields overwritten:
    total_points, altitude ranges, altitude gain, groundspeed stats, cruise
    altitude, flight time, and per-aircraft times/distances.

    Args:
        stats: Statistics dictionary (modified in place)
        segments: Full resolution path segments
        path_info_list: Full resolution path info entries
    """
    stats["total_points"] = len(segments) * 2

    if not segments:
        return

    altitudes_m = [seg.get("altitude_m", 0) for seg in segments]
    min_alt_m = min(altitudes_m)
    max_alt_m = max(altitudes_m)
    stats["min_altitude_m"] = min_alt_m
    stats["max_altitude_m"] = max_alt_m
    stats["min_altitude_ft"] = min_alt_m * METERS_TO_FEET
    stats["max_altitude_ft"] = max_alt_m * METERS_TO_FEET

    cruise_threshold = min_alt_m * METERS_TO_FEET + 1000

    total_gain_m = 0.0
    prev_alt = None
    groundspeed_sum = 0.0
    groundspeed_count = 0
    cruise_speed_sum = 0.0
    cruise_speed_count = 0
    altitude_bins: Dict[int, int] = {}
    path_durations: Dict[int, List[float]] = {}

    for seg in segments:
        alt_m = seg.get("altitude_m", 0)
        alt_ft = seg.get("altitude_ft", 0)
        gs = seg.get("groundspeed_knots", 0)

        if prev_alt is not None and alt_m > prev_alt:
            total_gain_m += alt_m - prev_alt
        prev_alt = alt_m

        if gs > 0:
            groundspeed_sum += gs
            groundspeed_count += 1

        if alt_ft > cruise_threshold:
            if gs > 0:
                cruise_speed_sum += gs
                cruise_speed_count += 1
            if "time" in seg:
                bin_alt = round(alt_ft / 100) * 100
                altitude_bins[bin_alt] = altitude_bins.get(bin_alt, 0) + 1

        if "time" in seg and "path_id" in seg:
            path_id = seg["path_id"]
            if path_id not in path_durations:
                path_durations[path_id] = []
            path_durations[path_id].append(seg["time"])

    stats["total_altitude_gain_m"] = total_gain_m
    stats["total_altitude_gain_ft"] = total_gain_m * METERS_TO_FEET
    stats["average_groundspeed_knots"] = (
        groundspeed_sum / groundspeed_count if groundspeed_count > 0 else 0
    )
    stats["cruise_speed_knots"] = (
        cruise_speed_sum / cruise_speed_count if cruise_speed_count > 0 else 0
    )

    if altitude_bins:
        stats["most_common_cruise_altitude_ft"] = max(
            altitude_bins.keys(), key=lambda k: altitude_bins[k]
        )
        stats["most_common_cruise_altitude_m"] = round(
            stats["most_common_cruise_altitude_ft"] * 0.3048
        )

    total_flight_time = 0.0
    for times in path_durations.values():
        if len(times) >= 2:
            total_flight_time += max(times) - min(times)
    stats["total_flight_time_seconds"] = total_flight_time

    if stats.get("aircraft_list"):
        aircraft_times: Dict[str, float] = {}
        aircraft_distances: Dict[str, float] = {}

        for pi in path_info_list:
            reg = pi.get("aircraft_registration")
            path_id = pi.get("id")
            if reg and path_id is not None and path_id in path_durations:
                if reg not in aircraft_times:
                    aircraft_times[reg] = 0
                    aircraft_distances[reg] = 0.0
                times = path_durations[path_id]
                if len(times) >= 2:
                    aircraft_times[reg] += max(times) - min(times)

        for segment in segments:
            path_id = segment.get("path_id")
            if path_id is not None and path_id < len(path_info_list):
                pi = path_info_list[path_id]
                reg = pi.get("aircraft_registration")
                if reg and reg in aircraft_distances:
                    coords = segment.get("coords", [])
                    if len(coords) == 2:
                        lat1, lon1 = coords[0]
                        lat2, lon2 = coords[1]
                        aircraft_distances[reg] += haversine_distance(
                            lat1, lon1, lat2, lon2
                        )

        for aircraft in stats["aircraft_list"]:
            reg = aircraft["registration"]
            if reg in aircraft_times:
                flight_time_seconds = aircraft_times[reg]
                flight_distance_km = aircraft_distances.get(reg, 0.0)
                aircraft["flight_time_seconds"] = flight_time_seconds
                aircraft["flight_distance_km"] = flight_distance_km
                aircraft["flight_time_str"] = format_flight_time(flight_time_seconds)
