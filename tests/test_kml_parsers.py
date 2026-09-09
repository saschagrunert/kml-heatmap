"""Tests for kml_parsers module."""

import pytest

from kml_heatmap.constants import ALT_MAX_M, ALT_MIN_M
from kml_heatmap.kml_parsers import validate_and_normalize_coordinate


class TestValidateAndNormalizeCoordinate:
    def test_valid_coordinate(self):
        assert validate_and_normalize_coordinate(50.0, 8.5, 300, "test.kml") == (
            50.0,
            8.5,
            300.0,
        )

    def test_negative_altitude_is_kept(self):
        result = validate_and_normalize_coordinate(50.0, 8.5, -100, "test.kml")
        assert result == (50.0, 8.5, -100)

    def test_altitude_range_boundaries_kept(self):
        assert (
            validate_and_normalize_coordinate(50.0, 8.5, ALT_MIN_M, "f")[2] == ALT_MIN_M
        )
        assert (
            validate_and_normalize_coordinate(50.0, 8.5, ALT_MAX_M, "f")[2] == ALT_MAX_M
        )

    @pytest.mark.parametrize(
        "alt", [999999, -99999, float("nan"), float("inf"), float("-inf")]
    )
    def test_out_of_range_or_non_finite_altitude_becomes_none(self, alt):
        result = validate_and_normalize_coordinate(50.0, 8.5, alt, "test.kml")
        assert result == (50.0, 8.5, None)

    def test_none_altitude_preserved(self):
        assert validate_and_normalize_coordinate(50.0, 8.5, None, "test.kml") == (
            50.0,
            8.5,
            None,
        )

    def test_zero_altitude(self):
        assert validate_and_normalize_coordinate(50.0, 8.5, 0, "test.kml") == (
            50.0,
            8.5,
            0,
        )

    @pytest.mark.parametrize(
        "lat,lon",
        [(-90.0, 0.0), (90.0, 0.0), (0.0, -180.0), (0.0, 180.0)],
        ids=["min-lat", "max-lat", "min-lon", "max-lon"],
    )
    def test_valid_range_boundaries(self, lat, lon):
        assert validate_and_normalize_coordinate(lat, lon, 0, "test.kml") is not None

    @pytest.mark.parametrize(
        "lat,lon",
        [
            (100.0, 8.5),
            (-100.0, 8.5),
            (50.0, 200.0),
            (50.0, -200.0),
            (float("nan"), 8.5),
            (50.0, float("inf")),
        ],
    )
    def test_invalid_lat_lon_returns_none(self, lat, lon):
        assert validate_and_normalize_coordinate(lat, lon, 300, "test.kml") is None
