"""Tests for the generation pipeline in the renderer module."""

import errno
import json
import os
import re
import shutil
import subprocess
import sys
from concurrent.futures import Future
from concurrent.futures.process import BrokenProcessPool
from pathlib import Path
from unittest.mock import patch

import pytest

import kml_heatmap.data_exporter as exporter_module
from kml_heatmap.data_exporter import STAGING_PREFIX
from kml_heatmap.exceptions import KMLHeatmapError
from kml_heatmap.renderer import (
    CoordinateExtent,
    ParsedFile,
    _drop_paths_without_year,
    _export_site,
    _map_extent,
    _parse_kml_files,
    _parse_with_error_handling,
    create_progressive_heatmap,
)
from kml_heatmap.types import TrackPoint
from tests.conftest import FIXTURE_AIRPORTS_CSV, decoded_segments

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

# A track without any date: its year cannot be determined
UNDATED_KML = """<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark>
  <name>somewhere</name><LineString><coordinates>
    -3.70,40.41,700 -3.60,40.50,900 -3.50,40.60,1200
  </coordinates></LineString></Placemark></Document></kml>
"""

MAP_BOUNDS = re.compile(r"bounds:\[\[([-\d.]+),([-\d.]+)\],\[([-\d.]+),([-\d.]+)\]\]")


def _write_kml(path, year=2025, template=TRACK_KML):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(template.format(year=year), encoding="utf-8")
    return str(path)


def _map_bounds(out):
    """The [[min_lat, min_lon], [max_lat, max_lon]] of a generated map_config.js."""
    match = MAP_BOUNDS.search((out / "map_config.js").read_text())
    assert match, "map_config.js has no bounds"
    min_lat, min_lon, max_lat, max_lon = map(float, match.groups())
    return [[min_lat, min_lon], [max_lat, max_lon]]


def _tree(directory):
    """Every file below ``directory`` with its content."""
    return {
        path.relative_to(directory).as_posix(): path.read_bytes()
        for path in sorted(directory.rglob("*"))
        if path.is_file()
    }


def _stages(directory):
    return [p for p in directory.rglob("*") if p.name.startswith(STAGING_PREFIX)]


@pytest.fixture
def bundle(tmp_path_factory, monkeypatch):
    """A stand-in application bundle.

    The Python tests run without `npm run build`, and the pipeline refuses to
    generate a site without the bundle.
    """
    static = tmp_path_factory.mktemp("static")
    bundle = static / "mapApp.bundle.js"
    bundle.write_text("/* test bundle */", encoding="utf-8")
    features = static / "features.bundle.js"
    features.write_text("/* test features */", encoding="utf-8")
    monkeypatch.setattr("kml_heatmap.site_assets.BUNDLE_FILE", bundle)
    monkeypatch.setattr("kml_heatmap.site_assets.FEATURES_BUNDLE_FILE", features)
    monkeypatch.setattr("kml_heatmap.site_assets.BUNDLE_FILES", (bundle, features))
    return bundle


class TestCoordinateExtent:
    def test_of_empty_list_is_none(self):
        assert CoordinateExtent.of([]) is None

    def test_of_points(self):
        extent = CoordinateExtent.of([TrackPoint(50.0, 8.0), TrackPoint(52.0, 7.0)])
        assert extent == CoordinateExtent(50.0, 52.0, 7.0, 8.0)

    def test_union(self):
        a = CoordinateExtent(50.0, 51.0, 8.0, 9.0)
        b = CoordinateExtent(49.0, 50.5, 8.5, 10.0)
        assert a.union(b) == CoordinateExtent(49.0, 51.0, 8.0, 10.0)
        assert a.union(None) == a

    def test_map_bounds_with_center(self):
        bounds = CoordinateExtent(48.0, 54.0, 9.0, 17.0).as_map_bounds()
        assert bounds == BOUNDS


class TestMapExtent:
    def test_covers_only_exportable_paths(self):
        paths = [
            [TrackPoint(50.0, 8.0, 1.0), TrackPoint(51.0, 9.0, 1.0)],
            [TrackPoint(40.0, -3.0, 1.0)],  # a single point is not exported
            [TrackPoint(50.5, 8.5, 1.0), TrackPoint(50.2, 9.5, 1.0)],
        ]
        assert _map_extent(paths) == CoordinateExtent(50.0, 51.0, 8.0, 9.5)

    def test_nothing_to_export_raises(self):
        with pytest.raises(KMLHeatmapError, match="No flight paths"):
            _map_extent([[TrackPoint(40.0, -3.0, 1.0)]])


class TestParseWithErrorHandling:
    def test_nonexistent_file_returns_empty_result(self):
        parsed = _parse_with_error_handling("/nonexistent/file.kml")
        assert parsed == ParsedFile("/nonexistent/file.kml")
        assert parsed.point_count == 0

    def test_invalid_kml_returns_empty_result(self, tmp_path):
        path = tmp_path / "bad.kml"
        path.write_text("<not-kml>garbage")
        assert _parse_with_error_handling(str(path)) == ParsedFile(str(path))

    def test_reduces_coordinates_to_count(self, tmp_path):
        kml_file = _write_kml(tmp_path / "1_DEAGJ_DA20.kml")
        parsed = _parse_with_error_handling(kml_file)
        assert parsed.kml_file == kml_file
        assert parsed.point_count == 3
        assert len(parsed.path_groups) == 1
        assert parsed.path_metadata[0]["year"] == 2025


class _FakeExecutor:
    """A ProcessPoolExecutor stand-in whose futures fail with a given error."""

    def __init__(self, error):
        self.error = error
        self.cancelled = False

    def __call__(self, *args, **kwargs):
        return self

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def submit(self, fn, *args):
        future = Future()
        future.set_exception(self.error)
        return future

    def shutdown(self, wait=True, cancel_futures=False):
        self.cancelled = cancel_futures


class _InlineExecutor(_FakeExecutor):
    """A ProcessPoolExecutor stand-in that runs the work in the test process."""

    def __init__(self):
        super().__init__(None)

    def submit(self, fn, *args):
        future = Future()
        future.set_result(fn(*args))
        return future


class TestParseKmlFiles:
    def test_merges_results_in_input_order(self, tmp_path):
        files = [
            _write_kml(tmp_path / "10_DEAGJ_DA20.kml", 2026),
            _write_kml(tmp_path / "2_DEAGJ_DA20.kml", 2025),
        ]

        paths, metadata = _parse_kml_files(files)

        assert len(paths) == 2
        assert [m["filename"] for m in metadata] == [
            "10_DEAGJ_DA20.kml",
            "2_DEAGJ_DA20.kml",
        ]
        assert all(isinstance(p, TrackPoint) for path in paths for p in path)

    def test_same_basename_in_two_directories_keeps_input_order(self, tmp_path):
        """Path ids follow this order, so it must not depend on worker timing."""
        files = [
            _write_kml(tmp_path / "2025" / "1_DEAGJ_DA20.kml", 2025),
            _write_kml(tmp_path / "2026" / "1_DEAGJ_DA20.kml", 2026),
        ]

        years = [[m["year"] for m in _parse_kml_files(files)[1]] for _ in range(3)]

        assert years == [[2025, 2026]] * 3

    def test_a_file_that_fails_to_parse_fails_the_run(self, tmp_path):
        """A site without one of the flights must not be published quietly."""
        bad = tmp_path / "bad.kml"
        bad.write_text("<not-kml>garbage")
        good = _write_kml(tmp_path / "1_DEAGJ_DA20.kml")

        with pytest.raises(KMLHeatmapError, match="1 of 2 file"):
            _parse_kml_files([str(bad), good])

    def test_no_coordinates_raises(self, tmp_path):
        empty = tmp_path / "empty.kml"
        empty.write_text("<kml><Document/></kml>")
        with pytest.raises(KMLHeatmapError, match="No coordinates"):
            _parse_kml_files([str(empty)])

    def test_crashed_worker_pool_falls_back_to_sequential_parsing(
        self, tmp_path, capsys
    ):
        files = [
            _write_kml(tmp_path / "1_DEAGJ_DA20.kml", 2025),
            _write_kml(tmp_path / "2_DEAGJ_DA20.kml", 2026),
        ]
        pools = iter([_FakeExecutor(BrokenProcessPool("crashed")), _InlineExecutor()])
        with patch(
            "kml_heatmap.renderer.ProcessPoolExecutor",
            side_effect=lambda *args, **kwargs: next(pools),
        ):
            paths, metadata = _parse_kml_files(files)

        assert len(paths) == 2
        assert [m["filename"] for m in metadata] == [
            "1_DEAGJ_DA20.kml",
            "2_DEAGJ_DA20.kml",
        ]
        assert "parsing the 2 remaining file(s) one at a time" in (
            capsys.readouterr().err
        )

    def test_a_file_that_crashes_its_own_worker_is_named(self, tmp_path):
        kml_file = _write_kml(tmp_path / "1_DEAGJ_DA20.kml")
        with (
            patch(
                "kml_heatmap.renderer.ProcessPoolExecutor",
                _FakeExecutor(BrokenProcessPool("crashed")),
            ),
            pytest.raises(KMLHeatmapError, match=r"crashed on .*1_DEAGJ_DA20"),
        ):
            _parse_kml_files([kml_file])

    def test_pipeline_error_in_a_worker_stops_the_run(self, tmp_path, capsys):
        """An error that is not about one file (the airport database) is fatal."""
        kml_file = _write_kml(tmp_path / "1_DEAGJ_DA20.kml")
        executor = _FakeExecutor(KMLHeatmapError("Airport database unavailable"))
        with (
            patch("kml_heatmap.renderer.ProcessPoolExecutor", executor),
            pytest.raises(KMLHeatmapError, match="Airport database unavailable"),
        ):
            _parse_kml_files([kml_file])
        assert executor.cancelled
        assert "Traceback" not in capsys.readouterr().err

    def test_unexpected_worker_error_is_logged(self, tmp_path, capsys):
        kml_file = _write_kml(tmp_path / "1_DEAGJ_DA20.kml")
        with (
            patch(
                "kml_heatmap.renderer.ProcessPoolExecutor",
                _FakeExecutor(RuntimeError("unexpected")),
            ),
            pytest.raises(KMLHeatmapError, match="No coordinates"),
        ):
            _parse_kml_files([kml_file])
        assert "Unexpected error processing" in capsys.readouterr().err

    def test_debug_output_from_forkserver_workers(self, tmp_path, bundle):
        """Workers start via forkserver; --debug must still show their output."""
        input_dir = tmp_path / "input"
        input_dir.mkdir()
        kml_file = _write_kml(input_dir / "1_DEAGJ_DA20.kml")
        # The child process does not see the in-process network guard, so it
        # gets its own cache directory with a fresh copy of the fixture
        cache_dir = tmp_path / "cache"
        cache_dir.mkdir()
        shutil.copyfile(FIXTURE_AIRPORTS_CSV, cache_dir / "airports.csv")
        # Nor does it see the stand-in bundle, which it gets as an argument
        run_cli = (
            "import sys; from pathlib import Path; import kml_heatmap.renderer as r; "
            "r.BUNDLE_FILE = Path(sys.argv.pop(1)); "
            "from kml_heatmap.cli import main; main()"
        )

        result = subprocess.run(  # noqa: S603
            [
                sys.executable,
                "-c",
                run_cli,
                str(bundle),
                "--debug",
                kml_file,
                "--output-dir",
                str(tmp_path / "out"),
            ],
            capture_output=True,
            text=True,
            check=False,
            cwd=Path(__file__).parent.parent,
            env={**os.environ, "KML_HEATMAP_CACHE_DIR": str(cache_dir)},
        )

        assert result.returncode == 0, result.stderr
        # Emitted by a parse worker process
        assert "DEBUG: Found 1 gx:Track element(s)" in result.stdout
        # Emitted by the parent, which loads the airport database before the pool
        assert "airports from cache" in result.stdout
        assert "Downloading" not in result.stdout


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


@pytest.mark.usefixtures("bundle")
class TestExportSite:
    def test_exports_and_excludes_yearless_paths(self, tmp_path, parse_js):
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
        out = tmp_path / "out"

        result = _export_site(
            paths, metadata, out / "index.html", out / "data", {"D-EAGJ": "Katana"}
        )

        # The map is fitted to the exported path only
        assert _map_bounds(out) == [[50.0, 8.0], [51.0, 9.0]]
        assert result.years == [2025]
        metadata = parse_js(out / "data" / "metadata.js")
        assert metadata["aircraft_models"] == {"D-EAGJ": "Katana"}
        year = parse_js(out / "data" / "2025" / "data.js")
        assert len(year["path_info"]) == 1
        assert year["original_points"] == 2
        airports = parse_js(out / "data" / "airports.js")["airports"]
        assert [airport["name"] for airport in airports] == [
            "EDDF Frankfurt Main",
            "EDDK Cologne Bonn",
        ]
        assert sorted(p.name for p in (out / "data").iterdir()) == [
            "2025",
            "airports.js",
            "metadata.js",
        ]
        assert (out / "index.html").exists()
        assert _stages(out) == []

    def test_airports_leave_out_excluded_paths(self, tmp_path, parse_js):
        """A path without an export must not publish its location either."""
        paths = [
            [TrackPoint(50.0, 8.0, 100.0), TrackPoint(51.0, 9.0, 200.0)],
            # A single point (a waypoint placemark with an altitude)
            [TrackPoint(49.5678, 10.1234, 320.0)],
            # A recording that never moved
            [TrackPoint(47.654321, 7.123456, 400.0)] * 3,
        ]
        metadata = [
            {
                "year": 2025,
                "start_point": [50.0, 8.0, 100.0],
                "airport_name": "EDDF Frankfurt Main - EDDK Cologne Bonn",
            },
            {
                "year": 2025,
                "start_point": [49.5678, 10.1234, 320.0],
                "airport_name": "Home Strip",
            },
            {
                "year": 2025,
                "start_point": [47.654321, 7.123456, 400.0],
                "airport_name": "Secret Strip",
            },
        ]
        out = tmp_path / "out"

        _export_site(paths, metadata, out / "index.html", out / "data")

        airports = parse_js(out / "data" / "airports.js")["airports"]
        assert [airport["name"] for airport in airports] == [
            "EDDF Frankfurt Main",
            "EDDK Cologne Bonn",
        ]

    def test_nothing_exportable_raises_before_writing(self, tmp_path):
        paths = [[TrackPoint(50.0, 8.0, 100.0), TrackPoint(51.0, 9.0, 200.0)]]
        metadata = [{"year": None, "start_point": [50.0, 8.0, 100.0]}]
        out = tmp_path / "out"

        with pytest.raises(KMLHeatmapError, match="No flight paths"):
            _export_site(paths, metadata, out / "index.html", out / "data")

        assert not out.exists()


class TestCreateProgressiveHeatmap:
    def test_refuses_overlapping_output_dir(self, tmp_path, capsys):
        kml_file = _write_kml(tmp_path / "1_DEAGJ_DA20.kml")
        assert (
            create_progressive_heatmap(
                [kml_file], str(tmp_path.parent / "index.html"), str(tmp_path)
            )
            is False
        )
        assert "Refusing" in capsys.readouterr().err
        assert not (tmp_path / "airports.js").exists()

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

    def test_missing_bundle_fails_before_any_work(self, tmp_path, capsys, monkeypatch):
        missing = tmp_path / "static" / "missing.js"
        monkeypatch.setattr("kml_heatmap.site_assets.BUNDLE_FILE", missing)
        monkeypatch.setattr("kml_heatmap.site_assets.BUNDLE_FILES", (missing,))
        kml_file = _write_kml(tmp_path / "input" / "1_DEAGJ_DA20.kml")
        out = tmp_path / "out"

        ok = create_progressive_heatmap(
            [kml_file], str(out / "index.html"), str(out / "data")
        )

        assert ok is False
        err = capsys.readouterr().err
        assert err.count("JavaScript bundle not found") == 1
        assert "npm run build" in err
        assert not out.exists()

    @pytest.mark.usefixtures("bundle")
    def test_no_valid_files(self, tmp_path):
        assert (
            create_progressive_heatmap(
                [str(tmp_path / "missing.kml")],
                str(tmp_path / "o" / "index.html"),
                str(tmp_path / "o" / "data"),
            )
            is False
        )

    @pytest.mark.usefixtures("bundle")
    def test_output_dir_equal_to_input_dir_is_refused(self, tmp_path, capsys):
        """The site files would land next to the KML files, and stale
        tool-owned files (a foreign manifest.json) would be removed."""
        input_dir = tmp_path / "input"
        kml_file = _write_kml(input_dir / "1_DEAGJ_DA20.kml")
        (input_dir / "manifest.json").write_text("{}")

        ok = create_progressive_heatmap(
            [kml_file], str(input_dir / "index.html"), str(input_dir / "data")
        )

        assert ok is False
        assert "Refusing to use output directory" in capsys.readouterr().err
        assert (input_dir / "manifest.json").read_text() == "{}"
        assert not (input_dir / "index.html").exists()

    @pytest.mark.usefixtures("bundle")
    def test_data_dir_outside_the_output_dir_is_refused(self, tmp_path, capsys):
        """The page loads the data directory by its name, next to itself."""
        kml_file = _write_kml(tmp_path / "input" / "1_DEAGJ_DA20.kml")

        ok = create_progressive_heatmap(
            [kml_file], str(tmp_path / "a" / "index.html"), str(tmp_path / "b" / "data")
        )

        assert ok is False
        assert "must be directly inside the output directory" in capsys.readouterr().err
        assert not (tmp_path / "a").exists()
        assert not (tmp_path / "b").exists()

    @pytest.mark.usefixtures("bundle")
    def test_one_invalid_input_fails_the_run(self, tmp_path, capsys):
        input_dir = tmp_path / "input"
        input_dir.mkdir()
        good = _write_kml(input_dir / "1_DEAGJ_DA20.kml")
        empty = input_dir / "2_DEAGJ_DA20.kml"
        empty.write_text("")

        ok = create_progressive_heatmap(
            [good, str(empty)],
            str(tmp_path / "o" / "index.html"),
            str(tmp_path / "o" / "data"),
        )

        assert ok is False
        assert "1 of 2 input file(s) are not valid" in capsys.readouterr().err
        assert not (tmp_path / "o").exists()

    @pytest.mark.usefixtures("bundle")
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

    @pytest.mark.usefixtures("bundle")
    def test_no_path_with_a_year_is_an_error(self, tmp_path, capsys):
        kml_file = _write_kml(tmp_path / "input" / "track.kml", template=UNDATED_KML)
        out = tmp_path / "out"

        ok = create_progressive_heatmap(
            [kml_file], str(out / "index.html"), str(out / "data")
        )

        assert ok is False
        assert "No flight paths with a determinable year" in capsys.readouterr().err
        assert not (out / "index.html").exists()

    @pytest.mark.usefixtures("bundle")
    def test_map_bounds_leave_out_excluded_paths(self, tmp_path):
        files = [
            _write_kml(tmp_path / "input" / "1_DEAGJ_DA20.kml"),
            _write_kml(tmp_path / "input" / "spain.kml", template=UNDATED_KML),
        ]
        out = tmp_path / "out"

        assert create_progressive_heatmap(
            files, str(out / "index.html"), str(out / "data")
        )

        assert _map_bounds(out) == [[51.13, 12.05], [51.55, 13.76]]

    @pytest.mark.usefixtures("bundle")
    def test_export_failure_returns_false(self, tmp_path, capsys):
        kml_file = _write_kml(tmp_path / "input" / "1_DEAGJ_DA20.kml")
        out = tmp_path / "out"
        with patch(
            "kml_heatmap.renderer.export_all_data",
            side_effect=RuntimeError("Failed to process year 2025"),
        ):
            ok = create_progressive_heatmap(
                [kml_file], str(out / "index.html"), str(out / "data")
            )
        assert ok is False
        assert "Export failed: Failed to process year 2025" in capsys.readouterr().err
        assert not (out / "index.html").exists()

    @pytest.mark.usefixtures("bundle")
    def test_full_disk_leaves_the_previous_site(self, tmp_path, capsys):
        out = tmp_path / "out"
        first = _write_kml(tmp_path / "input" / "1_DEAGJ_DA20.kml", 2025)
        assert create_progressive_heatmap(
            [first], str(out / "index.html"), str(out / "data")
        )
        previous = _tree(out)

        second = _write_kml(tmp_path / "input" / "2_DEAGJ_DA20.kml", 2026)
        real_atomic_write = exporter_module.atomic_write

        def atomic_write(path, write):
            if path.name == "data.js":
                raise OSError(errno.ENOSPC, "No space left on device")
            return real_atomic_write(path, write)

        with patch("kml_heatmap.data_exporter.atomic_write", atomic_write):
            ok = create_progressive_heatmap(
                [first, second], str(out / "index.html"), str(out / "data")
            )

        assert ok is False
        err = capsys.readouterr().err
        assert "Export failed" in err
        assert "No space left on device" in err
        assert "Traceback" not in err
        assert _tree(out) == previous
        assert _stages(out) == []

    @pytest.mark.usefixtures("bundle")
    def test_failure_after_the_data_export_leaves_the_previous_site(self, tmp_path):
        out = tmp_path / "out"
        kml_file = _write_kml(tmp_path / "input" / "1_DEAGJ_DA20.kml", 2025)
        assert create_progressive_heatmap(
            [kml_file], str(out / "index.html"), str(out / "data")
        )
        previous = _tree(out)

        other = _write_kml(tmp_path / "input" / "2_DEAGJ_DA20.kml", 2026)
        with patch(
            "kml_heatmap.renderer.package_assets",
            side_effect=PermissionError(errno.EACCES, "Permission denied"),
        ):
            ok = create_progressive_heatmap(
                [kml_file, other], str(out / "index.html"), str(out / "data")
            )

        assert ok is False
        assert _tree(out) == previous
        assert _stages(out) == []

    @pytest.mark.usefixtures("bundle")
    def test_symlinked_site_file_is_not_written_through(self, tmp_path, capsys):
        out = tmp_path / "out"
        out.mkdir()
        victim = tmp_path / "victim.txt"
        victim.write_text("precious")
        (out / "manifest.json").symlink_to(victim)
        kml_file = _write_kml(tmp_path / "input" / "1_DEAGJ_DA20.kml")

        ok = create_progressive_heatmap(
            [kml_file], str(out / "index.html"), str(out / "data")
        )

        assert ok is False
        assert "symlink" in capsys.readouterr().err
        assert victim.read_text() == "precious"
        assert not (out / "index.html").exists()
        assert not (out / "data" / "metadata.js").exists()

    @pytest.mark.usefixtures("bundle")
    def test_stale_bundle_source_map_is_removed(self, tmp_path):
        out = tmp_path / "out"
        out.mkdir()
        (out / "mapApp.bundle.js.map").write_text("{}")
        (out / "CNAME").write_text("maps.example.org")
        kml_file = _write_kml(tmp_path / "input" / "1_DEAGJ_DA20.kml")

        assert create_progressive_heatmap(
            [kml_file], str(out / "index.html"), str(out / "data")
        )

        assert not (out / "mapApp.bundle.js.map").exists()
        assert (out / "mapApp.bundle.js").exists()
        assert (out / "features.bundle.js").exists()
        assert (out / "CNAME").read_text() == "maps.example.org"

    @pytest.mark.usefixtures("bundle")
    def test_output_below_input_directory(self, tmp_path):
        """The documented ``kml-heatmap flight.kml --output-dir out`` layout."""
        kml_file = _write_kml(tmp_path / "1_DEAGJ_DA20.kml")
        out = tmp_path / "out"
        assert (
            create_progressive_heatmap(
                [kml_file], str(out / "index.html"), str(out / "data")
            )
            is True
        )
        assert (out / "data" / "2025" / "data.js").exists()

    @pytest.mark.usefixtures("bundle")
    def test_end_to_end_with_aircraft_data(self, tmp_path, parse_js):
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
        meta = parse_js(out / "data" / "metadata.js", "KML_METADATA")
        assert meta["available_years"] == [2025]
        assert meta["aircraft_models"] == {"D-EAGJ": "Diamond Katana"}
        year = parse_js(out / "data" / "2025" / "data.js", "KML_DATA_2025")
        assert len(year["path_info"]) == 1

    @pytest.mark.usefixtures("bundle")
    def test_removing_an_input_file_keeps_the_other_path_ids(self, tmp_path, parse_js):
        """Path ids end up in shared links, which must keep their flights."""
        # Every file flies through a different waypoint
        kml_files = [
            _write_kml(
                tmp_path / "input" / f"{index + 1}_DEAGJ_DA20.kml",
                year,
                TRACK_KML.replace("12.5 51.4", f"12.{index + 1} 51.4"),
            )
            for index, year in enumerate((2025, 2026, 2025, 2025, 2026))
        ]

        def ids_by_waypoint(out):
            ids = {}
            for data_file in sorted((out / "data").glob("*/data.js")):
                for path_id, entry in parse_js(data_file)["segments"].items():
                    _, rows = decoded_segments(entry)
                    ids[rows[0][1]] = int(path_id)
            return ids

        everything = tmp_path / "all"
        fewer = tmp_path / "fewer"
        assert create_progressive_heatmap(
            kml_files, str(everything / "index.html"), str(everything / "data")
        )
        removed = kml_files.pop(0)
        assert create_progressive_heatmap(
            kml_files, str(fewer / "index.html"), str(fewer / "data")
        )

        before = ids_by_waypoint(everything)
        after = ids_by_waypoint(fewer)
        assert len(before) == 5
        assert removed.endswith("1_DEAGJ_DA20.kml")
        del before[12.1]
        assert after == before
