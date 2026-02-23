"""Tests for validation module."""

import tempfile
import os
from kml_heatmap.validation import (
    validate_kml_file,
    validate_api_keys,
    validate_coordinates,
    validate_altitude,
)


class TestValidateKmlFile:
    """Tests for validate_kml_file function."""

    def test_valid_kml_file(self):
        """Test validation of valid KML file."""
        with tempfile.NamedTemporaryFile(suffix=".kml", delete=False, mode="w") as f:
            f.write('<?xml version="1.0" encoding="UTF-8"?>')
            f.write('<kml xmlns="http://www.opengis.net/kml/2.2">')
            f.write("<Document></Document></kml>")
            temp_path = f.name

        try:
            is_valid, error_msg = validate_kml_file(temp_path)
            assert is_valid is True
            assert error_msg is None
        finally:
            os.unlink(temp_path)

    def test_nonexistent_file(self):
        """Test validation of nonexistent file."""
        is_valid, error_msg = validate_kml_file("/nonexistent/file.kml")
        assert is_valid is False
        assert error_msg is not None

    def test_non_kml_extension(self):
        """Test validation of file without .kml extension."""
        with tempfile.NamedTemporaryFile(suffix=".txt", delete=False) as f:
            temp_path = f.name

        try:
            is_valid, error_msg = validate_kml_file(temp_path)
            assert is_valid is False
            assert error_msg is not None
            assert ".kml" in error_msg
        finally:
            os.unlink(temp_path)

    def test_empty_file(self):
        """Test validation of empty file."""
        with tempfile.NamedTemporaryFile(suffix=".kml", delete=False) as f:
            temp_path = f.name

        try:
            is_valid, error_msg = validate_kml_file(temp_path)
            assert is_valid is False
            assert error_msg is not None
            assert "empty" in error_msg.lower()
        finally:
            os.unlink(temp_path)

    def test_directory_instead_of_file(self):
        """Test validation with directory path."""
        with tempfile.TemporaryDirectory() as temp_dir:
            is_valid, error_msg = validate_kml_file(temp_dir)
            assert is_valid is False
            assert error_msg is not None


class TestValidateApiKeys:
    """Tests for validate_api_keys function."""

    def test_both_keys_provided(self):
        """Test with both API keys."""
        result = validate_api_keys("stadia_key_123", "openaip_key_456", verbose=False)
        assert isinstance(result, dict)
        assert "stadia" in result
        assert "openaip" in result

    def test_no_keys_provided(self):
        """Test with no API keys."""
        result = validate_api_keys("", "", verbose=False)
        assert isinstance(result, dict)

    def test_only_stadia_key(self):
        """Test with only Stadia key."""
        result = validate_api_keys("stadia_key_123", "", verbose=False)
        assert isinstance(result, dict)
        assert result.get("stadia") is True

    def test_only_openaip_key(self):
        """Test with only OpenAIP key."""
        result = validate_api_keys("", "openaip_key_456", verbose=False)
        assert isinstance(result, dict)
        assert result.get("openaip") is True

    def test_none_keys(self):
        """Test with None keys."""
        result = validate_api_keys(None, None, verbose=False)
        assert isinstance(result, dict)

    def test_verbose_warnings_no_stadia(self, caplog):
        """Test verbose warnings when Stadia key is missing."""
        with caplog.at_level("WARNING"):
            validate_api_keys("", "openaip_key", verbose=True)
        assert "STADIA_API_KEY" in caplog.text
        assert "stadiamaps.com" in caplog.text

    def test_verbose_warnings_no_openaip(self, caplog):
        """Test verbose warnings when OpenAIP key is missing."""
        with caplog.at_level("WARNING"):
            validate_api_keys("stadia_key", "", verbose=True)
        assert "OPENAIP_API_KEY" in caplog.text
        assert "openaip.net" in caplog.text

    def test_verbose_warnings_both_missing(self, caplog):
        """Test verbose warnings when both keys are missing."""
        with caplog.at_level("WARNING"):
            validate_api_keys("", "", verbose=True)
        assert "STADIA_API_KEY" in caplog.text
        assert "OPENAIP_API_KEY" in caplog.text


class TestValidateCoordinates:
    """Tests for validate_coordinates function."""

    def test_valid_coordinates(self):
        """Test valid coordinates."""
        is_valid, error = validate_coordinates(50.0, 8.5)
        assert is_valid is True
        assert error is None

    def test_invalid_latitude_type(self):
        """Test invalid latitude type."""
        is_valid, error = validate_coordinates("not_a_number", 8.5)
        assert is_valid is False
        assert "must be a number" in error

    def test_invalid_longitude_type(self):
        """Test invalid longitude type."""
        is_valid, error = validate_coordinates(50.0, "not_a_number")
        assert is_valid is False
        assert "must be a number" in error

    def test_latitude_too_low(self):
        """Test latitude below minimum."""
        is_valid, error = validate_coordinates(-100.0, 8.5)
        assert is_valid is False
        assert "out of bounds" in error
        assert "-90 to 90" in error

    def test_latitude_too_high(self):
        """Test latitude above maximum."""
        is_valid, error = validate_coordinates(100.0, 8.5)
        assert is_valid is False
        assert "out of bounds" in error

    def test_longitude_too_low(self):
        """Test longitude below minimum."""
        is_valid, error = validate_coordinates(50.0, -200.0)
        assert is_valid is False
        assert "out of bounds" in error
        assert "-180 to 180" in error

    def test_longitude_too_high(self):
        """Test longitude above maximum."""
        is_valid, error = validate_coordinates(50.0, 200.0)
        assert is_valid is False
        assert "out of bounds" in error

    def test_boundary_values(self):
        """Test boundary coordinate values."""
        # Min latitude
        is_valid, _ = validate_coordinates(-90.0, 0.0)
        assert is_valid is True

        # Max latitude
        is_valid, _ = validate_coordinates(90.0, 0.0)
        assert is_valid is True

        # Min longitude
        is_valid, _ = validate_coordinates(0.0, -180.0)
        assert is_valid is True

        # Max longitude
        is_valid, _ = validate_coordinates(0.0, 180.0)
        assert is_valid is True

    def test_context_message(self):
        """Test that context is included in error message."""
        is_valid, error = validate_coordinates(999.0, 8.5, context=" in file test.kml")
        assert is_valid is False
        assert "in file test.kml" in error


class TestValidateAltitude:
    """Tests for validate_altitude function."""

    def test_valid_altitude(self):
        """Test valid altitude."""
        is_valid, error = validate_altitude(1000.0)
        assert is_valid is True
        assert error is None

    def test_invalid_altitude_type(self):
        """Test invalid altitude type."""
        is_valid, error = validate_altitude("not_a_number")
        assert is_valid is False
        assert "must be a number" in error

    def test_altitude_too_low(self):
        """Test altitude below minimum."""
        is_valid, error = validate_altitude(-600.0)
        assert is_valid is False
        assert "unrealistic" in error
        assert "-500" in error

    def test_altitude_too_high(self):
        """Test altitude above maximum."""
        is_valid, error = validate_altitude(20000.0)
        assert is_valid is False
        assert "unrealistic" in error
        assert "15000" in error

    def test_boundary_values(self):
        """Test boundary altitude values."""
        # Min altitude
        is_valid, _ = validate_altitude(-500)
        assert is_valid is True

        # Max altitude
        is_valid, _ = validate_altitude(15000)
        assert is_valid is True

    def test_zero_altitude(self):
        """Test zero altitude (sea level)."""
        is_valid, error = validate_altitude(0.0)
        assert is_valid is True
        assert error is None

    def test_negative_valid_altitude(self):
        """Test negative but valid altitude (below sea level)."""
        is_valid, error = validate_altitude(-400.0)
        assert is_valid is True
        assert error is None

    def test_context_message(self):
        """Test that context is included in error message."""
        is_valid, error = validate_altitude(99999.0, context=" at coordinate 123")
        assert is_valid is False
        assert "at coordinate 123" in error
