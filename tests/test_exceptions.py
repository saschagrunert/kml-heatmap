"""Tests for exceptions module."""

import pytest
from kml_heatmap.exceptions import (
    KMLHeatmapError,
    KMLParseError,
    AircraftLookupError,
    InvalidCoordinateError,
    DataExportError,
    InvalidAltitudeError,
    ConfigurationError,
)


class TestKMLHeatmapError:
    """Tests for KMLHeatmapError base exception."""

    def test_base_exception(self):
        """Test raising base exception."""
        with pytest.raises(KMLHeatmapError):
            raise KMLHeatmapError("Test error")

    def test_base_exception_message(self):
        """Test base exception message."""
        error = KMLHeatmapError("Test message")
        assert str(error) == "Test message"


class TestKMLParseError:
    """Tests for KMLParseError exception."""

    def test_simple_parse_error(self):
        """Test parse error with just message."""
        error = KMLParseError("Parse failed")
        assert "Parse failed" in str(error)

    def test_parse_error_with_file(self):
        """Test parse error with file path."""
        error = KMLParseError("Parse failed", file_path="test.kml")
        assert "Parse failed" in str(error)
        assert "test.kml" in str(error)
        assert error.file_path == "test.kml"

    def test_parse_error_with_line(self):
        """Test parse error with line number."""
        error = KMLParseError("Parse failed", line_number=42)
        assert "Parse failed" in str(error)
        assert "42" in str(error)
        assert error.line_number == 42

    def test_parse_error_with_file_and_line(self):
        """Test parse error with file and line."""
        error = KMLParseError("Parse failed", file_path="test.kml", line_number=42)
        assert "Parse failed" in str(error)
        assert "test.kml" in str(error)
        assert "42" in str(error)

    def test_parse_error_inheritance(self):
        """Test parse error inherits from base."""
        error = KMLParseError("Test")
        assert isinstance(error, KMLHeatmapError)

    def test_parse_error_can_be_caught(self):
        """Test parse error can be caught."""
        with pytest.raises(KMLParseError):
            raise KMLParseError("Test error")


class TestAircraftLookupError:
    """Tests for AircraftLookupError exception."""

    def test_simple_aircraft_error(self):
        """Test aircraft error with just message."""
        error = AircraftLookupError("Lookup failed")
        assert "Lookup failed" in str(error)

    def test_aircraft_error_with_registration(self):
        """Test aircraft error with registration."""
        error = AircraftLookupError("Lookup failed", registration="D-EAGJ")
        assert "Lookup failed" in str(error)
        assert "D-EAGJ" in str(error)
        assert error.registration == "D-EAGJ"

    def test_aircraft_error_inheritance(self):
        """Test aircraft error inherits from base."""
        error = AircraftLookupError("Test")
        assert isinstance(error, KMLHeatmapError)


class TestInvalidCoordinateError:
    """Tests for InvalidCoordinateError exception."""

    def test_simple_coordinate_error(self):
        """Test coordinate error with just message."""
        error = InvalidCoordinateError("Invalid coordinate")
        assert "Invalid coordinate" in str(error)

    def test_coordinate_error_with_values(self):
        """Test coordinate error with lat/lon values."""
        error = InvalidCoordinateError(
            "Invalid coordinate", latitude=50.0, longitude=8.5
        )
        assert "Invalid coordinate" in str(error)
        assert "50.0" in str(error)
        assert "8.5" in str(error)
        assert error.latitude == 50.0
        assert error.longitude == 8.5

    def test_coordinate_error_with_partial_values(self):
        """Test coordinate error with only latitude."""
        error = InvalidCoordinateError("Invalid coordinate", latitude=50.0)
        assert "Invalid coordinate" in str(error)
        assert error.latitude == 50.0
        assert error.longitude is None

    def test_coordinate_error_inheritance(self):
        """Test coordinate error inherits from base."""
        error = InvalidCoordinateError("Test")
        assert isinstance(error, KMLHeatmapError)


class TestDataExportError:
    """Tests for DataExportError exception."""

    def test_simple_export_error(self):
        """Test export error with just message."""
        error = DataExportError("Export failed")
        assert "Export failed" in str(error)

    def test_export_error_with_path(self):
        """Test export error with output path."""
        error = DataExportError("Export failed", output_path="/path/to/output.html")
        assert "Export failed" in str(error)
        assert "/path/to/output.html" in str(error)
        assert error.output_path == "/path/to/output.html"

    def test_export_error_inheritance(self):
        """Test export error inherits from base."""
        error = DataExportError("Test")
        assert isinstance(error, KMLHeatmapError)


class TestInvalidAltitudeError:
    """Tests for InvalidAltitudeError exception."""

    def test_simple_altitude_error(self):
        """Test altitude error with just message."""
        error = InvalidAltitudeError("Invalid altitude")
        assert "Invalid altitude" in str(error)

    def test_altitude_error_with_value(self):
        """Test altitude error with altitude value."""
        error = InvalidAltitudeError("Invalid altitude", altitude=99999.0)
        assert "Invalid altitude" in str(error)
        assert "99999" in str(error)
        assert error.altitude == 99999.0

    def test_altitude_error_with_zero(self):
        """Test altitude error with zero altitude."""
        error = InvalidAltitudeError("Invalid altitude", altitude=0.0)
        assert "Invalid altitude" in str(error)
        # Should include altitude in message since it's not None
        assert "0" in str(error)

    def test_altitude_error_inheritance(self):
        """Test altitude error inherits from base."""
        error = InvalidAltitudeError("Test")
        assert isinstance(error, KMLHeatmapError)


class TestConfigurationError:
    """Tests for ConfigurationError exception."""

    def test_simple_config_error(self):
        """Test config error with just message."""
        error = ConfigurationError("Invalid config")
        assert "Invalid config" in str(error)

    def test_config_error_with_key(self):
        """Test config error with config key."""
        error = ConfigurationError("Invalid config", config_key="api_key")
        assert "Invalid config" in str(error)
        assert "api_key" in str(error)
        assert error.config_key == "api_key"

    def test_config_error_inheritance(self):
        """Test config error inherits from base."""
        error = ConfigurationError("Test")
        assert isinstance(error, KMLHeatmapError)


class TestExceptionHierarchy:
    """Tests for exception inheritance hierarchy."""

    def test_all_inherit_from_base(self):
        """Test all custom exceptions inherit from base."""
        exceptions = [
            KMLParseError("test"),
            AircraftLookupError("test"),
            InvalidCoordinateError("test"),
            DataExportError("test"),
            InvalidAltitudeError("test"),
            ConfigurationError("test"),
        ]
        for exc in exceptions:
            assert isinstance(exc, KMLHeatmapError)
            assert isinstance(exc, Exception)

    def test_base_inherits_from_exception(self):
        """Test base exception inherits from Exception."""
        error = KMLHeatmapError("test")
        assert isinstance(error, Exception)
