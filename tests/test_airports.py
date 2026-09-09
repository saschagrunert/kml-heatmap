"""Tests for airports module."""

import pytest

from kml_heatmap.airports import (
    AirportDeduplicator,
    deduplicate_airports,
    extract_airport_name,
    is_point_marker,
)
from kml_heatmap.types import TrackPoint


def _path(*points):
    return [TrackPoint(lat, lon, alt, None) for lat, lon, alt in points]


class TestExtractAirportName:
    def test_route_departure_and_arrival(self):
        assert (
            extract_airport_name("EDDF Frankfurt - KJFK New York", False)
            == "EDDF Frankfurt"
        )
        assert (
            extract_airport_name("EDDF Frankfurt - KJFK New York", True)
            == "KJFK New York"
        )

    def test_marker_returns_none(self):
        assert extract_airport_name("Log Start: 03 Mar 2025 08:58 Z", False) is None

    def test_single_icao_code(self):
        assert extract_airport_name("EDDF", True) == "EDDF"
        assert extract_airport_name("EDDF", False) == "EDDF"

    @pytest.mark.parametrize("value", [None, "", "Unknown", "Airport"])
    def test_empty_and_placeholder_names(self, value):
        assert extract_airport_name(value, True) is None

    def test_multi_word_name_without_icao(self):
        assert extract_airport_name("Unknown Location", True) == "Unknown Location"

    def test_single_word_without_icao(self):
        assert extract_airport_name("Somewhere", False) is None


class TestIsPointMarker:
    @pytest.mark.parametrize(
        "name", ["Log Start: EDAQ", "Takeoff: EDAQ", "Landing: EDMV", "Log Stop: X"]
    )
    def test_markers(self, name):
        assert is_point_marker(name) is True

    def test_route_not_marker(self):
        assert is_point_marker("EDAQ Halle - EDMV Vilshofen") is False

    @pytest.mark.parametrize("value", ["", None])
    def test_empty_name_is_marker(self, value):
        assert is_point_marker(value) is True


class TestDeduplicateAirports:
    def test_empty_metadata(self):
        assert deduplicate_airports([], [], lambda p, a: False, lambda p, a: True) == []

    def test_single_route_creates_departure_and_arrival(self):
        metadata = [
            {
                "start_point": [50.0, 8.5, 100],
                "airport_name": "EDDF Frankfurt - EDDK Cologne",
                "timestamp": "2025-03-15T10:00:00Z",
            }
        ]
        path_groups = [_path((50.0, 8.5, 100), (50.86, 7.14, 200))]

        result = deduplicate_airports(
            metadata, path_groups, lambda p, a: False, lambda p, a: True
        )

        assert len(result) == 2
        assert result[0]["is_at_path_end"] is False
        assert result[1]["is_at_path_end"] is True
        assert result[0]["timestamps"] == ["2025-03-15T10:00:00Z"]

    def test_duplicate_locations_merge_timestamps(self):
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
            _path((50.0, 8.5, 100), (51.0, 9.5, 200)),
            _path((50.0001, 8.5001, 100), (51.0, 9.5, 200)),
        ]

        result = deduplicate_airports(
            metadata, path_groups, lambda p, a: False, lambda p, a: True
        )

        assert len(result) == 1
        assert result[0]["timestamps"] == [
            "2025-03-15T10:00:00Z",
            "2025-03-16T10:00:00Z",
        ]

    def test_different_locations_are_kept(self):
        metadata = [
            {
                "start_point": [50.0, 8.5, 100],
                "airport_name": "EDDF",
                "timestamp": "t1",
            },
            {
                "start_point": [51.0, 9.5, 100],
                "airport_name": "EDDK",
                "timestamp": "t2",
            },
        ]
        path_groups = [
            _path((50.0, 8.5, 100), (51.0, 9.5, 200)),
            _path((51.0, 9.5, 100), (52.0, 10.5, 200)),
        ]

        result = deduplicate_airports(
            metadata, path_groups, lambda p, a: False, lambda p, a: True
        )

        assert len(result) == 2

    def test_mid_flight_start_filtered(self):
        metadata = [
            {
                "start_point": [50.0, 8.5, 5000],
                "airport_name": "Mid-air Somewhere",
                "timestamp": "2025-03-15T10:00:00Z",
            }
        ]
        path_groups = [_path((50.0, 8.5, 5000), (51.0, 9.5, 5000))]

        result = deduplicate_airports(
            metadata, path_groups, lambda p, a: a > 1000, lambda p, a: True
        )

        assert result == []

    def test_invalid_landing_not_added(self):
        metadata = [
            {
                "start_point": [50.0, 8.5, 100],
                "airport_name": "EDDF Frankfurt - EDDK Cologne",
                "timestamp": "2025-03-15T10:00:00Z",
            }
        ]
        path_groups = [_path((50.0, 8.5, 100), (50.86, 7.14, 5000))]

        result = deduplicate_airports(
            metadata, path_groups, lambda p, a: False, lambda p, a: a < 1000
        )

        assert len(result) == 1
        assert result[0]["is_at_path_end"] is False

    def test_point_marker_skipped(self):
        metadata = [
            {
                "start_point": [50.0, 8.5, 100],
                "airport_name": "Log Start: EDDF",
                "timestamp": "2025-03-15T10:00:00Z",
            }
        ]
        path_groups = [_path((50.0, 8.5, 100), (51.0, 9.5, 200))]

        result = deduplicate_airports(
            metadata, path_groups, lambda p, a: False, lambda p, a: True
        )

        assert result == []

    def test_short_path_skipped_in_endpoint_processing(self):
        metadata = [
            {
                "start_point": [50.0, 8.5, 100],
                "airport_name": "EDDF Frankfurt - EDDK Cologne",
                "timestamp": "2025-03-15T10:00:00Z",
            }
        ]
        path_groups = [_path((50.0, 8.5, 100))]

        result = deduplicate_airports(
            metadata, path_groups, lambda p, a: False, lambda p, a: True
        )

        # Only the start point entry, no arrival from the endpoint pass
        assert len(result) == 1

    def test_mid_flight_route_omits_departure_and_timestamp(self):
        metadata = [
            {
                "start_point": [50.0, 8.5, 3000],
                "airport_name": "EDDF Frankfurt - EDDK Cologne",
                "timestamp": "2025-03-15T10:00:00Z",
            }
        ]
        path_groups = [_path((50.0, 8.5, 3000), (50.86, 7.14, 100))]

        result = deduplicate_airports(
            metadata, path_groups, lambda p, a: a > 1000, lambda p, a: True
        )

        assert len(result) == 1
        assert result[0]["is_at_path_end"] is True
        assert result[0]["timestamps"] == []


class TestAirportDeduplicator:
    def test_initialization(self):
        deduplicator = AirportDeduplicator()
        assert deduplicator.unique_airports == []
        assert deduplicator.spatial_grid == {}

    def test_custom_grid_size(self):
        assert AirportDeduplicator(grid_size=0.5).grid_size == 0.5

    def test_add_new_airport(self):
        deduplicator = AirportDeduplicator()
        idx = deduplicator.add_or_update_airport(
            lat=50.0,
            lon=8.5,
            name="Some Field Name",
            timestamp="2025-03-15T10:00:00Z",
            path_index=0,
            is_at_path_end=False,
        )
        assert idx == 0
        assert deduplicator.unique_airports[0]["name"] == "Some Field Name"
        assert deduplicator.unique_airports[0]["lat"] == 50.0

    def test_icao_name_uses_database_coordinates(self):
        deduplicator = AirportDeduplicator()
        deduplicator.add_or_update_airport(
            lat=50.0,
            lon=8.5,
            name="EDDF",
            timestamp=None,
            path_index=0,
            is_at_path_end=False,
        )
        airport = deduplicator.unique_airports[0]
        assert airport["lat"] == pytest.approx(50.026706)
        assert airport["lon"] == pytest.approx(8.55835)

    def test_route_uses_arrival_icao_at_path_end(self):
        deduplicator = AirportDeduplicator()
        deduplicator.add_or_update_airport(
            lat=0.0,
            lon=0.0,
            name="EDDF - EDDM",
            timestamp=None,
            path_index=0,
            is_at_path_end=True,
        )
        airport = deduplicator.unique_airports[0]
        assert airport["lat"] == pytest.approx(48.353802)

    def test_update_existing_airport(self):
        deduplicator = AirportDeduplicator()
        idx1 = deduplicator.add_or_update_airport(
            lat=50.0,
            lon=8.5,
            name="EDDF",
            timestamp="2025-03-15T10:00:00Z",
            path_index=0,
            is_at_path_end=False,
        )
        idx2 = deduplicator.add_or_update_airport(
            lat=50.0001,
            lon=8.5001,
            name="EDDF",
            timestamp="2025-03-16T10:00:00Z",
            path_index=1,
            is_at_path_end=False,
        )
        assert idx1 == idx2
        assert len(deduplicator.unique_airports) == 1
        assert len(deduplicator.unique_airports[0]["timestamps"]) == 2

    def test_prefer_route_names_over_markers(self):
        deduplicator = AirportDeduplicator()
        idx1 = deduplicator.add_or_update_airport(
            lat=50.0,
            lon=8.5,
            name="Log Start: EDDF",
            timestamp="t1",
            path_index=0,
            is_at_path_end=False,
        )
        idx2 = deduplicator.add_or_update_airport(
            lat=50.0001,
            lon=8.5001,
            name="EDDF Frankfurt - EDDM Munich",
            timestamp="t2",
            path_index=1,
            is_at_path_end=False,
        )
        assert idx1 == idx2
        assert deduplicator.unique_airports[0]["name"] == "EDDF Frankfurt - EDDM Munich"
        # Marker timestamps are not counted as flights
        assert deduplicator.unique_airports[0]["timestamps"] == ["t2"]

    def test_skip_duplicate_timestamps(self):
        deduplicator = AirportDeduplicator()
        deduplicator.add_or_update_airport(
            lat=50.0,
            lon=8.5,
            name="EDDF",
            timestamp="t1",
            path_index=0,
            is_at_path_end=False,
        )
        deduplicator.add_or_update_airport(
            lat=50.0001,
            lon=8.5001,
            name="EDDF",
            timestamp="t1",
            path_index=1,
            is_at_path_end=False,
        )
        assert deduplicator.unique_airports[0]["timestamps"] == ["t1"]

    def test_get_unique_airports(self):
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
        assert len(deduplicator.get_unique_airports()) == 2

    def test_airport_with_no_name(self):
        deduplicator = AirportDeduplicator()
        idx = deduplicator.add_or_update_airport(
            lat=50.0,
            lon=8.5,
            name=None,
            timestamp="t1",
            path_index=0,
            is_at_path_end=False,
        )
        assert idx == 0
        assert deduplicator.unique_airports[0]["name"] is None
        assert deduplicator.unique_airports[0]["timestamps"] == []
