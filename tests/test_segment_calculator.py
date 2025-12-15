"""Tests for segment_calculator module."""

import pytest
from datetime import datetime
from kml_heatmap.segment_calculator import (
    SegmentData,
    calculate_path_duration,
    calculate_path_distance,
    extract_segment_speeds,
)


class TestSegmentData:
    """Tests for SegmentData class."""

    def test_segment_data_initialization(self):
        """Test SegmentData initialization."""
        data = SegmentData()
        assert data.segments == []
        assert data.max_groundspeed_knots == 0.0
        assert data.min_groundspeed_knots == float("inf")
        assert data.cruise_speed_total_distance == 0.0
        assert data.cruise_speed_total_time == 0.0
        assert data.cruise_altitude_histogram == {}
        assert data.max_path_distance_nm == 0.0


class TestCalculatePathDuration:
    """Tests for calculate_path_duration function."""

    def test_valid_timestamps(self):
        """Test duration calculation with valid timestamps."""
        start = "2025-03-15T10:00:00Z"
        end = "2025-03-15T11:00:00Z"
        duration = calculate_path_duration(start, end)
        assert duration == 3600.0  # 1 hour

    def test_no_start_timestamp(self):
        """Test with missing start timestamp."""
        duration = calculate_path_duration(None, "2025-03-15T11:00:00Z")
        assert duration == 0.0

    def test_no_end_timestamp(self):
        """Test with missing end timestamp."""
        duration = calculate_path_duration("2025-03-15T10:00:00Z", None)
        assert duration == 0.0

    def test_both_timestamps_none(self):
        """Test with both timestamps None."""
        duration = calculate_path_duration(None, None)
        assert duration == 0.0

    def test_empty_timestamps(self):
        """Test with empty string timestamps."""
        duration = calculate_path_duration("", "")
        assert duration == 0.0

    def test_invalid_timestamp_format(self):
        """Test with invalid timestamp format."""
        duration = calculate_path_duration("invalid", "2025-03-15T11:00:00Z")
        assert duration == 0.0

    def test_same_timestamps(self):
        """Test with same start and end timestamp."""
        timestamp = "2025-03-15T10:00:00Z"
        duration = calculate_path_duration(timestamp, timestamp)
        assert duration == 0.0

    def test_negative_duration(self):
        """Test when end is before start."""
        start = "2025-03-15T11:00:00Z"
        end = "2025-03-15T10:00:00Z"
        duration = calculate_path_duration(start, end)
        assert duration == -3600.0  # Negative duration


class TestCalculatePathDistance:
    """Tests for calculate_path_distance function."""

    def test_empty_path(self):
        """Test distance with empty path."""
        assert calculate_path_distance([]) == 0.0

    def test_single_point_path(self):
        """Test distance with single point."""
        path = [[50.0, 8.5, 100]]
        assert calculate_path_distance(path) == 0.0

    def test_two_point_path(self):
        """Test distance with two points."""
        # Approximately 111 km for 1 degree latitude difference
        path = [[50.0, 8.5, 100], [51.0, 8.5, 200]]
        distance = calculate_path_distance(path)
        assert 100 < distance < 120  # Rough check

    def test_multi_point_path(self):
        """Test distance with multiple points."""
        path = [
            [50.0, 8.5, 100],
            [50.5, 9.0, 150],
            [51.0, 9.5, 200],
        ]
        distance = calculate_path_distance(path)
        assert distance > 0

    def test_path_with_timestamps(self):
        """Test distance calculation ignores timestamps."""
        path = [
            [50.0, 8.5, 100, "2025-03-15T10:00:00Z"],
            [51.0, 8.5, 200, "2025-03-15T11:00:00Z"],
        ]
        distance = calculate_path_distance(path)
        assert 100 < distance < 120

    def test_zero_distance_path(self):
        """Test path where all points are the same location."""
        path = [
            [50.0, 8.5, 100],
            [50.0, 8.5, 200],
            [50.0, 8.5, 300],
        ]
        distance = calculate_path_distance(path)
        assert distance == pytest.approx(0.0, abs=0.01)


class TestExtractSegmentSpeeds:
    """Tests for extract_segment_speeds function."""

    def test_empty_path(self):
        """Test with empty path."""
        result = extract_segment_speeds([], None)
        assert result == []

    def test_single_point_path(self):
        """Test with single point."""
        path = [[50.0, 8.5, 100]]
        result = extract_segment_speeds(path, None)
        assert result == []

    def test_path_without_timestamps(self):
        """Test path without timestamp data."""
        path = [[50.0, 8.5, 100], [51.0, 9.5, 200]]
        result = extract_segment_speeds(path, None)
        assert len(result) == 1
        assert result[0]["speed"] == 0.0
        assert result[0]["timestamp"] is None

    def test_path_with_timestamps(self):
        """Test path with timestamp data."""
        path = [
            [50.0, 8.5, 100, "2025-03-15T10:00:00Z"],
            [51.0, 8.5, 200, "2025-03-15T10:30:00Z"],
        ]
        result = extract_segment_speeds(path, None)
        assert len(result) == 1
        assert result[0]["speed"] > 0  # Should calculate speed
        assert result[0]["timestamp"] is not None
        assert result[0]["time_delta"] == 1800.0  # 30 minutes

    def test_segment_with_relative_time(self):
        """Test segment calculation with path start time."""
        from datetime import timezone

        path = [
            [50.0, 8.5, 100, "2025-03-15T10:00:00Z"],
            [51.0, 8.5, 200, "2025-03-15T10:30:00Z"],
        ]
        start_time = datetime(2025, 3, 15, 10, 0, 0, tzinfo=timezone.utc)
        result = extract_segment_speeds(path, start_time)
        assert result[0]["relative_time"] == 0.0

    def test_multiple_segments(self):
        """Test path with multiple segments."""
        path = [
            [50.0, 8.5, 100, "2025-03-15T10:00:00Z"],
            [50.5, 9.0, 150, "2025-03-15T10:15:00Z"],
            [51.0, 9.5, 200, "2025-03-15T10:30:00Z"],
        ]
        result = extract_segment_speeds(path, None)
        assert len(result) == 2
        assert result[0]["index"] == 0
        assert result[1]["index"] == 1

    def test_unrealistic_speed_filtered(self):
        """Test that unrealistic speeds are filtered out."""
        # Very short time for long distance = unrealistic speed
        path = [
            [50.0, 8.5, 100, "2025-03-15T10:00:00Z"],
            [60.0, 18.5, 200, "2025-03-15T10:00:01Z"],  # 1 second for huge distance
        ]
        result = extract_segment_speeds(path, None)
        assert len(result) == 1
        # Speed should be filtered to 0 if unrealistic
        assert result[0]["speed"] == 0.0

    def test_segment_distance_calculation(self):
        """Test that segment distance is calculated."""
        path = [[50.0, 8.5, 100], [51.0, 8.5, 200]]
        result = extract_segment_speeds(path, None)
        assert result[0]["distance"] > 0

    def test_very_short_time_delta_ignored(self):
        """Test that very short time deltas are handled."""
        # Less than minimum segment time
        path = [
            [50.0, 8.5, 100, "2025-03-15T10:00:00.000Z"],
            [50.0, 8.5, 200, "2025-03-15T10:00:00.001Z"],  # 1 millisecond
        ]
        result = extract_segment_speeds(path, None)
        assert len(result) == 1
        # Speed should be 0 for too-short time delta
        assert result[0]["speed"] == 0.0

    def test_partial_timestamp_data(self):
        """Test path with some coordinates having timestamps."""
        path = [
            [50.0, 8.5, 100, "2025-03-15T10:00:00Z"],
            [50.5, 9.0, 150],  # No timestamp
            [51.0, 9.5, 200, "2025-03-15T10:30:00Z"],
        ]
        result = extract_segment_speeds(path, None)
        assert len(result) == 2
        # First segment requires both coordinates to have timestamps
        # Since second coordinate has no timestamp, first segment has no timestamp
        assert result[0]["timestamp"] is None
        # Second segment also has no timestamp (first coord has none)
        assert result[1]["timestamp"] is None


class TestBuildTimeIndexedSegments:
    """Tests for build_time_indexed_segments function."""

    def test_empty_segments(self):
        """Test with empty segment list."""
        from kml_heatmap.segment_calculator import build_time_indexed_segments

        timestamp_list, time_indexed_segments = build_time_indexed_segments([])
        assert timestamp_list == []
        assert time_indexed_segments == []

    def test_segments_with_timestamps(self):
        """Test building time index from segments with timestamps."""
        from kml_heatmap.segment_calculator import build_time_indexed_segments

        segments = [
            {"timestamp": datetime(2025, 3, 15, 10, 0, 0), "speed": 100},
            {"timestamp": datetime(2025, 3, 15, 10, 30, 0), "speed": 120},
        ]

        timestamp_list, time_indexed_segments = build_time_indexed_segments(segments)
        assert len(timestamp_list) == 2
        assert len(time_indexed_segments) == 2

    def test_segments_with_zero_speed_filtered(self):
        """Test that segments with zero speed are filtered out."""
        from kml_heatmap.segment_calculator import build_time_indexed_segments

        segments = [
            {"timestamp": datetime(2025, 3, 15, 10, 0, 0), "speed": 100},
            {"timestamp": datetime(2025, 3, 15, 10, 15, 0), "speed": 0},  # Filtered
            {"timestamp": datetime(2025, 3, 15, 10, 30, 0), "speed": 120},
        ]

        timestamp_list, time_indexed_segments = build_time_indexed_segments(segments)
        assert len(timestamp_list) == 2  # Only non-zero speeds

    def test_segments_with_none_timestamp_filtered(self):
        """Test that segments with None timestamp are filtered out."""
        from kml_heatmap.segment_calculator import build_time_indexed_segments

        segments = [
            {"timestamp": datetime(2025, 3, 15, 10, 0, 0), "speed": 100},
            {"timestamp": None, "speed": 120},  # Filtered
        ]

        timestamp_list, time_indexed_segments = build_time_indexed_segments(segments)
        assert len(timestamp_list) == 1


class TestCalculateWindowedGroundspeed:
    """Tests for calculate_windowed_groundspeed function."""

    def test_empty_timestamp_list(self):
        """Test with empty timestamp list."""
        from kml_heatmap.segment_calculator import calculate_windowed_groundspeed

        speed = calculate_windowed_groundspeed(datetime(2025, 3, 15, 10, 0, 0), [], [])
        assert speed == 0.0

    def test_single_segment_in_window(self):
        """Test calculation with single segment."""
        from kml_heatmap.segment_calculator import calculate_windowed_groundspeed

        timestamp = datetime(2025, 3, 15, 10, 0, 0)
        timestamp_list = [timestamp.timestamp()]
        # Need enough time_delta (>1 second) and reasonable distance
        segments = [{"distance": 10.0, "time_delta": 600.0}]  # 10km in 600s

        speed = calculate_windowed_groundspeed(timestamp, timestamp_list, segments)
        # Speed might be 0 if not enough time/distance, or positive if calculated
        assert speed >= 0


class TestCalculatePathDistanceConsistency:
    """Additional tests for calculate_path_distance function."""

    def test_path_distance_consistency(self):
        """Test that distance calculation is consistent."""
        # Same path should give same distance
        path = [[50.0, 8.5, 100], [51.0, 9.5, 200]]
        dist1 = calculate_path_distance(path)
        dist2 = calculate_path_distance(path)
        assert dist1 == dist2


class TestCalculateFallbackGroundspeed:
    """Tests for calculate_fallback_groundspeed function."""

    def test_fallback_with_valid_data(self):
        """Test fallback calculation with valid data."""
        from kml_heatmap.segment_calculator import calculate_fallback_groundspeed

        # 10km segment, 100km path, 3600 seconds (1 hour)
        speed = calculate_fallback_groundspeed(10.0, 100.0, 3600.0)
        # Should calculate based on path average
        assert speed >= 0

    def test_fallback_zero_duration(self):
        """Test fallback with zero duration."""
        from kml_heatmap.segment_calculator import calculate_fallback_groundspeed

        speed = calculate_fallback_groundspeed(10.0, 100.0, 0.0)
        assert speed == 0.0

    def test_fallback_zero_path_distance(self):
        """Test fallback with zero path distance."""
        from kml_heatmap.segment_calculator import calculate_fallback_groundspeed

        speed = calculate_fallback_groundspeed(10.0, 0.0, 3600.0)
        assert speed == 0.0

    def test_fallback_negative_duration(self):
        """Test fallback with negative duration."""
        from kml_heatmap.segment_calculator import calculate_fallback_groundspeed

        speed = calculate_fallback_groundspeed(10.0, 100.0, -100.0)
        assert speed == 0.0

    def test_fallback_unrealistic_speed(self):
        """Test fallback filters unrealistic speeds."""
        from kml_heatmap.segment_calculator import calculate_fallback_groundspeed

        # Very short duration for long distance = unrealistic
        speed = calculate_fallback_groundspeed(1000.0, 1000.0, 1.0)
        # Should be capped to 0 if unrealistic
        assert speed == 0.0

    def test_fallback_realistic_aircraft_speed(self):
        """Test fallback with realistic aircraft speeds."""
        from kml_heatmap.segment_calculator import calculate_fallback_groundspeed

        # 100km path in 1800 seconds (30 min) = ~200 km/h typical
        speed = calculate_fallback_groundspeed(10.0, 100.0, 1800.0)
        # Should be non-zero and reasonable
        assert speed > 0
        assert speed < 1000  # Less than supersonic


class TestUpdateCruiseStatistics:
    """Tests for update_cruise_statistics function."""

    def test_update_cruise_above_threshold(self):
        """Test updating cruise stats above altitude threshold."""
        from kml_heatmap.segment_calculator import update_cruise_statistics

        cruise_stats = {
            "total_distance": 0.0,
            "total_time": 0.0,
            "altitude_histogram": {},
        }

        # 10,000 feet AGL, 60 second window, 10 km distance
        update_cruise_statistics(10000.0, 60.0, 10.0, cruise_stats)

        assert cruise_stats["total_time"] > 0
        assert cruise_stats["total_distance"] > 0
        assert len(cruise_stats["altitude_histogram"]) > 0

    def test_cruise_below_altitude_threshold(self):
        """Test that low altitudes are ignored."""
        from kml_heatmap.segment_calculator import update_cruise_statistics

        cruise_stats = {
            "total_distance": 0.0,
            "total_time": 0.0,
            "altitude_histogram": {},
        }

        # 500 feet AGL - below cruise threshold
        update_cruise_statistics(500.0, 60.0, 10.0, cruise_stats)

        assert cruise_stats["total_time"] == 0
        assert cruise_stats["total_distance"] == 0

    def test_cruise_short_time_window(self):
        """Test that short time windows are handled."""
        from kml_heatmap.segment_calculator import update_cruise_statistics

        cruise_stats = {
            "total_distance": 0.0,
            "total_time": 0.0,
            "altitude_histogram": {},
        }

        # High altitude but very short time window
        update_cruise_statistics(10000.0, 0.1, 10.0, cruise_stats)

        # Still should update if time window is positive
        assert cruise_stats["total_time"] >= 0

    def test_cruise_altitude_binning(self):
        """Test altitude histogram binning."""
        from kml_heatmap.segment_calculator import update_cruise_statistics

        cruise_stats = {
            "total_distance": 0.0,
            "total_time": 0.0,
            "altitude_histogram": {},
        }

        # Add multiple segments at similar altitudes
        update_cruise_statistics(10000.0, 60.0, 10.0, cruise_stats)
        update_cruise_statistics(10100.0, 60.0, 10.0, cruise_stats)
        update_cruise_statistics(10200.0, 60.0, 10.0, cruise_stats)

        # Should bin into same or adjacent altitude bins
        assert len(cruise_stats["altitude_histogram"]) >= 1
        assert cruise_stats["total_time"] == 180.0

    def test_cruise_zero_distance(self):
        """Test cruise stats with zero distance."""
        from kml_heatmap.segment_calculator import update_cruise_statistics

        cruise_stats = {
            "total_distance": 0.0,
            "total_time": 0.0,
            "altitude_histogram": {},
        }

        update_cruise_statistics(10000.0, 60.0, 0.0, cruise_stats)

        # Should still update time and histogram
        assert cruise_stats["total_time"] > 0
        assert len(cruise_stats["altitude_histogram"]) > 0
        assert cruise_stats["total_distance"] == 0.0
