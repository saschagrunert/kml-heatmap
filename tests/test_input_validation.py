"""Tests for input_validation module."""

import pytest
import tempfile
from kml_heatmap.input_validation import (
    validate_latitude,
    validate_longitude,
    validate_altitude,
    validate_coordinate_pair,
    validate_path_exists,
    validate_non_empty,
    validate_positive,
    validate_in_range,
    validate_type,
    ValidationContext,
)
from kml_heatmap.exceptions import (
    InvalidCoordinateError,
    InvalidAltitudeError,
    ConfigurationError,
)


class TestValidateLatitude:
    """Tests for validate_latitude function."""

    def test_valid_latitude(self):
        """Test valid latitude values."""
        validate_latitude(0.0)
        validate_latitude(90.0)
        validate_latitude(-90.0)
        validate_latitude(50.5)

    def test_invalid_latitude_type(self):
        """Test non-numeric latitude."""
        with pytest.raises(InvalidCoordinateError, match="must be numeric"):
            validate_latitude("50.0")

    def test_latitude_too_high(self):
        """Test latitude above maximum."""
        with pytest.raises(InvalidCoordinateError, match="out of range"):
            validate_latitude(91.0)

    def test_latitude_too_low(self):
        """Test latitude below minimum."""
        with pytest.raises(InvalidCoordinateError, match="out of range"):
            validate_latitude(-91.0)

    def test_latitude_with_context(self):
        """Test latitude validation with context."""
        with pytest.raises(InvalidCoordinateError, match="in file test.kml"):
            validate_latitude(91.0, context=" in file test.kml")


class TestValidateLongitude:
    """Tests for validate_longitude function."""

    def test_valid_longitude(self):
        """Test valid longitude values."""
        validate_longitude(0.0)
        validate_longitude(180.0)
        validate_longitude(-180.0)
        validate_longitude(8.5)

    def test_invalid_longitude_type(self):
        """Test non-numeric longitude."""
        with pytest.raises(InvalidCoordinateError, match="must be numeric"):
            validate_longitude("8.5")

    def test_longitude_too_high(self):
        """Test longitude above maximum."""
        with pytest.raises(InvalidCoordinateError, match="out of range"):
            validate_longitude(181.0)

    def test_longitude_too_low(self):
        """Test longitude below minimum."""
        with pytest.raises(InvalidCoordinateError, match="out of range"):
            validate_longitude(-181.0)


class TestValidateAltitude:
    """Tests for validate_altitude function."""

    def test_valid_altitude(self):
        """Test valid altitude values."""
        validate_altitude(0.0)
        validate_altitude(1000.0)
        validate_altitude(-100.0)

    def test_invalid_altitude_type(self):
        """Test non-numeric altitude."""
        with pytest.raises(InvalidAltitudeError, match="must be numeric"):
            validate_altitude("1000")

    def test_altitude_too_high(self):
        """Test altitude above maximum."""
        with pytest.raises(InvalidAltitudeError, match="out of range"):
            validate_altitude(60000.0)

    def test_altitude_too_low(self):
        """Test altitude below minimum."""
        with pytest.raises(InvalidAltitudeError, match="out of range"):
            validate_altitude(-1500.0)


class TestValidateCoordinatePair:
    """Tests for validate_coordinate_pair function."""

    def test_valid_coordinate_pair(self):
        """Test valid coordinate pair."""
        validate_coordinate_pair(50.0, 8.5)

    def test_invalid_latitude_in_pair(self):
        """Test coordinate pair with invalid latitude."""
        with pytest.raises(InvalidCoordinateError):
            validate_coordinate_pair(91.0, 8.5)

    def test_invalid_longitude_in_pair(self):
        """Test coordinate pair with invalid longitude."""
        with pytest.raises(InvalidCoordinateError):
            validate_coordinate_pair(50.0, 181.0)


class TestValidatePathExists:
    """Tests for validate_path_exists function."""

    def test_valid_file_path(self):
        """Test validation with existing file."""
        with tempfile.NamedTemporaryFile() as f:
            validate_path_exists(f.name)

    def test_valid_directory_path(self):
        """Test validation with existing directory."""
        with tempfile.TemporaryDirectory() as tmpdir:
            validate_path_exists(tmpdir, must_be_file=False)

    def test_nonexistent_path(self):
        """Test validation with nonexistent path."""
        with pytest.raises(ConfigurationError, match="does not exist"):
            validate_path_exists("/nonexistent/path.txt")

    def test_directory_when_file_required(self):
        """Test validation when directory provided but file required."""
        with tempfile.TemporaryDirectory() as tmpdir:
            with pytest.raises(ConfigurationError, match="not a file"):
                validate_path_exists(tmpdir, must_be_file=True)

    def test_file_when_directory_required(self):
        """Test validation when file provided but directory required."""
        with tempfile.NamedTemporaryFile() as f:
            with pytest.raises(ConfigurationError, match="not a directory"):
                validate_path_exists(f.name, must_be_file=False)


class TestValidateNonEmpty:
    """Tests for validate_non_empty function."""

    def test_non_empty_list(self):
        """Test non-empty list."""
        validate_non_empty([1, 2, 3])

    def test_empty_list(self):
        """Test empty list."""
        with pytest.raises(ConfigurationError, match="cannot be empty"):
            validate_non_empty([])

    def test_non_empty_dict(self):
        """Test non-empty dict."""
        validate_non_empty({"key": "value"})

    def test_empty_dict(self):
        """Test empty dict."""
        with pytest.raises(ConfigurationError, match="cannot be empty"):
            validate_non_empty({})

    def test_non_empty_string(self):
        """Test non-empty string."""
        validate_non_empty("test")

    def test_empty_string(self):
        """Test empty string."""
        with pytest.raises(ConfigurationError, match="cannot be empty"):
            validate_non_empty("")

    def test_custom_name(self):
        """Test error message with custom name."""
        with pytest.raises(ConfigurationError, match="coordinates cannot be empty"):
            validate_non_empty([], name="coordinates")


class TestValidatePositive:
    """Tests for validate_positive function."""

    def test_positive_integer(self):
        """Test positive integer."""
        validate_positive(5)

    def test_positive_float(self):
        """Test positive float."""
        validate_positive(5.5)

    def test_zero(self):
        """Test zero (not positive)."""
        with pytest.raises(ConfigurationError, match="must be positive"):
            validate_positive(0)

    def test_negative(self):
        """Test negative number."""
        with pytest.raises(ConfigurationError, match="must be positive"):
            validate_positive(-5)

    def test_custom_name(self):
        """Test error message with custom name."""
        with pytest.raises(ConfigurationError, match="count must be positive"):
            validate_positive(0, name="count")


class TestValidateInRange:
    """Tests for validate_in_range function."""

    def test_value_in_range(self):
        """Test value within range."""
        validate_in_range(5, 0, 10)

    def test_value_at_min(self):
        """Test value at minimum."""
        validate_in_range(0, 0, 10)

    def test_value_at_max(self):
        """Test value at maximum."""
        validate_in_range(10, 0, 10)

    def test_value_below_min(self):
        """Test value below minimum."""
        with pytest.raises(ConfigurationError, match="must be in range"):
            validate_in_range(-1, 0, 10)

    def test_value_above_max(self):
        """Test value above maximum."""
        with pytest.raises(ConfigurationError, match="must be in range"):
            validate_in_range(11, 0, 10)

    def test_custom_name(self):
        """Test error message with custom name."""
        with pytest.raises(ConfigurationError, match="zoom must be in range"):
            validate_in_range(15, 0, 10, name="zoom")


class TestValidateType:
    """Tests for validate_type function."""

    def test_correct_type_string(self):
        """Test string with string type."""
        validate_type("test", str)

    def test_correct_type_int(self):
        """Test int with int type."""
        validate_type(5, int)

    def test_correct_type_list(self):
        """Test list with list type."""
        validate_type([1, 2, 3], list)

    def test_incorrect_type(self):
        """Test value with wrong type."""
        with pytest.raises(ConfigurationError, match="must be str, got int"):
            validate_type(5, str)

    def test_custom_name(self):
        """Test error message with custom name."""
        with pytest.raises(ConfigurationError, match="filename must be str"):
            validate_type(123, str, name="filename")


class TestValidationContext:
    """Tests for ValidationContext class."""

    def test_context_no_errors(self):
        """Test context with no validation errors."""
        with ValidationContext("Test operation"):
            pass  # No errors

    def test_context_single_error(self):
        """Test context with single validation error."""
        with pytest.raises(ConfigurationError, match="Test operation failed"):
            with ValidationContext("Test operation") as ctx:
                ctx.validate(91.0, validate_latitude, "latitude")

    def test_context_multiple_errors(self):
        """Test context collecting multiple errors."""
        with pytest.raises(ConfigurationError, match="Test operation failed"):
            with ValidationContext("Test operation") as ctx:
                ctx.validate(91.0, validate_latitude, "latitude")
                ctx.validate(181.0, validate_longitude, "longitude")

    def test_context_collects_error_messages(self):
        """Test that context collects error messages."""
        with pytest.raises(ConfigurationError) as exc_info:
            with ValidationContext("Processing coordinates") as ctx:
                ctx.validate(91.0, validate_latitude, "lat")
                ctx.validate(181.0, validate_longitude, "lon")

        error_msg = str(exc_info.value)
        assert "Processing coordinates failed" in error_msg
        assert "lat" in error_msg
        assert "lon" in error_msg

    def test_context_with_valid_values(self):
        """Test context with all valid values."""
        with ValidationContext("Test operation") as ctx:
            ctx.validate(50.0, validate_latitude, "latitude")
            ctx.validate(8.5, validate_longitude, "longitude")
        # Should not raise

    def test_context_mixed_valid_invalid(self):
        """Test context with mix of valid and invalid values."""
        with pytest.raises(ConfigurationError):
            with ValidationContext("Test operation") as ctx:
                ctx.validate(50.0, validate_latitude, "valid_lat")
                ctx.validate(91.0, validate_latitude, "invalid_lat")
