#!/usr/bin/env python3
"""Git pre-push hook: refuse to push KML files that carry real dates.

The repository is public, so the obfuscation CI job only notices a real
date once it has been published. This hook runs the same check before the
push, on every KML file that the commits about to be pushed add or change,
including commits whose files a later commit fixes again: the history is
published, not just its tip. Commits the remote already has are skipped.

Install it once per clone with `make hooks`. It needs nothing but the
Python the project requires, and it fails closed: when it cannot run the
check, the push is refused. `git push --no-verify` skips it.
"""

import shutil
import subprocess  # nosec B404
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# Every KML file, wherever it is and however its extension is spelled
KML_PATHSPEC = ":(glob,icase)**/*.kml"
# What git sends for a ref that is deleted rather than pushed
ZERO_SHA = "0" * 40


def _git(repo: Path, *args: str) -> bytes:
    git = shutil.which("git")
    if git is None:
        raise OSError("git is not on PATH")
    return subprocess.run(  # noqa: S603 # nosec B603
        [git, *args],
        cwd=repo,
        capture_output=True,
        check=True,
    ).stdout


def commits_to_check(repo: Path, remote: str, pushed_shas: list[str]) -> list[str]:
    """The commits being pushed that add or change a KML file, oldest first.

    --full-history keeps a side branch that adds a file and a later merge
    that drops it again; history simplification would skip exactly that.
    """
    if not pushed_shas:
        return []
    output = _git(
        repo,
        "rev-list",
        "--reverse",
        "--full-history",
        *pushed_shas,
        "--not",
        f"--remotes={remote}",
        "--",
        KML_PATHSPEC,
    )
    return output.decode().split()


def changed_kml_files(repo: Path, commit: str) -> list[str]:
    """The KML files a commit adds or changes (against each parent of a merge)."""
    output = _git(
        repo,
        "diff-tree",
        "-r",
        "-m",
        "--root",
        "-z",
        "--no-commit-id",
        "--name-only",
        "--diff-filter=d",
        commit,
        "--",
        KML_PATHSPEC,
    )
    names = [name for name in output.decode().split("\0") if name]
    return list(dict.fromkeys(names))


def violations_in(repo: Path, commit: str) -> dict[str, list[str]]:
    """The obfuscation violations of the KML files a commit adds or changes."""
    # Imported here: main() puts the checkout on the path first
    from kml_heatmap.obfuscate import check_directory_obfuscated

    with tempfile.TemporaryDirectory(prefix="kml-pre-push-") as tmp:
        directory = Path(tmp)
        for name in changed_kml_files(repo, commit):
            target = directory / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(_git(repo, "cat-file", "blob", f"{commit}:{name}"))
        return check_directory_obfuscated(directory)


def pushed_shas(lines: list[str]) -> list[str]:
    """The local commits of the refs being pushed, from the hook's input."""
    shas = []
    for line in lines:
        fields = line.split()
        if len(fields) == 4 and fields[1] != ZERO_SHA:
            shas.append(fields[1])
    return shas


def check(repo: Path, remote: str, lines: list[str]) -> int:
    """Print what is wrong and return the hook's exit status."""
    found = False
    for commit in commits_to_check(repo, remote, pushed_shas(lines)):
        for name, issues in violations_in(repo, commit).items():
            found = True
            for issue in issues:
                print(f"  {commit[:7]} {name}: {issue}", file=sys.stderr)
    if found:
        print(
            "\nPush refused: the commits above carry real flight dates, and the\n"
            "repository is public. Run `make obfuscate`, then rewrite the\n"
            "commits (amend or rebase) so none of them holds the originals.",
            file=sys.stderr,
        )
        return 1
    return 0


def main() -> int:
    remote = sys.argv[1] if len(sys.argv) > 1 else "origin"
    try:
        sys.path.insert(0, str(ROOT))
        return check(Path.cwd(), remote, sys.stdin.read().splitlines())
    except (ImportError, SyntaxError, OSError, subprocess.CalledProcessError) as e:
        print(
            f"pre-push: cannot check the KML files ({e}); needs Python 3.14 as "
            "python3. Refusing the push; `git push --no-verify` skips the check.",
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    sys.exit(main())
