"""Tests for the parser module (end-to-end KML parsing)."""

import logging

import pytest

from kml_heatmap.exceptions import KMLParseError
from kml_heatmap.helpers import parse_timestamp_epoch
from kml_heatmap.parser import _parse_kml_tree
from kml_heatmap.parser_cache import get_cache_key
from kml_heatmap.types import TrackPoint
from tests.conftest import parse_kml_coordinates

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


def _line_string(coordinates):
    return f"<LineString><coordinates>{coordinates}</coordinates></LineString>"


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
        first_ts = paths[0][0].ts
        assert first_ts is not None
        assert paths[0][1].ts == first_ts + 60
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

    @pytest.mark.parametrize(
        "kml",
        [
            (
                f"{KML_HEADER}<Document><Placemark><Polygon><outerBoundaryIs>"
                "<LinearRing><coordinates>9,48,0 9.1,48,0 9.1,48.1,0 9,48,0"
                "</coordinates></LinearRing></outerBoundaryIs></Polygon>"
                "</Placemark></Document></kml>"
            ),
            LINESTRING_KML.replace(
                "<LineString>", "<LineString><altitudeMode>clampToGround</altitudeMode>"
            ),
        ],
        ids=["nothing-usable", "partly-usable"],
    )
    def test_a_cache_hit_logs_the_warnings_again(self, tmp_path, capsys, kml):
        kml_file = _write(tmp_path, "warn.kml", kml)
        first = parse_kml_coordinates(kml_file)
        warnings = capsys.readouterr().err
        assert "WARNING: warn.kml:" in warnings

        assert parse_kml_coordinates(kml_file) == first
        captured = capsys.readouterr()
        assert "(cached)" in captured.out
        assert captured.err == warnings

    def test_a_corrupt_cache_entry_is_parsed_again(self, tmp_path):
        kml_file = _write(tmp_path, "corrupt.kml", GX_TRACK_KML)
        first = parse_kml_coordinates(kml_file)
        cache_path, _ = get_cache_key(kml_file)
        assert cache_path is not None
        cache_path.write_text("{not json", encoding="utf-8")
        assert parse_kml_coordinates(kml_file) == first
        assert get_cache_key(kml_file) == (cache_path, True)
        assert cache_path.read_text(encoding="utf-8").startswith("{")
        assert parse_kml_coordinates(kml_file) == first

    def test_invalid_xml_raises(self, tmp_path):
        with pytest.raises(KMLParseError, match="XML parsing error"):
            parse_kml_coordinates(_write(tmp_path, "bad.kml", "not valid xml <"))

    def test_parse_error_names_the_line(self, tmp_path):
        kml = "<?xml version='1.0'?>\n<kml>\n<Document>\n<Placemark>\n</kml>"
        with pytest.raises(KMLParseError, match="Line: 5") as excinfo:
            parse_kml_coordinates(_write(tmp_path, "bad.kml", kml))
        assert excinfo.value.line_number == 5

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
        # One line, with the file name: files are parsed in parallel
        err = capsys.readouterr().err
        assert "empty.kml: No valid coordinates found" in err
        assert err.count("\n") == 1

    def test_unprefixed_track_next_to_namespaced_point(self, tmp_path):
        """The namespace fallback is decided per element kind."""
        kml = f"""{KML_HEADER}
  <Document><Placemark><name>Home</name><Point><coordinates>8.5,50.0,100</coordinates></Point>
  </Placemark><Placemark><name>Flight</name>
  <Track><when>2025-03-15T10:00:00Z</when><coord>8.5 50.0 300</coord>
  <when>2025-03-15T10:01:00Z</when><coord>9.0 51.0 400</coord></Track>
  </Placemark></Document></kml>"""
        coords, paths, metadata = parse_kml_coordinates(
            _write(tmp_path, "mixed.kml", kml)
        )
        assert len(coords) == 3
        assert len(paths) == 1
        assert metadata[0]["year"] == 2025

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

    def test_gx_coord_counts_in_debug_output(self, tmp_path, capsys):
        from kml_heatmap.logger import set_debug_mode

        set_debug_mode(True)
        try:
            parse_kml_coordinates(_write(tmp_path, "debug.kml", GX_TRACK_KML))
        finally:
            set_debug_mode(False)
        output = capsys.readouterr()
        assert "Found 1 gx:Track element(s) with 2 gx:coord elements" in output.out
        assert "outside of gx:Track" not in output.err

    def test_legacy_google_namespace_with_gx_track(self, tmp_path):
        """Names and LineStrings must not get lost next to a gx:Track."""
        kml = GX_TRACK_KML.replace(
            'xmlns="http://www.opengis.net/kml/2.2"',
            'xmlns="http://earth.google.com/kml/2.2"',
        ).replace(
            "</Document>",
            "<Placemark><name>EDDS - EDDP</name><LineString>"
            "<coordinates>9.2,48.7,300 12.2,51.4,300</coordinates>"
            "</LineString></Placemark></Document>",
        )
        _, paths, metadata = parse_kml_coordinates(_write(tmp_path, "legacy.kml", kml))
        assert len(paths) == 2
        assert [m["airport_name"] for m in metadata] == [
            "EDDS Stuttgart - EDDP Leipzig/Halle",
            "Track",
        ]

    def test_line_string_next_to_a_track_is_not_counted_twice(self, tmp_path):
        kml = f"""{KML_HEADER}<Document><Placemark><name>EDDS - EDDP</name>
        <MultiGeometry><gx:Track>
          <when>2025-03-15T10:00:00Z</when><gx:coord>8.5 50.0 300</gx:coord>
          <when>2025-03-15T10:01:00Z</when><gx:coord>9.0 51.0 400</gx:coord>
        </gx:Track>
        <LineString><coordinates>8.5,50.0,300 9.0,51.0,400</coordinates></LineString>
        </MultiGeometry></Placemark>
        <Placemark><name>Other</name><LineString>
          <coordinates>8.5,50.0,300 9.0,51.0,400</coordinates>
        </LineString></Placemark></Document></kml>"""
        coords, paths, metadata = parse_kml_coordinates(
            _write(tmp_path, "both.kml", kml)
        )
        assert len(paths) == 2
        assert [m["airport_name"] for m in metadata] == [
            "Other",
            "EDDS Stuttgart - EDDP Leipzig/Halle",
        ]
        assert paths[1][0].ts is not None
        assert len(coords) == 4

    def test_text_node_over_10_mb(self, tmp_path):
        points = "9.123456,48.123456,1234.5 " * 420_000
        kml = (
            f"{KML_HEADER}<Document><Placemark><name>Long</name><LineString>"
            f"<coordinates>{points}</coordinates></LineString></Placemark>"
            "</Document></kml>"
        )
        coords, paths, _ = parse_kml_coordinates(_write(tmp_path, "long.kml", kml))
        assert len(coords) == 420_000
        assert len(paths) == 1

    def test_entity_expansion_is_still_rejected(self, tmp_path):
        entities = "".join(
            f'<!ENTITY lol{i} "' + f"&lol{i - 1};" * 10 + '">' for i in range(1, 10)
        )
        kml = (
            '<?xml version="1.0"?><!DOCTYPE kml [<!ENTITY lol0 "lol">'
            f"{entities}]><kml><name>&lol9;</name></kml>"
        )
        with pytest.raises(KMLParseError, match="XML parsing error"):
            parse_kml_coordinates(_write(tmp_path, "lol.kml", kml))

    def test_external_entities_are_not_resolved(self, tmp_path):
        secret = tmp_path / "secret.txt"
        secret.write_text("do not read")
        kml = (
            '<?xml version="1.0"?>'
            f'<!DOCTYPE kml [<!ENTITY x SYSTEM "{secret.as_uri()}">]>'
            "<kml><Placemark><name>&x;</name><LineString>"
            "<coordinates>8.5,50.0,300 9.0,51.0,400</coordinates>"
            "</LineString></Placemark></kml>"
        )
        _, _, metadata = parse_kml_coordinates(_write(tmp_path, "xxe.kml", kml))
        assert "do not read" not in str(metadata)

    def test_filename_is_parsed_once_per_file(self, tmp_path, capsys):
        kml = LINESTRING_KML.replace(
            "</Document>",
            "<Placemark><name>Second</name><LineString>"
            "<coordinates>8.5,50.0,300 9.0,51.0,400</coordinates>"
            "</LineString></Placemark></Document>",
        )
        _, paths, _ = parse_kml_coordinates(
            _write(tmp_path, "1_DEAGJ_DA20_extra.kml", kml)
        )
        assert len(paths) == 2
        assert capsys.readouterr().err.count("Ignoring extra filename parts") == 1

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
        from kml_heatmap.export_pipeline import path_duration

        kml_file = _write(tmp_path, "1_DEAGJ_DA20.kml", self.KML)
        _, _, metadata = parse_kml_coordinates(kml_file)

        assert metadata[0]["year"] == 2025
        assert metadata[0]["timestamp"] == "2025-06-15T12:00:00Z"
        assert metadata[0]["end_timestamp"] == "2025-06-15T13:30:00Z"
        duration = path_duration(metadata[0])
        assert duration == 5400.0

    @pytest.mark.parametrize("inherited", [False, True], ids=["multi", "folder"])
    def test_lines_that_share_a_timespan_share_its_duration(self, tmp_path, inherited):
        """Each line gets its part by distance, so all fly the average speed."""
        from kml_heatmap.export_pipeline import path_duration

        span = (
            "<TimeSpan><begin>2025-06-15T12:00:00Z</begin>"
            "<end>2025-06-15T13:30:00Z</end></TimeSpan>"
        )
        short = _line_string("8.0,50.0,300 8.0,50.1,300")
        long = _line_string("9.0,50.0,300 9.0,50.3,300")
        if inherited:
            body = (
                f"<Folder>{span}<Placemark><name>A</name>{short}</Placemark>"
                f"<Placemark><name>B</name>{long}</Placemark></Folder>"
            )
        else:
            body = (
                f"<Placemark><name>A</name>{span}"
                f"<MultiGeometry>{short}{long}</MultiGeometry></Placemark>"
            )
        kml = f"{KML_HEADER}<Document>{body}</Document></kml>"
        _, paths, metadata = parse_kml_coordinates(_write(tmp_path, "s.kml", kml))

        assert len(paths) == 2
        durations = [path_duration(meta) for meta in metadata]
        assert sum(durations) == pytest.approx(5400.0)
        assert durations[1] == pytest.approx(3 * durations[0])

    def test_lines_that_never_move_share_a_timespan_evenly(self, tmp_path):
        from kml_heatmap.export_pipeline import path_duration

        span = (
            "<TimeSpan><begin>2025-06-15T12:00:00Z</begin>"
            "<end>2025-06-15T13:00:00Z</end></TimeSpan>"
        )
        # Apart from each other: a line that starts where the one before
        # ended continues it
        line = _line_string("8.0,50.0,300 8.0,50.0,310")
        other = _line_string("8.5,50.5,300 8.5,50.5,310")
        kml = (
            f"{KML_HEADER}<Document><Placemark><name>A</name>{span}"
            f"<MultiGeometry>{line}{other}</MultiGeometry></Placemark></Document></kml>"
        )
        _, _, metadata = parse_kml_coordinates(_write(tmp_path, "z.kml", kml))
        assert [path_duration(meta) for meta in metadata] == [1800.0, 1800.0]

    @pytest.mark.parametrize("inherited", [False, True], ids=["span", "folder"])
    def test_a_track_split_into_lines_is_one_flight(self, tmp_path, inherited):
        """Each piece starts where the one before ended: no airport between."""
        span = (
            "<TimeSpan><begin>2025-06-15T10:00:00Z</begin>"
            "<end>2025-06-15T11:00:00Z</end></TimeSpan>"
        )
        pieces = [
            "8.0,48.5,300 8.1,48.55,500",
            "8.1,48.55,500 8.2,48.6,700",
            "8.2,48.6,700 8.3,48.65,300",
        ]
        placemarks = "".join(
            f"<Placemark><name>Track segment</name>{'' if inherited else span}"
            f"{_line_string(piece)}</Placemark>"
            for piece in pieces
        )
        body = f"<Folder>{span}{placemarks}</Folder>" if inherited else placemarks
        kml = f"{KML_HEADER}<Document>{body}</Document></kml>"

        _, paths, metadata = parse_kml_coordinates(_write(tmp_path, "t.kml", kml))

        assert len(paths) == 1
        assert [(p.lon, p.alt) for p in paths[0]] == [
            (8.0, 300.0),
            (8.1, 500.0),
            (8.2, 700.0),
            (8.3, 300.0),
        ]
        assert metadata[0]["timestamp"] == "2025-06-15T10:00:00Z"
        assert metadata[0]["end_timestamp"] == "2025-06-15T11:00:00Z"
        assert "span_share" not in metadata[0]

    def test_pieces_of_one_name_in_sequence_span_them_all(self, tmp_path):
        placemarks = "".join(
            f"<Placemark><name>EDDS - EDDP</name><TimeSpan>"
            f"<begin>2025-06-15T{begin}</begin><end>2025-06-15T{end}</end>"
            f"</TimeSpan>{_line_string(piece)}</Placemark>"
            for begin, end, piece in [
                ("10:00:00Z", "10:30:00Z", "9.2,48.7,400 10.0,49.5,2000"),
                ("10:31:00Z", "11:00:00Z", "10.0,49.5,2000 12.2,51.4,150"),
            ]
        )
        kml = f"{KML_HEADER}<Document>{placemarks}</Document></kml>"

        _, paths, metadata = parse_kml_coordinates(_write(tmp_path, "r.kml", kml))

        assert len(paths) == 1
        assert metadata[0]["end_timestamp"] == "2025-06-15T11:00:00Z"
        assert metadata[0]["start_airport"].startswith("EDDS")

    @pytest.mark.parametrize(
        ("second_name", "second_begin", "start"),
        [
            # Another name and another time
            ("B", "10:31:00Z", "8.1,48.55"),
            # The same name, but hours later: the next flight from the spot
            ("A", "14:00:00Z", "8.1,48.55"),
            # The same name and time, but somewhere else
            ("A", "10:31:00Z", "8.5,48.9"),
        ],
    )
    def test_other_flights_stay_apart(self, tmp_path, second_name, second_begin, start):
        placemarks = "".join(
            f"<Placemark><name>{name}</name><TimeSpan>"
            f"<begin>2025-06-15T{begin}</begin><end>2025-06-15T{end}</end>"
            f"</TimeSpan>{_line_string(piece)}</Placemark>"
            for name, begin, end, piece in [
                ("A", "10:00:00Z", "10:30:00Z", "8.0,48.5,300 8.1,48.55,300"),
                (
                    second_name,
                    second_begin,
                    "23:00:00Z",
                    f"{start},300 8.3,48.65,300",
                ),
            ]
        )
        kml = f"{KML_HEADER}<Document>{placemarks}</Document></kml>"

        _, paths, _ = parse_kml_coordinates(_write(tmp_path, "o.kml", kml))

        assert len(paths) == 2

    def test_a_return_flight_under_one_timespan_stays_apart(self, tmp_path):
        """Out and back in a document of one TimeSpan: two routes, two flights."""
        span = (
            "<TimeSpan><begin>2026-01-01T08:00:00Z</begin>"
            "<end>2026-01-01T16:00:00Z</end></TimeSpan>"
        )
        placemarks = "".join(
            f"<Placemark><name>{name}</name>{_line_string(piece)}</Placemark>"
            for name, piece in [
                ("EDDS - EDTQ", "9.0,48.0,400 9.1,48.1,1200 9.3,48.3,400"),
                ("EDTQ - EDDS", "9.3,48.3,400 9.1,48.1,1200 9.0,48.0,400"),
            ]
        )
        kml = f"{KML_HEADER}<Document>{span}{placemarks}</Document></kml>"

        _, paths, metadata = parse_kml_coordinates(_write(tmp_path, "b.kml", kml))

        assert len(paths) == 2
        assert [meta["start_airport"][:4] for meta in metadata] == ["EDDS", "EDTQ"]

    @pytest.mark.parametrize(
        ("first", "second", "joined"),
        [
            # Named after the aircraft, a second flight from near where the
            # first one parked
            (
                "9.0,48.0,1000 9.1,48.1,1200 9.3,48.3,1100 9.3001,48.3001,1100",
                "9.3002,48.3002,1100 9.4,48.4,1200",
                False,
            ),
            # Split in flight, the point of the split written twice
            (
                "9.0,48.0,400 9.1,48.1,1200 9.3,48.3,1100",
                "9.3,48.3,1100 9.4,48.4,400",
                True,
            ),
            # The same point, but the first came down to where it started
            (
                "9.0,48.0,400 9.1,48.1,1200 9.3,48.3,400",
                "9.3,48.3,400 9.4,48.4,1200",
                False,
            ),
            # ... or stood still at its end, however high the field
            (
                (
                    "9.0,48.0,400 9.1,48.1,1200 9.3,48.3,900 9.30001,48.3,900 "
                    "9.30002,48.3,900"
                ),
                "9.30002,48.3,900 9.4,48.4,1200",
                False,
            ),
        ],
        ids=["near", "split", "landed", "standing"],
    )
    def test_untimed_lines_join_only_at_a_repeated_point_in_flight(
        self, tmp_path, first, second, joined
    ):
        placemarks = "".join(
            f"<Placemark><name>D-EABC</name>{_line_string(piece)}</Placemark>"
            for piece in (first, second)
        )
        kml = f"{KML_HEADER}<Document>{placemarks}</Document></kml>"

        _, paths, _ = parse_kml_coordinates(_write(tmp_path, "u.kml", kml))

        assert len(paths) == (1 if joined else 2)

    def test_a_flight_that_landed_is_not_continued_by_the_next(self, tmp_path):
        """One name and one TimeSpan, but the first line ends on the ground."""
        span = (
            "<TimeSpan><begin>2026-01-01T08:00:00Z</begin>"
            "<end>2026-01-01T16:00:00Z</end></TimeSpan>"
        )
        placemarks = "".join(
            f"<Placemark><name>Local flight</name>{_line_string(piece)}</Placemark>"
            for piece in (
                "9.0,48.0,400 9.1,48.1,1200 9.0,48.0,400",
                "9.0,48.0,400 9.2,48.2,1200 9.0,48.0,400",
            )
        )
        kml = f"{KML_HEADER}<Document>{span}{placemarks}</Document></kml>"

        _, paths, _ = parse_kml_coordinates(_write(tmp_path, "l.kml", kml))

        assert len(paths) == 2

    def test_lines_with_their_own_timespans_keep_them(self, tmp_path):
        from kml_heatmap.export_pipeline import path_duration

        placemarks = "".join(
            f"<Placemark><name>{hour}</name><TimeSpan>"
            f"<begin>2025-06-15T{hour}:00:00Z</begin>"
            f"<end>2025-06-15T{hour}:30:00Z</end></TimeSpan><LineString>"
            f"<coordinates>8.0,50.0,300 8.0,50.{hour},300</coordinates>"
            "</LineString></Placemark>"
            for hour in (10, 12)
        )
        kml = f"{KML_HEADER}<Document>{placemarks}</Document></kml>"
        _, _, metadata = parse_kml_coordinates(_write(tmp_path, "o.kml", kml))
        assert [path_duration(meta) for meta in metadata] == [1800.0, 1800.0]
        assert all("span_share" not in meta for meta in metadata)


def _line(geometry, mode=None):
    mode_elem = f"<altitudeMode>{mode}</altitudeMode>" if mode else ""
    return (
        f"{KML_HEADER}<Document><Placemark><name>EDDS - EDDP</name>"
        f"<TimeStamp><when>2025-03-15T10:00:00Z</when></TimeStamp>{geometry}"
        f"</Placemark></Document></kml>"
    ).replace("MODE", mode_elem)


LINE = (
    "<LineString>MODE<coordinates>8.5,50.0,300 9.0,51.0,400</coordinates></LineString>"
)


class TestGeometryTypes:
    def test_polygon_is_no_flight_path(self, tmp_path, capsys):
        kml = _line(
            "<Polygon><outerBoundaryIs><LinearRing><coordinates>"
            "8.5,50.0,300 9.0,51.0,400 9.0,50.0,400 8.5,50.0,300"
            "</coordinates></LinearRing></outerBoundaryIs></Polygon>"
        )
        coords, paths, _ = parse_kml_coordinates(_write(tmp_path, "p.kml", kml))
        assert paths == []
        assert coords == []
        assert "outside of a LineString or Point" in capsys.readouterr().err

    def test_empty_coordinates_in_a_track_are_no_polygon(self, tmp_path, capsys):
        """SkyDemon writes an empty <coordinates /> into every gx:Track."""
        kml = GX_TRACK_KML.replace("<gx:Track>", "<gx:Track><coordinates />")
        _, paths, _ = parse_kml_coordinates(_write(tmp_path, "e.kml", kml))
        assert len(paths) == 1
        assert "outside of a LineString" not in capsys.readouterr().err

    def test_multi_geometry_of_lines(self, tmp_path):
        kml = _line(
            f"<MultiGeometry>{LINE}{LINE.replace('8.5', '7.5')}</MultiGeometry>"
        )
        _, paths, _ = parse_kml_coordinates(_write(tmp_path, "m.kml", kml))
        assert len(paths) == 2

    @pytest.mark.parametrize("mode", [None, "absolute"])
    def test_absolute_altitudes_are_kept(self, tmp_path, mode):
        _, paths, _ = parse_kml_coordinates(
            _write(tmp_path, "a.kml", _line(LINE, mode))
        )
        assert [p.alt for p in paths[0]] == [300.0, 400.0]

    @pytest.mark.parametrize(
        "mode", ["clampToGround", "relativeToGround", "clampToSeaFloor"]
    )
    def test_line_without_sea_level_altitudes_is_no_path(self, tmp_path, capsys, mode):
        coords, paths, _ = parse_kml_coordinates(
            _write(tmp_path, "c.kml", _line(LINE, mode))
        )
        assert paths == []
        assert [p.alt for p in coords] == [None, None]
        err = capsys.readouterr().err
        assert f"altitudeMode {mode} ignored" in err
        assert "without usable altitudes" not in err

    def test_gx_altitude_mode_on_a_track(self, tmp_path, capsys):
        kml = GX_TRACK_KML.replace(
            "<gx:Track>", "<gx:Track><gx:altitudeMode>clampToSeaFloor</gx:altitudeMode>"
        )
        coords, paths, _ = parse_kml_coordinates(_write(tmp_path, "t.kml", kml))
        assert paths == []
        assert len(coords) == 2
        assert "altitudeMode clampToSeaFloor ignored" in capsys.readouterr().err


class TestInheritedTime:
    def test_folder_time_dates_a_line_string(self, tmp_path):
        kml = (
            f"{KML_HEADER}<Document><Folder>"
            "<TimeSpan><begin>2024-07-01</begin></TimeSpan>"
            f"<Placemark><name>EDDS - EDDP</name>{LINE.replace('MODE', '')}"
            "</Placemark></Folder></Document></kml>"
        )
        _, paths, metadata = parse_kml_coordinates(_write(tmp_path, "f.kml", kml))
        assert len(paths) == 1
        assert metadata[0]["year"] == 2024


def _new_year_track():
    """A flight from 2025-12-31T23:00Z to 2026-01-01T02:00Z, mostly in 2026."""
    whens = []
    coords = []
    for i in range(19):
        minutes = 23 * 60 + 10 * i
        day = "2025-12-31" if minutes < 24 * 60 else "2026-01-01"
        clock = f"{minutes // 60 % 24:02d}:{minutes % 60:02d}:00"
        whens.append(f"<when>{day}T{clock}Z</when>")
        coords.append(f"<gx:coord>{9.0 + 0.02 * i:.2f} 48.0 {400 + 20 * i}</gx:coord>")
    return (
        f"{KML_HEADER}<Document><Placemark><name>EDDS - EDDP</name><gx:Track>"
        + "".join(whens)
        + "".join(coords)
        + "</gx:Track></Placemark></Document></kml>"
    )


class TestYearAcrossNewYear:
    def test_the_year_survives_the_obfuscation(self, tmp_path):
        """The parser and the obfuscator both go by the start of the flight."""
        from pathlib import Path

        from kml_heatmap.obfuscate import obfuscate_kml_file

        kml_file = _write(tmp_path, "ny.kml", _new_year_track())
        _, _, before = parse_kml_coordinates(kml_file)
        assert obfuscate_kml_file(Path(kml_file)) is True
        _, _, after = parse_kml_coordinates(kml_file)

        assert before[0]["year"] == after[0]["year"] == 2025
        assert (after[0].get("timestamp") or "").startswith("2025-01-01T23:00")


class TestMultiTrackFile:
    def test_a_paused_recording_is_one_flight(self, tmp_path):
        tracks = "".join(
            "<gx:Track>"
            + "".join(
                f"<when>2026-05-01T{hour:02d}:{minute:02d}:00Z</when>"
                f"<gx:coord>{9 + hour / 10 + minute / 1000:.3f} 48.0 300</gx:coord>"
                for minute in range(3)
            )
            + "</gx:Track>"
            for hour in (10, 11)
        )
        kml = (
            f"{KML_HEADER}<Document><Placemark><name>EDDS - EDDP</name>"
            "<gx:MultiTrack><altitudeMode>absolute</altitudeMode>"
            f"{tracks}</gx:MultiTrack></Placemark></Document></kml>"
        )
        _, paths, metadata = parse_kml_coordinates(_write(tmp_path, "m.kml", kml))
        assert [len(path) for path in paths] == [6]
        assert metadata[0]["timestamp"] == "2026-05-01T10:00:00Z"
        assert metadata[0]["end_timestamp"] == "2026-05-01T11:02:00Z"
