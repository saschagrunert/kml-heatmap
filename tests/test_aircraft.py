"""Tests for aircraft module."""

import json
import tempfile

import pytest
from pathlib import Path
from kml_heatmap.aircraft import (
    parse_aircraft_from_filename,
    lookup_aircraft_model,
)
import kml_heatmap.aircraft as aircraft_mod


class TestParseAircraftFromFilename:
    """Tests for parse_aircraft_from_filename function."""

    def test_incomplete_format(self):
        """Test parsing filename with incomplete format."""
        result = parse_aircraft_from_filename("flight_log.kml")
        assert isinstance(result, dict)
        assert result == {}

    def test_empty_filename(self):
        """Test parsing empty filename."""
        result = parse_aircraft_from_filename("")
        assert isinstance(result, dict)
        assert result == {}


class TestParseAircraftFromFilenameCharterware:
    """Tests for Charterware filename format."""

    def test_charterware_format(self):
        """Test parsing Charterware filename."""
        result = parse_aircraft_from_filename("2026-01-12_1513h_OE-AKI_LOAV-LOAV.kml")
        assert isinstance(result, dict)
        assert result.get("registration") == "OE-AKI"
        assert result.get("type") is None
        assert result.get("route") == "LOAV-LOAV"
        assert result.get("format") == "charterware"

    def test_charterware_different_registration(self):
        """Test Charterware with different registration."""
        result = parse_aircraft_from_filename("2026-01-15_1000h_D-EXYZ_EDDF-EDDM.kml")
        assert isinstance(result, dict)
        assert result.get("registration") == "D-EXYZ"
        assert result.get("type") is None
        assert result.get("route") == "EDDF-EDDM"
        assert result.get("format") == "charterware"

    def test_charterware_round_trip(self):
        """Test Charterware round trip route (same departure/arrival)."""
        result = parse_aircraft_from_filename("2026-01-12_1513h_OE-AKI_LOAV-LOAV.kml")
        assert isinstance(result, dict)
        assert result.get("route") == "LOAV-LOAV"

    def test_charterware_international_registration(self):
        """Test Charterware with various international registrations."""
        result = parse_aircraft_from_filename("2026-02-10_0900h_OE-ABC_LOWW-LOWI.kml")
        assert result.get("registration") == "OE-ABC"
        assert result.get("format") == "charterware"

        result = parse_aircraft_from_filename("2026-03-15_1200h_HB-XYZ_LSZH-LSGG.kml")
        assert result.get("registration") == "HB-XYZ"
        assert result.get("format") == "charterware"

    def test_charterware_different_routes(self):
        """Test Charterware with different route combinations."""
        result = parse_aircraft_from_filename("2026-01-20_1400h_D-EAGJ_EDDF-EDDM.kml")
        assert result.get("route") == "EDDF-EDDM"

        result = parse_aircraft_from_filename("2026-02-05_1100h_OE-AKI_LOWW-EDDF.kml")
        assert result.get("route") == "LOWW-EDDF"

    def test_charterware_without_extension(self):
        """Test Charterware filename without .kml extension."""
        result = parse_aircraft_from_filename("2026-01-12_1513h_OE-AKI_LOAV-LOAV")
        assert isinstance(result, dict)
        assert result.get("registration") == "OE-AKI"


class TestParseAircraftFromFilenameNumbered:
    """Tests for numbered filename format (N_REG_TYPE)."""

    def test_numbered_format(self):
        """Test parsing numbered filename."""
        result = parse_aircraft_from_filename("1_DEHYL_DA40.kml")
        assert result.get("registration") == "D-EHYL"
        assert result.get("type") == "DA40"
        assert result.get("format") == "numbered"

    def test_numbered_format_large_number(self):
        """Test parsing numbered filename with large number."""
        result = parse_aircraft_from_filename("87_DESST_C172.kml")
        assert result.get("registration") == "D-ESST"
        assert result.get("type") == "C172"
        assert result.get("format") == "numbered"

    def test_numbered_format_without_extension(self):
        """Test parsing numbered filename without .kml extension."""
        result = parse_aircraft_from_filename("42_DELGD_C182")
        assert result.get("registration") == "D-ELGD"
        assert result.get("type") == "C182"
        assert result.get("format") == "numbered"

    def test_numbered_format_non_german_registration(self):
        """Test numbered format with non-German registration."""
        result = parse_aircraft_from_filename("5_OE-AKI_PA28.kml")
        assert result.get("registration") == "OE-AKI"
        assert result.get("type") == "PA28"
        assert result.get("format") == "numbered"


class TestLookupAircraftModel:
    """Tests for lookup_aircraft_model with aircraft.json file."""

    @pytest.fixture(autouse=True)
    def _clear_cache(self):
        aircraft_mod._aircraft_cache = None
        aircraft_mod._aircraft_cache_path = None

    def test_lookup_found(self):
        """Test looking up an existing registration."""
        with tempfile.NamedTemporaryFile(mode="w", delete=False, suffix=".json") as f:
            json.dump({"D-EAGJ": "Diamond DA-20A-1 Katana"}, f)
            path = Path(f.name)

        try:
            result = lookup_aircraft_model("D-EAGJ", path)
            assert result == "Diamond DA-20A-1 Katana"
        finally:
            path.unlink()

    def test_lookup_not_found(self):
        """Test looking up a missing registration."""
        with tempfile.NamedTemporaryFile(mode="w", delete=False, suffix=".json") as f:
            json.dump({"D-EAGJ": "Diamond DA-20A-1 Katana"}, f)
            path = Path(f.name)

        try:
            result = lookup_aircraft_model("D-XXXX", path)
            assert result is None
        finally:
            path.unlink()

    def test_lookup_no_file(self):
        """Test lookup without aircraft file returns None."""
        result = lookup_aircraft_model("D-EAGJ")
        assert result is None

    def test_lookup_nonexistent_file(self):
        """Test lookup with nonexistent file returns None."""
        result = lookup_aircraft_model("D-EAGJ", Path("/nonexistent/aircraft.json"))
        assert result is None

    def test_lookup_corrupt_json(self):
        """Test lookup with corrupt JSON file returns None."""
        with tempfile.NamedTemporaryFile(mode="w", delete=False, suffix=".json") as f:
            f.write("{invalid json")
            path = Path(f.name)

        try:
            result = lookup_aircraft_model("D-EAGJ", path)
            assert result is None
        finally:
            path.unlink()

    def test_lookup_multiple_registrations(self):
        """Test looking up multiple registrations from same file."""
        data = {
            "D-EAGJ": "Diamond DA-20A-1 Katana",
            "D-EHYL": "Diamond DA-40TDI Diamond Star",
            "D-ESST": "1978 Cessna 172N",
        }
        with tempfile.NamedTemporaryFile(mode="w", delete=False, suffix=".json") as f:
            json.dump(data, f)
            path = Path(f.name)

        try:
            assert lookup_aircraft_model("D-EAGJ", path) == "Diamond DA-20A-1 Katana"
            assert (
                lookup_aircraft_model("D-EHYL", path) == "Diamond DA-40TDI Diamond Star"
            )
            assert lookup_aircraft_model("D-ESST", path) == "1978 Cessna 172N"
        finally:
            path.unlink()
