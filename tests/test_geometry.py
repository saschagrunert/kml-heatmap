"""Tests for geometry module."""

import pytest
from kml_heatmap.geometry import (
    haversine_distance,
    get_altitude_color,
    EARTH_RADIUS_KM,
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


class TestGetAltitudeColor:
    """Tests for get_altitude_color function."""

    def test_minimum_altitude(self):
        """Test color at minimum altitude."""
        color = get_altitude_color(0, 0, 1000)
        assert color.startswith("#")
        assert len(color) == 7
        # Should be blueish (low red component)
        assert color[1:3] == "00"  # Red component should be 00

    def test_maximum_altitude(self):
        """Test color at maximum altitude."""
        color = get_altitude_color(1000, 0, 1000)
        assert color.startswith("#")
        # Should be reddish (high red component)
        assert color[1:3] == "ff"  # Red component should be ff

    def test_mid_altitude(self):
        """Test color at mid-range altitude."""
        color = get_altitude_color(500, 0, 1000)
        assert color.startswith("#")
        assert len(color) == 7
        # Should be greenish/yellowish

    def test_same_altitude_range(self):
        """Test when min and max altitude are the same."""
        color = get_altitude_color(500, 500, 500)
        assert color == "#00AA88"  # Teal color for flat altitude

    def test_altitude_below_min(self):
        """Test altitude below minimum (should clamp to 0)."""
        color1 = get_altitude_color(0, 0, 1000)
        color2 = get_altitude_color(-100, 0, 1000)
        # Both should produce valid colors
        assert color1.startswith("#")
        assert color2.startswith("#")

    def test_altitude_above_max(self):
        """Test altitude above maximum."""
        color = get_altitude_color(2000, 0, 1000)
        assert color.startswith("#")
        # Should still be red (clamped to max)

    def test_hex_format(self):
        """Test that output is valid hex color."""
        color = get_altitude_color(500, 0, 1000)
        assert len(color) == 7
        assert color[0] == "#"
        # Check all characters are valid hex
        for char in color[1:]:
            assert char in "0123456789abcdef"

    def test_gradient_progression(self):
        """Test that color changes progressively with altitude."""
        colors = [get_altitude_color(i * 100, 0, 1000) for i in range(11)]
        # All colors should be different (monotonic progression)
        unique_colors = set(colors)
        assert len(unique_colors) >= 5  # At least 5 distinct colors in gradient
