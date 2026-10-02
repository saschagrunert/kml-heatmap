"""Tests for duplicates module."""

import logging
from math import floor
from typing import Any, ClassVar, cast

from hypothesis import given
from hypothesis import strategies as st

from kml_heatmap.duplicates import (
    _CELL_DEGREES,
    _MIN_AGREEING,
    _SHIFT_TOLERANCE_S,
    _clock_known,
    _clock_shifts,
    _Timed,
    drop_overlapping_paths,
    same_flight,
)
from kml_heatmap.types import TrackPoint

# East at 50 m/s (97 kt) at 50 degrees north
SPEED = 0.0007
# 2025-06-01T00:00:00Z: a recording that starts after it runs on the real
# clock. One that starts near 0 (January 1st, 1970) is taken for an
# obfuscated one, whose clock may be anything.
JUNE_2025 = 1748736000.0
JANUARY_2025 = 1735689600.0


def _recording(start_s, seconds, step_s=10.0, lat=50.0, lon=8.0, lon_per_s=SPEED):
    """A flight east from (lat, lon), a fix every ``step_s`` seconds."""
    count = int(seconds / step_s) + 1
    return [
        TrackPoint(lat, lon + lon_per_s * i * step_s, 500.0, start_s + i * step_s)
        for i in range(count)
    ]


def _drop(paths, names=None):
    metadata: Any = [
        {"filename": (names or [f"{i}.kml" for i in range(len(paths))])[i]}
        for i in range(len(paths))
    ]
    exported = dict.fromkeys(range(len(paths)), b"")
    return drop_overlapping_paths(
        {2025: list(range(len(paths)))}, paths, metadata, exported
    )


class TestDropOverlappingPaths:
    def test_two_recordings_of_one_flight_count_once(self, caplog):
        """A phone and a panel GPS: other fixes, the same flight, on the
        real clock (files that are not obfuscated)."""
        start = JUNE_2025 + 1000.0
        coarse = _recording(start, 3600.0, step_s=10.0)
        # Started a minute later, a fix every 3 s, a few metres off
        fine = _recording(start + 60.0, 3500.0, step_s=3.0, lat=50.0001)
        fine = [p._replace(lon=8.0 + SPEED * (p.ts - start)) for p in fine]

        with caplog.at_level(logging.WARNING, logger="kml_heatmap"):
            kept = _drop([coarse, fine], ["phone.kml", "panel.kml"])

        # The finer recording stays, whichever came first
        assert kept == {2025: [1]}
        assert "phone.kml" in caplog.text
        assert "panel.kml" in caplog.text
        assert _drop([fine, coarse]) == {2025: [0]}

    def test_recordings_with_clocks_of_their_own_count_once(self, caplog):
        """Obfuscated files each start at midnight, so the phone started a
        minute before the panel GPS no longer lines up with it in time."""
        coarse = _recording(1000.0, 3600.0, step_s=10.0)
        # The same flight from a minute in, its clock starting at 0
        fine = [
            p._replace(lon=8.0 + SPEED * (p.ts - 1000.0), ts=p.ts - 1060.0)
            for p in _recording(1060.0, 3500.0, step_s=3.0, lat=50.0001)
        ]

        with caplog.at_level(logging.WARNING, logger="kml_heatmap"):
            kept = _drop([coarse, fine], ["phone.kml", "panel.kml"])

        assert kept == {2025: [1]}
        assert "recorded twice" in caplog.text
        assert _drop([fine, coarse]) == {2025: [0]}

    def test_a_real_and_an_obfuscated_recording_of_one_flight_count_once(self):
        start = JUNE_2025 + 1000.0
        real = _recording(start, 3600.0, step_s=10.0)
        # Obfuscated on its own: started a minute later, at midnight now
        obfuscated = [
            p._replace(lon=8.0 + SPEED * (p.ts - start), ts=p.ts - start - 60.0)
            for p in _recording(start + 60.0, 3500.0, step_s=3.0, lat=50.0001)
        ]
        obfuscated = [p._replace(ts=p.ts + JANUARY_2025) for p in obfuscated]
        assert _drop([real, obfuscated]) == {2025: [1]}

    def test_real_clocks_tell_the_same_way_on_another_day_apart(self):
        """Two flights alike in the air: the real clock tells them apart,
        an obfuscated one cannot."""
        today = _recording(JUNE_2025 + 1000.0, 3600.0)
        tomorrow = _recording(JUNE_2025 + 1000.0 + 86400.0, 3600.0, lat=50.0001)
        assert _drop([today, tomorrow]) == {2025: [0, 1]}
        obfuscated = [
            [p._replace(ts=p.ts - path[0].ts) for p in path]
            for path in (today, tomorrow)
        ]
        assert _drop(obfuscated) == {2025: [0]}

    def test_flights_that_share_the_ground_only_are_two(self):
        """Obfuscated flights from one field, standing at the same place for
        most of their time: lined up by where they stood, they would agree."""
        ground = [TrackPoint(50.0, 8.0, 100.0, float(t)) for t in range(0, 1800, 10)]
        east = ground + _recording(1800.0, 600.0)
        north = ground + [
            p._replace(lat=50.0 + SPEED * (p.ts - 1800.0), lon=8.0)
            for p in _recording(1800.0, 600.0)
        ]
        assert _drop([east, north]) == {2025: [0, 1]}

    def test_the_same_way_at_another_pace_is_another_flight_at_any_time(self):
        first = _recording(1000.0, 3600.0)
        second = _recording(50000.0, 3600.0, lon_per_s=1.5 * SPEED)
        assert _drop([first, second]) == {2025: [0, 1]}

    def test_the_same_way_back_is_another_flight(self):
        out = _recording(1000.0, 3600.0)
        back = [
            p._replace(lon=8.0 + SPEED * 3600.0 - SPEED * (p.ts - 1000.0))
            for p in _recording(1000.0, 3600.0)
        ]
        assert _drop([out, back]) == {2025: [0, 1]}

    def test_as_many_points_keep_the_first(self):
        path = _recording(1000.0, 3600.0)
        assert _drop([path, list(path)]) == {2025: [0]}

    def test_the_same_time_elsewhere_is_another_flight(self):
        """Obfuscated flights of different days share January 1st."""
        home = _recording(1000.0, 3600.0)
        away = _recording(1000.0, 3600.0, lat=50.1)
        assert _drop([home, away]) == {2025: [0, 1]}

    def test_the_same_way_at_another_pace_is_another_flight(self):
        first = _recording(1000.0, 3600.0)
        second = _recording(1000.0, 3600.0, lon_per_s=1.5 * SPEED)
        assert _drop([first, second]) == {2025: [0, 1]}

    def test_little_overlap_in_time_is_another_flight(self):
        first = _recording(1000.0, 3600.0)
        # Starts where the first is after 40 minutes, in the same place
        later = [
            p._replace(lon=8.0 + SPEED * (p.ts - 1000.0))
            for p in _recording(1000.0 + 2400.0, 3600.0)
        ]
        assert _drop([first, later]) == {2025: [0, 1]}

    def test_recordings_that_never_moved_fast_are_two(self):
        """Two taxi-only recordings at one field on clocks of their own: a
        flight is told apart by the time it moved, and neither did."""
        taxi = [TrackPoint(50.0, 8.0 + 0.0001 * t, 100.0, float(t)) for t in range(600)]
        again = [p._replace(lat=50.00001) for p in taxi]
        assert _drop([taxi, again]) == {2025: [0, 1]}

    def test_recordings_without_times_are_not_compared(self):
        untimed = [p._replace(ts=None) for p in _recording(1000.0, 3600.0)]
        assert _drop([untimed, list(untimed)]) == {2025: [0, 1]}

    def test_a_year_left_empty_goes(self):
        path = _recording(1000.0, 3600.0)
        metadata = cast("Any", [{"filename": "a.kml"}, {"filename": "b.kml"}])
        kept = drop_overlapping_paths(
            {2024: [0], 2025: [1]}, [path, list(path)], metadata, {0: b"", 1: b""}
        )
        # Different years are never compared
        assert kept == {2024: [0], 2025: [1]}
        kept = drop_overlapping_paths(
            {2025: [0, 1]}, [path, list(path)], metadata, {0: b"", 1: b""}
        )
        assert kept == {2025: [0]}

    def test_the_recording_that_names_the_aircraft_stays(self):
        """A 1 Hz phone log and the panel GPS file with the registration."""
        panel = _recording(1000.0, 3600.0, step_s=10.0)
        phone = _recording(1000.0, 3600.0, step_s=1.0)
        paths = [phone, panel]
        metadata: Any = [
            {"filename": "phone.kml"},
            {
                "filename": "1_DEAGJ_DA20.kml",
                "aircraft_registration": "D-EAGJ",
                "aircraft_type": "DA20",
            },
        ]
        exported = dict.fromkeys(range(2), b"")
        kept = drop_overlapping_paths({2025: [0, 1]}, paths, metadata, exported)
        assert kept == {2025: [1]}

        # The registration counts before the type
        metadata[0]["aircraft_type"] = "DA20"
        metadata[1].pop("aircraft_type")
        kept = drop_overlapping_paths({2025: [0, 1]}, paths, metadata, exported)
        assert kept == {2025: [1]}


class TestSameFlight:
    def test_a_fix_or_two_that_jumped_are_forgiven(self):
        path = _recording(1000.0, 3600.0)
        # The fixes at two of the 20 moments compared jumped 11 km north
        jumped = [
            p._replace(lat=p.lat + (0.1 if p.ts in (1090.0, 1270.0) else 0.0))
            for p in path
        ]
        first, second = _Timed.of(path), _Timed.of(jumped)
        assert first is not None
        assert second is not None
        assert same_flight(first, second)

        lost = [p._replace(lat=p.lat + (0.1 if p.ts < 1600.0 else 0.0)) for p in path]
        third = _Timed.of(lost)
        assert third is not None
        assert not same_flight(first, third)

    def test_a_shift_lines_up_the_clocks(self):
        first = _Timed.of(_recording(1000.0, 3600.0))
        second = _Timed.of(_recording(0.0, 3600.0))
        assert first is not None
        assert second is not None
        assert same_flight(first, second, shift=-1000.0)
        assert not same_flight(first, second, shift=-900.0)


class TestClockKnown:
    def test_a_start_in_the_days_after_new_year_may_be_any_clock(self):
        assert _clock_known(JUNE_2025)
        assert not _clock_known(JANUARY_2025 + 3600.0)

    def test_a_start_no_date_holds_is_not_the_real_clock(self):
        # Past the year 9999, and not a number at all
        assert not _clock_known(1e20)
        assert not _clock_known(float("nan"))


def _shifts_looking_everywhere(first, second):
    """``_clock_shifts`` without the cells ``reach`` rules out first."""
    shifts = sorted(
        near - moment
        for moment, lat, lon in first.samples()
        if (near := second.time_near(lat, lon)) is not None
    )
    groups: list[list[float]] = []
    for shift in shifts:
        if groups and shift - groups[-1][-1] <= _SHIFT_TOLERANCE_S:
            groups[-1].append(shift)
        else:
            groups.append([shift])
    return [
        group[len(group) // 2]
        for group in sorted(groups, key=len, reverse=True)
        if len(group) >= _MIN_AGREEING
    ]


_WALK = st.lists(
    st.tuples(st.floats(-0.003, 0.003), st.floats(-0.003, 0.003), st.floats(1.0, 60.0)),
    min_size=2,
    max_size=40,
)


def _walk(steps, lat=50.0, lon=8.0):
    """A recording from (lat, lon) by the steps of ``_WALK``."""
    points, time = [], 0.0
    for north, east, seconds in steps:
        points.append(TrackPoint(lat, lon, 500.0, time))
        lat, lon, time = lat + north, lon + east, time + seconds
    points.append(TrackPoint(lat, lon, 500.0, time))
    return _Timed.of(points)


class TestReach:
    @given(_WALK, st.floats(-0.02, 0.02), st.floats(-0.02, 0.02))
    def test_holds_every_place_time_near_finds(self, steps, north, east):
        recording = _walk(steps)
        assert recording is not None
        lat, lon = 50.0 + north, 8.0 + east
        cell = (
            floor(lat / _CELL_DEGREES),
            floor(lon * recording.lon_scale / _CELL_DEGREES),
        )
        if recording.time_near(lat, lon) is not None:
            assert cell in recording.reach()

    @given(_WALK, st.floats(-0.005, 0.005), st.floats(-0.005, 0.005))
    def test_rules_out_no_shift(self, steps, north, east):
        """The same way, from a place up to 550 m off: near enough for a
        shift at some moments, and too far at others."""
        first = _walk(steps)
        second = _walk(steps, lat=50.0 + north, lon=8.0 + east)
        assert first is not None
        assert second is not None
        assert _clock_shifts(first, second) == _shifts_looking_everywhere(first, second)


class TestMoving:
    def test_from_the_takeoff_run_to_the_landing(self):
        # Taxiing at 7 m/s to where the takeoff run starts at 300 s
        taxi = [
            TrackPoint(50.0, 8.0 - 0.0001 * (300 - t), 100.0, float(t))
            for t in range(0, 300, 5)
        ]
        flight = _recording(300.0, 600.0)
        end = flight[-1]
        parked = [end._replace(ts=end.ts + t) for t in range(5, 300, 5)]
        recording = _Timed.of(taxi + flight + parked)
        assert recording is not None
        moving = recording.moving()
        assert moving is not None
        # From the last fix before the run, whose next 10 s were fast
        assert moving.times[0] == 295.0
        assert moving.times[-1] == 900.0
        assert moving.clock_known == recording.clock_known

    def test_none_for_a_recording_that_never_left_the_ground(self):
        taxi = [TrackPoint(50.0, 8.0 + 0.0001 * t, 100.0, float(t)) for t in range(600)]
        recording = _Timed.of(taxi)
        assert recording is not None
        assert recording.moving() is None


class TestTimeNear:
    def test_between_fixes_and_where_the_aircraft_stood(self):
        # Standing at the start for 20 s, then east at 0.0002 degrees a second
        path = [TrackPoint(50.0, 8.0, 500.0, 0.0), TrackPoint(50.0, 8.0, 500.0, 10.0)]
        path += _recording(20.0, 600.0, lon_per_s=0.0002)[1:]
        recording = _Timed.of(path)
        assert recording is not None
        assert recording.time_near(50.0, 8.0) == 0.0
        # Halfway between two fixes, a few metres off the line
        near = recording.time_near(50.00003, 8.0 + 0.0002 * 25.0)
        assert near is not None
        assert abs(near - 45.0) < 0.01
        # Further away than DUPLICATE_DISTANCE_KM from every fix
        assert recording.time_near(50.01, 8.0) is None

    def test_between_fixes_far_apart(self):
        """A fix a minute, 2.9 km apart: the line between them counts."""
        recording = _Timed.of(_recording(0.0, 600.0, step_s=60.0))
        assert recording is not None
        near = recording.time_near(50.001, 8.0 + SPEED * 90.0)
        assert near is not None
        assert abs(near - 90.0) < 0.01


def _wrapped(path):
    """The fixes with their longitudes from -180 to 180, as a file has them."""
    return [p._replace(lon=(p.lon + 180) % 360 - 180) for p in path]


class TestAntimeridian:
    # East from 179.5 at 16 degrees south, across the line after a while
    START: ClassVar[dict[str, float]] = {"lat": -16.0, "lon": 179.5}

    def test_a_crossing_has_the_cells_of_its_way(self):
        path = _wrapped(_recording(1000.0, 3600.0, **self.START))
        assert path[0].lon > 0 > path[-1].lon
        recording = _Timed.of(path)
        assert recording is not None
        # Indexed as one short way, not as a line around the whole world
        assert len(recording._index()) < 1000
        assert recording.lons[-1] > 180

    def test_two_recordings_of_a_crossing_count_once(self):
        """Obfuscated, so lined up by where they were; one starts after the
        line, the other before it."""
        coarse = _wrapped(_recording(1000.0, 3600.0, **self.START))
        fine = _wrapped(
            [
                p._replace(lat=-16.0001, lon=179.5 + SPEED * (p.ts - 1000.0))
                for p in _recording(1800.0, 2800.0, step_s=3.0)
            ]
        )
        assert fine[0].lon < 0
        assert _drop([coarse, fine]) == {2025: [1]}

    def test_another_way_across_is_another_flight(self):
        out = _wrapped(_recording(1000.0, 3600.0, **self.START))
        north = _wrapped(
            [
                p._replace(lat=-16.0 + SPEED * (p.ts - 1000.0), lon=179.9)
                for p in _recording(1000.0, 3600.0)
            ]
        )
        assert _drop([out, north]) == {2025: [0, 1]}
