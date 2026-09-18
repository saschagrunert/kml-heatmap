"""Command-line interface."""

import argparse
import os
import sys
from pathlib import Path

from . import __version__
from .exceptions import KMLHeatmapError
from .logger import logger, set_debug_mode
from .validation import find_kml_files

# Obfuscation violations listed per file before the rest are summarized
MAX_REPORTED_VIOLATIONS = 5


def _fatal(message: str) -> None:
    """Print a fatal error to stderr and exit with status 1."""
    print(f"Error: {message}", file=sys.stderr)
    sys.exit(1)


def _collect_kml_files(paths: list[str]) -> list[str]:
    """Resolve KML files from file and directory arguments.

    A directory is searched with its subdirectories (see ``find_kml_files``,
    which the obfuscation check uses as well). A file named more than once
    (directly, or through its directory) is processed once; it would otherwise
    be counted twice in every statistic. Paths are normalized but symlinks are
    not followed: a symlink is rejected by the validation later and must not
    shadow its target here.
    """
    kml_files: list[str] = []
    seen: set[str] = set()

    def add(kml_file: str) -> None:
        normalized = os.path.abspath(kml_file)
        if normalized in seen:
            logger.warning("Ignoring duplicate input: %s", kml_file)
            return
        seen.add(normalized)
        kml_files.append(kml_file)

    for path in paths:
        p = Path(path)
        if p.is_dir():
            dir_kml_files = [str(f) for f in find_kml_files(p)]
            if dir_kml_files:
                for kml_file in dir_kml_files:
                    add(kml_file)
                logger.info(
                    "Found %d KML file(s) in directory: %s", len(dir_kml_files), path
                )
            else:
                logger.warning("No KML files found in directory: %s", path)
        elif p.is_file():
            add(path)
        else:
            # A mistyped input would otherwise publish a site without it
            _fatal(f"File or directory not found: {path}")
    return kml_files


def _find_aircraft_files(kml_files: list[str]) -> list[Path]:
    """Find aircraft.json in every distinct input directory (in input order)."""
    aircraft_files: list[Path] = []
    seen: set[Path] = set()
    for kml_file in kml_files:
        input_dir = Path(kml_file).resolve().parent
        if input_dir in seen:
            continue
        seen.add(input_dir)
        candidate = input_dir / "aircraft.json"
        if candidate.is_file():
            aircraft_files.append(candidate)
            logger.info("Using aircraft data from %s", candidate)
    return aircraft_files


def _obfuscate_inputs(kml_files: list[str]) -> list[str]:
    """Rename and rewrite the (validated) input KML files in place for privacy.

    Returns ``kml_files`` with the new path of every renamed Charterware file.
    Exits with an error when a file cannot be rewritten: publishing data that
    still carries real dates would be worse than not publishing at all.
    """
    from .obfuscate import (
        check_kml_obfuscated,
        obfuscate_kml_files,
        rename_charterware_files,
    )
    from .validation import validate_kml_file

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
        _fatal(
            "Could not obfuscate every input file; refusing to continue. See "
            "the messages above: a file that is read-only or not UTF-8 has to "
            "be fixed first, and a date in a place the tool does not rewrite "
            "(such as the file name) has to be removed by hand"
        )

    return [new_names.get(kml_file, kml_file) for kml_file in kml_files]


def _generate(paths: list[str], output_dir: Path) -> None:
    """Obfuscate the inputs and generate the site into ``output_dir``."""
    kml_files = _collect_kml_files(paths)

    if not kml_files:
        _fatal("No KML files specified or found!")

    print("\nKML Heatmap Generator")
    print(f"{'=' * 50}\n")

    output_file = str(output_dir / "index.html")
    data_dir = str(output_dir / "data")

    aircraft_files = _find_aircraft_files(kml_files)

    from .renderer import create_progressive_heatmap
    from .site_assets import BUNDLE_FILE
    from .validation import validate_output_dir

    # Both are checked again inside create_progressive_heatmap, which is
    # public API; checking here stops before the inputs are rewritten
    is_safe, error_msg = validate_output_dir(output_dir, [*kml_files, *aircraft_files])
    if not is_safe:
        _fatal(error_msg or "Unsafe output directory")
    if not BUNDLE_FILE.is_file():
        _fatal(
            f"JavaScript bundle not found: {BUNDLE_FILE} (run 'npm run build' "
            "to generate it); the input files were left unchanged"
        )

    output_dir.mkdir(parents=True, exist_ok=True)

    kml_files = _obfuscate_inputs(kml_files)

    success = create_progressive_heatmap(
        kml_files, output_file, data_dir, aircraft_files=aircraft_files
    )

    if not success:
        _fatal("Heatmap generation failed (see messages above)")


def main() -> None:
    """Main CLI entry point."""
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
  %(prog)s --debug problematic.kml --output-dir out

The input KML files are rewritten IN PLACE before processing: all timestamps
and dates are shifted so that every flight starts on January 1st of its year
(time of day and intervals are preserved) and the creator attribute is
replaced. Charterware files are renamed to January 1st as well
(2026-01-12_1513h_OE-AKI_LOAV-LOAV.kml becomes 2026-01-01_0000h_...). Keep a
copy of the originals if you need the real dates.

The output directory must not be the directory of an input file, or contain
one: the tool replaces and removes its own files in there. An output
directory below the input directory (such as the default, docs) is fine. A
run that fails while generating the site leaves the previous site in the
output directory untouched.
""",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "paths",
        nargs="+",
        metavar="path",
        help="KML file(s) or directory containing KML files",
    )
    parser.add_argument(
        "--output-dir",
        default="docs",
        help="output directory (default: docs)",
    )
    parser.add_argument(
        "--debug",
        action="store_true",
        help="enable debug output to diagnose parsing issues",
    )
    parser.add_argument(
        "--version",
        action="version",
        version=f"%(prog)s {__version__}",
    )

    args = parser.parse_args()

    if args.debug:
        set_debug_mode(True)

    try:
        _generate(args.paths, Path(args.output_dir))
    except (KMLHeatmapError, OSError) as e:
        # Expected failures (an unwritable output directory, a missing airport
        # database) end in one line instead of a traceback
        _fatal(str(e))
