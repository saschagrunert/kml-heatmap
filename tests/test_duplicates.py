"""Tests for duplicates module."""

import logging
from typing import Any, cast

from kml_heatmap.duplicates import drop_overlapping_paths
from kml_heatmap.types import TrackPoint


def _recording(start_s, seconds, step_s=10.0, lat=50.0, lon=8.0, lon_per_s=0.0002):
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
        """A phone and a panel GPS: other fixes, the same flight."""
        coarse = _recording(1000.0, 3600.0, step_s=10.0)
        # Started a minute later, a fix every 3 s, a few metres off
        fine = _recording(1060.0, 3500.0, step_s=3.0, lat=50.0001)
        fine = [p._replace(lon=8.0 + 0.0002 * (p.ts - 1000.0)) for p in fine]

        with caplog.at_level(logging.WARNING, logger="kml_heatmap"):
            kept = _drop([coarse, fine], ["phone.kml", "panel.kml"])

        # The finer recording stays, whichever came first
        assert kept == {2025: [1]}
        assert "phone.kml" in caplog.text
        assert "panel.kml" in caplog.text
        assert _drop([fine, coarse]) == {2025: [0]}

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
        second = _recording(1000.0, 3600.0, lon_per_s=0.0003)
        assert _drop([first, second]) == {2025: [0, 1]}

    def test_little_overlap_in_time_is_another_flight(self):
        first = _recording(1000.0, 3600.0)
        # Starts where the first is after 40 minutes, in the same place
        later = [
            p._replace(lon=8.0 + 0.0002 * (p.ts - 1000.0))
            for p in _recording(1000.0 + 2400.0, 3600.0)
        ]
        assert _drop([first, later]) == {2025: [0, 1]}

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
