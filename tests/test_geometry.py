"""Tests for geometry module."""

import pytest

from kml_heatmap.geometry import (
    EARTH_RADIUS_KM,
    haversine_distance,
)


class TestHaversineDistance:
    """Tests for haversine_distance function."""

    def test_zero_distance(self):
        """Test distance between same point is zero."""
        assert haversine_distance(0, 0, 0, 0) == pytest.approx(0, abs=0.01)

    def test_equator_distance(self):
        """Test distance along equator."""
        # 1 degree longitude at equator ≈ 111.32 km
        dist = haversine_distance(0, 0, 0, 1)
        assert dist == pytest.approx(111.32, abs=1)

    def test_new_york_to_london(self):
        """Test distance from New York to London."""
        # Known distance ~5570 km
        dist = haversine_distance(40.7128, -74.0060, 51.5074, -0.1278)
        assert dist == pytest.approx(5570, abs=10)

    def test_antipodal_points(self):
        """Test distance between antipodal points (opposite sides of Earth)."""
        # Distance should be approximately half Earth's circumference
        dist = haversine_distance(0, 0, 0, 180)
        expected = EARTH_RADIUS_KM * 3.14159  # Half circumference
        assert dist == pytest.approx(expected, abs=10)

    def test_negative_coordinates(self):
        """Test with negative latitude/longitude."""
        dist = haversine_distance(
            -33.8688, 151.2093, -34.6037, -58.3816
        )  # Sydney to Buenos Aires
        assert dist > 0
