#!/usr/bin/env python3
"""Set up and check the smoke builds of the packaging and container jobs.

Both jobs of .github/workflows/test.yml generate a small site the way a
user would, from the installed wheel or from the image, and need the same
three directories for it:

    <dir>/input  the first three flights of data/ and its subdirectories
    <dir>/cache  the airport and runway fixtures in place of the OurAirports
                 downloads, so nothing is downloaded
    <dir>/site   where the site goes

`prepare <dir>` makes them (`--world-writable` for a run as the image's
own user, which exists only inside the image), and `check <dir>` checks
the site with check_site_files.py and that the fixtures in the cache are
still the fixtures, so the build fetched nothing. Standard library only:
the container job runs it with the runner's Python, which does not have
the package.
"""

import argparse
import filecmp
import shutil
import sys
from pathlib import Path

from check_site_files import site_problems

REPO = Path(__file__).resolve().parent.parent
FIXTURES = REPO / "tests" / "fixtures"
# What stands in for the OurAirports downloads
CACHE_FIXTURES = ("airports.csv", "runways.csv")
# Flights enough to fill a site, few enough to build in seconds
FLIGHTS = 3


def prepare(root: Path, *, world_writable: bool = False) -> None:
    """Make the input, cache and site directories of a smoke build."""
    for name in ("input", "cache", "site"):
        (root / name).mkdir(parents=True, exist_ok=True)
    for name in CACHE_FIXTURES:
        shutil.copy(FIXTURES / name, root / "cache" / name)
    for flight in sorted((REPO / "data").rglob("*.kml"))[:FLIGHTS]:
        shutil.copy(flight, root / "input" / flight.name)
    if world_writable:
        for path in (root, *root.rglob("*")):
            path.chmod(0o777 if path.is_dir() else 0o666)


def problems(root: Path) -> list[str]:
    """What is wrong with the site of a smoke build, empty for nothing."""
    found = site_problems(root / "site")
    found += [
        f"{root / 'cache' / name} is no longer the fixture"
        for name in CACHE_FIXTURES
        if not filecmp.cmp(FIXTURES / name, root / "cache" / name, shallow=False)
    ]
    return found


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Set up or check a smoke build")
    commands = parser.add_subparsers(dest="command", required=True)
    make = commands.add_parser("prepare", help="make the directories of a build")
    make.add_argument("root", type=Path)
    make.add_argument(
        "--world-writable",
        action="store_true",
        help="for a build as a user that exists only inside the image",
    )
    check = commands.add_parser("check", help="check the site of a build")
    check.add_argument("root", type=Path)
    args = parser.parse_args(argv)

    if args.command == "prepare":
        prepare(args.root, world_writable=args.world_writable)
        print(f"Prepared a smoke build in {args.root}")
        return 0
    found = problems(args.root)
    for problem in found:
        print(f"::error::{problem}")
    if found:
        return 1
    print(f"The site in {args.root / 'site'} is complete, and nothing was fetched")
    return 0


if __name__ == "__main__":
    sys.exit(main())
