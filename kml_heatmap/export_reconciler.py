"""Statistics reconciliation from exported segment data."""

from .constants import FEET_TO_METERS, METERS_TO_FEET
from .geometry import haversine_distance
from .helpers import format_flight_time
from .types import PathInfo, PathSegment, Statistics


def _recalculate_stats_from_segments(
    stats: Statistics,
    segments: list[PathSegment],
    path_info_list: list[PathInfo],
) -> None:
    """Recalculate statistics from exported segment data (authoritative source).

    The initial stats from statistics.py are computed from raw parsed data, but
    the frontend only sees the exported segments. This function overwrites stats
    to match the segment data exactly, ensuring the statistics panel is consistent
    with what the frontend can independently verify.
    """
    stats["total_points"] = len(segments) * 2

    if not segments:
        return

    altitudes_m = [seg.get("altitude_m") or 0.0 for seg in segments]
    min_alt_m = min(altitudes_m)
    max_alt_m = max(altitudes_m)
    stats["min_altitude_m"] = float(min_alt_m)
    stats["max_altitude_m"] = float(max_alt_m)
    stats["min_altitude_ft"] = float(min_alt_m) * METERS_TO_FEET
    stats["max_altitude_ft"] = float(max_alt_m) * METERS_TO_FEET

    cruise_threshold = float(min_alt_m) * METERS_TO_FEET + 1000

    total_gain_m = 0.0
    prev_alt = None
    groundspeed_sum = 0.0
    groundspeed_count = 0
    cruise_speed_sum = 0.0
    cruise_speed_count = 0
    altitude_bins: dict[int, int] = {}
    path_durations: dict[int, list[float]] = {}

    for seg in segments:
        alt_m = float(seg.get("altitude_m") or 0)
        alt_ft = float(seg.get("altitude_ft") or 0)
        gs = float(seg.get("groundspeed_knots") or 0)

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
            seg_time = seg.get("time")
            if seg_time is not None:
                bin_alt = round(alt_ft / 100) * 100
                altitude_bins[bin_alt] = altitude_bins.get(bin_alt, 0) + 1

        seg_time = seg.get("time")
        if seg_time is not None and "path_id" in seg:
            path_id = seg["path_id"]
            if path_id not in path_durations:
                path_durations[path_id] = []
            path_durations[path_id].append(seg_time)

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
            stats["most_common_cruise_altitude_ft"] * FEET_TO_METERS
        )

    total_flight_time = 0.0
    for times in path_durations.values():
        if len(times) >= 2:
            total_flight_time += max(times) - min(times)
    stats["total_flight_time_seconds"] = total_flight_time

    if stats.get("aircraft_list"):
        aircraft_times: dict[str, float] = {}
        aircraft_distances: dict[str, float] = {}

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
