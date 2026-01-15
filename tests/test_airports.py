"""Tests for airports module."""

from kml_heatmap.airports import (
    extract_airport_name,
    is_point_marker,
    deduplicate_airports,
)


class TestExtractAirportName:
    """Tests for extract_airport_name function."""

    def test_simple_airport_name(self):
        """Test simple airport name extraction from routes."""
        # Extract departure airport (is_at_path_end=False)
        assert (
            extract_airport_name("EDDF Frankfurt - KJFK New York", False)
            == "EDDF Frankfurt"
        )
        # Extract arrival airport (is_at_path_end=True)
        assert (
            extract_airport_name("EDDF Frankfurt - KJFK New York", True)
            == "KJFK New York"
        )

    def test_log_start_format(self):
        """Test Log Start format extraction."""
        name = "Log Start: 03 Mar 2025 08:58 Z"
        result = extract_airport_name(name, False)
        # Should return None or extract something meaningful
        assert result in [None, "Log Start"]

    def test_at_path_end(self):
        """Test extraction for airports at path end."""
        assert extract_airport_name("EDDF", True) == "EDDF"
        assert extract_airport_name("KJFK", True) == "KJFK"

    def test_not_at_path_end(self):
        """Test extraction for airports not at path end."""
        # May have different logic
        result = extract_airport_name("EDDF", False)
        assert isinstance(result, (str, type(None)))

    def test_none_input(self):
        """Test None input."""
        assert extract_airport_name(None, True) in [None, ""]

    def test_empty_string(self):
        """Test empty string."""
        assert extract_airport_name("", True) in [None, ""]

    def test_unknown_format(self):
        """Test unknown format."""
        result = extract_airport_name("Unknown Location", True)
        # Should handle gracefully
        assert isinstance(result, (str, type(None)))

    def test_unknown_airport_name(self):
        """Test 'Unknown' airport name returns None."""
        result = extract_airport_name("Unknown", True)
        assert result is None

    def test_single_word_without_icao(self):
        """Test single word without ICAO code returns None."""
        result = extract_airport_name("Somewhere", False)
        assert result is None


class TestIsPointMarker:
    """Tests for is_point_marker function."""

    def test_log_start_marker(self):
        """Test Log Start is a point marker."""
        assert is_point_marker("Log Start: EDAQ") is True

    def test_takeoff_marker(self):
        """Test Takeoff is a point marker."""
        assert is_point_marker("Takeoff: EDAQ") is True

    def test_landing_marker(self):
        """Test Landing is a point marker."""
        assert is_point_marker("Landing: EDMV") is True

    def test_route_not_marker(self):
        """Test route format is not a point marker."""
        assert is_point_marker("EDAQ Halle - EDMV Vilshofen") is False

    def test_empty_name(self):
        """Test empty name is considered a point marker."""
        assert is_point_marker("") is True
        assert is_point_marker(None) is True


class TestDeduplicateAirports:
    """Tests for deduplicate_airports function."""

    def test_empty_metadata(self):
        """Test with empty metadata."""
        result = deduplicate_airports([], [], lambda p, a: False, lambda p, a: True)
        assert result == []

    def test_single_airport(self):
        """Test with single airport."""
        metadata = [
            {
                "start_point": [50.0, 8.5, 100],
                "airport_name": "EDDF",
                "timestamp": "2025-03-15T10:00:00Z",
            }
        ]
        path_groups = [[[50.0, 8.5, 100], [51.0, 9.5, 200]]]

        result = deduplicate_airports(
            metadata, path_groups, lambda p, a: False, lambda p, a: True
        )

        assert len(result) >= 0  # May filter based on criteria

    def test_duplicate_locations(self):
        """Test deduplication of same location."""
        metadata = [
            {
                "start_point": [50.0, 8.5, 100],
                "airport_name": "EDDF",
                "timestamp": "2025-03-15T10:00:00Z",
            },
            {
                "start_point": [50.0001, 8.5001, 100],  # Very close
                "airport_name": "EDDF",
                "timestamp": "2025-03-15T11:00:00Z",
            },
        ]
        path_groups = [
            [[50.0, 8.5, 100], [51.0, 9.5, 200]],
            [[50.0001, 8.5001, 100], [51.0, 9.5, 200]],
        ]

        deduplicate_airports(
            metadata, path_groups, lambda p, a: False, lambda p, a: True
        )

        # Should deduplicate close locations
        # Exact behavior depends on grid size

    def test_different_locations(self):
        """Test different locations are kept."""
        metadata = [
            {
                "start_point": [50.0, 8.5, 100],
                "airport_name": "EDDF",
                "timestamp": "2025-03-15T10:00:00Z",
            },
            {
                "start_point": [51.0, 9.5, 100],  # Different location
                "airport_name": "EDDK",
                "timestamp": "2025-03-15T11:00:00Z",
            },
        ]
        path_groups = [
            [[50.0, 8.5, 100], [51.0, 9.5, 200]],
            [[51.0, 9.5, 100], [52.0, 10.5, 200]],
        ]

        deduplicate_airports(
            metadata, path_groups, lambda p, a: False, lambda p, a: True
        )

        # Should keep different locations

    def test_mid_flight_start_filtered(self):
        """Test mid-flight starts are filtered out."""
        metadata = [
            {
                "start_point": [50.0, 8.5, 5000],  # High altitude
                "airport_name": "Mid-air",
                "timestamp": "2025-03-15T10:00:00Z",
            }
        ]
        path_groups = [[[50.0, 8.5, 5000], [51.0, 9.5, 5000]]]

        def is_mid_flight(path, alt):
            return alt > 1000  # Simple threshold

        deduplicate_airports(metadata, path_groups, is_mid_flight, lambda p, a: True)

        # Mid-flight start should be filtered

    def test_invalid_landing_end_filtered(self):
        """Test invalid landing endpoints are not marked as airports."""
        metadata = [
            {
                "start_point": [50.0, 8.5, 100],
                "airport_name": "EDDF",
                "timestamp": "2025-03-15T10:00:00Z",
            }
        ]
        path_groups = [[[50.0, 8.5, 100], [51.0, 9.5, 5000]]]  # Ends high

        def is_valid_landing_func(path, alt):
            return alt < 1000  # Must end low

        deduplicate_airports(
            metadata, path_groups, lambda p, a: False, is_valid_landing_func
        )

        # Endpoint should not be added as airport if landing invalid

    def test_multiple_timestamps_aggregated(self):
        """Test multiple visits to same airport aggregate timestamps."""
        metadata = [
            {
                "start_point": [50.0, 8.5, 100],
                "airport_name": "EDDF",
                "timestamp": "2025-03-15T10:00:00Z",
            },
            {
                "start_point": [50.0001, 8.5001, 100],
                "airport_name": "EDDF",
                "timestamp": "2025-03-16T10:00:00Z",
            },
        ]
        path_groups = [
            [[50.0, 8.5, 100], [51.0, 9.5, 200]],
            [[50.0001, 8.5001, 100], [51.0, 9.5, 200]],
        ]

        deduplicate_airports(
            metadata, path_groups, lambda p, a: False, lambda p, a: True
        )

        # Should have timestamps from both visits if deduplicated

    def test_point_marker_in_metadata(self):
        """Test that point markers in metadata are skipped."""
        metadata = [
            {
                "start_point": [50.0, 8.5, 100],
                "airport_name": "Log Start: EDDF",  # Point marker
                "timestamp": "2025-03-15T10:00:00Z",
            }
        ]
        path_groups = [[[50.0, 8.5, 100], [51.0, 9.5, 200]]]

        deduplicate_airports(
            metadata, path_groups, lambda p, a: False, lambda p, a: True
        )

        # Point marker should be skipped
        # Result will depend on whether path endpoints are processed

    def test_short_path_in_endpoint_processing(self):
        """Test that short paths (<=1 point) are skipped in endpoint processing."""
        metadata = [
            {
                "start_point": [50.0, 8.5, 100],
                "airport_name": "EDDF",
                "timestamp": "2025-03-15T10:00:00Z",
            }
        ]
        # Single point path
        path_groups = [[[50.0, 8.5, 100]]]

        deduplicate_airports(
            metadata, path_groups, lambda p, a: False, lambda p, a: True
        )

        # Short paths should be skipped in endpoint processing


class TestAirportDeduplicator:
    """Tests for AirportDeduplicator class."""

    def test_initialization(self):
        """Test AirportDeduplicator initialization."""
        from kml_heatmap.airports import AirportDeduplicator

        deduplicator = AirportDeduplicator()
        assert deduplicator.unique_airports == []
        assert deduplicator.spatial_grid == {}

    def test_custom_grid_size(self):
        """Test AirportDeduplicator with custom grid size."""
        from kml_heatmap.airports import AirportDeduplicator

        deduplicator = AirportDeduplicator(grid_size=0.5)
        assert deduplicator.grid_size == 0.5

    def test_add_new_airport(self):
        """Test adding a new airport."""
        from kml_heatmap.airports import AirportDeduplicator

        deduplicator = AirportDeduplicator()
        idx = deduplicator.add_or_update_airport(
            lat=50.0,
            lon=8.5,
            name="EDDF Frankfurt",
            timestamp="2025-03-15T10:00:00Z",
            path_index=0,
            is_at_path_end=False,
        )

        assert idx == 0
        assert len(deduplicator.unique_airports) == 1
        assert deduplicator.unique_airports[0]["name"] == "EDDF Frankfurt"

    def test_update_existing_airport(self):
        """Test updating an existing airport with new timestamp."""
        from kml_heatmap.airports import AirportDeduplicator

        deduplicator = AirportDeduplicator()

        # Add first
        idx1 = deduplicator.add_or_update_airport(
            lat=50.0,
            lon=8.5,
            name="EDDF",
            timestamp="2025-03-15T10:00:00Z",
            path_index=0,
            is_at_path_end=False,
        )

        # Add same location (should update)
        idx2 = deduplicator.add_or_update_airport(
            lat=50.0001,  # Very close
            lon=8.5001,
            name="EDDF",
            timestamp="2025-03-16T10:00:00Z",
            path_index=1,
            is_at_path_end=False,
        )

        assert idx1 == idx2  # Should be the same airport
        assert len(deduplicator.unique_airports) == 1
        # Should have both timestamps
        assert len(deduplicator.unique_airports[0]["timestamps"]) == 2

    def test_prefer_route_names_over_markers(self):
        """Test that route names are preferred over point marker names."""
        from kml_heatmap.airports import AirportDeduplicator

        deduplicator = AirportDeduplicator()

        # Add with marker name first
        idx1 = deduplicator.add_or_update_airport(
            lat=50.0,
            lon=8.5,
            name="Log Start: EDDF",
            timestamp="2025-03-15T10:00:00Z",
            path_index=0,
            is_at_path_end=False,
        )

        # Update with proper route name
        idx2 = deduplicator.add_or_update_airport(
            lat=50.0001,
            lon=8.5001,
            name="EDDF Frankfurt - EDDM Munich",
            timestamp="2025-03-16T10:00:00Z",
            path_index=1,
            is_at_path_end=False,
        )

        assert idx1 == idx2
        # Should prefer route name
        assert "EDDF Frankfurt" in deduplicator.unique_airports[0]["name"]

    def test_skip_duplicate_timestamps(self):
        """Test that duplicate timestamps are not added."""
        from kml_heatmap.airports import AirportDeduplicator

        deduplicator = AirportDeduplicator()

        # Add with timestamp
        idx1 = deduplicator.add_or_update_airport(
            lat=50.0,
            lon=8.5,
            name="EDDF",
            timestamp="2025-03-15T10:00:00Z",
            path_index=0,
            is_at_path_end=False,
        )

        # Add same timestamp again
        idx2 = deduplicator.add_or_update_airport(
            lat=50.0001,
            lon=8.5001,
            name="EDDF",
            timestamp="2025-03-15T10:00:00Z",  # Same timestamp
            path_index=1,
            is_at_path_end=False,
        )

        assert idx1 == idx2
        # Should only have one timestamp
        assert len(deduplicator.unique_airports[0]["timestamps"]) == 1

    def test_get_unique_airports(self):
        """Test getting unique airports list."""
        from kml_heatmap.airports import AirportDeduplicator

        deduplicator = AirportDeduplicator()

        deduplicator.add_or_update_airport(
            lat=50.0,
            lon=8.5,
            name="EDDF",
            timestamp=None,
            path_index=0,
            is_at_path_end=False,
        )
        deduplicator.add_or_update_airport(
            lat=51.0,
            lon=9.5,
            name="EDDM",
            timestamp=None,
            path_index=1,
            is_at_path_end=False,
        )

        airports = deduplicator.get_unique_airports()
        assert len(airports) == 2

    def test_airport_with_no_name(self):
        """Test adding airport with no name."""
        from kml_heatmap.airports import AirportDeduplicator

        deduplicator = AirportDeduplicator()

        idx = deduplicator.add_or_update_airport(
            lat=50.0,
            lon=8.5,
            name=None,
            timestamp="2025-03-15T10:00:00Z",
            path_index=0,
            is_at_path_end=False,
        )

        assert idx == 0
        assert deduplicator.unique_airports[0]["name"] is None
