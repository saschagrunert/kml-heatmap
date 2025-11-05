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
import re
from pathlib import Path
from xml.etree import ElementTree as ET
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from math import radians, sin, cos, sqrt, atan2
import folium
from folium.plugins import HeatMap

DEBUG = False


def is_mid_flight_start(path, start_alt, debug=False):
    """
    Detect if a path started mid-flight by analyzing altitude patterns.

    A mid-flight start is characterized by:
    1. Starting at altitude (> 400m) AND
    2. NOT descending/ascending significantly in the first part of the path

    Args:
        path: List of [lat, lon, alt] coordinates
        start_alt: Starting altitude in meters
        debug: Enable debug output

    Returns:
        bool: True if this is a mid-flight start
    """
    if len(path) <= 10:
        return False

    # Get altitudes from first 25% of path (or first 50 points, whichever is smaller)
    sample_size = min(50, len(path) // 4)
    if sample_size <= 5:
        return False

    start_alts = [coord[2] for coord in path[:sample_size]]
    min_alt_in_sample = min(start_alts)
    max_alt_in_sample = max(start_alts)
    altitude_variation = max_alt_in_sample - min_alt_in_sample

    # Mid-flight indicators:
    # - Starting altitude > 400m (above typical low-elevation airports)
    # - AND altitude variation in first part < 100m (not climbing/descending much)
    is_mid_flight = start_alt > 400 and altitude_variation < 100

    if is_mid_flight and debug:
        print(f"  DEBUG: Detected mid-flight start at {start_alt:.0f}m (variation: {altitude_variation:.0f}m)")

    return is_mid_flight


def is_valid_landing(path, end_alt, debug=False):
    """
    Check if a path ends with a valid landing.

    A valid landing shows descent or stable low altitude at the end.

    Args:
        path: List of [lat, lon, alt] coordinates
        end_alt: Ending altitude in meters
        debug: Enable debug output

    Returns:
        bool: True if this is a valid landing
    """
    if len(path) <= 10:
        # Short path, just accept if altitude seems reasonable
        return end_alt < 1000

    # Check last 25% of path (or last 50 points)
    end_sample_size = min(50, len(path) // 4)
    if end_sample_size <= 5:
        return end_alt < 1000

    end_alts = [coord[2] for coord in path[-end_sample_size:]]
    min_end_alt = min(end_alts)
    max_end_alt = max(end_alts)
    end_variation = max_end_alt - min_end_alt

    # Valid landing: either descending significantly OR stable at low variation
    # Also accept any endpoint if variation at end is small (< 50m) - indicates stable landing
    return end_variation < 50 or end_alt < 600


def extract_airport_name(full_name, is_at_path_end=False):
    """
    Extract clean airport name from route name.

    Args:
        full_name: Full airport/route name (e.g., "EDAQ Halle - EDMV Vilshofen")
        is_at_path_end: If True, extract arrival airport; else departure

    Returns:
        str: Cleaned airport name or None if invalid
    """
    if not full_name or full_name in ['Airport', 'Unknown', '']:
        return None

    # Check if it's a marker prefix that shouldn't have made it here
    marker_pattern = r'^(Log Start|Takeoff|Landing|Log Stop):\s*.+$'
    if re.match(marker_pattern, full_name):
        return None

    # Extract airport from route format "XXX - YYY"
    if ' - ' in full_name and full_name.count(' - ') == 1:
        parts = full_name.split(' - ')
        airport_name = parts[1].strip() if is_at_path_end else parts[0].strip()
    else:
        airport_name = full_name

    # Validate: must have ICAO code OR be multi-word name
    has_icao_code = bool(re.search(r'\b[A-Z]{4}\b', airport_name))
    is_single_word = len(airport_name.split()) == 1

    # Skip if it's "Unknown" or single-word without ICAO code
    if airport_name == 'Unknown' or (not has_icao_code and is_single_word):
        return None

    return airport_name


def haversine_distance(lat1, lon1, lat2, lon2):
    """Calculate great circle distance in kilometers between two points."""
    R = 6371  # Earth's radius in kilometers
    lat1, lon1, lat2, lon2 = map(radians, [lat1, lon1, lat2, lon2])
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    a = sin(dlat/2)**2 + cos(lat1) * cos(lat2) * sin(dlon/2)**2
    c = 2 * atan2(sqrt(a), sqrt(1-a))
    return R * c


def parse_kml_coordinates(kml_file):
    """
    Extract coordinates from a KML file.

    Args:
        kml_file: Path to KML file

    Returns:
        Tuple of (coordinates, path_groups, path_metadata)
        - coordinates: List of [lat, lon] pairs for heatmap (all points)
        - path_groups: List of path groups, where each group is a list of [lat, lon, alt]
                      (keeps separate paths separate for proper line drawing)
        - path_metadata: List of metadata dicts for each path (timestamp, filename, etc.)
    """
    coordinates = []
    path_groups = []  # List of separate paths
    path_metadata = []  # Metadata for each path

    try:
        tree = ET.parse(kml_file)
        root = tree.getroot()

        if DEBUG:
            print(f"\n  DEBUG: Root tag: {root.tag}")
            print(f"  DEBUG: Root attrib: {root.attrib}")
            all_tags = set()
            for elem in root.iter():
                tag = elem.tag.split('}')[-1] if '}' in elem.tag else elem.tag
                all_tags.add(tag)
            print(f"  DEBUG: All unique tags in file: {sorted(all_tags)}")

        # KML uses XML namespaces
        namespaces = {
            'kml': 'http://www.opengis.net/kml/2.2',
            'gx': 'http://www.google.com/kml/ext/2.2'
        }

        # Try with namespace
        coord_elements = root.findall('.//kml:coordinates', namespaces)

        # Also try to find gx:coord elements (Google Earth Track extension)
        gx_coords = root.findall('.//gx:coord', namespaces)

        if DEBUG and gx_coords:
            print(f"  DEBUG: Found {len(gx_coords)} gx:coord elements (Google Earth Track)")

        # If no results, try without namespace (some KML files don't use it)
        if not coord_elements and not gx_coords:
            # Remove namespace from tags
            for elem in root.iter():
                if '}' in elem.tag:
                    elem.tag = elem.tag.split('}', 1)[1]
            coord_elements = root.findall('.//coordinates')
            gx_coords = root.findall('.//coord')  # gx:coord without namespace

        if DEBUG:
            print(f"  DEBUG: Found {len(coord_elements)} coordinate elements")
            if coord_elements:
                for i, elem in enumerate(coord_elements[:2]):  # Show first 2
                    print(f"  DEBUG: Element {i} text preview: {str(elem.text)[:100] if elem.text else 'None'}")

        # Find all Placemarks to extract name and timestamp information
        placemarks = root.findall('.//kml:Placemark', namespaces)
        if not placemarks:
            placemarks = root.findall('.//Placemark')  # Without namespace

        # Create a mapping from coordinates element to placemark metadata
        coord_to_metadata = {}
        for placemark in placemarks:
            # Find coordinates within this placemark
            placemark_coords = placemark.findall('.//kml:coordinates', namespaces)
            if not placemark_coords:
                placemark_coords = placemark.findall('.//coordinates')

            # Extract name
            name_elem = placemark.find('.//kml:name', namespaces)
            if name_elem is None:
                name_elem = placemark.find('.//name')
            airport_name = name_elem.text.strip() if name_elem is not None and name_elem.text else None

            # Extract timestamp
            time_elem = placemark.find('.//kml:TimeStamp/kml:when', namespaces)
            if time_elem is None:
                time_elem = placemark.find('.//TimeStamp/when')
            if time_elem is None:
                time_elem = placemark.find('.//gx:when', namespaces)
            if time_elem is None:
                time_elem = placemark.find('.//when')

            timestamp = None
            if time_elem is not None and time_elem.text:
                timestamp = time_elem.text.strip()
            elif airport_name:
                # Try to extract date from name (e.g., "Log Start: 03 Mar 2025 08:58 Z")
                date_pattern = r'(\d{2}\s+\w{3}\s+\d{4}|\d{4}-\d{2}-\d{2})'
                match = re.search(date_pattern, airport_name)
                if match:
                    timestamp = match.group(1)

            # Store metadata for each coordinates element in this placemark
            for coord_elem in placemark_coords:
                coord_to_metadata[id(coord_elem)] = {
                    'airport_name': airport_name,
                    'timestamp': timestamp
                }

        for idx, coord_elem in enumerate(coord_elements):
            # Handle None text
            if coord_elem.text is None:
                if DEBUG:
                    print(f"  DEBUG: Coordinate element {idx} has None text, skipping")
                continue

            coord_text = coord_elem.text.strip()
            if not coord_text:
                if DEBUG:
                    print(f"  DEBUG: Coordinate element {idx} has empty text, skipping")
                continue

            # Get metadata for this coordinate element
            metadata = coord_to_metadata.get(id(coord_elem), {})
            airport_name = metadata.get('airport_name')
            timestamp = metadata.get('timestamp')

            # Parse coordinates (format: lon,lat,alt or lon,lat)
            # Multiple coordinates can be separated by whitespace or newlines
            # This handles:
            # - Single points (Placemarks)
            # - Paths/LineStrings (tracks, routes)
            # - Polygons (areas)

            # Split by whitespace (spaces, tabs, newlines)
            points = coord_text.split()

            # Create a new path group for this coordinate element
            current_path = []
            element_coords = 0

            for point in points:
                point = point.strip()
                if not point:
                    continue

                parts = point.split(',')
                if len(parts) >= 2:
                    try:
                        lon = float(parts[0])
                        lat = float(parts[1])
                        alt = float(parts[2]) if len(parts) >= 3 else None

                        # Clamp negative altitudes to 0 (below sea level = 0ft)
                        if alt is not None and alt < 0:
                            alt = 0.0

                        # Swap to [lat, lon] for folium
                        coordinates.append([lat, lon])

                        # Add to current path group with altitude
                        if alt is not None:
                            current_path.append([lat, lon, alt])

                        element_coords += 1
                    except ValueError:
                        # Skip invalid coordinates
                        if DEBUG:
                            print(f"  DEBUG: Failed to parse coordinate: {point}")
                        continue

            # Add this path group to the list if it has coordinates
            if current_path:
                path_groups.append(current_path)
                path_metadata.append({
                    'timestamp': timestamp,
                    'filename': Path(kml_file).name,
                    'start_point': current_path[0],  # [lat, lon, alt]
                    'airport_name': airport_name
                })

            if DEBUG and element_coords > 0:
                coord_type = "Point" if element_coords == 1 else f"Path ({element_coords} points)"
                print(f"  DEBUG: Element {idx}: {coord_type}")

        # Parse gx:coord elements (Google Earth Track extension)
        # Format: "lon lat alt" (space-separated instead of comma-separated)
        # Note: gx:coord elements are typically all part of one gx:Track, so treat as one path
        if gx_coords:
            gx_path = []
            gx_timestamp = None
            gx_airport_name = None

            # Try to find timestamp and airport name for gx:Track
            # Find the Placemark that contains the gx:Track
            for placemark in placemarks:
                # Check if this placemark contains gx:coord elements
                placemark_gx_coords = placemark.findall('.//gx:coord', namespaces)
                if not placemark_gx_coords:
                    placemark_gx_coords = placemark.findall('.//coord')

                if placemark_gx_coords:
                    # Extract name
                    name_elem = placemark.find('.//kml:name', namespaces)
                    if name_elem is None:
                        name_elem = placemark.find('.//name')
                    if name_elem is not None and name_elem.text:
                        gx_airport_name = name_elem.text.strip()

                    # Extract timestamp - try to get the first when element
                    # The <when> elements in gx:Track are in the KML namespace, not gx namespace
                    time_elem = placemark.find('.//kml:when', namespaces)
                    if time_elem is None:
                        time_elem = placemark.find('.//when')

                    if time_elem is not None and time_elem.text:
                        gx_timestamp = time_elem.text.strip()
                        if DEBUG:
                            print(f"  DEBUG: Found gx:Track timestamp: {gx_timestamp}")
                    elif gx_airport_name:
                        # Try to extract date from name
                        date_pattern = r'(\d{2}\s+\w{3}\s+\d{4}|\d{4}-\d{2}-\d{2})'
                        match = re.search(date_pattern, gx_airport_name)
                        if match:
                            gx_timestamp = match.group(1)
                            if DEBUG:
                                print(f"  DEBUG: Extracted timestamp from gx:Track name: {gx_timestamp}")

                    if DEBUG and gx_timestamp is None:
                        print(f"  DEBUG: No timestamp found for gx:Track with name: {gx_airport_name}")

                    break

            for idx, gx_coord in enumerate(gx_coords):
                if gx_coord.text is None:
                    continue

                coord_text = gx_coord.text.strip()
                if not coord_text:
                    continue

                parts = coord_text.split()
                if len(parts) >= 2:
                    try:
                        lon = float(parts[0])
                        lat = float(parts[1])
                        alt = float(parts[2]) if len(parts) >= 3 else None

                        # Clamp negative altitudes to 0 (below sea level = 0ft)
                        if alt is not None and alt < 0:
                            alt = 0.0

                        coordinates.append([lat, lon])

                        if alt is not None:
                            gx_path.append([lat, lon, alt])
                    except ValueError:
                        if DEBUG:
                            print(f"  DEBUG: Failed to parse gx:coord: {coord_text}")
                        continue

            # Add gx:Track as a single path group
            if gx_path:
                path_groups.append(gx_path)
                path_metadata.append({
                    'timestamp': gx_timestamp,
                    'filename': Path(kml_file).name,
                    'start_point': gx_path[0],  # [lat, lon, alt]
                    'airport_name': gx_airport_name
                })

            if DEBUG:
                print(f"  DEBUG: Parsed {len(gx_coords)} gx:coord elements into 1 track")

        # Count total points with altitude across all path groups
        total_alt_points = sum(len(path) for path in path_groups)

        print(f"✓ Loaded {len(coordinates)} points from {Path(kml_file).name}")
        if path_groups:
            print(f"  ({total_alt_points} points have altitude data in {len(path_groups)} path(s))")

        if len(coordinates) == 0:
            print(f"  WARNING: No valid coordinates found!")
            print(f"  This could mean:")
            print(f"    - The KML file uses a different structure")
            print(f"    - The coordinates are in an unexpected format")
            print(f"    - Try running with --debug flag for more information")

        return coordinates, path_groups, path_metadata

    except ET.ParseError as e:
        print(f"✗ XML parsing error in {kml_file}: {e}")
        print(f"  The file may be corrupted or not a valid KML file")
        return [], [], []
    except Exception as e:
        print(f"✗ Error parsing {kml_file}: {e}")
        import traceback
        traceback.print_exc()
        return [], [], []


def get_altitude_color(altitude, min_alt, max_alt):
    """
    Get color for altitude value based on gradient from blue (low) to red (high).
    Balanced saturation for visibility without being too bright.
    """
    if max_alt == min_alt:
        return '#00AA88'  # Teal if all altitudes are the same

    # Normalize altitude to 0-1 range
    normalized = (altitude - min_alt) / (max_alt - min_alt)

    # Color gradient: blue -> cyan -> green -> yellow -> orange -> red
    if normalized < 0.2:
        # Blue to cyan
        ratio = normalized * 5
        r, g, b = 0, int(ratio * 180), int(150 + ratio * 105)
    elif normalized < 0.4:
        # Cyan to green
        ratio = (normalized - 0.2) * 5
        r, g, b = 0, int(180 + ratio * 75), int(255 - ratio * 155)
    elif normalized < 0.6:
        # Green to yellow
        ratio = (normalized - 0.4) * 5
        r, g, b = int(ratio * 255), 255, int(100 - ratio * 100)
    elif normalized < 0.8:
        # Yellow to orange
        ratio = (normalized - 0.6) * 5
        r, g, b = 255, int(255 - ratio * 100), 0
    else:
        # Orange to red
        ratio = (normalized - 0.8) * 5
        r, g, b = 255, int(155 - ratio * 155), 0

    return f'#{r:02x}{g:02x}{b:02x}'


def calculate_statistics(all_coordinates, all_path_groups):
    """
    Calculate statistics from coordinate and path data.

    Args:
        all_coordinates: List of [lat, lon] pairs
        all_path_groups: List of path groups with altitude data

    Returns:
        Dictionary of statistics
    """
    from math import radians, sin, cos, sqrt, atan2

    stats = {
        'total_points': len(all_coordinates),
        'num_paths': len(all_path_groups),
        'total_distance_km': 0.0,
        'total_distance_nm': 0.0,
        'total_altitude_gain_m': 0.0,
        'total_altitude_gain_ft': 0.0,
        'min_altitude_m': None,
        'max_altitude_m': None,
        'min_altitude_ft': None,
        'max_altitude_ft': None,
    }

    if not all_path_groups:
        return stats

    # Calculate statistics from all path groups
    all_altitudes = []
    total_distance_km = 0.0
    total_gain_m = 0.0

    for path in all_path_groups:
        if len(path) < 2:
            continue

        # Collect altitudes
        all_altitudes.extend([coord[2] for coord in path])

        # Calculate distance and elevation changes for this path
        for i in range(len(path) - 1):
            lat1, lon1, alt1 = path[i]
            lat2, lon2, alt2 = path[i + 1]

            # Add to total distance
            total_distance_km += haversine_distance(lat1, lon1, lat2, lon2)

            # Calculate altitude change (only track gain)
            alt_change = alt2 - alt1
            if alt_change > 0:
                total_gain_m += alt_change

    # Update statistics
    if all_altitudes:
        stats['min_altitude_m'] = min(all_altitudes)
        stats['max_altitude_m'] = max(all_altitudes)
        stats['min_altitude_ft'] = stats['min_altitude_m'] * 3.28084
        stats['max_altitude_ft'] = stats['max_altitude_m'] * 3.28084

    stats['total_distance_km'] = total_distance_km
    stats['total_distance_nm'] = total_distance_km * 0.539957  # Convert km to nautical miles
    stats['total_altitude_gain_m'] = total_gain_m
    stats['total_altitude_gain_ft'] = total_gain_m * 3.28084

    return stats


def create_heatmap(kml_files, output_file="heatmap.html", **kwargs):
    """
    Create an interactive heatmap from one or more KML files.

    Args:
        kml_files: List of KML file paths
        output_file: Output HTML file path
        **kwargs: Additional parameters for customization
            - radius: Heatmap point radius (default: 10)
            - blur: Heatmap blur amount (default: 15)
            - min_opacity: Minimum opacity (default: 0.4)
            - max_zoom: Maximum zoom level (default: 18)
    """
    all_coordinates = []
    all_path_groups = []
    all_path_metadata = []

    # Filter out non-existent files
    valid_files = []
    for kml_file in kml_files:
        if not os.path.exists(kml_file):
            print(f"✗ File not found: {kml_file}")
        else:
            valid_files.append(kml_file)

    if not valid_files:
        print("✗ No valid KML files to process!")
        return False

    # Parse KML files in parallel for better performance
    print(f"📁 Parsing {len(valid_files)} KML file(s)...")

    def parse_with_error_handling(kml_file):
        """Wrapper to handle errors gracefully in parallel execution."""
        try:
            return kml_file, parse_kml_coordinates(kml_file)
        except Exception as e:
            print(f"✗ Error processing {kml_file}: {e}")
            return kml_file, ([], [], [])

    # Use ThreadPoolExecutor for parallel file parsing
    completed_count = 0
    with ThreadPoolExecutor(max_workers=min(len(valid_files), 8)) as executor:
        # Submit all parsing tasks
        future_to_file = {executor.submit(parse_with_error_handling, f): f for f in valid_files}

        # Collect results as they complete with progress
        for future in as_completed(future_to_file):
            kml_file, (coords, path_groups, path_metadata) = future.result()
            all_coordinates.extend(coords)
            all_path_groups.extend(path_groups)
            all_path_metadata.extend(path_metadata)

            # Update progress
            completed_count += 1
            progress_pct = (completed_count / len(valid_files)) * 100
            print(f"  [{completed_count}/{len(valid_files)}] {progress_pct:.0f}% - {Path(kml_file).name}")

    if not all_coordinates:
        print("✗ No coordinates found in any KML files!")
        return False

    print(f"\n📍 Total points: {len(all_coordinates)}")

    # Calculate bounds to fit all data
    lats = [coord[0] for coord in all_coordinates]
    lons = [coord[1] for coord in all_coordinates]

    min_lat, max_lat = min(lats), max(lats)
    min_lon, max_lon = min(lons), max(lons)

    # Calculate center point
    center_lat = (min_lat + max_lat) / 2
    center_lon = (min_lon + max_lon) / 2

    # Create base map centered on all data with dark theme
    m = folium.Map(
        location=[center_lat, center_lon],
        tiles=None  # Don't add default tiles
    )

    # Add CartoDB dark_matter as the only tile layer (without showing in layer control)
    folium.TileLayer(
        tiles='CartoDB dark_matter',
        name='',  # Empty name prevents it from appearing in layer control
        control=False  # Don't show in layer control
    ).add_to(m)

    # Fit bounds to show all data with some padding
    m.fit_bounds([[min_lat, min_lon], [max_lat, max_lon]], padding=[30, 30])

    # Add heatmap layer (for density/frequency)
    # Lower opacity to avoid obscuring altitude paths
    heatmap_layer = folium.FeatureGroup(name='Density Heatmap', show=True)
    HeatMap(
        all_coordinates,
        radius=kwargs.get('radius', 10),
        blur=kwargs.get('blur', 15),
        min_opacity=kwargs.get('min_opacity', 0.25),  # Reduced from 0.4 for less obstruction
        max_opacity=0.6,  # Cap maximum opacity to keep paths visible underneath
        max_zoom=kwargs.get('max_zoom', 18),
        gradient={
            0.0: 'blue',
            0.3: 'cyan',
            0.5: 'lime',
            0.7: 'yellow',
            1.0: 'red'
        }
    ).add_to(heatmap_layer)
    heatmap_layer.add_to(m)

    # Add altitude visualization layer if altitude data is available
    if all_path_groups:
        # Calculate altitude range across all paths (KML stores in meters)
        all_altitudes = []
        for path in all_path_groups:
            all_altitudes.extend([coord[2] for coord in path])

        min_alt_m = min(all_altitudes)
        max_alt_m = max(all_altitudes)

        # Convert to feet (1 meter = 3.28084 feet) and round to nearest 100ft
        min_alt_ft = round(min_alt_m * 3.28084 / 100) * 100
        max_alt_ft = round(max_alt_m * 3.28084 / 100) * 100

        print(f"📊 Altitude range: {min_alt_ft:.0f}ft to {max_alt_ft:.0f}ft ({min_alt_m:.0f}m to {max_alt_m:.0f}m)")

        # Calculate total segments for progress
        total_segments = sum(len(path) - 1 for path in all_path_groups if len(path) > 1)

        # Create altitude layer
        altitude_layer = folium.FeatureGroup(name='Altitude Profile', show=False)

        if total_segments > 100:  # Only show progress for larger datasets
            print(f"🎨 Generating altitude visualization ({total_segments} segments)...")

        # Draw each path group separately (this prevents connecting unrelated paths)
        segments_drawn = 0
        last_progress = 0

        for path in all_path_groups:
            if len(path) > 1:
                # First, draw a single subtle white border for the entire path (anti-aliasing effect)
                # This prevents the grid pattern from individual segment borders
                path_coordinates = [[lat, lon] for lat, lon, _ in path]
                folium.PolyLine(
                    locations=path_coordinates,
                    color='#FFFFFF',
                    weight=6,
                    opacity=0.15,  # Very subtle
                ).add_to(altitude_layer)

                # Then draw colored segments within this path
                for i in range(len(path) - 1):
                    lat1, lon1, alt1_m = path[i]
                    lat2, lon2, alt2_m = path[i + 1]

                    # Use average altitude for segment color (in meters for color calculation)
                    avg_alt_m = (alt1_m + alt2_m) / 2
                    avg_alt_ft = round(avg_alt_m * 3.28084 / 100) * 100  # Round to nearest 100ft
                    color = get_altitude_color(avg_alt_m, min_alt_m, max_alt_m)

                    # Create main colored line segment
                    folium.PolyLine(
                        locations=[[lat1, lon1], [lat2, lon2]],
                        color=color,
                        weight=4,  # Slightly thinner to let border show through
                        opacity=0.85,
                        popup=f'Altitude: {avg_alt_ft:.0f}ft ({avg_alt_m:.0f}m)'
                    ).add_to(altitude_layer)

                    # Update progress for large datasets (every 10%)
                    if total_segments > 100:
                        segments_drawn += 1
                        progress = int((segments_drawn / total_segments) * 100)
                        if progress >= last_progress + 10:
                            print(f"  {progress}%...")
                            last_progress = progress

        if total_segments > 100:
            print(f"  100% - Complete!")

        altitude_layer.add_to(m)

        # Add altitude legend with actual gradient colors (dark theme)
        # Legend will be hidden by default and toggle with the altitude layer
        mid_alt_ft = round((min_alt_ft + max_alt_ft) / 2 / 100) * 100

        # Get actual colors from the gradient function
        low_color = get_altitude_color(min_alt_m, min_alt_m, max_alt_m)
        mid_color = get_altitude_color((min_alt_m + max_alt_m) / 2, min_alt_m, max_alt_m)
        high_color = get_altitude_color(max_alt_m, min_alt_m, max_alt_m)

        # Add JavaScript to toggle legend visibility with layer control
        legend_html = f'''
        <div id="altitude-legend" style="position: fixed;
                    bottom: 50px; right: 50px; width: 160px; height: 190px;
                    background-color: #2b2b2b; border:2px solid #555; z-index:9999;
                    font-size:14px; padding: 10px; display: none; color: #ffffff;">
        <p style="margin:0; font-weight:bold;">Altitude Legend</p>
        <p style="margin:8px 0;">
            <span style="display: inline-block; width: 20px; height: 20px; background-color:{low_color}; border: 1px solid #333; vertical-align: middle;"></span>
            <span style="margin-left: 5px;">{min_alt_ft:.0f}ft (Low)</span>
        </p>
        <p style="margin:8px 0;">
            <span style="display: inline-block; width: 20px; height: 20px; background-color:{mid_color}; border: 1px solid #333; vertical-align: middle;"></span>
            <span style="margin-left: 5px;">{mid_alt_ft:.0f}ft (Mid)</span>
        </p>
        <p style="margin:8px 0;">
            <span style="display: inline-block; width: 20px; height: 20px; background-color:{high_color}; border: 1px solid #333; vertical-align: middle;"></span>
            <span style="margin-left: 5px;">{max_alt_ft:.0f}ft (High)</span>
        </p>
        </div>
        '''
        m.get_root().html.add_child(folium.Element(legend_html))

        # Add script to handle layer toggle events using Leaflet's event system
        toggle_script = '''
        <script>
        // Wait for the map to be fully initialized
        function initLegendToggle() {
            // Get the Leaflet map instance
            var mapElement = document.querySelector('.folium-map');
            if (!mapElement || !mapElement._leaflet_id) {
                setTimeout(initLegendToggle, 100);
                return;
            }

            // Get the map object from Leaflet
            var maps = [];
            for (var key in window) {
                if (key.startsWith('map_')) {
                    maps.push(window[key]);
                }
            }

            if (maps.length === 0) {
                setTimeout(initLegendToggle, 100);
                return;
            }

            var map = maps[0];
            var legend = document.getElementById('altitude-legend');

            // Listen for layer add/remove events
            map.on('overlayadd', function(e) {
                if (e.name === 'Altitude Profile') {
                    legend.style.display = 'block';
                }
            });

            map.on('overlayremove', function(e) {
                if (e.name === 'Altitude Profile') {
                    legend.style.display = 'none';
                }
            });
        }

        // Start initialization when page loads
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', initLegendToggle);
        } else {
            initLegendToggle();
        }
        </script>
        '''
        m.get_root().html.add_child(folium.Element(toggle_script))

    # Add airport/start point markers
    if all_path_metadata:
        print(f"\n✈️  Processing {len(all_path_metadata)} start points...")

        # Deduplicate airports by location (within ~1.5 km)
        # Group airports that are close together (airports can be large, with different
        # takeoff/landing points, taxiways, etc. - especially for round trips)
        unique_airports = []
        DISTANCE_THRESHOLD_KM = 1.5  # 1500 meters (1.5 km)

        for idx, metadata in enumerate(all_path_metadata):
            start_lat, start_lon = metadata['start_point'][0], metadata['start_point'][1]
            start_alt = metadata['start_point'][2] if len(metadata['start_point']) > 2 else 0

            # Check if this is a point marker (Log Start, Takeoff, Landing, Log Stop)
            # vs an actual flight path - only count actual paths as flights
            airport_name = metadata.get('airport_name', '')
            is_point_marker = any(marker in airport_name for marker in
                                 ['Log Start', 'Log Stop', 'Takeoff', 'Landing'])

            # Skip ALL point markers entirely - these don't contain airport info
            # The actual airport names come from route/track names (e.g., "EDAV - EDBH")
            # Point markers are just events: "Log Start: date", "Takeoff: date", "Landing: date", "Log Stop: date"
            if is_point_marker:
                if DEBUG:
                    print(f"  DEBUG: Skipping point marker '{airport_name}'")
                continue

            # Check if this path started mid-flight
            path = all_path_groups[idx] if idx < len(all_path_groups) else []
            if is_mid_flight_start(path, start_alt, DEBUG):
                if DEBUG:
                    print(f"  DEBUG: Skipping mid-flight start '{airport_name}'")
                continue

            # Check if this location is already in unique_airports
            is_duplicate = False
            for airport in unique_airports:
                dist = haversine_distance(start_lat, start_lon, airport['lat'], airport['lon'])
                if dist < DISTANCE_THRESHOLD_KM:
                    # This is a duplicate - only add timestamp if it's an actual flight path, not a point marker
                    if metadata['timestamp'] and not is_point_marker:
                        airport['timestamps'].append(metadata['timestamp'])
                    # Update airport name - prefer route names over point marker names
                    # Point markers have names like "Log Start", "Takeoff", "Landing", "Log Stop"
                    # Route names are like "EDAV - EDBH" or just "EDCJ ChemnitzJahnsdorf"
                    new_name = metadata.get('airport_name')
                    current_name = airport.get('name', '')

                    # Determine if new_name is a route/airport name (preferred) vs a point marker name
                    new_is_marker = any(marker in new_name for marker in
                                       ['Log Start', 'Log Stop', 'Takeoff', 'Landing']) if new_name else True
                    current_is_marker = any(marker in current_name for marker in
                                           ['Log Start', 'Log Stop', 'Takeoff', 'Landing']) if current_name else True

                    # Update the name if:
                    # 1. There's no current name, OR
                    # 2. Current name is a marker but new name is a route/airport name
                    if new_name and (not current_name or (current_is_marker and not new_is_marker)):
                        airport['name'] = new_name
                    is_duplicate = True
                    break

            if not is_duplicate:
                # New unique airport - only add timestamp if it's an actual flight, not a point marker
                timestamps = []
                if metadata['timestamp'] and not is_point_marker:
                    timestamps = [metadata['timestamp']]
                # Note: This is a START point, so is_at_path_end should be False
                unique_airports.append({
                    'lat': start_lat,
                    'lon': start_lon,
                    'timestamps': timestamps,
                    'name': metadata.get('airport_name'),
                    'path_index': idx,  # Store the path index for later reference
                    'is_at_path_end': False  # This is a departure/start point
                })

        # Also check for airports at path endpoints (landings) and startpoints (takeoffs)
        # Some KML files have Point placemarks for "Landing"/"Takeoff" separate from the track
        # OR the endpoint might not have any marker at all
        for idx, path in enumerate(all_path_groups):
            if len(path) > 1:
                # Get the start and end points of the path
                start_lat, start_lon, start_alt = path[0][0], path[0][1], path[0][2]
                end_lat, end_lon, end_alt = path[-1][0], path[-1][1], path[-1][2]

                # Get the route name and timestamp from the path metadata
                if idx >= len(all_path_metadata):
                    continue

                route_name = all_path_metadata[idx].get('airport_name', '')
                route_timestamp = all_path_metadata[idx].get('timestamp')

                # Skip if this path doesn't have a proper route name
                route_is_marker = any(marker in route_name for marker in
                                     ['Log Start', 'Log Stop', 'Takeoff', 'Landing']) if route_name else True
                if route_is_marker:
                    continue

                # Detect mid-flight starts
                starts_at_high_altitude = is_mid_flight_start(path, start_alt, DEBUG)
                if starts_at_high_altitude and DEBUG:
                    print(f"  DEBUG: Path '{route_name}' detected as mid-flight start")

                # Check if the startpoint (departure airport) should be added
                # Only add if it's at ground level and not already in unique_airports
                if not starts_at_high_altitude:
                    start_found = False
                    for airport in unique_airports:
                        dist_to_start = haversine_distance(airport['lat'], airport['lon'], start_lat, start_lon)
                        if dist_to_start < DISTANCE_THRESHOLD_KM:
                            start_found = True
                            # Update with route name if it's a better name
                            current_name = airport.get('name', '')
                            if ' - ' in route_name and current_name != route_name:
                                airport['name'] = route_name
                                airport['is_at_path_end'] = False
                            # Add timestamp
                            if route_timestamp and route_timestamp not in airport['timestamps']:
                                airport['timestamps'].append(route_timestamp)
                            break

                    # Create new airport for departure if not found
                    if not start_found and ' - ' in route_name:
                        unique_airports.append({
                            'lat': start_lat,
                            'lon': start_lon,
                            'timestamps': [route_timestamp] if route_timestamp else [],
                            'name': route_name,
                            'is_at_path_end': False  # Mark this as departure airport
                        })
                        if DEBUG:
                            print(f"  DEBUG: Created departure airport for '{route_name}' at {start_alt:.0f}m altitude")

                # Check if the endpoint already exists in unique_airports
                end_found = False
                for airport in unique_airports:
                    dist_to_end = haversine_distance(airport['lat'], airport['lon'], end_lat, end_lon)
                    if dist_to_end < DISTANCE_THRESHOLD_KM:
                        # This endpoint matches an existing airport
                        end_found = True
                        current_name = airport.get('name', '')

                        # Check if this is a point marker that should be updated
                        is_marker = any(marker in current_name for marker in
                                       ['Log Start', 'Log Stop', 'Takeoff', 'Landing'])

                        if is_marker:
                            # Update marker with route name
                            airport['name'] = route_name
                            airport['is_at_path_end'] = True

                        # Add the timestamp for flights landing here (only if not a high-altitude start)
                        if not starts_at_high_altitude and route_timestamp and route_timestamp not in airport['timestamps']:
                            airport['timestamps'].append(route_timestamp)
                        break

                # If endpoint doesn't exist, create a new airport for it at the landing location
                # (this handles cases where there's no Landing marker)
                # Even for high-altitude starts, the landing location is valid
                if not end_found and ' - ' in route_name:
                    if is_valid_landing(path, end_alt, DEBUG):
                        unique_airports.append({
                            'lat': end_lat,
                            'lon': end_lon,
                            'timestamps': [route_timestamp] if not starts_at_high_altitude and route_timestamp else [],
                            'name': route_name,
                            'is_at_path_end': True  # Mark this as landing airport
                        })
                        if DEBUG:
                            print(f"  DEBUG: Created endpoint airport for '{route_name}' at {end_alt:.0f}m altitude (start was at {start_alt:.0f}m)")
                    else:
                        if DEBUG:
                            print(f"  DEBUG: Skipping endpoint for '{route_name}' - ends at {end_alt:.0f}m altitude (still in air)")

        # Debug: print all path metadata to understand what's being counted
        if DEBUG:
            print(f"\n  DEBUG: All path_metadata entries:")
            for idx, meta in enumerate(all_path_metadata):
                airport_name = meta.get('airport_name', '')
                is_marker = any(marker in airport_name for marker in
                              ['Log Start', 'Log Stop', 'Takeoff', 'Landing'])
                print(f"    {idx+1}. {meta.get('airport_name')} at ({meta['start_point'][0]:.4f}, {meta['start_point'][1]:.4f}) - Timestamp: {meta.get('timestamp')} - IsMarker: {is_marker}")

        print(f"  Found {len(unique_airports)} unique airports (deduplicated from {len(all_path_metadata)} flights)")

        # Print airport names for verification
        for idx, airport in enumerate(unique_airports):
            print(f"  Airport {idx+1}: {airport.get('name')} at ({airport['lat']:.4f}, {airport['lon']:.4f})")
            print(f"    Flights: {len(airport['timestamps'])}, Timestamps: {airport['timestamps'][:3]}")

        # Create airport markers layer
        airport_layer = folium.FeatureGroup(name='Airports', show=True)

        # Collect valid airport names for statistics
        valid_airport_names = []

        for airport in unique_airports:
            # Format dates for display
            dates_str = "No dates available"
            if airport['timestamps']:
                # Parse timestamps into datetime objects first, then format
                date_objects = []
                for ts in airport['timestamps']:
                    try:
                        # Try to parse ISO format timestamp (e.g., "2025-03-03T08:58:01Z")
                        if 'T' in ts:
                            dt = datetime.fromisoformat(ts.replace('Z', '+00:00'))
                            date_objects.append(dt)
                        else:
                            # It's already a date string (e.g., "03 Mar 2025")
                            # Try to parse it
                            try:
                                dt = datetime.strptime(ts, '%d %b %Y')
                                date_objects.append(dt)
                            except:
                                pass
                    except:
                        pass

                # Remove duplicates by date (ignore time), sort chronologically
                unique_dates = {}
                for dt in date_objects:
                    date_key = dt.date()
                    if date_key not in unique_dates:
                        unique_dates[date_key] = dt

                # Sort by date and format in German format (DD.MM.YYYY)
                sorted_dates = sorted(unique_dates.values())
                formatted_dates = [dt.strftime('%d.%m.%Y') for dt in sorted_dates]

                if len(formatted_dates) <= 5:
                    dates_str = "<br>".join(formatted_dates)
                else:
                    dates_str = f"{formatted_dates[0]} to {formatted_dates[-1]}<br>({len(formatted_dates)} days)"

            # Extract and validate airport name
            full_name = airport.get('name', 'Unknown')
            is_at_path_end = airport.get('is_at_path_end', False)
            airport_name = extract_airport_name(full_name, is_at_path_end)

            # Skip if invalid
            if not airport_name:
                if DEBUG:
                    print(f"  DEBUG: Skipping invalid airport name: '{full_name}'")
                continue

            # Add to valid airport names list for statistics
            valid_airport_names.append(airport_name)

            popup_html = f"""
            <div style="font-size: 12px; min-width: 150px;">
                <b>🛫 {airport_name}</b><br>
                <b>Flights:</b> {len(airport['timestamps']) if airport['timestamps'] else '1'}<br>
                <b>Dates:</b><br>{dates_str}
            </div>
            """

            # Add marker with custom airport icon
            folium.Marker(
                location=[airport['lat'], airport['lon']],
                popup=folium.Popup(popup_html, max_width=250),
                icon=folium.Icon(color='green', icon='plane', prefix='fa')
            ).add_to(airport_layer)

        airport_layer.add_to(m)
        print(f"  ✓ Added {len(unique_airports)} airport markers")

    # Calculate and add statistics dashboard
    print(f"\n📊 Calculating statistics...")
    stats = calculate_statistics(all_coordinates, all_path_groups)

    # Add airport count and list to statistics
    num_airports = len(valid_airport_names) if all_path_metadata else 0
    stats['num_airports'] = num_airports
    stats['airport_names'] = sorted(valid_airport_names) if valid_airport_names else []

    # Print statistics to console
    print(f"  • Total distance: {stats['total_distance_nm']:.1f} nm")
    if stats['min_altitude_m'] is not None:
        print(f"  • Altitude gain: {stats['total_altitude_gain_ft']:.0f}ft")
    print(f"  • Airports visited: {num_airports}")
    if stats['airport_names']:
        print(f"    - {', '.join(stats['airport_names'][:5])}" + (" ..." if len(stats['airport_names']) > 5 else ""))

    # Format statistics for display
    stats_html = f'''
    <div id="statistics-panel" style="position: fixed;
                top: 10px; left: 130px; width: 280px;
                background-color: #2b2b2b; border:2px solid #555; z-index:9999;
                font-size:13px; padding: 12px; display: none; color: #ffffff;
                box-shadow: 0 2px 6px rgba(0,0,0,0.3);">
    <p style="margin:0 0 10px 0; font-weight:bold; font-size:15px;">📊 Flight Statistics</p>

    <div style="margin-bottom: 8px;">
        <strong>Data Points:</strong><br>
        <span style="margin-left: 10px;">• Total Points: {stats['total_points']:,}</span><br>
        <span style="margin-left: 10px;">• Number of Paths: {stats['num_paths']}</span>
    </div>

    <div style="margin-bottom: 8px;">
        <strong>Airports Visited:</strong> {stats['num_airports']}
    </div>
    '''

    # Add airport list if available
    if stats['airport_names']:
        airport_list_html = '<br>'.join([f'<span style="margin-left: 10px;">• {name}</span>' for name in stats['airport_names']])
        stats_html += f'''
    <div style="margin-bottom: 8px; max-height: 150px; overflow-y: auto;">
        <strong>Airports:</strong><br>
        {airport_list_html}
    </div>
    '''

    stats_html += f'''
    <div style="margin-bottom: 8px;">
        <strong>Distance:</strong> {stats['total_distance_nm']:.1f} nm
    </div>
    '''

    # Add altitude statistics if available
    if stats['min_altitude_m'] is not None:
        stats_html += f'''
    <div style="margin-bottom: 8px;">
        <strong>Max Altitude:</strong> {stats['max_altitude_ft']:.0f}ft
    </div>

    <div style="margin-bottom: 8px;">
        <strong>Elevation Gain:</strong> {stats['total_altitude_gain_ft']:.0f}ft
    </div>
    '''

    stats_html += '''
    </div>
    '''
    m.get_root().html.add_child(folium.Element(stats_html))

    # Add statistics toggle button and dark theme for layer control
    stats_toggle_script = '''
    <style>
    #stats-toggle-btn {
        position: fixed;
        top: 10px;
        left: 50px;
        background-color: #2b2b2b;
        color: #ffffff;
        border: 2px solid #555;
        border-radius: 4px;
        padding: 6px 12px;
        cursor: pointer;
        z-index: 10000;
        font-size: 14px;
        font-weight: bold;
        box-shadow: 0 1px 5px rgba(0,0,0,0.4);
    }
    #stats-toggle-btn:hover {
        background-color: #3b3b3b;
    }

    /* Dark theme for Leaflet layer control */
    .leaflet-control-layers {
        background-color: #2b2b2b !important;
        color: #ffffff !important;
        border: 1px solid #555 !important;
        border-radius: 4px !important;
    }
    .leaflet-control-layers-toggle {
        background-color: #2b2b2b !important;
        border: 1px solid #555 !important;
    }
    .leaflet-control-layers-expanded {
        background-color: #2b2b2b !important;
        color: #ffffff !important;
    }
    .leaflet-control-layers-base label,
    .leaflet-control-layers-overlays label {
        color: #ffffff !important;
    }
    .leaflet-control-layers-separator {
        border-top: 1px solid #555 !important;
    }
    </style>

    <button id="stats-toggle-btn" onclick="toggleStats()">📊 Stats</button>

    <script>
    var statsVisible = false;

    function toggleStats() {
        var panel = document.getElementById('statistics-panel');
        statsVisible = !statsVisible;
        panel.style.display = statsVisible ? 'block' : 'none';
    }
    </script>
    '''
    m.get_root().html.add_child(folium.Element(stats_toggle_script))

    # Add layer control (only showing overlay layers, not base layer)
    folium.LayerControl().add_to(m)

    # Save map
    print(f"\n💾 Saving map to {output_file}...")
    m.save(output_file)
    print(f"✓ Heatmap saved successfully!")
    print(f"  Open {output_file} in your browser to view the interactive map!")

    return True


def print_help():
    """Print comprehensive help message."""
    help_text = """
KML Heatmap Generator
=====================

Create interactive heatmap visualizations from KML files with altitude profiles.

USAGE:
    kml-heatmap.py <path> [path2 ...] [OPTIONS]

ARGUMENTS:
    <path>               KML file(s) or directory containing KML files
                         Directories will be scanned for all .kml files

OPTIONS:
    --output FILE        Output HTML filename (default: heatmap.html)
    --radius N           Heatmap point radius in pixels (default: 10)
    --blur N             Heatmap blur amount (default: 15)
    --debug              Enable debug output to diagnose parsing issues
    --help, -h           Show this help message

FEATURES:
    • Density Heatmap    - Shows where you've been most frequently
    • Altitude Profile   - Color-coded paths showing elevation (toggle-able)
    • Multiple Formats   - Supports Points, LineStrings, and Google Earth Tracks
    • Multi-file Support - Combine multiple KML files into one visualization
    • Parallel Processing - Fast parsing of multiple files simultaneously

EXAMPLES:
    # Basic usage - single file
    kml-heatmap.py flight.kml

    # Process all KML files in a directory
    kml-heatmap.py ./my_flights/

    # Multiple files
    kml-heatmap.py flight1.kml flight2.kml flight3.kml

    # Mix files and directories
    kml-heatmap.py flight.kml ./more_flights/ another.kml

    # Custom output and styling
    kml-heatmap.py *.kml --output my_flights.html --radius 15

    # Debug mode for troubleshooting
    kml-heatmap.py --debug problematic.kml

OUTPUT:
    Creates an interactive HTML map with:
    • Toggle-able layers (Density Heatmap / Altitude Profile)
    • Multiple map styles (OpenStreetMap / Light / Dark)
    • Altitude legend with rounded feet values (100ft increments)
    • Click paths to see altitude popups

For more information, see README.md
"""
    print(help_text)


def main():
    global DEBUG

    # Check for help flag first
    if len(sys.argv) < 2 or '--help' in sys.argv or '-h' in sys.argv:
        print_help()
        sys.exit(0 if '--help' in sys.argv or '-h' in sys.argv else 1)

    # Parse arguments
    kml_files = []
    output_file = "heatmap.html"
    kwargs = {}

    i = 1
    while i < len(sys.argv):
        arg = sys.argv[i]

        if arg == '--help' or arg == '-h':
            print_help()
            sys.exit(0)
        elif arg == '--debug':
            DEBUG = True
            i += 1
        elif arg == '--output':
            if i + 1 < len(sys.argv):
                output_file = sys.argv[i + 1]
                i += 2
            else:
                print("Error: --output requires a filename")
                sys.exit(1)
        elif arg == '--radius':
            if i + 1 < len(sys.argv):
                kwargs['radius'] = int(sys.argv[i + 1])
                i += 2
            else:
                print("Error: --radius requires a number")
                sys.exit(1)
        elif arg == '--blur':
            if i + 1 < len(sys.argv):
                kwargs['blur'] = int(sys.argv[i + 1])
                i += 2
            else:
                print("Error: --blur requires a number")
                sys.exit(1)
        elif arg.startswith('--'):
            print(f"Unknown option: {arg}")
            sys.exit(1)
        else:
            # It's a KML file or directory
            if os.path.isdir(arg):
                # Add all .kml files from directory
                dir_kml_files = []
                for filename in os.listdir(arg):
                    if filename.lower().endswith('.kml'):
                        dir_kml_files.append(os.path.join(arg, filename))

                if dir_kml_files:
                    dir_kml_files.sort()  # Sort alphabetically
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

    # Create heatmap
    success = create_heatmap(kml_files, output_file, **kwargs)

    if not success:
        sys.exit(1)


if __name__ == "__main__":
    main()
