"""Tests for parser_common module."""

from xml.etree import ElementTree as ET

import pytest

from kml_heatmap.parser_common import (
    _build_path_metadata_dict,
    extract_charterware_timestamp,
    extract_placemark_metadata,
    extract_year_from_timestamp,
    find_xml_element,
    find_xml_elements,
    is_mid_flight_start,
    is_valid_landing,
    parse_coordinate_point,
    sample_path_altitudes,
)


class TestExtractYearFromTimestamp:
    def test_iso_format(self):
        assert extract_year_from_timestamp("2025-03-03T08:58:01Z") == 2025

    def test_iso_format_with_offset(self):
        assert extract_year_from_timestamp("2026-01-15T10:30:00+02:00") == 2026

    def test_date_only(self):
        assert extract_year_from_timestamp("2025-03-03") == 2025

    def test_text_date(self):
        assert extract_year_from_timestamp("03 Mar 2025") == 2025

    def test_none_input(self):
        assert extract_year_from_timestamp(None) is None

    def test_empty_string(self):
        assert extract_year_from_timestamp("") is None

    def test_invalid_format(self):
        assert extract_year_from_timestamp("not-a-date") is None

    def test_year_in_text(self):
        assert extract_year_from_timestamp("Log Start: 03 Mar 2025 08:58 Z") == 2025


class TestSamplePathAltitudes:
    def test_short_path_returns_none(self):
        path = [[50, 8, 100]] * 10
        assert sample_path_altitudes(path) is None

    def test_path_too_short_for_sample(self):
        path = [[50, 8, 100]] * 22
        assert sample_path_altitudes(path) is None

    def test_from_start(self):
        path = [[50, 8, float(i * 10)] for i in range(100)]
        result = sample_path_altitudes(path, from_end=False)
        assert result is not None
        assert result["min"] == 0.0
        assert result["max"] < 250.0
        assert result["variation"] == result["max"] - result["min"]

    def test_from_end(self):
        path = [[50, 8, float(i * 10)] for i in range(100)]
        result = sample_path_altitudes(path, from_end=True)
        assert result is not None
        assert result["max"] == 990.0

    def test_flat_altitude(self):
        path = [[50, 8, 500.0]] * 100
        result = sample_path_altitudes(path, from_end=False)
        assert result is not None
        assert result["variation"] == 0.0


class TestIsMidFlightStart:
    def _make_path(self, alt, count=100):
        return [[50.0, 8.0, alt]] * count

    def test_ground_level_start(self):
        assert is_mid_flight_start(self._make_path(50.0), 50.0) is False

    def test_mid_flight_cruise(self):
        assert is_mid_flight_start(self._make_path(1500.0), 1500.0) is True

    def test_climbing_start_high_variation(self):
        path = [[50.0, 8.0, float(100 + i * 20)] for i in range(100)]
        assert is_mid_flight_start(path, 100.0) is False

    def test_short_path(self):
        path = [[50.0, 8.0, 2000.0]] * 5
        assert is_mid_flight_start(path, 2000.0) is False


class TestIsValidLanding:
    def _make_path(self, alt, count=100):
        return [[50.0, 8.0, alt]] * count

    def test_low_variation_ending(self):
        assert is_valid_landing(self._make_path(100.0), 100.0) is True

    def test_high_altitude_but_low_variation(self):
        assert is_valid_landing(self._make_path(2000.0), 2000.0) is True

    def test_low_altitude_endpoint(self):
        path = [[50.0, 8.0, float(500 - i * 5)] for i in range(100)]
        assert is_valid_landing(path, 5.0) is True

    def test_short_path_below_fallback(self):
        path = [[50.0, 8.0, 500.0]] * 5
        assert is_valid_landing(path, 500.0) is True

    def test_short_path_above_fallback(self):
        path = [[50.0, 8.0, 2000.0]] * 5
        assert is_valid_landing(path, 2000.0) is False


class TestParseCoordinatePoint:
    def test_three_components(self):
        result = parse_coordinate_point("8.5,50.0,100.0", "test.kml")
        assert result is not None
        lat, lon, alt = result
        assert lat == pytest.approx(50.0)
        assert lon == pytest.approx(8.5)
        assert alt == pytest.approx(100.0)

    def test_two_components(self):
        result = parse_coordinate_point("8.5,50.0", "test.kml")
        assert result is not None
        lat, lon, alt = result
        assert lat == pytest.approx(50.0)
        assert lon == pytest.approx(8.5)

    def test_empty_string(self):
        assert parse_coordinate_point("", "test.kml") is None

    def test_whitespace_only(self):
        assert parse_coordinate_point("   ", "test.kml") is None

    def test_single_value(self):
        assert parse_coordinate_point("8.5", "test.kml") is None

    def test_invalid_values(self):
        assert parse_coordinate_point("abc,def", "test.kml") is None

    def test_whitespace_stripping(self):
        result = parse_coordinate_point("  8.5,50.0,100.0  ", "test.kml")
        assert result is not None


class TestFindXmlElement:
    NS = {"kml": "http://www.opengis.net/kml/2.2"}

    def test_namespaced_found(self):
        xml = '<root xmlns:kml="http://www.opengis.net/kml/2.2"><kml:name>Test</kml:name></root>'
        root = ET.fromstring(xml)
        result = find_xml_element(root, "kml:name", "name", self.NS)
        assert result is not None
        assert result.text == "Test"

    def test_fallback_found(self):
        xml = "<root><name>Test</name></root>"
        root = ET.fromstring(xml)
        result = find_xml_element(root, "kml:name", "name", self.NS)
        assert result is not None
        assert result.text == "Test"

    def test_neither_found(self):
        xml = "<root><other>Test</other></root>"
        root = ET.fromstring(xml)
        result = find_xml_element(root, "kml:name", "name", self.NS)
        assert result is None


class TestFindXmlElements:
    NS = {"kml": "http://www.opengis.net/kml/2.2"}

    def test_multiple_elements(self):
        xml = "<root><when>t1</when><when>t2</when><when>t3</when></root>"
        root = ET.fromstring(xml)
        result = find_xml_elements(root, "kml:when", "when", self.NS)
        assert len(result) == 3

    def test_empty_result(self):
        xml = "<root><other>Test</other></root>"
        root = ET.fromstring(xml)
        result = find_xml_elements(root, "kml:when", "when", self.NS)
        assert result == []


class TestExtractCharterwareTimestamp:
    def test_pm_time(self):
        desc = "Flight Jan 12 2026 03:01PM path of OE-AKI"
        result = extract_charterware_timestamp(desc)
        assert result == "2026-01-12T15:01:00Z"

    def test_am_time(self):
        desc = "Flight Mar 05 2026 08:30AM path of OE-AKI"
        result = extract_charterware_timestamp(desc)
        assert result == "2026-03-05T08:30:00Z"

    def test_12pm_noon(self):
        desc = "Flight Jun 01 2026 12:00PM path of OE-AKI"
        result = extract_charterware_timestamp(desc)
        assert result == "2026-06-01T12:00:00Z"

    def test_12am_midnight(self):
        desc = "Flight Jun 01 2026 12:00AM path of OE-AKI"
        result = extract_charterware_timestamp(desc)
        assert result == "2026-06-01T00:00:00Z"

    def test_none_input(self):
        assert extract_charterware_timestamp(None) is None

    def test_empty_input(self):
        assert extract_charterware_timestamp("") is None

    def test_invalid_format(self):
        assert extract_charterware_timestamp("not a charterware description") is None

    def test_full_month_name(self):
        desc = "Flight January 15 2026 02:00PM path of D-EAGJ"
        result = extract_charterware_timestamp(desc)
        assert result == "2026-01-15T14:00:00Z"


class TestExtractPlacemarkMetadata:
    NS = {"kml": "http://www.opengis.net/kml/2.2"}

    def test_name_and_timestamps(self):
        xml = """
        <Placemark xmlns:kml="http://www.opengis.net/kml/2.2">
            <kml:name>EDDS</kml:name>
            <kml:when>2025-03-03T08:58:01Z</kml:when>
            <kml:when>2025-03-03T10:30:00Z</kml:when>
        </Placemark>
        """
        placemark = ET.fromstring(xml)
        result = extract_placemark_metadata(placemark, self.NS)
        assert result["timestamp"] == "2025-03-03T08:58:01Z"
        assert result["end_timestamp"] == "2025-03-03T10:30:00Z"
        assert result["year"] == 2025

    def test_single_timestamp(self):
        xml = """
        <Placemark>
            <name>EDDS</name>
            <TimeStamp><when>2025-06-15T12:00:00Z</when></TimeStamp>
        </Placemark>
        """
        placemark = ET.fromstring(xml)
        result = extract_placemark_metadata(placemark, self.NS)
        assert result["timestamp"] == "2025-06-15T12:00:00Z"
        assert result["end_timestamp"] is None

    def test_date_in_name_fallback(self):
        xml = """
        <Placemark>
            <name>EDDS to EDDP - 16 Aug 2026</name>
        </Placemark>
        """
        placemark = ET.fromstring(xml)
        result = extract_placemark_metadata(placemark, self.NS)
        assert result["timestamp"] == "16 Aug 2026"
        assert result["year"] == 2026

    def test_charterware_description_fallback(self):
        xml = """
        <Placemark>
            <name>Route</name>
            <description>Flight Jan 12 2026 03:01PM path of OE-AKI</description>
        </Placemark>
        """
        placemark = ET.fromstring(xml)
        result = extract_placemark_metadata(placemark, self.NS)
        assert result["timestamp"] == "2026-01-12T15:01:00Z"
        assert result["year"] == 2026

    def test_no_metadata(self):
        xml = "<Placemark></Placemark>"
        placemark = ET.fromstring(xml)
        result = extract_placemark_metadata(placemark, self.NS)
        assert result["airport_name"] is None
        assert result["timestamp"] is None
        assert result["end_timestamp"] is None
        assert result["year"] is None


class TestBuildPathMetadataDict:
    def test_basic_metadata(self):
        result = _build_path_metadata_dict(
            kml_file="test.kml",
            path_start=[50.0, 8.5, 100.0],
            airport_name="EDDS",
            timestamp="2025-03-03T08:58:01Z",
            end_timestamp="2025-03-03T10:30:00Z",
        )
        assert result["filename"] == "test.kml"
        assert result["start_point"] == [50.0, 8.5, 100.0]
        assert result["airport_name"] == "EDDS"
        assert result["timestamp"] == "2025-03-03T08:58:01Z"
        assert result["end_timestamp"] == "2025-03-03T10:30:00Z"
        assert result["year"] == 2025

    def test_no_aircraft_info(self):
        result = _build_path_metadata_dict(
            kml_file="test.kml",
            path_start=[50.0, 8.5, 100.0],
            airport_name=None,
            timestamp=None,
            end_timestamp=None,
        )
        assert result["year"] is None
        assert "aircraft_registration" not in result

    def test_with_aircraft_in_filename(self):
        result = _build_path_metadata_dict(
            kml_file="1_DEAGJ_DA20.kml",
            path_start=[50.0, 8.5, 100.0],
            airport_name="EDDS",
            timestamp="2025-03-03T08:58:01Z",
            end_timestamp=None,
        )
        assert result["aircraft_registration"] == "D-EAGJ"
