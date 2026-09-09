"""Tests for aircraft module."""

import json

import pytest

from kml_heatmap.aircraft import (
    load_aircraft_data,
    lookup_aircraft_model,
    merge_aircraft_data,
    normalize_registration,
    parse_aircraft_from_filename,
)


class TestNormalizeRegistration:
    @pytest.mark.parametrize(
        "raw,expected",
        [
            ("DEAGJ", "D-EAGJ"),
            ("OEAKI", "OE-AKI"),
            ("HBXYZ", "HB-XYZ"),
            ("GABCD", "G-ABCD"),
            ("FGXYZ", "F-GXYZ"),
            ("IABCD", "I-ABCD"),
            ("PHABC", "PH-ABC"),
            ("OOABC", "OO-ABC"),
            ("LXABC", "LX-ABC"),
            ("SEABC", "SE-ABC"),
            ("OYABC", "OY-ABC"),
            ("LNABC", "LN-ABC"),
            ("OHABC", "OH-ABC"),
            ("EIABC", "EI-ABC"),
            ("SPABC", "SP-ABC"),
            ("OKABC", "OK-ABC"),
            ("OMABC", "OM-ABC"),
            ("HAABC", "HA-ABC"),
            ("9AABC", "9A-ABC"),
            ("S5ABC", "S5-ABC"),
            ("YUABC", "YU-ABC"),
            ("LZABC", "LZ-ABC"),
            ("YRABC", "YR-ABC"),
            ("SXABC", "SX-ABC"),
            ("TCABC", "TC-ABC"),
            ("ECABC", "EC-ABC"),
            ("CSABC", "CS-ABC"),
            ("ESABC", "ES-ABC"),
            ("YLABC", "YL-ABC"),
            ("LYABC", "LY-ABC"),
        ],
    )
    def test_prefix_table(self, raw, expected):
        assert normalize_registration(raw) == expected

    def test_us_registration_has_no_hyphen(self):
        assert normalize_registration("N12345") == "N12345"

    def test_existing_hyphen_kept(self):
        assert normalize_registration("OE-AKI") == "OE-AKI"

    def test_unknown_prefix_unchanged(self):
        assert normalize_registration("ZZ123") == "ZZ123"

    def test_prefix_only_unchanged(self):
        assert normalize_registration("D") == "D"
        assert normalize_registration("") == ""


class TestParseAircraftFromFilenameNumbered:
    def test_numbered_format(self):
        result = parse_aircraft_from_filename("1_DEHYL_DA40.kml")
        assert result == {
            "registration": "D-EHYL",
            "type": "DA40",
            "format": "numbered",
        }

    def test_uppercase_extension(self):
        result = parse_aircraft_from_filename("23_DEHYL_DA40.KML")
        assert result["type"] == "DA40"
        assert result["registration"] == "D-EHYL"

    def test_large_number(self):
        result = parse_aircraft_from_filename("87_DESST_C172.kml")
        assert result["registration"] == "D-ESST"
        assert result["type"] == "C172"

    def test_without_extension(self):
        result = parse_aircraft_from_filename("42_DELGD_C182")
        assert result["registration"] == "D-ELGD"
        assert result["type"] == "C182"

    def test_non_german_registration(self):
        result = parse_aircraft_from_filename("5_OE-AKI_PA28.kml")
        assert result["registration"] == "OE-AKI"
        assert result["type"] == "PA28"

    def test_austrian_registration_without_hyphen(self):
        result = parse_aircraft_from_filename("5_OEAKI_PA28.kml")
        assert result["registration"] == "OE-AKI"

    def test_extra_underscore_still_parses_first_three_parts(self):
        result = parse_aircraft_from_filename("7_DEAGJ_DA20_copy.kml")
        assert result["registration"] == "D-EAGJ"
        assert result["type"] == "DA20"
        assert result["format"] == "numbered"


class TestParseAircraftFromFilenameCharterware:
    def test_charterware_format(self):
        result = parse_aircraft_from_filename("2026-01-12_1513h_OE-AKI_LOAV-LOAV.kml")
        assert result == {
            "registration": "OE-AKI",
            "type": None,
            "route": "LOAV-LOAV",
            "format": "charterware",
        }

    def test_different_route(self):
        result = parse_aircraft_from_filename("2026-01-15_1000h_D-EXYZ_EDDF-EDDM.kml")
        assert result["registration"] == "D-EXYZ"
        assert result["route"] == "EDDF-EDDM"

    def test_without_extension(self):
        result = parse_aircraft_from_filename("2026-01-12_1513h_OE-AKI_LOAV-LOAV")
        assert result["registration"] == "OE-AKI"

    def test_invalid_calendar_date_rejected(self):
        assert parse_aircraft_from_filename("2026-02-30_1513h_OE-AKI_LOAV.kml") == {}

    def test_malformed_date_rejected(self):
        assert parse_aircraft_from_filename("2026-1-2_1513h_OE-AKI_LOAV.kml") == {}

    @pytest.mark.parametrize("time_part", ["1513", "2513h", "1575h", "abcdh"])
    def test_invalid_time_rejected(self, time_part):
        name = f"2026-01-12_{time_part}_OE-AKI_LOAV-LOAV.kml"
        assert parse_aircraft_from_filename(name) == {}


class TestParseAircraftFromFilenameUnrecognized:
    @pytest.mark.parametrize("name", ["flight_log.kml", "", "track.kml", "a_b.kml"])
    def test_unrecognized_returns_empty(self, name):
        assert parse_aircraft_from_filename(name) == {}


class TestLoadAircraftData:
    def test_loads_mapping(self, tmp_path):
        path = tmp_path / "aircraft.json"
        path.write_text(json.dumps({"D-EAGJ": "Diamond DA-20A-1 Katana"}))
        assert load_aircraft_data(path) == {"D-EAGJ": "Diamond DA-20A-1 Katana"}

    def test_corrupt_json_returns_empty(self, tmp_path):
        path = tmp_path / "aircraft.json"
        path.write_text("{invalid json")
        assert load_aircraft_data(path) == {}

    def test_missing_file_returns_empty(self, tmp_path):
        assert load_aircraft_data(tmp_path / "missing.json") == {}

    def test_non_object_returns_empty(self, tmp_path):
        path = tmp_path / "aircraft.json"
        path.write_text(json.dumps(["D-EAGJ"]))
        assert load_aircraft_data(path) == {}


class TestMergeAircraftData:
    def test_first_file_wins_on_conflict(self, tmp_path):
        first = tmp_path / "a" / "aircraft.json"
        second = tmp_path / "b" / "aircraft.json"
        first.parent.mkdir()
        second.parent.mkdir()
        first.write_text(json.dumps({"D-EAGJ": "First", "D-EHYL": "Only first"}))
        second.write_text(json.dumps({"D-EAGJ": "Second", "D-ESST": "Only second"}))

        merged = merge_aircraft_data([first, second])

        assert merged == {
            "D-EAGJ": "First",
            "D-EHYL": "Only first",
            "D-ESST": "Only second",
        }

    def test_empty_input(self):
        assert merge_aircraft_data([]) == {}


class TestLookupAircraftModel:
    def test_lookup_found(self):
        data = {"D-EAGJ": "Diamond DA-20A-1 Katana"}
        assert lookup_aircraft_model("D-EAGJ", data) == "Diamond DA-20A-1 Katana"

    def test_lookup_not_found(self):
        assert lookup_aircraft_model("D-XXXX", {"D-EAGJ": "Katana"}) is None

    def test_lookup_without_data(self):
        assert lookup_aircraft_model("D-EAGJ") is None
        assert lookup_aircraft_model("D-EAGJ", {}) is None
