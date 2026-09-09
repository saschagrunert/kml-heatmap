"""Tests for parser_standard module."""

from unittest.mock import MagicMock

from kml_heatmap.parser_common import empty_placemark_metadata
from kml_heatmap.parser_standard import process_standard_coordinates
from kml_heatmap.types import TrackPoint


def _elem(text):
    elem = MagicMock()
    elem.text = text
    return elem


def _run(elements, metadata=None, kml_file="test.kml"):
    coordinates, path_groups, path_metadata = [], [], []
    process_standard_coordinates(
        elements, metadata or {}, kml_file, coordinates, path_groups, path_metadata
    )
    return coordinates, path_groups, path_metadata


class TestProcessStandardCoordinates:
    def test_none_text_skipped(self):
        assert _run([_elem(None)]) == ([], [], [])

    def test_empty_text_skipped(self):
        assert _run([_elem("   ")]) == ([], [], [])

    def test_single_point(self):
        coordinates, path_groups, path_metadata = _run([_elem("8.5,50.0,100.0")])
        assert coordinates == [TrackPoint(50.0, 8.5, 100.0, None)]
        assert path_groups == [[TrackPoint(50.0, 8.5, 100.0, None)]]
        assert path_metadata[0]["start_point"] == [50.0, 8.5, 100.0]
        assert path_metadata[0]["filename"] == "test.kml"

    def test_multi_point_path(self):
        coordinates, path_groups, _ = _run(
            [_elem("8.5,50.0,100.0 8.6,50.1,150.0 8.7,50.2,200.0")]
        )
        assert len(coordinates) == 3
        assert path_groups == [coordinates]

    def test_invalid_coordinates_skipped(self):
        coordinates, path_groups, _ = _run(
            [_elem("invalid 8.5,50.0,100.0 also-invalid")]
        )
        assert coordinates == [TrackPoint(50.0, 8.5, 100.0, None)]
        assert len(path_groups) == 1

    def test_metadata_lookup(self):
        elem = _elem("8.5,50.0,100.0")
        metadata = {
            id(elem): {
                "airport_name": "EDDS",
                "timestamp": "2025-03-03T08:58:01Z",
                "end_timestamp": None,
                "year": 2025,
            }
        }
        _, _, path_metadata = _run([elem], metadata)
        assert path_metadata[0]["airport_name"] == "EDDS"
        assert path_metadata[0]["timestamp"] == "2025-03-03T08:58:01Z"
        assert path_metadata[0]["year"] == 2025

    def test_missing_metadata_uses_empty_defaults(self):
        _, _, path_metadata = _run([_elem("8.5,50.0,100.0")])
        empty = empty_placemark_metadata()
        assert path_metadata[0]["airport_name"] == ""
        assert path_metadata[0]["timestamp"] == empty["timestamp"]
        assert path_metadata[0]["year"] is None

    def test_newline_separated_coordinates(self):
        coordinates, _, _ = _run([_elem("8.5,50.0,100.0\n8.6,50.1,150.0")])
        assert len(coordinates) == 2

    def test_multiple_elements(self):
        _, path_groups, path_metadata = _run(
            [_elem("8.5,50.0,100.0"), _elem("9.0,51.0,200.0")]
        )
        assert len(path_groups) == 2
        assert len(path_metadata) == 2

    def test_coordinates_without_altitude_are_not_paths(self):
        coordinates, path_groups, path_metadata = _run([_elem("8.5,50.0 8.6,50.1")])
        assert coordinates == [
            TrackPoint(50.0, 8.5, None, None),
            TrackPoint(50.1, 8.6, None, None),
        ]
        assert path_groups == []
        assert path_metadata == []

    def test_invalid_altitude_point_excluded_from_path(self):
        coordinates, path_groups, _ = _run([_elem("8.5,50.0,999999 8.6,50.1,150.0")])
        assert len(coordinates) == 2
        assert coordinates[0].alt is None
        assert path_groups == [[TrackPoint(50.1, 8.6, 150.0, None)]]

    def test_negative_altitude_kept(self):
        _, path_groups, _ = _run([_elem("8.5,50.0,-50 8.6,50.1,150.0")])
        assert path_groups[0][0].alt == -50.0
