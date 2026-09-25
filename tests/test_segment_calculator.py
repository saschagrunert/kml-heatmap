"""Tests for segment_calculator module."""

from bisect import bisect_left, bisect_right
from pathlib import Path

import pytest

from kml_heatmap.constants import (
    KM_TO_NAUTICAL_MILES,
    MAX_GROUNDSPEED_KNOTS,
    MIN_SEGMENT_TIME_SECONDS,
    SECONDS_PER_HOUR,
    SPEED_WINDOW_SECONDS,
)
from kml_heatmap.helpers import parse_timestamp_epoch
from kml_heatmap.segment_calculator import (
    SegmentSpeed,
    SpeedWindow,
    calculate_fallback_groundspeed,
    extract_segment_speeds,
)
from kml_heatmap.types import TrackPoint
from tests.conftest import parse_kml_coordinates

DATA_DIR = Path(__file__).parent.parent / "data"


def _pt(lat, lon, alt=100.0, ts=None):
    return TrackPoint(lat, lon, alt, parse_timestamp_epoch(ts) if ts else None)


class TestExtractSegmentSpeeds:
    def test_empty_and_single_point(self):
        assert extract_segment_speeds([], None) == []
        assert extract_segment_speeds([_pt(50.0, 8.5)], None) == []

    def test_path_without_timestamps(self):
        result = extract_segment_speeds([_pt(50.0, 8.5), _pt(51.0, 9.5)], None)
        assert len(result) == 1
        seg = result[0]
        assert seg.index == 0
        assert seg.speed is None
        assert seg.timestamp is None
        assert seg.relative_time is None
        assert seg.time_delta == 0.0
        assert seg.distance > 0

    def test_path_with_timestamps(self):
        path = [
            _pt(50.0, 8.5, ts="2025-03-15T10:00:00Z"),
            _pt(51.0, 8.5, ts="2025-03-15T10:30:00Z"),
        ]
        seg = extract_segment_speeds(path, None)[0]
        assert seg.timestamp == path[0].ts
        assert seg.time_delta == 1800.0
        assert seg.speed == pytest.approx(seg.distance / 1.852 / 1800 * 3600, rel=1e-6)

    def test_distances_add_up_to_the_path_length(self):
        path = [_pt(50.0, 8.5), _pt(50.5, 9.0), _pt(51.0, 9.5)]
        segments = extract_segment_speeds(path, None)
        assert sum(s.distance for s in segments) == pytest.approx(
            segments[0].distance + segments[1].distance
        )
        assert segments[0].distance == pytest.approx(65.8, abs=0.5)

    def test_relative_time_from_path_start(self):
        path = [
            _pt(50.0, 8.5, ts="2025-03-15T10:00:00Z"),
            _pt(51.0, 8.5, ts="2025-03-15T10:30:00Z"),
        ]
        start = parse_timestamp_epoch("2025-03-15T09:59:00Z")
        assert extract_segment_speeds(path, start)[0].relative_time == 60.0

    def test_multiple_segments_indexed(self):
        path = [
            _pt(50.0, 8.5, ts="2025-03-15T10:00:00Z"),
            _pt(50.5, 9.0, ts="2025-03-15T10:15:00Z"),
            _pt(51.0, 9.5, ts="2025-03-15T10:30:00Z"),
        ]
        assert [s.index for s in extract_segment_speeds(path, None)] == [0, 1]

    def test_unrealistic_speed_is_unknown(self):
        path = [
            _pt(50.0, 8.5, ts="2025-03-15T10:00:00Z"),
            _pt(60.0, 18.5, ts="2025-03-15T10:00:01Z"),
        ]
        seg = extract_segment_speeds(path, None)[0]
        assert seg.speed is None
        assert seg.valid is False

    def test_fast_aircraft_is_measured(self):
        """300 kt is a turboprop at cruise, not a glitch."""
        path = [
            _pt(50.0, 8.5, ts="2025-03-15T10:00:00Z"),
            _pt(50.0 + 5 * 1.852 / 111.195, 8.5, ts="2025-03-15T10:01:00Z"),
        ]
        seg = extract_segment_speeds(path, None)[0]
        assert seg.valid is True
        assert seg.speed == pytest.approx(300.0, rel=1e-3)

    def test_very_short_time_delta_ignored(self):
        path = [
            _pt(50.0, 8.5, ts="2025-03-15T10:00:00.000Z"),
            _pt(50.0, 8.5, ts="2025-03-15T10:00:00.001Z"),
        ]
        seg = extract_segment_speeds(path, None)[0]
        assert seg.speed is None
        assert seg.valid is False

    def test_standing_still_is_a_valid_measurement(self):
        path = [
            _pt(50.0, 8.5, ts="2025-03-15T10:00:00Z"),
            _pt(50.0, 8.5, ts="2025-03-15T10:01:00Z"),
        ]
        seg = extract_segment_speeds(path, None)[0]
        assert seg.speed == 0.0
        assert seg.valid is True

    def test_untimed_segment_is_not_valid(self):
        assert (
            extract_segment_speeds([_pt(50.0, 8.5), _pt(51.0, 9.5)], None)[0].valid
            is False
        )

    def test_partial_timestamp_data(self):
        path = [
            _pt(50.0, 8.5, ts="2025-03-15T10:00:00Z"),
            _pt(50.5, 9.0),
            _pt(51.0, 9.5, ts="2025-03-15T10:30:00Z"),
        ]
        result = extract_segment_speeds(path, None)
        assert [s.timestamp for s in result] == [None, None]


class TestSpeedWindow:
    def test_empty(self):
        window = SpeedWindow([])
        assert len(window) == 0
        assert window.groundspeed(1000.0) is None

    def test_sorted_and_filtered(self):
        segments = [
            SegmentSpeed(0, 200.0, None, 100.0, 1.0, 10.0, valid=True),
            SegmentSpeed(1, 100.0, None, 0.0, 0.0, 10.0, valid=True),  # standing
            SegmentSpeed(2, None, None, None, 1.0, 10.0),  # no timestamp
            SegmentSpeed(3, 150.0, None, None, 100.0, 1.0),  # implausible
            SegmentSpeed(4, 50.0, None, 120.0, 1.0, 10.0, valid=True),
        ]
        window = SpeedWindow(segments)
        assert window.timestamps == [50.0, 100.0, 200.0]
        assert window.totals(100.0) == (1.0, 20.0)

    def test_standing_time_counts_in_the_window(self):
        """A minute standing still and a minute at 100 kt average to 50 kt."""
        one_minute_at_100_kt = 100 * 1.852 / 60  # km
        path = [
            _pt(50.0, 8.5, ts="2025-03-15T10:00:00Z"),
            _pt(50.0, 8.5, ts="2025-03-15T10:01:00Z"),
            _pt(50.0 + one_minute_at_100_kt / 111.195, 8.5, ts="2025-03-15T10:02:00Z"),
        ]
        segments = extract_segment_speeds(path, None)
        window = SpeedWindow(segments)
        timestamp = segments[1].timestamp
        assert timestamp is not None
        assert window.totals(timestamp)[1] == 120.0
        assert window.groundspeed(timestamp) == pytest.approx(50.0, rel=1e-3)

    def test_window_average(self):
        segments = [
            SegmentSpeed(0, 1000.0, None, 0.0, 1.0, 30.0, valid=True),
            SegmentSpeed(1, 1030.0, None, 0.0, 2.0, 30.0, valid=True),
            SegmentSpeed(2, 5000.0, None, 0.0, 100.0, 1.0, valid=True),  # outside
        ]
        window = SpeedWindow(segments)
        assert window.totals(1010.0) == (3.0, 60.0)
        assert window.groundspeed(1010.0) == pytest.approx(3.0 / 1.852 / 60.0 * 3600)

    def test_unrealistic_window_speed_is_unknown(self):
        window = SpeedWindow([SegmentSpeed(0, 1000.0, None, 0.0, 100.0, 1.0, True)])
        assert window.groundspeed(1000.0) is None

    def test_nothing_in_the_window_is_unknown(self):
        window = SpeedWindow([SegmentSpeed(0, 1000.0, None, 1.0, 1.0, 60.0, True)])
        assert window.groundspeed(5000.0) is None

    def test_standing_still_is_zero_not_unknown(self):
        window = SpeedWindow([SegmentSpeed(0, 1000.0, None, 0.0, 0.0, 60.0, True)])
        assert window.groundspeed(1000.0) == 0.0


def _windowed_groundspeed_before_prefix_sums(current, timed):
    """The window as it was computed before: a fresh sum over every window.

    ``timed`` are the valid segments, sorted by time.
    """
    timestamps = [s.timestamp for s in timed]
    if not timestamps:
        return None
    half = SPEED_WINDOW_SECONDS / 2
    distance = 0.0
    seconds = 0.0
    for seg in timed[
        bisect_left(timestamps, current - half) : bisect_right(
            timestamps, current + half
        )
    ]:
        distance += seg.distance
        seconds += seg.time_delta
    if seconds < MIN_SEGMENT_TIME_SECONDS:
        return None
    speed = distance * KM_TO_NAUTICAL_MILES / seconds * SECONDS_PER_HOUR
    return None if speed > MAX_GROUNDSPEED_KNOTS else speed


@pytest.mark.skipif(not DATA_DIR.is_dir(), reason="needs the data/ flights")
@pytest.mark.parametrize(
    "name", ["1_DEAGJ_DA20.kml", "41_DELGD_C182.kml", "100_DEAGJ_DA20.kml"]
)
def test_running_totals_match_summing_every_window(name):
    """The O(n) window gives the exported speeds of the O(n * w) one."""
    _, paths, _ = parse_kml_coordinates(str(DATA_DIR / name))
    compared = 0
    for path in paths:
        segments = extract_segment_speeds(path, None)
        window = SpeedWindow(segments)
        timed = sorted(
            (s for s in segments if s.valid and s.timestamp is not None),
            key=lambda s: s.timestamp or 0.0,
        )
        for seg in segments:
            if seg.timestamp is None:
                continue
            new = window.groundspeed(seg.timestamp)
            old = _windowed_groundspeed_before_prefix_sums(seg.timestamp, timed)
            assert (new is None) == (old is None)
            if new is not None and old is not None:
                assert new == pytest.approx(old, rel=1e-9, abs=1e-9)
                assert round(new, 1) == round(old, 1)
                compared += 1
    assert compared > 500


class TestCalculateFallbackGroundspeed:
    def test_valid_data(self):
        speed = calculate_fallback_groundspeed(10.0, 100.0, 3600.0)
        assert speed == pytest.approx(100.0 / 1.852)

    @pytest.mark.parametrize(
        "args", [(10.0, 100.0, 0.0), (10.0, 0.0, 3600.0), (10.0, 100.0, -100.0)]
    )
    def test_invalid_inputs_are_unknown(self, args):
        assert calculate_fallback_groundspeed(*args) is None

    def test_unrealistic_speed_is_unknown(self):
        assert calculate_fallback_groundspeed(1000.0, 1000.0, 1.0) is None

    def test_realistic_speed(self):
        speed = calculate_fallback_groundspeed(10.0, 100.0, 1800.0)
        assert speed is not None
        assert 0 < speed <= MAX_GROUNDSPEED_KNOTS
