"""Tests for parser_gx_track module."""

from unittest.mock import MagicMock
from lxml import etree

from kml_heatmap.parser_gx_track import (
    _extract_gx_track_metadata,
    _extract_gx_when_elements,
    _parse_gx_coordinates,
    process_gx_track,
)

NAMESPACES = {
    "kml": "http://www.opengis.net/kml/2.2",
    "gx": "http://www.google.com/kml/ext/2.2",
}


def _make_placemark_with_gx(name=None, coords=None, when_times=None, description=None):
    """Helper to build a Placemark element containing gx:coord elements."""
    kml_ns = NAMESPACES["kml"]
    gx_ns = NAMESPACES["gx"]

    pm = etree.SubElement(
        etree.Element(f"{{{kml_ns}}}Document"), f"{{{kml_ns}}}Placemark"
    )

    if name is not None:
        n = etree.SubElement(pm, f"{{{kml_ns}}}name")
        n.text = name

    if description is not None:
        d = etree.SubElement(pm, f"{{{kml_ns}}}description")
        d.text = description

    track = etree.SubElement(pm, f"{{{gx_ns}}}Track")

    if when_times:
        for t in when_times:
            w = etree.SubElement(track, f"{{{kml_ns}}}when")
            w.text = t

    if coords:
        for c in coords:
            gc = etree.SubElement(track, f"{{{gx_ns}}}coord")
            gc.text = c

    gx_coords = track.findall(f"{{{gx_ns}}}coord")
    return pm, gx_coords


class TestExtractGxTrackMetadata:
    def test_returns_metadata_from_first_matching_placemark(self):
        pm, _ = _make_placemark_with_gx(
            name="EDDS",
            coords=["8.5 50.0 300"],
            when_times=["2025-03-01T10:00:00Z"],
        )
        result = _extract_gx_track_metadata([pm], NAMESPACES, "test.kml")
        assert result["airport_name"] is not None
        assert result["timestamp"] == "2025-03-01T10:00:00Z"
        assert result["year"] == 2025

    def test_returns_defaults_when_no_gx_coords(self):
        kml_ns = NAMESPACES["kml"]
        pm = etree.SubElement(
            etree.Element(f"{{{kml_ns}}}Document"), f"{{{kml_ns}}}Placemark"
        )
        result = _extract_gx_track_metadata([pm], NAMESPACES, "test.kml")
        assert result["airport_name"] is None
        assert result["timestamp"] is None
        assert result["end_timestamp"] is None

    def test_returns_defaults_for_empty_placemarks(self):
        result = _extract_gx_track_metadata([], NAMESPACES, "test.kml")
        assert result == {
            "airport_name": None,
            "timestamp": None,
            "end_timestamp": None,
            "year": None,
        }

    def test_handles_placemark_without_timestamp(self):
        pm, _ = _make_placemark_with_gx(name="EDDS", coords=["8.5 50.0 300"])
        result = _extract_gx_track_metadata([pm], NAMESPACES, "test.kml")
        assert result["timestamp"] is None

    def test_handles_end_timestamp(self):
        pm, _ = _make_placemark_with_gx(
            name="EDDS",
            coords=["8.5 50.0 300", "9.0 51.0 400"],
            when_times=["2025-03-01T10:00:00Z", "2025-03-01T11:00:00Z"],
        )
        result = _extract_gx_track_metadata([pm], NAMESPACES, "test.kml")
        assert result["timestamp"] == "2025-03-01T10:00:00Z"
        assert result["end_timestamp"] == "2025-03-01T11:00:00Z"

    def test_handles_name_without_timestamp(self):
        pm, _ = _make_placemark_with_gx(name="Some Airport", coords=["8.5 50.0 300"])
        result = _extract_gx_track_metadata([pm], NAMESPACES, "test.kml")
        assert result["timestamp"] is None
        assert result["airport_name"] is not None


class TestExtractGxWhenElements:
    def test_returns_matching_when_elements(self):
        pm, gx_coords = _make_placemark_with_gx(
            coords=["8.5 50.0 300", "9.0 51.0 400"],
            when_times=["2025-03-01T10:00:00Z", "2025-03-01T11:00:00Z"],
        )
        result = _extract_gx_when_elements([pm], gx_coords, NAMESPACES)
        assert len(result) == 2

    def test_returns_empty_when_count_mismatch(self):
        pm, gx_coords = _make_placemark_with_gx(
            coords=["8.5 50.0 300", "9.0 51.0 400"],
            when_times=["2025-03-01T10:00:00Z"],
        )
        result = _extract_gx_when_elements([pm], gx_coords, NAMESPACES)
        assert result == []

    def test_returns_empty_when_no_when_elements(self):
        pm, gx_coords = _make_placemark_with_gx(
            coords=["8.5 50.0 300"],
        )
        result = _extract_gx_when_elements([pm], gx_coords, NAMESPACES)
        assert result == []

    def test_returns_empty_for_empty_placemarks(self):
        gx_coords = [MagicMock()]
        result = _extract_gx_when_elements([], gx_coords, NAMESPACES)
        assert result == []


class TestParseGxCoordinates:
    def test_parses_valid_coordinates(self):
        pm, gx_coords = _make_placemark_with_gx(
            coords=["8.5 50.0 300", "9.0 51.0 400"],
        )
        coordinates = []
        result = _parse_gx_coordinates(gx_coords, [], "test.kml", coordinates)
        assert len(result) == 2
        assert len(coordinates) == 2
        assert coordinates[0] == [50.0, 8.5]

    def test_skips_none_text(self):
        kml_ns = NAMESPACES["kml"]
        gx_ns = NAMESPACES["gx"]
        track = etree.SubElement(
            etree.Element(f"{{{kml_ns}}}Document"), f"{{{gx_ns}}}Track"
        )
        gc = etree.SubElement(track, f"{{{gx_ns}}}coord")
        # gc.text is None by default
        gx_coords = [gc]
        coordinates = []
        result = _parse_gx_coordinates(gx_coords, [], "test.kml", coordinates)
        assert len(result) == 0
        assert len(coordinates) == 0

    def test_skips_empty_text(self):
        kml_ns = NAMESPACES["kml"]
        gx_ns = NAMESPACES["gx"]
        track = etree.SubElement(
            etree.Element(f"{{{kml_ns}}}Document"), f"{{{gx_ns}}}Track"
        )
        gc = etree.SubElement(track, f"{{{gx_ns}}}coord")
        gc.text = "   "
        gx_coords = [gc]
        coordinates = []
        result = _parse_gx_coordinates(gx_coords, [], "test.kml", coordinates)
        assert len(result) == 0

    def test_skips_single_part_coordinates(self):
        pm, gx_coords = _make_placemark_with_gx(coords=["8.5"])
        coordinates = []
        result = _parse_gx_coordinates(gx_coords, [], "test.kml", coordinates)
        assert len(result) == 0

    def test_handles_coordinates_without_altitude(self):
        pm, gx_coords = _make_placemark_with_gx(coords=["8.5 50.0"])
        coordinates = []
        result = _parse_gx_coordinates(gx_coords, [], "test.kml", coordinates)
        assert len(coordinates) == 1
        # No altitude means no entry in gx_path
        assert len(result) == 0

    def test_handles_timestamps(self):
        pm, gx_coords = _make_placemark_with_gx(
            coords=["8.5 50.0 300", "9.0 51.0 400"],
            when_times=["2025-03-01T10:00:00Z", "2025-03-01T11:00:00Z"],
        )
        when_elems = pm.findall(f".//{{{NAMESPACES['kml']}}}when")
        coordinates = []
        result = _parse_gx_coordinates(gx_coords, when_elems, "test.kml", coordinates)
        assert len(result) == 2
        # Should have timestamp as 4th element
        assert len(result[0]) == 4
        assert result[0][3] == "2025-03-01T10:00:00Z"

    def test_handles_coordinates_without_timestamps(self):
        pm, gx_coords = _make_placemark_with_gx(
            coords=["8.5 50.0 300"],
        )
        coordinates = []
        result = _parse_gx_coordinates(gx_coords, [], "test.kml", coordinates)
        assert len(result) == 1
        assert len(result[0]) == 3  # No timestamp

    def test_handles_invalid_coordinates(self):
        pm, gx_coords = _make_placemark_with_gx(coords=["abc def ghi"])
        coordinates = []
        result = _parse_gx_coordinates(gx_coords, [], "test.kml", coordinates)
        assert len(result) == 0
        assert len(coordinates) == 0


class TestProcessGxTrack:
    def test_returns_early_for_empty_gx_coords(self):
        coordinates = []
        path_groups = []
        path_metadata = []
        process_gx_track(
            [], [], NAMESPACES, "test.kml", coordinates, path_groups, path_metadata
        )
        assert len(coordinates) == 0
        assert len(path_groups) == 0

    def test_processes_valid_track(self):
        pm, gx_coords = _make_placemark_with_gx(
            name="EDDS",
            coords=["8.5 50.0 300", "9.0 51.0 400"],
            when_times=["2025-03-01T10:00:00Z", "2025-03-01T11:00:00Z"],
        )
        coordinates = []
        path_groups = []
        path_metadata = []
        process_gx_track(
            gx_coords,
            [pm],
            NAMESPACES,
            "test.kml",
            coordinates,
            path_groups,
            path_metadata,
        )
        assert len(coordinates) == 2
        assert len(path_groups) == 1
        assert len(path_metadata) == 1
        assert len(path_groups[0]) == 2

    def test_skips_track_with_no_valid_coords(self):
        pm, gx_coords = _make_placemark_with_gx(coords=["invalid"])
        coordinates = []
        path_groups = []
        path_metadata = []
        process_gx_track(
            gx_coords,
            [pm],
            NAMESPACES,
            "test.kml",
            coordinates,
            path_groups,
            path_metadata,
        )
        assert len(path_groups) == 0
        assert len(path_metadata) == 0
