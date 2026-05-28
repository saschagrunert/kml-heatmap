"""Tests for export_pipeline module."""

import pytest

from kml_heatmap.export_pipeline import _build_path_info, _process_path_segments


class TestBuildPathInfo:
    def _make_path(self, count=10):
        return [[50.0 + i * 0.01, 8.5 + i * 0.01, 1000.0] for i in range(count)]

    def test_airport_name_parsing(self):
        metadata = {
            "airport_name": "EDDS - EDDP",
            "timestamp": "2025-03-03T08:00:00Z",
            "end_timestamp": "2025-03-03T09:30:00Z",
        }
        info, duration, dist_km, dist_nm = _build_path_info(
            self._make_path(), metadata, 0, 2025
        )
        assert info["start_airport"] == "EDDS"
        assert info["end_airport"] == "EDDP"
        assert info["year"] == 2025
        assert info["id"] == 0

    def test_no_airport_name(self):
        metadata = {"airport_name": "", "timestamp": None, "end_timestamp": None}
        info, _, _, _ = _build_path_info(self._make_path(), metadata, 1, 2025)
        assert info["start_airport"] is None
        assert info["end_airport"] is None

    def test_single_airport_no_split(self):
        metadata = {
            "airport_name": "EDDS",
            "timestamp": None,
            "end_timestamp": None,
        }
        info, _, _, _ = _build_path_info(self._make_path(), metadata, 0, 2025)
        assert info["start_airport"] is None
        assert info["end_airport"] is None

    def test_missing_timestamps_zero_duration(self):
        metadata = {"airport_name": "", "timestamp": None, "end_timestamp": None}
        _, duration, _, _ = _build_path_info(self._make_path(), metadata, 0, 2025)
        assert duration == 0.0

    def test_valid_timestamps_duration(self):
        metadata = {
            "airport_name": "",
            "timestamp": "2025-03-03T08:00:00Z",
            "end_timestamp": "2025-03-03T09:30:00Z",
        }
        _, duration, _, _ = _build_path_info(self._make_path(), metadata, 0, 2025)
        assert duration == pytest.approx(5400.0, abs=1.0)

    def test_distance_calculation(self):
        metadata = {"airport_name": "", "timestamp": None, "end_timestamp": None}
        _, _, dist_km, dist_nm = _build_path_info(self._make_path(), metadata, 0, 2025)
        assert dist_km > 0
        assert dist_nm > 0
        assert dist_nm == pytest.approx(dist_km * 0.539957, rel=0.01)

    def test_aircraft_metadata_included(self):
        metadata = {
            "airport_name": "",
            "timestamp": None,
            "end_timestamp": None,
            "aircraft_registration": "D-EAGJ",
            "aircraft_type": "C172",
        }
        info, _, _, _ = _build_path_info(self._make_path(), metadata, 0, 2025)
        assert info["aircraft_registration"] == "D-EAGJ"
        assert info["aircraft_type"] == "C172"

    def test_segment_count(self):
        path = self._make_path(count=5)
        metadata = {"airport_name": "", "timestamp": None, "end_timestamp": None}
        info, _, _, _ = _build_path_info(path, metadata, 0, 2025)
        assert info["segment_count"] == 4

    def test_start_end_coords(self):
        path = self._make_path(count=3)
        metadata = {"airport_name": "", "timestamp": None, "end_timestamp": None}
        info, _, _, _ = _build_path_info(path, metadata, 0, 2025)
        assert info["start_coords"] == [path[0][0], path[0][1]]
        assert info["end_coords"] == [path[-1][0], path[-1][1]]


class TestProcessPathSegments:
    def _make_path_with_timestamps(self, count=10):
        path = []
        for i in range(count):
            lat = 50.0 + i * 0.01
            lon = 8.5 + i * 0.01
            alt = 1000.0 + i * 50
            ts = f"2025-03-03T08:{i:02d}:00Z"
            path.append([lat, lon, alt, ts])
        return path

    def test_generates_segments(self):
        path = self._make_path_with_timestamps()
        segments, max_gs, min_gs, cruise_dist, cruise_time, hist = (
            _process_path_segments(path, 0, 10.0, 540.0)
        )
        assert len(segments) > 0

    def test_identical_coordinates_filtered(self):
        path = [
            [50.0, 8.5, 1000.0, "2025-03-03T08:00:00Z"],
            [50.0, 8.5, 1100.0, "2025-03-03T08:01:00Z"],
            [50.1, 8.6, 1200.0, "2025-03-03T08:02:00Z"],
        ]
        segments, _, _, _, _, _ = _process_path_segments(path, 0, 5.0, 120.0)
        coords_in_segments = [s["coords"] for s in segments]
        for coords in coords_in_segments:
            assert coords[0] != coords[1]

    def test_segment_data_fields(self):
        path = self._make_path_with_timestamps(count=3)
        segments, _, _, _, _, _ = _process_path_segments(path, 5, 5.0, 120.0)
        if segments:
            seg = segments[0]
            assert "coords" in seg
            assert "altitude_ft" in seg
            assert "altitude_m" in seg
            assert "groundspeed_knots" in seg
            assert seg["path_id"] == 5

    def test_path_without_timestamps(self):
        path = [
            [50.0, 8.5, 1000.0],
            [50.1, 8.6, 1100.0],
            [50.2, 8.7, 1200.0],
        ]
        segments, _, _, _, _, _ = _process_path_segments(path, 0, 10.0, 600.0)
        assert len(segments) > 0
        for seg in segments:
            assert "time" not in seg

    def test_groundspeed_tracking(self):
        path = self._make_path_with_timestamps(count=5)
        _, max_gs, min_gs, _, _, _ = _process_path_segments(path, 0, 5.0, 240.0)
        assert max_gs >= 0
        if min_gs < float("inf"):
            assert min_gs <= max_gs

    def test_altitude_rounding(self):
        path = [
            [50.0, 8.5, 1523.5, "2025-03-03T08:00:00Z"],
            [50.1, 8.6, 1523.5, "2025-03-03T08:01:00Z"],
        ]
        segments, _, _, _, _, _ = _process_path_segments(path, 0, 5.0, 60.0)
        if segments:
            assert segments[0]["altitude_ft"] % 100 == 0
