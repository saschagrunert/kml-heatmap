"""Tests for geometry module."""

import math

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from kml_heatmap.geometry import (
    EARTH_RADIUS_KM,
    haversine_distance,
    longitude_difference,
    true_bearing,
)

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
        # Relative slack: near antipodal points the rounding error of a
        # 20,000 km distance is about 1e-5 km, more than any absolute epsilon
        assert direct <= via * (1 + 1e-9) + 1e-6


class TestLongitudeDifference:
    def test_the_short_way_round(self):
        assert longitude_difference(8.0, 9.5) == pytest.approx(1.5)
        assert longitude_difference(9.5, 8.0) == pytest.approx(-1.5)
        assert longitude_difference(179.5, -179.5) == pytest.approx(1.0)
        assert longitude_difference(-179.5, 179.5) == pytest.approx(-1.0)

    @given(longitudes, longitudes)
    def test_bounded(self, lon0, lon1):
        assert -180.0 <= longitude_difference(lon0, lon1) < 180.0


class TestTrueBearing:
    def test_the_points_of_the_compass(self):
        assert true_bearing(50.0, 8.0, 50.1, 8.0) == pytest.approx(0.0)
        assert true_bearing(50.0, 8.0, 50.0, 8.1) == pytest.approx(90.0)
        assert true_bearing(50.0, 8.0, 49.9, 8.0) == pytest.approx(180.0)
        assert true_bearing(50.0, 8.0, 50.0, 7.9) == pytest.approx(270.0)

    def test_across_the_antimeridian(self):
        assert true_bearing(-16.7, 179.99, -16.7, -179.99) == pytest.approx(90.0)
        assert true_bearing(-16.7, -179.99, -16.7, 179.99) == pytest.approx(270.0)

    def test_a_runway_is_narrower_eastward_further_north(self):
        """A degree of longitude is half as long at 60 degrees."""
        assert true_bearing(60.0, 8.0, 60.01, 8.02) == pytest.approx(45.0, abs=0.1)
