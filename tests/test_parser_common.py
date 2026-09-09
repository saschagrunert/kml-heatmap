"""Tests for parser_common module."""

from datetime import UTC, datetime
from typing import ClassVar
from xml.etree import ElementTree as ET

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from kml_heatmap.parser_common import (
    _build_path_metadata_dict,
    empty_placemark_metadata,
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
from kml_heatmap.types import TrackPoint

NS = {"kml": "http://www.opengis.net/kml/2.2"}


def _flat(alt, count=100):
    return [TrackPoint(50.0, 8.0, float(alt), None)] * count


class TestExtractYearFromTimestamp:
    @pytest.mark.parametrize(
        "value,expected",
        [
            ("2025-03-03T08:58:01Z", 2025),
            ("2026-01-15T10:30:00+02:00", 2026),
            ("2025-03-03", 2025),
            ("03 Mar 2025", 2025),
            ("Log Start: 03 Mar 2024 08:58 Z", 2024),
            ("2099-12-31T23:59:59Z", 2099),
            ("2000-01-01T00:00:00Z", 2000),
            ("not-a-date", None),
            ("03 Mar", None),
            ("2025-99-99T99:99:99Z", None),
            ("", None),
            (None, None),
        ],
    )
    def test_extract(self, value, expected):
        assert extract_year_from_timestamp(value) == expected


class TestSamplePathAltitudes:
    def test_short_path_returns_none(self):
        assert sample_path_altitudes(_flat(100, 10)) is None
        assert sample_path_altitudes(_flat(100, 22)) is None

    def test_from_start(self):
        path = [TrackPoint(50, 8, float(i * 10), None) for i in range(100)]
        result = sample_path_altitudes(path, from_end=False)
        assert result == {"min": 0.0, "max": 240.0, "variation": 240.0}

    def test_from_end(self):
        path = [TrackPoint(50, 8, float(i * 10), None) for i in range(100)]
        result = sample_path_altitudes(path, from_end=True)
        assert result == {"min": 750.0, "max": 990.0, "variation": 240.0}

    def test_flat_altitude(self):
        assert sample_path_altitudes(_flat(500))["variation"] == 0.0

    def test_missing_altitudes_ignored(self):
        path = [TrackPoint(50, 8, None, None)] * 50 + _flat(300, 50)
        assert sample_path_altitudes(path, from_end=False) is None
        assert sample_path_altitudes(path, from_end=True)["min"] == 300.0


class TestIsMidFlightStart:
    def test_ground_level_start(self):
        assert is_mid_flight_start(_flat(50.0), 50.0) is False

    def test_mid_flight_cruise(self):
        assert is_mid_flight_start(_flat(1500.0), 1500.0) is True

    def test_climbing_start_high_variation(self):
        path = [TrackPoint(50.0, 8.0, float(100 + i * 20), None) for i in range(100)]
        assert is_mid_flight_start(path, 100.0) is False

    def test_short_path(self):
        assert is_mid_flight_start(_flat(2000.0, 5), 2000.0) is False

    def test_unknown_altitude(self):
        assert is_mid_flight_start(_flat(2000.0), None) is False


class TestIsValidLanding:
    def test_low_variation_ending(self):
        assert is_valid_landing(_flat(100.0), 100.0) is True

    def test_high_altitude_but_low_variation(self):
        assert is_valid_landing(_flat(2000.0), 2000.0) is True

    def test_low_altitude_endpoint(self):
        path = [TrackPoint(50.0, 8.0, float(500 - i * 5), None) for i in range(100)]
        assert is_valid_landing(path, 5.0) is True

    def test_high_variation_high_endpoint(self):
        path = [TrackPoint(50.0, 8.0, float(3000 - i * 5), None) for i in range(100)]
        assert is_valid_landing(path, 2505.0) is False

    def test_short_path_fallback(self):
        assert is_valid_landing(_flat(500.0, 5), 500.0) is True
        assert is_valid_landing(_flat(2000.0, 5), 2000.0) is False
        assert is_valid_landing(_flat(2000.0, 5), None) is False


class TestParseCoordinatePoint:
    def test_three_components(self):
        assert parse_coordinate_point("8.5,50.0,100.0", "test.kml") == (
            50.0,
            8.5,
            100.0,
        )

    def test_two_components(self):
        assert parse_coordinate_point("8.5,50.0", "test.kml") == (50.0, 8.5, None)

    def test_negative_altitude_kept(self):
        assert parse_coordinate_point("8.5,50.0,-100", "test.kml") == (
            50.0,
            8.5,
            -100.0,
        )

    def test_out_of_range_latitude(self):
        assert parse_coordinate_point("8.5,9999.0,300", "test.kml") is None

    def test_whitespace_stripping(self):
        assert parse_coordinate_point("  8.5,50.0,100.0  ", "test.kml") == (
            50.0,
            8.5,
            100.0,
        )

    @pytest.mark.parametrize(
        "value", ["", "   ", "8.5", "abc,def", "abc,def,ghi", "invalid"]
    )
    def test_invalid_values(self, value):
        assert parse_coordinate_point(value, "test.kml") is None

    @settings(max_examples=300)
    @given(st.text())
    def test_never_raises(self, text):
        result = parse_coordinate_point(text, "test.kml")
        assert result is None or (isinstance(result, tuple) and len(result) == 3)


class TestFindXmlElement:
    NS: ClassVar[dict[str, str]] = NS

    def test_namespaced_found(self):
        root = ET.fromstring(
            '<root xmlns:kml="http://www.opengis.net/kml/2.2"><kml:name>T</kml:name></root>'
        )
        assert find_xml_element(root, "kml:name", "name", self.NS).text == "T"

    def test_fallback_found(self):
        root = ET.fromstring("<root><name>T</name></root>")
        assert find_xml_element(root, "kml:name", "name", self.NS).text == "T"

    def test_neither_found(self):
        root = ET.fromstring("<root><other>T</other></root>")
        assert find_xml_element(root, "kml:name", "name", self.NS) is None


class TestFindXmlElements:
    NS: ClassVar[dict[str, str]] = NS

    def test_namespaced_elements(self):
        root = ET.fromstring(
            '<root xmlns:kml="http://www.opengis.net/kml/2.2">'
            "<kml:when>1</kml:when><kml:when>2</kml:when></root>"
        )
        assert [
            e.text for e in find_xml_elements(root, "kml:when", "when", self.NS)
        ] == ["1", "2"]

    def test_fallback_elements(self):
        root = ET.fromstring(
            "<root><when>t1</when><when>t2</when><when>t3</when></root>"
        )
        assert len(find_xml_elements(root, "kml:when", "when", self.NS)) == 3

    def test_empty_result(self):
        root = ET.fromstring("<root><other>T</other></root>")
        assert find_xml_elements(root, "kml:when", "when", self.NS) == []


class TestExtractCharterwareTimestamp:
    @pytest.mark.parametrize(
        "desc,expected",
        [
            ("Flight Jan 12 2026 03:01PM path of OE-AKI", "2026-01-12T15:01:00+00:00"),
            ("Flight Mar 05 2026 08:30AM path of OE-AKI", "2026-03-05T08:30:00+00:00"),
            ("Flight Mar 3 2025 08:15AM path of D-EAGJ", "2025-03-03T08:15:00+00:00"),
            ("Flight Jun 01 2026 12:00PM path of OE-AKI", "2026-06-01T12:00:00+00:00"),
            ("Flight Jun 01 2026 12:00AM path of OE-AKI", "2026-06-01T00:00:00+00:00"),
            ("Flight Jan 1 2026 11:59PM path of OE-AKI", "2026-01-01T23:59:00+00:00"),
            (
                "Flight January 15 2026 02:00PM path of D-EAGJ",
                "2026-01-15T14:00:00+00:00",
            ),
        ],
    )
    def test_parsing(self, desc, expected):
        assert extract_charterware_timestamp(desc) == expected

    @pytest.mark.parametrize(
        "desc",
        [
            None,
            "",
            "not a charterware description",
            "Flight without timestamp",
            "Flight Feb 31 2025 12:00AM path of OE-AKI",
            "Flight Foo 12 2026 03:01PM",
        ],
    )
    def test_invalid(self, desc):
        assert extract_charterware_timestamp(desc) is None

    @settings(max_examples=100)
    @given(
        st.datetimes(min_value=datetime(2000, 1, 1), max_value=datetime(2099, 12, 31)),
        st.booleans(),
    )
    def test_round_trip(self, dt, long_month):
        month = dt.strftime("%B" if long_month else "%b")
        hour12 = dt.hour % 12 or 12
        meridiem = "AM" if dt.hour < 12 else "PM"
        desc = (
            f"Flight {month} {dt.day} {dt.year} "
            f"{hour12:02d}:{dt.minute:02d}{meridiem} path"
        )
        expected = dt.replace(second=0, microsecond=0, tzinfo=UTC).isoformat()
        assert extract_charterware_timestamp(desc) == expected


class TestExtractPlacemarkMetadata:
    def test_name_and_timestamps(self):
        placemark = ET.fromstring(
            '<Placemark xmlns:kml="http://www.opengis.net/kml/2.2">'
            "<kml:name>EDDS</kml:name>"
            "<kml:when>2025-03-03T08:58:01Z</kml:when>"
            "<kml:when>2025-03-03T10:30:00Z</kml:when></Placemark>"
        )
        assert extract_placemark_metadata(placemark, NS) == {
            "airport_name": "EDDS Stuttgart",
            "timestamp": "2025-03-03T08:58:01Z",
            "end_timestamp": "2025-03-03T10:30:00Z",
            "year": 2025,
        }

    def test_timestamp_element(self):
        placemark = ET.fromstring(
            "<Placemark><name>Test Airport</name>"
            "<TimeStamp><when>2025-06-15T12:00:00Z</when></TimeStamp></Placemark>"
        )
        result = extract_placemark_metadata(placemark, NS)
        assert result["airport_name"] == "Test Airport"
        assert result["timestamp"] == "2025-06-15T12:00:00Z"
        assert result["end_timestamp"] is None
        assert result["year"] == 2025

    def test_date_in_name_fallback(self):
        placemark = ET.fromstring(
            "<Placemark><name>EDDS to EDDP - 16 Aug 2026</name></Placemark>"
        )
        result = extract_placemark_metadata(placemark, NS)
        assert result["timestamp"] == "16 Aug 2026"
        assert result["year"] == 2026

    def test_log_start_name(self):
        placemark = ET.fromstring(
            "<Placemark><name>Log Start: 03 Mar 2025 08:58 Z</name></Placemark>"
        )
        result = extract_placemark_metadata(placemark, NS)
        assert result["airport_name"] == "Log Start: 03 Mar 2025 08:58 Z"
        assert result["timestamp"] == "03 Mar 2025"
        assert result["year"] == 2025

    def test_charterware_description_fallback(self):
        placemark = ET.fromstring(
            "<Placemark><name>Route</name>"
            "<description>Flight Jan 12 2026 03:01PM path of OE-AKI</description>"
            "</Placemark>"
        )
        result = extract_placemark_metadata(placemark, NS)
        assert result["timestamp"] == "2026-01-12T15:01:00+00:00"
        assert result["year"] == 2026

    def test_no_metadata(self):
        assert (
            extract_placemark_metadata(ET.fromstring("<Placemark/>"), NS)
            == empty_placemark_metadata()
        )


class TestBuildPathMetadataDict:
    def _meta(self, **overrides):
        meta = empty_placemark_metadata()
        meta.update(overrides)
        return meta

    def test_basic_metadata(self):
        result = _build_path_metadata_dict(
            "test.kml",
            TrackPoint(50.0, 8.5, 100.0, 12.0),
            self._meta(
                airport_name="EDDS",
                timestamp="2025-03-03T08:58:01Z",
                end_timestamp="2025-03-03T10:30:00Z",
                year=2025,
            ),
        )
        assert result == {
            "start_point": [50.0, 8.5, 100.0],
            "airport_name": "EDDS",
            "timestamp": "2025-03-03T08:58:01Z",
            "end_timestamp": "2025-03-03T10:30:00Z",
            "filename": "test.kml",
            "year": 2025,
        }

    def test_year_comes_from_placemark_metadata(self):
        result = _build_path_metadata_dict(
            "test.kml",
            TrackPoint(50.0, 8.5, 100.0),
            self._meta(timestamp="x", year=2031),
        )
        assert result["year"] == 2031

    def test_no_aircraft_info(self):
        result = _build_path_metadata_dict(
            "test.kml", TrackPoint(50.0, 8.5, 100.0), self._meta()
        )
        assert result["year"] is None
        assert result["airport_name"] == ""
        assert "aircraft_registration" not in result

    def test_start_point_without_altitude(self):
        result = _build_path_metadata_dict(
            "test.kml", TrackPoint(50.0, 8.5, None), self._meta()
        )
        assert result["start_point"] == [50.0, 8.5]

    def test_with_aircraft_in_filename(self):
        result = _build_path_metadata_dict(
            "some/dir/1_DEAGJ_DA20.kml",
            TrackPoint(50.0, 8.5, 100.0),
            self._meta(airport_name="EDDS"),
        )
        assert result["aircraft_registration"] == "D-EAGJ"
        assert result["aircraft_type"] == "DA20"
        assert result["filename"] == "1_DEAGJ_DA20.kml"

    def test_charterware_route_becomes_airport_name(self):
        result = _build_path_metadata_dict(
            "2026-01-12_1513h_OE-AKI_EDDF-EDDM.kml",
            TrackPoint(50.0, 8.5, 100.0),
            self._meta(airport_name="OE-AKI"),
        )
        assert result["airport_name"] == "EDDF Frankfurt Main - EDDM Munich"
        assert result["route"] == "EDDF-EDDM"
        assert "aircraft_type" not in result

    def test_charterware_keeps_icao_name(self):
        result = _build_path_metadata_dict(
            "2026-01-12_1513h_OE-AKI_EDDF-EDDM.kml",
            TrackPoint(50.0, 8.5, 100.0),
            self._meta(airport_name="LOAV"),
        )
        assert result["airport_name"] == "LOAV"
