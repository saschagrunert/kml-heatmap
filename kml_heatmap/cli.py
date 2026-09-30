"""Command-line interface.

The exit status tells what went wrong: 0 for a site written (or a listing
printed), 2 for a problem with what the command was given (a usage error, a
missing or invalid input, an output directory it must not write), 1 for a
build that failed on the way and 130 when it was interrupted. Every failure
ends in one line on stderr.
"""

import argparse
import logging
import os
import sys
from pathlib import Path
from typing import TYPE_CHECKING, NoReturn

from . import __version__
from .exceptions import (
    InvalidInputError,
    KMLHeatmapError,
    OutputRefusedError,
)
from .logger import logger, set_debug_mode, set_log_level
from .validation import find_kml_files, validate_kml_file, validate_output_dir

if TYPE_CHECKING:
    from collections.abc import Sequence

    from .renderer import FlightListing

# Obfuscation violations listed per file before the rest are summarized
MAX_REPORTED_VIOLATIONS = 5

# The exit statuses (see the module)
EXIT_FAILED = 1
EXIT_USAGE = 2
EXIT_INTERRUPTED = 130

# Read by kml_heatmap.cache when it is first imported
CACHE_DIR_ENV = "KML_HEATMAP_CACHE_DIR"


def _fatal(message: str, status: int = EXIT_FAILED) -> NoReturn:
    """Print a fatal error to stderr and exit."""
    print(f"Error: {message}", file=sys.stderr)
    sys.exit(status)


def _collect_kml_files(paths: list[str]) -> tuple[list[str], dict[str, Path]]:
    """Resolve KML files from file and directory arguments.

    A directory is searched with its subdirectories (see ``find_kml_files``,
    which the obfuscation check uses as well). A file named more than once
    (directly, or through its directory) is processed once; it would otherwise
    be counted twice in every statistic. Paths are normalized but symlinks are
    not followed: a symlink is rejected by the validation later and must not
    shadow its target here.

    Also returns the input root of every file: the directory argument it was
    found in, or its own directory for a file named directly, which is as
    far up as ``_find_aircraft_files`` looks.
    """
    kml_files: list[str] = []
    roots: dict[str, Path] = {}
    seen: set[str] = set()

    def add(kml_file: str, root: Path) -> None:
        normalized = os.path.abspath(kml_file)
        if normalized in seen:
            logger.warning("Ignoring duplicate input: %s", kml_file)
            return
        seen.add(normalized)
        kml_files.append(kml_file)
        roots[kml_file] = root

    for path in paths:
        p = Path(path)
        if p.is_dir():
            dir_kml_files = [str(f) for f in find_kml_files(p)]
            if dir_kml_files:
                for kml_file in dir_kml_files:
                    add(kml_file, p)
                logger.info(
                    "Found %d KML file(s) in directory: %s", len(dir_kml_files), path
                )
            else:
                logger.warning("No KML files found in directory: %s", path)
        elif p.is_file():
            add(path, p.parent)
        else:
            # A mistyped input would otherwise publish a site without it
            raise InvalidInputError(f"File or directory not found: {path}")
    return kml_files, roots


def _find_aircraft_files(
    kml_files: list[str], roots: dict[str, Path] | None = None
) -> list[Path]:
    """The aircraft.json files for the inputs, the nearest one first.

    For every file (in input order) its own directory and each one above it
    up to and including the input root it was found in (``roots``, its own
    directory by default): an aircraft.json next to data/ covers the flights
    in data/2025/ as well. ``merge_aircraft_data`` lets the first file win,
    so a file in a subdirectory is put before the ones of the directories
    above it, and otherwise the files keep the order they were found in.
    """
    roots = roots or {}
    aircraft_files: list[Path] = []
    seen: set[Path] = set()
    for kml_file in kml_files:
        directory = Path(kml_file).resolve().parent
        root = roots.get(kml_file, Path(kml_file).parent).resolve()
        for candidate_dir in (directory, *directory.parents):
            candidate = candidate_dir / "aircraft.json"
            if candidate_dir not in seen and candidate.is_file():
                # Before the first file of a directory above it, if any
                position = next(
                    (
                        index
                        for index, found in enumerate(aircraft_files)
                        if found.parent in candidate_dir.parents
                    ),
                    len(aircraft_files),
                )
                aircraft_files.insert(position, candidate)
                logger.info("Using aircraft data from %s", candidate)
            seen.add(candidate_dir)
            if candidate_dir == root or root not in candidate_dir.parents:
                break
    return aircraft_files


def _obfuscate_inputs(kml_files: list[str]) -> list[str]:
    """Rename and rewrite the (validated) input KML files in place for privacy.

    Only runs with ``--obfuscate-inputs``; see ``_generate``. Returns
    ``kml_files`` with the new path of every renamed Charterware file. Raises
    when a file cannot be rewritten: leaving a file the user asked to scrub
    with its real dates would be worse than not running at all.
    """
    # Reads the cache directory at import, which --cache-dir sets first
    from .obfuscate import (  # noqa: PLC0415
        check_kml_obfuscated,
        obfuscate_kml_files,
        rename_charterware_files,
    )

    valid: list[Path] = []
    valid_names: list[str] = []
    for kml_file in kml_files:
        is_valid, error_msg = validate_kml_file(kml_file)
        if is_valid:
            valid.append(Path(kml_file))
            valid_names.append(kml_file)
        else:
            # An invalid file fails the run later, before anything is
            # published, so it cannot leak anything
            logger.warning("Not obfuscating: %s", error_msg)

    renamed = rename_charterware_files(valid)
    # Keyed by the given spelling: Path() would normalize "./a.kml" to "a.kml"
    new_names = {
        name: str(new)
        for name, old, new in zip(valid_names, valid, renamed, strict=True)
        if new != old
    }
    modified = obfuscate_kml_files(renamed)
    logger.info("Obfuscated %d of %d KML file(s) in place", modified, len(renamed))

    failed = False
    for path in renamed:
        violations = check_kml_obfuscated(path)
        if not violations:
            continue
        failed = True
        logger.error("Not obfuscated: %s", path)
        for violation in violations[:MAX_REPORTED_VIOLATIONS]:
            logger.error("  %s", violation)
        if len(violations) > MAX_REPORTED_VIOLATIONS:
            logger.error("  ... and %d more", len(violations) - MAX_REPORTED_VIOLATIONS)
    if failed:
        raise KMLHeatmapError(
            "Could not obfuscate every input file; refusing to continue. See "
            "the messages above: a file that is read-only or not UTF-8 has to "
            "be fixed first, and a date in a place the tool does not rewrite "
            "(such as the file name) has to be removed by hand"
        )

    return [new_names.get(kml_file, kml_file) for kml_file in kml_files]


def _symbol(ok: bool) -> str:
    """The mark of a row: a symbol on a terminal, ASCII anywhere else."""
    if sys.stdout.isatty():
        return "✓" if ok else "⚠"
    return "ok" if ok else "--"


def format_listing(rows: Sequence[FlightListing]) -> str:
    """The ``--list`` table: one line per path, and per file without one."""
    header = ("", "file", "year", "aircraft", "airports", "points", "timed", "note")
    lines = [
        (
            _symbol(not row.skipped),
            Path(row.file).name,
            str(row.year) if row.year is not None else "-",
            row.aircraft or "-",
            row.airports or "-",
            str(row.points),
            "yes" if row.timed else "no",
            row.skipped or "published",
        )
        for row in rows
    ]
    # Every column but the note, which ends the line, as wide as its widest
    padded = len(header) - 1
    widths = [max(len(line[i]) for line in [header, *lines]) for i in range(padded)]
    text = [
        "  ".join(
            [
                *(
                    cell.ljust(width)
                    for cell, width in zip(line[:padded], widths, strict=True)
                ),
                line[padded],
            ]
        ).rstrip()
        for line in [header, *lines]
    ]
    published = sum(1 for row in rows if not row.skipped)
    text.append(f"{published} of {len(rows)} flight(s) would be published")
    return "\n".join(text)


def _list(paths: list[str]) -> None:
    """Print what a build of ``paths`` would publish, and write nothing."""
    # Needs lxml and reads the cache directory, see _generate
    from .renderer import list_flights  # noqa: PLC0415

    kml_files, _ = _collect_kml_files(paths)
    if not kml_files:
        raise InvalidInputError("No KML files specified or found!")
    print(format_listing(list_flights(kml_files)))


def _generate(
    paths: list[str],
    output_dir: Path,
    obfuscate_inputs: bool,
    terrain: bool = True,
    force: bool = False,
    site_url: str | None = None,
    private: bool = False,
    quiet: bool = False,
) -> None:
    """Generate the site into ``output_dir``.

    ``terrain`` samples the ground under the flights from the elevation
    tiles of AWS (see ``kml_heatmap.terrain``), which are downloaded once
    into the cache directory. ``force`` replaces the files of a site that
    no earlier run wrote (see ``renderer.foreign_output_error``).
    ``site_url`` is where the site is published, which its link preview
    images are named by (see ``kml_heatmap.previews``); None takes it from
    ``KML_HEATMAP_SITE_URL``. ``private`` asks search engines not to index
    the site. ``quiet`` leaves out the banner and prints one line at the end.

    The generated site never carries a flight date finer than the year,
    whatever the inputs hold: the exported paths keep their year, their
    relative timing and nothing else (see ``data_exporter``). Rewriting the
    inputs is therefore not needed to publish safely and is not done unless
    ``obfuscate_inputs`` asks for it, because it cannot be undone.

    The modules below are imported here rather than at the top: they need
    lxml and the minifiers, which ``--help`` and ``--version`` do not, and
    they read the cache directory, which ``--cache-dir`` sets first.
    """
    # See the docstring: lxml, the minifiers and the cache directory
    from .previews import SITE_URL_ENV, normalize_site_url  # noqa: PLC0415

    try:
        site_url = normalize_site_url(
            site_url if site_url is not None else os.environ.get(SITE_URL_ENV)
        )
    except ValueError as e:
        raise InvalidInputError(str(e)) from None

    kml_files, roots = _collect_kml_files(paths)

    if not kml_files:
        raise InvalidInputError("No KML files specified or found!")

    if not quiet:
        print("\nKML Heatmap Generator")
        print(f"{'=' * 50}\n")

    output_file = str(output_dir / "index.html")
    data_dir = str(output_dir / "data")

    aircraft_files = _find_aircraft_files(kml_files, roots)

    # Lazy for the same reasons as the previews above
    from .renderer import (  # noqa: PLC0415
        create_progressive_heatmap,
        foreign_output_error,
    )
    from .site_assets import missing_build_files  # noqa: PLC0415

    # All are checked again inside create_progressive_heatmap, which is
    # public API; checking here stops before --obfuscate-inputs rewrites them
    is_safe, error_msg = validate_output_dir(output_dir, [*kml_files, *aircraft_files])
    if not is_safe:
        raise OutputRefusedError(error_msg or "Unsafe output directory")
    foreign = None if force else foreign_output_error(output_file, data_dir)
    if foreign:
        raise OutputRefusedError(foreign)
    missing = missing_build_files()
    if missing:
        raise KMLHeatmapError(
            f"JavaScript bundle not found: {', '.join(missing)} (run 'npm run "
            "build' to generate it); the input files were left unchanged"
        )

    output_dir.mkdir(parents=True, exist_ok=True)

    if obfuscate_inputs:
        kml_files = _obfuscate_inputs(kml_files)

    # Reads the cache directory at import, like the others above
    from .terrain import TerrariumTiles  # noqa: PLC0415

    result = create_progressive_heatmap(
        kml_files,
        output_file,
        data_dir,
        aircraft_files=aircraft_files,
        terrain=TerrariumTiles() if terrain else None,
        force=force,
        # "" rather than None: resolved above, the environment is not read
        # a second time
        site_url=site_url or "",
        private=private,
    )
    if quiet:
        # The line the quiet run is for: where the site went
        years = ", ".join(str(year) for year in result.years)
        print(f"Wrote the site to {output_dir} ({years})")


def _refresh_airports() -> None:
    """Mark the cached OurAirports files expired, so the run downloads them.

    The files stay until a download replaces them: offline, the run goes on
    with them and says so (see ``airport_lookup._ensure_cache_file``).
    """
    # Reads the cache directory at import, which --cache-dir sets first
    from .airport_lookup import refresh_airport_databases  # noqa: PLC0415

    refresh_airport_databases()
    logger.info("Marked the cached airport database for a fresh download")


def _jobs(text: str) -> int:
    """``--jobs``: a whole number of at least 1."""
    try:
        jobs = int(text)
    except ValueError:
        raise argparse.ArgumentTypeError(f"not a number: {text!r}") from None
    if jobs < 1:
        raise argparse.ArgumentTypeError(f"must be at least 1, not {jobs}")
    return jobs


def build_parser() -> argparse.ArgumentParser:
    """The command line's arguments, grouped as ``--help`` shows them."""
    parser = argparse.ArgumentParser(
        prog="kml-heatmap",
        description=(
            "Create interactive heatmap visualizations"
            " from KML files with altitude profiles."
        ),
        epilog="""
examples:
  %(prog)s flight.kml --output-dir out
  %(prog)s ./my_flights/ --output-dir out
  %(prog)s *.kml --output-dir mymap
  %(prog)s --list ./my_flights/
  %(prog)s --debug problematic.kml --output-dir out
  %(prog)s --obfuscate-inputs ./my_flights/ --output-dir out

The input KML files are read and left alone. The generated site never carries
a flight date finer than the year in the first place: a flight keeps its year
and the intervals between its points, and every absolute timestamp is dropped
on export. The only full date in it is the day the site was built.

--obfuscate-inputs additionally rewrites the input files THEMSELVES, IN PLACE
and IRREVERSIBLY, so that the files on disk carry no real dates either (useful
before committing or sharing them). All timestamps and dates are shifted so
that every flight starts at midnight (UTC) on January 1st of its year, which
keeps the intervals between its points but neither its date nor its time of
day, and the creator attribute is replaced. Charterware files are
renamed to January 1st as well (2026-01-12_1513h_OE-AKI_LOAV-LOAV.kml becomes
2026-01-01_0000h_...). Keep a copy of the originals if you need the real
dates. The same rewrite is available on its own, without generating a site, as
`python -m kml_heatmap.obfuscate <path>`.

The output directory must not be the directory of an input file, or contain
one: the tool replaces and removes its own files in there. An output
directory below the input directory (such as the default, docs) is fine. A
run that fails while generating the site leaves the previous site in the
output directory untouched. An output directory with files of another site
(an index.html, a styles.css) and no sign of an earlier run of this tool
(map_config.js, data/metadata.json) is refused unless --force is given.

exit status: 0 on success, 2 for a usage error, a missing or invalid input or
a refused output directory, 1 when the build failed, 130 when interrupted.
""",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "paths",
        nargs="+",
        metavar="path",
        help="KML or KMZ file(s) or directory containing them",
    )
    parser.add_argument(
        "--version",
        action="version",
        version=f"%(prog)s {__version__}",
    )

    output = parser.add_argument_group("output")
    output.add_argument(
        "--output-dir",
        metavar="DIR",
        default="docs",
        help="output directory (default: docs)",
    )
    output.add_argument(
        "--force",
        action="store_true",
        help=(
            "replace the files of a site in the output directory that no "
            "earlier run of this tool wrote (such as an index.html of its own)"
        ),
    )
    output.add_argument(
        "--site-url",
        metavar="URL",
        help=(
            "the address the site is published at, such as "
            "https://example.org/flights (default: $KML_HEATMAP_SITE_URL); "
            "with it every year and flight gets a link preview image, "
            "which needs an absolute URL"
        ),
    )
    output.add_argument(
        "--list",
        action="store_true",
        help=(
            "list every flight of the inputs with its year, aircraft, "
            "airports and points, and why any would be left out; writes no "
            "site and downloads no elevation tiles"
        ),
    )
    output.add_argument(
        "-q",
        "--quiet",
        action="store_true",
        help="print warnings and errors only, and one line at the end",
    )
    output.add_argument(
        "--debug",
        action="store_true",
        help="enable debug output to diagnose parsing issues",
    )

    privacy = parser.add_argument_group("privacy")
    privacy.add_argument(
        "--obfuscate-inputs",
        action="store_true",
        help=(
            "also rewrite the input KML files in place, irreversibly, so that "
            "they carry no real dates either (the generated site never does); "
            "keep a copy of the originals first"
        ),
    )
    privacy.add_argument(
        "--private",
        action="store_true",
        help=(
            "ask search engines not to index the site (a robots meta tag in "
            "the page); it is still public to anyone with the address"
        ),
    )

    network = parser.add_argument_group("network and cache")
    network.add_argument(
        "--no-terrain",
        dest="terrain",
        action="store_false",
        help=(
            "do not sample the ground under the flights from elevation tiles; "
            "the 3D view then puts each flight on a line between its airfields "
            "(the tiles of the flown area are otherwise downloaded once from "
            "AWS and cached)"
        ),
    )
    network.add_argument(
        "--cache-dir",
        metavar="DIR",
        help=(
            "where the airport database, the elevation tiles and the parse "
            "cache are kept (default: $KML_HEATMAP_CACHE_DIR, else "
            "~/.cache/kml-heatmap)"
        ),
    )
    network.add_argument(
        "--refresh-airports",
        action="store_true",
        help=(
            "download the OurAirports database again instead of using the "
            "cached copy (renewed every 30 days otherwise)"
        ),
    )
    network.add_argument(
        "--jobs",
        metavar="N",
        type=_jobs,
        help="use at most N worker processes (default: one per CPU)",
    )
    return parser


def main() -> None:
    """Main CLI entry point; exits with the status the module describes."""
    # argparse exits with 2 on a usage error by itself
    args = build_parser().parse_args()

    if args.debug:
        set_debug_mode(True)
    elif args.quiet:
        set_log_level(logging.WARNING)
    if args.cache_dir:
        # Before anything reads it: kml_heatmap.cache does at import
        os.environ[CACHE_DIR_ENV] = str(Path(args.cache_dir).expanduser().resolve())
    if args.jobs:
        # After --cache-dir: workers imports the airport lookup, which
        # reads the cache directory at import
        from .workers import configure_workers  # noqa: PLC0415

        configure_workers(args.jobs)

    try:
        if args.refresh_airports:
            _refresh_airports()
        if args.list:
            _list(args.paths)
            return
        _generate(
            args.paths,
            Path(args.output_dir),
            args.obfuscate_inputs,
            args.terrain,
            args.force,
            args.site_url,
            args.private,
            args.quiet and not args.debug,
        )
    except KeyboardInterrupt:
        _fatal("Interrupted", EXIT_INTERRUPTED)
    except (InvalidInputError, OutputRefusedError) as e:
        _fatal(str(e), EXIT_USAGE)
    except (KMLHeatmapError, OSError) as e:
        # Expected failures (an unwritable output directory, a missing airport
        # database) end in one line instead of a traceback
        _fatal(str(e))
