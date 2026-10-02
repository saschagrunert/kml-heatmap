#!/usr/bin/env python3
"""Git pre-push hook: refuse to push KML files that carry real dates.

The repository is public, so the obfuscation check of CI only notices a real
date once it has been published. This hook runs the same check before the
push, on every KML file that the commits about to be pushed add or change,
including commits whose files a later commit fixes again: the history is
published, not just its tip. Commits the remote already has are skipped.

Install it once per clone with `make hooks`. It needs nothing but the
Python the project requires, and it fails closed: when it cannot run the
check, the push is refused. `git push --no-verify` skips it.

The messages of the commits that add or change a flight in data/ are
published with it: one that names a date or a weekday ("Add flight 16 Aug
2026") is refused as well.

A push that adds exactly one flight to data/ gets a warning, not a refusal:
the files carry no date, but the commit does, and a commit with one new
flight in it dates that flight to about the day it was pushed.
"""

import shutil
import subprocess  # nosec B404
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# Every KML file, wherever it is and however its extension is spelled, and
# every KMZ archive, which the check reports as one it cannot read (the
# generator reads both, see kml_heatmap.validation.find_kml_files)
KML_PATHSPECS = (":(glob,icase)**/*.kml", ":(glob,icase)**/*.kmz")
# The flights of the site
FLIGHT_PATHSPECS = (":(glob,icase)data/**/*.kml", ":(glob,icase)data/**/*.kmz")
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
        *KML_PATHSPECS,
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
        *KML_PATHSPECS,
    )
    names = [name for name in output.decode().split("\0") if name]
    return list(dict.fromkeys(names))


def added_flights(repo: Path, remote: str, pushed_shas: list[str]) -> list[str]:
    """The flight files under data/ that the commits being pushed add."""
    if not pushed_shas:
        return []
    output = _git(
        repo,
        "log",
        "--diff-filter=A",
        "--name-only",
        "--format=",
        "-z",
        *pushed_shas,
        "--not",
        f"--remotes={remote}",
        "--",
        *FLIGHT_PATHSPECS,
    )
    names = (name.strip("\n") for name in output.decode().split("\0"))
    return list(dict.fromkeys(name for name in names if name))


def dated_messages(
    repo: Path, remote: str, pushed_shas: list[str]
) -> list[tuple[str, str]]:
    """The dates and weekdays in the messages of the commits to flights.

    Each with the commit it is in, oldest commit first: a message is
    published with the flight its commit adds ("Add flight 16 Aug 2026").
    """
    if not pushed_shas:
        return []
    # Imported here: main() puts the checkout on the path first
    from kml_heatmap.date_tokens import (  # noqa: PLC0415
        find_date_tokens,
        find_partial_date_tokens,
        find_weekday_tokens,
    )

    output = _git(
        repo,
        "log",
        "--reverse",
        "--format=%H%x00%B%x1e",
        *pushed_shas,
        "--not",
        f"--remotes={remote}",
        "--",
        *FLIGHT_PATHSPECS,
    )
    found: list[tuple[str, str]] = []
    for record in output.decode().split("\x1e"):
        commit, _, message = record.strip("\n").partition("\0")
        if not commit:
            continue
        found.extend(
            (commit, token)
            for token in find_date_tokens(message, skip_near_jan_first=True)
            + find_partial_date_tokens(message)
            + find_weekday_tokens(message)
        )
    return found


def violations_in(repo: Path, commit: str) -> dict[str, list[str]]:
    """The obfuscation violations of the KML files a commit adds or changes."""
    # Imported here: main() puts the checkout on the path first
    from kml_heatmap.obfuscate import check_directory_obfuscated  # noqa: PLC0415

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
    messages = dated_messages(repo, remote, pushed_shas(lines))
    for commit, token in messages:
        print(f"  {commit[:7]} commit message: {token}", file=sys.stderr)
    if messages:
        print(
            "\nPush refused: the messages of the commits above date the flights\n"
            "they add or change, and the repository is public. Reword them\n"
            "without the dates and weekdays: `git commit --amend` for the last\n"
            "commit, `git rebase -i` with `reword` for an earlier one.",
            file=sys.stderr,
        )
        return 1
    added = added_flights(repo, remote, pushed_shas(lines))
    if len(added) == 1:
        print(
            f"pre-push: warning: this push adds one flight ({added[0]}); a "
            "commit with a single flight dates it to about the day it was "
            "pushed, so consider adding it together with others.",
            file=sys.stderr,
        )
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
