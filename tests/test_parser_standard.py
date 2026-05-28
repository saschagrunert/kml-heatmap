"""Tests for parser_standard module."""

from unittest.mock import MagicMock

from kml_heatmap.parser_standard import process_standard_coordinates


class TestProcessStandardCoordinates:
    def _make_coord_element(self, text):
        elem = MagicMock()
        elem.text = text
        return elem

    def test_none_text_skipped(self):
        elem = self._make_coord_element(None)
        coordinates, path_groups, path_metadata = [], [], []
        process_standard_coordinates(
            [elem], {}, "test.kml", coordinates, path_groups, path_metadata
        )
        assert coordinates == []
        assert path_groups == []

    def test_empty_text_skipped(self):
        elem = self._make_coord_element("   ")
        coordinates, path_groups, path_metadata = [], [], []
        process_standard_coordinates(
            [elem], {}, "test.kml", coordinates, path_groups, path_metadata
        )
        assert coordinates == []
        assert path_groups == []

    def test_single_point(self):
        elem = self._make_coord_element("8.5,50.0,100.0")
        coordinates, path_groups, path_metadata = [], [], []
        process_standard_coordinates(
            [elem], {}, "test.kml", coordinates, path_groups, path_metadata
        )
        assert len(coordinates) == 1
        assert len(path_groups) == 1
        assert len(path_groups[0]) == 1

    def test_multi_point_path(self):
        elem = self._make_coord_element("8.5,50.0,100.0 8.6,50.1,150.0 8.7,50.2,200.0")
        coordinates, path_groups, path_metadata = [], [], []
        process_standard_coordinates(
            [elem], {}, "test.kml", coordinates, path_groups, path_metadata
        )
        assert len(coordinates) == 3
        assert len(path_groups) == 1
        assert len(path_groups[0]) == 3

    def test_invalid_coordinates_skipped(self):
        elem = self._make_coord_element("invalid 8.5,50.0,100.0 also-invalid")
        coordinates, path_groups, path_metadata = [], [], []
        process_standard_coordinates(
            [elem], {}, "test.kml", coordinates, path_groups, path_metadata
        )
        assert len(coordinates) == 1

    def test_metadata_lookup(self):
        elem = self._make_coord_element("8.5,50.0,100.0")
        metadata = {
            id(elem): {
                "airport_name": "EDDS",
                "timestamp": "2025-03-03T08:58:01Z",
                "end_timestamp": None,
            }
        }
        coordinates, path_groups, path_metadata = [], [], []
        process_standard_coordinates(
            [elem], metadata, "test.kml", coordinates, path_groups, path_metadata
        )
        assert len(path_metadata) == 1
        assert path_metadata[0]["airport_name"] == "EDDS"

    def test_newline_separated_coordinates(self):
        elem = self._make_coord_element("8.5,50.0,100.0\n8.6,50.1,150.0")
        coordinates, path_groups, path_metadata = [], [], []
        process_standard_coordinates(
            [elem], {}, "test.kml", coordinates, path_groups, path_metadata
        )
        assert len(coordinates) == 2

    def test_multiple_elements(self):
        elem1 = self._make_coord_element("8.5,50.0,100.0")
        elem2 = self._make_coord_element("9.0,51.0,200.0")
        coordinates, path_groups, path_metadata = [], [], []
        process_standard_coordinates(
            [elem1, elem2], {}, "test.kml", coordinates, path_groups, path_metadata
        )
        assert len(path_groups) == 2
        assert len(path_metadata) == 2

    def test_coordinates_without_altitude(self):
        elem = self._make_coord_element("8.5,50.0 8.6,50.1")
        coordinates, path_groups, path_metadata = [], [], []
        process_standard_coordinates(
            [elem], {}, "test.kml", coordinates, path_groups, path_metadata
        )
        assert len(coordinates) == 2
        # No altitude, so no path group entries
        assert len(path_groups) == 0
