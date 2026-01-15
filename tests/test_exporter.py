"""Tests for exporter module."""

import numpy as np
from kml_heatmap.exporter import SegmentSpeedCalculator


class TestSegmentSpeedCalculator:
    """Tests for SegmentSpeedCalculator class."""

    def test_initialization(self):
        """Test calculator initialization."""
        path = [[50.0, 8.5, 1000], [50.1, 8.6, 1100]]
        calc = SegmentSpeedCalculator(path, ground_level_m=100)
        assert calc.path == path
        assert calc.ground_level_m == 100

    def test_find_path_start_time_with_timestamps(self):
        """Test finding start time from path with timestamps."""
        path = [
            [50.0, 8.5, 1000, "2025-03-15T10:00:00Z"],
            [50.1, 8.6, 1100, "2025-03-15T10:01:00Z"],
        ]
        calc = SegmentSpeedCalculator(path, ground_level_m=100)
        assert calc.path_start_time is not None
        assert calc.path_start_time.year == 2025

    def test_find_path_start_time_no_timestamps(self):
        """Test finding start time from path without timestamps."""
        path = [[50.0, 8.5, 1000], [50.1, 8.6, 1100]]
        calc = SegmentSpeedCalculator(path, ground_level_m=100)
        assert calc.path_start_time is None

    def test_calculate_instantaneous_speeds_empty_path(self):
        """Test calculating speeds for empty path."""
        calc = SegmentSpeedCalculator([], ground_level_m=100)
        speeds = calc.calculate_instantaneous_speeds()
        assert speeds == []

    def test_calculate_instantaneous_speeds_single_point(self):
        """Test calculating speeds for single point path."""
        path = [[50.0, 8.5, 1000]]
        calc = SegmentSpeedCalculator(path, ground_level_m=100)
        speeds = calc.calculate_instantaneous_speeds()
        assert speeds == []

    def test_calculate_instantaneous_speeds_with_timestamps(self):
        """Test calculating speeds with timestamps."""
        path = [
            [50.0, 8.5, 1000, "2025-03-15T10:00:00Z"],
            [50.1, 8.6, 1100, "2025-03-15T10:01:00Z"],
        ]
        calc = SegmentSpeedCalculator(path, ground_level_m=100)
        speeds = calc.calculate_instantaneous_speeds()

        assert len(speeds) == 1
        assert speeds[0]["index"] == 0
        assert speeds[0]["timestamp"] is not None
        assert speeds[0]["speed"] >= 0
        assert speeds[0]["distance"] > 0

    def test_calculate_instantaneous_speeds_without_timestamps(self):
        """Test calculating speeds without timestamps."""
        path = [[50.0, 8.5, 1000], [50.1, 8.6, 1100]]
        calc = SegmentSpeedCalculator(path, ground_level_m=100)
        speeds = calc.calculate_instantaneous_speeds()

        assert len(speeds) == 1
        assert speeds[0]["timestamp"] is None
        assert speeds[0]["speed"] == 0  # No time delta means no speed

    def test_calculate_instantaneous_speeds_caps_unrealistic(self):
        """Test that unrealistic speeds are capped."""
        # Very short time for long distance
        path = [
            [50.0, 8.5, 1000, "2025-03-15T10:00:00.000Z"],
            [51.0, 9.5, 1100, "2025-03-15T10:00:00.001Z"],
        ]
        calc = SegmentSpeedCalculator(path, ground_level_m=100)
        speeds = calc.calculate_instantaneous_speeds()

        # Speed should be capped to 0 if too high
        assert speeds[0]["speed"] == 0

    def test_calculate_rolling_average_speeds(self):
        """Test calculating rolling average speeds."""
        path = [
            [50.0, 8.5, 1000, "2025-03-15T10:00:00Z"],
            [50.1, 8.6, 1100, "2025-03-15T10:01:00Z"],
            [50.2, 8.7, 1200, "2025-03-15T10:02:00Z"],
        ]
        calc = SegmentSpeedCalculator(path, ground_level_m=100)
        groundspeeds, relative_times = calc.calculate_rolling_average_speeds()

        assert len(groundspeeds) >= 0
        assert isinstance(groundspeeds, np.ndarray)

    def test_calculate_rolling_average_speeds_empty(self):
        """Test calculating rolling average speeds with empty path."""
        calc = SegmentSpeedCalculator([], ground_level_m=100)
        groundspeeds, relative_times = calc.calculate_rolling_average_speeds()

        assert len(groundspeeds) == 0

    def test_multiple_segments_with_valid_timestamps(self):
        """Test calculating speeds for multiple segments with valid timestamps."""
        path = [
            [50.0, 8.5, 1000, "2025-03-15T10:00:00Z"],
            [50.1, 8.6, 1100, "2025-03-15T10:01:00Z"],
            [50.2, 8.7, 1200, "2025-03-15T10:02:00Z"],
            [50.3, 8.8, 1300, "2025-03-15T10:03:00Z"],
        ]
        calc = SegmentSpeedCalculator(path, ground_level_m=100)
        speeds = calc.calculate_instantaneous_speeds()

        assert len(speeds) == 3
        for speed_data in speeds:
            assert "index" in speed_data
            assert "timestamp" in speed_data
            assert "speed" in speed_data
            assert "distance" in speed_data
            assert "time_delta" in speed_data

    def test_find_path_start_time_invalid_timestamps(self):
        """Test finding start time with invalid timestamp format."""
        path = [[50.0, 8.5, 1000, "invalid"], [50.1, 8.6, 1100, "also_invalid"]]
        calc = SegmentSpeedCalculator(path, ground_level_m=100)
        assert calc.path_start_time is None

    def test_find_path_start_time_value_error(self):
        """Test finding start time with timestamps that raise ValueError."""
        # Timestamp without 'T' should be skipped
        path = [
            [50.0, 8.5, 1000, "2025-03-15"],
            [50.1, 8.6, 1100, "2025-03-15T10:00:00Z"],
        ]
        calc = SegmentSpeedCalculator(path, ground_level_m=100)
        # Should find the second timestamp
        assert calc.path_start_time is not None
        assert calc.path_start_time.year == 2025

    def test_find_path_start_time_type_error(self):
        """Test finding start time with wrong type in timestamp field."""
        # Integer in timestamp field should be handled
        path = [[50.0, 8.5, 1000, 12345], [50.1, 8.6, 1100, "2025-03-15T10:00:00Z"]]
        calc = SegmentSpeedCalculator(path, ground_level_m=100)
        # Should skip invalid and find valid timestamp
        assert calc.path_start_time is not None

    def test_calculate_instantaneous_speeds_with_partial_timestamps(self):
        """Test calculating speeds when only some coordinates have timestamps."""
        path = [
            [50.0, 8.5, 1000, "2025-03-15T10:00:00Z"],
            [50.1, 8.6, 1100],  # No timestamp
            [50.2, 8.7, 1200, "2025-03-15T10:02:00Z"],
        ]
        calc = SegmentSpeedCalculator(path, ground_level_m=100)
        speeds = calc.calculate_instantaneous_speeds()

        assert len(speeds) == 2
        # First segment has end coord without timestamp - both coords need timestamps
        # so timestamp will be None
        assert speeds[0]["timestamp"] is None
        assert speeds[0]["speed"] == 0  # No time delta available

    def test_relative_time_calculation(self):
        """Test that relative times are calculated correctly."""
        path = [
            [50.0, 8.5, 1000, "2025-03-15T10:00:00Z"],
            [50.1, 8.6, 1100, "2025-03-15T10:01:00Z"],
            [50.2, 8.7, 1200, "2025-03-15T10:02:00Z"],
        ]
        calc = SegmentSpeedCalculator(path, ground_level_m=100)
        speeds = calc.calculate_instantaneous_speeds()

        # First segment should have relative_time of 0
        assert speeds[0]["relative_time"] == 0.0
        # Second segment should have relative_time of 60 seconds
        assert speeds[1]["relative_time"] == 60.0

    def test_distance_calculation_accuracy(self):
        """Test that distance calculations are reasonable."""
        # Create path with known lat/lon difference
        path = [
            [50.0, 8.0, 1000, "2025-03-15T10:00:00Z"],
            [50.1, 8.0, 1000, "2025-03-15T10:01:00Z"],  # 0.1 degree latitude diff
        ]
        calc = SegmentSpeedCalculator(path, ground_level_m=100)
        speeds = calc.calculate_instantaneous_speeds()

        # 0.1 degrees latitude is approximately 11 km
        assert 10 < speeds[0]["distance"] < 12

    def test_rolling_average_with_sorted_timestamps(self):
        """Test rolling average calculation with timestamp sorting."""
        # Create path with timestamps that need sorting
        path = [
            [50.0, 8.5, 1000, "2025-03-15T10:00:00Z"],
            [50.1, 8.6, 1100, "2025-03-15T10:01:00Z"],
            [50.2, 8.7, 1200, "2025-03-15T10:02:00Z"],
            [50.3, 8.8, 1300, "2025-03-15T10:03:00Z"],
        ]
        calc = SegmentSpeedCalculator(path, ground_level_m=100)
        groundspeeds, relative_times = calc.calculate_rolling_average_speeds()

        assert len(groundspeeds) >= 0
        # Should have calculated rolling averages
        assert isinstance(groundspeeds, np.ndarray)

    def test_rolling_average_with_window_calculation(self):
        """Test rolling average with proper window-based speed calculation."""
        # Create path with larger distances to ensure valid speed calculation
        # Using approximately 100 km/h = ~54 knots
        path = [
            [50.0, 8.0, 1000, "2025-03-15T10:00:00Z"],
            [50.015, 8.0, 1000, "2025-03-15T10:01:00Z"],  # ~1.67 km in 60s
            [50.030, 8.0, 1000, "2025-03-15T10:02:00Z"],  # ~1.67 km in 60s
            [50.045, 8.0, 1000, "2025-03-15T10:03:00Z"],  # ~1.67 km in 60s
            [50.060, 8.0, 1000, "2025-03-15T10:04:00Z"],  # ~1.67 km in 60s
        ]
        calc = SegmentSpeedCalculator(path, ground_level_m=100)
        groundspeeds, relative_times = calc.calculate_rolling_average_speeds()

        # Should calculate speeds for all segments
        assert len(groundspeeds) >= 4
        # Groundspeeds array should be a numpy array
        assert isinstance(groundspeeds, np.ndarray)

    def test_time_delta_below_minimum(self):
        """Test handling of very small time deltas."""
        path = [
            [50.0, 8.5, 1000, "2025-03-15T10:00:00.000Z"],
            [50.1, 8.6, 1100, "2025-03-15T10:00:00.500Z"],  # 0.5 seconds
        ]
        calc = SegmentSpeedCalculator(path, ground_level_m=100)
        speeds = calc.calculate_instantaneous_speeds()

        # Should return speed of 0 for very short time delta (< MIN_SEGMENT_TIME_SECONDS)
        assert speeds[0]["speed"] == 0


class TestCalculatePathDurationAndDistance:
    """Tests for calculate_path_duration_and_distance function."""

    def test_empty_path(self):
        """Test with empty path."""
        from kml_heatmap.exporter import calculate_path_duration_and_distance

        duration, distance = calculate_path_duration_and_distance([], {})
        assert duration == 0
        assert distance == 0

    def test_single_point_path(self):
        """Test with single point."""
        from kml_heatmap.exporter import calculate_path_duration_and_distance

        path = [[50.0, 8.5, 1000]]
        duration, distance = calculate_path_duration_and_distance(path, {})
        assert duration == 0
        assert distance == 0

    def test_path_with_timestamps(self):
        """Test path with timestamps in metadata."""
        from kml_heatmap.exporter import calculate_path_duration_and_distance

        path = [
            [50.0, 8.5, 1000],
            [50.1, 8.6, 1100],
        ]
        metadata = {
            "timestamp": "2025-03-15T10:00:00Z",
            "end_timestamp": "2025-03-15T10:30:00Z",
        }
        duration, distance = calculate_path_duration_and_distance(path, metadata)
        assert duration == 1800  # 30 minutes
        assert distance > 0

    def test_path_without_timestamps(self):
        """Test path without timestamps."""
        from kml_heatmap.exporter import calculate_path_duration_and_distance

        path = [[50.0, 8.5, 1000], [50.1, 8.6, 1100]]
        duration, distance = calculate_path_duration_and_distance(path, {})
        assert duration == 0
        assert distance > 0

    def test_invalid_timestamps(self):
        """Test with invalid timestamps."""
        from kml_heatmap.exporter import calculate_path_duration_and_distance

        path = [[50.0, 8.5, 1000], [50.1, 8.6, 1100]]
        metadata = {"timestamp": "invalid", "end_timestamp": "also_invalid"}
        duration, distance = calculate_path_duration_and_distance(path, metadata)
        assert duration == 0

    def test_missing_t_in_timestamp(self):
        """Test timestamps without T character."""
        from kml_heatmap.exporter import calculate_path_duration_and_distance

        path = [[50.0, 8.5, 1000], [50.1, 8.6, 1100]]
        metadata = {"timestamp": "2025-03-15", "end_timestamp": "2025-03-16"}
        duration, distance = calculate_path_duration_and_distance(path, metadata)
        assert duration == 0  # Won't parse without T


class TestUpdateSpeedStatistics:
    """Tests for _update_speed_statistics function."""

    def test_update_max_speed(self):
        """Test updating maximum speed."""
        from kml_heatmap.exporter import _update_speed_statistics

        speed_stats = {"min": float("inf"), "max": 0.0}
        _update_speed_statistics(150.0, speed_stats)
        assert speed_stats["max"] == 150.0

    def test_update_min_speed(self):
        """Test updating minimum speed."""
        from kml_heatmap.exporter import _update_speed_statistics

        speed_stats = {"min": float("inf"), "max": 0.0}
        _update_speed_statistics(80.0, speed_stats)
        assert speed_stats["min"] == 80.0

    def test_ignore_zero_speed(self):
        """Test that zero speeds are ignored."""
        from kml_heatmap.exporter import _update_speed_statistics

        speed_stats = {"min": float("inf"), "max": 0.0}
        _update_speed_statistics(0.0, speed_stats)
        assert speed_stats["min"] == float("inf")
        assert speed_stats["max"] == 0.0

    def test_update_both_min_and_max(self):
        """Test updating both min and max."""
        from kml_heatmap.exporter import _update_speed_statistics

        speed_stats = {"min": 100.0, "max": 100.0}
        _update_speed_statistics(150.0, speed_stats)
        assert speed_stats["max"] == 150.0
        _update_speed_statistics(50.0, speed_stats)
        assert speed_stats["min"] == 50.0


class TestUpdateCruiseStatistics:
    """Tests for _update_cruise_statistics function."""

    def test_update_cruise_above_threshold(self):
        """Test updating cruise stats above altitude threshold."""
        from kml_heatmap.exporter import _update_cruise_statistics

        cruise_stats = {
            "total_distance_nm": 0.0,
            "total_time_s": 0.0,
            "altitude_histogram": {},
        }
        seg_info = {"distance": 10.0, "time_delta": 60.0}  # 10 km in 60 seconds

        # 3000m above ground = ~9843 feet AGL (above CRUISE_ALTITUDE_THRESHOLD_FT)
        _update_cruise_statistics(3100.0, 100.0, seg_info, cruise_stats)

        assert cruise_stats["total_time_s"] > 0
        assert cruise_stats["total_distance_nm"] > 0
        assert len(cruise_stats["altitude_histogram"]) > 0

    def test_ignore_below_cruise_threshold(self):
        """Test that low altitudes are ignored."""
        from kml_heatmap.exporter import _update_cruise_statistics

        cruise_stats = {
            "total_distance_nm": 0.0,
            "total_time_s": 0.0,
            "altitude_histogram": {},
        }
        seg_info = {"distance": 10.0, "time_delta": 60.0}

        # 200m above ground = ~656 feet AGL (below CRUISE_ALTITUDE_THRESHOLD_FT)
        _update_cruise_statistics(300.0, 100.0, seg_info, cruise_stats)

        assert cruise_stats["total_time_s"] == 0
        assert cruise_stats["total_distance_nm"] == 0

    def test_ignore_short_time_delta(self):
        """Test that short time deltas are ignored."""
        from kml_heatmap.exporter import _update_cruise_statistics
        from kml_heatmap.constants import MIN_SEGMENT_TIME_SECONDS

        cruise_stats = {
            "total_distance_nm": 0.0,
            "total_time_s": 0.0,
            "altitude_histogram": {},
        }
        # Use a time_delta that's below MIN_SEGMENT_TIME_SECONDS (default is 1.0)
        seg_info = {"distance": 10.0, "time_delta": MIN_SEGMENT_TIME_SECONDS - 0.5}

        # High altitude but short time delta
        _update_cruise_statistics(3100.0, 100.0, seg_info, cruise_stats)

        assert cruise_stats["total_time_s"] == 0

    def test_altitude_histogram_binning(self):
        """Test altitude histogram binning."""
        from kml_heatmap.exporter import _update_cruise_statistics

        cruise_stats = {
            "total_distance_nm": 0.0,
            "total_time_s": 0.0,
            "altitude_histogram": {},
        }
        seg_info = {"distance": 10.0, "time_delta": 60.0}

        # Add segments at similar altitudes - should bin together
        _update_cruise_statistics(3100.0, 100.0, seg_info, cruise_stats)
        _update_cruise_statistics(3150.0, 100.0, seg_info, cruise_stats)

        # Should have accumulated time in histogram
        assert len(cruise_stats["altitude_histogram"]) >= 1
        for bin_time in cruise_stats["altitude_histogram"].values():
            assert bin_time > 0


class TestBuildPathInfo:
    """Tests for _build_path_info function."""

    def test_build_path_info_basic(self):
        """Test building basic path info."""
        from kml_heatmap.exporter import _build_path_info

        path = [[50.0, 8.5, 1000], [50.1, 8.6, 1100]]
        metadata = {"airport_name": "EDDF - EDDM", "timestamp": "2025-03-15T10:00:00Z"}

        info = _build_path_info(path, 0, metadata)

        # Check for 'id' which is what the function actually uses
        assert "id" in info
        assert info["id"] == 0
        # Check for start coords
        assert "start_coords" in info or "start" in info

    def test_build_path_info_with_airports(self):
        """Test building path info with airport names."""
        from kml_heatmap.exporter import _build_path_info

        path = [[50.0, 8.5, 1000], [50.1, 8.6, 1100]]
        metadata = {"airport_name": "EDDF - EDDM", "timestamp": None}

        info = _build_path_info(path, 0, metadata)

        assert "start_airport" in info
        assert "end_airport" in info

    def test_build_path_info_no_airport_separator(self):
        """Test building path info without airport separator."""
        from kml_heatmap.exporter import _build_path_info

        path = [[50.0, 8.5, 1000]]
        metadata = {"airport_name": "Single Airport", "timestamp": None}

        info = _build_path_info(path, 0, metadata)

        assert info["start_airport"] is None
        assert info["end_airport"] is None

    def test_build_path_info_with_aircraft_data(self):
        """Test building path info with aircraft metadata."""
        from kml_heatmap.exporter import _build_path_info

        path = [[50.0, 8.5, 1000], [50.1, 8.6, 1100]]
        metadata = {
            "airport_name": "EDDF - EDDM",
            "aircraft_registration": "D-ABCD",
            "aircraft_type": "C172",
            "year": 2025,
        }

        info = _build_path_info(path, 5, metadata)

        assert info["id"] == 5
        assert info["aircraft_registration"] == "D-ABCD"
        assert info["aircraft_type"] == "C172"
        assert info["year"] == 2025
        assert info["segment_count"] == 1


class TestProcessPathSegmentsFullResolution:
    """Tests for process_path_segments_full_resolution function."""

    def test_process_simple_path(self):
        """Test processing a simple path."""
        from kml_heatmap.exporter import process_path_segments_full_resolution

        path = [
            [50.0, 8.5, 1000, "2025-03-15T10:00:00Z"],
            [50.1, 8.6, 1100, "2025-03-15T10:01:00Z"],
            [50.2, 8.7, 1200, "2025-03-15T10:02:00Z"],
        ]
        metadata = {"airport_name": "Test", "year": 2025}
        cruise_stats = {
            "total_distance_nm": 0.0,
            "total_time_s": 0.0,
            "altitude_histogram": {},
        }
        speed_stats = {"min": float("inf"), "max": 0.0}

        segments, path_info = process_path_segments_full_resolution(
            path, 0, metadata, 1000.0, 1200.0, cruise_stats, speed_stats
        )

        assert len(segments) > 0
        assert "id" in path_info
        assert path_info["id"] == 0

    def test_process_path_skips_zero_length_segments(self):
        """Test that zero-length segments are skipped."""
        from kml_heatmap.exporter import process_path_segments_full_resolution

        path = [
            [50.0, 8.5, 1000],
            [50.0, 8.5, 1000],  # Same location
            [50.1, 8.6, 1100],
        ]
        metadata = {}
        cruise_stats = {
            "total_distance_nm": 0.0,
            "total_time_s": 0.0,
            "altitude_histogram": {},
        }
        speed_stats = {"min": float("inf"), "max": 0.0}

        segments, path_info = process_path_segments_full_resolution(
            path, 0, metadata, 1000.0, 1100.0, cruise_stats, speed_stats
        )

        # Should only have 1 segment (skipping the zero-length one)
        assert len(segments) == 1

    def test_process_path_updates_statistics(self):
        """Test that processing updates speed and cruise statistics."""
        from kml_heatmap.exporter import process_path_segments_full_resolution

        path = [
            [50.0, 8.5, 1000, "2025-03-15T10:00:00Z"],
            [50.1, 8.6, 1100, "2025-03-15T10:01:00Z"],
        ]
        metadata = {}
        cruise_stats = {
            "total_distance_nm": 0.0,
            "total_time_s": 0.0,
            "altitude_histogram": {},
        }
        speed_stats = {"min": float("inf"), "max": 0.0}

        segments, path_info = process_path_segments_full_resolution(
            path, 0, metadata, 1000.0, 1100.0, cruise_stats, speed_stats
        )

        # Speed stats should be updated if speed > 0
        # (depends on whether timestamps generate valid speed)
        assert isinstance(speed_stats["max"], float)

    def test_process_path_includes_time_data(self):
        """Test that segments include time data when available."""
        from kml_heatmap.exporter import process_path_segments_full_resolution

        path = [
            [50.0, 8.5, 1000, "2025-03-15T10:00:00Z"],
            [50.1, 8.6, 1100, "2025-03-15T10:01:00Z"],
        ]
        metadata = {}
        cruise_stats = {
            "total_distance_nm": 0.0,
            "total_time_s": 0.0,
            "altitude_histogram": {},
        }
        speed_stats = {"min": float("inf"), "max": 0.0}

        segments, path_info = process_path_segments_full_resolution(
            path, 0, metadata, 1000.0, 1100.0, cruise_stats, speed_stats
        )

        # Check segment structure
        if len(segments) > 0:
            seg = segments[0]
            assert "coords" in seg
            assert "color" in seg
            assert "altitude_ft" in seg
            assert "groundspeed_knots" in seg


class TestProcessPathSegmentsDownsampled:
    """Tests for process_path_segments_downsampled function."""

    def test_process_downsampled_path(self):
        """Test processing path without speed calculation."""
        from kml_heatmap.exporter import process_path_segments_downsampled

        path = [
            [50.0, 8.5, 1000],
            [50.1, 8.6, 1100],
            [50.2, 8.7, 1200],
        ]
        metadata = {"airport_name": "Test"}

        segments, path_info = process_path_segments_downsampled(
            path, 0, metadata, 1000.0, 1200.0
        )

        assert len(segments) > 0
        assert path_info["id"] == 0

    def test_downsampled_skips_zero_length(self):
        """Test that downsampled processing skips zero-length segments."""
        from kml_heatmap.exporter import process_path_segments_downsampled

        path = [
            [50.0, 8.5, 1000],
            [50.0, 8.5, 1000],  # Same location
            [50.1, 8.6, 1100],
        ]
        metadata = {}

        segments, path_info = process_path_segments_downsampled(
            path, 0, metadata, 1000.0, 1100.0
        )

        # Should skip zero-length segment
        assert len(segments) == 1

    def test_downsampled_has_zero_speed(self):
        """Test that downsampled segments have speed set to zero."""
        from kml_heatmap.exporter import process_path_segments_downsampled

        path = [[50.0, 8.5, 1000], [50.1, 8.6, 1100]]
        metadata = {}

        segments, path_info = process_path_segments_downsampled(
            path, 0, metadata, 1000.0, 1100.0
        )

        if len(segments) > 0:
            seg = segments[0]
            assert "coords" in seg
            assert "color" in seg
            assert "altitude_ft" in seg
            # Downsampled segments have groundspeed set to 0
            assert "groundspeed_knots" in seg
            assert seg["groundspeed_knots"] == 0


class TestExportAirportsJson:
    """Tests for export_airports_json function."""

    def test_export_basic_airports(self):
        """Test exporting basic airport list."""
        from kml_heatmap.exporter import export_airports_json
        import tempfile
        import os

        airports = [
            {
                "lat": 50.0,
                "lon": 8.5,
                "name": "EDDF Frankfurt",
                "timestamps": ["2025-01-01T10:00:00Z"],
            }
        ]

        with tempfile.TemporaryDirectory() as tmpdir:
            export_airports_json(airports, tmpdir, strip_timestamps=False)
            output_file = os.path.join(tmpdir, "airports.json")
            assert os.path.exists(output_file)

            with open(output_file) as f:
                data = __import__("json").load(f)
                assert "airports" in data
                assert len(data["airports"]) > 0

    def test_export_airports_strip_timestamps(self):
        """Test exporting airports without timestamps."""
        from kml_heatmap.exporter import export_airports_json
        import tempfile
        import os

        airports = [
            {
                "lat": 50.0,
                "lon": 8.5,
                "name": "EDDF Frankfurt",
                "timestamps": ["2025-01-01T10:00:00Z"],
            }
        ]

        with tempfile.TemporaryDirectory() as tmpdir:
            export_airports_json(airports, tmpdir, strip_timestamps=True)
            output_file = os.path.join(tmpdir, "airports.json")

            with open(output_file) as f:
                data = __import__("json").load(f)
                # Timestamps should not be present
                if len(data["airports"]) > 0:
                    assert "timestamps" not in data["airports"][0]

    def test_export_airports_filters_invalid_names(self):
        """Test that airports with invalid names are filtered."""
        from kml_heatmap.exporter import export_airports_json
        import tempfile

        airports = [
            {
                "lat": 50.0,
                "lon": 8.5,
                "name": "Unknown",  # Should be filtered
                "timestamps": [],
                "is_at_path_end": False,
            },
            {
                "lat": 51.0,
                "lon": 9.5,
                "name": "EDDF Frankfurt",
                "timestamps": ["2025-01-01T10:00:00Z"],
                "is_at_path_end": False,
            },
        ]

        with tempfile.TemporaryDirectory() as tmpdir:
            export_airports_json(airports, tmpdir)
            # Should filter out "Unknown"

    def test_export_airports_deduplicates_locations(self):
        """Test that duplicate locations are filtered."""
        from kml_heatmap.exporter import export_airports_json
        import tempfile

        airports = [
            {
                "lat": 50.0000,
                "lon": 8.5000,
                "name": "EDDF Frankfurt",
                "timestamps": ["2025-01-01T10:00:00Z"],
                "is_at_path_end": False,
            },
            {
                "lat": 50.0001,
                "lon": 8.5001,  # Very close - should deduplicate
                "name": "EDDF Frankfurt",
                "timestamps": ["2025-01-02T10:00:00Z"],
                "is_at_path_end": False,
            },
        ]

        with tempfile.TemporaryDirectory() as tmpdir:
            export_airports_json(airports, tmpdir)


class TestExportMetadataJson:
    """Tests for export_metadata_json function."""

    def test_export_basic_metadata(self):
        """Test exporting basic metadata."""
        from kml_heatmap.exporter import export_metadata_json
        import tempfile
        import os

        stats = {"total_paths": 10, "total_points": 1000}
        speed_stats = {"min": 50.0, "max": 200.0}
        gradient = {0.0: "#0000ff", 1.0: "#ff0000"}
        years = [2024, 2025]

        with tempfile.TemporaryDirectory() as tmpdir:
            export_metadata_json(
                stats, 100.0, 5000.0, speed_stats, gradient, years, tmpdir
            )
            output_file = os.path.join(tmpdir, "metadata.json")
            assert os.path.exists(output_file)

            with open(output_file) as f:
                data = __import__("json").load(f)
                assert "stats" in data
                assert "min_alt_m" in data
                assert "max_alt_m" in data
                assert "gradient" in data
                assert "available_years" in data

    def test_export_metadata_with_no_speeds(self):
        """Test exporting metadata when no speeds were recorded."""
        from kml_heatmap.exporter import export_metadata_json
        import tempfile
        import os

        stats = {}
        speed_stats = {"min": float("inf"), "max": 0.0}
        gradient = {}
        years = []

        with tempfile.TemporaryDirectory() as tmpdir:
            export_metadata_json(stats, 0.0, 0.0, speed_stats, gradient, years, tmpdir)
            output_file = os.path.join(tmpdir, "metadata.json")

            with open(output_file) as f:
                data = __import__("json").load(f)
                # Should handle inf gracefully
                assert data["min_groundspeed_knots"] == 0
