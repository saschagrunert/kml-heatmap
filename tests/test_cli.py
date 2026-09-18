"""Tests for CLI module."""

import json
import os
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from kml_heatmap.cli import main
from kml_heatmap.exceptions import KMLHeatmapError

MINIMAL_KML = "<?xml version='1.0'?><kml></kml>"


@pytest.fixture
def workspace(tmp_path):
    """Input directory with a KML file and a separate output directory."""
    input_dir = tmp_path / "input"
    input_dir.mkdir()
    kml = input_dir / "test.kml"
    kml.write_text(MINIMAL_KML)
    return input_dir, kml, tmp_path / "out"


@pytest.fixture(autouse=True)
def bundle(tmp_path, monkeypatch):
    """A stand-in for the bundle, which the Python tests do not build."""
    path = tmp_path / "static" / "mapApp.bundle.js"
    path.parent.mkdir()
    path.write_text("/* bundle */")
    monkeypatch.setattr("kml_heatmap.site_assets.BUNDLE_FILE", path)
    return path


def _run(argv, create_return=True):
    mock_create = MagicMock(return_value=create_return)
    with (
        patch("sys.argv", ["kml-heatmap", *argv]),
        patch("kml_heatmap.renderer.create_progressive_heatmap", mock_create),
    ):
        main()
    return mock_create


class TestArgumentParsing:
    def test_no_arguments_shows_usage(self):
        with patch("sys.argv", ["kml-heatmap"]), pytest.raises(SystemExit) as exc_info:
            main()
        assert exc_info.value.code == 2

    @pytest.mark.parametrize("flag", ["-h", "--help"])
    def test_help(self, capsys, flag):
        with patch("sys.argv", ["kml-heatmap", flag]), pytest.raises(SystemExit) as e:
            main()
        assert e.value.code == 0
        out = capsys.readouterr().out
        assert "--output-dir" in out
        assert "(default: docs)" in out
        assert "--debug" in out
        assert "IN PLACE" in out

    def test_version(self, capsys):
        with (
            patch("sys.argv", ["kml-heatmap", "--version"]),
            pytest.raises(SystemExit) as e,
        ):
            main()
        assert e.value.code == 0
        assert "kml-heatmap 1.0.0" in capsys.readouterr().out

    def test_output_dir_without_argument_exits(self):
        with (
            patch("sys.argv", ["kml-heatmap", "file.kml", "--output-dir"]),
            pytest.raises(SystemExit) as exc_info,
        ):
            main()
        assert exc_info.value.code == 2

    def test_unknown_option_exits(self):
        with (
            patch("sys.argv", ["kml-heatmap", "--unknown-option"]),
            pytest.raises(SystemExit) as exc_info,
        ):
            main()
        assert exc_info.value.code == 2


class TestFileCollection:
    def test_single_kml_file(self, workspace):
        _, kml, out = workspace
        mock_create = _run([str(kml), "--output-dir", str(out)])
        assert mock_create.call_args[0][0] == [str(kml)]

    def test_multiple_kml_files(self, workspace):
        input_dir, kml, out = workspace
        kml2 = input_dir / "test2.kml"
        kml2.write_text(MINIMAL_KML)
        mock_create = _run([str(kml), str(kml2), "--output-dir", str(out)])
        assert mock_create.call_args[0][0] == [str(kml), str(kml2)]

    def test_directory_with_kml_files_sorted_numerically(self, tmp_path):
        kml_dir = tmp_path / "kml_files"
        kml_dir.mkdir()
        for name in ("10_a_b.kml", "2_a_b.kml", "flight3.KML", "readme.txt"):
            (kml_dir / name).write_text(MINIMAL_KML)

        mock_create = _run([str(kml_dir), "--output-dir", str(tmp_path / "out")])

        names = [Path(f).name for f in mock_create.call_args[0][0]]
        assert names == ["2_a_b.kml", "10_a_b.kml", "flight3.KML"]

    def test_directory_is_searched_with_its_subdirectories(self, tmp_path):
        """The obfuscation check sees the same files as the generator."""
        kml_dir = tmp_path / "kml_files"
        (kml_dir / "2025").mkdir(parents=True)
        (kml_dir / "2_a_b.kml").write_text(MINIMAL_KML)
        (kml_dir / "2025" / "1_a_b.kml").write_text(MINIMAL_KML)

        mock_create = _run([str(kml_dir), "--output-dir", str(tmp_path / "out")])

        files = [
            Path(f).relative_to(kml_dir).as_posix() for f in mock_create.call_args[0][0]
        ]
        assert files == ["2_a_b.kml", "2025/1_a_b.kml"]

    def test_directory_without_kml_files_exits(self, tmp_path, capsys):
        empty_dir = tmp_path / "empty"
        empty_dir.mkdir()
        with (
            patch("sys.argv", ["kml-heatmap", str(empty_dir)]),
            pytest.raises(SystemExit) as exc_info,
        ):
            main()
        assert exc_info.value.code == 1
        assert "No KML files specified or found" in capsys.readouterr().err

    def test_nonexistent_input_is_an_error(self, workspace, capsys):
        """A mistyped input must not publish a site without its flights."""
        input_dir, kml, out = workspace
        missing = input_dir / "nonexistent.kml"
        mock_create = MagicMock(return_value=True)
        with (
            patch(
                "sys.argv",
                ["kml-heatmap", str(kml), str(missing), "--output-dir", str(out)],
            ),
            patch("kml_heatmap.renderer.create_progressive_heatmap", mock_create),
            pytest.raises(SystemExit) as exc_info,
        ):
            main()
        assert exc_info.value.code == 1
        assert f"File or directory not found: {missing}" in capsys.readouterr().err
        mock_create.assert_not_called()
        assert not out.exists()

    def test_duplicate_inputs_are_processed_once(self, tmp_path, capsys):
        kml_dir = tmp_path / "flights"
        kml_dir.mkdir()
        (kml_dir / "1_a_b.kml").write_text(MINIMAL_KML)
        (kml_dir / "2_a_b.kml").write_text(MINIMAL_KML)

        mock_create = _run(
            [
                str(kml_dir),
                str(kml_dir / "1_a_b.kml"),
                str(kml_dir / ".." / "flights" / "2_a_b.kml"),
                "--output-dir",
                str(tmp_path / "out"),
            ]
        )

        names = [Path(f).name for f in mock_create.call_args[0][0]]
        assert names == ["1_a_b.kml", "2_a_b.kml"]
        assert capsys.readouterr().err.count("Ignoring duplicate input") == 2

    def test_mixed_files_and_directories(self, tmp_path):
        standalone = tmp_path / "one" / "standalone.kml"
        standalone.parent.mkdir()
        standalone.write_text(MINIMAL_KML)
        kml_dir = tmp_path / "many"
        kml_dir.mkdir()
        (kml_dir / "a.kml").write_text(MINIMAL_KML)
        (kml_dir / "b.kml").write_text(MINIMAL_KML)

        mock_create = _run(
            [str(standalone), str(kml_dir), "--output-dir", str(tmp_path / "out")]
        )
        assert len(mock_create.call_args[0][0]) == 3


class TestOutputHandling:
    def test_output_dir_option_and_creation(self, workspace):
        _, kml, out = workspace
        assert not out.exists()

        mock_create = _run([str(kml), "--output-dir", str(out)])

        assert out.is_dir()
        args = mock_create.call_args[0]
        assert args[1] == str(out / "index.html")
        assert args[2] == str(out / "data")

    def test_processing_failure_exits_with_stderr_message(self, workspace, capsys):
        _, kml, out = workspace
        with pytest.raises(SystemExit) as exc_info:
            _run([str(kml), "--output-dir", str(out)], create_return=False)
        assert exc_info.value.code == 1
        assert "failed" in capsys.readouterr().err.lower()

    def test_overlapping_output_dir_refused_before_processing(self, tmp_path, capsys):
        # The output data directory (<output-dir>/data) would be the input dir
        input_dir = tmp_path / "data"
        input_dir.mkdir()
        kml = input_dir / "test.kml"
        kml.write_text(MINIMAL_KML)
        with pytest.raises(SystemExit) as exc_info:
            _run([str(kml), "--output-dir", str(tmp_path)])
        assert exc_info.value.code == 1
        assert "Refusing" in capsys.readouterr().err
        assert not (tmp_path / "index.html").exists()

    def test_output_dir_equal_to_input_dir_refused(self, workspace, capsys):
        """The tool would replace and remove its own files next to the inputs."""
        input_dir, kml, _ = workspace
        with pytest.raises(SystemExit) as exc_info:
            _run([str(kml), "--output-dir", str(input_dir)])
        assert exc_info.value.code == 1
        assert "Refusing to use output directory" in capsys.readouterr().err
        assert not (input_dir / "index.html").exists()

    @pytest.mark.parametrize("dangerous", ["/", "~"])
    def test_dangerous_output_dir_refused(self, workspace, capsys, dangerous):
        _, kml, _ = workspace
        with pytest.raises(SystemExit) as exc_info:
            _run([str(kml), "--output-dir", os.path.expanduser(dangerous)])
        assert exc_info.value.code == 1
        assert "dangerous" in capsys.readouterr().err

    def test_default_output_dir_next_to_input_is_accepted(self, workspace, monkeypatch):
        """``kml-heatmap flight.kml`` in the file's directory is the documented use."""
        input_dir, kml, _ = workspace
        monkeypatch.chdir(input_dir)
        mock_create = _run([kml.name])
        args = mock_create.call_args[0]
        # Not the current directory, whose index.html it would overwrite
        assert args[1] == str(Path("docs") / "index.html")
        assert args[2] == str(Path("docs") / "data")
        assert (input_dir / "docs").is_dir()

    def test_unusable_output_dir_is_one_line(self, workspace, capsys):
        _, kml, out = workspace
        out.write_text("a file, not a directory")
        with pytest.raises(SystemExit) as exc_info:
            _run([str(kml), "--output-dir", str(out)])
        assert exc_info.value.code == 1
        err = capsys.readouterr().err
        assert err.startswith("Error: [Errno")
        assert "Traceback" not in err

    @pytest.mark.parametrize(
        "error",
        [
            KMLHeatmapError("Airport database unavailable"),
            PermissionError(13, "Permission denied"),
        ],
    )
    def test_pipeline_errors_are_one_line(self, workspace, capsys, error):
        _, kml, out = workspace
        with (
            patch("sys.argv", ["kml-heatmap", str(kml), "--output-dir", str(out)]),
            patch("kml_heatmap.renderer.create_progressive_heatmap", side_effect=error),
            pytest.raises(SystemExit) as exc_info,
        ):
            main()
        assert exc_info.value.code == 1
        err = capsys.readouterr().err
        assert f"Error: {error}" in err
        assert "Traceback" not in err


class TestDebugFlag:
    def test_debug_flag_enables_debug_mode(self, workspace):
        _, kml, out = workspace
        with patch("kml_heatmap.cli.set_debug_mode") as mock_set_debug:
            _run(["--debug", str(kml), "--output-dir", str(out)])
        mock_set_debug.assert_called_once_with(True)


class TestAircraftFiles:
    def test_aircraft_json_from_every_input_directory(self, tmp_path):
        dir_a = tmp_path / "a"
        dir_b = tmp_path / "b"
        dir_c = tmp_path / "c"
        for d in (dir_a, dir_b, dir_c):
            d.mkdir()
            (d / "flight.kml").write_text(MINIMAL_KML)
        (dir_a / "aircraft.json").write_text(json.dumps({"D-EAGJ": "A"}))
        (dir_b / "aircraft.json").write_text(json.dumps({"D-EHYL": "B"}))

        mock_create = _run(
            [
                str(dir_a / "flight.kml"),
                str(dir_b / "flight.kml"),
                str(dir_c / "flight.kml"),
                str(dir_a / "flight.kml"),
                "--output-dir",
                str(tmp_path / "out"),
            ]
        )

        aircraft_files = mock_create.call_args.kwargs["aircraft_files"]
        assert aircraft_files == [dir_a / "aircraft.json", dir_b / "aircraft.json"]

    def test_no_aircraft_json(self, workspace):
        _, kml, out = workspace
        mock_create = _run([str(kml), "--output-dir", str(out)])
        assert mock_create.call_args.kwargs["aircraft_files"] == []


class TestObfuscateFlag:
    def test_obfuscate_runs_before_processing(self, workspace):
        _, kml, out = workspace
        calls = []
        mock_create = MagicMock(
            side_effect=lambda *a, **k: calls.append("create") or True
        )
        with (
            patch(
                "sys.argv",
                ["kml-heatmap", str(kml), "--output-dir", str(out)],
            ),
            patch("kml_heatmap.renderer.create_progressive_heatmap", mock_create),
            patch(
                "kml_heatmap.obfuscate.obfuscate_kml_files",
                side_effect=lambda paths: calls.append(("obfuscate", list(paths))) or 1,
            ),
        ):
            main()
        assert calls == [("obfuscate", [kml]), "create"]

    def test_obfuscate_skips_files_failing_validation(self, workspace):
        input_dir, kml, out = workspace
        link = input_dir / "link.kml"
        os.symlink(kml, link)
        empty = input_dir / "empty.kml"
        empty.write_text("")

        with patch("kml_heatmap.obfuscate.obfuscate_kml_files") as mock_obfuscate:
            _run(
                [
                    str(link),
                    str(empty),
                    str(kml),
                    "--output-dir",
                    str(out),
                ]
            )

        mock_obfuscate.assert_called_once_with([kml])

    def test_obfuscate_rewrites_input_in_place(self, tmp_path):
        input_dir = tmp_path / "input"
        input_dir.mkdir()
        kml = input_dir / "flight.kml"
        kml.write_text(
            "<kml><Placemark><gx:Track>"
            "<when>2025-03-03T08:25:15Z</when><gx:coord>12.0 51.5 100</gx:coord>"
            "</gx:Track></Placemark></kml>"
        )

        _run([str(kml), "--output-dir", str(tmp_path / "out")])

        assert "2025-01-01T08:25:15Z" in kml.read_text()

    def test_renamed_charterware_files_are_processed_under_their_new_name(
        self, tmp_path
    ):
        input_dir = tmp_path / "input"
        input_dir.mkdir()
        kml = input_dir / "2025-03-03_0825h_OE-AKI_LOAV-LOAV.kml"
        kml.write_text(
            "<kml><Placemark><gx:Track>"
            "<when>2025-03-03T08:25:15Z</when><gx:coord>12.0 51.5 100</gx:coord>"
            "</gx:Track></Placemark></kml>"
        )

        mock_create = _run([str(input_dir), "--output-dir", str(tmp_path / "out")])

        renamed = input_dir / "2025-01-01_0000h_OE-AKI_LOAV-LOAV.kml"
        assert not kml.exists()
        assert "2025-01-01T08:25:15Z" in renamed.read_text()
        assert mock_create.call_args.args[0] == [str(renamed)]


class TestMissingBundle:
    def test_stops_before_touching_the_inputs(self, tmp_path, bundle, capsys):
        bundle.unlink()
        input_dir = tmp_path / "input"
        input_dir.mkdir()
        kml = input_dir / "2025-03-03_0825h_OE-AKI_LOAV-LOAV.kml"
        original = (
            "<kml><Placemark><gx:Track><when>2025-03-03T08:25:15Z</when>"
            "<gx:coord>12.0 51.5 100</gx:coord></gx:Track></Placemark></kml>"
        )
        kml.write_text(original)

        with pytest.raises(SystemExit) as excinfo:
            _run([str(input_dir), "--output-dir", str(tmp_path / "out")])

        assert excinfo.value.code == 1
        assert "npm run build" in capsys.readouterr().err
        assert kml.read_text() == original
        assert not (tmp_path / "out").exists()


class TestObfuscationFailsClosed:
    def test_exits_when_a_file_still_contains_dates(self, tmp_path, monkeypatch):
        input_dir = tmp_path / "input"
        input_dir.mkdir()
        kml = input_dir / "1_DEAGJ_DA20.kml"
        kml.write_text(
            '<?xml version="1.0"?><kml><when>2024-03-14T10:00:00Z</when></kml>',
            encoding="utf-8",
        )

        # Simulate a rewrite that leaves the real date in place
        monkeypatch.setattr("kml_heatmap.obfuscate.obfuscate_kml_files", lambda _: 0)

        with pytest.raises(SystemExit) as excinfo:
            _run([str(kml), "--output-dir", str(tmp_path / "out")])
        assert excinfo.value.code == 1

    def test_names_the_dates_it_could_not_remove(self, tmp_path, capsys):
        input_dir = tmp_path / "input"
        input_dir.mkdir()
        # A date in a place the obfuscation does not rewrite
        kml = input_dir / "2024-03-14 EDAQ.kml"
        kml.write_text(
            '<?xml version="1.0"?><kml><when>2024-01-01T10:00:00Z</when></kml>',
            encoding="utf-8",
        )

        with pytest.raises(SystemExit):
            _run([str(kml), "--output-dir", str(tmp_path / "out")])

        err = capsys.readouterr().err
        assert "Not obfuscated: " in err
        assert "File name contains a date: 2024-03-14" in err
        assert "removed by hand" in err

    def test_lists_a_few_dates_and_counts_the_rest(self, tmp_path, capsys):
        input_dir = tmp_path / "input"
        input_dir.mkdir()
        kml = input_dir / "flight.kml"
        dates = " ".join(f"2024-03-{day:02d}" for day in range(10, 20))
        kml.write_text(
            "<kml><when>2024-01-01T10:00:00Z</when>"
            f"<ExtendedData>{dates}</ExtendedData></kml>",
            encoding="utf-8",
        )

        with pytest.raises(SystemExit):
            _run([str(kml), "--output-dir", str(tmp_path / "out")])

        err = capsys.readouterr().err
        assert "2024-03-14" in err
        assert "... and 5 more" in err
