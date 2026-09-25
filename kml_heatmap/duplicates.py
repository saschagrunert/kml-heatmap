"""The same flight recorded twice, found by where it was when.

``data_exporter.drop_duplicate_paths`` drops a path that repeats another one
exactly: the same file under two names. The same flight recorded by two
devices (a phone and a panel-mounted GPS), or exported twice by different
tools, has points of its own in each recording, and was counted twice in
every statistic. Two recordings are of one flight when they overlap in time
by more than half of the shorter one, and at the times they share they are
in the same place (``same_flight``). One of them is left out, with a warning
that names both files: the one that does not name the aircraft, when only one
does (a phone log without a registration, next to the file of the panel
GPS), and otherwise the one with fewer points (the coarser recording).

Only recordings with timed points are compared; a line without times has
nothing to tell two flights over the same route apart. Obfuscated files put
every flight of a year on January 1st at its time of day, so two flights
from one field at the same time of day on different days overlap in time:
where they are at each moment tells them apart, since no two flights take
the same way at the same pace.
"""

from __future__ import annotations

from bisect import bisect_right
from typing import TYPE_CHECKING, NamedTuple

from .geometry import haversine_distance
from .logger import logger

if TYPE_CHECKING:
    from collections.abc import Mapping, Sequence

    from .types import FlightPath, FlightPathGroup, PathMetadata

__all__ = [
    "DUPLICATE_DISTANCE_KM",
    "MIN_TIME_OVERLAP",
    "drop_overlapping_paths",
    "same_flight",
]

# Two recordings share more than this part of the shorter one's time
MIN_TIME_OVERLAP = 0.5
# ... and are this close at the moments compared: two GPS receivers agree
# within a few tens of metres, and a second of clock difference is 80 m at
# 150 kt. The moments are spread evenly over the time they share, and a
# tenth of them may be further apart (a fix that jumped).
DUPLICATE_DISTANCE_KM = 0.3
_MOMENTS = 20
_MAX_APART = _MOMENTS // 10


class _Timed(NamedTuple):
    """The timed points of a recording, as parallel lists sorted by time."""

    times: list[float]
    lats: list[float]
    lons: list[float]

    @classmethod
    def of(cls, path: FlightPath) -> _Timed | None:
        points = sorted(
            (point.ts, point.lat, point.lon) for point in path if point.ts is not None
        )
        if len(points) < 2 or points[-1][0] <= points[0][0]:
            return None
        times, lats, lons = (list(column) for column in zip(*points, strict=True))
        return cls(times, lats, lons)

    def at(self, moment: float) -> tuple[float, float]:
        """Where the recording was at ``moment``, between its fixes."""
        after = min(max(bisect_right(self.times, moment), 1), len(self.times) - 1)
        before = after - 1
        span = self.times[after] - self.times[before]
        share = (moment - self.times[before]) / span if span > 0 else 0.0
        share = min(max(share, 0.0), 1.0)
        return (
            self.lats[before] + (self.lats[after] - self.lats[before]) * share,
            self.lons[before] + (self.lons[after] - self.lons[before]) * share,
        )


def same_flight(first: _Timed, second: _Timed) -> bool:
    """Whether two timed recordings are of one flight (see the module)."""
    begin = max(first.times[0], second.times[0])
    end = min(first.times[-1], second.times[-1])
    shorter = min(first.times[-1] - first.times[0], second.times[-1] - second.times[0])
    if end - begin <= MIN_TIME_OVERLAP * shorter:
        return False
    apart = 0
    for step in range(_MOMENTS):
        moment = begin + (end - begin) * (step + 0.5) / _MOMENTS
        lat1, lon1 = first.at(moment)
        lat2, lon2 = second.at(moment)
        if haversine_distance(lat1, lon1, lat2, lon2) > DUPLICATE_DISTANCE_KM:
            apart += 1
            if apart > _MAX_APART:
                return False
    return True


def _aircraft_known(metadata: PathMetadata) -> tuple[bool, bool]:
    """What a recording lacks of its aircraft, as a key to sort by.

    The one with the registration sorts first, then the one with the type:
    a 1 Hz phone log has more points than the file of the panel GPS, but
    only the file says which aircraft flew, which the aircraft filter and
    the statistics go by.
    """
    return (
        not metadata.get("aircraft_registration"),
        not metadata.get("aircraft_type"),
    )


def _name(metadata: Sequence[PathMetadata], index: int) -> str:
    return metadata[index].get("filename") or f"path {index}"


def drop_overlapping_paths(
    paths_by_year: Mapping[int, list[int]],
    all_path_groups: FlightPathGroup,
    all_path_metadata: Sequence[PathMetadata],
    exported: Mapping[int, object],
) -> dict[int, list[int]]:
    """Leave out every exported path that records a flight another one does.

    ``exported`` holds the indices of the exported paths (see
    ``data_exporter.exported_contents``). Of two recordings of one flight
    the one that names the aircraft stays: its registration first, then its
    type (see ``_aircraft_known``). Of two that name as much, the one with
    more points stays, and of two with as many the first in input order, so
    the choice does not depend on the order they are compared in. A year
    left without an exported path is left out.
    """
    dropped: set[int] = set()
    for indices in paths_by_year.values():
        timed = {
            index: recording
            for index in indices
            if index in exported
            and (recording := _Timed.of(all_path_groups[index])) is not None
        }
        # Swept by start: a recording is compared with the ones still going
        order = sorted(timed, key=lambda index: (timed[index].times[0], index))
        going: list[int] = []
        for index in order:
            recording = timed[index]
            going = [
                other
                for other in going
                if timed[other].times[-1] > recording.times[0] and other not in dropped
            ]
            for other in going:
                if index in dropped or not same_flight(timed[other], recording):
                    continue
                keep, drop = sorted(
                    (other, index),
                    key=lambda i: (
                        _aircraft_known(all_path_metadata[i]),
                        -len(timed[i].times),
                        i,
                    ),
                )
                dropped.add(drop)
                logger.warning(
                    "Skipping a flight in %s: the same flight as in %s, recorded twice",
                    _name(all_path_metadata, drop),
                    _name(all_path_metadata, keep),
                )
            if index not in dropped:
                going.append(index)
    if not dropped:
        return dict(paths_by_year)
    kept = {
        year: [index for index in indices if index not in dropped]
        for year, indices in paths_by_year.items()
    }
    return {
        year: indices
        for year, indices in kept.items()
        if any(index in exported for index in indices)
    }
