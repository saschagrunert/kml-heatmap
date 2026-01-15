"""Tests for geometry module."""

import pytest
from kml_heatmap.geometry import (
    haversine_distance,
    downsample_path_rdp,
    downsample_coordinates,
    get_altitude_color,
    calculate_adaptive_epsilon,
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


class TestDownsamplePathRdp:
    """Tests for downsample_path_rdp function."""

    def test_empty_path(self):
        """Test with empty path."""
        result = downsample_path_rdp([])
        assert result == []

    def test_single_point(self):
        """Test with single point."""
        path = [[0, 0, 100]]
        result = downsample_path_rdp(path)
        assert result == path

    def test_two_points(self):
        """Test with two points (minimum for a line)."""
        path = [[0, 0, 100], [1, 1, 200]]
        result = downsample_path_rdp(path)
        assert result == path

    def test_straight_line_simplification(self):
        """Test simplification of straight line removes middle points."""
        # Perfectly straight line - middle points should be removed
        path = [[0, 0, 100], [1, 1, 100], [2, 2, 100], [3, 3, 100]]
        result = downsample_path_rdp(path, epsilon=0.0001)
        # Should keep only start and end points
        assert len(result) == 2
        assert result[0] == [0, 0, 100]
        assert result[-1] == [3, 3, 100]

    def test_zigzag_preservation(self):
        """Test that significant deviations are preserved."""
        # Zigzag pattern
        path = [[0, 0, 100], [1, 0, 100], [1, 1, 100], [2, 1, 100]]
        result = downsample_path_rdp(path, epsilon=0.0001)
        # All points should be kept due to direction changes
        assert len(result) >= 3

    def test_four_element_coordinates(self):
        """Test with 4-element coordinates (lat, lon, alt, timestamp)."""
        path = [
            [0, 0, 100, "2025-01-01T00:00:00Z"],
            [1, 1, 200, "2025-01-01T01:00:00Z"],
        ]
        result = downsample_path_rdp(path)
        assert len(result) == 2
        assert len(result[0]) == 4

    def test_circular_path(self):
        """Test with circular path (start == end)."""
        # Create a circular path
        path = [[0, 0, 100], [1, 0, 100], [1, 1, 100], [0, 1, 100], [0, 0, 100]]
        result = downsample_path_rdp(path, epsilon=0.001)
        # Should preserve shape
        assert len(result) >= 2


class TestDownsampleCoordinates:
    """Tests for downsample_coordinates function."""

    def test_factor_one(self):
        """Test with factor=1 returns all points."""
        coords = [[0, 0], [1, 1], [2, 2], [3, 3]]
        result = downsample_coordinates(coords, factor=1)
        assert result == coords

    def test_factor_two(self):
        """Test with factor=2 keeps every other point."""
        coords = [[0, 0], [1, 1], [2, 2], [3, 3], [4, 4]]
        result = downsample_coordinates(coords, factor=2)
        assert result == [[0, 0], [2, 2], [4, 4]]

    def test_factor_larger_than_list(self):
        """Test with factor larger than list length."""
        coords = [[0, 0], [1, 1]]
        result = downsample_coordinates(coords, factor=10)
        assert result == [[0, 0]]

    def test_empty_coordinates(self):
        """Test with empty list."""
        result = downsample_coordinates([], factor=5)
        assert result == []

    def test_three_element_coordinates(self):
        """Test with 3-element coordinates (lat, lon, alt)."""
        coords = [[0, 0, 100], [1, 1, 200], [2, 2, 300]]
        result = downsample_coordinates(coords, factor=2)
        assert result == [[0, 0, 100], [2, 2, 300]]


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


class TestCalculateAdaptiveEpsilon:
    """Tests for calculate_adaptive_epsilon function."""

    def test_under_target_returns_base(self):
        """Test that datasets under target return base epsilon unchanged."""
        base_epsilon = 0.0001
        result = calculate_adaptive_epsilon(10_000, 50_000, base_epsilon)
        assert result == base_epsilon

    def test_at_target_returns_base(self):
        """Test that datasets exactly at target return base epsilon."""
        base_epsilon = 0.0002
        result = calculate_adaptive_epsilon(50_000, 50_000, base_epsilon)
        assert result == base_epsilon

    def test_small_dataset_no_adaptation(self):
        """Test small dataset with minimal points."""
        base_epsilon = 0.0001
        result = calculate_adaptive_epsilon(1_000, 100_000, base_epsilon)
        assert result == base_epsilon

    def test_moderate_excess_scales_gently(self):
        """Test 2x over target scales by ~1.3x."""
        base_epsilon = 0.0001
        result = calculate_adaptive_epsilon(100_000, 50_000, base_epsilon)
        # log10(2) + 1 ≈ 1.301
        expected = base_epsilon * 1.301
        assert result == pytest.approx(expected, rel=0.01)

    def test_significant_excess_scales_moderately(self):
        """Test 10x over target scales by ~2x."""
        base_epsilon = 0.0001
        result = calculate_adaptive_epsilon(500_000, 50_000, base_epsilon)
        # log10(10) + 1 = 2.0
        expected = base_epsilon * 2.0
        assert result == pytest.approx(expected, rel=0.01)

    def test_massive_excess_scales_aggressively(self):
        """Test 100x over target scales by ~3x."""
        base_epsilon = 0.0001
        result = calculate_adaptive_epsilon(5_000_000, 50_000, base_epsilon)
        # log10(100) + 1 = 3.0
        expected = base_epsilon * 3.0
        assert result == pytest.approx(expected, rel=0.01)

    def test_zero_base_epsilon_uses_minimum(self):
        """Test that zero base epsilon uses minimum value."""
        result = calculate_adaptive_epsilon(1_000_000, 50_000, 0)
        # Should use minimum epsilon of 0.00005 and scale it
        assert result > 0
        # With 20x over target: log10(20) + 1 ≈ 2.301
        expected = 0.00005 * 2.301
        assert result == pytest.approx(expected, rel=0.05)

    def test_caps_at_maximum(self):
        """Test that epsilon is capped at maximum value."""
        base_epsilon = 0.005
        # Extreme case: 1 billion points for 50k target
        # log10(1B/50k) + 1 = log10(20000) + 1 = 5.301
        # 0.005 * 5.301 = 0.0265, which should be capped at 0.01
        result = calculate_adaptive_epsilon(1_000_000_000, 50_000, base_epsilon)
        # Should cap at 0.01
        assert result <= 0.01
        assert result == 0.01

    def test_realistic_scenario_73_files(self):
        """Test with actual current dataset (73 files, ~110k points)."""
        # 2025: 106,690 points, target z11_13: 100,000
        base_epsilon = 0.0001
        result = calculate_adaptive_epsilon(106_690, 100_000, base_epsilon)
        # Slightly over target, should scale minimally
        assert result > base_epsilon
        assert result < base_epsilon * 1.1  # Less than 10% increase

    def test_realistic_scenario_large_dataset(self):
        """Test with projected large dataset (25,000 files, ~7M points per year)."""
        # Projected: ~1.46M points/year, target z14_plus: 500,000
        base_epsilon = 0.00005  # z14_plus base (starts at 0)
        result = calculate_adaptive_epsilon(1_460_000, 500_000, base_epsilon)
        # ~3x over target: log10(2.92) + 1 ≈ 1.466
        expected_scale = 1.466
        assert result == pytest.approx(base_epsilon * expected_scale, rel=0.05)

    def test_different_resolutions(self):
        """Test adaptive scaling across different resolution levels."""
        total_points = 1_000_000

        # z14_plus: target 500k
        epsilon_z14 = calculate_adaptive_epsilon(total_points, 500_000, 0)
        # z11_13: target 100k
        epsilon_z11 = calculate_adaptive_epsilon(total_points, 100_000, 0.0001)
        # z8_10: target 50k
        epsilon_z8 = calculate_adaptive_epsilon(total_points, 50_000, 0.0002)

        # Higher targets should result in lower epsilon (less aggressive)
        assert epsilon_z14 < epsilon_z11 < epsilon_z8

    def test_logarithmic_scaling_property(self):
        """Test that scaling is logarithmic, not linear."""
        base_epsilon = 0.0001
        target = 10_000

        # 10x over
        result_10x = calculate_adaptive_epsilon(100_000, target, base_epsilon)
        # 100x over
        result_100x = calculate_adaptive_epsilon(1_000_000, target, base_epsilon)

        # Ratio should be log10(100)/log10(10) = 2/1 = 2
        # (Not 100/10 = 10 if it were linear)
        ratio = result_100x / result_10x
        assert ratio == pytest.approx(1.5, rel=0.1)  # log(100)+1 / log(10)+1 ≈ 1.5

    def test_edge_case_zero_target(self):
        """Test edge case where target is zero."""
        base_epsilon = 0.0001
        # Should handle gracefully (though this shouldn't happen in practice)
        # This will cause division by zero in ratio calculation
        with pytest.raises(ZeroDivisionError):
            calculate_adaptive_epsilon(100_000, 0, base_epsilon)

    def test_returns_float(self):
        """Test that return value is always a float."""
        result = calculate_adaptive_epsilon(100_000, 50_000, 0.0001)
        assert isinstance(result, float)

    def test_monotonic_increase_with_points(self):
        """Test that epsilon increases monotonically as points increase."""
        base_epsilon = 0.0001
        target = 50_000

        epsilons = []
        for points in [10_000, 50_000, 100_000, 500_000, 1_000_000]:
            eps = calculate_adaptive_epsilon(points, target, base_epsilon)
            epsilons.append(eps)

        # Epsilon should increase as point count increases
        for i in range(len(epsilons) - 1):
            assert epsilons[i] <= epsilons[i + 1]
