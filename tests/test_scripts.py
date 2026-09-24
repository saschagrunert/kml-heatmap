"""Tests for the helper scripts in scripts/ that have no test file of their own.

The coverage floor counts scripts/ as well, so a script nobody runs in CI
still shows up when it stops doing what its docstring says.
"""

import importlib.util
import os
import subprocess
import sys
from pathlib import Path
from typing import TYPE_CHECKING

import pytest

from kml_heatmap.parser import parse_kml_file

if TYPE_CHECKING:
    from types import ModuleType

SCRIPTS = Path(__file__).parent.parent / "scripts"


def _load(name: str) -> ModuleType:
    """Import a script from scripts/, which is not a package."""
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / f"{name}.py")
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


generate_test_data = _load("generate_test_data")
build_visual_site = _load("build_visual_site")
pre_push = _load("pre_push")


class TestGenerateTestData:
    def test_writes_parseable_flights_under_the_documented_names(
        self, tmp_path, monkeypatch, capsys
    ):
        output = tmp_path / "flights"
        monkeypatch.setattr(
            sys, "argv", ["generate_test_data.py", "3", "--output", str(output)]
        )

        generate_test_data.main()

        files = sorted(output.iterdir())
        assert [path.name.split("_", 1)[0] for path in files] == ["1", "2", "3"]
        for path in files:
            _, registration, aircraft_type = path.stem.split("_")
            assert (registration[:1] + "-" + registration[1:], aircraft_type) in (
                generate_test_data.AIRCRAFT
            )
            coordinates, _, metadata = parse_kml_file(str(path))
            assert len(coordinates) == 50
            assert len(metadata) == 1
        out = capsys.readouterr().out
        assert "Successfully generated 3 KML files" in out
        assert f"make build INPUT_DIR={output}" in out

    def test_reports_progress_every_thousand_files(self, tmp_path, monkeypatch, capsys):
        written = []
        monkeypatch.setattr(
            generate_test_data,
            "generate_kml_file",
            lambda flight_id, *_: written.append(flight_id),
        )
        monkeypatch.setattr(
            sys, "argv", ["generate_test_data.py", "1000", "-o", str(tmp_path)]
        )

        generate_test_data.main()

        assert len(written) == 1000
        assert "Generated 1,000 files..." in capsys.readouterr().out

    def test_the_default_directory_is_named_after_the_count(
        self, tmp_path, monkeypatch
    ):
        monkeypatch.chdir(tmp_path)
        monkeypatch.setattr(sys, "argv", ["generate_test_data.py", "1"])

        generate_test_data.main()

        assert [path.name for path in (tmp_path / "kml_test_1").iterdir()]

    def test_the_altitude_climbs_cruises_and_descends(self):
        path = generate_test_data.generate_flight_path(
            generate_test_data.AIRPORTS["EDDF"], generate_test_data.AIRPORTS["EDDM"]
        )

        altitudes = [alt for _, _, alt in path]
        assert altitudes[0] == 0
        assert altitudes[-1] == 0
        assert min(altitudes[15:35]) >= 1800


class TestBuildVisualSite:
    def test_builds_the_fixture_flights_offline_with_a_fixed_stamp(
        self, tmp_path, monkeypatch
    ):
        site = tmp_path / "visual-site"
        (site / "stale").mkdir(parents=True)
        monkeypatch.setattr(build_visual_site, "SITE_DIR", site)
        monkeypatch.setenv("CARTO_API_KEY", "from-the-user")
        calls = []

        def run(command, *, cwd, env, check):
            cache = Path(env["KML_HEATMAP_CACHE_DIR"])
            calls.append(
                {
                    "command": command,
                    "cwd": cwd,
                    "env": env,
                    "check": check,
                    "cached": sorted(path.name for path in cache.iterdir()),
                }
            )
            return subprocess.CompletedProcess(command, 3)

        monkeypatch.setattr(build_visual_site.subprocess, "run", run)

        assert build_visual_site.main() == 3

        assert not site.exists()
        [call] = calls
        assert call["command"] == [
            sys.executable,
            "-m",
            "kml_heatmap",
            str(build_visual_site.FIXTURE_DIR),
            "--output-dir",
            str(site),
            # Offline: no elevation tiles
            "--no-terrain",
        ]
        assert call["cwd"] == build_visual_site.ROOT
        assert call["check"] is False
        assert call["cached"] == ["airports.csv"]
        env = call["env"]
        assert env["CARTO_API_KEY"] == ""
        assert env["SOURCE_DATE_EPOCH"] == "1735689600"
        assert env["KML_HEATMAP_REQUIRE_AIRPORT_DB"] == "1"
        # The rest of the environment is passed on
        assert env["PATH"] == os.environ["PATH"]


class TestPrePushWithoutGit:
    def test_fails_closed_when_git_is_missing(self, tmp_path, monkeypatch):
        monkeypatch.setattr(pre_push.shutil, "which", lambda _: None)

        with pytest.raises(OSError, match="git is not on PATH"):
            pre_push.commits_to_check(tmp_path, "origin", ["a" * 40])
