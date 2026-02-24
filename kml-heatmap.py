#!/usr/bin/env python3
"""
KML Heatmap Generator
Creates interactive heatmap visualizations from KML files on real map tiles.

Usage:
    python kml-heatmap.py input.kml [output.html]
    python kml-heatmap.py *.kml  # Multiple files
    python kml-heatmap.py --debug input.kml  # Debug mode
"""

import sys
import os
import json
import shutil
import string
import subprocess
from pathlib import Path
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor, as_completed
import folium

# Import from our refactored modules
from kml_heatmap.geometry import (
    haversine_distance,
    get_altitude_color,
)
from kml_heatmap.parser import (
    parse_kml_coordinates,
    is_mid_flight_start,
    is_valid_landing,
)
from kml_heatmap.logger import logger, set_debug_mode
from kml_heatmap.airports import (
    deduplicate_airports,
    extract_airport_name,
)
from kml_heatmap.statistics import calculate_statistics
from kml_heatmap.renderer import minify_html, load_template
from kml_heatmap.validation import validate_kml_file, validate_api_keys
from kml_heatmap.constants import (
    DATA_RESOLUTION,
    HEATMAP_GRADIENT,
)
from kml_heatmap.helpers import format_flight_time
from kml_heatmap.data_exporter import process_year_data

# Get API keys from environment variables
STADIA_API_KEY = os.environ.get("STADIA_API_KEY", "")
OPENAIP_API_KEY = os.environ.get("OPENAIP_API_KEY", "")


def set_debug(enabled):
    """Set debug mode globally."""
    # Set logging debug mode
    set_debug_mode(enabled)


def create_altitude_layer(all_path_groups, m):
    """
    Add altitude-colored paths to the map.

    Args:
        all_path_groups: List of path groups with altitude data
        m: Folium map object
    """
    if not all_path_groups:
        return

    # Filter valid paths (must have at least 2 points)
    valid_paths = [path for path in all_path_groups if len(path) >= 2]
    if not valid_paths:
        return

    # Get altitude range for color mapping
    all_altitudes = [coord[2] for path in valid_paths for coord in path]
    min_alt = min(all_altitudes)
    max_alt = max(all_altitudes)

    # Create a feature group for altitude paths
    altitude_layer = folium.FeatureGroup(name="Altitude Profile", show=False)

    for path in valid_paths:
        # Create colored segments
        for i in range(len(path) - 1):
            # Handle both 3-element [lat,lon,alt] and 4-element [lat,lon,alt,timestamp]
            lat1, lon1, alt1 = path[i][0], path[i][1], path[i][2]
            lat2, lon2, alt2 = path[i + 1][0], path[i + 1][1], path[i + 1][2]

            # Use average altitude for segment color
            avg_alt = (alt1 + alt2) / 2
            color = get_altitude_color(avg_alt, min_alt, max_alt)

            # Add line segment
            folium.PolyLine(
                locations=[[lat1, lon1], [lat2, lon2]],
                color=color,
                weight=2,
                opacity=0.7,
            ).add_to(altitude_layer)

    altitude_layer.add_to(m)


def export_data_json(
    all_coordinates,
    all_path_groups,
    all_path_metadata,
    unique_airports,
    stats,
    output_dir="data",
    strip_timestamps=False,
):
    """
    Export data to JSON files at full resolution.

    Args:
        all_coordinates: List of [lat, lon] pairs
        all_path_groups: List of path groups with altitude data
        all_path_metadata: List of metadata dicts for each path
        unique_airports: List of airport dicts
        stats: Statistics dictionary
        output_dir: Directory to save JSON files
        strip_timestamps: If True, remove all date/time information for privacy

    Returns:
        Dictionary with paths to generated files
    """
    # Clean up existing output directory before exporting new data
    if os.path.exists(output_dir):
        logger.info(f"\n🧹 Cleaning up output directory: {output_dir}")
        shutil.rmtree(output_dir)
        logger.info("  ✓ Removed existing directory")

    # Create fresh output directory
    os.makedirs(output_dir, exist_ok=True)

    logger.info("\n📦 Exporting data to JSON files...")
    if strip_timestamps:
        logger.info("  🔒 Privacy mode: Stripping all date/time information")

    # Calculate min/max altitude for color mapping
    if all_path_groups:
        all_altitudes = [coord[2] for path in all_path_groups for coord in path]
        min_alt_m = min(all_altitudes)
        max_alt_m = max(all_altitudes)
    else:
        min_alt_m = 0
        max_alt_m = 1000

    # Export at full resolution only
    resolutions = {
        DATA_RESOLUTION: {"factor": 1, "epsilon": 0, "description": "Full resolution"}
    }

    files = {}
    max_groundspeed_knots = 0  # Track maximum groundspeed across all segments
    min_groundspeed_knots = float(
        "inf"
    )  # Track minimum groundspeed across all segments

    # Track cruise speed statistics (only segments above threshold AGL)
    cruise_speed_total_distance = 0  # Total distance in cruise (nm)
    cruise_speed_total_time = 0  # Total time in cruise (seconds)

    # Track longest single flight distance
    max_path_distance_nm = 0  # Longest flight in nautical miles

    # Store full resolution data to avoid reloading it later
    full_res_segments = None
    full_res_path_info = None

    # Track cruise altitude histogram (bins for altitudes above threshold AGL)
    cruise_altitude_histogram = {}  # Dict of {altitude_bin_ft: time_seconds}

    # Group paths by year for year-based file splitting
    paths_by_year = {}
    for path_idx, metadata in enumerate(all_path_metadata):
        year = metadata.get("year")
        if year is None:
            year = "unknown"
        else:
            year = str(year)  # Convert to string for consistency

        if year not in paths_by_year:
            paths_by_year[year] = []
        paths_by_year[year].append(path_idx)

    logger.info(f"\n  📅 Splitting data by year: {sorted(paths_by_year.keys())}")

    # Track file structure for metadata
    file_structure = {}

    # Calculate segment metadata at full resolution
    logger.info("\n  📈 Calculating segment metadata at full resolution...")

    # Only process full resolution
    resolution_order = ["data"]

    # Process years in parallel for faster export
    logger.info(f"\n  📊 Processing {len(paths_by_year)} year(s) in parallel...")

    year_results = []
    with ThreadPoolExecutor(
        max_workers=min(len(paths_by_year), os.cpu_count() or 4)
    ) as executor:
        futures = {}
        for year in sorted(paths_by_year.keys()):
            year_path_indices = paths_by_year[year]
            future = executor.submit(
                process_year_data,
                year,
                year_path_indices,
                all_coordinates,
                all_path_groups,
                all_path_metadata,
                min_alt_m,
                max_alt_m,
                output_dir,
                resolutions,
                resolution_order,
                True,  # quiet=True for parallel execution
            )
            futures[future] = year

        # Collect results as they complete
        completed_count = 0
        total_years = len(futures)
        for future in as_completed(futures):
            year = futures[future]
            try:
                result = future.result()
                year_results.append(result)
                completed_count += 1

                # Calculate total points for this year
                year_points = sum(
                    len(all_path_groups[idx]) for idx in paths_by_year[year]
                )

                logger.info(
                    f"  [{completed_count}/{total_years}] ✓ Year {year}: {year_points:,} points"
                )
            except Exception as e:
                logger.error(f"  ✗ Error processing year {year}: {e}")
                import traceback

                traceback.print_exc()

    # Aggregate results from all years
    for result in year_results:
        year = result["year"]
        file_structure[year] = result["file_structure"]

        # Track max/min groundspeeds across all years
        if result["max_groundspeed"] > max_groundspeed_knots:
            max_groundspeed_knots = result["max_groundspeed"]
        if result["min_groundspeed"] < min_groundspeed_knots:
            min_groundspeed_knots = result["min_groundspeed"]

        # Accumulate cruise statistics
        cruise_speed_total_distance += result["cruise_distance"]
        cruise_speed_total_time += result["cruise_time"]

        # Track longest flight distance
        if result["max_path_distance"] > max_path_distance_nm:
            max_path_distance_nm = result["max_path_distance"]

        # Merge cruise altitude histograms
        for altitude_bin, time_spent in result["cruise_altitude_histogram"].items():
            if altitude_bin not in cruise_altitude_histogram:
                cruise_altitude_histogram[altitude_bin] = 0
            cruise_altitude_histogram[altitude_bin] += time_spent

        # Store full resolution data for the last year
        sorted_years = sorted(paths_by_year.keys())
        if year == sorted_years[-1]:
            full_res_segments = result["full_res_segments"]
            full_res_path_info = result["full_res_path_info"]

    # Export airports (same for all resolutions)
    # Filter and extract valid airport names
    valid_airports = []
    seen_locations = set()  # Track by location to prevent duplicates

    for apt in unique_airports:
        # Extract clean airport name
        full_name = apt.get("name", "Unknown")
        is_at_path_end = apt.get("is_at_path_end", False)
        airport_name = extract_airport_name(full_name, is_at_path_end)

        # Skip invalid airports
        if not airport_name:
            continue

        # Create location key for deduplication
        location_key = f"{apt['lat']:.4f},{apt['lon']:.4f}"

        # Skip duplicates at same location
        if location_key in seen_locations:
            continue

        seen_locations.add(location_key)

        # Prepare airport data
        airport_data = {
            "lat": apt["lat"],
            "lon": apt["lon"],
            "name": airport_name,
            "flight_count": len(apt["timestamps"]) if apt["timestamps"] else 1,
        }

        # Include timestamps only if not stripping
        if not strip_timestamps:
            airport_data["timestamps"] = apt["timestamps"]

        valid_airports.append(airport_data)

    airports_data = {"airports": valid_airports}

    airports_file = os.path.join(output_dir, "airports.js")
    with open(airports_file, "w") as f:
        # Export as JavaScript file for file:// protocol compatibility
        f.write("window.KML_AIRPORTS = ")
        json.dump(airports_data, f, separators=(",", ":"), sort_keys=True)
        f.write(";")

    files["airports"] = airports_file
    logger.info(
        f"  ✓ Airports: {len(valid_airports)} locations ({os.path.getsize(airports_file) / 1024:.1f} KB)"
    )

    # Collect unique years from path metadata
    unique_years = set()
    for meta in all_path_metadata:
        year = meta.get("year")
        if year:
            unique_years.add(year)
    available_years = sorted(list(unique_years))

    # Update stats with maximum groundspeed
    stats["max_groundspeed_knots"] = round(max_groundspeed_knots, 1)

    # Calculate and add cruise speed (average speed at >1000ft AGL)
    if cruise_speed_total_time > 0:
        cruise_speed_knots = (
            cruise_speed_total_distance / cruise_speed_total_time
        ) * 3600
        stats["cruise_speed_knots"] = round(cruise_speed_knots, 1)
    else:
        stats["cruise_speed_knots"] = 0

    # Calculate most common cruise altitude (altitude spent most time at)
    if cruise_altitude_histogram:
        most_common_altitude_ft = max(
            cruise_altitude_histogram.items(), key=lambda x: x[1]
        )[0]
        stats["most_common_cruise_altitude_ft"] = most_common_altitude_ft
        stats["most_common_cruise_altitude_m"] = round(
            most_common_altitude_ft * 0.3048, 1
        )
    else:
        stats["most_common_cruise_altitude_ft"] = 0
        stats["most_common_cruise_altitude_m"] = 0

    # Add longest single flight distance
    stats["longest_flight_nm"] = round(max_path_distance_nm, 1)
    stats["longest_flight_km"] = round(max_path_distance_nm * 1.852, 1)

    # Handle case where no groundspeed was calculated
    if min_groundspeed_knots == float("inf"):
        min_groundspeed_knots = 0

    # Export statistics and metadata
    meta_data = {
        "stats": stats,
        "min_alt_m": min_alt_m,
        "max_alt_m": max_alt_m,
        "min_groundspeed_knots": round(min_groundspeed_knots, 1),
        "max_groundspeed_knots": round(max_groundspeed_knots, 1),
        "gradient": HEATMAP_GRADIENT,
        "available_years": available_years,
        "file_structure": file_structure,
    }

    meta_file = os.path.join(output_dir, "metadata.js")
    with open(meta_file, "w") as f:
        # Export as JavaScript file for file:// protocol compatibility
        f.write("window.KML_METADATA = ")
        json.dump(meta_data, f, separators=(",", ":"), sort_keys=True)
        f.write(";")

    files["metadata"] = meta_file
    logger.info(f"  ✓ Metadata: {os.path.getsize(meta_file) / 1024:.1f} KB")

    total_size = sum(os.path.getsize(f) for f in files.values())
    logger.info(f"  📊 Total data size: {total_size / 1024:.1f} KB")

    return files, full_res_segments, full_res_path_info


def parse_with_error_handling(kml_file):
    """Parse a KML file with error handling.

    Args:
        kml_file: Path to KML file

    Returns:
        Tuple of (kml_file, (coordinates, path_groups, path_metadata))
    """
    try:
        return kml_file, parse_kml_coordinates(kml_file)
    except (OSError, ValueError, TypeError, AttributeError) as e:
        logger.error(f"✗ Error processing {kml_file}: {e}")
        logger.debug("Stack trace:", exc_info=True)
        return kml_file, ([], [], [])


def build_javascript_bundle():
    """
    Build the JavaScript bundle using npm.

    Returns:
        bool: True if build succeeded, False otherwise
    """
    try:
        # Get the project root directory (where package.json is)
        project_root = Path(__file__).parent

        # Check if package.json exists
        package_json = project_root / "package.json"
        if not package_json.exists():
            logger.warning("⚠️  package.json not found - skipping JavaScript build")
            return False

        # Check if node_modules exists
        node_modules = project_root / "node_modules"
        if not node_modules.exists():
            logger.info("📦 Installing Node.js dependencies...")
            result = subprocess.run(
                ["npm", "install"],
                cwd=project_root,
                capture_output=True,
                text=True,
                timeout=300,  # 5 minute timeout for npm install
            )
            if result.returncode != 0:
                logger.error(f"✗ npm install failed: {result.stderr}")
                return False

        # Run the build
        logger.info("🔨 Building JavaScript bundle...")
        result = subprocess.run(
            ["npm", "run", "build"],
            cwd=project_root,
            capture_output=True,
            text=True,
            timeout=60,  # 1 minute timeout for build
        )

        if result.returncode != 0:
            logger.error(f"✗ JavaScript build failed: {result.stderr}")
            return False

        logger.info("✓ JavaScript bundle built successfully")
        return True

    except FileNotFoundError:
        logger.warning("⚠️  npm not found - skipping JavaScript build")
        logger.warning("   Install Node.js to enable modular JavaScript features")
        return False
    except subprocess.TimeoutExpired:
        logger.error("✗ JavaScript build timed out")
        return False
    except Exception as e:
        logger.error(f"✗ JavaScript build error: {e}")
        return False


def create_progressive_heatmap(kml_files, output_file="index.html", data_dir="data"):
    """
    Create a full resolution heatmap with external JSON data files.

    This generates a lightweight HTML file that loads full resolution data split by year.

    Args:
        kml_files: List of KML file paths
        output_file: Output HTML file path
        data_dir: Directory to save JSON data files

    Note:
        Date/time information is automatically stripped from exported data for privacy.
    """
    # Parse all KML files
    all_coordinates = []
    all_path_groups = []
    all_path_metadata = []

    valid_files = []
    for kml_file in kml_files:
        is_valid, error_msg = validate_kml_file(kml_file)
        if not is_valid:
            logger.error(f"✗ {error_msg}")
        else:
            valid_files.append(kml_file)

    if not valid_files:
        logger.error("✗ No valid KML files to process!")
        return False

    logger.info(f"📁 Parsing {len(valid_files)} KML file(s)...")

    # Pre-load airport database in main process to avoid multiple downloads in worker processes
    # (ProcessPoolExecutor creates separate processes, each would download independently)
    from kml_heatmap.airport_lookup import _load_airport_database

    _load_airport_database()

    import time

    parse_start = time.time()

    # Parse files in parallel using multiprocessing for CPU-bound XML parsing
    results = []
    completed_count = 0
    with ProcessPoolExecutor(
        max_workers=min(len(valid_files), os.cpu_count() or 4)
    ) as executor:
        future_to_file = {
            executor.submit(parse_with_error_handling, f): f for f in valid_files
        }
        for future in as_completed(future_to_file):
            kml_file, (coords, path_groups, path_metadata) = future.result()
            results.append((kml_file, coords, path_groups, path_metadata))
            completed_count += 1
            progress_pct = (completed_count / len(valid_files)) * 100
            logger.info(
                f"  [{completed_count}/{len(valid_files)}] {progress_pct:.0f}% - {Path(kml_file).name}"
            )

    # Sort results by filename for deterministic output
    results.sort(key=lambda x: x[0])

    # Extend arrays in sorted order
    for kml_file, coords, path_groups, path_metadata in results:
        all_coordinates.extend(coords)
        all_path_groups.extend(path_groups)
        all_path_metadata.extend(path_metadata)

    parse_time = time.time() - parse_start
    logger.info(
        f"  ⏱️  Parsing took {parse_time:.1f}s ({parse_time / len(valid_files):.2f}s per file)"
    )

    if not all_coordinates:
        logger.error("✗ No coordinates found in any KML files!")
        return False

    logger.info(f"\n📍 Total points: {len(all_coordinates)}")

    # Calculate bounds
    lats = [coord[0] for coord in all_coordinates]
    lons = [coord[1] for coord in all_coordinates]
    min_lat, max_lat = min(lats), max(lats)
    min_lon, max_lon = min(lons), max(lons)
    center_lat = (min_lat + max_lat) / 2
    center_lon = (min_lon + max_lon) / 2

    # Process airports
    unique_airports = []
    if all_path_metadata:
        logger.info(f"\n✈️  Processing {len(all_path_metadata)} start points...")
        unique_airports = deduplicate_airports(
            all_path_metadata, all_path_groups, is_mid_flight_start, is_valid_landing
        )
        logger.info(f"  Found {len(unique_airports)} unique airports")

    # Calculate statistics
    logger.info("\n📊 Calculating statistics...")
    stats = calculate_statistics(all_coordinates, all_path_groups, all_path_metadata)

    # Add airport info to stats
    valid_airport_names = []
    for airport in unique_airports:
        full_name = airport.get("name", "Unknown")
        is_at_path_end = airport.get("is_at_path_end", False)
        airport_name = extract_airport_name(full_name, is_at_path_end)
        if airport_name:
            valid_airport_names.append(airport_name)

    stats["num_airports"] = len(valid_airport_names)
    stats["airport_names"] = sorted(valid_airport_names)

    # Export data to JSON files (strip timestamps by default for privacy)
    data_files, full_res_segments, full_res_path_info = export_data_json(
        all_coordinates,
        all_path_groups,
        all_path_metadata,
        unique_airports,
        stats,
        data_dir,
        strip_timestamps=True,
    )

    # Recalculate ALL statistics from exported segment data to match JavaScript
    # This ensures wrapped panel and filtered stats show perfectly consistent values
    logger.info("\n🔄 Recalculating statistics from segment data...")

    # First, load the existing metadata to preserve available_years and gradient
    meta_file = os.path.join(data_dir, "metadata.js")
    existing_meta = {}
    if os.path.exists(meta_file):
        with open(meta_file, "r") as f:
            # Read JS file and extract JSON data
            content = f.read()
            # Remove "window.KML_METADATA = " prefix and trailing ";"
            json_str = content.replace("window.KML_METADATA = ", "").rstrip(";")
            existing_meta = json.loads(json_str)

    # Use the segments data we just created instead of reloading from disk
    if full_res_segments is not None and full_res_path_info is not None:
        segments = full_res_segments
        logger.debug(
            f"  Recalc: {len(segments)} segments, {len(full_res_path_info)} path_info entries"
        )

        # 1. Total Points (segments × 2)
        stats["total_points"] = len(segments) * 2

        # 2. Altitude statistics from segments
        altitudes_m = [seg["altitude_m"] for seg in segments]
        stats["min_altitude_m"] = min(altitudes_m) if altitudes_m else 0
        stats["max_altitude_m"] = max(altitudes_m) if altitudes_m else 0
        stats["min_altitude_ft"] = stats["min_altitude_m"] * 3.28084
        stats["max_altitude_ft"] = stats["max_altitude_m"] * 3.28084

        # 3. Total altitude gain from segments
        total_gain_m = 0
        prev_alt = None
        for seg in segments:
            alt = seg["altitude_m"]
            if prev_alt is not None and alt > prev_alt:
                total_gain_m += alt - prev_alt
            prev_alt = alt
        stats["total_altitude_gain_m"] = total_gain_m
        stats["total_altitude_gain_ft"] = total_gain_m * 3.28084

        # 4. Average groundspeed from segments
        groundspeeds = [
            seg["groundspeed_knots"] for seg in segments if seg["groundspeed_knots"] > 0
        ]
        stats["average_groundspeed_knots"] = (
            sum(groundspeeds) / len(groundspeeds) if groundspeeds else 0
        )

        # 5. Cruise speed (segments > 1000ft AGL)
        min_alt_m = stats["min_altitude_m"]
        cruise_segs = [
            seg for seg in segments if seg["altitude_ft"] > (min_alt_m * 3.28084 + 1000)
        ]
        cruise_speeds = [
            seg["groundspeed_knots"]
            for seg in cruise_segs
            if seg["groundspeed_knots"] > 0
        ]
        stats["cruise_speed_knots"] = (
            sum(cruise_speeds) / len(cruise_speeds) if cruise_speeds else 0
        )

        # 6. Most common cruise altitude (time-weighted)
        altitude_bins = {}
        for seg in cruise_segs:
            if "time" in seg:
                bin_alt = round(seg["altitude_ft"] / 100) * 100
                altitude_bins[bin_alt] = altitude_bins.get(bin_alt, 0) + 1

        if altitude_bins:
            stats["most_common_cruise_altitude_ft"] = max(
                altitude_bins.keys(), key=lambda k: altitude_bins[k]
            )
            stats["most_common_cruise_altitude_m"] = round(
                stats["most_common_cruise_altitude_ft"] * 0.3048
            )

        # 7. Flight time from segments
        total_flight_time = 0
        path_durations = {}
        for segment in segments:
            if "time" in segment and "path_id" in segment:
                path_id = segment["path_id"]
                if path_id not in path_durations:
                    path_durations[path_id] = []
                path_durations[path_id].append(segment["time"])

        for path_id, times in path_durations.items():
            if len(times) >= 2:
                duration = max(times) - min(times)
                total_flight_time += duration

        stats["total_flight_time_seconds"] = total_flight_time

        # 8. Per-aircraft flight times and distances from segments
        if stats.get("aircraft_list"):
            logger.debug(
                f"    Recalculating per-aircraft times and distances from {len(full_res_path_info)} paths"
            )
            aircraft_times = {}
            aircraft_distances = {}
            aircraft_years = {}

            # Calculate times and distances per aircraft
            for idx, path_info in enumerate(full_res_path_info):
                reg = path_info.get("aircraft_registration")
                path_id = path_info.get("id")
                year = path_info.get("year")
                if idx == 0:  # Debug first path
                    logger.debug(f"    First path_info: {path_info}")
                if reg and path_id is not None and path_id in path_durations:
                    if reg not in aircraft_times:
                        aircraft_times[reg] = 0
                        aircraft_distances[reg] = 0.0
                        aircraft_years[reg] = set()
                    times = path_durations[path_id]
                    if len(times) >= 2:
                        aircraft_times[reg] += max(times) - min(times)
                        # Track year from the path metadata
                        if year:
                            aircraft_years[reg].add(str(year))
                        else:
                            logger.debug(f"    No year for path {path_id}, reg={reg}")

            # Calculate distances per aircraft from segments
            for segment in segments:
                path_id = segment.get("path_id")
                if path_id is not None and path_id < len(full_res_path_info):
                    path_info = full_res_path_info[path_id]
                    reg = path_info.get("aircraft_registration")
                    if reg and reg in aircraft_distances:
                        # Calculate segment distance using haversine
                        coords = segment.get("coords", [])
                        if len(coords) == 2:
                            lat1, lon1 = coords[0]
                            lat2, lon2 = coords[1]
                            segment_distance_km = haversine_distance(
                                lat1, lon1, lat2, lon2
                            )
                            aircraft_distances[reg] += segment_distance_km

            # Update aircraft list with recalculated times and distances from actual GPS data
            for aircraft in stats["aircraft_list"]:
                reg = aircraft["registration"]
                if reg in aircraft_times:
                    flight_time_seconds = aircraft_times[reg]
                    flight_distance_km = aircraft_distances.get(reg, 0.0)

                    aircraft["flight_time_seconds"] = flight_time_seconds
                    aircraft["flight_distance_km"] = flight_distance_km
                    aircraft["flight_time_str"] = format_flight_time(
                        flight_time_seconds
                    )

        # Re-export metadata with all recalculated statistics
        # Preserve available_years, gradient, and file_structure from the original metadata
        meta_data = {
            "available_years": existing_meta.get("available_years", []),
            "gradient": existing_meta.get("gradient", {}),
            "file_structure": existing_meta.get("file_structure", {}),
            "max_alt_m": stats["max_altitude_m"],
            "max_groundspeed_knots": stats.get("max_groundspeed_knots", 0),
            "min_alt_m": stats["min_altitude_m"],
            "min_groundspeed_knots": stats.get("min_groundspeed_knots", 0),
            "stats": stats,
        }
        with open(meta_file, "w") as f:
            # Export as JavaScript file for file:// protocol compatibility
            f.write("window.KML_METADATA = ")
            json.dump(meta_data, f, separators=(",", ":"), sort_keys=True)
            f.write(";")
        logger.info(
            "  ✓ Updated metadata with segment-based statistics (matches JavaScript)"
        )

    # Generate lightweight HTML with progressive loading
    logger.info("\n💾 Generating progressive HTML...")

    # Use only the directory name for DATA_DIR (relative path for web serving)
    data_dir_name = os.path.basename(data_dir)

    # Load template and substitute variables
    tmpl = string.Template(load_template())
    html_content = tmpl.substitute(data_dir_name=data_dir_name)

    # Minify and write HTML file
    logger.info("\n💾 Generating and minifying HTML...")
    minified_html = minify_html(html_content)

    with open(output_file, "w") as f:
        f.write(minified_html)

    file_size = os.path.getsize(output_file)
    original_size = len(html_content)
    minified_size = len(minified_html)
    reduction = (1 - minified_size / original_size) * 100

    logger.info(f"✓ Progressive HTML saved: {output_file} ({file_size / 1024:.1f} KB)")
    logger.info(
        f"  Minification: {original_size / 1024:.1f} KB → {minified_size / 1024:.1f} KB ({reduction:.1f}% reduction)"
    )

    # Build JavaScript bundle (only if running outside Docker)
    # In Docker, bundles are already built during image creation
    bundle_exists = (
        Path(__file__).parent / "kml_heatmap" / "static" / "bundle.js"
    ).exists()
    mapapp_exists = (
        Path(__file__).parent / "kml_heatmap" / "static" / "mapApp.bundle.js"
    ).exists()

    if not (bundle_exists and mapapp_exists):
        logger.info("\n📦 Building JavaScript modules...")
        build_javascript_bundle()  # Non-fatal if it fails
    else:
        logger.info("\n📦 Using pre-built JavaScript bundles...")

    # Generate map_config.js from template with variable substitution
    output_dir = os.path.dirname(output_file) or "."
    templates_dir = Path(__file__).parent / "kml_heatmap" / "templates"
    static_dir = Path(__file__).parent / "kml_heatmap" / "static"

    map_config_template = templates_dir / "map_config_template.js"
    map_config_dst = os.path.join(output_dir, "map_config.js")

    # Process map_config template with variable substitution
    with open(map_config_template, "r") as f:
        map_config_raw = f.read()

    config_vars = {
        "stadia_api_key": STADIA_API_KEY,
        "openaip_api_key": OPENAIP_API_KEY,
        "data_dir_name": data_dir_name,
        "center_lat": str(center_lat),
        "center_lon": str(center_lon),
        "min_lat": str(min_lat),
        "max_lat": str(max_lat),
        "min_lon": str(min_lon),
        "max_lon": str(max_lon),
    }
    map_config_content = string.Template(map_config_raw).substitute(config_vars)

    # Minify JavaScript
    import rjsmin

    map_config_minified = rjsmin.jsmin(map_config_content)

    with open(map_config_dst, "w") as f:
        f.write(map_config_minified)

    map_config_size = os.path.getsize(map_config_dst)
    logger.info(
        f"✓ Configuration generated: {map_config_dst} ({map_config_size / 1024:.1f} KB)"
    )

    # Copy modular JavaScript bundles
    bundle_js_src = static_dir / "bundle.js"
    if bundle_js_src.exists():
        bundle_js_dst = os.path.join(output_dir, "bundle.js")
        shutil.copy2(bundle_js_src, bundle_js_dst)
        bundle_js_size = os.path.getsize(bundle_js_dst)
        logger.info(
            f"✓ JavaScript library copied: {bundle_js_dst} ({bundle_js_size / 1024:.1f} KB)"
        )
    else:
        logger.warning("⚠️  bundle.js not found - run npm build to generate it")

    mapapp_bundle_src = static_dir / "mapApp.bundle.js"
    if mapapp_bundle_src.exists():
        mapapp_bundle_dst = os.path.join(output_dir, "mapApp.bundle.js")
        shutil.copy2(mapapp_bundle_src, mapapp_bundle_dst)
        mapapp_bundle_size = os.path.getsize(mapapp_bundle_dst)
        logger.info(
            f"✓ JavaScript application copied: {mapapp_bundle_dst} ({mapapp_bundle_size / 1024:.1f} KB)"
        )
    else:
        logger.warning("⚠️  mapApp.bundle.js not found - run npm build to generate it")

    # Copy styles.css to the output directory
    styles_css_src = static_dir / "styles.css"
    styles_css_dst = os.path.join(output_dir, "styles.css")

    # Read CSS file
    with open(styles_css_src, "r") as f:
        styles_css_content = f.read()

    # Minify CSS
    import rcssmin

    styles_css_minified = rcssmin.cssmin(styles_css_content)

    with open(styles_css_dst, "w") as f:
        f.write(styles_css_minified)

    styles_css_size = os.path.getsize(styles_css_dst)
    logger.info(f"✓ CSS copied: {styles_css_dst} ({styles_css_size / 1024:.1f} KB)")

    # Copy favicon files to the output directory
    favicon_files = [
        "favicon.svg",
        "favicon.ico",
        "favicon-192.png",
        "favicon-512.png",
        "apple-touch-icon.png",
        "manifest.json",
    ]

    for favicon_file in favicon_files:
        favicon_src = static_dir / favicon_file
        favicon_dst = os.path.join(output_dir, favicon_file)
        if favicon_src.exists():
            shutil.copy2(favicon_src, favicon_dst)

    logger.info(f"✓ Favicon files copied to {output_dir}")
    logger.info(
        f"  Open {output_file} in a web browser (works with file:// or serve via HTTP)"
    )

    return True


def print_help():
    """Print comprehensive help message."""
    from kml_heatmap.cli import print_help as cli_print_help

    cli_print_help()


def main():
    """Main CLI entry point."""
    # Check for help flag first
    if len(sys.argv) < 2 or "--help" in sys.argv or "-h" in sys.argv:
        print_help()
        sys.exit(0 if "--help" in sys.argv or "-h" in sys.argv else 1)

    # Parse arguments
    kml_files = []
    output_dir = "."

    i = 1
    while i < len(sys.argv):
        arg = sys.argv[i]

        if arg == "--help" or arg == "-h":
            print_help()
            sys.exit(0)
        elif arg == "--debug":
            set_debug(True)
            i += 1
        elif arg == "--output-dir":
            if i + 1 < len(sys.argv):
                output_dir = sys.argv[i + 1]
                i += 2
            else:
                logger.error("Error: --output-dir requires a directory name")
                sys.exit(1)
        elif arg.startswith("--"):
            logger.error(f"Unknown option: {arg}")
            sys.exit(1)
        else:
            # It's a KML file or directory
            if os.path.isdir(arg):
                # Add all .kml files from directory (sorted for deterministic output)
                dir_kml_files = []
                for filename in sorted(os.listdir(arg)):
                    if filename.lower().endswith(".kml"):
                        dir_kml_files.append(os.path.join(arg, filename))

                if dir_kml_files:
                    kml_files.extend(dir_kml_files)
                    logger.info(
                        f"Found {len(dir_kml_files)} KML file(s) in directory: {arg}"
                    )
                else:
                    logger.warning(f"Warning: No KML files found in directory: {arg}")
            elif os.path.isfile(arg):
                kml_files.append(arg)
            else:
                logger.warning(f"Warning: File or directory not found: {arg}")
            i += 1

    if not kml_files:
        logger.error("Error: No KML files specified or found!")
        sys.exit(1)

    logger.info("\nKML Heatmap Generator")
    logger.info(f"{'=' * 50}\n")

    # Validate API keys and warn if missing
    validate_api_keys(STADIA_API_KEY, OPENAIP_API_KEY, verbose=True)
    # Empty line handled by logger

    # Ensure output directory exists
    os.makedirs(output_dir, exist_ok=True)

    # Create paths for output files
    output_file = os.path.join(output_dir, "index.html")
    data_dir_path = os.path.join(output_dir, "data")

    # Create progressive heatmap (default)
    success = create_progressive_heatmap(kml_files, output_file, data_dir_path)

    if not success:
        sys.exit(1)


if __name__ == "__main__":
    main()
