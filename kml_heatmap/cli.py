"""Command-line interface."""

import sys
import os
from .logger import logger, set_debug_mode


def print_help():
    """Print comprehensive help message."""
    help_text = """
KML Heatmap Generator
=====================

Create interactive heatmap visualizations from KML files with altitude profiles.
Uses progressive loading to generate mobile-friendly maps with smaller file sizes.

USAGE:
    kml-heatmap.py <path> [path2 ...] [OPTIONS]

ARGUMENTS:
    <path>               KML file(s) or directory containing KML files
                         Directories will be scanned for all .kml files

OPTIONS:
    --output-dir DIR     Output directory (default: current directory)
                         Creates index.html and data/ subdirectory
    --debug              Enable debug output to diagnose parsing issues
    --help, -h           Show this help message

PROGRESSIVE LOADING:
    The generator uses progressive loading by default, which:
    • Creates a lightweight HTML file (10-20 KB)
    • Stores data in external JSON files at 5 resolution levels
    • Loads appropriate data based on zoom level
    • Reduces initial load time and memory usage on mobile devices
    • Requires a local web server to view (see Docker usage below)

FEATURES:
    • Density Heatmap    - Shows where you've been most frequently
    • Altitude Profile   - Color-coded paths showing elevation (toggle-able)
    • Multiple Formats   - Supports Points, LineStrings, and Google Earth Tracks
    • Multi-file Support - Combine multiple KML files into one visualization
    • Parallel Processing - Fast parsing of multiple files simultaneously

EXAMPLES:
    # Basic usage with Docker - generate and serve
    docker build -t kml-heatmap .
    docker run -v $(pwd):/data kml-heatmap *.kml
    docker run -p 8000:8000 -v $(pwd):/data --entrypoint python kml-heatmap /app/serve.py

    # Or combine generation and serving:
    docker run -v $(pwd):/data kml-heatmap *.kml && \\
    docker run -p 8000:8000 -v $(pwd):/data --entrypoint python kml-heatmap /app/serve.py

    # Python usage - single file
    python kml-heatmap.py flight.kml
    python -m http.server 8000  # Serve the files

    # Process all KML files in a directory
    python kml-heatmap.py ./my_flights/

    # Multiple files with custom output directory
    python kml-heatmap.py *.kml --output-dir mymap

    # Debug mode for troubleshooting
    python kml-heatmap.py --debug problematic.kml

OUTPUT:
    Creates an interactive HTML map with:
    • Toggle-able layers (Altitude Profile / Airports)
    • Dark theme map tiles (Stadia Maps or CartoDB)
    • Statistics panel with metric conversions
    • Export map as JPG image

For more information, see README.md
"""
    print(help_text)


def main():
    """Main CLI entry point."""
    # Check for help flag first
    if len(sys.argv) < 2 or '--help' in sys.argv or '-h' in sys.argv:
        print_help()
        sys.exit(0 if '--help' in sys.argv or '-h' in sys.argv else 1)

    # Parse arguments
    kml_files = []
    output_dir = "."

    i = 1
    while i < len(sys.argv):
        arg = sys.argv[i]

        if arg == '--help' or arg == '-h':
            print_help()
            sys.exit(0)
        elif arg == '--debug':
            set_debug_mode(True)
            i += 1
        elif arg == '--output-dir':
            if i + 1 < len(sys.argv):
                output_dir = sys.argv[i + 1]
                i += 2
            else:
                print("Error: --output-dir requires a directory name")
                sys.exit(1)
        elif arg.startswith('--'):
            logger.error(f"Unknown option: {arg}")
            sys.exit(1)
        else:
            # It's a KML file or directory
            if os.path.isdir(arg):
                # Add all .kml files from directory (sorted for deterministic output)
                dir_kml_files = []
                for filename in sorted(os.listdir(arg)):
                    if filename.lower().endswith('.kml'):
                        dir_kml_files.append(os.path.join(arg, filename))

                if dir_kml_files:
                    kml_files.extend(dir_kml_files)
                    logger.info(f"Found {len(dir_kml_files)} KML file(s) in directory: {arg}")
                else:
                    logger.warning(f"No KML files found in directory: {arg}")
            elif os.path.isfile(arg):
                kml_files.append(arg)
            else:
                logger.warning(f"File or directory not found: {arg}")
            i += 1

    if not kml_files:
        print("Error: No KML files specified or found!")
        sys.exit(1)

    print(f"\nKML Heatmap Generator")
    print(f"{'=' * 50}\n")

    # Ensure output directory exists
    os.makedirs(output_dir, exist_ok=True)

    # Create paths for output files
    output_file = os.path.join(output_dir, "index.html")
    data_dir = os.path.join(output_dir, "data")

    # For now, call the original create_progressive_heatmap from the monolithic script
    # This will be replaced once renderer is fully implemented
    # Import the original function
    import sys
    sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
    from kml_heatmap_original import create_progressive_heatmap as original_create

    success = original_create(kml_files, output_file, data_dir)

    if not success:
        sys.exit(1)
