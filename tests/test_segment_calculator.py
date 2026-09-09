"""Tests for segment_calculator module."""

import pytest

from kml_heatmap.constants import MAX_GROUNDSPEED_KNOTS
from kml_heatmap.helpers import parse_timestamp_epoch
from kml_heatmap.segment_calculator import (
    SegmentSpeed,
    build_time_indexed_segments,
    calculate_fallback_groundspeed,
    calculate_path_distance,
    calculate_windowed_groundspeed,
    extract_segment_speeds,
)
from kml_heatmap.types import TrackPoint


def _pt(lat, lon, alt=100.0, ts=None):
    return TrackPoint(lat, lon, alt, parse_timestamp_epoch(ts) if ts else None)


class TestCalculatePathDistance:
    def test_empty_and_single_point(self):
        assert calculate_path_distance([]) == 0.0
        assert calculate_path_distance([_pt(50.0, 8.5)]) == 0.0

    def test_two_point_path(self):
        assert calculate_path_distance(
            [_pt(50.0, 8.5), _pt(51.0, 8.5)]
        ) == pytest.approx(111.2, abs=0.5)

    def test_multi_point_path_sums_segments(self):
        path = [_pt(50.0, 8.5), _pt(50.5, 9.0), _pt(51.0, 9.5)]
        expected = calculate_path_distance(path[:2]) + calculate_path_distance(path[1:])
        assert calculate_path_distance(path) == pytest.approx(expected)

    def test_zero_distance_path(self):
        path = [_pt(50.0, 8.5, 100), _pt(50.0, 8.5, 200), _pt(50.0, 8.5, 300)]
        assert calculate_path_distance(path) == pytest.approx(0.0, abs=0.01)


class TestExtractSegmentSpeeds:
    def test_empty_and_single_point(self):
        assert extract_segment_speeds([], None) == []
        assert extract_segment_speeds([_pt(50.0, 8.5)], None) == []

    def test_path_without_timestamps(self):
        result = extract_segment_speeds([_pt(50.0, 8.5), _pt(51.0, 9.5)], None)
        assert len(result) == 1
        seg = result[0]
        assert seg.index == 0
        assert seg.speed == 0.0
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

    def test_unrealistic_speed_filtered(self):
        path = [
            _pt(50.0, 8.5, ts="2025-03-15T10:00:00Z"),
            _pt(60.0, 18.5, ts="2025-03-15T10:00:01Z"),
        ]
        assert extract_segment_speeds(path, None)[0].speed == 0.0

    def test_very_short_time_delta_ignored(self):
        path = [
            _pt(50.0, 8.5, ts="2025-03-15T10:00:00.000Z"),
            _pt(50.0, 8.5, ts="2025-03-15T10:00:00.001Z"),
        ]
        assert extract_segment_speeds(path, None)[0].speed == 0.0

    def test_partial_timestamp_data(self):
        path = [
            _pt(50.0, 8.5, ts="2025-03-15T10:00:00Z"),
            _pt(50.5, 9.0),
            _pt(51.0, 9.5, ts="2025-03-15T10:30:00Z"),
        ]
        result = extract_segment_speeds(path, None)
        assert [s.timestamp for s in result] == [None, None]


class TestBuildTimeIndexedSegments:
    def test_empty(self):
        assert build_time_indexed_segments([]) == ([], [])

    def test_sorted_and_filtered(self):
        segments = [
            SegmentSpeed(0, 200.0, None, 100.0, 1.0, 10.0),
            SegmentSpeed(1, 100.0, None, 0.0, 1.0, 10.0),  # zero speed filtered
            SegmentSpeed(2, None, None, 120.0, 1.0, 10.0),  # no timestamp filtered
            SegmentSpeed(3, 50.0, None, 120.0, 1.0, 10.0),
        ]
        timestamps, indexed = build_time_indexed_segments(segments)
        assert timestamps == [50.0, 200.0]
        assert [s.index for s in indexed] == [3, 0]


class TestCalculateWindowedGroundspeed:
    def test_empty_timestamp_list(self):
        assert calculate_windowed_groundspeed(1000.0, [], []) == (0.0, 0.0, 0.0)

    def test_window_average(self):
        segments = [
            SegmentSpeed(0, 1000.0, None, 0.0, 1.0, 30.0),
            SegmentSpeed(1, 1030.0, None, 0.0, 2.0, 30.0),
            SegmentSpeed(2, 5000.0, None, 0.0, 100.0, 1.0),  # outside window
        ]
        speed, dist, secs = calculate_windowed_groundspeed(
            1010.0, [1000.0, 1030.0, 5000.0], segments
        )
        assert dist == 3.0
        assert secs == 60.0
        assert speed == pytest.approx(3.0 / 1.852 / 60.0 * 3600)

    def test_unrealistic_window_speed_rejected(self):
        segments = [SegmentSpeed(0, 1000.0, None, 0.0, 100.0, 1.0)]
        assert calculate_windowed_groundspeed(1000.0, [1000.0], segments) == (
            0.0,
            0.0,
            0.0,
        )


class TestCalculateFallbackGroundspeed:
    def test_valid_data(self):
        speed = calculate_fallback_groundspeed(10.0, 100.0, 3600.0)
        assert speed == pytest.approx(100.0 / 1.852)

    @pytest.mark.parametrize(
        "args", [(10.0, 100.0, 0.0), (10.0, 0.0, 3600.0), (10.0, 100.0, -100.0)]
    )
    def test_invalid_inputs(self, args):
        assert calculate_fallback_groundspeed(*args) == 0.0

    def test_unrealistic_speed_rejected(self):
        assert calculate_fallback_groundspeed(1000.0, 1000.0, 1.0) == 0.0

    def test_realistic_speed(self):
        speed = calculate_fallback_groundspeed(10.0, 100.0, 1800.0)
        assert 0 < speed <= MAX_GROUNDSPEED_KNOTS
