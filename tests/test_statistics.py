"""Tests for statistics module."""

import pytest
from kml_heatmap.statistics import (
    calculate_statistics,
    calculate_flight_time,
    extract_timestamps_from_path,
    calculate_basic_stats,
    calculate_altitude_stats,
    aggregate_aircraft_stats,
)


class TestCalculateFlightTime:
    """Tests for calculate_flight_time function."""

    def test_empty_paths(self):
        """Test with empty path list."""
        result = calculate_flight_time([])
        assert result["total_seconds"] == 0
        assert result["paths_with_timestamps"] == 0

    def test_paths_without_timestamps(self):
        """Test paths without timestamp data."""
        paths = [
            [[50.0, 8.5, 100], [51.0, 9.5, 200]],
            [[52.0, 10.5, 300], [53.0, 11.5, 400]],
        ]
        result = calculate_flight_time(paths)
        assert result["total_seconds"] == 0
        assert result["paths_with_timestamps"] == 0

    def test_paths_with_timestamps(self):
        """Test paths with timestamp data."""
        paths = [
            [
                [50.0, 8.5, 100, "2025-03-15T10:00:00Z"],
                [50.1, 8.6, 150, "2025-03-15T10:30:00Z"],
                [50.2, 8.7, 200, "2025-03-15T11:00:00Z"],
            ],
        ]
        result = calculate_flight_time(paths)
        assert result["total_seconds"] == 3600  # 1 hour
        assert result["paths_with_timestamps"] == 1

    def test_multiple_paths_with_timestamps(self):
        """Test multiple paths with timestamps."""
        paths = [
            [
                [50.0, 8.5, 100, "2025-03-15T10:00:00Z"],
                [50.1, 8.6, 150, "2025-03-15T11:00:00Z"],
            ],
            [
                [51.0, 9.5, 200, "2025-03-15T14:00:00Z"],
                [51.1, 9.6, 250, "2025-03-15T15:00:00Z"],
            ],
        ]
        result = calculate_flight_time(paths)
        assert result["total_seconds"] == 7200  # 2 hours total
        assert result["paths_with_timestamps"] == 2

    def test_mixed_paths(self):
        """Test mix of paths with and without timestamps."""
        paths = [
            [
                [50.0, 8.5, 100, "2025-03-15T10:00:00Z"],
                [50.1, 8.6, 150, "2025-03-15T11:00:00Z"],
            ],
            [[51.0, 9.5, 200], [51.1, 9.6, 250]],  # No timestamps
        ]
        result = calculate_flight_time(paths)
        assert result["total_seconds"] == 3600  # Only first path counted
        assert result["paths_with_timestamps"] == 1


class TestCalculateStatistics:
    """Tests for calculate_statistics function."""

    def test_empty_data(self):
        """Test with no data."""
        stats = calculate_statistics([], [], [])
        assert stats["total_points"] == 0
        assert stats["total_distance_km"] == 0

    def test_single_point(self):
        """Test with single coordinate."""
        coords = [[50.0, 8.5]]
        paths = []
        metadata = []
        stats = calculate_statistics(coords, paths, metadata)
        assert stats["total_points"] == 1
        assert stats["total_distance_km"] == 0

    def test_distance_calculation(self):
        """Test distance calculation between points."""
        # Two points ~111km apart (1 degree latitude)
        coords = [[50.0, 8.5], [51.0, 8.5]]
        paths = [[[50.0, 8.5, 100], [51.0, 8.5, 100]]]
        metadata = [{}]
        stats = calculate_statistics(coords, paths, metadata)
        assert stats["total_distance_km"] > 100
        assert stats["total_distance_km"] < 120

    def test_altitude_statistics(self):
        """Test altitude min/max calculation."""
        coords = [[50.0, 8.5], [51.0, 9.5]]
        paths = [[[50.0, 8.5, 100], [50.5, 9.0, 500], [51.0, 9.5, 200]]]
        metadata = [{}]
        stats = calculate_statistics(coords, paths, metadata)
        assert stats["min_altitude_m"] == 100
        assert stats["max_altitude_m"] == 500

    def test_altitude_gain_calculation(self):
        """Test total altitude gain calculation."""
        coords = [[50.0, 8.5], [51.0, 9.5]]
        paths = [[[50.0, 8.5, 100], [50.5, 9.0, 300], [51.0, 9.5, 500]]]
        metadata = [{}]
        stats = calculate_statistics(coords, paths, metadata)
        # Total gain should be (300-100) + (500-300) = 400m
        assert stats["total_altitude_gain_m"] >= 400

    def test_no_altitude_data(self):
        """Test with paths without altitude."""
        coords = [[50.0, 8.5], [51.0, 9.5]]
        paths = []  # No paths with altitude
        metadata = []
        calculate_statistics(coords, paths, metadata)
        # Should handle missing altitude gracefully

    def test_metric_conversions(self):
        """Test that metric conversions are present."""
        coords = [[50.0, 8.5], [51.0, 9.5]]
        paths = [[[50.0, 8.5, 1000], [51.0, 9.5, 2000]]]
        metadata = [{}]
        stats = calculate_statistics(coords, paths, metadata)

        # Check conversions exist
        assert "min_altitude_ft" in stats
        assert "max_altitude_ft" in stats
        assert "total_distance_nm" in stats
        assert "total_altitude_gain_ft" in stats

        # Check conversion accuracy
        assert stats["min_altitude_ft"] == pytest.approx(
            stats["min_altitude_m"] * 3.28084, abs=1
        )
        assert stats["max_altitude_ft"] == pytest.approx(
            stats["max_altitude_m"] * 3.28084, abs=1
        )

    def test_path_count(self):
        """Test path counting."""
        coords = [[50.0, 8.5], [51.0, 9.5], [52.0, 10.5]]
        paths = [
            [[50.0, 8.5, 100], [50.5, 9.0, 150]],
            [[51.0, 9.5, 200], [51.5, 10.0, 250]],
            [[52.0, 10.5, 300], [52.5, 11.0, 350]],
        ]
        # Provide metadata with airport names (not point markers)
        metadata = [
            {"airport_name": "EDDF - KJFK"},
            {"airport_name": "EGLL - LFPG"},
            {"airport_name": "EHAM - EDDK"},
        ]
        stats = calculate_statistics(coords, paths, metadata)
        assert stats["num_paths"] == 3

    def test_flight_time_integration(self):
        """Test flight time calculation integration."""
        coords = [[50.0, 8.5]]
        paths = [
            [
                [50.0, 8.5, 100, "2025-03-15T10:00:00Z"],
                [50.1, 8.6, 150, "2025-03-15T11:00:00Z"],
            ]
        ]
        metadata = [{}]
        stats = calculate_statistics(coords, paths, metadata)
        assert "total_flight_time_seconds" in stats
        assert "total_flight_time_str" in stats
        assert stats["total_flight_time_seconds"] > 0

    def test_multiple_paths_distance(self):
        """Test total distance with multiple paths."""
        coords = [[50.0, 8.5], [51.0, 9.5]]
        paths = [
            [[50.0, 8.5, 100], [50.5, 9.0, 200]],
            [[50.5, 9.0, 200], [51.0, 9.5, 300]],
        ]
        metadata = [{}, {}]
        stats = calculate_statistics(coords, paths, metadata)
        # Total distance should be sum of both paths
        assert stats["total_distance_km"] > 0

    def test_no_metadata_fallback(self):
        """Test statistics calculation without metadata (fallback mode)."""
        coords = [[50.0, 8.5], [51.0, 9.5]]
        paths = [
            [[50.0, 8.5, 100], [51.0, 9.5, 200]],
            [[52.0, 10.5, 300], [53.0, 11.5, 400]],
        ]
        # No metadata provided (None)
        stats = calculate_statistics(coords, paths, None)
        # Should count all paths when no metadata
        assert stats["num_paths"] == 2

    def test_groundspeed_calculation(self):
        """Test average groundspeed calculation."""
        coords = [[50.0, 8.5], [51.0, 9.5]]
        # Path with timestamps to enable speed calculation
        paths = [
            [
                [50.0, 8.5, 100, "2025-03-15T10:00:00Z"],
                [51.0, 9.5, 200, "2025-03-15T11:00:00Z"],
            ]
        ]
        metadata = [{"airport_name": "EDDF - KJFK"}]
        stats = calculate_statistics(coords, paths, metadata)
        # Should have calculated average groundspeed
        assert stats["average_groundspeed_knots"] > 0

    def test_with_aircraft_metadata(self):
        """Test statistics with aircraft metadata integration."""
        coords = [[50.0, 8.5], [51.0, 9.5]]
        paths = [[[50.0, 8.5, 100], [51.0, 9.5, 200]]]
        metadata = [
            {
                "airport_name": "EDDF - KJFK",
                "aircraft_registration": "D-EAGJ",
                "aircraft_type": "DA20",
                "filename": "flight1.kml",
            }
        ]
        stats = calculate_statistics(coords, paths, metadata)
        # Should include aircraft stats
        assert "num_aircraft" in stats
        assert "aircraft_types" in stats
        assert "aircraft_list" in stats
        assert stats["num_aircraft"] == 1

    def test_all_short_paths(self):
        """Test with all paths being too short (< 2 points)."""
        coords = [[50.0, 8.5]]
        # All paths have only 1 point
        paths = [[[50.0, 8.5, 100]], [[51.0, 9.5, 200]]]
        metadata = [{}, {}]
        stats = calculate_statistics(coords, paths, metadata)
        # Should return early with no valid paths
        assert stats["total_distance_km"] == 0
        assert stats["min_altitude_m"] is None


class TestExtractTimestampsFromPath:
    """Tests for extract_timestamps_from_path function."""

    def test_empty_path(self):
        """Test with empty path."""
        result = extract_timestamps_from_path([])
        assert result == []

    def test_path_without_timestamps(self):
        """Test path with only 3 coordinates (no timestamp)."""
        path = [[50.0, 8.5, 100], [51.0, 9.5, 200]]
        result = extract_timestamps_from_path(path)
        assert result == []

    def test_path_with_iso_timestamps(self):
        """Test path with ISO format timestamps."""
        path = [
            [50.0, 8.5, 100, "2025-03-15T10:00:00Z"],
            [50.1, 8.6, 150, "2025-03-15T10:30:00Z"],
        ]
        result = extract_timestamps_from_path(path)
        assert len(result) == 2
        assert result[0] < result[1]

    def test_path_with_unix_timestamps(self):
        """Test path with Unix timestamps."""
        path = [
            [50.0, 8.5, 100, 1710500000.0],
            [50.1, 8.6, 150, 1710501800.0],
        ]
        result = extract_timestamps_from_path(path)
        assert len(result) == 2
        assert result[0] == 1710500000.0
        assert result[1] == 1710501800.0

    def test_path_with_invalid_timestamp_strings(self):
        """Test path with invalid ISO timestamp strings."""
        path = [
            [50.0, 8.5, 100, "invalid"],
            [50.1, 8.6, 150, "2025-03-15T10:30:00Z"],
        ]
        result = extract_timestamps_from_path(path)
        # Invalid timestamp should be skipped
        assert len(result) == 1

    def test_path_with_none_timestamps(self):
        """Test path with None timestamps."""
        path = [
            [50.0, 8.5, 100, None],
            [50.1, 8.6, 150, None],
        ]
        result = extract_timestamps_from_path(path)
        assert result == []

    def test_mixed_timestamp_formats(self):
        """Test path with mix of timestamp formats."""
        path = [
            [50.0, 8.5, 100, 1710500000.0],
            [50.1, 8.6, 150, "2025-03-15T10:30:00Z"],
            [50.2, 8.7, 200, 1710503600.0],
        ]
        result = extract_timestamps_from_path(path)
        assert len(result) == 3


class TestCalculateBasicStats:
    """Tests for calculate_basic_stats function."""

    def test_empty_paths(self):
        """Test with empty path list."""
        result = calculate_basic_stats([])
        assert result["total_distance_km"] == 0.0
        assert result["total_altitude_gain_m"] == 0.0

    def test_single_path_flat(self):
        """Test single path with no altitude change."""
        paths = [[[50.0, 8.5, 100], [51.0, 9.5, 100]]]
        result = calculate_basic_stats(paths)
        assert result["total_distance_km"] > 0
        assert result["total_altitude_gain_m"] == 0.0

    def test_altitude_gain_only(self):
        """Test that only positive altitude changes are counted."""
        paths = [
            [[50.0, 8.5, 100], [50.1, 8.6, 300], [50.2, 8.7, 200], [50.3, 8.8, 400]]
        ]
        result = calculate_basic_stats(paths)
        # Gain: 200 (100->300) + 200 (200->400) = 400m
        assert result["total_altitude_gain_m"] == pytest.approx(400.0)

    def test_multiple_paths(self):
        """Test multiple paths accumulate distance and altitude."""
        paths = [
            [[50.0, 8.5, 100], [50.5, 9.0, 200]],
            [[51.0, 9.5, 300], [51.5, 10.0, 400]],
        ]
        result = calculate_basic_stats(paths)
        assert result["total_distance_km"] > 0
        assert result["total_altitude_gain_m"] == pytest.approx(200.0)


class TestCalculateAltitudeStats:
    """Tests for calculate_altitude_stats function."""

    def test_empty_paths(self):
        """Test with empty path list."""
        result = calculate_altitude_stats([])
        assert result["min_altitude_m"] is None
        assert result["max_altitude_m"] is None
        assert result["min_altitude_ft"] is None
        assert result["max_altitude_ft"] is None

    def test_single_altitude(self):
        """Test with single altitude value."""
        paths = [[[50.0, 8.5, 1000]]]
        result = calculate_altitude_stats(paths)
        assert result["min_altitude_m"] == 1000
        assert result["max_altitude_m"] == 1000
        assert result["min_altitude_ft"] == pytest.approx(1000 * 3.28084, abs=0.1)
        assert result["max_altitude_ft"] == pytest.approx(1000 * 3.28084, abs=0.1)

    def test_multiple_altitudes(self):
        """Test with varying altitudes."""
        paths = [
            [[50.0, 8.5, 100], [50.1, 8.6, 500], [50.2, 8.7, 200]],
            [[51.0, 9.5, 1000], [51.1, 9.6, 50]],
        ]
        result = calculate_altitude_stats(paths)
        assert result["min_altitude_m"] == 50
        assert result["max_altitude_m"] == 1000

    def test_negative_altitudes(self):
        """Test with negative altitudes (below sea level)."""
        paths = [[[50.0, 8.5, -50], [50.1, 8.6, 100]]]
        result = calculate_altitude_stats(paths)
        assert result["min_altitude_m"] == -50
        assert result["max_altitude_m"] == 100


class TestAggregateAircraftStats:
    """Tests for aggregate_aircraft_stats function."""

    def test_empty_metadata(self):
        """Test with empty metadata."""
        result = aggregate_aircraft_stats([], [])
        assert result["num_aircraft"] == 0
        assert result["aircraft_types"] == []
        assert result["aircraft_list"] == []

    def test_single_aircraft_no_registration(self):
        """Test with metadata but no registration."""
        metadata = [{"airport_name": "EDDF - KJFK"}]
        paths = [[[50.0, 8.5, 100], [51.0, 9.5, 200]]]
        result = aggregate_aircraft_stats(metadata, paths)
        assert result["num_aircraft"] == 0

    def test_single_aircraft_with_registration(self):
        """Test single aircraft with registration."""
        metadata = [
            {
                "aircraft_registration": "D-EAGJ",
                "aircraft_type": "DA20",
                "filename": "flight1.kml",
            }
        ]
        paths = [[[50.0, 8.5, 100], [51.0, 9.5, 200]]]
        result = aggregate_aircraft_stats(metadata, paths)
        assert result["num_aircraft"] == 1
        assert "DA20" in result["aircraft_types"]
        assert len(result["aircraft_list"]) == 1
        assert result["aircraft_list"][0]["registration"] == "D-EAGJ"
        assert result["aircraft_list"][0]["flights"] == 1

    def test_multiple_flights_same_aircraft(self):
        """Test multiple flights with same aircraft."""
        metadata = [
            {
                "aircraft_registration": "D-EAGJ",
                "aircraft_type": "DA20",
                "filename": "flight1.kml",
            },
            {
                "aircraft_registration": "D-EAGJ",
                "aircraft_type": "DA20",
                "filename": "flight2.kml",
            },
        ]
        paths = [
            [[50.0, 8.5, 100], [51.0, 9.5, 200]],
            [[52.0, 10.5, 300], [53.0, 11.5, 400]],
        ]
        result = aggregate_aircraft_stats(metadata, paths)
        assert result["num_aircraft"] == 1
        assert result["aircraft_list"][0]["flights"] == 2

    def test_duplicate_filename_not_counted_twice(self):
        """Test that duplicate filenames are not counted twice."""
        metadata = [
            {
                "aircraft_registration": "D-EAGJ",
                "aircraft_type": "DA20",
                "filename": "flight1.kml",
            },
            {
                "aircraft_registration": "D-EAGJ",
                "aircraft_type": "DA20",
                "filename": "flight1.kml",
            },
        ]
        paths = [
            [[50.0, 8.5, 100], [51.0, 9.5, 200]],
            [[52.0, 10.5, 300], [53.0, 11.5, 400]],
        ]
        result = aggregate_aircraft_stats(metadata, paths)
        assert result["aircraft_list"][0]["flights"] == 1

    def test_multiple_aircraft(self):
        """Test multiple different aircraft."""
        metadata = [
            {
                "aircraft_registration": "D-EAGJ",
                "aircraft_type": "DA20",
                "filename": "flight1.kml",
            },
            {
                "aircraft_registration": "D-EHYL",
                "aircraft_type": "DA40",
                "filename": "flight2.kml",
            },
        ]
        paths = [
            [[50.0, 8.5, 100], [51.0, 9.5, 200]],
            [[52.0, 10.5, 300], [53.0, 11.5, 400]],
        ]
        result = aggregate_aircraft_stats(metadata, paths)
        assert result["num_aircraft"] == 2
        assert len(result["aircraft_types"]) == 2

    def test_aircraft_with_timestamps(self):
        """Test aircraft flight time calculation with timestamps."""
        metadata = [
            {
                "aircraft_registration": "D-EAGJ",
                "aircraft_type": "DA20",
                "filename": "flight1.kml",
            }
        ]
        paths = [
            [
                [50.0, 8.5, 100, "2025-03-15T10:00:00Z"],
                [51.0, 9.5, 200, "2025-03-15T11:00:00Z"],
            ]
        ]
        result = aggregate_aircraft_stats(metadata, paths)
        assert result["aircraft_list"][0]["flight_time_seconds"] == 3600
        assert result["aircraft_list"][0]["flight_time_str"] is not None

    def test_aircraft_sorted_by_flights(self):
        """Test aircraft are sorted by flight count."""
        metadata = [
            {
                "aircraft_registration": "D-EAGJ",
                "aircraft_type": "DA20",
                "filename": "flight1.kml",
            },
            {
                "aircraft_registration": "D-EHYL",
                "aircraft_type": "DA40",
                "filename": "flight2.kml",
            },
            {
                "aircraft_registration": "D-EHYL",
                "aircraft_type": "DA40",
                "filename": "flight3.kml",
            },
        ]
        paths = [
            [[50.0, 8.5, 100], [51.0, 9.5, 200]],
            [[52.0, 10.5, 300], [53.0, 11.5, 400]],
            [[54.0, 12.5, 500], [55.0, 13.5, 600]],
        ]
        result = aggregate_aircraft_stats(metadata, paths)
        # D-EHYL has 2 flights, D-EAGJ has 1, so D-EHYL should be first
        assert result["aircraft_list"][0]["registration"] == "D-EHYL"
        assert result["aircraft_list"][0]["flights"] == 2
        assert result["aircraft_list"][1]["registration"] == "D-EAGJ"
        assert result["aircraft_list"][1]["flights"] == 1

    def test_aircraft_type_without_registration(self):
        """Test aircraft type is collected even without registration."""
        metadata = [{"aircraft_type": "C172"}]
        paths = [[[50.0, 8.5, 100], [51.0, 9.5, 200]]]
        result = aggregate_aircraft_stats(metadata, paths)
        assert "C172" in result["aircraft_types"]

    def test_short_path_skipped_in_flight_time(self):
        """Test that short paths are skipped in flight time calculation."""
        metadata = [
            {
                "aircraft_registration": "D-EAGJ",
                "aircraft_type": "DA20",
                "filename": "flight1.kml",
            }
        ]
        # Path with only 1 point (too short)
        paths = [[[50.0, 8.5, 100, "2025-03-15T10:00:00Z"]]]
        result = aggregate_aircraft_stats(metadata, paths)
        assert result["aircraft_list"][0]["flight_time_seconds"] == 0

    def test_aircraft_no_type_and_lookup_fails(self):
        """Test aircraft without type when lookup fails."""
        metadata = [
            {
                "aircraft_registration": "D-XXXX",
                "filename": "flight1.kml",
                # No aircraft_type provided
            }
        ]
        paths = [[[50.0, 8.5, 100], [51.0, 9.5, 200]]]
        result = aggregate_aircraft_stats(metadata, paths)
        # Should still create aircraft entry, model will be None
        assert len(result["aircraft_list"]) == 1
        assert result["aircraft_list"][0]["type"] is None
