"""Tests for geometry module."""

import pytest

from kml_heatmap.geometry import (
    EARTH_RADIUS_KM,
    extract_altitudes,
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


class TestHaversineDistanceEdgeCases:
    """Edge case tests for haversine_distance."""

    def test_identical_points(self):
        """Test distance between identical non-origin points is zero."""
        assert haversine_distance(48.8566, 2.3522, 48.8566, 2.3522) == pytest.approx(
            0, abs=0.01
        )

    def test_very_small_distance(self):
        """Test distance for nearby points (floating-point precision)."""
        dist = haversine_distance(0.0, 0.0, 0.0001, 0.0001)
        assert dist > 0
        assert dist < 0.02

    def test_north_pole(self):
        """Test distance involving the North Pole."""
        dist = haversine_distance(90, 0, 90, 180)
        assert dist == pytest.approx(0, abs=0.01)

    def test_south_pole(self):
        """Test distance involving the South Pole."""
        dist = haversine_distance(-90, 0, -90, 45)
        assert dist == pytest.approx(0, abs=0.01)

    def test_symmetry(self):
        """Test that distance is symmetric."""
        d1 = haversine_distance(40.0, -74.0, 51.5, -0.1)
        d2 = haversine_distance(51.5, -0.1, 40.0, -74.0)
        assert d1 == pytest.approx(d2, abs=0.01)


class TestExtractAltitudes:
    """Tests for extract_altitudes function."""

    def test_basic_extraction(self):
        """Test extracting altitudes from paths with altitude data."""
        paths = [[[0, 0, 100], [0, 0, 200]], [[0, 0, 300]]]
        result = extract_altitudes(paths)
        assert result == [100, 200, 300]

    def test_empty_paths(self):
        """Test with empty path list."""
        assert extract_altitudes([]) == []

    def test_empty_inner_paths(self):
        """Test with paths that contain no coordinates."""
        assert extract_altitudes([[], []]) == []

    def test_2d_coordinates_skipped(self):
        """Test that 2D coordinates (no altitude) are skipped."""
        paths = [[[0, 0], [0, 0, 500], [0, 0]]]
        result = extract_altitudes(paths)
        assert result == [500]

    def test_zero_altitude(self):
        """Test that zero altitude is included."""
        paths = [[[0, 0, 0]]]
        result = extract_altitudes(paths)
        assert result == [0]

    def test_negative_altitude(self):
        """Test with negative altitude (below sea level)."""
        paths = [[[0, 0, -50], [0, 0, 100]]]
        result = extract_altitudes(paths)
        assert result == [-50, 100]
