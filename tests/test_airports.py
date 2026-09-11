"""Tests for airports module."""

import pytest

from kml_heatmap.airports import (
    AirportDeduplicator,
    deduplicate_airports,
    extract_airport_name,
    is_mid_flight_start,
    is_point_marker,
    is_valid_landing,
    sample_path_altitudes,
)
from kml_heatmap.types import TrackPoint


def _path(*points):
    return [TrackPoint(lat, lon, alt, None) for lat, lon, alt in points]


def _flat(alt, count=100):
    return [TrackPoint(50.0, 8.0, float(alt), None)] * count


def _profile(*altitudes):
    """A path along a meridian with the given altitudes, one point each."""
    return [
        TrackPoint(50.0 + i * 0.01, 8.0, float(alt), None)
        for i, alt in enumerate(altitudes)
    ]


class TestSamplePathAltitudes:
    def test_short_path_returns_none(self):
        assert sample_path_altitudes(_flat(100, 10)) is None
        assert sample_path_altitudes(_flat(100, 22)) is None

    def test_from_start_and_from_end(self):
        path = _profile(*range(0, 1000, 10))  # 100 points, 0..990
        start = sample_path_altitudes(path)
        end = sample_path_altitudes(path, from_end=True)
        assert start == {"min": 0.0, "max": 240.0, "variation": 240.0}
        assert end == {"min": 750.0, "max": 990.0, "variation": 240.0}

    def test_sample_is_capped(self):
        path = _profile(*range(1000))
        assert sample_path_altitudes(path)["max"] == 49.0

    def test_no_altitudes_returns_none(self):
        path = [TrackPoint(50.0, 8.0, None, None)] * 100
        assert sample_path_altitudes(path) is None


class TestIsMidFlightStart:
    def test_flat_high_start_is_mid_flight(self):
        assert is_mid_flight_start(_flat(2000), 2000.0) is True

    def test_climbing_start_is_not(self):
        assert is_mid_flight_start(_profile(*range(100, 4100, 40)), 100.0) is False

    def test_low_start_is_not(self):
        assert is_mid_flight_start(_flat(100), 100.0) is False

    def test_short_path_or_unknown_altitude(self):
        assert is_mid_flight_start(_flat(2000, 5), 2000.0) is False
        assert is_mid_flight_start(_flat(2000), None) is False


class TestIsValidLanding:
    def test_stable_low_end_is_a_landing(self):
        assert is_valid_landing(_flat(100), 100.0) is True

    def test_descent_to_low_altitude_is_a_landing(self):
        descent = _profile(*range(3000, 90, -30))
        assert is_valid_landing(descent, descent[-1].alt) is True

    def test_high_variable_end_is_not(self):
        climb = _profile(*range(100, 4100, 40))
        assert is_valid_landing(climb, climb[-1].alt) is False

    def test_short_path_uses_fallback_altitude(self):
        assert is_valid_landing(_flat(100, 3), 100.0) is True
        assert is_valid_landing(_flat(5000, 3), 5000.0) is False
        assert is_valid_landing(_flat(100, 3), None) is False


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
        assert deduplicate_airports([], []) == []

    def test_single_route_creates_departure_and_arrival(self):
        metadata = [
            {
                "start_point": [50.0, 8.5, 100],
                "airport_name": "EDDF Frankfurt - EDDK Cologne",
            }
        ]
        path_groups = [_path((50.0, 8.5, 100), (50.86, 7.14, 200))]

        result = deduplicate_airports(metadata, path_groups)

        assert len(result) == 2
        assert result[0]["is_at_path_end"] is False
        assert result[1]["is_at_path_end"] is True

    def test_departure_is_registered_once(self):
        """The metadata start point is the path's first point; no second pass."""
        path = _path((50.0, 8.5, 100), (50.4, 8.3, 900), (50.86, 7.14, 200))
        metadata = [
            {
                "start_point": [path[0].lat, path[0].lon, path[0].alt],
                "airport_name": "Some Field - Other Field",
            }
        ]

        result = deduplicate_airports(metadata, [path])

        assert [(a["lat"], a["is_at_path_end"]) for a in result] == [
            (50.0, False),
            (50.86, True),
        ]

    def test_duplicate_locations_merge(self):
        metadata = [
            {
                "start_point": [50.0, 8.5, 100],
                "airport_name": "EDDF",
            },
            {
                "start_point": [50.0001, 8.5001, 100],
                "airport_name": "EDDF",
            },
        ]
        path_groups = [
            _path((50.0, 8.5, 100), (51.0, 9.5, 200)),
            _path((50.0001, 8.5001, 100), (51.0, 9.5, 200)),
        ]

        result = deduplicate_airports(metadata, path_groups)

        assert len(result) == 1

    def test_different_locations_are_kept(self):
        metadata = [
            {
                "start_point": [50.0, 8.5, 100],
                "airport_name": "EDDF",
            },
            {
                "start_point": [51.0, 9.5, 100],
                "airport_name": "EDDK",
            },
        ]
        path_groups = [
            _path((50.0, 8.5, 100), (51.0, 9.5, 200)),
            _path((51.0, 9.5, 100), (52.0, 10.5, 200)),
        ]

        result = deduplicate_airports(metadata, path_groups)

        assert len(result) == 2

    def test_mid_flight_start_filtered(self):
        metadata = [
            {
                "start_point": [50.0, 8.0, 5000],
                "airport_name": "Mid-air Somewhere",
            }
        ]
        path_groups = [_flat(5000, 40)]

        result = deduplicate_airports(metadata, path_groups)

        assert result == []

    def test_invalid_landing_not_added(self):
        metadata = [
            {
                "start_point": [50.0, 8.5, 100],
                "airport_name": "EDDF Frankfurt - EDDK Cologne",
            }
        ]
        path_groups = [_path((50.0, 8.5, 100), (50.86, 7.14, 5000))]

        result = deduplicate_airports(metadata, path_groups)

        assert len(result) == 1
        assert result[0]["is_at_path_end"] is False

    def test_point_marker_skipped(self):
        metadata = [
            {
                "start_point": [50.0, 8.5, 100],
                "airport_name": "Log Start: EDDF",
            }
        ]
        path_groups = [_path((50.0, 8.5, 100), (51.0, 9.5, 200))]

        result = deduplicate_airports(metadata, path_groups)

        assert result == []

    def test_short_path_skipped_in_endpoint_processing(self):
        metadata = [
            {
                "start_point": [50.0, 8.5, 100],
                "airport_name": "EDDF Frankfurt - EDDK Cologne",
            }
        ]
        path_groups = [_path((50.0, 8.5, 100))]

        result = deduplicate_airports(metadata, path_groups)

        # Only the start point entry, no arrival from the endpoint pass
        assert len(result) == 1

    def test_metadata_without_matching_path(self):
        metadata = [{"start_point": [50.0, 8.5], "airport_name": "EDDF"}]

        result = deduplicate_airports(metadata, [])

        assert len(result) == 1

    def test_mid_flight_route_omits_departure(self):
        cruise = [3000.0] * 30
        descent = [3000.0 - i * 290.0 for i in range(1, 11)]
        path = _profile(*cruise, *descent)
        metadata = [
            {
                "start_point": [path[0].lat, path[0].lon, 3000],
                "airport_name": "EDDF Frankfurt - EDDK Cologne",
            }
        ]

        result = deduplicate_airports(metadata, [path])

        assert len(result) == 1
        assert result[0]["is_at_path_end"] is True


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
            path_index=0,
            is_at_path_end=False,
        )
        idx2 = deduplicator.add_or_update_airport(
            lat=50.0001,
            lon=8.5001,
            name="EDDF",
            path_index=1,
            is_at_path_end=False,
        )
        assert idx1 == idx2
        assert len(deduplicator.unique_airports) == 1

    def test_prefer_route_names_over_markers(self):
        deduplicator = AirportDeduplicator()
        idx1 = deduplicator.add_or_update_airport(
            lat=50.0,
            lon=8.5,
            name="Log Start: EDDF",
            path_index=0,
            is_at_path_end=False,
        )
        idx2 = deduplicator.add_or_update_airport(
            lat=50.0001,
            lon=8.5001,
            name="EDDF Frankfurt - EDDM Munich",
            path_index=1,
            is_at_path_end=False,
        )
        assert idx1 == idx2
        assert deduplicator.unique_airports[0]["name"] == "EDDF Frankfurt - EDDM Munich"

    def test_get_unique_airports(self):
        deduplicator = AirportDeduplicator()
        deduplicator.add_or_update_airport(
            lat=50.0,
            lon=8.5,
            name="EDDF",
            path_index=0,
            is_at_path_end=False,
        )
        deduplicator.add_or_update_airport(
            lat=51.0,
            lon=9.5,
            name="EDDM",
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
            path_index=0,
            is_at_path_end=False,
        )
        assert idx == 0
        assert deduplicator.unique_airports[0]["name"] is None
