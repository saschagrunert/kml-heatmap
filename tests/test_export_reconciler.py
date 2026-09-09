"""Tests for export_reconciler module."""

import pytest

from kml_heatmap.constants import FEET_TO_METERS, KM_TO_NAUTICAL_MILES, METERS_TO_FEET
from kml_heatmap.export_reconciler import YearAggregate
from kml_heatmap.geometry import haversine_distance
from kml_heatmap.helpers import format_flight_time


def _row(alt_ft, gs, time=None, lat1=50.0, lon1=8.0, lat2=50.01, lon2=8.0):
    row = [lat1, lon1, lat2, lon2, alt_ft, gs]
    if time is not None:
        row.append(time)
    return row


def _distances(rows):
    return [haversine_distance(r[0], r[1], r[2], r[3]) for r in rows]


def _add(aggregate, rows, registration=None):
    aggregate.add_path(rows, _distances(rows), registration)


class TestAddPath:
    def test_altitude_min_max_from_feet(self):
        agg = YearAggregate()
        _add(agg, [_row(1600, 100), _row(3300, 120), _row(700, 90)])
        assert agg.min_altitude_ft == 700
        assert agg.max_altitude_ft == 3300

    def test_altitude_gain_resets_at_path_boundary(self):
        agg = YearAggregate()
        _add(agg, [_row(100, 100), _row(300, 100), _row(200, 100), _row(500, 100)])
        gain_one_path = (200 + 300) * FEET_TO_METERS
        assert agg.total_altitude_gain_m == pytest.approx(gain_one_path)

        # Second path starts lower: no gain may be counted across the boundary
        _add(agg, [_row(0, 100), _row(100, 100)])
        assert agg.total_altitude_gain_m == pytest.approx(
            gain_one_path + 100 * FEET_TO_METERS
        )

    def test_average_groundspeed_excludes_zero(self):
        agg = YearAggregate()
        _add(agg, [_row(100, 100), _row(100, 150), _row(100, 0)])
        assert agg.groundspeed_sum / agg.groundspeed_count == pytest.approx(125.0)
        assert agg.max_groundspeed_knots == 150
        assert agg.min_groundspeed_knots == 100

    def test_cruise_speed_weighted_by_distance(self):
        agg = YearAggregate()
        rows = [
            _row(100, 80),
            _row(1200, 150, lat1=50.0, lat2=50.01),
            _row(1300, 100, lat1=50.01, lat2=50.03),
        ]
        _add(agg, rows)
        d1, d2 = _distances(rows)[1:]
        nm1, nm2 = d1 * KM_TO_NAUTICAL_MILES, d2 * KM_TO_NAUTICAL_MILES
        assert agg.cruise_distance_nm == pytest.approx(nm1 + nm2)
        assert agg.cruise_time_hours == pytest.approx(nm1 / 150 + nm2 / 100)

    def test_cruise_uses_per_path_ground_level(self):
        agg = YearAggregate()
        # Path at 2000..2500 ft: only 2500 - 2000 = 500 ft AGL -> no cruise
        _add(agg, [_row(2000, 100), _row(2500, 100)])
        assert agg.cruise_altitude_bins == {}
        # Path from 0 to 1100 ft -> 1100 ft AGL is cruise
        _add(agg, [_row(0, 100), _row(1100, 100)])
        assert agg.cruise_altitude_bins == {1100: 1}

    def test_cruise_requires_groundspeed(self):
        agg = YearAggregate()
        _add(agg, [_row(0, 0), _row(2000, 0)])
        assert agg.cruise_altitude_bins == {}

    def test_flight_time_per_path(self):
        agg = YearAggregate()
        _add(agg, [_row(100, 100, 0.0), _row(100, 100, 100.0)])
        _add(agg, [_row(100, 100, 0.0), _row(100, 100, 200.0)])
        _add(agg, [_row(100, 100, 50.0)])
        _add(agg, [_row(100, 100)])
        assert agg.total_flight_time_seconds == pytest.approx(300.0)
        assert agg.num_paths == 4

    def test_per_aircraft_totals(self):
        agg = YearAggregate()
        rows = [_row(100, 100, 0.0), _row(100, 100, 300.0)]
        _add(agg, rows, "D-EAGJ")
        _add(agg, rows, "D-EAGJ")
        _add(agg, rows, None)
        assert agg.aircraft_time_seconds == {"D-EAGJ": 600.0}
        assert agg.aircraft_distance_km["D-EAGJ"] == pytest.approx(
            2 * sum(_distances(rows))
        )

    def test_longest_flight_and_total_distance(self):
        agg = YearAggregate()
        short = [_row(100, 100)]
        long = [_row(100, 100, lat2=50.5)]
        _add(agg, short)
        _add(agg, long)
        assert agg.longest_flight_km == pytest.approx(sum(_distances(long)))
        assert agg.total_distance_km == pytest.approx(
            sum(_distances(short)) + sum(_distances(long))
        )

    def test_empty_path_counts_but_adds_nothing(self):
        agg = YearAggregate()
        agg.add_path([], [], "D-EAGJ")
        assert agg.num_paths == 1
        assert agg.min_altitude_ft is None
        assert agg.aircraft_time_seconds == {}


class TestMerge:
    def test_merge_combines_everything(self):
        a = YearAggregate(total_points=3)
        _add(a, [_row(100, 100, 0.0), _row(300, 120, 60.0)], "D-EAGJ")
        b = YearAggregate(total_points=4)
        _add(b, [_row(50, 90, 0.0), _row(2000, 130, 120.0)], "D-EAGJ")
        _add(b, [_row(500, 0)], "D-EHYL")

        merged = YearAggregate()
        merged.merge(a)
        merged.merge(b)

        assert merged.total_points == 7
        assert merged.num_paths == 3
        assert merged.min_altitude_ft == 50
        assert merged.max_altitude_ft == 2000
        assert merged.min_groundspeed_knots == 90
        assert merged.max_groundspeed_knots == 130
        assert merged.groundspeed_count == 4
        assert merged.total_flight_time_seconds == pytest.approx(180.0)
        assert merged.aircraft_time_seconds == {"D-EAGJ": 180.0, "D-EHYL": 0.0}
        assert merged.cruise_altitude_bins == b.cruise_altitude_bins
        assert merged.total_distance_km == pytest.approx(
            a.total_distance_km + b.total_distance_km
        )

    def test_merge_into_empty_keeps_none_values(self):
        merged = YearAggregate()
        merged.merge(YearAggregate())
        assert merged.min_altitude_ft is None
        assert merged.min_groundspeed_or_zero == 0.0


class TestApplyToStats:
    def test_stats_are_internally_consistent(self):
        agg = YearAggregate(total_points=10)
        _add(agg, [_row(100, 100, 0.0), _row(300, 120, 90.0)], "D-EAGJ")
        _add(agg, [_row(0, 100, 0.0), _row(1500, 130, 45.0)], "D-EHYL")
        stats = {
            "aircraft_list": [{"registration": "D-EAGJ"}, {"registration": "D-XXXX"}]
        }

        agg.apply_to_stats(stats)

        assert stats["total_points"] == 10
        assert stats["num_paths"] == 2
        assert stats["min_altitude_m"] == pytest.approx(0.0)
        assert stats["max_altitude_m"] == pytest.approx(1500 * FEET_TO_METERS)
        assert stats["min_altitude_ft"] == pytest.approx(
            stats["min_altitude_m"] * METERS_TO_FEET
        )
        assert stats["max_altitude_ft"] == pytest.approx(
            stats["max_altitude_m"] * METERS_TO_FEET
        )
        assert stats["total_distance_nm"] == pytest.approx(
            stats["total_distance_km"] * KM_TO_NAUTICAL_MILES
        )
        assert stats["total_altitude_gain_ft"] == pytest.approx(
            stats["total_altitude_gain_m"] * METERS_TO_FEET
        )
        assert stats["max_groundspeed_knots"] == 130
        assert stats["avg_groundspeed_knots"] == pytest.approx(112.5)
        assert stats["cruise_speed_knots"] == pytest.approx(130)
        assert stats["most_common_cruise_altitude_ft"] == 1500
        assert stats["most_common_cruise_altitude_m"] == round(1500 * FEET_TO_METERS, 1)
        assert stats["total_flight_time_seconds"] == pytest.approx(135.0)
        assert stats["total_flight_time_str"] == format_flight_time(135.0)
        assert stats["longest_flight_nm"] == pytest.approx(
            stats["longest_flight_km"] * KM_TO_NAUTICAL_MILES, abs=0.1
        )
        eagj, other = stats["aircraft_list"]
        assert eagj["flight_time_seconds"] == 90.0
        assert eagj["flight_time_str"] == "0h 1m"
        assert eagj["flight_distance_km"] > 0
        assert other == {
            "registration": "D-XXXX",
            "flight_time_seconds": 0.0,
            "flight_time_str": "0h 0m",
            "flight_distance_km": 0.0,
        }

    def test_no_segments_gives_zero_and_none(self):
        stats = {}
        YearAggregate().apply_to_stats(stats)
        assert stats["total_points"] == 0
        assert stats["min_altitude_m"] is None
        assert stats["max_altitude_ft"] is None
        assert stats["avg_groundspeed_knots"] == 0.0
        assert stats["cruise_speed_knots"] == 0.0
        assert stats["most_common_cruise_altitude_ft"] == 0
        assert stats["total_flight_time_str"] == "0h 0m"
        assert stats["longest_flight_km"] == 0.0

    def test_most_common_altitude_ties_resolve_to_lowest(self):
        agg = YearAggregate()
        _add(agg, [_row(0, 100), _row(3000, 100), _row(2000, 100)])
        stats = {}
        agg.apply_to_stats(stats)
        assert stats["most_common_cruise_altitude_ft"] == 2000

    def test_altitude_stats_match_frontend_derivation(self):
        agg = YearAggregate()
        _add(agg, [_row(1700, 100), _row(2300, 100)])
        stats = {}
        agg.apply_to_stats(stats)
        # The frontend derives altitude_m = altitude_ft * FEET_TO_METERS
        assert stats["min_altitude_m"] == 1700 * FEET_TO_METERS
        assert stats["max_altitude_m"] == 2300 * FEET_TO_METERS
