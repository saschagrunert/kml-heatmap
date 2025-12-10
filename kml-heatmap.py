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
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
import folium
from folium.plugins import HeatMap

# Import from our refactored modules
from kml_heatmap.geometry import haversine_distance, downsample_path_rdp, get_altitude_color
from kml_heatmap.parser import (
    parse_kml_coordinates,
    is_mid_flight_start,
    is_valid_landing,
    extract_year_from_timestamp
)
from kml_heatmap.aircraft import lookup_aircraft_model, parse_aircraft_from_filename
from kml_heatmap.airports import (
    deduplicate_airports,
    extract_airport_name,
    is_point_marker,
    AIRPORT_DISTANCE_THRESHOLD_KM
)
from kml_heatmap.statistics import calculate_statistics
from kml_heatmap.renderer import minify_html, load_template
from kml_heatmap.validation import validate_kml_file, validate_api_keys

# Module-level DEBUG flag
DEBUG = False

# Get API keys from environment variables
STADIA_API_KEY = os.environ.get('STADIA_API_KEY', '')
OPENAIP_API_KEY = os.environ.get('OPENAIP_API_KEY', '')

# Constants (re-exported from modules for compatibility)
from kml_heatmap.geometry import EARTH_RADIUS_KM
METERS_TO_FEET = 3.28084
KM_TO_NAUTICAL_MILES = 0.539957

# Heatmap configuration
HEATMAP_GRADIENT = {
    0.0: 'blue',
    0.3: 'cyan',
    0.5: 'lime',
    0.7: 'yellow',
    1.0: 'red'
}


def set_debug(enabled):
    """Set debug mode globally across all modules."""
    global DEBUG
    DEBUG = enabled

    # Set DEBUG in all imported modules
    import kml_heatmap.parser as parser
    import kml_heatmap.airports as airports
    parser.DEBUG = enabled
    airports.DEBUG = enabled


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
    altitude_layer = folium.FeatureGroup(name='Altitude Profile', show=False)

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
                opacity=0.7
            ).add_to(altitude_layer)

    altitude_layer.add_to(m)


def export_data_json(all_coordinates, all_path_groups, all_path_metadata, unique_airports, stats, output_dir="data", strip_timestamps=False):
    """
    Export data to JSON files at multiple resolutions for progressive loading.

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
    os.makedirs(output_dir, exist_ok=True)

    print(f"\n📦 Exporting data to JSON files...")
    if strip_timestamps:
        print(f"  🔒 Privacy mode: Stripping all date/time information")

    # Calculate min/max altitude for color mapping
    if all_path_groups:
        all_altitudes = [coord[2] for path in all_path_groups for coord in path]
        min_alt_m = min(all_altitudes)
        max_alt_m = max(all_altitudes)
    else:
        min_alt_m = 0
        max_alt_m = 1000

    # Export at 5 resolution levels for more dynamic loading
    resolutions = {
        'z0_4': {'factor': 15, 'epsilon': 0.0008, 'description': 'Zoom 0-4 (continent level)'},
        'z5_7': {'factor': 10, 'epsilon': 0.0004, 'description': 'Zoom 5-7 (country level)'},
        'z8_10': {'factor': 5, 'epsilon': 0.0002, 'description': 'Zoom 8-10 (regional level)'},
        'z11_13': {'factor': 2, 'epsilon': 0.0001, 'description': 'Zoom 11-13 (city level)'},
        'z14_plus': {'factor': 1, 'epsilon': 0, 'description': 'Zoom 14+ (full detail)'}
    }

    files = {}
    max_groundspeed_knots = 0  # Track maximum groundspeed across all segments
    min_groundspeed_knots = float('inf')  # Track minimum groundspeed across all segments

    # Track cruise speed statistics (only segments >1000ft AGL)
    cruise_speed_total_distance = 0  # Total distance in cruise (nm)
    cruise_speed_total_time = 0  # Total time in cruise (seconds)
    CRUISE_ALTITUDE_THRESHOLD_FT = 1000  # AGL threshold for cruise

    # Track longest single flight distance
    max_path_distance_nm = 0  # Longest flight in nautical miles

    # Track cruise altitude histogram (500ft bins for altitudes >1000ft AGL)
    cruise_altitude_histogram = {}  # Dict of {altitude_bin_ft: time_seconds}

    # Process resolutions in order, with z14_plus first to establish the groundspeed baseline
    resolution_order = ['z14_plus', 'z11_13', 'z8_10', 'z5_7', 'z0_4']

    for res_name in resolution_order:
        res_config = resolutions[res_name]
        # Downsample coordinates for heatmap
        if res_config['epsilon'] > 0:
            # Use RDP for path-based downsampling
            downsampled_coords = []
            for path in all_path_groups:
                simplified = downsample_path_rdp([[c[0], c[1]] for c in path], res_config['epsilon'])
                downsampled_coords.extend(simplified)
            # If no paths, fall back to simple downsampling
            if not downsampled_coords:
                downsampled_coords = downsample_coordinates(all_coordinates, res_config['factor'])
        else:
            # Full resolution
            downsampled_coords = all_coordinates

        # Downsample path groups for altitude visualization
        downsampled_paths = []
        for path in all_path_groups:
            if res_config['epsilon'] > 0:
                simplified = downsample_path_rdp(path, res_config['epsilon'])
                downsampled_paths.append(simplified)
            else:
                downsampled_paths.append(path)

        # Prepare path segments with colors and track relationships
        path_segments = []
        path_info = []  # Track path-to-airport relationships

        for path_idx, path in enumerate(downsampled_paths):
            if len(path) > 1:
                # Get original path metadata if available
                metadata = all_path_metadata[path_idx] if path_idx < len(all_path_metadata) else {}

                # Extract airport information from metadata
                airport_name = metadata.get('airport_name', '')
                start_airport = None
                end_airport = None

                if airport_name and ' - ' in airport_name:
                    parts = airport_name.split(' - ')
                    if len(parts) == 2:
                        start_airport = parts[0].strip()
                        end_airport = parts[1].strip()

                # Get year from metadata
                path_year = all_path_metadata[path_idx].get('year') if path_idx < len(all_path_metadata) else None

                # Calculate total path duration and distance for groundspeed calculation
                path_duration_seconds = 0
                path_distance_km = 0
                start_ts = metadata.get('timestamp')
                end_ts = metadata.get('end_timestamp')

                if start_ts and end_ts:
                    try:
                        if 'T' in start_ts and 'T' in end_ts:
                            start_dt = datetime.fromisoformat(start_ts.replace('Z', '+00:00'))
                            end_dt = datetime.fromisoformat(end_ts.replace('Z', '+00:00'))
                            path_duration_seconds = (end_dt - start_dt).total_seconds()
                    except (ValueError, TypeError) as e:
                        if DEBUG:
                            print(f"  DEBUG: Could not parse timestamps '{start_ts}' -> '{end_ts}': {e}")
                        pass

                # Calculate total path distance
                for i in range(len(path) - 1):
                    lat1, lon1 = path[i][0], path[i][1]
                    lat2, lon2 = path[i + 1][0], path[i + 1][1]
                    path_distance_km += haversine_distance(lat1, lon1, lat2, lon2)

                # Track longest single flight distance
                path_distance_nm = path_distance_km * KM_TO_NAUTICAL_MILES
                if path_distance_nm > max_path_distance_nm:
                    max_path_distance_nm = path_distance_nm

                # Store path info with airport relationships and aircraft info
                info = {
                    'id': path_idx,
                    'start_airport': start_airport,
                    'end_airport': end_airport,
                    'start_coords': [path[0][0], path[0][1]],
                    'end_coords': [path[-1][0], path[-1][1]],
                    'segment_count': len(path) - 1,
                    'year': path_year
                }
                # Add aircraft information if available in metadata
                if 'aircraft_registration' in metadata:
                    info['aircraft_registration'] = metadata['aircraft_registration']
                if 'aircraft_type' in metadata:
                    info['aircraft_type'] = metadata['aircraft_type']
                path_info.append(info)

                # Define realistic groundspeed limits for general aviation
                MAX_GROUNDSPEED_KNOTS = 200  # Reasonable max for typical general aviation
                MIN_SEGMENT_TIME_SECONDS = 0.1  # Avoid division by very small time differences
                SPEED_WINDOW_SECONDS = 120  # 2 minute rolling average window

                # Calculate ground level for this path (minimum altitude in meters)
                ground_level_m = min([coord[2] for coord in path]) if path else 0

                # First pass: calculate instantaneous speeds and timestamps for all segments
                segment_speeds = []  # List of (timestamp, speed, distance, time_delta)

                for i in range(len(path) - 1):
                    coord1 = path[i]
                    coord2 = path[i + 1]

                    lat1, lon1 = coord1[0], coord1[1]
                    lat2, lon2 = coord2[0], coord2[1]
                    segment_distance_km = haversine_distance(lat1, lon1, lat2, lon2)

                    # Try to calculate speed from timestamps
                    instant_speed = 0
                    timestamp = None
                    time_delta = 0

                    if len(coord1) >= 4 and len(coord2) >= 4:
                        ts1, ts2 = coord1[3], coord2[3]
                        try:
                            if 'T' in ts1 and 'T' in ts2:
                                dt1 = datetime.fromisoformat(ts1.replace('Z', '+00:00'))
                                dt2 = datetime.fromisoformat(ts2.replace('Z', '+00:00'))
                                time_delta = (dt2 - dt1).total_seconds()
                                timestamp = dt1  # Use start time of segment

                                if time_delta >= MIN_SEGMENT_TIME_SECONDS:
                                    segment_distance_nm = segment_distance_km * KM_TO_NAUTICAL_MILES
                                    instant_speed = (segment_distance_nm / time_delta) * 3600
                                    # Cap at max speed
                                    if instant_speed > MAX_GROUNDSPEED_KNOTS:
                                        instant_speed = 0  # Ignore unrealistic speeds
                        except (ValueError, TypeError) as e:
                            if DEBUG:
                                print(f"  DEBUG: Could not parse segment timestamps '{ts1}' -> '{ts2}': {e}")
                            pass

                    segment_speeds.append({
                        'index': i,
                        'timestamp': timestamp,
                        'speed': instant_speed,
                        'distance': segment_distance_km,
                        'time_delta': time_delta
                    })

                # Second pass: calculate rolling average speeds using time window
                for i in range(len(path) - 1):
                    coord1 = path[i]
                    coord2 = path[i + 1]
                    lat1, lon1, alt1_m = coord1[0], coord1[1], coord1[2]
                    lat2, lon2, alt2_m = coord2[0], coord2[1], coord2[2]

                    avg_alt_m = (alt1_m + alt2_m) / 2
                    avg_alt_ft = round(avg_alt_m * METERS_TO_FEET / 100) * 100
                    color = get_altitude_color(avg_alt_m, min_alt_m, max_alt_m)

                    # Calculate windowed average groundspeed
                    groundspeed_knots = 0
                    current_segment = segment_speeds[i]
                    current_timestamp = current_segment['timestamp']

                    if current_timestamp is not None:
                        # Collect segments within time window (±60 seconds from current point)
                        window_distance = 0
                        window_time = 0

                        for seg in segment_speeds:
                            if seg['timestamp'] is None or seg['speed'] == 0:
                                continue

                            # Calculate time difference from current segment
                            time_diff = abs((seg['timestamp'] - current_timestamp).total_seconds())

                            # Include segments within the window
                            if time_diff <= SPEED_WINDOW_SECONDS / 2:
                                window_distance += seg['distance']
                                window_time += seg['time_delta']

                        # Calculate average speed over the window
                        if window_time >= MIN_SEGMENT_TIME_SECONDS:
                            window_distance_nm = window_distance * KM_TO_NAUTICAL_MILES
                            groundspeed_knots = (window_distance_nm / window_time) * 3600
                            # Cap at max speed
                            if groundspeed_knots > MAX_GROUNDSPEED_KNOTS:
                                groundspeed_knots = 0

                    # Fall back to path average if no timestamp-based calculation
                    if groundspeed_knots == 0 and path_duration_seconds > 0 and path_distance_km > 0:
                        segment_distance_km = haversine_distance(lat1, lon1, lat2, lon2)
                        segment_time_seconds = (segment_distance_km / path_distance_km) * path_duration_seconds
                        if segment_time_seconds >= MIN_SEGMENT_TIME_SECONDS:
                            segment_distance_nm = segment_distance_km * KM_TO_NAUTICAL_MILES
                            calculated_speed = (segment_distance_nm / segment_time_seconds) * 3600
                            if 0 < calculated_speed <= MAX_GROUNDSPEED_KNOTS:
                                groundspeed_knots = calculated_speed

                    # Track maximum and minimum groundspeed (only for full resolution to get accurate range)
                    if res_name == 'z14_plus' and groundspeed_knots > 0:
                        if groundspeed_knots > max_groundspeed_knots:
                            max_groundspeed_knots = groundspeed_knots
                        if groundspeed_knots < min_groundspeed_knots:
                            min_groundspeed_knots = groundspeed_knots

                        # Track cruise speed (only segments >1000ft AGL)
                        altitude_agl_m = avg_alt_m - ground_level_m
                        altitude_agl_ft = altitude_agl_m * METERS_TO_FEET
                        if altitude_agl_ft > CRUISE_ALTITUDE_THRESHOLD_FT:
                            # This is a cruise segment
                            if window_time >= MIN_SEGMENT_TIME_SECONDS:
                                cruise_speed_total_distance += window_distance * KM_TO_NAUTICAL_MILES
                                cruise_speed_total_time += window_time

                                # Track cruise altitude in 500ft bins
                                altitude_bin_ft = int(altitude_agl_ft / 500) * 500
                                if altitude_bin_ft not in cruise_altitude_histogram:
                                    cruise_altitude_histogram[altitude_bin_ft] = 0
                                cruise_altitude_histogram[altitude_bin_ft] += window_time

                    # For downsampled resolutions, clamp to the max from full resolution to avoid
                    # artificially high speeds caused by downsampling (fewer GPS points = longer segments)
                    if res_name != 'z14_plus' and max_groundspeed_knots > 0 and groundspeed_knots > max_groundspeed_knots:
                        groundspeed_knots = max_groundspeed_knots

                    # Skip zero-length segments (identical coordinates)
                    if lat1 != lat2 or lon1 != lon2:
                        path_segments.append({
                            'coords': [[lat1, lon1], [lat2, lon2]],
                            'color': color,
                            'altitude_ft': avg_alt_ft,
                            'altitude_m': round(avg_alt_m, 0),
                            'groundspeed_knots': round(groundspeed_knots, 1),
                            'path_id': path_idx  # Link segment to its path
                        })

        # Export data
        data = {
            'coordinates': downsampled_coords,
            'path_segments': path_segments,
            'path_info': path_info,  # Include path-to-airport relationships
            'resolution': res_name,
            'original_points': len(all_coordinates),
            'downsampled_points': len(downsampled_coords),
            'compression_ratio': round(len(downsampled_coords) / max(len(all_coordinates), 1) * 100, 1)
        }

        output_file = os.path.join(output_dir, f'data_{res_name}.json')
        with open(output_file, 'w') as f:
            json.dump(data, f, separators=(',', ':'), sort_keys=True)

        file_size = os.path.getsize(output_file)
        files[res_name] = output_file

        print(f"  ✓ {res_config['description']}: {len(downsampled_coords):,} points ({file_size / 1024:.1f} KB)")

    # Export airports (same for all resolutions)
    # Filter and extract valid airport names
    valid_airports = []
    seen_locations = set()  # Track by location to prevent duplicates

    for apt in unique_airports:
        # Extract clean airport name
        full_name = apt.get('name', 'Unknown')
        is_at_path_end = apt.get('is_at_path_end', False)
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
            'lat': apt['lat'],
            'lon': apt['lon'],
            'name': airport_name,
            'flight_count': len(apt['timestamps']) if apt['timestamps'] else 1
        }

        # Include timestamps only if not stripping
        if not strip_timestamps:
            airport_data['timestamps'] = apt['timestamps']

        valid_airports.append(airport_data)

    airports_data = {'airports': valid_airports}

    airports_file = os.path.join(output_dir, 'airports.json')
    with open(airports_file, 'w') as f:
        json.dump(airports_data, f, separators=(',', ':'), sort_keys=True)

    files['airports'] = airports_file
    print(f"  ✓ Airports: {len(valid_airports)} locations ({os.path.getsize(airports_file) / 1024:.1f} KB)")

    # Collect unique years from path metadata
    unique_years = set()
    for meta in all_path_metadata:
        year = meta.get('year')
        if year:
            unique_years.add(year)
    available_years = sorted(list(unique_years))

    # Update stats with maximum groundspeed
    stats['max_groundspeed_knots'] = round(max_groundspeed_knots, 1)

    # Calculate and add cruise speed (average speed at >1000ft AGL)
    if cruise_speed_total_time > 0:
        cruise_speed_knots = (cruise_speed_total_distance / cruise_speed_total_time) * 3600
        stats['cruise_speed_knots'] = round(cruise_speed_knots, 1)
    else:
        stats['cruise_speed_knots'] = 0

    # Calculate most common cruise altitude (altitude spent most time at)
    if cruise_altitude_histogram:
        most_common_altitude_ft = max(cruise_altitude_histogram.items(), key=lambda x: x[1])[0]
        stats['most_common_cruise_altitude_ft'] = most_common_altitude_ft
        stats['most_common_cruise_altitude_m'] = round(most_common_altitude_ft * 0.3048, 1)
    else:
        stats['most_common_cruise_altitude_ft'] = 0
        stats['most_common_cruise_altitude_m'] = 0

    # Add longest single flight distance
    stats['longest_flight_nm'] = round(max_path_distance_nm, 1)
    stats['longest_flight_km'] = round(max_path_distance_nm * 1.852, 1)

    # Handle case where no groundspeed was calculated
    if min_groundspeed_knots == float('inf'):
        min_groundspeed_knots = 0

    # Export statistics and metadata
    meta_data = {
        'stats': stats,
        'min_alt_m': min_alt_m,
        'max_alt_m': max_alt_m,
        'min_groundspeed_knots': round(min_groundspeed_knots, 1),
        'max_groundspeed_knots': round(max_groundspeed_knots, 1),
        'gradient': HEATMAP_GRADIENT,
        'available_years': available_years
    }

    meta_file = os.path.join(output_dir, 'metadata.json')
    with open(meta_file, 'w') as f:
        json.dump(meta_data, f, separators=(',', ':'), sort_keys=True)

    files['metadata'] = meta_file
    print(f"  ✓ Metadata: {os.path.getsize(meta_file) / 1024:.1f} KB")

    total_size = sum(os.path.getsize(f) for f in files.values())
    print(f"  📊 Total data size: {total_size / 1024:.1f} KB")

    return files



def create_progressive_heatmap(kml_files, output_file="index.html", data_dir="data"):
    """
    Create a progressive-loading heatmap with external JSON data files.

    This generates a lightweight HTML file that loads data based on zoom level,
    significantly reducing initial load time and memory usage on mobile devices.

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
            print(f"✗ {error_msg}")
        else:
            valid_files.append(kml_file)

    if not valid_files:
        print("✗ No valid KML files to process!")
        return False

    print(f"📁 Parsing {len(valid_files)} KML file(s)...")

    def parse_with_error_handling(kml_file):
        try:
            return kml_file, parse_kml_coordinates(kml_file)
        except ET.ParseError as e:
            print(f"✗ XML parsing error in {kml_file}: {e}")
            return kml_file, ([], [], [])
        except (IOError, OSError) as e:
            print(f"✗ File error reading {kml_file}: {e}")
            return kml_file, ([], [], [])
        except Exception as e:
            print(f"✗ Unexpected error processing {kml_file}: {e}")
            if DEBUG:
                import traceback
                traceback.print_exc()
            return kml_file, ([], [], [])

    # Parse files in parallel but collect results in order
    results = []
    completed_count = 0
    with ThreadPoolExecutor(max_workers=min(len(valid_files), 8)) as executor:
        future_to_file = {executor.submit(parse_with_error_handling, f): f for f in valid_files}
        for future in as_completed(future_to_file):
            kml_file, (coords, path_groups, path_metadata) = future.result()
            results.append((kml_file, coords, path_groups, path_metadata))
            completed_count += 1
            progress_pct = (completed_count / len(valid_files)) * 100
            print(f"  [{completed_count}/{len(valid_files)}] {progress_pct:.0f}% - {Path(kml_file).name}")

    # Sort results by filename for deterministic output
    results.sort(key=lambda x: x[0])

    # Extend arrays in sorted order
    for kml_file, coords, path_groups, path_metadata in results:
        all_coordinates.extend(coords)
        all_path_groups.extend(path_groups)
        all_path_metadata.extend(path_metadata)

    if not all_coordinates:
        print("✗ No coordinates found in any KML files!")
        return False

    print(f"\n📍 Total points: {len(all_coordinates)}")

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
        print(f"\n✈️  Processing {len(all_path_metadata)} start points...")
        unique_airports = deduplicate_airports(all_path_metadata, all_path_groups, is_mid_flight_start, is_valid_landing)
        print(f"  Found {len(unique_airports)} unique airports")

    # Calculate statistics
    print(f"\n📊 Calculating statistics...")
    stats = calculate_statistics(all_coordinates, all_path_groups, all_path_metadata)

    # Add airport info to stats
    valid_airport_names = []
    for airport in unique_airports:
        full_name = airport.get('name', 'Unknown')
        is_at_path_end = airport.get('is_at_path_end', False)
        airport_name = extract_airport_name(full_name, is_at_path_end)
        if airport_name:
            valid_airport_names.append(airport_name)

    stats['num_airports'] = len(valid_airport_names)
    stats['airport_names'] = sorted(valid_airport_names)

    # Export data to JSON files (strip timestamps by default for privacy)
    data_files = export_data_json(all_coordinates, all_path_groups, all_path_metadata, unique_airports, stats, data_dir, strip_timestamps=True)

    # Generate lightweight HTML with progressive loading
    print(f"\n💾 Generating progressive HTML...")

    # Use only the directory name for DATA_DIR (relative path for web serving)
    data_dir_name = os.path.basename(data_dir)

    # Load template and substitute variables
    template = load_template()
    html_content = template.replace('{STADIA_API_KEY}', STADIA_API_KEY)
    html_content = html_content.replace('{OPENAIP_API_KEY}', OPENAIP_API_KEY)
    html_content = html_content.replace('{data_dir_name}', data_dir_name)
    html_content = html_content.replace('{center_lat}', str(center_lat))
    html_content = html_content.replace('{center_lon}', str(center_lon))
    html_content = html_content.replace('{min_lat}', str(min_lat))
    html_content = html_content.replace('{max_lat}', str(max_lat))
    html_content = html_content.replace('{min_lon}', str(min_lon))
    html_content = html_content.replace('{max_lon}', str(max_lon))

    # Minify and write HTML file
    print(f"\n💾 Generating and minifying HTML...")
    minified_html = minify_html(html_content)

    with open(output_file, 'w') as f:
        f.write(minified_html)

    file_size = os.path.getsize(output_file)
    original_size = len(html_content)
    minified_size = len(minified_html)
    reduction = (1 - minified_size / original_size) * 100

    print(f"✓ Progressive HTML saved: {output_file} ({file_size / 1024:.1f} KB)")
    print(f"  Minification: {original_size / 1024:.1f} KB → {minified_size / 1024:.1f} KB ({reduction:.1f}% reduction)")
    print(f"  Open {output_file} in a web browser (requires local server)")

    return True


def print_help():
    """Print comprehensive help message."""
    from kml_heatmap.cli import print_help as cli_print_help
    cli_print_help()


def main():
    """Main CLI entry point."""
    global DEBUG

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
            set_debug(True)
            i += 1
        elif arg == '--output-dir':
            if i + 1 < len(sys.argv):
                output_dir = sys.argv[i + 1]
                i += 2
            else:
                print("Error: --output-dir requires a directory name")
                sys.exit(1)
        elif arg.startswith('--'):
            print(f"Unknown option: {arg}")
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
                    print(f"Found {len(dir_kml_files)} KML file(s) in directory: {arg}")
                else:
                    print(f"Warning: No KML files found in directory: {arg}")
            elif os.path.isfile(arg):
                kml_files.append(arg)
            else:
                print(f"Warning: File or directory not found: {arg}")
            i += 1

    if not kml_files:
        print("Error: No KML files specified or found!")
        sys.exit(1)

    print(f"\nKML Heatmap Generator")
    print(f"{'=' * 50}\n")

    # Validate API keys and warn if missing
    validate_api_keys(STADIA_API_KEY, OPENAIP_API_KEY, verbose=True)
    print()  # Empty line after warnings

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
