"""Command-line interface."""

import argparse
import sys
from pathlib import Path

from .helpers import numeric_filename_key
from .logger import logger, set_debug_mode


def main() -> None:
    """Main CLI entry point."""
    parser = argparse.ArgumentParser(
        prog="kml-heatmap",
        description="Create interactive heatmap visualizations from KML files with altitude profiles.",
        epilog="""
examples:
  %(prog)s flight.kml
  %(prog)s ./my_flights/
  %(prog)s *.kml --output-dir mymap
  %(prog)s --debug problematic.kml
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

    args = parser.parse_args()

    if args.debug:
        set_debug_mode(True)

    # Resolve KML files from paths
    kml_files = []
    for path in args.paths:
        p = Path(path)
        if p.is_dir():
            dir_kml_files = sorted(
                (str(p / f.name) for f in p.iterdir() if f.suffix.lower() == ".kml"),
                key=numeric_filename_key,
            )
            if dir_kml_files:
                kml_files.extend(dir_kml_files)
                logger.info(
                    f"Found {len(dir_kml_files)} KML file(s) in directory: {path}"
                )
            else:
                logger.warning(f"No KML files found in directory: {path}")
        elif p.is_file():
            kml_files.append(path)
        else:
            logger.warning(f"File or directory not found: {path}")

    if not kml_files:
        print("Error: No KML files specified or found!")
        sys.exit(1)

    print("\nKML Heatmap Generator")
    print(f"{'=' * 50}\n")

    # Ensure output directory exists
    Path(args.output_dir).mkdir(parents=True, exist_ok=True)

    # Create paths for output files
    output_dir = Path(args.output_dir)
    output_file = str(output_dir / "index.html")
    data_dir = str(output_dir / "data")

    # Detect aircraft.json in the input directory
    aircraft_file = None
    if kml_files:
        input_dir = Path(kml_files[0]).parent
        candidate = input_dir / "aircraft.json"
        if candidate.exists():
            aircraft_file = candidate
            logger.info(f"Using aircraft data from {aircraft_file}")

    from .obfuscate import obfuscate_kml_file
    from .renderer import create_progressive_heatmap

    for f in kml_files:
        obfuscate_kml_file(Path(f))

    success = create_progressive_heatmap(
        kml_files, output_file, data_dir, aircraft_file=aircraft_file
    )

    if not success:
        sys.exit(1)
