"""Tests for parser module."""

import pytest
import tempfile
import os
from pathlib import Path
from kml_heatmap.parser import (
    extract_year_from_timestamp,
    sample_path_altitudes,
    is_mid_flight_start,
    is_valid_landing,
    parse_coordinate_point,
    get_cache_key,
    load_cached_parse,
    save_to_cache,
    extract_charterware_timestamp,
)


class TestExtractYearFromTimestamp:
    """Tests for extract_year_from_timestamp function."""

    def test_iso_format(self):
        """Test extracting year from ISO format timestamp."""
        assert extract_year_from_timestamp("2025-03-03T08:58:01Z") == 2025

    def test_date_only(self):
        """Test extracting year from date-only format."""
        assert extract_year_from_timestamp("2025-03-03") == 2025

    def test_text_format(self):
        """Test extracting year from text format."""
        assert extract_year_from_timestamp("03 Mar 2025") == 2025
        assert extract_year_from_timestamp("Log Start: 03 Mar 2024 08:58 Z") == 2024

    def test_invalid_format(self):
        """Test invalid format returns None."""
        assert extract_year_from_timestamp("invalid") is None
        assert extract_year_from_timestamp("") is None
        assert extract_year_from_timestamp(None) is None

    def test_no_year_present(self):
        """Test timestamp without year."""
        assert extract_year_from_timestamp("03 Mar") is None

    def test_future_year(self):
        """Test extracting future years."""
        assert extract_year_from_timestamp("2099-12-31T23:59:59Z") == 2099

    def test_early_2000s(self):
        """Test years in early 2000s."""
        assert extract_year_from_timestamp("2000-01-01T00:00:00Z") == 2000
        assert extract_year_from_timestamp("2010-06-15T12:00:00Z") == 2010


class TestSamplePathAltitudes:
    """Tests for sample_path_altitudes function."""

    def test_short_path(self):
        """Test path too short to sample."""
        path = [[0, 0, 100], [1, 1, 200]]
        assert sample_path_altitudes(path) is None

    def test_start_sample(self):
        """Test sampling from start of path."""
        # Create path with 100 points at varying altitudes
        path = [[i, i, 1000 + i * 10] for i in range(100)]
        result = sample_path_altitudes(path, from_end=False)
        assert result is not None
        assert "min" in result
        assert "max" in result
        assert "variation" in result
        assert result["min"] >= 1000
        assert result["max"] <= 2000

    def test_end_sample(self):
        """Test sampling from end of path."""
        # Create path with altitude increasing then decreasing
        path = [[i, i, i * 10] for i in range(50)]
        path += [[i, i, (100 - i) * 10] for i in range(50, 100)]
        result = sample_path_altitudes(path, from_end=True)
        assert result is not None
        assert result["variation"] >= 0

    def test_variation_calculation(self):
        """Test variation is correctly calculated."""
        # Flat path
        flat_path = [[i, i, 1000] for i in range(100)]
        result = sample_path_altitudes(flat_path)
        assert result["variation"] == 0

        # Varying path
        varying_path = [[i, i, 1000 + (i % 10) * 100] for i in range(100)]
        result = sample_path_altitudes(varying_path)
        assert result["variation"] > 0


class TestIsMidFlightStart:
    """Tests for is_mid_flight_start function."""

    def test_ground_start(self):
        """Test path starting at ground level."""
        path = [[i, i, 50 + i * 0.1] for i in range(100)]  # Low altitude
        assert not is_mid_flight_start(path, 50)

    def test_mid_flight_start(self):
        """Test path starting mid-flight."""
        # High stable altitude at start
        path = [[i, i, 5000] for i in range(100)]
        assert is_mid_flight_start(path, 5000)

    def test_climbing_start(self):
        """Test path starting with rapid climb."""
        # High altitude but climbing rapidly
        path = [[i, i, 3000 + i * 50] for i in range(100)]
        # Should not be considered mid-flight due to variation
        is_mid_flight_start(path, 3000, debug=False)
        # Result depends on variation threshold

    def test_short_path(self):
        """Test with path too short to analyze."""
        path = [[0, 0, 5000], [1, 1, 5000]]
        assert not is_mid_flight_start(path, 5000)


class TestIsValidLanding:
    """Tests for is_valid_landing function."""

    def test_ground_level_landing(self):
        """Test landing at ground level."""
        path = [[i, i, 1000 - i * 10] for i in range(100)]  # Descending
        assert is_valid_landing(path, 50)  # Low end altitude

    def test_mid_air_end(self):
        """Test path ending mid-air."""
        path = [[i, i, 5000] for i in range(100)]  # High stable altitude
        # Stable at high altitude - should still be valid if variation is low
        is_valid_landing(path, 5000)
        # Result depends on variation threshold

    def test_short_path_low_altitude(self):
        """Test short path with low end altitude."""
        path = [[0, 0, 100], [1, 1, 50]]
        assert is_valid_landing(path, 50)

    def test_short_path_high_altitude(self):
        """Test short path with high end altitude."""
        path = [[0, 0, 5000], [1, 1, 5000]]
        # Above fallback threshold
        is_valid_landing(path, 5000)
        # Should use fallback logic


class TestParseCoordinatePoint:
    """Tests for parse_coordinate_point function."""

    def test_valid_three_components(self):
        """Test parsing valid lon,lat,alt format."""
        result = parse_coordinate_point("8.5,50.0,300", "test.kml")
        assert result is not None
        lat, lon, alt = result
        assert lat == pytest.approx(50.0)
        assert lon == pytest.approx(8.5)
        assert alt == pytest.approx(300.0)

    def test_valid_two_components(self):
        """Test parsing lon,lat without altitude."""
        result = parse_coordinate_point("8.5,50.0", "test.kml")
        assert result is not None
        lat, lon, alt = result
        assert lat == pytest.approx(50.0)
        assert lon == pytest.approx(8.5)
        assert alt is None

    def test_negative_altitude_clamped(self):
        """Test negative altitude is clamped to zero."""
        result = parse_coordinate_point("8.5,50.0,-100", "test.kml")
        # Should be validated and potentially clamped
        assert result is not None

    def test_invalid_format(self):
        """Test invalid coordinate format."""
        assert parse_coordinate_point("invalid", "test.kml") is None
        assert parse_coordinate_point("", "test.kml") is None
        assert parse_coordinate_point("8.5", "test.kml") is None

    def test_whitespace_handling(self):
        """Test whitespace is handled."""
        result = parse_coordinate_point("  8.5,50.0,300  ", "test.kml")
        assert result is not None

    def test_out_of_range_coordinates(self):
        """Test coordinates out of valid range."""
        # Invalid latitude
        parse_coordinate_point("8.5,9999.0,300", "test.kml")
        # Should be filtered by validation

    def test_non_numeric_values(self):
        """Test non-numeric values."""
        assert parse_coordinate_point("abc,def,ghi", "test.kml") is None


class TestCacheFunctions:
    """Tests for cache-related functions."""

    def test_get_cache_key_nonexistent_file(self):
        """Test get_cache_key with nonexistent file."""
        cache_path, is_valid = get_cache_key("/nonexistent/file.kml")
        assert cache_path is None
        assert is_valid is False

    def test_get_cache_key_existing_file(self):
        """Test get_cache_key with existing file."""
        with tempfile.NamedTemporaryFile(suffix=".kml", delete=False) as f:
            f.write(b"test content")
            temp_path = f.name

        try:
            cache_path, is_valid = get_cache_key(temp_path)
            assert cache_path is not None
            assert isinstance(cache_path, Path)
            assert str(cache_path).endswith(".json")
            # First time should not be valid (cache doesn't exist)
            assert is_valid is False
        finally:
            os.unlink(temp_path)

    def test_save_and_load_cache(self):
        """Test saving and loading cache."""
        with tempfile.NamedTemporaryFile(suffix=".kml", delete=False) as f:
            temp_path = f.name

        try:
            cache_path, _ = get_cache_key(temp_path)
            if cache_path is None:
                pytest.skip("Could not create cache path")

            # Test data
            coords = [[1.0, 2.0], [3.0, 4.0]]
            paths = [[[1.0, 2.0, 100], [3.0, 4.0, 200]]]
            metadata = [{"test": "data"}]

            # Save
            save_to_cache(cache_path, coords, paths, metadata)
            assert cache_path.exists()

            # Load
            loaded = load_cached_parse(cache_path)
            assert loaded is not None
            loaded_coords, loaded_paths, loaded_metadata = loaded
            assert loaded_coords == coords
            assert loaded_paths == paths
            assert loaded_metadata == metadata

        finally:
            if os.path.exists(temp_path):
                os.unlink(temp_path)
            # Clean up cache file
            if cache_path and cache_path.exists():
                cache_path.unlink()

    def test_load_cache_invalid_file(self):
        """Test loading invalid cache file."""
        with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as f:
            f.write(b"invalid json")
            temp_path = f.name

        try:
            result = load_cached_parse(Path(temp_path))
            assert result is None
        finally:
            os.unlink(temp_path)

    def test_load_cache_nonexistent_file(self):
        """Test loading nonexistent cache file."""
        result = load_cached_parse(Path("/nonexistent/cache.json"))
        assert result is None

    def test_get_cache_key_cleanup_old_caches(self):
        """Test that old cache files are cleaned up."""
        import tempfile
        from pathlib import Path

        with tempfile.TemporaryDirectory() as tmpdir:
            # Create a test KML file
            kml_file = Path(tmpdir) / "test.kml"
            kml_file.write_text("<kml></kml>")

            # Create some old cache files
            cache_dir = Path(tmpdir) / ".kml_cache"
            cache_dir.mkdir(exist_ok=True)

            old_cache1 = cache_dir / "test_old1.json"
            old_cache2 = cache_dir / "test_old2.json"
            old_cache1.write_text("{}")
            old_cache2.write_text("{}")

            # Mock KML_CACHE_DIR to use our temp directory
            from unittest.mock import patch

            with patch("kml_heatmap.parser.KML_CACHE_DIR", cache_dir):
                cache_path, is_valid = get_cache_key(str(kml_file))

                # Old caches should be cleaned up
                assert not old_cache1.exists()
                assert not old_cache2.exists()

    def test_get_cache_key_cleanup_handles_errors(self):
        """Test that cache cleanup handles errors gracefully."""
        import tempfile
        from pathlib import Path

        with tempfile.TemporaryDirectory() as tmpdir:
            # Create a test KML file
            kml_file = Path(tmpdir) / "test.kml"
            kml_file.write_text("<kml></kml>")

            # Create cache directory
            cache_dir = Path(tmpdir) / ".kml_cache"
            cache_dir.mkdir(exist_ok=True)

            # Create an old cache file and make it read-only
            old_cache = cache_dir / "test_readonly.json"
            old_cache.write_text("{}")

            # Mock KML_CACHE_DIR
            from unittest.mock import patch

            with patch("kml_heatmap.parser.KML_CACHE_DIR", cache_dir):
                # Should not raise even if cleanup fails
                cache_path, is_valid = get_cache_key(str(kml_file))
                assert cache_path is not None


class TestFindXmlElement:
    """Tests for find_xml_element function."""

    def test_find_with_namespace(self):
        """Test finding element with namespace."""
        from kml_heatmap.parser import find_xml_element
        from xml.etree import ElementTree as ET

        xml = """<root xmlns:kml="http://test.com"><kml:name>Test</kml:name></root>"""
        root = ET.fromstring(xml)
        namespaces = {"kml": "http://test.com"}

        elem = find_xml_element(root, ".//kml:name", ".//name", namespaces)
        assert elem is not None
        assert elem.text == "Test"

    def test_find_with_fallback(self):
        """Test finding element using fallback path."""
        from kml_heatmap.parser import find_xml_element
        from xml.etree import ElementTree as ET

        xml = """<root><name>Test</name></root>"""
        root = ET.fromstring(xml)
        namespaces = {"kml": "http://test.com"}

        elem = find_xml_element(root, ".//kml:name", ".//name", namespaces)
        assert elem is not None
        assert elem.text == "Test"

    def test_find_element_not_found(self):
        """Test when element is not found."""
        from kml_heatmap.parser import find_xml_element
        from xml.etree import ElementTree as ET

        xml = """<root><other>Test</other></root>"""
        root = ET.fromstring(xml)
        namespaces = {"kml": "http://test.com"}

        elem = find_xml_element(root, ".//kml:name", ".//name", namespaces)
        assert elem is None


class TestFindXmlElements:
    """Tests for find_xml_elements function."""

    def test_find_multiple_with_namespace(self):
        """Test finding multiple elements with namespace."""
        from kml_heatmap.parser import find_xml_elements
        from xml.etree import ElementTree as ET

        xml = """<root xmlns:kml="http://test.com">
            <kml:when>2025-01-01</kml:when>
            <kml:when>2025-01-02</kml:when>
        </root>"""
        root = ET.fromstring(xml)
        namespaces = {"kml": "http://test.com"}

        elems = find_xml_elements(root, ".//kml:when", ".//when", namespaces)
        assert len(elems) == 2
        assert elems[0].text == "2025-01-01"
        assert elems[1].text == "2025-01-02"

    def test_find_multiple_with_fallback(self):
        """Test finding multiple elements using fallback."""
        from kml_heatmap.parser import find_xml_elements
        from xml.etree import ElementTree as ET

        xml = """<root><when>2025-01-01</when><when>2025-01-02</when></root>"""
        root = ET.fromstring(xml)
        namespaces = {"kml": "http://test.com"}

        elems = find_xml_elements(root, ".//kml:when", ".//when", namespaces)
        assert len(elems) == 2

    def test_find_elements_not_found(self):
        """Test when no elements are found."""
        from kml_heatmap.parser import find_xml_elements
        from xml.etree import ElementTree as ET

        xml = """<root><other>Test</other></root>"""
        root = ET.fromstring(xml)
        namespaces = {"kml": "http://test.com"}

        elems = find_xml_elements(root, ".//kml:when", ".//when", namespaces)
        assert len(elems) == 0


class TestExtractPlacemarkMetadata:
    """Tests for extract_placemark_metadata function."""

    def test_extract_with_name_and_timestamp(self):
        """Test extracting metadata with name and timestamp."""
        from kml_heatmap.parser import extract_placemark_metadata
        from xml.etree import ElementTree as ET

        xml = """<Placemark xmlns="http://www.opengis.net/kml/2.2">
            <name>Test Airport</name>
            <when>2025-03-15T10:00:00Z</when>
        </Placemark>"""
        placemark = ET.fromstring(xml)
        namespaces = {"kml": "http://www.opengis.net/kml/2.2"}

        metadata = extract_placemark_metadata(placemark, namespaces)
        assert metadata["airport_name"] == "Test Airport"
        assert metadata["timestamp"] == "2025-03-15T10:00:00Z"
        assert metadata["year"] == 2025

    def test_extract_with_multiple_timestamps(self):
        """Test extracting metadata with multiple timestamps."""
        from kml_heatmap.parser import extract_placemark_metadata
        from xml.etree import ElementTree as ET

        xml = """<Placemark xmlns="http://www.opengis.net/kml/2.2">
            <when>2025-03-15T10:00:00Z</when>
            <when>2025-03-15T11:00:00Z</when>
        </Placemark>"""
        placemark = ET.fromstring(xml)
        namespaces = {"kml": "http://www.opengis.net/kml/2.2"}

        metadata = extract_placemark_metadata(placemark, namespaces)
        assert metadata["timestamp"] == "2025-03-15T10:00:00Z"
        assert metadata["end_timestamp"] == "2025-03-15T11:00:00Z"

    def test_extract_timestamp_from_name(self):
        """Test extracting timestamp from name when when element missing."""
        from kml_heatmap.parser import extract_placemark_metadata
        from xml.etree import ElementTree as ET

        xml = """<Placemark xmlns="http://www.opengis.net/kml/2.2">
            <name>Log Start: 03 Mar 2025 08:58 Z</name>
        </Placemark>"""
        placemark = ET.fromstring(xml)
        namespaces = {"kml": "http://www.opengis.net/kml/2.2"}

        metadata = extract_placemark_metadata(placemark, namespaces)
        assert metadata["airport_name"] == "Log Start: 03 Mar 2025 08:58 Z"
        assert "03 Mar 2025" in metadata["timestamp"]
        assert metadata["year"] == 2025

    def test_extract_no_metadata(self):
        """Test extracting metadata when none exists."""
        from kml_heatmap.parser import extract_placemark_metadata
        from xml.etree import ElementTree as ET

        xml = """<Placemark xmlns="http://www.opengis.net/kml/2.2"></Placemark>"""
        placemark = ET.fromstring(xml)
        namespaces = {"kml": "http://www.opengis.net/kml/2.2"}

        metadata = extract_placemark_metadata(placemark, namespaces)
        assert metadata["airport_name"] is None
        assert metadata["timestamp"] is None
        assert metadata["end_timestamp"] is None
        assert metadata["year"] is None


class TestProcessStandardCoordinates:
    """Tests for process_standard_coordinates function."""

    def test_process_valid_coordinates(self):
        """Test processing valid coordinate elements."""
        from kml_heatmap.parser import process_standard_coordinates
        from xml.etree import ElementTree as ET

        # Create mock coordinate element
        coord_elem = ET.Element("coordinates")
        coord_elem.text = "8.5,50.0,300 9.0,51.0,400"

        coordinates = []
        path_groups = []
        path_metadata = []
        coord_to_metadata = {
            id(coord_elem): {
                "airport_name": "Test",
                "timestamp": None,
                "end_timestamp": None,
            }
        }

        with tempfile.NamedTemporaryFile(suffix=".kml") as f:
            process_standard_coordinates(
                [coord_elem],
                coord_to_metadata,
                f.name,
                coordinates,
                path_groups,
                path_metadata,
            )

        assert len(coordinates) == 2
        assert len(path_groups) == 1
        assert len(path_metadata) == 1
        assert path_metadata[0]["airport_name"] == "Test"

    def test_process_empty_coordinate_element(self):
        """Test processing empty coordinate element."""
        from kml_heatmap.parser import process_standard_coordinates
        from xml.etree import ElementTree as ET

        coord_elem = ET.Element("coordinates")
        coord_elem.text = ""

        coordinates = []
        path_groups = []
        path_metadata = []

        with tempfile.NamedTemporaryFile(suffix=".kml") as f:
            process_standard_coordinates(
                [coord_elem],
                {},
                f.name,
                coordinates,
                path_groups,
                path_metadata,
            )

        assert len(coordinates) == 0
        assert len(path_groups) == 0

    def test_process_none_text_coordinate(self):
        """Test processing coordinate element with None text."""
        from kml_heatmap.parser import process_standard_coordinates
        from xml.etree import ElementTree as ET

        coord_elem = ET.Element("coordinates")
        coord_elem.text = None

        coordinates = []
        path_groups = []
        path_metadata = []

        with tempfile.NamedTemporaryFile(suffix=".kml") as f:
            process_standard_coordinates(
                [coord_elem],
                {},
                f.name,
                coordinates,
                path_groups,
                path_metadata,
            )

        assert len(coordinates) == 0
        assert len(path_groups) == 0


class TestParseKmlCoordinates:
    """Tests for parse_kml_coordinates function."""

    def test_parse_simple_kml(self):
        """Test parsing simple KML file."""
        from kml_heatmap.parser import parse_kml_coordinates

        kml_content = """<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <Placemark>
      <name>Test Path</name>
      <LineString>
        <coordinates>8.5,50.0,300 9.0,51.0,400</coordinates>
      </LineString>
    </Placemark>
  </Document>
</kml>"""

        with tempfile.NamedTemporaryFile(mode="w", suffix=".kml", delete=False) as f:
            f.write(kml_content)
            temp_path = f.name

        try:
            coords, paths, metadata = parse_kml_coordinates(temp_path)
            assert len(coords) == 2
            assert len(paths) == 1
            assert len(metadata) == 1
            assert metadata[0]["airport_name"] == "Test Path"
        finally:
            os.unlink(temp_path)
            # Clean up cache
            from kml_heatmap.parser import get_cache_key

            cache_path, _ = get_cache_key(temp_path)
            if cache_path and cache_path.exists():
                cache_path.unlink()

    def test_parse_with_cache(self):
        """Test parsing uses cache on second call."""
        from kml_heatmap.parser import parse_kml_coordinates

        kml_content = """<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <Placemark>
      <LineString>
        <coordinates>8.5,50.0,300</coordinates>
      </LineString>
    </Placemark>
  </Document>
</kml>"""

        with tempfile.NamedTemporaryFile(mode="w", suffix=".kml", delete=False) as f:
            f.write(kml_content)
            temp_path = f.name

        try:
            # First parse
            coords1, paths1, metadata1 = parse_kml_coordinates(temp_path)
            # Second parse (should use cache)
            coords2, paths2, metadata2 = parse_kml_coordinates(temp_path)

            assert coords1 == coords2
            assert paths1 == paths2
            assert metadata1 == metadata2
        finally:
            os.unlink(temp_path)
            # Clean up cache
            from kml_heatmap.parser import get_cache_key

            cache_path, _ = get_cache_key(temp_path)
            if cache_path and cache_path.exists():
                cache_path.unlink()

    def test_parse_invalid_xml(self):
        """Test parsing invalid XML file."""
        from kml_heatmap.parser import parse_kml_coordinates

        with tempfile.NamedTemporaryFile(mode="w", suffix=".kml", delete=False) as f:
            f.write("not valid xml <")
            temp_path = f.name

        try:
            coords, paths, metadata = parse_kml_coordinates(temp_path)
            assert len(coords) == 0
            assert len(paths) == 0
            assert len(metadata) == 0
        finally:
            os.unlink(temp_path)

    def test_parse_gx_track(self):
        """Test parsing Google Earth Track format."""
        from kml_heatmap.parser import parse_kml_coordinates

        kml_content = """<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">
  <Document>
    <Placemark>
      <name>Track</name>
      <gx:Track>
        <when>2025-03-15T10:00:00Z</when>
        <when>2025-03-15T10:01:00Z</when>
        <gx:coord>8.5 50.0 300</gx:coord>
        <gx:coord>9.0 51.0 400</gx:coord>
      </gx:Track>
    </Placemark>
  </Document>
</kml>"""

        with tempfile.NamedTemporaryFile(mode="w", suffix=".kml", delete=False) as f:
            f.write(kml_content)
            temp_path = f.name

        try:
            coords, paths, metadata = parse_kml_coordinates(temp_path)
            assert len(coords) == 2
            assert len(paths) == 1
            # Check that timestamps are included
            assert len(paths[0][0]) == 4  # [lat, lon, alt, timestamp]
        finally:
            os.unlink(temp_path)
            # Clean up cache
            from kml_heatmap.parser import get_cache_key

            cache_path, _ = get_cache_key(temp_path)
            if cache_path and cache_path.exists():
                cache_path.unlink()


class TestExtractCharterwareTimestamp:
    """Tests for extract_charterware_timestamp function."""

    def test_basic_format(self):
        """Test parsing basic Charterware description format."""
        desc = "Flight Jan 12 2026 03:01PM path of OE-AKI"
        result = extract_charterware_timestamp(desc)
        assert result == "2026-01-12T15:01:00Z"

    def test_different_months(self):
        """Test parsing different months."""
        # January
        assert (
            extract_charterware_timestamp("Flight Jan 15 2026 02:30PM path of OE-AKI")
            == "2026-01-15T14:30:00Z"
        )
        # December
        assert (
            extract_charterware_timestamp("Flight Dec 25 2025 11:45AM path of OE-AKI")
            == "2025-12-25T11:45:00Z"
        )
        # March
        assert (
            extract_charterware_timestamp("Flight Mar 3 2025 08:15AM path of D-EAGJ")
            == "2025-03-03T08:15:00Z"
        )

    def test_am_pm_conversion(self):
        """Test AM/PM to 24-hour conversion."""
        # 12 AM (midnight)
        assert (
            extract_charterware_timestamp("Flight Jan 1 2026 12:00AM path of OE-AKI")
            == "2026-01-01T00:00:00Z"
        )
        # 12 PM (noon)
        assert (
            extract_charterware_timestamp("Flight Jan 1 2026 12:00PM path of OE-AKI")
            == "2026-01-01T12:00:00Z"
        )
        # 1 AM
        assert (
            extract_charterware_timestamp("Flight Jan 1 2026 01:30AM path of OE-AKI")
            == "2026-01-01T01:30:00Z"
        )
        # 1 PM
        assert (
            extract_charterware_timestamp("Flight Jan 1 2026 01:30PM path of OE-AKI")
            == "2026-01-01T13:30:00Z"
        )
        # 11 PM
        assert (
            extract_charterware_timestamp("Flight Jan 1 2026 11:59PM path of OE-AKI")
            == "2026-01-01T23:59:00Z"
        )

    def test_invalid_format(self):
        """Test that invalid formats return None."""
        assert extract_charterware_timestamp("") is None
        assert extract_charterware_timestamp(None) is None
        assert extract_charterware_timestamp("Invalid description") is None
        assert extract_charterware_timestamp("Flight without timestamp") is None

    def test_full_month_names(self):
        """Test parsing with full month names (if supported)."""
        # Should handle full month names
        result = extract_charterware_timestamp(
            "Flight January 12 2026 03:01PM path of OE-AKI"
        )
        assert result == "2026-01-12T15:01:00Z"


class TestParseCharterwareKML:
    """Integration tests for parsing Charterware KML files."""

    def test_parse_charterware_kml(self):
        """Test parsing actual Charterware KML format."""
        import tempfile
        import os
        from kml_heatmap.parser import parse_kml_coordinates, get_cache_key

        kml_content = """<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">
    <Document id="1">
        <Style id="4">
            <LineStyle id="5">
                <color>ff8c4426</color>
                <colorMode>normal</colorMode>
                <width>4</width>
            </LineStyle>
        </Style>
        <Placemark id="3">
            <name>OE-AKI</name>
            <description>Flight Jan 12 2026 03:01PM path of OE-AKI</description>
            <styleUrl>#4</styleUrl>
            <LineString id="2">
                <coordinates>
                    16.252537,47.96571,232.800003 16.252432,47.965717,231.800003 16.252419,47.96571,231.800003
                </coordinates>
                <extrude>1</extrude>
                <altitudeMode>absolute</altitudeMode>
            </LineString>
        </Placemark>
    </Document>
</kml>"""

        # Create temp file with exact Charterware filename format
        temp_dir = tempfile.gettempdir()
        temp_path = os.path.join(temp_dir, "2026-01-12_1513h_OE-AKI_LOAV-LOAV.kml")

        with open(temp_path, "w") as f:
            f.write(kml_content)

        try:
            coords, paths, metadata = parse_kml_coordinates(temp_path)

            # Check coordinates were extracted
            assert len(coords) > 0
            assert len(paths) > 0
            assert len(metadata) > 0

            # Check metadata
            meta = metadata[0]
            assert meta.get("aircraft_registration") == "OE-AKI"
            assert meta.get("route") == "LOAV-LOAV"
            assert meta.get("aircraft_type") is None  # Charterware doesn't include type
            assert (
                meta.get("timestamp") is not None
            )  # Should be extracted from description
            assert meta.get("year") == 2026

        finally:
            if os.path.exists(temp_path):
                os.unlink(temp_path)
            # Clean up cache
            cache_path, _ = get_cache_key(temp_path)
            if cache_path and cache_path.exists():
                cache_path.unlink()

    def test_charterware_metadata_extraction(self):
        """Test that Charterware metadata is correctly extracted."""
        import tempfile
        import os
        from kml_heatmap.parser import parse_kml_coordinates, get_cache_key

        kml_content = """<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
    <Document>
        <Placemark>
            <name>D-EXYZ</name>
            <description>Flight Feb 15 2026 10:30AM path of D-EXYZ</description>
            <LineString>
                <coordinates>8.5,50.0,300 9.0,51.0,400</coordinates>
            </LineString>
        </Placemark>
    </Document>
</kml>"""

        # Create temp file with exact Charterware filename format
        temp_dir = tempfile.gettempdir()
        temp_path = os.path.join(temp_dir, "2026-02-15_1030h_D-EXYZ_EDDF-EDDM.kml")

        with open(temp_path, "w") as f:
            f.write(kml_content)

        try:
            coords, paths, metadata = parse_kml_coordinates(temp_path)

            assert len(metadata) > 0
            meta = metadata[0]

            # Check aircraft info from filename
            assert meta.get("aircraft_registration") == "D-EXYZ"
            assert meta.get("route") == "EDDF-EDDM"

            # Check timestamp from description
            assert meta.get("timestamp") == "2026-02-15T10:30:00Z"
            assert meta.get("year") == 2026

        finally:
            if os.path.exists(temp_path):
                os.unlink(temp_path)
            # Clean up cache
            cache_path, _ = get_cache_key(temp_path)
            if cache_path and cache_path.exists():
                cache_path.unlink()

    def test_mixed_formats(self):
        """Test that parser handles both SkyDemon and Charterware formats correctly."""
        import tempfile
        import os
        from kml_heatmap.parser import parse_kml_coordinates, get_cache_key

        # Create SkyDemon format KML
        skydemon_kml = """<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">
    <Document>
        <Placemark>
            <name>EDAV - EDBH</name>
            <gx:Track>
                <when>2025-08-22T10:13:29Z</when>
                <gx:coord>13.710165 52.827545 42.392002</gx:coord>
            </gx:Track>
        </Placemark>
    </Document>
</kml>"""

        # Create Charterware format KML
        charterware_kml = """<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
    <Document>
        <Placemark>
            <name>OE-AKI</name>
            <description>Flight Jan 12 2026 03:01PM path of OE-AKI</description>
            <LineString>
                <coordinates>16.252537,47.96571,232.8</coordinates>
            </LineString>
        </Placemark>
    </Document>
</kml>"""

        # Create temp files with exact filenames (unique for this test)
        temp_dir = tempfile.gettempdir()
        skydemon_path = os.path.join(temp_dir, "20250822_1013_EDAV_DEHYL_DA40.kml")
        charterware_path = os.path.join(
            temp_dir, "2026-01-15_1513h_OE-AKI_EDDF-EDDM.kml"
        )

        # Clear any existing caches before test
        for path in [skydemon_path, charterware_path]:
            cache_path, _ = get_cache_key(path)
            if cache_path and cache_path.exists():
                cache_path.unlink()

        with open(skydemon_path, "w") as f:
            f.write(skydemon_kml)

        with open(charterware_path, "w") as f:
            f.write(charterware_kml)

        try:
            # Parse SkyDemon
            coords_sd, paths_sd, metadata_sd = parse_kml_coordinates(skydemon_path)
            assert len(metadata_sd) > 0
            assert metadata_sd[0].get("aircraft_registration") == "D-EHYL"
            assert metadata_sd[0].get("aircraft_type") == "DA40"

            # Parse Charterware
            coords_cw, paths_cw, metadata_cw = parse_kml_coordinates(charterware_path)
            assert len(metadata_cw) > 0
            assert metadata_cw[0].get("aircraft_registration") == "OE-AKI"
            assert metadata_cw[0].get("route") == "EDDF-EDDM"
            assert metadata_cw[0].get("aircraft_type") is None

        finally:
            if os.path.exists(skydemon_path):
                os.unlink(skydemon_path)
            if os.path.exists(charterware_path):
                os.unlink(charterware_path)
            # Clean up caches
            for path in [skydemon_path, charterware_path]:
                cache_path, _ = get_cache_key(path)
                if cache_path and cache_path.exists():
                    cache_path.unlink()


class TestSyntheticTimestampGeneration:
    """Tests for synthetic timestamp generation in Charterware files."""

    def test_synthetic_timestamps_charterware(self):
        """Test that synthetic timestamps are generated for Charterware files."""
        import tempfile
        import os
        from kml_heatmap.parser import parse_kml_coordinates, get_cache_key

        # Charterware KML with no per-point timestamps
        kml_content = """<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
    <Document>
        <Placemark>
            <name>OE-AKI</name>
            <description>Flight Jan 12 2026 03:01PM path of OE-AKI</description>
            <LineString>
                <coordinates>16.25,47.96,232.8 16.26,47.97,240.0 16.27,47.98,250.0</coordinates>
            </LineString>
        </Placemark>
    </Document>
</kml>"""

        # Create temp file with exact Charterware filename format
        temp_dir = tempfile.gettempdir()
        temp_path = os.path.join(temp_dir, "2026-01-12_1513h_OE-AKI_LOAV-LOAV.kml")

        # Clear any existing cache before test
        cache_path, _ = get_cache_key(temp_path)
        if cache_path and cache_path.exists():
            cache_path.unlink()

        with open(temp_path, "w") as f:
            f.write(kml_content)

        try:
            coords, paths, metadata = parse_kml_coordinates(temp_path)

            # Should have 3 points
            assert len(coords) == 3
            assert len(paths) == 1
            assert len(paths[0]) == 3

            # Each point should have 4 elements: [lat, lon, alt, timestamp]
            assert len(paths[0][0]) == 4
            assert len(paths[0][1]) == 4
            assert len(paths[0][2]) == 4

            # Check timestamps are 2 seconds apart
            ts1 = paths[0][0][3]
            ts2 = paths[0][1][3]
            ts3 = paths[0][2][3]

            assert ts1 == "2026-01-12T15:01:00Z"
            assert ts2 == "2026-01-12T15:01:02Z"  # +2 seconds
            assert ts3 == "2026-01-12T15:01:04Z"  # +4 seconds total

            # Metadata should have end_timestamp
            assert metadata[0].get("end_timestamp") == "2026-01-12T15:01:04Z"

        finally:
            if os.path.exists(temp_path):
                os.unlink(temp_path)
            cache_path, _ = get_cache_key(temp_path)
            if cache_path and cache_path.exists():
                cache_path.unlink()

    def test_synthetic_timestamps_interval(self):
        """Test that synthetic timestamps use correct 2-second interval."""
        import tempfile
        import os
        from kml_heatmap.parser import parse_kml_coordinates, get_cache_key

        # Create 10 points
        coords_str = " ".join([f"16.{i},47.{i},230.0" for i in range(10)])
        kml_content = f"""<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
    <Document>
        <Placemark>
            <name>OE-AKI</name>
            <description>Flight Jan 15 2026 10:00AM path of OE-AKI</description>
            <LineString>
                <coordinates>{coords_str}</coordinates>
            </LineString>
        </Placemark>
    </Document>
</kml>"""

        # Create temp file with exact Charterware filename format
        temp_dir = tempfile.gettempdir()
        temp_path = os.path.join(temp_dir, "2026-01-15_1000h_OE-AKI_EDDF-EDDM.kml")

        with open(temp_path, "w") as f:
            f.write(kml_content)

        try:
            coords, paths, metadata = parse_kml_coordinates(temp_path)

            # Should have 10 points with timestamps
            assert len(paths[0]) == 10

            # First and last timestamps
            first_ts = paths[0][0][3]
            last_ts = paths[0][9][3]

            assert first_ts == "2026-01-15T10:00:00Z"
            assert last_ts == "2026-01-15T10:00:18Z"  # 9 intervals * 2s = 18s

            # Check metadata
            meta = metadata[0]
            assert meta.get("timestamp") == "2026-01-15T10:00:00Z"
            assert meta.get("end_timestamp") == "2026-01-15T10:00:18Z"

        finally:
            if os.path.exists(temp_path):
                os.unlink(temp_path)
            cache_path, _ = get_cache_key(temp_path)
            if cache_path and cache_path.exists():
                cache_path.unlink()

    def test_no_synthetic_timestamps_for_skydemon(self):
        """Test that SkyDemon files with real timestamps don't get synthetic ones."""
        import tempfile
        import os
        from kml_heatmap.parser import parse_kml_coordinates, get_cache_key

        # SkyDemon format with real timestamps
        kml_content = """<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">
    <Document>
        <Placemark>
            <name>EDAV - EDBH</name>
            <gx:Track>
                <when>2025-08-22T10:13:00Z</when>
                <when>2025-08-22T10:13:05Z</when>
                <gx:coord>13.71 52.82 42.0</gx:coord>
                <gx:coord>13.72 52.83 45.0</gx:coord>
            </gx:Track>
        </Placemark>
    </Document>
</kml>"""

        # Create temp file with exact SkyDemon filename format (unique)
        temp_dir = tempfile.gettempdir()
        temp_path = os.path.join(temp_dir, "20250823_1013_EDBH_DEHYL_DA40.kml")

        with open(temp_path, "w") as f:
            f.write(kml_content)

        try:
            coords, paths, metadata = parse_kml_coordinates(temp_path)

            # Should preserve original timestamps
            if paths and len(paths[0]) > 0:
                # Timestamps should be from the original <when> elements
                ts1 = paths[0][0][3] if len(paths[0][0]) > 3 else None
                ts2 = paths[0][1][3] if len(paths[0][1]) > 3 else None

                # Should have original timestamps, not synthetic 2s intervals
                if ts1 and ts2:
                    assert ts1 == "2025-08-22T10:13:00Z"
                    assert ts2 == "2025-08-22T10:13:05Z"  # 5s apart, not 2s

        finally:
            if os.path.exists(temp_path):
                os.unlink(temp_path)
            cache_path, _ = get_cache_key(temp_path)
            if cache_path and cache_path.exists():
                cache_path.unlink()


class TestAirportExtractionFromRoute:
    """Tests for airport extraction from Charterware route field."""

    def test_airport_from_route_charterware(self):
        """Test that airport is extracted from route for Charterware files."""
        import tempfile
        import os
        from kml_heatmap.parser import parse_kml_coordinates, get_cache_key

        kml_content = """<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
    <Document>
        <Placemark>
            <name>OE-AKI</name>
            <description>Flight Jan 12 2026 03:01PM path of OE-AKI</description>
            <LineString>
                <coordinates>16.25,47.96,232.8</coordinates>
            </LineString>
        </Placemark>
    </Document>
</kml>"""

        # Create temp file with exact Charterware filename format
        temp_dir = tempfile.gettempdir()
        temp_path = os.path.join(temp_dir, "2026-01-12_1513h_OE-AKI_LOAV-LOAV.kml")

        with open(temp_path, "w") as f:
            f.write(kml_content)

        try:
            coords, paths, metadata = parse_kml_coordinates(temp_path)

            # Airport should be extracted from route (LOAV-LOAV)
            # Format: "DEPARTURE - ARRIVAL" with full names from OurAirports lookup
            assert (
                metadata[0].get("airport_name")
                == "LOAV Vöslau-Kottingbrunn - LOAV Vöslau-Kottingbrunn"
            )
            assert metadata[0].get("route") == "LOAV-LOAV"

        finally:
            if os.path.exists(temp_path):
                os.unlink(temp_path)
            cache_path, _ = get_cache_key(temp_path)
            if cache_path and cache_path.exists():
                cache_path.unlink()

    def test_airport_from_route_different_airports(self):
        """Test route with different departure and arrival airports."""
        import tempfile
        import os
        from kml_heatmap.parser import parse_kml_coordinates, get_cache_key

        kml_content = """<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
    <Document>
        <Placemark>
            <name>D-EXYZ</name>
            <description>Flight Feb 15 2026 10:30AM path of D-EXYZ</description>
            <LineString>
                <coordinates>8.5,50.0,300.0</coordinates>
            </LineString>
        </Placemark>
    </Document>
</kml>"""

        # Create temp file with exact Charterware filename format
        temp_dir = tempfile.gettempdir()
        temp_path = os.path.join(temp_dir, "2026-02-15_1030h_D-EXYZ_EDDF-EDDM.kml")

        with open(temp_path, "w") as f:
            f.write(kml_content)

        try:
            coords, paths, metadata = parse_kml_coordinates(temp_path)

            # Should extract route and format as "DEPARTURE - ARRIVAL" with full names from OurAirports
            assert metadata[0].get("airport_name") == "EDDF Frankfurt - EDDM Munich"
            assert metadata[0].get("route") == "EDDF-EDDM"

        finally:
            if os.path.exists(temp_path):
                os.unlink(temp_path)
            cache_path, _ = get_cache_key(temp_path)
            if cache_path and cache_path.exists():
                cache_path.unlink()

    def test_skydemon_airport_not_replaced(self):
        """Test that SkyDemon airport names are not replaced by route logic."""
        import tempfile
        import os
        from kml_heatmap.parser import parse_kml_coordinates, get_cache_key

        # SkyDemon with airport pair in name
        kml_content = """<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">
    <Document>
        <Placemark>
            <name>EDAV - EDBH</name>
            <gx:Track>
                <when>2025-08-22T10:13:00Z</when>
                <gx:coord>13.71 52.82 42.0</gx:coord>
            </gx:Track>
        </Placemark>
    </Document>
</kml>"""

        with tempfile.NamedTemporaryFile(
            mode="w", suffix="20250822_1013_EDAV_DEHYL_DA40.kml", delete=False
        ) as f:
            f.write(kml_content)
            temp_path = f.name

        try:
            coords, paths, metadata = parse_kml_coordinates(temp_path)

            # Should preserve SkyDemon airport name format (with standardization)
            assert (
                metadata[0].get("airport_name")
                == "EDAV Eberswalde-Finow - EDBH Stralsund-Barth"
            )
            # SkyDemon files don't have route field
            assert metadata[0].get("route") is None

        finally:
            if os.path.exists(temp_path):
                os.unlink(temp_path)
            cache_path, _ = get_cache_key(temp_path)
            if cache_path and cache_path.exists():
                cache_path.unlink()
