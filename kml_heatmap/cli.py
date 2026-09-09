"""Command-line interface."""

import argparse
import sys
from pathlib import Path

from . import __version__
from .helpers import numeric_filename_key
from .logger import logger, set_debug_mode


def _fatal(message: str) -> None:
    """Print a fatal error to stderr and exit with status 1."""
    print(f"Error: {message}", file=sys.stderr)
    sys.exit(1)


def _collect_kml_files(paths: list[str]) -> list[str]:
    """Resolve KML files from file and directory arguments."""
    kml_files: list[str] = []
    for path in paths:
        p = Path(path)
        if p.is_dir():
            dir_kml_files = sorted(
                (str(p / f.name) for f in p.iterdir() if f.suffix.lower() == ".kml"),
                key=numeric_filename_key,
            )
            if dir_kml_files:
                kml_files.extend(dir_kml_files)
                logger.info(
                    "Found %d KML file(s) in directory: %s", len(dir_kml_files), path
                )
            else:
                logger.warning("No KML files found in directory: %s", path)
        elif p.is_file():
            kml_files.append(path)
        else:
            logger.warning("File or directory not found: %s", path)
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


def _obfuscate_inputs(kml_files: list[str]) -> None:
    """Rewrite the (validated) input KML files in place for privacy.

    Exits with an error when a file cannot be rewritten: publishing data that
    still carries real dates would be worse than not publishing at all.
    """
    from .obfuscate import check_kml_obfuscated, obfuscate_kml_files
    from .validation import validate_kml_file

    valid: list[Path] = []
    for kml_file in kml_files:
        is_valid, error_msg = validate_kml_file(kml_file)
        if is_valid:
            valid.append(Path(kml_file))
        else:
            # Invalid files are skipped by the parser too, so they are never
            # published and cannot leak anything
            logger.warning("Not obfuscating: %s", error_msg)

    modified = obfuscate_kml_files(valid)
    logger.info("Obfuscated %d of %d KML file(s) in place", modified, len(valid))

    failed = [path for path in valid if check_kml_obfuscated(path)]
    for path in failed:
        logger.error("Still contains real dates: %s", path)
    if failed:
        _fatal(
            "Could not obfuscate every input file; refusing to continue "
            "(see the messages above)"
        )


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
replaced. Keep a copy of the originals if you need the real dates.

The output data directory (<output-dir>/data) must not overlap with the
directory of any input file.
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
        default=".",
        help="output directory (default: current directory)",
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

    kml_files = _collect_kml_files(args.paths)

    if not kml_files:
        _fatal("No KML files specified or found!")

    print("\nKML Heatmap Generator")
    print(f"{'=' * 50}\n")

    output_dir = Path(args.output_dir)
    output_file = str(output_dir / "index.html")
    data_dir = str(output_dir / "data")

    aircraft_files = _find_aircraft_files(kml_files)

    from .renderer import create_progressive_heatmap
    from .validation import validate_output_dir

    # Validated again inside create_progressive_heatmap, which is public API;
    # checking here reports the problem before any work is done.
    is_safe, error_msg = validate_output_dir(data_dir, [*kml_files, *aircraft_files])
    if not is_safe:
        _fatal(error_msg or "Unsafe output directory")

    output_dir.mkdir(parents=True, exist_ok=True)

    _obfuscate_inputs(kml_files)

    success = create_progressive_heatmap(
        kml_files, output_file, data_dir, aircraft_files=aircraft_files
    )

    if not success:
        _fatal("Heatmap generation failed (see messages above)")
