"""Tests for scripts/check_locks.py.

The script is a CI gate: it is the thing that notices when the lock files,
the Playwright image and the package version drift apart. A gate that
silently stops checking fails open, and every check below therefore starts
from a consistent fixture repository and breaks exactly one thing.
"""

import importlib.util
import json
import sys
from pathlib import Path

import pytest

SCRIPT = Path(__file__).parent.parent / "scripts" / "check_locks.py"


def _load_module():
    """Import check_locks.py, which lives outside any package."""
    spec = importlib.util.spec_from_file_location("check_locks", SCRIPT)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


check_locks = _load_module()

VERSION = "1.0.0"
RUFF = "0.16.4"
PLAYWRIGHT = "1.63.0"
DIGEST = "sha256:" + "ab" * 32
IMAGE = f"mcr.microsoft.com/playwright:v{PLAYWRIGHT}-noble@{DIGEST}"


@pytest.fixture
def repo(tmp_path, monkeypatch):
    """A minimal repository in which every check passes."""
    (tmp_path / "pyproject.toml").write_text(
        "[project]\n"
        'dependencies = ["lxml>=6.0.2"]\n'
        "[project.optional-dependencies]\n"
        'test = ["pytest>=9.0.2"]\n'
        f'dev = ["ruff>={RUFF}"]\n',
        encoding="utf-8",
    )
    (tmp_path / "requirements.lock").write_text(
        "lxml==6.0.2 \\\n    --hash=sha256:abc\n", encoding="utf-8"
    )
    (tmp_path / "requirements-test.lock").write_text(
        "lxml==6.0.2 \\\n    --hash=sha256:abc\n"
        "pytest==9.0.2 \\\n    --hash=sha256:def\n"
        f"ruff=={RUFF} \\\n    --hash=sha256:ghi\n",
        encoding="utf-8",
    )
    (tmp_path / "package.json").write_text(
        json.dumps({"name": "kml-heatmap", "version": VERSION}), encoding="utf-8"
    )
    (tmp_path / "package-lock.json").write_text(
        json.dumps(
            {
                "name": "kml-heatmap",
                "version": VERSION,
                "packages": {
                    "": {"name": "kml-heatmap", "version": VERSION},
                    "node_modules/@playwright/test": {"version": PLAYWRIGHT},
                },
            }
        ),
        encoding="utf-8",
    )
    workflow = tmp_path / ".github" / "workflows"
    workflow.mkdir(parents=True)
    (workflow / "test.yml").write_text(
        f"      image: {IMAGE}\n",
        encoding="utf-8",
    )
    package = tmp_path / "kml_heatmap"
    package.mkdir()
    (package / "__init__.py").write_text(
        f'__version__ = "{VERSION}"\n', encoding="utf-8"
    )

    monkeypatch.setattr(check_locks, "ROOT", tmp_path)
    check_locks.read_package_lock.cache_clear()
    yield tmp_path
    check_locks.read_package_lock.cache_clear()


def edit_json(path: Path, **changes):
    """Rewrite selected top-level keys of a JSON file."""
    data = json.loads(path.read_text(encoding="utf-8"))
    data.update(changes)
    path.write_text(json.dumps(data), encoding="utf-8")


class TestPassingRepository:
    def test_reports_success(self, repo, capsys):
        assert check_locks.main() == 0

        captured = capsys.readouterr()
        assert "satisfy pyproject.toml" in captured.out
        assert captured.err == ""


class TestLockFiles:
    def test_a_pin_below_the_requirement_fails(self, repo, capsys):
        (repo / "requirements.lock").write_text("lxml==6.0.1\n", encoding="utf-8")

        assert check_locks.main() == 1

        err = capsys.readouterr().err
        assert "requirements.lock pins lxml==6.0.1" in err
        assert "make lock" in err

    def test_a_missing_pin_fails(self, repo, capsys):
        (repo / "requirements.lock").write_text("", encoding="utf-8")

        assert check_locks.main() == 1

        assert "requirements.lock does not pin lxml" in capsys.readouterr().err

    def test_a_missing_tool_pin_fails(self, repo, capsys):
        text = (repo / "requirements-test.lock").read_text(encoding="utf-8")
        (repo / "requirements-test.lock").write_text(
            text.replace(f"ruff=={RUFF} \\\n    --hash=sha256:ghi\n", ""),
            encoding="utf-8",
        )

        assert check_locks.main() == 1

        assert "requirements-test.lock does not pin ruff" in capsys.readouterr().err

    def test_the_two_locks_disagreeing_fails(self, repo, capsys):
        """CI installs requirements-test.lock alone where it needs both."""
        (repo / "requirements.lock").write_text("lxml==6.0.3\n", encoding="utf-8")

        assert check_locks.main() == 1

        assert (
            "requirements.lock pins lxml==6.0.3, requirements-test.lock lxml==6.0.2"
            in capsys.readouterr().err
        )

    def test_a_requirement_for_another_platform_is_skipped(self, repo):
        (repo / "pyproject.toml").write_text(
            "[project]\n"
            'dependencies = ["lxml>=6.0.2", "pywin32>=1; sys_platform == \'win32\'"]\n'
            "[project.optional-dependencies]\n"
            'test = ["pytest>=9.0.2"]\n'
            f'dev = ["ruff>={RUFF}"]\n',
            encoding="utf-8",
        )

        assert check_locks.main() == (0 if sys.platform != "win32" else 1)

    def test_a_pin_is_matched_regardless_of_name_spelling(self, repo):
        """pip-compile normalises names; the requirement may not be normalised."""
        (repo / "pyproject.toml").write_text(
            "[project]\n"
            'dependencies = ["LXML>=6.0.2"]\n'
            "[project.optional-dependencies]\n"
            'test = ["pytest>=9.0.2"]\n'
            f'dev = ["ruff>={RUFF}"]\n',
            encoding="utf-8",
        )

        assert check_locks.main() == 0


class TestPlaywrightImage:
    def test_an_image_ahead_of_the_library_fails(self, repo, capsys):
        path = repo / ".github/workflows/test.yml"
        path.write_text(
            path.read_text(encoding="utf-8").replace(
                f"v{PLAYWRIGHT}-noble", "v1.70.0-noble"
            ),
            encoding="utf-8",
        )

        assert check_locks.main() == 1

        assert (
            "runs the Playwright image v1.70.0, package-lock.json pins 1.63.0"
            in capsys.readouterr().err
        )

    def test_an_image_without_a_digest_fails(self, repo, capsys):
        path = repo / ".github/workflows/test.yml"
        path.write_text(
            path.read_text(encoding="utf-8").replace(f"@{DIGEST}", ""),
            encoding="utf-8",
        )

        assert check_locks.main() == 1

        assert "by its @sha256 digest" in capsys.readouterr().err

    def test_a_malformed_digest_is_no_digest(self, repo, capsys):
        path = repo / ".github/workflows/test.yml"
        path.write_text(
            path.read_text(encoding="utf-8").replace(DIGEST, "sha256:abc"),
            encoding="utf-8",
        )

        assert check_locks.main() == 1

        assert "runs no Playwright image" in capsys.readouterr().err

    def test_a_document_quoting_the_same_image_passes(self, repo):
        (repo / "CONTRIBUTING.md").write_text(
            f"```sh\npodman run {IMAGE} npx playwright test\n```\n",
            encoding="utf-8",
        )

        assert check_locks.main() == 0

    def test_a_document_quoting_another_image_fails(self, repo, capsys):
        stale = f"mcr.microsoft.com/playwright:v{PLAYWRIGHT}-noble"
        (repo / "DEVELOPMENT.md").write_text(
            f"Run `podman run {stale} npx playwright test`.\n", encoding="utf-8"
        )

        assert check_locks.main() == 1

        assert (
            f"DEVELOPMENT.md quotes the Playwright image {stale}, "
            f".github/workflows/test.yml runs {IMAGE}"
        ) in capsys.readouterr().err

    def test_a_workflow_without_the_image_fails(self, repo, capsys):
        path = repo / ".github/workflows/test.yml"
        path.write_text("jobs:\n", encoding="utf-8")

        assert check_locks.main() == 1

        assert "runs no Playwright image" in capsys.readouterr().err

    def test_an_unpinned_library_fails(self, repo, capsys):
        lock = json.loads((repo / "package-lock.json").read_text(encoding="utf-8"))
        del lock["packages"]["node_modules/@playwright/test"]
        (repo / "package-lock.json").write_text(json.dumps(lock), encoding="utf-8")
        check_locks.read_package_lock.cache_clear()

        assert check_locks.main() == 1

        assert "does not pin @playwright/test" in capsys.readouterr().err


class TestPackageVersion:
    def test_package_json_out_of_step_fails(self, repo, capsys):
        edit_json(repo / "package.json", version="1.1.0")

        assert check_locks.main() == 1

        err = capsys.readouterr().err
        assert "kml_heatmap/__init__.py is 1.0.0, package.json 1.1.0" in err
        assert "npm install" in err

    def test_the_top_level_lock_version_out_of_step_fails(self, repo, capsys):
        edit_json(repo / "package-lock.json", version="1.1.0")
        check_locks.read_package_lock.cache_clear()

        assert check_locks.main() == 1

        assert 'package-lock.json "version" 1.1.0' in capsys.readouterr().err

    def test_the_root_package_entry_out_of_step_fails(self, repo, capsys):
        lock = json.loads((repo / "package-lock.json").read_text(encoding="utf-8"))
        lock["packages"][""]["version"] = "1.1.0"
        (repo / "package-lock.json").write_text(json.dumps(lock), encoding="utf-8")
        check_locks.read_package_lock.cache_clear()

        assert check_locks.main() == 1

        assert 'package-lock.json packages[""] 1.1.0' in capsys.readouterr().err

    def test_a_missing_python_version_fails(self, repo, capsys):
        (repo / "kml_heatmap/__init__.py").write_text("", encoding="utf-8")

        assert check_locks.main() == 1

        assert "declares no __version__" in capsys.readouterr().err

    def test_a_missing_npm_version_fails(self, repo, capsys):
        path = repo / "package.json"
        path.write_text(json.dumps({"name": "kml-heatmap"}), encoding="utf-8")

        assert check_locks.main() == 1

        assert "package.json declares no version" in capsys.readouterr().err


class TestAgainstTheRealRepository:
    def test_the_checked_in_files_pass(self, capsys):
        """The repository itself is consistent, the way the CI job checks it."""
        check_locks.read_package_lock.cache_clear()

        assert check_locks.main() == 0

        check_locks.read_package_lock.cache_clear()
