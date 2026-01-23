#!/usr/bin/env python3
"""
Generate test KML files with random flight data.

Creates realistic test KML files with curved flight paths between major
European airports. Useful for testing performance, stack overflow fixes,
and visualization quality with large datasets.

Features:
- Curved flight paths using Bezier curves (not straight lines)
- Random deviations to spread data across Germany
- Realistic altitude profiles (climb, cruise, descend)
- Configurable number of files
- Charterware-format KML (LineString without per-point timestamps)
- SkyDemon-compatible filename format for metadata extraction

Note: Uses Charterware KML format (LineString with flat coordinates) without
per-point timing information. Only the flight start date is included in the
filename. This tests the code path where altitude and airspeed visualization
is not available due to lack of timing data.
"""

import os
import random
import datetime
import argparse
from pathlib import Path

# Airport coordinates (major airports in Europe)
AIRPORTS = {
    "EDDF": (50.0379, 8.5622),  # Frankfurt
    "EDDM": (48.3538, 11.7861),  # Munich
    "EDDK": (50.8659, 7.1427),  # Cologne
    "EDDH": (53.6304, 9.9882),  # Hamburg
    "EDDB": (52.3667, 13.5033),  # Berlin
    "EDDL": (51.2895, 6.7668),  # Düsseldorf
    "EDDS": (48.6899, 9.2220),  # Stuttgart
    "EDDP": (51.4324, 12.2416),  # Leipzig
    "EDDW": (53.0475, 8.7867),  # Bremen
    "EDDN": (49.4987, 11.0669),  # Nuremberg
}

AIRCRAFT = [
    ("D-ABCD", "DA40"),
    ("D-EFGH", "C172"),
    ("D-IJKL", "PA28"),
    ("D-MNOP", "SR22"),
    ("D-QRST", "TB20"),
]


def generate_flight_path(start_coords, end_coords, num_points=50):
    """Generate a flight path between two coordinates with altitude and speed.

    Adds realistic variations including:
    - Curved paths (not straight lines)
    - Random deviations to spread data across Germany
    - Realistic altitude and speed profiles
    """
    lat1, lon1 = start_coords
    lat2, lon2 = end_coords

    coords = []
    altitudes = []
    speeds = []

    # Generate cruise altitude (1000-10000 ft)
    cruise_alt = random.randint(2000, 10000)

    # Add some randomness to create curved paths
    # Generate control points for a bezier-like curve
    mid_lat = (lat1 + lat2) / 2
    mid_lon = (lon1 + lon2) / 2

    # Offset the midpoint perpendicular to the flight path to create curves
    dx = lat2 - lat1
    dy = lon2 - lon1

    # Create perpendicular offset (20-40% of distance)
    offset_factor = random.uniform(0.2, 0.4) * random.choice([-1, 1])
    offset_lat = -dy * offset_factor
    offset_lon = dx * offset_factor

    mid_lat += offset_lat
    mid_lon += offset_lon

    for i in range(num_points):
        progress = i / (num_points - 1)

        # Quadratic bezier curve interpolation for more realistic paths
        # B(t) = (1-t)^2 * P0 + 2(1-t)t * P1 + t^2 * P2
        t = progress
        lat = (1 - t) ** 2 * lat1 + 2 * (1 - t) * t * mid_lat + t**2 * lat2
        lon = (1 - t) ** 2 * lon1 + 2 * (1 - t) * t * mid_lon + t**2 * lon2

        # Add small random variations to spread the data more
        lat += random.uniform(-0.02, 0.02)
        lon += random.uniform(-0.02, 0.02)

        # Generate altitude profile (climb, cruise, descend)
        if progress < 0.2:  # Climb
            alt = int(cruise_alt * (progress / 0.2))
        elif progress > 0.8:  # Descend
            alt = int(cruise_alt * ((1 - progress) / 0.2))
        else:  # Cruise
            alt = cruise_alt + random.randint(-200, 200)

        # Generate speed (80-150 knots)
        speed = random.randint(80, 150)

        coords.append((lat, lon, alt))
        altitudes.append(alt)
        speeds.append(speed)

    return coords, altitudes, speeds


def generate_kml_file(
    flight_id, start_airport, end_airport, aircraft_reg, aircraft_type, output_dir
):
    """Generate a single KML file for a flight."""
    start_coords = AIRPORTS[start_airport]
    end_coords = AIRPORTS[end_airport]

    coords, altitudes, speeds = generate_flight_path(start_coords, end_coords)

    # Generate timestamps (2026 only)
    start_time = datetime.datetime(
        2026,
        random.randint(1, 12),
        random.randint(1, 28),
        random.randint(8, 20),
        random.randint(0, 59),
    )

    # Format timestamp for KML (parser expects: "DD MMM YYYY" or "YYYY-MM-DD")
    timestamp_str = start_time.strftime("%d %b %Y")

    kml_content = f"""<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>Flight {flight_id}</name>
    <Placemark>
      <name>{start_airport} to {end_airport} - {timestamp_str}</name>
      <description>Aircraft: {aircraft_reg} ({aircraft_type})</description>
      <ExtendedData>
        <Data name="aircraft_registration">
          <value>{aircraft_reg}</value>
        </Data>
        <Data name="aircraft_type">
          <value>{aircraft_type}</value>
        </Data>
        <Data name="start_airport">
          <value>{start_airport}</value>
        </Data>
        <Data name="end_airport">
          <value>{end_airport}</value>
        </Data>
      </ExtendedData>
      <LineString>
        <extrude>1</extrude>
        <tessellate>1</tessellate>
        <altitudeMode>absolute</altitudeMode>
        <coordinates>
"""

    for i, (lat, lon, alt) in enumerate(coords):
        # Convert altitude from feet to meters
        alt_meters = alt * 0.3048
        kml_content += f"          {lon},{lat},{alt_meters}\n"

    kml_content += """        </coordinates>
      </LineString>
    </Placemark>
  </Document>
</kml>
"""

    # Create output file (SkyDemon format: YYYYMMDD_HHMM_START_END_AIRCRAFT.kml)
    timestamp = start_time.strftime("%Y%m%d_%H%M")
    filename = f"{timestamp}_{start_airport}_{end_airport}_{aircraft_type}.kml"
    filepath = os.path.join(output_dir, filename)

    with open(filepath, "w") as f:
        f.write(kml_content)

    return filename


def main():
    """Generate test KML files."""
    parser = argparse.ArgumentParser(
        description="Generate realistic test KML files with curved flight paths",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Generate 1000 files (default)
  %(prog)s

  # Generate 10000 files
  %(prog)s 10000

  # Generate 5000 files to custom directory
  %(prog)s 5000 --output custom_test_data

  # Build and test the generated data
  make build INPUT_DIR=kml_test_10000
        """,
    )
    parser.add_argument(
        "count",
        type=int,
        nargs="?",
        default=1000,
        help="Number of KML files to generate (default: 1000)",
    )
    parser.add_argument(
        "-o",
        "--output",
        type=str,
        help="Output directory (default: kml_test_<count>)",
    )
    args = parser.parse_args()

    num_files = args.count
    output_dir = args.output or f"kml_test_{num_files}"
    Path(output_dir).mkdir(exist_ok=True)

    print(f"Generating {num_files:,} KML files in {output_dir}/")
    estimated_size_mb = num_files * 0.05
    print(f"This will create approximately {estimated_size_mb:.0f}MB of test data...")

    airport_list = list(AIRPORTS.keys())

    for i in range(num_files):
        # Random flight parameters
        start_airport = random.choice(airport_list)
        end_airport = random.choice([a for a in airport_list if a != start_airport])
        aircraft_reg, aircraft_type = random.choice(AIRCRAFT)

        generate_kml_file(
            i, start_airport, end_airport, aircraft_reg, aircraft_type, output_dir
        )

        if (i + 1) % 1000 == 0:
            print(f"Generated {i + 1:,} files...")

    print(f"\n✓ Successfully generated {num_files:,} KML files in {output_dir}/")
    print("\nTo test with this data, run:")
    print(f"  make build INPUT_DIR={output_dir}")
    print("\nOr with Docker:")
    print(f"  docker run --rm -v $(pwd):/data kml-heatmap {output_dir}")


if __name__ == "__main__":
    main()
