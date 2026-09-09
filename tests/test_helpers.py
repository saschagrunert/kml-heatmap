"""Tests for helpers module."""

from datetime import UTC, datetime

import pytest

from kml_heatmap.helpers import (
    calculate_duration_seconds,
    format_flight_time,
    numeric_filename_key,
    parse_iso_timestamp,
    parse_timestamp_epoch,
)


class TestParseIsoTimestamp:
    def test_valid_zulu_time(self):
        result = parse_iso_timestamp("2025-03-15T14:30:00Z")
        assert result == datetime(2025, 3, 15, 14, 30, tzinfo=UTC)

    def test_valid_timezone_offset(self):
        result = parse_iso_timestamp("2025-03-15T14:30:00+01:00")
        assert result is not None
        assert result.utcoffset().total_seconds() == 3600

    def test_seven_digit_fraction(self):
        result = parse_iso_timestamp("2025-03-03T08:25:15.5848380Z")
        assert result is not None
        assert result.microsecond == 584838

    @pytest.mark.parametrize(
        "value",
        [
            "not a timestamp",
            "2025-03-15",
            "",
            "15/03/2025",
            None,
            "2025-13-45T25:99:99Z",
        ],
    )
    def test_invalid_returns_none(self, value):
        assert parse_iso_timestamp(value) is None


class TestParseTimestampEpoch:
    def test_zulu(self):
        assert parse_timestamp_epoch("1970-01-01T00:01:00Z") == 60.0

    def test_offset_is_applied(self):
        assert parse_timestamp_epoch("1970-01-01T01:00:00+01:00") == 0.0

    def test_naive_is_treated_as_utc(self):
        assert parse_timestamp_epoch("1970-01-01T00:00:10") == 10.0

    @pytest.mark.parametrize("value", ["invalid", "", None])
    def test_invalid_returns_none(self, value):
        assert parse_timestamp_epoch(value) is None


class TestCalculateDurationSeconds:
    def test_valid_duration(self):
        assert (
            calculate_duration_seconds("2025-03-15T14:00:00Z", "2025-03-15T16:30:00Z")
            == 9000
        )

    def test_same_timestamp(self):
        assert (
            calculate_duration_seconds("2025-03-15T14:00:00Z", "2025-03-15T14:00:00Z")
            == 0
        )

    def test_negative_duration(self):
        assert (
            calculate_duration_seconds("2025-03-15T16:00:00Z", "2025-03-15T14:00:00Z")
            == -7200
        )

    def test_naive_and_aware_mixed(self):
        assert (
            calculate_duration_seconds("2025-03-15T14:00:00", "2025-03-15T15:00:00Z")
            == 3600
        )

    @pytest.mark.parametrize(
        "start,end",
        [
            ("invalid", "2025-03-15T14:00:00Z"),
            ("2025-03-15T14:00:00Z", "invalid"),
            ("invalid", "also invalid"),
            (None, None),
            ("2025-03-15T14:00:00Z", None),
            (None, "2025-03-15T14:00:00Z"),
        ],
    )
    def test_invalid_inputs_give_zero(self, start, end):
        assert calculate_duration_seconds(start, end) == 0

    def test_one_day_duration(self):
        assert (
            calculate_duration_seconds("2025-03-15T00:00:00Z", "2025-03-16T00:00:00Z")
            == 86400
        )


class TestFormatFlightTime:
    @pytest.mark.parametrize(
        "seconds,expected",
        [
            (0, "0h 0m"),
            (-100, "0h 0m"),
            (45, "0h 0m"),
            (60, "0h 1m"),
            (1800, "0h 30m"),
            (3600, "1h 0m"),
            (3660, "1h 1m"),
            (3665, "1h 1m"),
            (9000, "2h 30m"),
            (360000, "100h 0m"),
        ],
    )
    def test_formatting(self, seconds, expected):
        assert format_flight_time(seconds) == expected


class TestNumericFilenameKey:
    def test_numeric_prefix_sorts_numerically(self):
        names = ["10_a.kml", "2_a.kml", "1_a.kml"]
        assert sorted(names, key=numeric_filename_key) == [
            "1_a.kml",
            "2_a.kml",
            "10_a.kml",
        ]

    def test_non_numeric_names_sort_after_numeric(self):
        names = ["b.kml", "3_a.kml", "a.kml"]
        assert sorted(names, key=numeric_filename_key) == ["3_a.kml", "a.kml", "b.kml"]

    def test_uses_basename(self):
        assert numeric_filename_key("/some/dir/7_x.kml") == (0, 7, "7_x.kml")
