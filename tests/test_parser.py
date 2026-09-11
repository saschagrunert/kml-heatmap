"""Tests for the parser module (end-to-end KML parsing)."""

import logging

import pytest

from kml_heatmap.exceptions import KMLParseError
from kml_heatmap.helpers import parse_timestamp_epoch
from kml_heatmap.parser import _parse_kml_tree, parse_kml_coordinates
from kml_heatmap.parser_cache import get_cache_key
from kml_heatmap.types import TrackPoint

KML_HEADER = (
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    '<kml xmlns="http://www.opengis.net/kml/2.2" '
    'xmlns:gx="http://www.google.com/kml/ext/2.2">'
)

LINESTRING_KML = f"""{KML_HEADER}
  <Document>
    <Placemark>
      <name>Test Path</name>
      <LineString>
        <coordinates>8.5,50.0,300 9.0,51.0,400</coordinates>
      </LineString>
    </Placemark>
  </Document>
</kml>"""

GX_TRACK_KML = f"""{KML_HEADER}
  <Document>
    <Placemark>
      <name>Track</name>
      <gx:Track>
        <when>2025-03-15T10:00:00Z</when>
        <gx:coord>8.5 50.0 300</gx:coord>
        <when>2025-03-15T10:01:00Z</when>
        <gx:coord>9.0 51.0 400</gx:coord>
      </gx:Track>
    </Placemark>
  </Document>
</kml>"""


def _write(tmp_path, name, content):
    path = tmp_path / name
    path.write_text(content, encoding="utf-8")
    return str(path)


class TestParseKmlCoordinates:
    def test_parse_linestring(self, tmp_path):
        coords, paths, metadata = parse_kml_coordinates(
            _write(tmp_path, "test.kml", LINESTRING_KML)
        )
        assert coords == [
            TrackPoint(50.0, 8.5, 300.0, None),
            TrackPoint(51.0, 9.0, 400.0, None),
        ]
        assert paths == [coords]
        assert len(metadata) == 1
        assert metadata[0]["airport_name"] == "Test Path"
        assert metadata[0]["filename"] == "test.kml"
        assert metadata[0]["start_point"] == [50.0, 8.5, 300.0]

    def test_parse_gx_track_with_epoch_timestamps(self, tmp_path):
        coords, paths, metadata = parse_kml_coordinates(
            _write(tmp_path, "track.kml", GX_TRACK_KML)
        )
        assert len(coords) == 2
        assert len(paths) == 1
        assert paths[0][0].ts == parse_timestamp_epoch("2025-03-15T10:00:00Z")
        assert paths[0][1].ts == paths[0][0].ts + 60
        assert metadata[0]["timestamp"] == "2025-03-15T10:00:00Z"
        assert metadata[0]["end_timestamp"] == "2025-03-15T10:01:00Z"
        assert metadata[0]["year"] == 2025

    def test_second_parse_uses_cache_and_is_identical(self, tmp_path):
        kml_file = _write(tmp_path, "cached.kml", GX_TRACK_KML)
        first = parse_kml_coordinates(kml_file)
        cache_path, valid = get_cache_key(kml_file)
        assert valid is True
        assert cache_path is not None
        assert cache_path.exists()
        second = parse_kml_coordinates(kml_file)
        assert second == first
        assert all(isinstance(p, TrackPoint) for p in second[1][0])

    def test_invalid_xml_raises(self, tmp_path):
        with pytest.raises(KMLParseError, match="XML parsing error"):
            parse_kml_coordinates(_write(tmp_path, "bad.kml", "not valid xml <"))

    def test_missing_file_raises(self, tmp_path):
        with pytest.raises(KMLParseError, match="I/O error"):
            parse_kml_coordinates(str(tmp_path / "missing.kml"))

    def test_no_valid_coordinates(self, tmp_path, capsys):
        kml = f"""{KML_HEADER}
  <Document><Placemark><name>Empty</name><Point><coordinates></coordinates></Point>
  </Placemark></Document></kml>"""
        coords, paths, metadata = parse_kml_coordinates(
            _write(tmp_path, "empty.kml", kml)
        )
        assert (coords, paths, metadata) == ([], [], [])
        assert "No valid coordinates found" in capsys.readouterr().err

    def test_namespace_less_kml(self, tmp_path):
        kml = """<?xml version="1.0"?><kml><Document><Placemark><name>Plain</name>
        <Track><when>2025-03-15T10:00:00Z</when><coord>8.5 50.0 300</coord>
        <when>2025-03-15T10:01:00Z</when><coord>9.0 51.0 400</coord></Track>
        </Placemark></Document></kml>"""
        coords, paths, metadata = parse_kml_coordinates(
            _write(tmp_path, "plain.kml", kml)
        )
        assert len(coords) == 2
        assert len(paths) == 1
        assert metadata[0]["year"] == 2025

    def test_multiple_tracks_produce_multiple_paths(self, tmp_path):
        kml = f"""{KML_HEADER}
  <Document>
    <Placemark><name>First</name><gx:Track>
      <when>2025-03-15T10:00:00Z</when><gx:coord>8.5 50.0 300</gx:coord>
      <when>2025-03-15T10:01:00Z</when><gx:coord>8.6 50.1 300</gx:coord>
    </gx:Track></Placemark>
    <Placemark><name>Second</name><gx:Track>
      <when>2026-03-15T10:00:00Z</when><gx:coord>9.0 51.0 400</gx:coord>
      <when>2026-03-15T10:01:00Z</when><gx:coord>9.1 51.1 400</gx:coord>
    </gx:Track></Placemark>
  </Document></kml>"""
        coords, paths, metadata = parse_kml_coordinates(
            _write(tmp_path, "two.kml", kml)
        )
        assert len(coords) == 4
        assert [len(p) for p in paths] == [2, 2]
        assert [m["year"] for m in metadata] == [2025, 2026]
        assert [m["airport_name"] for m in metadata] == ["First", "Second"]

    def test_gx_coord_outside_track_warns(self, tmp_path, capsys):
        kml = f"""{KML_HEADER}<Document><Placemark>
        <gx:coord>8.5 50.0 300</gx:coord>
        <gx:Track><when>2025-03-15T10:00:00Z</when>
        <gx:coord>9.0 51.0 400</gx:coord></gx:Track>
        </Placemark></Document></kml>"""
        coords, _, _ = parse_kml_coordinates(_write(tmp_path, "loose.kml", kml))
        assert len(coords) == 1
        assert "outside of gx:Track were ignored" in capsys.readouterr().err

    def test_debug_logging_lists_tags(self, tmp_path, capsys):
        from kml_heatmap.logger import set_debug_mode

        set_debug_mode(True)
        try:
            root = _parse_kml_tree(_write(tmp_path, "dbg.kml", LINESTRING_KML))
        finally:
            set_debug_mode(False)
        assert root is not None
        assert "All unique tags in file" in capsys.readouterr().out
        assert not logging.getLogger("kml_heatmap").isEnabledFor(logging.DEBUG)


class TestCharterwareIntegration:
    CHARTERWARE_KML = f"""{KML_HEADER}
    <Document id="1">
        <Placemark id="3">
            <name>OE-AKI</name>
            <description>Flight Jan 12 2026 03:01PM path of OE-AKI</description>
            <LineString id="2">
                <coordinates>
                    16.252537,47.96571,232.800003 16.252432,47.965717,231.800003
                    16.252419,47.96571,231.800003
                </coordinates>
            </LineString>
        </Placemark>
    </Document>
</kml>"""

    def test_parse_charterware_kml(self, tmp_path):
        kml_file = _write(
            tmp_path, "2026-01-12_1513h_OE-AKI_LOAV-LOAV.kml", self.CHARTERWARE_KML
        )
        coords, paths, metadata = parse_kml_coordinates(kml_file)
        assert len(coords) == 3
        assert len(paths) == 1
        meta = metadata[0]
        assert meta["aircraft_registration"] == "OE-AKI"
        assert "route" not in meta
        assert "aircraft_type" not in meta
        assert meta["timestamp"] == "2026-01-12T15:01:00+00:00"
        assert meta["year"] == 2026
        assert (
            meta["airport_name"]
            == "LOAV Vöslau-Kottingbrunn - LOAV Vöslau-Kottingbrunn"
        )

    def test_route_with_different_airports(self, tmp_path):
        kml = self.CHARTERWARE_KML.replace("OE-AKI", "D-EXYZ").replace(
            "Jan 12 2026 03:01PM", "Feb 15 2026 10:30AM"
        )
        kml_file = _write(tmp_path, "2026-02-15_1030h_D-EXYZ_EDDF-EDDM.kml", kml)
        _, _, metadata = parse_kml_coordinates(kml_file)
        assert metadata[0]["airport_name"] == "EDDF Frankfurt Main - EDDM Munich"
        assert metadata[0]["timestamp"] == "2026-02-15T10:30:00+00:00"

    def test_skydemon_airport_name_not_replaced(self, tmp_path):
        kml = f"""{KML_HEADER}<Document><Placemark><name>EDAV - EDBH</name>
        <gx:Track><when>2025-08-22T10:13:00Z</when>
        <gx:coord>13.71 52.82 42.0</gx:coord></gx:Track>
        </Placemark></Document></kml>"""
        kml_file = _write(tmp_path, "1_DEHYL_DA40.kml", kml)
        _, _, metadata = parse_kml_coordinates(kml_file)
        assert (
            metadata[0]["airport_name"]
            == "EDAV Eberswalde-Finow - EDBH Stralsund-Barth"
        )
        assert metadata[0]["aircraft_registration"] == "D-EHYL"
        assert metadata[0]["aircraft_type"] == "DA40"


class TestTimeSpanPlacemark:
    KML = f"""{KML_HEADER}
  <Document>
    <Placemark>
      <name>EDDS - EDDP</name>
      <TimeSpan>
        <begin>2025-06-15T12:00:00Z</begin>
        <end>2025-06-15T13:30:00Z</end>
      </TimeSpan>
      <LineString>
        <coordinates>8.5,50.0,300 9.0,51.0,400 9.5,51.5,350</coordinates>
      </LineString>
    </Placemark>
  </Document>
</kml>"""

    def test_timespan_gives_year_and_duration(self, tmp_path):
        """The obfuscator shifts TimeSpan dates; the parser must read them too."""
        from kml_heatmap.export_pipeline import path_metrics

        kml_file = _write(tmp_path, "1_DEAGJ_DA20.kml", self.KML)
        _, paths, metadata = parse_kml_coordinates(kml_file)

        assert metadata[0]["year"] == 2025
        assert metadata[0]["timestamp"] == "2025-06-15T12:00:00Z"
        assert metadata[0]["end_timestamp"] == "2025-06-15T13:30:00Z"
        duration, _ = path_metrics(paths[0], metadata[0])
        assert duration == 5400.0
