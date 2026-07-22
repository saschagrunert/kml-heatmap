"""Tests for helpers module."""

from datetime import datetime
from kml_heatmap.helpers import (
    parse_iso_timestamp,
    calculate_duration_seconds,
    format_flight_time,
)


class TestParseIsoTimestamp:
    """Tests for parse_iso_timestamp function."""

    def test_valid_zulu_time(self):
        """Test parsing valid Zulu time format."""
        result = parse_iso_timestamp("2025-03-15T14:30:00Z")
        assert isinstance(result, datetime)
        assert result.year == 2025
        assert result.month == 3
        assert result.day == 15
        assert result.hour == 14
        assert result.minute == 30
        assert result.second == 0

    def test_valid_timezone_offset(self):
        """Test parsing with timezone offset."""
        result = parse_iso_timestamp("2025-03-15T14:30:00+01:00")
        assert isinstance(result, datetime)
        assert result.year == 2025

    def test_invalid_format(self):
        """Test parsing invalid format returns None."""
        assert parse_iso_timestamp("not a timestamp") is None
        assert parse_iso_timestamp("2025-03-15") is None  # No T separator
        assert parse_iso_timestamp("") is None
        assert parse_iso_timestamp("15/03/2025") is None

    def test_none_input(self):
        """Test None input returns None."""
        assert parse_iso_timestamp(None) is None

    def test_empty_string(self):
        """Test empty string returns None."""
        assert parse_iso_timestamp("") is None

    def test_malformed_datetime(self):
        """Test malformed datetime string."""
        assert parse_iso_timestamp("2025-13-45T25:99:99Z") is None


class TestCalculateDurationSeconds:
    """Tests for calculate_duration_seconds function."""

    def test_valid_duration(self):
        """Test calculating valid duration."""
        duration = calculate_duration_seconds(
            "2025-03-15T14:00:00Z", "2025-03-15T16:30:00Z"
        )
        assert duration == 9000  # 2.5 hours

    def test_same_timestamp(self):
        """Test same start and end timestamp."""
        duration = calculate_duration_seconds(
            "2025-03-15T14:00:00Z", "2025-03-15T14:00:00Z"
        )
        assert duration == 0

    def test_negative_duration(self):
        """Test end before start (negative duration)."""
        duration = calculate_duration_seconds(
            "2025-03-15T16:00:00Z", "2025-03-15T14:00:00Z"
        )
        assert duration == -7200  # -2 hours

    def test_invalid_start(self):
        """Test with invalid start timestamp."""
        duration = calculate_duration_seconds("invalid", "2025-03-15T14:00:00Z")
        assert duration == 0

    def test_invalid_end(self):
        """Test with invalid end timestamp."""
        duration = calculate_duration_seconds("2025-03-15T14:00:00Z", "invalid")
        assert duration == 0

    def test_both_invalid(self):
        """Test with both timestamps invalid."""
        duration = calculate_duration_seconds("invalid", "also invalid")
        assert duration == 0

    def test_none_inputs(self):
        """Test with None inputs."""
        assert calculate_duration_seconds(None, None) == 0
        assert calculate_duration_seconds("2025-03-15T14:00:00Z", None) == 0
        assert calculate_duration_seconds(None, "2025-03-15T14:00:00Z") == 0

    def test_one_day_duration(self):
        """Test duration of exactly one day."""
        duration = calculate_duration_seconds(
            "2025-03-15T00:00:00Z", "2025-03-16T00:00:00Z"
        )
        assert duration == 86400  # 24 hours


class TestFormatFlightTime:
    """Tests for format_flight_time function."""

    def test_zero_seconds(self):
        """Test formatting zero seconds."""
        assert format_flight_time(0) == "---"

    def test_negative_seconds(self):
        """Test formatting negative seconds."""
        assert format_flight_time(-100) == "---"

    def test_only_minutes(self):
        """Test formatting time with only minutes."""
        assert format_flight_time(1800) == "30m"  # 30 minutes
        assert format_flight_time(60) == "1m"  # 1 minute

    def test_hours_and_minutes(self):
        """Test formatting time with hours and minutes."""
        assert format_flight_time(9000) == "2h 30m"  # 2.5 hours
        assert format_flight_time(3600) == "1h 0m"  # 1 hour exactly
        assert format_flight_time(3660) == "1h 1m"  # 1 hour 1 minute

    def test_seconds_truncated(self):
        """Test that seconds are truncated, not rounded."""
        assert format_flight_time(3665) == "1h 1m"  # 1h 1m 5s -> 1h 1m
        assert format_flight_time(125) == "2m"  # 2m 5s -> 2m

    def test_large_hours(self):
        """Test formatting large number of hours."""
        assert format_flight_time(360000) == "100h 0m"  # 100 hours

    def test_less_than_minute(self):
        """Test formatting less than one minute."""
        assert format_flight_time(45) == "0m"
