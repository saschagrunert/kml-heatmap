"""Command-line interface."""

import argparse
import os
import sys
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
        if os.path.isdir(path):
            dir_kml_files = sorted(
                os.path.join(path, f)
                for f in os.listdir(path)
                if f.lower().endswith(".kml")
            )
            if dir_kml_files:
                kml_files.extend(dir_kml_files)
                logger.info(
                    f"Found {len(dir_kml_files)} KML file(s) in directory: {path}"
                )
            else:
                logger.warning(f"No KML files found in directory: {path}")
        elif os.path.isfile(path):
            kml_files.append(path)
        else:
            logger.warning(f"File or directory not found: {path}")

    if not kml_files:
        print("Error: No KML files specified or found!")
        sys.exit(1)

    print("\nKML Heatmap Generator")
    print(f"{'=' * 50}\n")

    # Ensure output directory exists
    os.makedirs(args.output_dir, exist_ok=True)

    # Create paths for output files
    output_file = os.path.join(args.output_dir, "index.html")
    data_dir = os.path.join(args.output_dir, "data")

    from .renderer import create_progressive_heatmap

    success = create_progressive_heatmap(kml_files, output_file, data_dir)

    if not success:
        sys.exit(1)
