#!/usr/bin/env python3
"""
Generate test KML files with random flight data.

Creates realistic test KML files with curved flight paths between major
European airports. Useful for testing performance and visualization quality
with large datasets.

Features:
- Curved flight paths using Bezier curves (not straight lines)
- Random deviations to spread data across Germany
- Realistic altitude profiles (climb, cruise, descend)
- Configurable number of files
- LineString coordinates without per-point timestamps (Charterware style)
- Documented N_REGISTRATION_TYPE.kml filenames (no dates in the filename or
  the placemark name); the flight date is carried by a <TimeStamp> element

Note: Without per-point timing information the groundspeed visualization
falls back to path averages. This exercises that code path deliberately.
"""

import argparse
import datetime
import random
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
    """Generate a curved flight path between two coordinates with altitude."""
    lat1, lon1 = start_coords
    lat2, lon2 = end_coords

    coords = []

    # Generate cruise altitude (2000-10000 ft)
    cruise_alt = random.randint(2000, 10000)

    # Offset the midpoint perpendicular to the flight path to create curves
    mid_lat = (lat1 + lat2) / 2
    mid_lon = (lon1 + lon2) / 2
    dx = lat2 - lat1
    dy = lon2 - lon1
    offset_factor = random.uniform(0.2, 0.4) * random.choice([-1, 1])
    mid_lat += -dy * offset_factor
    mid_lon += dx * offset_factor

    for i in range(num_points):
        t = i / (num_points - 1)

        # Quadratic bezier curve interpolation for more realistic paths
        lat = (1 - t) ** 2 * lat1 + 2 * (1 - t) * t * mid_lat + t**2 * lat2
        lon = (1 - t) ** 2 * lon1 + 2 * (1 - t) * t * mid_lon + t**2 * lon2

        # Small random variations to spread the data
        lat += random.uniform(-0.02, 0.02)
        lon += random.uniform(-0.02, 0.02)

        # Altitude profile (climb, cruise, descend)
        if t < 0.2:
            alt = int(cruise_alt * (t / 0.2))
        elif t > 0.8:
            alt = int(cruise_alt * ((1 - t) / 0.2))
        else:
            alt = cruise_alt + random.randint(-200, 200)

        coords.append((lat, lon, alt))

    return coords


def generate_kml_file(
    flight_id, start_airport, end_airport, aircraft_reg, aircraft_type, output_dir
):
    """Generate a single KML file for a flight."""
    coords = generate_flight_path(AIRPORTS[start_airport], AIRPORTS[end_airport])

    # Flight date (2026 only), carried by a TimeStamp element
    start_time = datetime.datetime(
        2026,
        random.randint(1, 12),
        random.randint(1, 28),
        random.randint(8, 20),
        random.randint(0, 59),
        tzinfo=datetime.UTC,
    )
    timestamp = start_time.strftime("%Y-%m-%dT%H:%M:%SZ")

    coordinate_lines = "\n".join(
        f"          {lon},{lat},{alt * 0.3048}" for lat, lon, alt in coords
    )

    kml_content = f"""<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>Flight {flight_id}</name>
    <Placemark>
      <name>{start_airport} - {end_airport}</name>
      <TimeStamp>
        <when>{timestamp}</when>
      </TimeStamp>
      <LineString>
        <extrude>1</extrude>
        <tessellate>1</tessellate>
        <altitudeMode>absolute</altitudeMode>
        <coordinates>
{coordinate_lines}
        </coordinates>
      </LineString>
    </Placemark>
  </Document>
</kml>
"""

    # Documented filename format: N_REGISTRATION_TYPE.kml (registration without hyphen)
    filename = f"{flight_id}_{aircraft_reg.replace('-', '')}_{aircraft_type}.kml"
    (Path(output_dir) / filename).write_text(kml_content, encoding="utf-8")

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

    for i in range(1, num_files + 1):
        start_airport = random.choice(airport_list)
        end_airport = random.choice([a for a in airport_list if a != start_airport])
        aircraft_reg, aircraft_type = random.choice(AIRCRAFT)

        generate_kml_file(
            i, start_airport, end_airport, aircraft_reg, aircraft_type, output_dir
        )

        if i % 1000 == 0:
            print(f"Generated {i:,} files...")

    print(f"\n✓ Successfully generated {num_files:,} KML files in {output_dir}/")
    print("\nTo test with this data, run:")
    print(f"  make build INPUT_DIR={output_dir}")
    print("\nOr with Docker:")
    print(f"  docker run --rm -v $(pwd):/data kml-heatmap {output_dir}")


if __name__ == "__main__":
    main()
