"""Tests for renderer module."""

import json
import os
import string
import subprocess
import sys
from pathlib import Path
from unittest.mock import patch

from kml_heatmap.renderer import (
    _drop_paths_without_year,
    _escape_js_string,
    _package_assets,
    _parse_kml_files,
    _parse_with_error_handling,
    _process_data,
    _render_html,
    create_progressive_heatmap,
    load_template,
    minify_html,
)
from kml_heatmap.types import TrackPoint

BOUNDS = {
    "center_lat": 51.0,
    "center_lon": 13.0,
    "min_lat": 48.0,
    "max_lat": 54.0,
    "min_lon": 9.0,
    "max_lon": 17.0,
}

TRACK_KML = """<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">
  <Document><Placemark><name>EDAQ - EDDC</name><gx:Track>
    <when>{year}-03-15T10:00:00Z</when><gx:coord>12.05 51.55 110</gx:coord>
    <when>{year}-03-15T10:10:00Z</when><gx:coord>12.5 51.4 800</gx:coord>
    <when>{year}-03-15T10:20:00Z</when><gx:coord>13.76 51.13 230</gx:coord>
  </gx:Track></Placemark></Document></kml>
"""


def _write_kml(path, year=2025):
    path.write_text(TRACK_KML.format(year=year), encoding="utf-8")
    return str(path)


class TestEscapeJsString:
    def test_plain_string_unchanged(self):
        assert _escape_js_string("hello") == "hello"

    def test_escapes_quotes_backslash_and_control_chars(self):
        assert _escape_js_string('say "hi"') == 'say \\"hi\\"'
        assert _escape_js_string("it's") == "it\\'s"
        assert _escape_js_string("path\\to") == "path\\\\to"
        assert _escape_js_string("line1\nline2") == "line1\\nline2"
        assert _escape_js_string("col1\tcol2") == "col1\\tcol2"

    def test_xss_payload_neutralized(self):
        result = _escape_js_string("'; alert('xss'); //")
        assert "\\'" in result
        assert "'" not in result.replace("\\'", "")

    def test_empty_and_unicode(self):
        assert _escape_js_string("") == ""
        assert "M\\u00fcnchen" in _escape_js_string("Flughafen München")


class TestLoadTemplate:
    def test_template_content(self):
        template = load_template()
        assert "<html" in template.lower()
        assert "</html>" in template.lower()
        assert "$data_dir_name" in template


class TestMinifyHtml:
    def test_minifies_css_and_js(self):
        html = """<html><head><style>
            body { margin: 0; padding: 0; }
        </style></head><body><script>
            var x = 10;
            console.log(x);
        </script></body></html>"""
        minified = minify_html(html)
        assert "body{margin:0;padding:0}" in minified
        assert "<script>var x=10;console.log(x);</script>" in minified
        assert len(minified) < len(html)

    def test_preserves_attributes_and_content(self):
        minified = minify_html('<html><body><div id="test">Content</div></body></html>')
        assert 'id="test"' in minified or "id=test" in minified
        assert "Content" in minified

    def test_multiple_scripts(self):
        minified = minify_html(
            "<script>var a = 1;</script>\n<script>var b = 2;</script>"
        )
        assert minified.count("<script>") == 2
        assert minified.count("</script>") == 2


class TestParseWithErrorHandling:
    def test_nonexistent_file_returns_empty(self):
        assert _parse_with_error_handling("/nonexistent/file.kml") == (
            "/nonexistent/file.kml",
            ([], [], []),
        )

    def test_invalid_kml_returns_empty(self, tmp_path):
        path = tmp_path / "bad.kml"
        path.write_text("<not-kml>garbage")
        assert _parse_with_error_handling(str(path)) == (str(path), ([], [], []))


class TestParseKmlFiles:
    def test_merges_results_in_numeric_order(self, tmp_path):
        files = [
            _write_kml(tmp_path / "10_DEAGJ_DA20.kml", 2026),
            _write_kml(tmp_path / "2_DEAGJ_DA20.kml", 2025),
        ]

        coords, paths, metadata = _parse_kml_files(files)

        assert len(coords) == 6
        assert len(paths) == 2
        assert [m["filename"] for m in metadata] == [
            "2_DEAGJ_DA20.kml",
            "10_DEAGJ_DA20.kml",
        ]
        assert all(isinstance(p, TrackPoint) for p in coords)

    def test_debug_output_from_forkserver_workers(self, tmp_path):
        """Workers start via forkserver; --debug must still show their output."""
        input_dir = tmp_path / "input"
        input_dir.mkdir()
        kml_file = _write_kml(input_dir / "1_DEAGJ_DA20.kml")

        result = subprocess.run(  # noqa: S603
            [
                sys.executable,
                "-m",
                "kml_heatmap",
                "--debug",
                kml_file,
                "--output-dir",
                str(tmp_path / "out"),
            ],
            capture_output=True,
            text=True,
            check=False,
            cwd=Path(__file__).parent.parent,
        )

        assert result.returncode == 0, result.stderr
        # Emitted by a parse worker process
        assert "DEBUG: Found 1 gx:Track element(s)" in result.stdout
        # Emitted by init_worker pre-loading the airport database
        assert "airports from cache" in result.stdout


class TestDropPathsWithoutYear:
    def test_excludes_paths_without_year(self, capsys):
        paths = [[TrackPoint(1, 1, 1)], [TrackPoint(2, 2, 2)], [TrackPoint(3, 3, 3)]]
        metadata = [
            {"year": 2025, "filename": "a.kml"},
            {"year": None, "filename": "b.kml", "airport_name": "Somewhere"},
            {"filename": "c.kml"},
        ]

        kept_paths, kept_metadata = _drop_paths_without_year(paths, metadata)

        assert kept_paths == [paths[0]]
        assert kept_metadata == [metadata[0]]
        err = capsys.readouterr().err
        assert "b.kml (Somewhere)" in err
        assert "c.kml" in err


class TestProcessData:
    def test_exports_and_excludes_yearless_paths(self, tmp_path):
        coords = [
            TrackPoint(50.0, 8.0, 100.0),
            TrackPoint(51.0, 9.0, 200.0),
            TrackPoint(52.0, 10.0, 1.0),
        ]
        paths = [coords[:2], [coords[2], TrackPoint(52.1, 10.1, 2.0)]]
        metadata = [
            {
                "year": 2025,
                "start_point": [50.0, 8.0, 100.0],
                "airport_name": "EDDF Frankfurt Main - EDDK Cologne Bonn",
                "aircraft_registration": "D-EAGJ",
                "aircraft_type": "DA20",
                "filename": "1_DEAGJ_DA20.kml",
            },
            {
                "year": None,
                "start_point": [52.0, 10.0, 1.0],
                "airport_name": "EDDH - EDDW",
            },
        ]

        result = _process_data(
            coords, paths, metadata, str(tmp_path / "data"), {"D-EAGJ": "Katana"}
        )

        assert result["bounds"]["min_lat"] == 50.0
        assert result["bounds"]["max_lat"] == 52.0
        assert result["bounds"]["center_lon"] == 9.0
        stats = result["stats"]
        assert stats["num_paths"] == 1
        assert stats["total_points"] == 2
        assert stats["num_aircraft"] == 1
        assert stats["aircraft_list"][0]["model"] == "Katana"
        assert stats["airport_names"] == ["EDDF Frankfurt Main", "EDDK Cologne Bonn"]
        assert sorted(p.name for p in (tmp_path / "data").iterdir()) == [
            "2025",
            "airports.js",
            "metadata.js",
        ]


class TestRenderHtml:
    def test_renders_minified_html_with_data_dir(self, tmp_path):
        output_file = tmp_path / "index.html"
        _render_html(str(output_file), "my_data_dir")
        content = output_file.read_text()
        assert "<!doctype html>" in content.lower()
        assert "my_data_dir" in content
        assert "$data_dir_name" not in content
        substituted = string.Template(load_template()).substitute(
            data_dir_name="my_data_dir"
        )
        assert len(content) < len(substituted)


class TestPackageAssets:
    def test_generates_config_css_and_favicons(self, tmp_path):
        with patch.dict(
            os.environ, {"CARTO_API_KEY": "test-carto", "OPENAIP_API_KEY": "it's"}
        ):
            _package_assets(str(tmp_path), BOUNDS, "data")

        config = (tmp_path / "map_config.js").read_text()
        assert "51.0" in config
        assert "test-carto" in config
        assert "it\\'s" in config
        assert "$center_lat" not in config
        assert (tmp_path / "styles.css").stat().st_size > 0
        static_dir = Path(__file__).parent.parent / "kml_heatmap" / "static"
        for fname in ("favicon.svg", "manifest.json", "mapApp.bundle.js"):
            if (static_dir / fname).exists():
                assert (tmp_path / fname).exists()
        # The library bundle was removed; it must not reappear in the output
        assert not (tmp_path / "bundle.js").exists()


class TestCreateProgressiveHeatmap:
    def test_refuses_overlapping_output_dir(self, tmp_path, capsys):
        kml_file = _write_kml(tmp_path / "1_DEAGJ_DA20.kml")
        assert (
            create_progressive_heatmap(
                [kml_file], str(tmp_path / "index.html"), str(tmp_path / "data")
            )
            is False
        )
        assert "Refusing" in capsys.readouterr().err
        assert not (tmp_path / "data").exists()

    def test_refuses_when_aircraft_json_dir_overlaps(self, tmp_path):
        input_dir = tmp_path / "input"
        input_dir.mkdir()
        kml_file = _write_kml(input_dir / "1_DEAGJ_DA20.kml")
        aircraft = tmp_path / "out" / "data" / "aircraft.json"
        aircraft.parent.mkdir(parents=True)
        aircraft.write_text("{}")
        out = tmp_path / "out"
        assert (
            create_progressive_heatmap(
                [kml_file], str(out / "index.html"), str(out / "data"), [aircraft]
            )
            is False
        )

    def test_no_valid_files(self, tmp_path):
        assert (
            create_progressive_heatmap(
                [str(tmp_path / "missing.kml")],
                str(tmp_path / "o" / "index.html"),
                str(tmp_path / "o" / "data"),
            )
            is False
        )

    def test_no_coordinates(self, tmp_path):
        input_dir = tmp_path / "input"
        input_dir.mkdir()
        (input_dir / "empty.kml").write_text("<kml><Document/></kml>")
        out = tmp_path / "out"
        assert (
            create_progressive_heatmap(
                [str(input_dir / "empty.kml")],
                str(out / "index.html"),
                str(out / "data"),
            )
            is False
        )

    def test_end_to_end_with_aircraft_data(self, tmp_path):
        input_dir = tmp_path / "input"
        input_dir.mkdir()
        kml_file = _write_kml(input_dir / "1_DEAGJ_DA20.kml")
        aircraft = input_dir / "aircraft.json"
        aircraft.write_text(json.dumps({"D-EAGJ": "Diamond Katana"}))
        out = tmp_path / "out"
        out.mkdir()

        assert (
            create_progressive_heatmap(
                [kml_file], str(out / "index.html"), str(out / "data"), [aircraft]
            )
            is True
        )

        assert (out / "index.html").exists()
        meta = json.loads(
            (out / "data" / "metadata.js").read_text()[
                len("window.KML_METADATA = ") : -1
            ]
        )
        assert meta["available_years"] == [2025]
        assert meta["stats"]["aircraft_list"][0]["model"] == "Diamond Katana"
        assert meta["stats"]["num_paths"] == 1
