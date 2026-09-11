"""Statistics derived from the exported segment data.

The exported segments are the only flight data the frontend sees, so every
numeric statistic is computed from them: each worker process aggregates its
year's segments into a compact ``YearAggregate`` and the main process merges
the aggregates; ``statistics.build_statistics`` turns the result into the
statistics dict. This keeps the statistics panel consistent with what the
frontend computes for its filters.
"""

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from .constants import (
    ALTITUDE_BIN_SIZE_FT,
    CRUISE_ALTITUDE_THRESHOLD_FT,
    FEET_TO_METERS,
    KM_TO_NAUTICAL_MILES,
)

if TYPE_CHECKING:
    from .types import SegmentRow

__all__ = ["YearAggregate"]

# Segment row layout: [lat, lon, altitude_ft, groundspeed_knots, time?]
SEGMENT_ALTITUDE_INDEX = 2
SEGMENT_SPEED_INDEX = 3
SEGMENT_TIME_INDEX = 4


@dataclass
class YearAggregate:
    """Reconciliation inputs accumulated from exported segments."""

    total_points: int = 0
    num_paths: int = 0
    total_distance_km: float = 0.0
    min_altitude_ft: float | None = None
    max_altitude_ft: float | None = None
    total_altitude_gain_m: float = 0.0
    max_groundspeed_knots: float = 0.0
    min_groundspeed_knots: float | None = None
    groundspeed_sum: float = 0.0
    groundspeed_count: int = 0
    cruise_distance_nm: float = 0.0
    cruise_time_hours: float = 0.0
    cruise_altitude_bins: dict[int, int] = field(default_factory=dict)
    longest_flight_km: float = 0.0
    total_flight_time_seconds: float = 0.0
    aircraft_time_seconds: dict[str, float] = field(default_factory=dict)
    aircraft_distance_km: dict[str, float] = field(default_factory=dict)

    @property
    def min_groundspeed_or_zero(self) -> float:
        """Minimum positive groundspeed, or 0 when no segment had a speed."""
        return self.min_groundspeed_knots or 0.0

    def add_path(
        self,
        segments: list[SegmentRow],
        distances_km: list[float],
        registration: str | None,
        altitude_range_ft: tuple[float, float] | None = None,
    ) -> None:
        """Accumulate one exported path (its segment rows and their distances).

        The flight time is the span of the segment times, exactly as the
        frontend computes it from the exported rows. Segment times are start
        offsets and zero-length (standstill) segments are not exported, so the
        span is the time between the first and the last movement; the source
        file's own time span would also count the standstill before and after
        and disagree with what the statistics panel shows.
        """
        self.num_paths += 1
        if not segments:
            return

        # Per-path ground level for AGL-based cruise detection
        min_alt_ft = min(seg[SEGMENT_ALTITUDE_INDEX] for seg in segments)

        # Exact range when the caller has it, otherwise the rounded rows
        path_min_ft, path_max_ft = altitude_range_ft or (
            min_alt_ft,
            max(seg[SEGMENT_ALTITUDE_INDEX] for seg in segments),
        )
        self.min_altitude_ft = (
            path_min_ft
            if self.min_altitude_ft is None
            else min(self.min_altitude_ft, path_min_ft)
        )
        self.max_altitude_ft = (
            path_max_ft
            if self.max_altitude_ft is None
            else max(self.max_altitude_ft, path_max_ft)
        )

        path_distance_km = 0.0
        path_gain_m = 0.0
        prev_alt_m: float | None = None
        times: list[float] = []

        for seg, distance_km in zip(segments, distances_km, strict=True):
            alt_ft = seg[SEGMENT_ALTITUDE_INDEX]
            groundspeed = seg[SEGMENT_SPEED_INDEX]
            path_distance_km += distance_km

            alt_m = alt_ft * FEET_TO_METERS
            if prev_alt_m is not None and alt_m > prev_alt_m:
                path_gain_m += alt_m - prev_alt_m
            prev_alt_m = alt_m

            if groundspeed > 0:
                self.max_groundspeed_knots = max(
                    self.max_groundspeed_knots, groundspeed
                )
                self.min_groundspeed_knots = (
                    groundspeed
                    if self.min_groundspeed_knots is None
                    else min(self.min_groundspeed_knots, groundspeed)
                )
                self.groundspeed_sum += groundspeed
                self.groundspeed_count += 1

                altitude_agl_ft = alt_ft - min_alt_ft
                if altitude_agl_ft > CRUISE_ALTITUDE_THRESHOLD_FT:
                    if distance_km > 0:
                        distance_nm = distance_km * KM_TO_NAUTICAL_MILES
                        self.cruise_distance_nm += distance_nm
                        self.cruise_time_hours += distance_nm / groundspeed
                    alt_bin = int(
                        round(altitude_agl_ft / ALTITUDE_BIN_SIZE_FT)
                        * ALTITUDE_BIN_SIZE_FT
                    )
                    self.cruise_altitude_bins[alt_bin] = (
                        self.cruise_altitude_bins.get(alt_bin, 0) + 1
                    )

            if len(seg) > SEGMENT_TIME_INDEX:
                times.append(seg[SEGMENT_TIME_INDEX])

        self.total_distance_km += path_distance_km
        self.longest_flight_km = max(self.longest_flight_km, path_distance_km)
        self.total_altitude_gain_m += path_gain_m

        flight_time = max(times) - min(times) if times else 0.0
        self.total_flight_time_seconds += flight_time

        if registration:
            self.aircraft_time_seconds[registration] = (
                self.aircraft_time_seconds.get(registration, 0.0) + flight_time
            )
            self.aircraft_distance_km[registration] = (
                self.aircraft_distance_km.get(registration, 0.0) + path_distance_km
            )

    def merge(self, other: YearAggregate) -> None:
        """Merge another aggregate (typically another year) into this one."""
        self.total_points += other.total_points
        self.num_paths += other.num_paths
        self.total_distance_km += other.total_distance_km
        for attr in ("min_altitude_ft", "min_groundspeed_knots"):
            other_value = getattr(other, attr)
            if other_value is not None:
                own_value = getattr(self, attr)
                setattr(
                    self,
                    attr,
                    other_value if own_value is None else min(own_value, other_value),
                )
        if other.max_altitude_ft is not None:
            self.max_altitude_ft = (
                other.max_altitude_ft
                if self.max_altitude_ft is None
                else max(self.max_altitude_ft, other.max_altitude_ft)
            )
        self.total_altitude_gain_m += other.total_altitude_gain_m
        self.max_groundspeed_knots = max(
            self.max_groundspeed_knots, other.max_groundspeed_knots
        )
        self.groundspeed_sum += other.groundspeed_sum
        self.groundspeed_count += other.groundspeed_count
        self.cruise_distance_nm += other.cruise_distance_nm
        self.cruise_time_hours += other.cruise_time_hours
        for alt_bin, count in other.cruise_altitude_bins.items():
            self.cruise_altitude_bins[alt_bin] = (
                self.cruise_altitude_bins.get(alt_bin, 0) + count
            )
        self.longest_flight_km = max(self.longest_flight_km, other.longest_flight_km)
        self.total_flight_time_seconds += other.total_flight_time_seconds
        for registration, seconds in other.aircraft_time_seconds.items():
            self.aircraft_time_seconds[registration] = (
                self.aircraft_time_seconds.get(registration, 0.0) + seconds
            )
        for registration, distance in other.aircraft_distance_km.items():
            self.aircraft_distance_km[registration] = (
                self.aircraft_distance_km.get(registration, 0.0) + distance
            )
