"""Tests for parser_gx_track module."""

from lxml import etree

from kml_heatmap.constants import KML_NAMESPACES
from kml_heatmap.helpers import parse_timestamp_epoch
from kml_heatmap.parser_gx_track import local_name, parse_gx_track, process_gx_track
from kml_heatmap.types import TrackPoint

KML_NS = KML_NAMESPACES["kml"]
GX_NS = KML_NAMESPACES["gx"]


def _document():
    return etree.Element(f"{{{KML_NS}}}Document", nsmap={None: KML_NS, "gx": GX_NS})


def _placemark(document, name=None, description=None, timestamp=None):
    pm = etree.SubElement(document, f"{{{KML_NS}}}Placemark")
    if name is not None:
        etree.SubElement(pm, f"{{{KML_NS}}}name").text = name
    if description is not None:
        etree.SubElement(pm, f"{{{KML_NS}}}description").text = description
    if timestamp is not None:
        ts = etree.SubElement(pm, f"{{{KML_NS}}}TimeStamp")
        etree.SubElement(ts, f"{{{KML_NS}}}when").text = timestamp
    return pm


def _track(parent, coords=(), whens=(), interleave=True):
    """Add a gx:Track (interleaved when/coord pairs, as SkyDemon writes them)."""
    track = etree.SubElement(parent, f"{{{GX_NS}}}Track")
    if interleave:
        for idx, coord in enumerate(coords):
            if idx < len(whens):
                etree.SubElement(track, f"{{{KML_NS}}}when").text = whens[idx]
            etree.SubElement(track, f"{{{GX_NS}}}coord").text = coord
        for when in whens[len(coords) :]:
            etree.SubElement(track, f"{{{KML_NS}}}when").text = when
    else:
        for when in whens:
            etree.SubElement(track, f"{{{KML_NS}}}when").text = when
        for coord in coords:
            etree.SubElement(track, f"{{{GX_NS}}}coord").text = coord
    return track


def _run(tracks):
    coordinates, path_groups, path_metadata = [], [], []
    process_gx_track(
        tracks,
        KML_NAMESPACES,
        "1_DEAGJ_DA20.kml",
        coordinates,
        path_groups,
        path_metadata,
    )
    return coordinates, path_groups, path_metadata


class TestLocalName:
    def test_strips_namespace(self):
        assert local_name(f"{{{GX_NS}}}coord") == "coord"
        assert local_name("when") == "when"

    def test_non_string_tags(self):
        assert local_name(etree.Comment) == ""


class TestParseGxTrack:
    def test_parses_coordinates_and_timestamps(self):
        track = _track(
            _document(),
            ["8.5 50.0 300", "9.0 51.0 400"],
            ["2025-03-01T10:00:00Z", "2025-03-01T11:00:00Z"],
        )
        coordinates = []
        path, whens = parse_gx_track(track, "test.kml", coordinates)
        assert path == [
            TrackPoint(50.0, 8.5, 300.0, parse_timestamp_epoch("2025-03-01T10:00:00Z")),
            TrackPoint(51.0, 9.0, 400.0, parse_timestamp_epoch("2025-03-01T11:00:00Z")),
        ]
        assert coordinates == path
        assert whens == ["2025-03-01T10:00:00Z", "2025-03-01T11:00:00Z"]

    def test_grouped_whens_and_coords_pair_by_position(self):
        track = _track(
            _document(),
            ["8.5 50.0 300", "9.0 51.0 400"],
            ["2025-03-01T10:00:00Z", "2025-03-01T11:00:00Z"],
            interleave=False,
        )
        path, _ = parse_gx_track(track, "test.kml", [])
        assert path[1].ts == parse_timestamp_epoch("2025-03-01T11:00:00Z")

    def test_without_timestamps(self):
        track = _track(_document(), ["8.5 50.0 300"])
        path, whens = parse_gx_track(track, "test.kml", [])
        assert path == [TrackPoint(50.0, 8.5, 300.0, None)]
        assert whens == []

    def test_coordinate_without_altitude_only_in_coordinates(self):
        track = _track(_document(), ["8.5 50.0"])
        coordinates = []
        path, _ = parse_gx_track(track, "test.kml", coordinates)
        assert path == []
        assert coordinates == [TrackPoint(50.0, 8.5, None, None)]

    def test_invalid_altitude_treated_as_missing(self):
        track = _track(_document(), ["8.5 50.0 999999"])
        coordinates = []
        path, _ = parse_gx_track(track, "test.kml", coordinates)
        assert path == []
        assert coordinates[0].alt is None

    def test_skips_empty_and_invalid_coords(self):
        track = _track(
            _document(),
            ["", "   ", "8.5", "abc def ghi", "8.5 999.0 100", "8.5 50.0 300"],
        )
        etree.SubElement(track, f"{{{GX_NS}}}coord")  # text is None
        path, _ = parse_gx_track(track, "test.kml", [])
        assert path == [TrackPoint(50.0, 8.5, 300.0, None)]

    def test_count_mismatch_warns_and_pairs_by_position(self, capsys):
        track = _track(
            _document(), ["8.5 50.0 300", "9.0 51.0 400"], ["2025-03-01T10:00:00Z"]
        )
        path, whens = parse_gx_track(track, "test.kml", [])
        assert path[0].ts == parse_timestamp_epoch("2025-03-01T10:00:00Z")
        assert path[1].ts is None
        assert whens == ["2025-03-01T10:00:00Z"]
        assert "1 <when> but 2 <gx:coord>" in capsys.readouterr().err

    def test_unparsable_when_gives_none_timestamp(self):
        track = _track(_document(), ["8.5 50.0 300"], ["yesterday"])
        path, whens = parse_gx_track(track, "test.kml", [])
        assert path[0].ts is None
        assert whens == ["yesterday"]

    def test_ignores_comments_and_other_children(self):
        track = _track(_document(), ["8.5 50.0 300"], ["2025-03-01T10:00:00Z"])
        track.append(etree.Comment("ignored"))
        etree.SubElement(track, f"{{{GX_NS}}}angles").text = "1 2 3"
        path, _ = parse_gx_track(track, "test.kml", [])
        assert len(path) == 1


class TestProcessGxTrack:
    def test_no_tracks(self):
        assert _run([]) == ([], [], [])

    def test_single_track_with_placemark_metadata(self):
        doc = _document()
        pm = _placemark(doc, name="EDDS")
        track = _track(
            pm,
            ["8.5 50.0 300", "9.0 51.0 400"],
            ["2025-03-01T10:00:00Z", "2025-03-01T11:00:00Z"],
        )

        coordinates, path_groups, path_metadata = _run([track])

        assert len(coordinates) == 2
        assert len(path_groups) == 1
        meta = path_metadata[0]
        assert meta["airport_name"] == "EDDS Stuttgart"
        assert meta["timestamp"] == "2025-03-01T10:00:00Z"
        assert meta["end_timestamp"] == "2025-03-01T11:00:00Z"
        assert meta["year"] == 2025
        assert meta["aircraft_registration"] == "D-EAGJ"
        assert meta["start_point"] == [50.0, 8.5, 300.0]

    def test_two_tracks_in_one_placemark(self):
        doc = _document()
        pm = _placemark(doc, name="Two legs")
        first = _track(
            pm,
            ["8.5 50.0 300", "8.6 50.1 300"],
            ["2025-03-01T10:00:00Z", "2025-03-01T10:01:00Z"],
        )
        second = _track(
            pm,
            ["9.0 51.0 400", "9.1 51.1 400"],
            ["2025-03-01T12:00:00Z", "2025-03-01T12:05:00Z"],
        )

        coordinates, path_groups, path_metadata = _run([first, second])

        assert len(coordinates) == 4
        assert [len(p) for p in path_groups] == [2, 2]
        assert path_groups[1][0].ts == parse_timestamp_epoch("2025-03-01T12:00:00Z")
        assert [m["timestamp"] for m in path_metadata] == [
            "2025-03-01T10:00:00Z",
            "2025-03-01T12:00:00Z",
        ]
        assert [m["end_timestamp"] for m in path_metadata] == [
            "2025-03-01T10:01:00Z",
            "2025-03-01T12:05:00Z",
        ]
        assert all(m["airport_name"] == "Two legs" for m in path_metadata)

    def test_extra_timestamp_element_does_not_shift_pairing(self):
        doc = _document()
        pm = _placemark(doc, name="Track", timestamp="2025-02-01T00:00:00Z")
        track = _track(
            pm,
            ["8.5 50.0 300", "9.0 51.0 400"],
            ["2025-03-01T10:00:00Z", "2025-03-01T11:00:00Z"],
        )

        _, path_groups, path_metadata = _run([track])

        assert path_groups[0][0].ts == parse_timestamp_epoch("2025-03-01T10:00:00Z")
        assert path_groups[0][1].ts == parse_timestamp_epoch("2025-03-01T11:00:00Z")
        # The track's own timestamps define its span, not the placemark's TimeStamp
        assert path_metadata[0]["timestamp"] == "2025-03-01T10:00:00Z"
        assert path_metadata[0]["end_timestamp"] == "2025-03-01T11:00:00Z"

    def test_metadata_per_placemark(self):
        doc = _document()
        first = _track(
            _placemark(doc, name="EDAQ"), ["8.5 50.0 300"], ["2025-03-01T10:00:00Z"]
        )
        second = _track(
            _placemark(doc, name="EDMV"), ["9.0 51.0 400"], ["2026-03-01T10:00:00Z"]
        )

        _, _, path_metadata = _run([first, second])

        assert [m["airport_name"] for m in path_metadata] == [
            "EDAQ Halle-Oppin",
            "EDMV Vilshofen",
        ]
        assert [m["year"] for m in path_metadata] == [2025, 2026]
        assert [m["end_timestamp"] for m in path_metadata] == [None, None]

    def test_track_without_timestamps_uses_placemark_metadata(self):
        doc = _document()
        pm = _placemark(
            doc, name="Flight", description="Flight Jan 12 2026 03:01PM path of OE-AKI"
        )
        track = _track(pm, ["8.5 50.0 300"])

        _, _, path_metadata = _run([track])

        assert path_metadata[0]["timestamp"] == "2026-01-12T15:01:00+00:00"
        assert path_metadata[0]["year"] == 2026

    def test_track_outside_placemark(self):
        track = _track(_document(), ["8.5 50.0 300"])

        _, path_groups, path_metadata = _run([track])

        assert len(path_groups) == 1
        assert path_metadata[0]["airport_name"] == ""
        assert path_metadata[0]["year"] is None

    def test_track_without_valid_coords_is_skipped(self):
        track = _track(_placemark(_document(), name="X"), ["invalid"])
        assert _run([track]) == ([], [], [])
