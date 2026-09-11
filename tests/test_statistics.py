"""Tests for statistics module."""

import pytest

from kml_heatmap.constants import FEET_TO_METERS, KM_TO_NAUTICAL_MILES, METERS_TO_FEET
from kml_heatmap.export_reconciler import YearAggregate
from kml_heatmap.helpers import format_flight_time
from kml_heatmap.statistics import aggregate_aircraft_stats, build_statistics
from tests.test_export_reconciler import _add, _row


def _meta(reg=None, atype=None, filename=None):
    meta = {"start_point": [50.0, 8.5, 100.0], "airport_name": "EDDF - KJFK"}
    if reg:
        meta["aircraft_registration"] = reg
    if atype:
        meta["aircraft_type"] = atype
    if filename:
        meta["filename"] = filename
    return meta


class TestBuildStatistics:
    def test_empty_aggregate_gives_zeros_and_nones(self):
        stats = build_statistics(YearAggregate(), [])
        assert stats == {
            "total_points": 0,
            "num_paths": 0,
            "total_distance_km": 0.0,
            "total_distance_nm": 0.0,
            "min_altitude_m": None,
            "max_altitude_m": None,
            "min_altitude_ft": None,
            "max_altitude_ft": None,
            "total_altitude_gain_m": 0.0,
            "total_altitude_gain_ft": 0.0,
            "total_flight_time_seconds": 0.0,
            "total_flight_time_str": "0h 0m",
            "avg_groundspeed_knots": 0.0,
            "max_groundspeed_knots": 0.0,
            "cruise_speed_knots": 0.0,
            "most_common_cruise_altitude_ft": None,
            "most_common_cruise_altitude_m": None,
            "longest_flight_km": 0.0,
            "longest_flight_nm": 0.0,
            "num_airports": 0,
            "airport_names": [],
            "num_aircraft": 0,
            "aircraft_types": [],
            "aircraft_list": [],
        }

    def test_stats_are_internally_consistent(self):
        agg = YearAggregate(total_points=10)
        _add(agg, [_row(100, 100, 0.0), _row(300, 120, 90.0)], "D-EAGJ")
        _add(agg, [_row(0, 100, 0.0), _row(1500, 130, 45.0)], "D-EHYL")
        metadata = [
            _meta("D-EAGJ", "DA20", "a.kml"),
            _meta("D-EHYL", "DA40", "b.kml"),
            _meta("D-XXXX", None, "c.kml"),
        ]

        stats = build_statistics(
            agg, metadata, ["EDDK Cologne", "EDDF Frankfurt"], {"D-EAGJ": "Katana"}
        )

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
        assert stats["num_airports"] == 2
        assert stats["airport_names"] == ["EDDF Frankfurt", "EDDK Cologne"]
        assert stats["num_aircraft"] == 3
        assert stats["aircraft_types"] == ["DA20", "DA40"]
        eagj, ehyl, other = stats["aircraft_list"]
        assert eagj["model"] == "Katana"
        assert eagj["flight_time_seconds"] == 90.0
        assert eagj["flight_time_str"] == "0h 1m"
        assert eagj["flight_distance_km"] > 0
        assert ehyl["flight_time_seconds"] == 45.0
        assert other == {
            "registration": "D-XXXX",
            "type": None,
            "model": None,
            "flights": 1,
            "flight_time_seconds": 0.0,
            "flight_time_str": "0h 0m",
            "flight_distance_km": 0.0,
        }

    def test_most_common_altitude_ties_resolve_to_lowest(self):
        agg = YearAggregate()
        _add(agg, [_row(0, 100), _row(3000, 100), _row(2000, 100)])
        assert build_statistics(agg, [])["most_common_cruise_altitude_ft"] == 2000

    def test_altitude_stats_match_frontend_derivation(self):
        agg = YearAggregate()
        _add(agg, [_row(1700, 100), _row(2300, 100)])
        stats = build_statistics(agg, [])
        # The frontend derives altitude_m = altitude_ft * FEET_TO_METERS
        assert stats["min_altitude_m"] == 1700 * FEET_TO_METERS
        assert stats["max_altitude_m"] == 2300 * FEET_TO_METERS

    def test_airport_names_are_sorted(self):
        stats = build_statistics(YearAggregate(), [], ["B", "A"])
        assert stats["airport_names"] == ["A", "B"]


class TestAggregateAircraftStats:
    def test_empty_metadata(self):
        assert aggregate_aircraft_stats([]) == {
            "num_aircraft": 0,
            "aircraft_types": [],
            "aircraft_list": [],
        }

    def test_no_registration(self):
        result = aggregate_aircraft_stats([_meta(atype="C172")])
        assert result["num_aircraft"] == 0
        assert result["aircraft_types"] == ["C172"]

    def test_single_aircraft(self):
        result = aggregate_aircraft_stats([_meta("D-EAGJ", "DA20", "flight1.kml")])
        assert result["num_aircraft"] == 1
        assert result["aircraft_list"] == [
            {
                "registration": "D-EAGJ",
                "type": "DA20",
                "model": "DA20",
                "flights": 1,
                "flight_time_seconds": 0.0,
                "flight_time_str": "0h 0m",
                "flight_distance_km": 0.0,
            }
        ]

    def test_totals_from_aggregate(self):
        agg = YearAggregate()
        _add(agg, [_row(100, 100, 0.0), _row(100, 100, 300.0)], "D-EAGJ")
        result = aggregate_aircraft_stats(
            [_meta("D-EAGJ", "DA20", "flight1.kml")], aggregate=agg
        )
        entry = result["aircraft_list"][0]
        assert entry["flight_time_seconds"] == 300.0
        assert entry["flight_time_str"] == "0h 5m"
        assert entry["flight_distance_km"] == pytest.approx(agg.total_distance_km)

    def test_flights_count_unique_files(self):
        metadata = [
            _meta("D-EAGJ", "DA20", "flight1.kml"),
            _meta("D-EAGJ", "DA20", "flight1.kml"),
            _meta("D-EAGJ", "DA20", "flight2.kml"),
            _meta("D-EAGJ", "DA20"),
        ]
        assert aggregate_aircraft_stats(metadata)["aircraft_list"][0]["flights"] == 2

    def test_multiple_aircraft_sorted_by_flights(self):
        metadata = [
            _meta("D-EAGJ", "DA20", "flight1.kml"),
            _meta("D-EHYL", "DA40", "flight2.kml"),
            _meta("D-EHYL", "DA40", "flight3.kml"),
        ]
        result = aggregate_aircraft_stats(metadata)
        assert result["num_aircraft"] == 2
        assert result["aircraft_types"] == ["DA20", "DA40"]
        assert [(a["registration"], a["flights"]) for a in result["aircraft_list"]] == [
            ("D-EHYL", 2),
            ("D-EAGJ", 1),
        ]

    def test_type_backfilled_from_later_metadata(self):
        metadata = [
            _meta("D-EAGJ", None, "flight1.kml"),
            _meta("D-EAGJ", "DA20", "flight2.kml"),
        ]
        result = aggregate_aircraft_stats(metadata)
        assert result["aircraft_list"][0]["type"] == "DA20"

    def test_model_falls_back_to_type_when_lookup_fails(self):
        result = aggregate_aircraft_stats(
            [_meta("D-XXXX", None, "flight1.kml")], {"D-EAGJ": "Katana"}
        )
        assert result["aircraft_list"][0]["type"] is None
        assert result["aircraft_list"][0]["model"] is None

    def test_model_lookup_logged(self, capsys):
        aggregate_aircraft_stats(
            [_meta("D-EAGJ", "DA20", "f.kml")], {"D-EAGJ": "Katana"}
        )
        assert "D-EAGJ: Katana" in capsys.readouterr().out
