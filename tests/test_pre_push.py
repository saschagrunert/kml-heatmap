"""Tests for scripts/pre_push.py, the hook that keeps real dates unpublished.

Every test builds a real repository: what the hook has to get right is which
commits and files git hands it, and a mocked git would only repeat the
assumptions the script makes.
"""

import importlib.util
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPT = Path(__file__).parent.parent / "scripts" / "pre_push.py"

GIT = shutil.which("git")
pytestmark = pytest.mark.skipif(GIT is None, reason="needs git")

CLEAN_KML = (
    "<kml><when>2025-01-01T08:25:15Z</when><when>2025-01-01T08:26:15Z</when></kml>"
)
REAL_KML = (
    "<kml><when>2025-03-03T08:25:15Z</when><when>2025-03-03T08:26:15Z</when></kml>"
)


def _load_module():
    """Import pre_push.py, which lives outside any package."""
    spec = importlib.util.spec_from_file_location("pre_push", SCRIPT)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


pre_push = _load_module()


@pytest.fixture(autouse=True)
def isolated_git(monkeypatch, tmp_path):
    """Keep the user's git configuration (signing, hooks) out of the tests."""
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", os.devnull)
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")
    for name in ("AUTHOR", "COMMITTER"):
        monkeypatch.setenv(f"GIT_{name}_NAME", "Test")
        monkeypatch.setenv(f"GIT_{name}_EMAIL", "test@example.com")


def git(repo: Path, *args: str) -> str:
    assert GIT is not None
    return subprocess.run(  # noqa: S603
        [GIT, *args], cwd=repo, capture_output=True, text=True, check=True
    ).stdout.strip()


@pytest.fixture
def repo(tmp_path):
    """A repository whose first commit (a clean flight) the remote already has."""
    repo = tmp_path / "repo"
    repo.mkdir()
    git(repo, "init", "-q", "-b", "main")
    commit(repo, {"data/1.kml": CLEAN_KML})
    git(repo, "update-ref", "refs/remotes/origin/main", "HEAD")
    return repo


def commit(repo: Path, files: dict[str, str | None], message: str = "c") -> str:
    """Write (or with None, remove) files and commit them; returns the sha."""
    for name, content in files.items():
        path = repo / name
        if content is None:
            git(repo, "rm", "-q", name)
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
        git(repo, "add", name)
    git(repo, "commit", "-q", "-m", message)
    return git(repo, "rev-parse", "HEAD")


def push_of(sha: str, remote_sha: str = pre_push.ZERO_SHA) -> list[str]:
    """The hook's input for pushing ``sha`` to main."""
    return [f"refs/heads/main {sha} refs/heads/main {remote_sha}"]


def run_check(repo: Path, lines: list[str]) -> int:
    status: int = pre_push.check(repo, "origin", lines)
    return status


class TestCheck:
    def test_passes_clean_flights(self, repo):
        sha = commit(repo, {"data/2.kml": CLEAN_KML})
        assert run_check(repo, push_of(sha)) == 0

    def test_refuses_a_real_date(self, repo, capsys):
        sha = commit(repo, {"data/2.kml": REAL_KML})
        assert run_check(repo, push_of(sha)) == 1
        err = capsys.readouterr().err
        assert f"{sha[:7]} data/2.kml" in err
        assert "2025-03-03" in err
        assert "Push refused" in err

    def test_refuses_a_date_with_a_one_digit_month(self, repo, capsys):
        """The shapes of date_tokens: the hook checks what the export strips."""
        kml = CLEAN_KML.replace("</kml>", "<name>Trip 2025/3/3</name></kml>")
        sha = commit(repo, {"data/2.kml": kml})
        assert run_check(repo, push_of(sha)) == 1
        assert "2025/3/3" in capsys.readouterr().err

    def test_refuses_a_real_date_a_later_commit_fixes(self, repo, capsys):
        bad = commit(repo, {"data/2.kml": REAL_KML})
        fixed = commit(repo, {"data/2.kml": CLEAN_KML})
        assert run_check(repo, push_of(fixed)) == 1
        assert f"{bad[:7]} data/2.kml" in capsys.readouterr().err

    def test_refuses_a_real_date_a_merge_drops_again(self, repo):
        # History simplification would skip the side branch: the merge
        # result matches main, which never had the file
        git(repo, "switch", "-q", "-c", "side")
        commit(repo, {"data/2.kml": REAL_KML})
        commit(repo, {"data/2.kml": None})
        git(repo, "switch", "-q", "main")
        commit(repo, {"notes.txt": "x"})
        git(repo, "merge", "-q", "--no-edit", "side")
        assert run_check(repo, push_of(git(repo, "rev-parse", "HEAD"))) == 1

    def test_checks_kml_files_anywhere_and_in_any_case(self, repo):
        sha = commit(repo, {"elsewhere/Flight.KML": REAL_KML})
        assert run_check(repo, push_of(sha)) == 1

    def test_skips_what_the_remote_already_has(self, repo):
        commit(repo, {"data/2.kml": REAL_KML})
        git(repo, "update-ref", "refs/remotes/origin/main", "HEAD")
        sha = commit(repo, {"data/3.kml": CLEAN_KML})
        assert run_check(repo, push_of(sha)) == 0

    def test_ignores_commits_without_kml_files(self, repo):
        sha = commit(repo, {"README.md": "2025-03-03"})
        assert run_check(repo, push_of(sha)) == 0

    def test_ignores_a_deleted_ref(self, repo):
        lines = [f"(delete) {pre_push.ZERO_SHA} refs/heads/old {'a' * 40}"]
        assert run_check(repo, lines) == 0


class TestMain:
    def test_fails_closed_when_it_cannot_check(self, monkeypatch, capsys):
        def broken(*_args):
            raise ImportError("no module named kml_heatmap")

        monkeypatch.setattr(pre_push, "check", broken)
        monkeypatch.setattr(sys, "argv", ["pre-push", "origin"])
        assert pre_push.main() == 1
        assert "--no-verify" in capsys.readouterr().err


class TestInstalledHook:
    def test_git_push_is_refused(self, repo, tmp_path):
        remote = tmp_path / "remote.git"
        git(tmp_path, "init", "-q", "--bare", str(remote))
        git(repo, "remote", "add", "origin", str(remote))
        git(repo, "push", "-q", "origin", "main")
        hook = Path(git(repo, "rev-parse", "--git-path", "hooks/pre-push"))
        hook = hook if hook.is_absolute() else repo / hook
        hook.parent.mkdir(parents=True, exist_ok=True)
        hook.symlink_to(SCRIPT)

        commit(repo, {"data/2.kml": REAL_KML})
        assert GIT is not None
        refused = subprocess.run(  # noqa: S603
            [GIT, "push", "-q", "origin", "main"],
            cwd=repo,
            capture_output=True,
            text=True,
        )
        assert refused.returncode != 0
        assert "Push refused" in refused.stderr

        # Rewritten without the original, the same flight goes through
        git(repo, "reset", "-q", "--hard", "origin/main")
        commit(repo, {"data/2.kml": CLEAN_KML})
        git(repo, "push", "-q", "origin", "main")
