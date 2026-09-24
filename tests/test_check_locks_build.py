"""Tests for the build lock check of scripts/check_locks.py.

CI builds the wheel without build isolation from requirements-build.lock, so
a range in build-system.requires that the lock no longer meets would build
with the old setuptools while claiming the new one. These tests start from
the passing fixture repository of test_check_locks.py and add a build system
to it.
"""

import pytest

from tests.test_check_locks import check_locks, repo  # noqa: F401

SETUPTOOLS = "84.0.0"


@pytest.fixture
def build_repo(repo):  # noqa: F811
    """The fixture repository with a build system and its lock file."""
    pyproject = repo / "pyproject.toml"
    pyproject.write_text(
        '[build-system]\nrequires = ["setuptools>=82.0.1"]\n'
        + pyproject.read_text(encoding="utf-8"),
        encoding="utf-8",
    )
    (repo / "requirements-build.lock").write_text(
        f"setuptools=={SETUPTOOLS} \\\n    --hash=sha256:abc\n", encoding="utf-8"
    )
    return repo


def test_a_satisfied_build_lock_passes(build_repo):
    assert check_locks.main() == 0


def test_a_build_pin_below_the_requirement_fails(build_repo, capsys):
    (build_repo / "requirements-build.lock").write_text(
        "setuptools==80.0.0 \\\n    --hash=sha256:abc\n", encoding="utf-8"
    )

    assert check_locks.main() == 1
    err = capsys.readouterr().err
    assert "requirements-build.lock pins setuptools==80.0.0" in err
    assert "run `make lock`" in err


def test_a_build_lock_without_setuptools_fails(build_repo, capsys):
    (build_repo / "requirements-build.lock").write_text("", encoding="utf-8")

    assert check_locks.main() == 1
    assert "requirements-build.lock does not pin setuptools" in (
        capsys.readouterr().err
    )


def test_a_missing_build_lock_fails(build_repo, capsys):
    (build_repo / "requirements-build.lock").unlink()

    assert check_locks.main() == 1
    assert "requirements-build.lock is missing" in capsys.readouterr().err
