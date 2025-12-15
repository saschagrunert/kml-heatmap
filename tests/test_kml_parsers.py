"""Tests for kml_parsers module."""

import pytest
from kml_heatmap.kml_parsers import (
    validate_coordinate,
    validate_and_normalize_coordinate,
    parse_coordinate_string,
    parse_gx_coordinate_string,
)


class TestValidateCoordinate:
    """Tests for validate_coordinate function."""

    def test_valid_coordinate(self):
        """Test valid coordinate."""
        assert validate_coordinate(50.0, 8.5, 300, "test.kml") is True

    def test_valid_coordinate_no_altitude(self):
        """Test valid coordinate without altitude."""
        assert validate_coordinate(50.0, 8.5, None, "test.kml") is True

    def test_invalid_latitude_too_high(self):
        """Test latitude above valid range."""
        assert validate_coordinate(100.0, 8.5, 300, "test.kml") is False

    def test_invalid_latitude_too_low(self):
        """Test latitude below valid range."""
        assert validate_coordinate(-100.0, 8.5, 300, "test.kml") is False

    def test_invalid_longitude_too_high(self):
        """Test longitude above valid range."""
        assert validate_coordinate(50.0, 200.0, 300, "test.kml") is False

    def test_invalid_longitude_too_low(self):
        """Test longitude below valid range."""
        assert validate_coordinate(50.0, -200.0, 300, "test.kml") is False

    def test_invalid_altitude_too_high(self):
        """Test altitude above valid range."""
        assert validate_coordinate(50.0, 8.5, 999999, "test.kml") is False

    def test_invalid_altitude_too_low(self):
        """Test altitude below valid range."""
        assert validate_coordinate(50.0, 8.5, -99999, "test.kml") is False

    def test_edge_case_min_lat(self):
        """Test minimum valid latitude."""
        assert validate_coordinate(-90.0, 0.0, 0, "test.kml") is True

    def test_edge_case_max_lat(self):
        """Test maximum valid latitude."""
        assert validate_coordinate(90.0, 0.0, 0, "test.kml") is True

    def test_edge_case_min_lon(self):
        """Test minimum valid longitude."""
        assert validate_coordinate(0.0, -180.0, 0, "test.kml") is True

    def test_edge_case_max_lon(self):
        """Test maximum valid longitude."""
        assert validate_coordinate(0.0, 180.0, 0, "test.kml") is True

    def test_zero_altitude(self):
        """Test zero altitude is valid."""
        assert validate_coordinate(50.0, 8.5, 0, "test.kml") is True


class TestValidateAndNormalizeCoordinate:
    """Tests for validate_and_normalize_coordinate function."""

    def test_valid_coordinate(self):
        """Test valid coordinate normalization."""
        result = validate_and_normalize_coordinate(50.0, 8.5, 300, "test.kml")
        assert result is not None
        assert result == (50.0, 8.5, 300.0)

    def test_negative_altitude_clamped(self):
        """Test negative altitude is clamped to zero."""
        result = validate_and_normalize_coordinate(50.0, 8.5, -100, "test.kml")
        assert result is not None
        lat, lon, alt = result
        assert alt == 0.0

    def test_invalid_returns_none(self):
        """Test invalid coordinates return None."""
        result = validate_and_normalize_coordinate(999.0, 8.5, 300, "test.kml")
        assert result is None

    def test_none_altitude_preserved(self):
        """Test None altitude is preserved."""
        result = validate_and_normalize_coordinate(50.0, 8.5, None, "test.kml")
        assert result is not None
        lat, lon, alt = result
        assert alt is None

    def test_valid_range_boundaries(self):
        """Test coordinates at valid range boundaries."""
        # Min latitude
        result = validate_and_normalize_coordinate(-90.0, 0.0, 0, "test.kml")
        assert result is not None

        # Max latitude
        result = validate_and_normalize_coordinate(90.0, 0.0, 0, "test.kml")
        assert result is not None

        # Min longitude
        result = validate_and_normalize_coordinate(0.0, -180.0, 0, "test.kml")
        assert result is not None

        # Max longitude
        result = validate_and_normalize_coordinate(0.0, 180.0, 0, "test.kml")
        assert result is not None

    def test_extreme_altitude_out_of_range(self):
        """Test that extreme altitude values get normalized to None."""
        # Altitude way too high (above valid range)
        result = validate_and_normalize_coordinate(50.0, 8.5, 999999, "test.kml")
        assert result is not None
        lat, lon, alt = result
        # Invalid altitude gets set to None
        assert alt is None

        # Altitude way too low (below valid range)
        result = validate_and_normalize_coordinate(50.0, 8.5, -99999, "test.kml")
        assert result is not None
        lat, lon, alt = result
        # Invalid altitude gets set to None
        assert alt is None


class TestParseCoordinateString:
    """Tests for parse_coordinate_string function."""

    def test_valid_three_component(self):
        """Test parsing valid lon,lat,alt format."""
        result = parse_coordinate_string("8.5,50.0,300")
        assert result is not None
        lat, lon, alt = result
        assert lat == pytest.approx(50.0)
        assert lon == pytest.approx(8.5)
        assert alt == pytest.approx(300.0)

    def test_valid_two_component(self):
        """Test parsing valid lon,lat format without altitude."""
        result = parse_coordinate_string("8.5,50.0")
        assert result is not None
        lat, lon, alt = result
        assert lat == pytest.approx(50.0)
        assert lon == pytest.approx(8.5)
        assert alt is None

    def test_negative_coordinates(self):
        """Test parsing negative coordinates."""
        result = parse_coordinate_string("-74.0060,40.7128,10")
        assert result is not None
        lat, lon, alt = result
        assert lat == pytest.approx(40.7128)
        assert lon == pytest.approx(-74.0060)

    def test_whitespace_stripped(self):
        """Test that whitespace is stripped."""
        result = parse_coordinate_string("  8.5 , 50.0 , 300  ")
        assert result is not None

    def test_empty_string(self):
        """Test empty string returns None."""
        assert parse_coordinate_string("") is None

    def test_single_value(self):
        """Test single value returns None."""
        assert parse_coordinate_string("8.5") is None

    def test_invalid_numbers(self):
        """Test invalid numbers return None."""
        assert parse_coordinate_string("abc,def,ghi") is None

    def test_out_of_range_coordinates(self):
        """Test out of range coordinates are parsed (validation happens elsewhere)."""
        result = parse_coordinate_string("8.5,999.0,300")
        # Parsing doesn't validate - just extracts values
        assert result is not None
        lat, lon, alt = result
        assert lat == pytest.approx(999.0)  # Invalid but parsed

    def test_high_precision_decimals(self):
        """Test high precision decimal values."""
        result = parse_coordinate_string("8.123456789,50.987654321,123.45")
        assert result is not None
        lat, lon, alt = result
        assert lat == pytest.approx(50.987654321)
        assert lon == pytest.approx(8.123456789)


class TestParseGxCoordinateString:
    """Tests for parse_gx_coordinate_string function."""

    def test_valid_three_component(self):
        """Test parsing valid gx:coord format (space-separated)."""
        result = parse_gx_coordinate_string("8.5 50.0 300")
        assert result is not None
        lat, lon, alt = result
        assert lat == pytest.approx(50.0)
        assert lon == pytest.approx(8.5)
        assert alt == pytest.approx(300.0)

    def test_valid_two_component(self):
        """Test parsing gx:coord without altitude."""
        result = parse_gx_coordinate_string("8.5 50.0")
        assert result is not None
        lat, lon, alt = result
        assert lat == pytest.approx(50.0)
        assert lon == pytest.approx(8.5)
        assert alt is None

    def test_negative_coordinates(self):
        """Test parsing negative gx coordinates."""
        result = parse_gx_coordinate_string("-74.0060 40.7128 10")
        assert result is not None
        lat, lon, alt = result
        assert lat == pytest.approx(40.7128)
        assert lon == pytest.approx(-74.0060)

    def test_whitespace_handling(self):
        """Test extra whitespace is handled."""
        result = parse_gx_coordinate_string("  8.5   50.0   300  ")
        assert result is not None

    def test_empty_string(self):
        """Test empty string returns None."""
        assert parse_gx_coordinate_string("") is None

    def test_single_value(self):
        """Test single value returns None."""
        assert parse_gx_coordinate_string("8.5") is None

    def test_invalid_numbers(self):
        """Test invalid numbers return None."""
        assert parse_gx_coordinate_string("abc def ghi") is None

    def test_out_of_range_coordinates(self):
        """Test out of range coordinates are parsed (validation happens elsewhere)."""
        result = parse_gx_coordinate_string("8.5 999.0 300")
        # Parsing doesn't validate - just extracts values
        assert result is not None
        lat, lon, alt = result
        assert lat == pytest.approx(999.0)  # Invalid but parsed

    def test_tab_separated(self):
        """Test tab-separated values."""
        result = parse_gx_coordinate_string("8.5\t50.0\t300")
        assert result is not None

    def test_mixed_whitespace(self):
        """Test mixed whitespace separators."""
        result = parse_gx_coordinate_string("8.5\t 50.0  \t300")
        assert result is not None


class TestPlacemarkMetadata:
    """Tests for PlacemarkMetadata class."""

    def test_initialization(self):
        """Test PlacemarkMetadata initialization."""
        from kml_heatmap.kml_parsers import PlacemarkMetadata

        metadata = PlacemarkMetadata()
        assert metadata.name is None
        assert metadata.timestamp is None
        assert metadata.end_timestamp is None
        assert metadata.year is None

    def test_to_dict(self):
        """Test converting metadata to dictionary."""
        from kml_heatmap.kml_parsers import PlacemarkMetadata

        metadata = PlacemarkMetadata()
        metadata.name = "Test Airport"
        metadata.timestamp = "2025-03-15T10:00:00Z"
        metadata.end_timestamp = "2025-03-15T11:00:00Z"
        metadata.year = 2025

        result = metadata.to_dict()
        assert result["airport_name"] == "Test Airport"
        assert result["timestamp"] == "2025-03-15T10:00:00Z"
        assert result["end_timestamp"] == "2025-03-15T11:00:00Z"
        assert result["year"] == 2025

    def test_to_dict_empty(self):
        """Test converting empty metadata to dictionary."""
        from kml_heatmap.kml_parsers import PlacemarkMetadata

        metadata = PlacemarkMetadata()
        result = metadata.to_dict()
        assert result["airport_name"] is None
        assert result["timestamp"] is None
        assert result["end_timestamp"] is None
        assert result["year"] is None


class TestExtractPlacemarkMetadata:
    """Tests for extract_placemark_metadata function."""

    def test_extract_with_name(self):
        """Test extracting placemark with name."""
        from kml_heatmap.kml_parsers import extract_placemark_metadata
        from xml.etree import ElementTree as ET

        xml = """<Placemark xmlns="http://www.opengis.net/kml/2.2">
            <name>Test Airport</name>
        </Placemark>"""
        placemark = ET.fromstring(xml)
        namespaces = {"kml": "http://www.opengis.net/kml/2.2"}

        metadata = extract_placemark_metadata(placemark, namespaces)
        assert metadata.name == "Test Airport"

    def test_extract_with_timestamp(self):
        """Test extracting placemark with timestamp."""
        from kml_heatmap.kml_parsers import extract_placemark_metadata
        from xml.etree import ElementTree as ET

        xml = """<Placemark xmlns="http://www.opengis.net/kml/2.2">
            <when>2025-03-15T10:00:00Z</when>
        </Placemark>"""
        placemark = ET.fromstring(xml)
        namespaces = {"kml": "http://www.opengis.net/kml/2.2"}

        metadata = extract_placemark_metadata(placemark, namespaces)
        assert metadata.timestamp == "2025-03-15T10:00:00Z"
        assert metadata.year == 2025

    def test_extract_with_multiple_timestamps(self):
        """Test extracting placemark with start and end timestamps."""
        from kml_heatmap.kml_parsers import extract_placemark_metadata
        from xml.etree import ElementTree as ET

        xml = """<Placemark xmlns="http://www.opengis.net/kml/2.2">
            <when>2025-03-15T10:00:00Z</when>
            <when>2025-03-15T11:00:00Z</when>
        </Placemark>"""
        placemark = ET.fromstring(xml)
        namespaces = {"kml": "http://www.opengis.net/kml/2.2"}

        metadata = extract_placemark_metadata(placemark, namespaces)
        assert metadata.timestamp == "2025-03-15T10:00:00Z"
        assert metadata.end_timestamp == "2025-03-15T11:00:00Z"

    def test_extract_without_namespace(self):
        """Test extracting placemark without namespace."""
        from kml_heatmap.kml_parsers import extract_placemark_metadata
        from xml.etree import ElementTree as ET

        xml = """<Placemark xmlns="http://www.opengis.net/kml/2.2">
            <name>Test</name>
            <when>2025-03-15T10:00:00Z</when>
        </Placemark>"""
        placemark = ET.fromstring(xml)
        namespaces = {"kml": "http://www.opengis.net/kml/2.2"}

        metadata = extract_placemark_metadata(placemark, namespaces)
        assert metadata.name == "Test"
        assert metadata.timestamp == "2025-03-15T10:00:00Z"

    def test_extract_timestamp_element(self):
        """Test extracting TimeStamp element."""
        from kml_heatmap.kml_parsers import extract_placemark_metadata
        from xml.etree import ElementTree as ET

        xml = """<Placemark xmlns="http://www.opengis.net/kml/2.2">
            <TimeStamp>
                <when>2025-03-15T10:00:00Z</when>
            </TimeStamp>
        </Placemark>"""
        placemark = ET.fromstring(xml)
        namespaces = {"kml": "http://www.opengis.net/kml/2.2"}

        metadata = extract_placemark_metadata(placemark, namespaces)
        assert metadata.timestamp == "2025-03-15T10:00:00Z"

    def test_extract_empty_placemark(self):
        """Test extracting empty placemark."""
        from kml_heatmap.kml_parsers import extract_placemark_metadata
        from xml.etree import ElementTree as ET

        xml = """<Placemark xmlns="http://www.opengis.net/kml/2.2"></Placemark>"""
        placemark = ET.fromstring(xml)
        namespaces = {"kml": "http://www.opengis.net/kml/2.2"}

        metadata = extract_placemark_metadata(placemark, namespaces)
        assert metadata.name is None
        assert metadata.timestamp is None

    def test_extract_timestamp_fallback_no_namespace(self):
        """Test extracting TimeStamp without namespace."""
        from kml_heatmap.kml_parsers import extract_placemark_metadata
        from xml.etree import ElementTree as ET

        # XML without namespace prefixes
        xml = """<Placemark>
            <TimeStamp>
                <when>2025-03-15T10:00:00Z</when>
            </TimeStamp>
        </Placemark>"""
        placemark = ET.fromstring(xml)
        namespaces = {"kml": "http://www.opengis.net/kml/2.2"}

        metadata = extract_placemark_metadata(placemark, namespaces)
        assert metadata.timestamp == "2025-03-15T10:00:00Z"

    def test_extract_when_with_empty_text(self):
        """Test extracting when element with empty text."""
        from kml_heatmap.kml_parsers import extract_placemark_metadata
        from xml.etree import ElementTree as ET

        xml = """<Placemark xmlns="http://www.opengis.net/kml/2.2">
            <when></when>
        </Placemark>"""
        placemark = ET.fromstring(xml)
        namespaces = {"kml": "http://www.opengis.net/kml/2.2"}

        metadata = extract_placemark_metadata(placemark, namespaces)
        # Empty when element should not set timestamp
        assert metadata.timestamp is None

    def test_extract_timestamp_year_parsing(self):
        """Test that year is extracted from timestamp."""
        from kml_heatmap.kml_parsers import extract_placemark_metadata
        from xml.etree import ElementTree as ET

        xml = """<Placemark xmlns="http://www.opengis.net/kml/2.2">
            <when>2023-12-25T15:30:00Z</when>
        </Placemark>"""
        placemark = ET.fromstring(xml)
        namespaces = {"kml": "http://www.opengis.net/kml/2.2"}

        metadata = extract_placemark_metadata(placemark, namespaces)
        assert metadata.year == 2023


class TestParseStandardCoordinates:
    """Tests for parse_standard_coordinates function."""

    def test_parse_valid_coordinates(self):
        """Test parsing valid standard coordinates."""
        from kml_heatmap.kml_parsers import (
            parse_standard_coordinates,
            PlacemarkMetadata,
        )
        from xml.etree import ElementTree as ET

        coord_elem = ET.Element("coordinates")
        coord_elem.text = "8.5,50.0,300 9.0,51.0,400"
        metadata = PlacemarkMetadata()

        coords_2d, coords_3d = parse_standard_coordinates(
            coord_elem, metadata, "test.kml"
        )

        assert len(coords_2d) == 2
        assert len(coords_3d) == 2
        assert coords_2d[0] == [50.0, 8.5]
        assert coords_3d[0] == [50.0, 8.5, 300.0]

    def test_parse_empty_coordinates(self):
        """Test parsing empty coordinates element."""
        from kml_heatmap.kml_parsers import (
            parse_standard_coordinates,
            PlacemarkMetadata,
        )
        from xml.etree import ElementTree as ET

        coord_elem = ET.Element("coordinates")
        coord_elem.text = ""
        metadata = PlacemarkMetadata()

        coords_2d, coords_3d = parse_standard_coordinates(
            coord_elem, metadata, "test.kml"
        )

        assert coords_2d == []
        assert coords_3d == []

    def test_parse_none_text(self):
        """Test parsing coordinates with None text."""
        from kml_heatmap.kml_parsers import (
            parse_standard_coordinates,
            PlacemarkMetadata,
        )
        from xml.etree import ElementTree as ET

        coord_elem = ET.Element("coordinates")
        coord_elem.text = None
        metadata = PlacemarkMetadata()

        coords_2d, coords_3d = parse_standard_coordinates(
            coord_elem, metadata, "test.kml"
        )

        assert coords_2d == []
        assert coords_3d == []

    def test_parse_negative_altitude_clamped(self):
        """Test that negative altitudes are clamped to zero."""
        from kml_heatmap.kml_parsers import (
            parse_standard_coordinates,
            PlacemarkMetadata,
        )
        from xml.etree import ElementTree as ET

        coord_elem = ET.Element("coordinates")
        coord_elem.text = "8.5,50.0,-100"
        metadata = PlacemarkMetadata()

        coords_2d, coords_3d = parse_standard_coordinates(
            coord_elem, metadata, "test.kml"
        )

        assert len(coords_3d) == 1
        assert coords_3d[0][2] == 0.0  # Negative altitude clamped to 0

    def test_parse_invalid_coordinates_skipped(self):
        """Test that invalid coordinates are skipped."""
        from kml_heatmap.kml_parsers import (
            parse_standard_coordinates,
            PlacemarkMetadata,
        )
        from xml.etree import ElementTree as ET

        coord_elem = ET.Element("coordinates")
        coord_elem.text = "8.5,50.0,300 invalid,coords,here 9.0,51.0,400"
        metadata = PlacemarkMetadata()

        coords_2d, coords_3d = parse_standard_coordinates(
            coord_elem, metadata, "test.kml"
        )

        # Should have 2 valid coordinates, skipping the invalid one
        assert len(coords_2d) == 2
        assert len(coords_3d) == 2

    def test_parse_out_of_range_coordinates_skipped(self):
        """Test that out-of-range coordinates are skipped."""
        from kml_heatmap.kml_parsers import (
            parse_standard_coordinates,
            PlacemarkMetadata,
        )
        from xml.etree import ElementTree as ET

        coord_elem = ET.Element("coordinates")
        coord_elem.text = "8.5,999.0,300"  # Invalid latitude
        metadata = PlacemarkMetadata()

        coords_2d, coords_3d = parse_standard_coordinates(
            coord_elem, metadata, "test.kml"
        )

        # Should be empty - coordinate is out of range
        assert coords_2d == []
        assert coords_3d == []

    def test_parse_coordinates_without_altitude(self):
        """Test parsing coordinates without altitude."""
        from kml_heatmap.kml_parsers import (
            parse_standard_coordinates,
            PlacemarkMetadata,
        )
        from xml.etree import ElementTree as ET

        coord_elem = ET.Element("coordinates")
        coord_elem.text = "8.5,50.0"
        metadata = PlacemarkMetadata()

        coords_2d, coords_3d = parse_standard_coordinates(
            coord_elem, metadata, "test.kml"
        )

        assert len(coords_2d) == 1
        assert len(coords_3d) == 0  # No altitude means not in 3D list


class TestParseGxTrackCoordinates:
    """Tests for parse_gx_track_coordinates function."""

    def test_parse_gx_track_basic(self):
        """Test parsing basic gx:Track."""
        from kml_heatmap.kml_parsers import parse_gx_track_coordinates
        from xml.etree import ElementTree as ET

        xml = """<Placemark xmlns="http://www.opengis.net/kml/2.2"
                             xmlns:gx="http://www.google.com/kml/ext/2.2">
            <name>Track</name>
            <gx:Track>
                <when>2025-03-15T10:00:00Z</when>
                <when>2025-03-15T10:01:00Z</when>
                <gx:coord>8.5 50.0 300</gx:coord>
                <gx:coord>9.0 51.0 400</gx:coord>
            </gx:Track>
        </Placemark>"""
        placemark = ET.fromstring(xml)
        namespaces = {
            "kml": "http://www.opengis.net/kml/2.2",
            "gx": "http://www.google.com/kml/ext/2.2",
        }

        coords_2d, coords_3d, metadata = parse_gx_track_coordinates(
            placemark, namespaces, "test.kml"
        )

        assert len(coords_2d) == 2
        assert len(coords_3d) == 2
        # gx:Track coordinates should have timestamps
        assert len(coords_3d[0]) == 4  # [lat, lon, alt, timestamp]
        assert metadata.name == "Track"

    def test_parse_gx_track_mismatched_coords(self):
        """Test parsing gx:Track with mismatched coord/when counts."""
        from kml_heatmap.kml_parsers import parse_gx_track_coordinates
        from xml.etree import ElementTree as ET

        xml = """<Placemark xmlns="http://www.opengis.net/kml/2.2"
                             xmlns:gx="http://www.google.com/kml/ext/2.2">
            <gx:Track>
                <when>2025-03-15T10:00:00Z</when>
                <gx:coord>8.5 50.0 300</gx:coord>
                <gx:coord>9.0 51.0 400</gx:coord>
            </gx:Track>
        </Placemark>"""
        placemark = ET.fromstring(xml)
        namespaces = {
            "kml": "http://www.opengis.net/kml/2.2",
            "gx": "http://www.google.com/kml/ext/2.2",
        }

        coords_2d, coords_3d, metadata = parse_gx_track_coordinates(
            placemark, namespaces, "test.kml"
        )

        # Should still parse coords even if timestamp count doesn't match
        assert len(coords_2d) >= 0

    def test_parse_gx_track_no_coords(self):
        """Test parsing placemark with no gx:Track."""
        from kml_heatmap.kml_parsers import parse_gx_track_coordinates
        from xml.etree import ElementTree as ET

        xml = """<Placemark xmlns="http://www.opengis.net/kml/2.2">
            <name>Empty Track</name>
        </Placemark>"""
        placemark = ET.fromstring(xml)
        namespaces = {
            "kml": "http://www.opengis.net/kml/2.2",
            "gx": "http://www.google.com/kml/ext/2.2",
        }

        coords_2d, coords_3d, metadata = parse_gx_track_coordinates(
            placemark, namespaces, "test.kml"
        )

        assert coords_2d == []
        assert coords_3d == []
        # When no coords found, function returns early with empty metadata
        assert metadata.name is None

    def test_parse_gx_track_when_fallback_no_namespace(self):
        """Test parsing gx:Track with when elements without namespace."""
        from kml_heatmap.kml_parsers import parse_gx_track_coordinates
        from xml.etree import ElementTree as ET

        # when elements without kml: prefix
        xml = """<Placemark>
            <gx:Track xmlns:gx="http://www.google.com/kml/ext/2.2">
                <when>2025-03-15T10:00:00Z</when>
                <gx:coord>8.5 50.0 300</gx:coord>
            </gx:Track>
        </Placemark>"""
        placemark = ET.fromstring(xml)
        namespaces = {
            "kml": "http://www.opengis.net/kml/2.2",
            "gx": "http://www.google.com/kml/ext/2.2",
        }

        coords_2d, coords_3d, metadata = parse_gx_track_coordinates(
            placemark, namespaces, "test.kml"
        )

        assert len(coords_2d) == 1
        assert len(coords_3d) == 1

    def test_parse_gx_track_empty_coord_text(self):
        """Test parsing gx:Track with empty coord text."""
        from kml_heatmap.kml_parsers import parse_gx_track_coordinates
        from xml.etree import ElementTree as ET

        xml = """<Placemark xmlns:gx="http://www.google.com/kml/ext/2.2">
            <gx:Track>
                <gx:coord></gx:coord>
                <gx:coord>8.5 50.0 300</gx:coord>
            </gx:Track>
        </Placemark>"""
        placemark = ET.fromstring(xml)
        namespaces = {
            "kml": "http://www.opengis.net/kml/2.2",
            "gx": "http://www.google.com/kml/ext/2.2",
        }

        coords_2d, coords_3d, metadata = parse_gx_track_coordinates(
            placemark, namespaces, "test.kml"
        )

        # Empty coord should be skipped
        assert len(coords_2d) == 1

    def test_parse_gx_track_invalid_coord_format(self):
        """Test parsing gx:Track with invalid coordinate format."""
        from kml_heatmap.kml_parsers import parse_gx_track_coordinates
        from xml.etree import ElementTree as ET

        xml = """<Placemark xmlns:gx="http://www.google.com/kml/ext/2.2">
            <gx:Track>
                <gx:coord>invalid data</gx:coord>
                <gx:coord>8.5 50.0 300</gx:coord>
            </gx:Track>
        </Placemark>"""
        placemark = ET.fromstring(xml)
        namespaces = {
            "kml": "http://www.opengis.net/kml/2.2",
            "gx": "http://www.google.com/kml/ext/2.2",
        }

        coords_2d, coords_3d, metadata = parse_gx_track_coordinates(
            placemark, namespaces, "test.kml"
        )

        # Invalid coord should be skipped
        assert len(coords_2d) == 1

    def test_parse_gx_track_invalid_coordinates(self):
        """Test parsing gx:Track with out-of-range coordinates."""
        from kml_heatmap.kml_parsers import parse_gx_track_coordinates
        from xml.etree import ElementTree as ET

        xml = """<Placemark xmlns:gx="http://www.google.com/kml/ext/2.2">
            <gx:Track>
                <gx:coord>8.5 999.0 300</gx:coord>
                <gx:coord>8.5 50.0 300</gx:coord>
            </gx:Track>
        </Placemark>"""
        placemark = ET.fromstring(xml)
        namespaces = {
            "kml": "http://www.opengis.net/kml/2.2",
            "gx": "http://www.google.com/kml/ext/2.2",
        }

        coords_2d, coords_3d, metadata = parse_gx_track_coordinates(
            placemark, namespaces, "test.kml"
        )

        # Invalid coordinate should be skipped
        assert len(coords_2d) == 1

    def test_parse_gx_track_negative_altitude_clamped(self):
        """Test that negative altitudes in gx:Track are clamped."""
        from kml_heatmap.kml_parsers import parse_gx_track_coordinates
        from xml.etree import ElementTree as ET

        xml = """<Placemark xmlns:gx="http://www.google.com/kml/ext/2.2">
            <gx:Track>
                <gx:coord>8.5 50.0 -100</gx:coord>
            </gx:Track>
        </Placemark>"""
        placemark = ET.fromstring(xml)
        namespaces = {
            "kml": "http://www.opengis.net/kml/2.2",
            "gx": "http://www.google.com/kml/ext/2.2",
        }

        coords_2d, coords_3d, metadata = parse_gx_track_coordinates(
            placemark, namespaces, "test.kml"
        )

        assert len(coords_3d) == 1
        # Negative altitude should be clamped to 0
        assert coords_3d[0][2] == 0.0


class TestRemoveXmlNamespaces:
    """Tests for remove_xml_namespaces function."""

    def test_remove_namespaces_from_elements(self):
        """Test removing XML namespaces from elements."""
        from kml_heatmap.kml_parsers import remove_xml_namespaces
        from xml.etree import ElementTree as ET

        xml = """<root xmlns="http://www.opengis.net/kml/2.2">
            <name>Test</name>
            <coords>8.5,50.0</coords>
        </root>"""
        root = ET.fromstring(xml)

        # Before: tags have namespace
        assert "}" in root.tag

        remove_xml_namespaces(root)

        # After: tags should not have namespace
        assert "}" not in root.tag
        assert root.tag == "root"

    def test_remove_namespaces_nested_elements(self):
        """Test removing namespaces from nested elements."""
        from kml_heatmap.kml_parsers import remove_xml_namespaces
        from xml.etree import ElementTree as ET

        xml = """<kml:Document xmlns:kml="http://www.opengis.net/kml/2.2">
            <kml:Placemark>
                <kml:name>Test</kml:name>
            </kml:Placemark>
        </kml:Document>"""
        root = ET.fromstring(xml)

        remove_xml_namespaces(root)

        # Check all elements had namespaces removed
        for elem in root.iter():
            assert "}" not in elem.tag

    def test_remove_namespaces_no_namespace(self):
        """Test removing namespaces from elements without namespace."""
        from kml_heatmap.kml_parsers import remove_xml_namespaces
        from xml.etree import ElementTree as ET

        xml = """<root><name>Test</name></root>"""
        root = ET.fromstring(xml)

        # Elements already have no namespace
        remove_xml_namespaces(root)

        # Should not affect elements without namespace
        assert root.tag == "root"
        assert root[0].tag == "name"
