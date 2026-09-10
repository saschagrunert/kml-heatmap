"""Tests for statistics module."""

from kml_heatmap.statistics import aggregate_aircraft_stats, calculate_statistics


def _meta(reg=None, atype=None, filename=None):
    meta = {"start_point": [50.0, 8.5, 100.0], "airport_name": "EDDF - KJFK"}
    if reg:
        meta["aircraft_registration"] = reg
    if atype:
        meta["aircraft_type"] = atype
    if filename:
        meta["filename"] = filename
    return meta


class TestCalculateStatistics:
    def test_base_structure(self):
        stats = calculate_statistics([])
        assert stats == {
            "total_points": 0,
            "num_paths": 0,
            "total_distance_km": 0.0,
            "total_distance_nm": 0.0,
            "total_altitude_gain_m": 0.0,
            "total_altitude_gain_ft": 0.0,
            "min_altitude_m": None,
            "max_altitude_m": None,
            "min_altitude_ft": None,
            "max_altitude_ft": None,
            "total_flight_time_seconds": 0.0,
            "total_flight_time_str": "0h 0m",
            "avg_groundspeed_knots": 0.0,
            "max_groundspeed_knots": 0.0,
        }

    def test_no_metadata_argument(self):
        assert "aircraft_list" not in calculate_statistics()

    def test_with_aircraft_metadata(self):
        stats = calculate_statistics([_meta("D-EAGJ", "DA20", "flight1.kml")])
        assert stats["num_aircraft"] == 1
        assert stats["aircraft_types"] == ["DA20"]
        assert stats["aircraft_list"][0]["registration"] == "D-EAGJ"
        assert stats["aircraft_list"][0]["model"] == "DA20"

    def test_model_lookup_from_aircraft_data(self):
        stats = calculate_statistics(
            [_meta("D-EAGJ", "DA20", "flight1.kml")], {"D-EAGJ": "Diamond Katana"}
        )
        assert stats["aircraft_list"][0]["model"] == "Diamond Katana"


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
