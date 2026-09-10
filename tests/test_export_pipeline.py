"""Tests for export_pipeline module."""

import pytest

from kml_heatmap.export_pipeline import (
    _segment_groundspeed,
    build_path_info,
    process_path_segments,
)
from kml_heatmap.helpers import parse_timestamp_epoch
from kml_heatmap.segment_calculator import SegmentSpeed
from kml_heatmap.types import TrackPoint


def _make_path(count=10, alt=1000.0, timed=False):
    path = []
    for i in range(count):
        ts = parse_timestamp_epoch(f"2025-03-03T08:{i:02d}:00Z") if timed else None
        path.append(TrackPoint(50.0 + i * 0.01, 8.5 + i * 0.01, alt + i * 50, ts))
    return path


class TestBuildPathInfo:
    def test_airport_name_parsing(self):
        metadata = {
            "airport_name": "EDDS - EDDP",
            "timestamp": "2025-03-03T08:00:00Z",
            "end_timestamp": "2025-03-03T09:30:00Z",
        }
        info, duration, distance = build_path_info(_make_path(), metadata, 4, 2025)
        assert info["start_airport"] == "EDDS"
        assert info["end_airport"] == "EDDP"
        assert info["year"] == 2025
        assert info["id"] == 4
        assert duration == pytest.approx(5400.0)
        assert distance > 0

    def test_none_values_are_omitted(self):
        metadata = {"airport_name": "", "aircraft_registration": None}
        info, duration, _ = build_path_info(_make_path(), metadata, 1, 2025)
        assert "start_airport" not in info
        assert "end_airport" not in info
        assert "aircraft_registration" not in info
        assert duration == 0.0
        assert set(info) == {
            "id",
            "year",
            "min_altitude_ft",
            "max_altitude_ft",
            "start_coords",
            "end_coords",
            "segment_count",
        }

    def test_single_airport_no_split(self):
        info, _, _ = build_path_info(_make_path(), {"airport_name": "EDDS"}, 0, 2025)
        assert "start_airport" not in info

    def test_three_part_name_not_split(self):
        metadata = {"airport_name": "EDDF - EDDM - EDDT"}
        info, _, _ = build_path_info(_make_path(), metadata, 0, 2025)
        assert "start_airport" not in info

    def test_invalid_timestamps_zero_duration(self):
        metadata = {"timestamp": "invalid", "end_timestamp": "also-invalid"}
        _, duration, _ = build_path_info(_make_path(), metadata, 0, 2025)
        assert duration == 0.0

    def test_distance_calculation(self):
        _, _, distance = build_path_info(_make_path(), {}, 0, 2025)
        assert distance == pytest.approx(11.9, abs=0.5)

    def test_aircraft_metadata_included(self):
        metadata = {"aircraft_registration": "D-EAGJ", "aircraft_type": "C172"}
        info, _, _ = build_path_info(_make_path(), metadata, 0, 2025)
        assert info["aircraft_registration"] == "D-EAGJ"
        assert info["aircraft_type"] == "C172"

    def test_segment_count_and_coords(self):
        path = _make_path(count=5)
        info, _, _ = build_path_info(path, {}, 0, 2025)
        assert info["segment_count"] == 4
        assert info["start_coords"] == [path[0].lat, path[0].lon]
        assert info["end_coords"] == [path[-1].lat, path[-1].lon]


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
        rows, distances = process_path_segments(_make_path(timed=True), 10.0, 540.0)
        assert len(rows) == 9
        assert len(distances) == 9
        assert all(len(row) == 7 for row in rows)
        assert rows[0][6] == 0.0
        assert rows[1][6] == 60.0
        assert all(distance > 0 for distance in distances)

    def test_rows_without_time(self):
        rows, _ = process_path_segments(_make_path(count=3), 10.0, 600.0)
        assert all(len(row) == 6 for row in rows)

    def test_identical_coordinates_filtered(self):
        path = [
            TrackPoint(50.0, 8.5, 1000.0, None),
            TrackPoint(50.0, 8.5, 1100.0, None),
            TrackPoint(50.1, 8.6, 1200.0, None),
        ]
        rows, distances = process_path_segments(path, 5.0, 120.0)
        assert len(rows) == 1
        assert rows[0][:4] == [50.0, 8.5, 50.1, 8.6]
        assert len(distances) == 1

    def test_altitude_rounded_to_100ft(self):
        path = [
            TrackPoint(50.0, 8.5, 1523.5, None),
            TrackPoint(50.1, 8.6, 1523.5, None),
        ]
        rows, _ = process_path_segments(path, 5.0, 60.0)
        assert rows[0][4] == 5000
        assert rows[0][4] % 100 == 0

    def test_missing_altitude_on_one_end_uses_the_other(self):
        path = [TrackPoint(50.0, 8.5, None, None), TrackPoint(50.1, 8.6, 304.8, None)]
        rows, _ = process_path_segments(path, 5.0, 60.0)
        assert rows[0][4] == 1000

    def test_missing_altitude_on_both_ends_skips_segment(self):
        path = [
            TrackPoint(50.0, 8.5, None, None),
            TrackPoint(50.1, 8.6, None, None),
            TrackPoint(50.2, 8.7, 100.0, None),
        ]
        rows, distances = process_path_segments(path, 5.0, 60.0)
        assert len(rows) == 1
        assert rows[0][:2] == [50.1, 8.6]
        assert len(distances) == 1

    def test_groundspeed_rounded(self):
        rows, _ = process_path_segments(_make_path(timed=True), 10.0, 540.0)
        for row in rows:
            assert row[5] == round(row[5], 1)
            assert row[5] > 0

    def test_relative_time_rounded(self):
        path = [
            TrackPoint(50.0, 8.5, 100.0, 1000.0),
            TrackPoint(50.1, 8.6, 100.0, 1000.0 + 61.26),
            TrackPoint(50.2, 8.7, 100.0, 1000.0 + 120.0),
        ]
        rows, _ = process_path_segments(path, 20.0, 120.0)
        assert rows[1][6] == 61.3
