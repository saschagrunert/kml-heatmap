"""Tests for export_reconciler module."""

import pytest

from kml_heatmap.constants import METERS_TO_FEET
from kml_heatmap.export_reconciler import _recalculate_stats_from_segments


class TestRecalculateStatsFromSegments:
    def _make_stats(self, aircraft_list=None):
        stats = {
            "total_points": 0,
            "min_altitude_m": 0,
            "max_altitude_m": 0,
            "min_altitude_ft": 0,
            "max_altitude_ft": 0,
            "total_altitude_gain_m": 0,
            "total_altitude_gain_ft": 0,
            "average_groundspeed_knots": 0,
            "cruise_speed_knots": 0,
            "total_flight_time_seconds": 0,
        }
        if aircraft_list is not None:
            stats["aircraft_list"] = aircraft_list
        return stats

    def test_empty_segments(self):
        stats = self._make_stats()
        _recalculate_stats_from_segments(stats, [], [])
        assert stats["total_points"] == 0

    def test_altitude_min_max(self):
        segments = [
            {"altitude_m": 500, "altitude_ft": 1640, "groundspeed_knots": 100},
            {"altitude_m": 1000, "altitude_ft": 3280, "groundspeed_knots": 120},
            {"altitude_m": 200, "altitude_ft": 656, "groundspeed_knots": 90},
        ]
        stats = self._make_stats()
        _recalculate_stats_from_segments(stats, segments, [])
        assert stats["min_altitude_m"] == 200
        assert stats["max_altitude_m"] == 1000
        assert stats["min_altitude_ft"] == pytest.approx(200 * METERS_TO_FEET)
        assert stats["max_altitude_ft"] == pytest.approx(1000 * METERS_TO_FEET)

    def test_altitude_gain(self):
        segments = [
            {"altitude_m": 100, "altitude_ft": 328, "groundspeed_knots": 100},
            {"altitude_m": 300, "altitude_ft": 984, "groundspeed_knots": 100},
            {"altitude_m": 200, "altitude_ft": 656, "groundspeed_knots": 100},
            {"altitude_m": 500, "altitude_ft": 1640, "groundspeed_knots": 100},
        ]
        stats = self._make_stats()
        _recalculate_stats_from_segments(stats, segments, [])
        assert stats["total_altitude_gain_m"] == pytest.approx(500.0)

    def test_average_groundspeed(self):
        segments = [
            {"altitude_m": 100, "altitude_ft": 328, "groundspeed_knots": 100},
            {"altitude_m": 100, "altitude_ft": 328, "groundspeed_knots": 150},
            {"altitude_m": 100, "altitude_ft": 328, "groundspeed_knots": 0},
        ]
        stats = self._make_stats()
        _recalculate_stats_from_segments(stats, segments, [])
        assert stats["average_groundspeed_knots"] == pytest.approx(125.0)

    def test_cruise_speed_above_threshold(self):
        min_alt_m = 100
        cruise_threshold = min_alt_m * METERS_TO_FEET + 1000
        segments = [
            {"altitude_m": min_alt_m, "altitude_ft": 328, "groundspeed_knots": 80},
            {
                "altitude_m": 2000,
                "altitude_ft": cruise_threshold + 500,
                "groundspeed_knots": 140,
            },
            {
                "altitude_m": 2000,
                "altitude_ft": cruise_threshold + 500,
                "groundspeed_knots": 160,
            },
        ]
        stats = self._make_stats()
        _recalculate_stats_from_segments(stats, segments, [])
        assert stats["cruise_speed_knots"] == pytest.approx(150.0)

    def test_cruise_altitude_histogram(self):
        min_alt_m = 100
        cruise_threshold = min_alt_m * METERS_TO_FEET + 1000
        high_alt = int(cruise_threshold + 500)
        segments = [
            {"altitude_m": min_alt_m, "altitude_ft": 328, "groundspeed_knots": 100},
            {
                "altitude_m": 2000,
                "altitude_ft": high_alt,
                "groundspeed_knots": 140,
                "time": 10.0,
            },
            {
                "altitude_m": 2000,
                "altitude_ft": high_alt,
                "groundspeed_knots": 140,
                "time": 20.0,
            },
            {
                "altitude_m": 2500,
                "altitude_ft": high_alt + 1000,
                "groundspeed_knots": 140,
                "time": 30.0,
            },
        ]
        stats = self._make_stats()
        _recalculate_stats_from_segments(stats, segments, [])
        assert "most_common_cruise_altitude_ft" in stats

    def test_flight_time_from_path_durations(self):
        segments = [
            {
                "altitude_m": 1000,
                "altitude_ft": 3280,
                "groundspeed_knots": 100,
                "time": 0.0,
                "path_id": 0,
            },
            {
                "altitude_m": 1000,
                "altitude_ft": 3280,
                "groundspeed_knots": 100,
                "time": 100.0,
                "path_id": 0,
            },
            {
                "altitude_m": 1000,
                "altitude_ft": 3280,
                "groundspeed_knots": 100,
                "time": 0.0,
                "path_id": 1,
            },
            {
                "altitude_m": 1000,
                "altitude_ft": 3280,
                "groundspeed_knots": 100,
                "time": 200.0,
                "path_id": 1,
            },
        ]
        stats = self._make_stats()
        _recalculate_stats_from_segments(stats, segments, [])
        assert stats["total_flight_time_seconds"] == pytest.approx(300.0)

    def test_total_points(self):
        segments = [
            {"altitude_m": 100, "altitude_ft": 328, "groundspeed_knots": 100},
            {"altitude_m": 200, "altitude_ft": 656, "groundspeed_knots": 100},
        ]
        stats = self._make_stats()
        _recalculate_stats_from_segments(stats, segments, [])
        assert stats["total_points"] == 4

    def test_per_aircraft_statistics(self):
        segments = [
            {
                "altitude_m": 1000,
                "altitude_ft": 3280,
                "groundspeed_knots": 100,
                "time": 0.0,
                "path_id": 0,
                "coords": [[50.0, 8.5], [50.01, 8.51]],
            },
            {
                "altitude_m": 1000,
                "altitude_ft": 3280,
                "groundspeed_knots": 100,
                "time": 300.0,
                "path_id": 0,
                "coords": [[50.01, 8.51], [50.02, 8.52]],
            },
        ]
        path_info = [{"id": 0, "aircraft_registration": "D-EAGJ"}]
        aircraft_list = [
            {
                "registration": "D-EAGJ",
                "flight_time_seconds": 0,
                "flight_distance_km": 0,
            }
        ]
        stats = self._make_stats(aircraft_list=aircraft_list)
        _recalculate_stats_from_segments(stats, segments, path_info)
        aircraft = stats["aircraft_list"][0]
        assert aircraft["flight_time_seconds"] == pytest.approx(300.0)
        assert aircraft["flight_distance_km"] > 0

    def test_zero_groundspeed_excluded_from_average(self):
        segments = [
            {"altitude_m": 100, "altitude_ft": 328, "groundspeed_knots": 0},
            {"altitude_m": 100, "altitude_ft": 328, "groundspeed_knots": 0},
            {"altitude_m": 100, "altitude_ft": 328, "groundspeed_knots": 120},
        ]
        stats = self._make_stats()
        _recalculate_stats_from_segments(stats, segments, [])
        assert stats["average_groundspeed_knots"] == pytest.approx(120.0)

    def test_no_altitude_gain_on_descent(self):
        segments = [
            {"altitude_m": 500, "altitude_ft": 1640, "groundspeed_knots": 100},
            {"altitude_m": 400, "altitude_ft": 1312, "groundspeed_knots": 100},
            {"altitude_m": 300, "altitude_ft": 984, "groundspeed_knots": 100},
        ]
        stats = self._make_stats()
        _recalculate_stats_from_segments(stats, segments, [])
        assert stats["total_altitude_gain_m"] == 0.0
