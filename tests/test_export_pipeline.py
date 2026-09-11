"""Tests for export_pipeline module."""

from itertools import pairwise

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from kml_heatmap.export_pipeline import (
    _segment_groundspeed,
    build_path_info,
    path_metrics,
    process_path_segments,
)
from kml_heatmap.geometry import haversine_distance
from kml_heatmap.helpers import parse_timestamp_epoch
from kml_heatmap.segment_calculator import SegmentSpeed
from kml_heatmap.types import TrackPoint


def _make_path(count=10, alt=1000.0, timed=False):
    path = []
    for i in range(count):
        ts = parse_timestamp_epoch(f"2025-03-03T08:{i:02d}:00Z") if timed else None
        path.append(TrackPoint(50.0 + i * 0.01, 8.5 + i * 0.01, alt + i * 50, ts))
    return path


class TestPathMetrics:
    def test_duration_and_distance(self):
        metadata = {
            "timestamp": "2025-03-03T08:00:00Z",
            "end_timestamp": "2025-03-03T09:30:00Z",
        }
        duration, distance = path_metrics(_make_path(), metadata)
        assert duration == pytest.approx(5400.0)
        assert distance == pytest.approx(11.9, abs=0.5)

    def test_missing_or_invalid_timestamps_give_zero_duration(self):
        assert path_metrics(_make_path(), {})[0] == 0.0
        metadata = {"timestamp": "invalid", "end_timestamp": "also-invalid"}
        assert path_metrics(_make_path(), metadata)[0] == 0.0


class TestBuildPathInfo:
    def test_airport_name_parsing(self):
        metadata = {"airport_name": "EDDS - EDDP"}
        info = build_path_info(_make_path(), metadata, 4, 2025, 9)
        assert info["start_airport"] == "EDDS"
        assert info["end_airport"] == "EDDP"
        assert info["year"] == 2025
        assert info["id"] == 4

    def test_none_values_are_omitted(self):
        metadata = {"airport_name": "", "aircraft_registration": None}
        info = build_path_info(_make_path(), metadata, 1, 2025, 9)
        assert "start_airport" not in info
        assert "end_airport" not in info
        assert "aircraft_registration" not in info
        assert set(info) == {
            "id",
            "year",
            "min_altitude_ft",
            "max_altitude_ft",
            "start_coords",
            "end_coords",
            "segment_count",
        }

    def test_key_order_is_stable(self):
        """The exported JSON keeps this order; the frontend contract test pins it."""
        info = build_path_info(_make_path(), {"airport_name": "A - B"}, 1, 2025, 9)
        assert list(info) == [
            "id",
            "year",
            "start_coords",
            "end_coords",
            "segment_count",
            "min_altitude_ft",
            "max_altitude_ft",
            "start_airport",
            "end_airport",
        ]

    def test_single_airport_no_split(self):
        info = build_path_info(_make_path(), {"airport_name": "EDDS"}, 0, 2025, 9)
        assert "start_airport" not in info

    def test_three_part_name_not_split(self):
        metadata = {"airport_name": "EDDF - EDDM - EDDT"}
        info = build_path_info(_make_path(), metadata, 0, 2025, 9)
        assert "start_airport" not in info

    def test_aircraft_metadata_included(self):
        metadata = {"aircraft_registration": "D-EAGJ", "aircraft_type": "C172"}
        info = build_path_info(_make_path(), metadata, 0, 2025, 9)
        assert info["aircraft_registration"] == "D-EAGJ"
        assert info["aircraft_type"] == "C172"

    def test_segment_count_and_coords(self):
        path = _make_path(count=5)
        info = build_path_info(path, {}, 0, 2025, 3)
        assert info["segment_count"] == 3
        assert info["start_coords"] == [path[0].lat, path[0].lon]
        assert info["end_coords"] == [path[-1].lat, path[-1].lon]

    def test_altitude_range_omitted_without_altitudes(self):
        path = [TrackPoint(50.0, 8.5, None, None), TrackPoint(50.1, 8.6, None, None)]
        info = build_path_info(path, {}, 0, 2025, 1)
        assert "min_altitude_ft" not in info


class TestSegmentGroundspeed:
    def test_windowed_speed_used_when_available(self):
        seg = SegmentSpeed(0, 1000.0, 0.0, 100.0, 1.0, 30.0)
        speed = _segment_groundspeed(seg, [1000.0], [seg], 10.0, 0.0)
        assert speed == pytest.approx(1.0 / 1.852 / 30.0 * 3600, rel=1e-6)

    def test_fallback_when_no_timestamp(self):
        seg = SegmentSpeed(0, None, None, 0.0, 1.0, 0.0)
        speed = _segment_groundspeed(seg, [], [], 10.0, 600.0)
        assert speed == pytest.approx(10.0 / 1.852 / 600.0 * 3600, rel=1e-6)

    def test_zero_when_nothing_known(self):
        seg = SegmentSpeed(0, None, None, 0.0, 1.0, 0.0)
        assert _segment_groundspeed(seg, [], [], 10.0, 0.0) == 0.0


class TestProcessPathSegments:
    def test_generates_rows_with_time(self):
        start, rows, distances = process_path_segments(
            _make_path(timed=True), 10.0, 540.0
        )
        assert start == [50.0, 8.5]
        assert len(rows) == 9
        assert len(distances) == 9
        assert all(len(row) == 5 for row in rows)
        assert rows[0][4] == 0.0
        assert rows[1][4] == 60.0
        assert all(distance > 0 for distance in distances)

    def test_rows_without_time(self):
        _, rows, _ = process_path_segments(_make_path(count=3), 10.0, 600.0)
        assert all(len(row) == 4 for row in rows)

    def test_rows_are_contiguous(self):
        """Each row starts where the previous one ended, so only ends are stored."""
        start, rows, _ = process_path_segments(_make_path(count=5), 10.0, 600.0)
        path = _make_path(count=5)
        assert start == [round(path[0].lat, 5), round(path[0].lon, 5)]
        for row, point in zip(rows, path[1:], strict=True):
            assert row[:2] == [round(point.lat, 5), round(point.lon, 5)]

    def test_coordinates_rounded_to_five_decimals(self):
        path = [
            TrackPoint(50.123456789, 8.987654321, 1000.0, None),
            TrackPoint(50.223456789, 8.887654321, 1000.0, None),
        ]
        start, rows, _ = process_path_segments(path, 5.0, 60.0)
        assert start == [50.12346, 8.98765]
        assert rows[0][:2] == [50.22346, 8.88765]

    def test_identical_coordinates_filtered(self):
        path = [
            TrackPoint(50.0, 8.5, 1000.0, None),
            TrackPoint(50.0, 8.5, 1100.0, None),
            TrackPoint(50.1, 8.6, 1200.0, None),
        ]
        start, rows, distances = process_path_segments(path, 5.0, 120.0)
        assert len(rows) == 1
        # The dropped segment had zero length, so the chain stays contiguous
        assert start == [50.0, 8.5]
        assert rows[0][:2] == [50.1, 8.6]
        assert len(distances) == 1

    def test_altitude_rounded_to_100ft(self):
        path = [
            TrackPoint(50.0, 8.5, 1523.5, None),
            TrackPoint(50.1, 8.6, 1523.5, None),
        ]
        _, rows, _ = process_path_segments(path, 5.0, 60.0)
        assert rows[0][2] == 5000
        assert rows[0][2] % 100 == 0

    def test_missing_altitude_on_one_end_uses_the_other(self):
        path = [TrackPoint(50.0, 8.5, None, None), TrackPoint(50.1, 8.6, 304.8, None)]
        _, rows, _ = process_path_segments(path, 5.0, 60.0)
        assert rows[0][2] == 1000

    def test_missing_altitude_on_both_ends_keeps_the_segment(self):
        """Skipping it would break the end-to-start chain of the row format."""
        path = [
            TrackPoint(50.0, 8.5, None, None),
            TrackPoint(50.1, 8.6, None, None),
            TrackPoint(50.2, 8.7, 100.0, None),
        ]
        start, rows, distances = process_path_segments(path, 5.0, 60.0)
        assert start == [50.0, 8.5]
        assert [row[:2] for row in rows] == [[50.1, 8.6], [50.2, 8.7]]
        assert rows[0][2] == 0.0  # no altitude known yet
        assert rows[1][2] == 300  # 100 m rounded to the nearest 100 ft
        assert len(distances) == 2

    def test_groundspeed_rounded(self):
        _, rows, _ = process_path_segments(_make_path(timed=True), 10.0, 540.0)
        for row in rows:
            assert row[3] == round(row[3], 1)
            assert row[3] > 0

    def test_relative_time_rounded(self):
        path = [
            TrackPoint(50.0, 8.5, 100.0, 1000.0),
            TrackPoint(50.1, 8.6, 100.0, 1000.0 + 61.26),
            TrackPoint(50.2, 8.7, 100.0, 1000.0 + 120.0),
        ]
        _, rows, _ = process_path_segments(path, 20.0, 120.0)
        assert rows[1][4] == 61.3

    def test_empty_path_has_no_start(self):
        _, rows, _ = process_path_segments([], 0.0, 0.0)
        assert rows == []
        start, _, _ = process_path_segments([], 0.0, 0.0)
        assert start == []


class TestProcessPathSegmentsProperties:
    @settings(max_examples=150, deadline=None)
    @given(
        st.lists(
            st.tuples(
                st.floats(min_value=-89.0, max_value=89.0),
                st.floats(min_value=-179.0, max_value=179.0),
                st.floats(min_value=0.0, max_value=5000.0),
            ),
            min_size=2,
            max_size=25,
        ),
        st.booleans(),
    )
    def test_rows_form_a_contiguous_chain(self, points, timed):
        """Every row continues where the previous one ended.

        The exported format stores only end points, so the chain must stay
        intact whatever the geometry, including repeated (zero-length) points.
        """
        path = [
            TrackPoint(lat, lon, alt, float(i) if timed else None)
            for i, (lat, lon, alt) in enumerate(points)
        ]
        start, rows, distances = process_path_segments(path, 1.0, 60.0)

        assert len(rows) == len(distances)
        assert len(start) == (2 if rows else 0)
        previous = start
        for row, distance in zip(rows, distances, strict=True):
            # The distance of a row is measured from the previous end point,
            # which is exactly how the frontend walks the chain
            assert distance == pytest.approx(
                haversine_distance(previous[0], previous[1], row[0], row[1])
            )
            assert row[2] % 100 == 0
            assert row[3] >= 0
            previous = row[:2]
        exported_ends = [row[:2] for row in rows]
        assert exported_ends == [
            [round(p2.lat, 5), round(p2.lon, 5)]
            for p1, p2 in pairwise(path)
            if (p1.lat, p1.lon) != (p2.lat, p2.lon)
        ]
