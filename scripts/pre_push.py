#!/usr/bin/env python3
"""Git pre-push hook: refuse to push KML files that carry real dates.

The repository is public, so the obfuscation check of CI only notices a real
date once it has been published. This hook runs the same check before the
push, on every KML file that the commits about to be pushed add or change,
including commits whose files a later commit fixes again: the history is
published, not just its tip. Commits the remote already has are skipped:
those of its remote-tracking branches, and those of the refs being pushed to
where they are in the clone. Not those of another remote, a fork or a mirror
whose commits the public remote may never have had: a private remote may hold
the raw flights. A push to a URL or to a remote never fetched from has no
remote-tracking branches of its own, so only the refs being pushed to count,
and a first push to a new remote checks the whole history. When that history
is already public elsewhere and clean, `git push --no-verify` skips it.

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
import subprocess
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
# Said by a refusal of a push to a remote the clone has no tracking branches
# of, which counts as having only what the refs pushed to point at there
# (see published): its first push checks history that may be public
# elsewhere already. Not "the whole history", which it was not where the
# clone has the commit of such a ref.
SKIP_HINT = (
    "\nThis remote was never fetched from, so every commit was checked that\n"
    "the refs pushed to there do not already have. If it has these commits\n"
    "anyway, `git push --no-verify` skips the check."
)


def _git(repo: Path, *args: str) -> bytes:
    git = shutil.which("git")
    if git is None:
        raise OSError("git is not on PATH")
    return subprocess.run(  # noqa: S603
        [git, *args],
        cwd=repo,
        capture_output=True,
        check=True,
    ).stdout


def _text(output: bytes) -> str:
    """Output of git as text, whatever the encoding of its file names.

    git hands over names and messages as the bytes they are. A name that is
    no UTF-8 keeps its bytes as surrogates, which turn back into the same
    bytes as an argument of the next git command or as a path, rather than
    failing the hook with a UnicodeDecodeError it would not explain.
    """
    return output.decode(errors="surrogateescape")


def _has_commit(repo: Path, sha: str) -> bool:
    """Whether the commit ``sha`` is in the clone."""
    try:
        _git(repo, "cat-file", "-e", f"{sha}^{{commit}}")
    except subprocess.CalledProcessError:
        return False
    return True


def _is_tracked(repo: Path, remote: str) -> bool:
    """Whether the clone has remote-tracking branches of ``remote``."""
    return bool(
        _git(
            repo,
            "for-each-ref",
            "--count=1",
            "--format=%(refname)",
            f"refs/remotes/{remote}/",
        ).strip()
    )


def published(repo: Path, remote: str, lines: list[str], tracked: bool) -> list[str]:
    """The revisions whose commits the remote already has, for rev-list.

    The remote-tracking branches of ``remote`` and the commit each ref being
    pushed to points at on the remote, where the clone has it: a push that
    only updates a branch does not check everything before it again. A push
    to a URL or to a remote not fetched from has no tracking branches, and
    then only those commits count, never the branches of another remote: a
    private one may hold commits with the raw flights that this remote never
    had, and counting them as published would let them through. The hook
    fails closed, so such a push checks everything else. ``tracked`` is
    whether the remote has tracking branches (``_is_tracked``).
    """
    known = []
    for line in lines:
        fields = line.split()
        if len(fields) == 4 and fields[3] != ZERO_SHA and _has_commit(repo, fields[3]):
            known.append(fields[3])
    remotes = [f"--remotes={remote}"] if tracked else []
    revisions = [*remotes, *dict.fromkeys(known)]
    return ["--not", *revisions] if revisions else []


def commits_to_check(
    repo: Path, exclude: list[str], pushed_shas: list[str]
) -> list[str]:
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
        *exclude,
        "--",
        *KML_PATHSPECS,
    )
    return _text(output).split()


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
    names = [name for name in _text(output).split("\0") if name]
    return list(dict.fromkeys(names))


def added_flights(repo: Path, exclude: list[str], pushed_shas: list[str]) -> list[str]:
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
        *exclude,
        "--",
        *FLIGHT_PATHSPECS,
    )
    names = (name.strip("\n") for name in _text(output).split("\0"))
    return list(dict.fromkeys(name for name in names if name))


def dated_messages(
    repo: Path, exclude: list[str], pushed_shas: list[str]
) -> list[tuple[str, str]]:
    """The dates, weekdays and holidays in the messages of commits to flights.

    Each with the commit it is in, oldest commit first: a message is
    published with the flight its commit adds ("Add flight 16 Aug 2026").
    """
    if not pushed_shas:
        return []
    # Imported here: main() puts the checkout on the path first
    from kml_heatmap.date_tokens import (  # noqa: PLC0415
        find_date_tokens,
        find_holiday_tokens,
        find_partial_date_tokens,
        find_weekday_tokens,
    )

    output = _git(
        repo,
        "log",
        "--reverse",
        "--format=%H%x00%B%x1e",
        *pushed_shas,
        *exclude,
        "--",
        *FLIGHT_PATHSPECS,
    )
    found: list[tuple[str, str]] = []
    for record in _text(output).split("\x1e"):
        commit, _, message = record.strip("\n").partition("\0")
        if not commit:
            continue
        found.extend(
            (commit, token)
            for token in find_date_tokens(message, skip_near_jan_first=True)
            + find_partial_date_tokens(message)
            + find_weekday_tokens(message)
            + find_holiday_tokens(message)
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


def _report(line: str) -> None:
    """Print a line naming a file or a message, with any byte no UTF-8 escaped."""
    shown = line.encode(errors="surrogateescape").decode(errors="backslashreplace")
    print(shown, file=sys.stderr)


def check(repo: Path, lines: list[str], remote: str = "origin") -> int:
    """Print what is wrong and return the hook's exit status."""
    found = False
    tracked = _is_tracked(repo, remote)
    exclude = published(repo, remote, lines, tracked)
    hint = "" if tracked else SKIP_HINT
    for commit in commits_to_check(repo, exclude, pushed_shas(lines)):
        for name, issues in violations_in(repo, commit).items():
            found = True
            for issue in issues:
                _report(f"  {commit[:7]} {name}: {issue}")
    if found:
        print(
            "\nPush refused: the commits above carry real flight dates, and the\n"
            "repository is public. Run `make obfuscate`, then rewrite the\n"
            f"commits (amend or rebase) so none of them holds the originals.{hint}",
            file=sys.stderr,
        )
        return 1
    messages = dated_messages(repo, exclude, pushed_shas(lines))
    for commit, token in messages:
        _report(f"  {commit[:7]} commit message: {token}")
    if messages:
        print(
            "\nPush refused: the messages of the commits above date the flights\n"
            "they add or change, and the repository is public. Reword them\n"
            "without the dates and weekdays: `git commit --amend` for the last\n"
            f"commit, `git rebase -i` with `reword` for an earlier one.{hint}",
            file=sys.stderr,
        )
        return 1
    added = added_flights(repo, exclude, pushed_shas(lines))
    if len(added) == 1:
        print(
            f"pre-push: warning: this push adds one flight ({added[0]}); a "
            "commit with a single flight dates it to about the day it was "
            "pushed, so consider adding it together with others.",
            file=sys.stderr,
        )
    return 0


def main() -> int:
    # The remote's name, or the URL a push names in its place
    remote = sys.argv[1] if len(sys.argv) > 1 else "origin"
    try:
        sys.path.insert(0, str(ROOT))
        return check(Path.cwd(), sys.stdin.read().splitlines(), remote)
    except (ImportError, SyntaxError) as e:
        reason = f"{e}; needs Python 3.14 as python3"
    except subprocess.CalledProcessError as e:
        stderr = e.stderr.decode(errors="replace").strip() if e.stderr else ""
        reason = f"git failed: {stderr or e}"
    except OSError as e:
        reason = str(e)
    except UnicodeError as e:
        reason = f"unexpected text: {e}"
    print(
        f"pre-push: cannot check the KML files ({reason}). Refusing the push; "
        "`git push --no-verify` skips the check.",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
