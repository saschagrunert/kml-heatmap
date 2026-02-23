"""Tests for kml_parsers module."""

from kml_heatmap.kml_parsers import validate_and_normalize_coordinate


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

    def test_invalid_latitude_too_high(self):
        """Test latitude above valid range."""
        assert validate_and_normalize_coordinate(100.0, 8.5, 300, "test.kml") is None

    def test_invalid_latitude_too_low(self):
        """Test latitude below valid range."""
        assert validate_and_normalize_coordinate(-100.0, 8.5, 300, "test.kml") is None

    def test_invalid_longitude_too_high(self):
        """Test longitude above valid range."""
        assert validate_and_normalize_coordinate(50.0, 200.0, 300, "test.kml") is None

    def test_invalid_longitude_too_low(self):
        """Test longitude below valid range."""
        assert validate_and_normalize_coordinate(50.0, -200.0, 300, "test.kml") is None

    def test_zero_altitude(self):
        """Test zero altitude is valid."""
        result = validate_and_normalize_coordinate(50.0, 8.5, 0, "test.kml")
        assert result is not None
        assert result == (50.0, 8.5, 0)
