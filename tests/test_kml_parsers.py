"""Tests for kml_parsers module."""

import pytest

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
        _lat, _lon, alt = result
        assert alt == 0.0

    def test_invalid_returns_none(self):
        """Test invalid coordinates return None."""
        result = validate_and_normalize_coordinate(999.0, 8.5, 300, "test.kml")
        assert result is None

    def test_none_altitude_preserved(self):
        """Test None altitude is preserved."""
        result = validate_and_normalize_coordinate(50.0, 8.5, None, "test.kml")
        assert result is not None
        _lat, _lon, alt = result
        assert alt is None

    @pytest.mark.parametrize(
        "lat,lon",
        [(-90.0, 0.0), (90.0, 0.0), (0.0, -180.0), (0.0, 180.0)],
        ids=["min-lat", "max-lat", "min-lon", "max-lon"],
    )
    def test_valid_range_boundaries(self, lat, lon):
        """Test coordinates at valid range boundaries."""
        result = validate_and_normalize_coordinate(lat, lon, 0, "test.kml")
        assert result is not None

    def test_extreme_altitude_out_of_range(self):
        """Test that extreme altitude values get normalized to 0."""
        # Altitude way too high (above valid range)
        result = validate_and_normalize_coordinate(50.0, 8.5, 999999, "test.kml")
        assert result is not None
        _lat, _lon, alt = result
        assert alt == 0.0

        # Altitude way too low (below valid range)
        result = validate_and_normalize_coordinate(50.0, 8.5, -99999, "test.kml")
        assert result is not None
        _lat, _lon, alt = result
        assert alt == 0.0

    @pytest.mark.parametrize(
        "lat,lon",
        [
            (100.0, 8.5),
            (-100.0, 8.5),
            (50.0, 200.0),
            (50.0, -200.0),
        ],
        ids=["lat-too-high", "lat-too-low", "lon-too-high", "lon-too-low"],
    )
    def test_invalid_lat_lon_returns_none(self, lat, lon):
        """Test out-of-range lat/lon returns None."""
        assert validate_and_normalize_coordinate(lat, lon, 300, "test.kml") is None

    def test_zero_altitude(self):
        """Test zero altitude is valid."""
        result = validate_and_normalize_coordinate(50.0, 8.5, 0, "test.kml")
        assert result is not None
        assert result == (50.0, 8.5, 0)
