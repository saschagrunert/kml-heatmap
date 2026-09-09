"""Tests for geometry module."""

import math

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from kml_heatmap.geometry import (
    EARTH_RADIUS_KM,
    extract_altitudes,
    haversine_distance,
)
from kml_heatmap.types import TrackPoint

latitudes = st.floats(min_value=-90.0, max_value=90.0)
longitudes = st.floats(min_value=-180.0, max_value=180.0)


class TestHaversineDistance:
    def test_zero_distance(self):
        assert haversine_distance(0, 0, 0, 0) == pytest.approx(0, abs=0.01)

    def test_equator_distance(self):
        assert haversine_distance(0, 0, 0, 1) == pytest.approx(111.32, abs=1)

    def test_new_york_to_london(self):
        dist = haversine_distance(40.7128, -74.0060, 51.5074, -0.1278)
        assert dist == pytest.approx(5570, abs=10)

    def test_antipodal_points(self):
        dist = haversine_distance(0, 0, 0, 180)
        assert dist == pytest.approx(EARTH_RADIUS_KM * math.pi, abs=0.01)

    def test_negative_coordinates(self):
        dist = haversine_distance(-33.8688, 151.2093, -34.6037, -58.3816)
        assert dist == pytest.approx(11800, abs=100)

    def test_identical_points(self):
        assert haversine_distance(48.8566, 2.3522, 48.8566, 2.3522) == pytest.approx(
            0, abs=0.01
        )

    def test_very_small_distance(self):
        dist = haversine_distance(0.0, 0.0, 0.0001, 0.0001)
        assert 0 < dist < 0.02

    def test_poles(self):
        assert haversine_distance(90, 0, 90, 180) == pytest.approx(0, abs=0.01)
        assert haversine_distance(-90, 0, -90, 45) == pytest.approx(0, abs=0.01)


class TestHaversineProperties:
    @given(latitudes, longitudes, latitudes, longitudes)
    def test_symmetry(self, lat1, lon1, lat2, lon2):
        d1 = haversine_distance(lat1, lon1, lat2, lon2)
        d2 = haversine_distance(lat2, lon2, lat1, lon1)
        assert d1 == pytest.approx(d2, abs=1e-6)

    @given(latitudes, longitudes, latitudes, longitudes)
    def test_non_negative_and_bounded(self, lat1, lon1, lat2, lon2):
        d = haversine_distance(lat1, lon1, lat2, lon2)
        assert 0.0 <= d <= math.pi * EARTH_RADIUS_KM + 1e-6

    @given(latitudes, longitudes)
    def test_identity(self, lat, lon):
        assert haversine_distance(lat, lon, lat, lon) == pytest.approx(0.0, abs=1e-6)

    @settings(max_examples=200)
    @given(latitudes, longitudes, latitudes, longitudes, latitudes, longitudes)
    def test_triangle_inequality(self, lat1, lon1, lat2, lon2, lat3, lon3):
        direct = haversine_distance(lat1, lon1, lat3, lon3)
        via = haversine_distance(lat1, lon1, lat2, lon2) + haversine_distance(
            lat2, lon2, lat3, lon3
        )
        assert direct <= via + 1e-6


class TestExtractAltitudes:
    def test_basic_extraction(self):
        paths = [
            [TrackPoint(0, 0, 100), TrackPoint(0, 0, 200)],
            [TrackPoint(0, 0, 300)],
        ]
        assert extract_altitudes(paths) == [100, 200, 300]

    def test_empty_paths(self):
        assert extract_altitudes([]) == []
        assert extract_altitudes([[], []]) == []

    def test_points_without_altitude_skipped(self):
        paths = [[TrackPoint(0, 0, None), TrackPoint(0, 0, 500), TrackPoint(0, 0)]]
        assert extract_altitudes(paths) == [500]

    def test_zero_and_negative_altitude_included(self):
        paths = [[TrackPoint(0, 0, 0), TrackPoint(0, 0, -50)]]
        assert extract_altitudes(paths) == [0, -50]
