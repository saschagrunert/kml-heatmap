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
import json
from pathlib import Path
from xml.etree import ElementTree as ET
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from math import radians, sin, cos, sqrt, atan2
import folium
from folium.plugins import HeatMap

DEBUG = False

# Get Stadia Maps API key from environment variable
STADIA_API_KEY = os.environ.get('STADIA_API_KEY', '')

# Constants
EARTH_RADIUS_KM = 6371
METERS_TO_FEET = 3.28084
KM_TO_NAUTICAL_MILES = 0.539957

# Altitude detection thresholds
MID_FLIGHT_MIN_ALTITUDE = 400  # meters
MID_FLIGHT_MAX_VARIATION = 100  # meters
LANDING_MAX_VARIATION = 50  # meters
LANDING_MAX_ALTITUDE = 600  # meters
PATH_SAMPLE_MAX_SIZE = 50
PATH_SAMPLE_MIN_SIZE = 5

# Airport deduplication
AIRPORT_DISTANCE_THRESHOLD_KM = 1.5

# Marker types to filter out
POINT_MARKERS = ['Log Start', 'Log Stop', 'Takeoff', 'Landing']

# Heatmap configuration
HEATMAP_GRADIENT = {
    0.0: 'blue',
    0.3: 'cyan',
    0.5: 'lime',
    0.7: 'yellow',
    1.0: 'red'
}


def downsample_path_rdp(path, epsilon=0.0001):
    """
    Downsample a path using Ramer-Douglas-Peucker algorithm.

    Args:
        path: List of [lat, lon] or [lat, lon, alt] coordinates
        epsilon: Tolerance for simplification (smaller = more detail)

    Returns:
        Simplified path
    """
    if len(path) <= 2:
        return path

    def perpendicular_distance(point, line_start, line_end):
        """Calculate perpendicular distance from point to line."""
        if line_start == line_end:
            return haversine_distance(point[0], point[1], line_start[0], line_start[1])

        # Using simple Euclidean approximation for small distances
        x0, y0 = point[0], point[1]
        x1, y1 = line_start[0], line_start[1]
        x2, y2 = line_end[0], line_end[1]

        num = abs((y2 - y1) * x0 - (x2 - x1) * y0 + x2 * y1 - y2 * x1)
        den = sqrt((y2 - y1)**2 + (x2 - x1)**2)

        if den == 0:
            return 0
        return num / den

    # Find point with maximum distance
    dmax = 0
    index = 0
    end = len(path) - 1

    for i in range(1, end):
        d = perpendicular_distance(path[i], path[0], path[end])
        if d > dmax:
            index = i
            dmax = d

    # If max distance is greater than epsilon, recursively simplify
    if dmax > epsilon:
        # Recursive call
        rec_results1 = downsample_path_rdp(path[:index + 1], epsilon)
        rec_results2 = downsample_path_rdp(path[index:], epsilon)

        # Build result list
        result = rec_results1[:-1] + rec_results2
    else:
        result = [path[0], path[end]]

    return result


def downsample_coordinates(coordinates, factor=5):
    """
    Simple downsampling by keeping every Nth point.

    Args:
        coordinates: List of [lat, lon] or [lat, lon, alt]
        factor: Keep every Nth point

    Returns:
        Downsampled coordinates
    """
    if factor <= 1:
        return coordinates
    return [coordinates[i] for i in range(0, len(coordinates), factor)]


def is_point_marker(name):
    """Check if a name represents a point marker (not a flight path)."""
    if not name:
        return True
    return any(marker in name for marker in POINT_MARKERS)


def sample_path_altitudes(path, from_end=False):
    """
    Extract altitude statistics from a path sample.

    Args:
        path: List of [lat, lon, alt] coordinates
        from_end: If True, sample from end of path; otherwise from start

    Returns:
        Dict with 'min', 'max', 'variation' keys, or None if sample too small
    """
    if len(path) <= 10:
        return None

    sample_size = min(PATH_SAMPLE_MAX_SIZE, len(path) // 4)
    if sample_size <= PATH_SAMPLE_MIN_SIZE:
        return None

    sample = path[-sample_size:] if from_end else path[:sample_size]
    alts = [coord[2] for coord in sample]
    return {
        'min': min(alts),
        'max': max(alts),
        'variation': max(alts) - min(alts)
    }


def is_mid_flight_start(path, start_alt, debug=False):
    """
    Detect if a path started mid-flight by analyzing altitude patterns.

    A mid-flight start is characterized by:
    1. Starting at altitude (> MID_FLIGHT_MIN_ALTITUDE) AND
    2. NOT descending/ascending significantly in the first part of the path

    Args:
        path: List of [lat, lon, alt] coordinates
        start_alt: Starting altitude in meters
        debug: Enable debug output

    Returns:
        bool: True if this is a mid-flight start
    """
    sample = sample_path_altitudes(path, from_end=False)
    if not sample:
        return False

    # Mid-flight indicators:
    # - Starting altitude above typical airports
    # - AND altitude variation in first part is small (not climbing/descending much)
    is_mid_flight = start_alt > MID_FLIGHT_MIN_ALTITUDE and sample['variation'] < MID_FLIGHT_MAX_VARIATION

    if is_mid_flight and debug:
        print(f"  DEBUG: Detected mid-flight start at {start_alt:.0f}m (variation: {sample['variation']:.0f}m)")

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
    sample = sample_path_altitudes(path, from_end=True)
    if not sample:
        # Short path, just accept if altitude seems reasonable
        return end_alt < 1000

    # Valid landing: either descending significantly OR stable at low variation
    # Also accept any endpoint if variation at end is small - indicates stable landing
    return sample['variation'] < LANDING_MAX_VARIATION or end_alt < LANDING_MAX_ALTITUDE


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
    lat1, lon1, lat2, lon2 = map(radians, [lat1, lon1, lat2, lon2])
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    a = sin(dlat/2)**2 + cos(lat1) * cos(lat2) * sin(dlon/2)**2
    c = 2 * atan2(sqrt(a), sqrt(1-a))
    return EARTH_RADIUS_KM * c


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

            # Extract timestamps - both start and end for tracks with multiple when elements
            time_elems = placemark.findall('.//kml:when', namespaces)
            if not time_elems:
                time_elems = placemark.findall('.//when')

            # Also try TimeStamp element (single timestamp)
            if not time_elems:
                time_elem = placemark.find('.//kml:TimeStamp/kml:when', namespaces)
                if time_elem is None:
                    time_elem = placemark.find('.//TimeStamp/when')
                if time_elem is not None:
                    time_elems = [time_elem]

            timestamp = None
            end_timestamp = None
            if time_elems and len(time_elems) > 0:
                if time_elems[0].text:
                    timestamp = time_elems[0].text.strip()
                # Get last timestamp if multiple exist
                if len(time_elems) > 1 and time_elems[-1].text:
                    end_timestamp = time_elems[-1].text.strip()
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
                    'timestamp': timestamp,
                    'end_timestamp': end_timestamp
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
            end_timestamp = metadata.get('end_timestamp')

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
                    'end_timestamp': end_timestamp,
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
            gx_end_timestamp = None
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

                    # Extract timestamps - try to get all when elements for start and end time
                    # The <when> elements in gx:Track are in the KML namespace, not gx namespace
                    time_elems = placemark.findall('.//kml:when', namespaces)
                    if not time_elems:
                        time_elems = placemark.findall('.//when')

                    if time_elems and len(time_elems) > 0:
                        # Get first timestamp (start time)
                        if time_elems[0].text:
                            gx_timestamp = time_elems[0].text.strip()
                            if DEBUG:
                                print(f"  DEBUG: Found gx:Track start timestamp: {gx_timestamp}")

                        # Get last timestamp (end time) if available
                        if len(time_elems) > 1 and time_elems[-1].text:
                            gx_end_timestamp = time_elems[-1].text.strip()
                            if DEBUG:
                                print(f"  DEBUG: Found gx:Track end timestamp: {gx_end_timestamp}")
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
                    'end_timestamp': gx_end_timestamp,
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


def calculate_statistics(all_coordinates, all_path_groups, all_path_metadata=None):
    """
    Calculate statistics from coordinate and path data.

    Args:
        all_coordinates: List of [lat, lon] pairs
        all_path_groups: List of path groups with altitude data
        all_path_metadata: List of metadata dicts for each path (optional)

    Returns:
        Dictionary of statistics
    """
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
        'total_flight_time_seconds': 0,
        'total_flight_time_str': None,
    }

    if not all_path_groups:
        return stats

    # Calculate statistics from all path groups (filter out short paths)
    valid_paths = [path for path in all_path_groups if len(path) >= 2]
    if not valid_paths:
        return stats

    # Collect all altitudes
    all_altitudes = [coord[2] for path in valid_paths for coord in path]

    # Calculate distance and elevation changes
    total_distance_km = 0.0
    total_gain_m = 0.0

    for path in valid_paths:
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
        stats['min_altitude_ft'] = stats['min_altitude_m'] * METERS_TO_FEET
        stats['max_altitude_ft'] = stats['max_altitude_m'] * METERS_TO_FEET

    stats['total_distance_km'] = total_distance_km
    stats['total_distance_nm'] = total_distance_km * KM_TO_NAUTICAL_MILES
    stats['total_altitude_gain_m'] = total_gain_m
    stats['total_altitude_gain_ft'] = total_gain_m * METERS_TO_FEET

    # Calculate total flight time from path metadata
    if all_path_metadata:
        total_seconds = 0

        for metadata in all_path_metadata:
            start_ts = metadata.get('timestamp')
            end_ts = metadata.get('end_timestamp')

            # Only calculate duration if both start and end timestamps exist
            if start_ts and end_ts:
                try:
                    # Try to parse ISO format timestamp (e.g., "2025-03-03T08:58:01Z")
                    if 'T' in start_ts and 'T' in end_ts:
                        start_dt = datetime.fromisoformat(start_ts.replace('Z', '+00:00'))
                        end_dt = datetime.fromisoformat(end_ts.replace('Z', '+00:00'))
                        duration = (end_dt - start_dt).total_seconds()
                        if duration > 0:  # Only count positive durations
                            total_seconds += duration
                except Exception:
                    # Skip if parsing fails
                    pass

        stats['total_flight_time_seconds'] = total_seconds

        # Format flight time as human-readable string
        if total_seconds > 0:
            hours = int(total_seconds // 3600)
            minutes = int((total_seconds % 3600) // 60)
            if hours > 0:
                stats['total_flight_time_str'] = f"{hours}h {minutes}m"
            else:
                stats['total_flight_time_str'] = f"{minutes}m"

    return stats


def create_altitude_layer(all_path_groups, m):
    """
    Create altitude visualization layer with color-coded paths and legend.

    Args:
        all_path_groups: List of path groups with altitude data
        m: Folium map object to add elements to

    Returns:
        Tuple of (altitude_layer, min_alt_m, max_alt_m) or (None, None, None) if no altitude data
    """
    if not all_path_groups:
        return None, None, None

    # Calculate altitude range across all paths
    all_altitudes = [coord[2] for path in all_path_groups for coord in path]
    min_alt_m = min(all_altitudes)
    max_alt_m = max(all_altitudes)

    # Convert to feet and round to nearest 100ft
    min_alt_ft = round(min_alt_m * METERS_TO_FEET / 100) * 100
    max_alt_ft = round(max_alt_m * METERS_TO_FEET / 100) * 100

    print(f"📊 Altitude range: {min_alt_ft:.0f}ft to {max_alt_ft:.0f}ft ({min_alt_m:.0f}m to {max_alt_m:.0f}m)")

    # Calculate total segments for progress
    total_segments = sum(len(path) - 1 for path in all_path_groups if len(path) > 1)

    # Create altitude layer
    altitude_layer = folium.FeatureGroup(name='Altitude Profile', show=False)

    if total_segments > 100:
        print(f"🎨 Generating altitude visualization ({total_segments} segments)...")

    # Draw each path group separately
    segments_drawn = 0
    last_progress = 0

    for path in all_path_groups:
        if len(path) > 1:
            # Draw subtle white border for anti-aliasing
            path_coordinates = [[lat, lon] for lat, lon, _ in path]
            folium.PolyLine(
                locations=path_coordinates,
                color='#FFFFFF',
                weight=6,
                opacity=0.15,
            ).add_to(altitude_layer)

            # Draw colored segments
            for i in range(len(path) - 1):
                lat1, lon1, alt1_m = path[i]
                lat2, lon2, alt2_m = path[i + 1]

                avg_alt_m = (alt1_m + alt2_m) / 2
                avg_alt_ft = round(avg_alt_m * METERS_TO_FEET / 100) * 100
                color = get_altitude_color(avg_alt_m, min_alt_m, max_alt_m)

                folium.PolyLine(
                    locations=[[lat1, lon1], [lat2, lon2]],
                    color=color,
                    weight=4,
                    opacity=0.85,
                    popup=f'Altitude: {avg_alt_ft:.0f}ft ({avg_alt_m:.0f}m)'
                ).add_to(altitude_layer)

                # Update progress
                if total_segments > 100:
                    segments_drawn += 1
                    progress = int((segments_drawn / total_segments) * 100)
                    if progress >= last_progress + 10:
                        print(f"  {progress}%...")
                        last_progress = progress

    if total_segments > 100:
        print(f"  100% - Complete!")

    # Generate altitude legend
    num_stops = 20
    gradient_stops = []
    for i in range(num_stops):
        ratio = i / (num_stops - 1)
        alt = min_alt_m + ratio * (max_alt_m - min_alt_m)
        color = get_altitude_color(alt, min_alt_m, max_alt_m)
        gradient_stops.append(f"{color} {ratio * 100:.1f}%")

    gradient_css = ", ".join(gradient_stops)

    # Add legend HTML
    legend_html = f'''
    <div id="altitude-legend" style="position: fixed;
                bottom: 50px; right: 50px; width: fit-content;
                background-color: #2b2b2b; border:2px solid #555; z-index:9999;
                font-size:13px; padding: 10px; display: none; color: #ffffff;
                box-shadow: 0 2px 6px rgba(0,0,0,0.3);">
        <div style="margin:0 0 8px 0; font-weight:bold; white-space: nowrap;">Altitude</div>
        <div style="display: flex; align-items: center; gap: 8px;">
            <div style="width: 20px; height: 100px; background: linear-gradient(to top, {gradient_css}); border: 1px solid #555; border-radius: 2px;"></div>
            <div style="display: flex; flex-direction: column; justify-content: space-between; height: 100px; font-size: 12px; white-space: nowrap;">
                <div>{max_alt_ft:.0f}ft</div>
                <div style="opacity: 0.7;">{((min_alt_ft + max_alt_ft) / 2):.0f}ft</div>
                <div>{min_alt_ft:.0f}ft</div>
            </div>
        </div>
    </div>
    '''
    m.get_root().html.add_child(folium.Element(legend_html))

    # Add legend toggle script
    toggle_script = '''
    <script>
    // Wait for the map to be fully initialized
    function initLegendToggle() {
        var mapElement = document.querySelector('.folium-map');
        if (!mapElement || !mapElement._leaflet_id) {
            setTimeout(initLegendToggle, 100);
            return;
        }

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

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initLegendToggle);
    } else {
        initLegendToggle();
    }
    </script>
    '''
    m.get_root().html.add_child(folium.Element(toggle_script))

    return altitude_layer, min_alt_m, max_alt_m


def deduplicate_airports(all_path_metadata, all_path_groups):
    """
    Deduplicate airports by location and extract valid airport information.

    Args:
        all_path_metadata: List of metadata dicts for each path
        all_path_groups: List of path groups with altitude data

    Returns:
        List of unique airport dicts with lat, lon, timestamps, name, etc.
    """
    unique_airports = []

    # Process start points from metadata
    for idx, metadata in enumerate(all_path_metadata):
        start_lat, start_lon = metadata['start_point'][0], metadata['start_point'][1]
        start_alt = metadata['start_point'][2] if len(metadata['start_point']) > 2 else 0
        airport_name = metadata.get('airport_name', '')

        # Skip point markers - they don't contain airport info
        if is_point_marker(airport_name):
            if DEBUG:
                print(f"  DEBUG: Skipping point marker '{airport_name}'")
            continue

        # Skip mid-flight starts
        path = all_path_groups[idx] if idx < len(all_path_groups) else []
        if is_mid_flight_start(path, start_alt, DEBUG):
            if DEBUG:
                print(f"  DEBUG: Skipping mid-flight start '{airport_name}'")
            continue

        # Check for duplicates
        is_duplicate = False
        for airport in unique_airports:
            dist = haversine_distance(start_lat, start_lon, airport['lat'], airport['lon'])
            if dist < AIRPORT_DISTANCE_THRESHOLD_KM:
                # Update existing airport
                if metadata['timestamp'] and not is_point_marker(airport_name):
                    airport['timestamps'].append(metadata['timestamp'])

                # Prefer route names over marker names
                new_name = metadata.get('airport_name')
                current_name = airport.get('name', '')
                if new_name and (not current_name or
                               (is_point_marker(current_name) and not is_point_marker(new_name))):
                    airport['name'] = new_name
                is_duplicate = True
                break

        if not is_duplicate:
            # Add new unique airport
            timestamps = [metadata['timestamp']] if metadata['timestamp'] and not is_point_marker(airport_name) else []
            unique_airports.append({
                'lat': start_lat,
                'lon': start_lon,
                'timestamps': timestamps,
                'name': metadata.get('airport_name'),
                'path_index': idx,
                'is_at_path_end': False
            })

    # Process path endpoints (landings and takeoffs)
    for idx, path in enumerate(all_path_groups):
        if len(path) <= 1 or idx >= len(all_path_metadata):
            continue

        start_lat, start_lon, start_alt = path[0][0], path[0][1], path[0][2]
        end_lat, end_lon, end_alt = path[-1][0], path[-1][1], path[-1][2]
        route_name = all_path_metadata[idx].get('airport_name', '')
        route_timestamp = all_path_metadata[idx].get('timestamp')

        # Skip if not a proper route name
        if is_point_marker(route_name):
            continue

        # Check for mid-flight starts
        starts_at_high_altitude = is_mid_flight_start(path, start_alt, DEBUG)
        if starts_at_high_altitude and DEBUG:
            print(f"  DEBUG: Path '{route_name}' detected as mid-flight start")

        # Process departure airport (if not high altitude start)
        if not starts_at_high_altitude:
            start_found = False
            for airport in unique_airports:
                if haversine_distance(airport['lat'], airport['lon'], start_lat, start_lon) < AIRPORT_DISTANCE_THRESHOLD_KM:
                    start_found = True
                    if ' - ' in route_name and airport.get('name', '') != route_name:
                        airport['name'] = route_name
                        airport['is_at_path_end'] = False
                    if route_timestamp and route_timestamp not in airport['timestamps']:
                        airport['timestamps'].append(route_timestamp)
                    break

            if not start_found and ' - ' in route_name:
                unique_airports.append({
                    'lat': start_lat,
                    'lon': start_lon,
                    'timestamps': [route_timestamp] if route_timestamp else [],
                    'name': route_name,
                    'is_at_path_end': False
                })
                if DEBUG:
                    print(f"  DEBUG: Created departure airport for '{route_name}' at {start_alt:.0f}m altitude")

        # Process landing airport
        end_found = False
        for airport in unique_airports:
            if haversine_distance(airport['lat'], airport['lon'], end_lat, end_lon) < AIRPORT_DISTANCE_THRESHOLD_KM:
                end_found = True
                if is_point_marker(airport.get('name', '')):
                    airport['name'] = route_name
                    airport['is_at_path_end'] = True
                if not starts_at_high_altitude and route_timestamp and route_timestamp not in airport['timestamps']:
                    airport['timestamps'].append(route_timestamp)
                break

        if not end_found and ' - ' in route_name and is_valid_landing(path, end_alt, DEBUG):
            unique_airports.append({
                'lat': end_lat,
                'lon': end_lon,
                'timestamps': [route_timestamp] if not starts_at_high_altitude and route_timestamp else [],
                'name': route_name,
                'is_at_path_end': True
            })
            if DEBUG:
                print(f"  DEBUG: Created endpoint airport for '{route_name}' at {end_alt:.0f}m altitude")

    return unique_airports


def export_data_json(all_coordinates, all_path_groups, all_path_metadata, unique_airports, stats, output_dir="data"):
    """
    Export data to JSON files at multiple resolutions for progressive loading.

    Args:
        all_coordinates: List of [lat, lon] pairs
        all_path_groups: List of path groups with altitude data
        all_path_metadata: List of metadata dicts for each path
        unique_airports: List of airport dicts
        stats: Statistics dictionary
        output_dir: Directory to save JSON files

    Returns:
        Dictionary with paths to generated files
    """
    os.makedirs(output_dir, exist_ok=True)

    print(f"\n📦 Exporting data to JSON files...")

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

    for res_name, res_config in resolutions.items():
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

        # Prepare path segments with colors
        path_segments = []
        for path in downsampled_paths:
            if len(path) > 1:
                for i in range(len(path) - 1):
                    lat1, lon1, alt1_m = path[i]
                    lat2, lon2, alt2_m = path[i + 1]
                    avg_alt_m = (alt1_m + alt2_m) / 2
                    avg_alt_ft = round(avg_alt_m * METERS_TO_FEET / 100) * 100
                    color = get_altitude_color(avg_alt_m, min_alt_m, max_alt_m)

                    path_segments.append({
                        'coords': [[lat1, lon1], [lat2, lon2]],
                        'color': color,
                        'altitude_ft': avg_alt_ft,
                        'altitude_m': round(avg_alt_m, 0)
                    })

        # Export data
        data = {
            'coordinates': downsampled_coords,
            'path_segments': path_segments,
            'resolution': res_name,
            'original_points': len(all_coordinates),
            'downsampled_points': len(downsampled_coords),
            'compression_ratio': round(len(downsampled_coords) / max(len(all_coordinates), 1) * 100, 1)
        }

        output_file = os.path.join(output_dir, f'data_{res_name}.json')
        with open(output_file, 'w') as f:
            json.dump(data, f, separators=(',', ':'))

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
        valid_airports.append({
            'lat': apt['lat'],
            'lon': apt['lon'],
            'name': airport_name,
            'timestamps': apt['timestamps'],
            'flight_count': len(apt['timestamps']) if apt['timestamps'] else 1
        })

    airports_data = {'airports': valid_airports}

    airports_file = os.path.join(output_dir, 'airports.json')
    with open(airports_file, 'w') as f:
        json.dump(airports_data, f, separators=(',', ':'))

    files['airports'] = airports_file
    print(f"  ✓ Airports: {len(valid_airports)} locations ({os.path.getsize(airports_file) / 1024:.1f} KB)")

    # Export statistics and metadata
    meta_data = {
        'stats': stats,
        'min_alt_m': min_alt_m,
        'max_alt_m': max_alt_m,
        'gradient': HEATMAP_GRADIENT
    }

    meta_file = os.path.join(output_dir, 'metadata.json')
    with open(meta_file, 'w') as f:
        json.dump(meta_data, f, separators=(',', ':'))

    files['metadata'] = meta_file
    print(f"  ✓ Metadata: {os.path.getsize(meta_file) / 1024:.1f} KB")

    total_size = sum(os.path.getsize(f) for f in files.values())
    print(f"  📊 Total data size: {total_size / 1024:.1f} KB")

    return files


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
        tiles=None,  # Don't add default tiles
        zoom_snap=0.25,  # Allow zoom levels in 0.25 increments (e.g., 12.25, 12.5, 12.75)
        zoom_delta=0.25,  # Zoom in/out by 0.25 instead of 1.0 for fine-grained control
        wheel_pix_per_zoom_level=120  # Smooth mouse wheel scrolling
    )

    # Add tile layer (Stadia AlidadeSmoothDark if API key available, otherwise CartoDB dark_matter)
    if STADIA_API_KEY:
        folium.TileLayer(
            tiles=f'https://tiles.stadiamaps.com/tiles/alidade_smooth_dark/{{z}}/{{x}}/{{y}}{{r}}.png?api_key={STADIA_API_KEY}',
            attr='&copy; <a href="https://stadiamaps.com/">Stadia Maps</a>, &copy; <a href="https://openmaptiles.org/">OpenMapTiles</a> &copy; <a href="http://openstreetmap.org">OpenStreetMap</a> contributors',
            name='',  # Empty name prevents it from appearing in layer control
            control=False  # Don't show in layer control
        ).add_to(m)
    else:
        # Fallback to CartoDB dark_matter if no API key provided
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
        gradient=HEATMAP_GRADIENT
    ).add_to(heatmap_layer)
    heatmap_layer.add_to(m)

    # Create altitude visualization layer
    altitude_layer, min_alt_m, max_alt_m = create_altitude_layer(all_path_groups, m)

    # Store airport layer reference for later addition (will be added before altitude layer)
    airport_layer = None

    # Add airport/start point markers
    if all_path_metadata:
        print(f"\n✈️  Processing {len(all_path_metadata)} start points...")

        # Deduplicate airports and extract valid airport information
        unique_airports = deduplicate_airports(all_path_metadata, all_path_groups)

        # Debug output
        if DEBUG:
            print(f"\n  DEBUG: All path_metadata entries:")
            for idx, meta in enumerate(all_path_metadata):
                airport_name = meta.get('airport_name', '')
                marker_status = is_point_marker(airport_name)
                print(f"    {idx+1}. {meta.get('airport_name')} at ({meta['start_point'][0]:.4f}, {meta['start_point'][1]:.4f}) - Timestamp: {meta.get('timestamp')} - IsMarker: {marker_status}")

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

            # Extract ICAO code (4-letter code like EDAQ, EDMV, etc.)
            icao_match = re.search(r'\b([A-Z]{4})\b', airport_name)
            icao_code = icao_match.group(1) if icao_match else None

            popup_html = f"""
            <div style="font-size: 12px; min-width: 150px;">
                <b>🛫 {airport_name}</b><br>
                <b>Flights:</b> {len(airport['timestamps']) if airport['timestamps'] else '1'}<br>
                <b>Dates:</b><br>{dates_str}
            </div>
            """

            # Add marker with embedded ICAO code for better export compatibility
            # Create a clean marker with ICAO code and simple arrow pointing to location
            if icao_code:
                # Marker with embedded ICAO code
                airport_marker_svg = f'''
                <div style="display: flex; flex-direction: column; align-items: center; transform: translate(-50%, -100%);">
                    <!-- ICAO code box -->
                    <div style="background-color: #28a745; color: white; padding: 4px 8px;
                                border: 2px solid #1e7e34; border-radius: 4px 4px 0 0;
                                font-family: monospace; font-size: 13px; font-weight: bold;
                                box-shadow: 0 2px 4px rgba(0,0,0,0.3);
                                white-space: nowrap;">
                        {icao_code}
                    </div>
                    <!-- Arrow pointing down -->
                    <div style="width: 0; height: 0;
                                border-left: 6px solid transparent;
                                border-right: 6px solid transparent;
                                border-top: 8px solid #1e7e34;
                                margin-top: 0;
                                filter: drop-shadow(0 1px 2px rgba(0,0,0,0.3));"></div>
                </div>
                '''
            else:
                # Fallback for airports without ICAO code - use full name or generic marker
                display_name = airport_name[:8] if airport_name and len(airport_name) <= 12 else "APT"
                airport_marker_svg = f'''
                <div style="display: flex; flex-direction: column; align-items: center; transform: translate(-50%, -100%);">
                    <div style="background-color: #28a745; color: white; padding: 4px 8px;
                                border: 2px solid #1e7e34; border-radius: 4px 4px 0 0;
                                font-family: sans-serif; font-size: 11px; font-weight: bold;
                                box-shadow: 0 2px 4px rgba(0,0,0,0.3);
                                white-space: nowrap;">
                        {display_name}
                    </div>
                    <div style="width: 0; height: 0;
                                border-left: 6px solid transparent;
                                border-right: 6px solid transparent;
                                border-top: 8px solid #1e7e34;
                                margin-top: 0;
                                filter: drop-shadow(0 1px 2px rgba(0,0,0,0.3));"></div>
                </div>
                '''

            folium.Marker(
                location=[airport['lat'], airport['lon']],
                popup=folium.Popup(popup_html, max_width=250),
                icon=folium.DivIcon(
                    html=airport_marker_svg,
                    icon_size=(1, 1),  # Let CSS handle sizing
                    icon_anchor=(0, 0)  # CSS transform handles positioning
                )
            ).add_to(airport_layer)

        print(f"  ✓ Added {len(unique_airports)} airport markers")

    # Add layers to map in correct order (Airports before Altitude Profile in layer control)
    if airport_layer:
        airport_layer.add_to(m)
    if all_path_groups and 'altitude_layer' in locals():
        altitude_layer.add_to(m)

    # Calculate and add statistics dashboard
    print(f"\n📊 Calculating statistics...")
    stats = calculate_statistics(all_coordinates, all_path_groups, all_path_metadata)

    # Add airport count and list to statistics
    num_airports = len(valid_airport_names) if all_path_metadata else 0
    stats['num_airports'] = num_airports
    stats['airport_names'] = sorted(valid_airport_names) if valid_airport_names else []

    # Print statistics to console
    print(f"  • Total distance: {stats['total_distance_nm']:.1f} nm")
    if stats['min_altitude_m'] is not None:
        print(f"  • Altitude gain: {stats['total_altitude_gain_ft']:.0f}ft")
    if stats.get('total_flight_time_str'):
        print(f"  • Total flight time: {stats['total_flight_time_str']}")
    print(f"  • Airports visited: {num_airports}")
    if stats['airport_names']:
        print(f"    - {', '.join(stats['airport_names'][:5])}" + (" ..." if len(stats['airport_names']) > 5 else ""))

    # Format statistics for display
    stats_html = f'''
    <div id="statistics-panel" style="position: fixed;
                top: 10px; left: 135px; width: 280px;
                background-color: #2b2b2b; border:2px solid #555; z-index:10001;
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

    # Add flight time if available
    if stats.get('total_flight_time_str'):
        stats_html += f'''
    <div style="margin-bottom: 8px;">
        <strong>Total Flight Time:</strong> {stats['total_flight_time_str']}
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

    # Add statistics toggle button, export button, and dark theme for layer control
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
    #export-btn {
        position: fixed;
        top: 50px;
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
    #export-btn:hover {
        background-color: #3b3b3b;
    }
    #export-btn:disabled {
        background-color: #1b1b1b;
        color: #888;
        cursor: not-allowed;
    }

    /* Hide Leaflet attribution */
    .leaflet-control-attribution {
        display: none !important;
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

    /* Dark theme for Leaflet zoom control */
    .leaflet-control-zoom {
        border: 2px solid #555 !important;
        border-radius: 4px !important;
    }
    .leaflet-control-zoom a {
        background-color: #2b2b2b !important;
        color: #ffffff !important;
        border-bottom: 1px solid #555 !important;
    }
    .leaflet-control-zoom a:hover {
        background-color: #3b3b3b !important;
        color: #ffffff !important;
    }
    .leaflet-control-zoom-in {
        border-top-left-radius: 4px !important;
        border-top-right-radius: 4px !important;
    }
    .leaflet-control-zoom-out {
        border-bottom-left-radius: 4px !important;
        border-bottom-right-radius: 4px !important;
        border-bottom: none !important;
    }
    .leaflet-bar a {
        border-bottom: 1px solid #555 !important;
    }
    .leaflet-bar a:last-child {
        border-bottom: none !important;
    }
    </style>

    <button id="stats-toggle-btn" onclick="toggleStats()">📊 Stats</button>
    <button id="export-btn" onclick="exportMap()">📷 Export</button>

    <!-- Load dom-to-image library for better Leaflet map export -->
    <script src="https://cdn.jsdelivr.net/npm/dom-to-image@2.6.0/dist/dom-to-image.min.js"></script>

    <script>
    // Leaflet tile rendering workaround for gaps/lines between tiles
    // Fixes rendering issues with fractional zoom levels, especially in dark mode
    // See: https://github.com/Leaflet/Leaflet/issues/3575
    (function(){
        var originalInitTile = L.GridLayer.prototype._initTile;
        L.GridLayer.include({
            _initTile: function (tile) {
                originalInitTile.call(this, tile);
                var tileSize = this.getTileSize();
                tile.style.width = tileSize.x + 1 + 'px';
                tile.style.height = tileSize.y + 1 + 'px';
            }
        });
    })();

    var statsVisible = false;

    function toggleStats() {
        var panel = document.getElementById('statistics-panel');
        statsVisible = !statsVisible;
        panel.style.display = statsVisible ? 'block' : 'none';
    }

    function exportMap() {
        var exportBtn = document.getElementById('export-btn');

        // Disable button and show loading state
        exportBtn.disabled = true;
        exportBtn.textContent = '⏳ Exporting...';

        // Find the map container
        var mapContainer = document.querySelector('.folium-map');

        if (!mapContainer) {
            alert('Map container not found. Please wait for the map to load.');
            exportBtn.disabled = false;
            exportBtn.textContent = '📷 Export';
            return;
        }

        // Find all UI controls to hide during export
        var controlsToHide = [
            document.querySelector('.leaflet-control-zoom'),
            document.querySelector('.leaflet-control-layers'),
            document.getElementById('stats-toggle-btn'),
            document.getElementById('export-btn'),
            document.getElementById('statistics-panel'),
            document.getElementById('altitude-legend')
        ];

        // Hide all controls
        var previousDisplayStates = [];
        controlsToHide.forEach(function(element) {
            if (element) {
                previousDisplayStates.push(element.style.display);
                element.style.display = 'none';
            } else {
                previousDisplayStates.push(null);
            }
        });

        // Small delay to ensure controls are hidden and map is rendered
        setTimeout(function() {
            // Use dom-to-image to capture the map (better handling of SVG/Canvas layers)
            // Export at 2x resolution for higher quality as JPEG
            domtoimage.toJpeg(mapContainer, {
                width: mapContainer.offsetWidth * 2,
                height: mapContainer.offsetHeight * 2,
                bgcolor: '#1a1a1a',
                quality: 0.95,
                style: {
                    transform: 'scale(2)',
                    transformOrigin: 'top left'
                }
            }).then(function(dataUrl) {
                // Restore all controls
                controlsToHide.forEach(function(element, index) {
                    if (element) {
                        element.style.display = previousDisplayStates[index] || '';
                    }
                });

                // Re-enable button
                exportBtn.disabled = false;
                exportBtn.textContent = '📷 Export';

                // Create download link
                var link = document.createElement('a');
                var timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
                link.download = 'heatmap_export_' + timestamp + '.jpg';
                link.href = dataUrl;
                link.click();
            }).catch(function(error) {
                // Restore all controls on error
                controlsToHide.forEach(function(element, index) {
                    if (element) {
                        element.style.display = previousDisplayStates[index] || '';
                    }
                });

                console.error('Export error:', error);
                alert('Failed to export map: ' + error.message);

                // Re-enable button
                exportBtn.disabled = false;
                exportBtn.textContent = '📷 Export';
            });
        }, 200);
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


def minify_html(html):
    """
    Minify HTML by removing unnecessary whitespace and newlines.

    Args:
        html: HTML string to minify

    Returns:
        Minified HTML string
    """
    import re

    # Remove comments
    html = re.sub(r'<!--.*?-->', '', html, flags=re.DOTALL)

    # Remove whitespace between tags
    html = re.sub(r'>\s+<', '><', html)

    # Remove leading/trailing whitespace on each line
    html = re.sub(r'^\s+', '', html, flags=re.MULTILINE)
    html = re.sub(r'\s+$', '', html, flags=re.MULTILINE)

    # Replace multiple spaces with single space (but preserve spaces in strings)
    html = re.sub(r'  +', ' ', html)

    # Remove empty lines
    html = re.sub(r'\n\s*\n', '\n', html)

    return html.strip()


def create_progressive_heatmap(kml_files, output_file="index.html", data_dir="data", **kwargs):
    """
    Create a progressive-loading heatmap with external JSON data files.

    This generates a lightweight HTML file that loads data based on zoom level,
    significantly reducing initial load time and memory usage on mobile devices.

    Args:
        kml_files: List of KML file paths
        output_file: Output HTML file path
        data_dir: Directory to save JSON data files
        **kwargs: Additional parameters (radius, blur, etc.)
    """
    # Parse all KML files (reusing code from create_heatmap)
    all_coordinates = []
    all_path_groups = []
    all_path_metadata = []

    valid_files = []
    for kml_file in kml_files:
        if not os.path.exists(kml_file):
            print(f"✗ File not found: {kml_file}")
        else:
            valid_files.append(kml_file)

    if not valid_files:
        print("✗ No valid KML files to process!")
        return False

    print(f"📁 Parsing {len(valid_files)} KML file(s)...")

    def parse_with_error_handling(kml_file):
        try:
            return kml_file, parse_kml_coordinates(kml_file)
        except Exception as e:
            print(f"✗ Error processing {kml_file}: {e}")
            return kml_file, ([], [], [])

    completed_count = 0
    with ThreadPoolExecutor(max_workers=min(len(valid_files), 8)) as executor:
        future_to_file = {executor.submit(parse_with_error_handling, f): f for f in valid_files}
        for future in as_completed(future_to_file):
            kml_file, (coords, path_groups, path_metadata) = future.result()
            all_coordinates.extend(coords)
            all_path_groups.extend(path_groups)
            all_path_metadata.extend(path_metadata)
            completed_count += 1
            progress_pct = (completed_count / len(valid_files)) * 100
            print(f"  [{completed_count}/{len(valid_files)}] {progress_pct:.0f}% - {Path(kml_file).name}")

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
        unique_airports = deduplicate_airports(all_path_metadata, all_path_groups)
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

    # Export data to JSON files
    data_files = export_data_json(all_coordinates, all_path_groups, all_path_metadata, unique_airports, stats, data_dir)

    # Generate lightweight HTML with progressive loading
    print(f"\n💾 Generating progressive HTML...")

    html_content = f"""<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>KML Heatmap</title>
    <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
    <link rel="stylesheet" href="https://unpkg.com/leaflet.heat@0.2.0/dist/leaflet-heat.css" />
    <link rel="stylesheet" href="https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.css" />
    <link rel="stylesheet" href="https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.Default.css" />
    <style>
        * {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Helvetica Neue', Arial, sans-serif; }}
        body {{ margin: 0; padding: 0; }}
        #map {{ position: absolute; top: 0; bottom: 0; right: 0; left: 0; }}

        /* Button styles */
        .control-btn {{
            position: fixed;
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
        }}
        .control-btn:hover {{ background-color: #3b3b3b; }}
        #stats-btn {{ top: 10px; }}
        #export-btn {{ top: 50px; }}

        /* Statistics panel */
        #stats-panel {{
            position: fixed;
            top: 10px;
            left: 135px;
            width: 280px;
            background-color: #2b2b2b;
            border: 2px solid #555;
            z-index: 10001;
            font-size: 13px;
            padding: 12px;
            display: none;
            color: #ffffff;
            box-shadow: 0 2px 6px rgba(0,0,0,0.3);
            max-height: 80vh;
            overflow-y: auto;
        }}

        /* Loading indicator */
        #loading {{
            position: fixed;
            bottom: 10px;
            right: 10px;
            background-color: #2b2b2b;
            color: #ffffff;
            border: 2px solid #555;
            border-radius: 4px;
            padding: 6px 12px;
            z-index: 10000;
            font-size: 12px;
            display: none;
        }}

        /* Dark theme for Leaflet controls */
        .leaflet-control-attribution {{ display: none !important; }}
        .leaflet-control-layers {{
            background-color: #2b2b2b !important;
            color: #ffffff !important;
            border: 1px solid #555 !important;
        }}
        .leaflet-control-layers-toggle {{
            background-color: #2b2b2b !important;
            border: 1px solid #555 !important;
        }}
        .leaflet-control-layers label {{ color: #ffffff !important; }}
        .leaflet-control-zoom {{ border: 2px solid #555 !important; }}
        .leaflet-control-zoom a {{
            background-color: #2b2b2b !important;
            color: #ffffff !important;
        }}
        .leaflet-control-zoom a:hover {{ background-color: #3b3b3b !important; }}

        /* Airport cluster marker - custom styling */
        .airport-cluster-marker {{
            background: transparent;
            border: none;
        }}
    </style>
</head>
<body>
    <div id="map"></div>
    <button id="stats-btn" class="control-btn" onclick="toggleStats()">📊 Stats</button>
    <button id="export-btn" class="control-btn" onclick="exportMap()">📷 Export</button>
    <div id="stats-panel"></div>
    <div id="loading">Loading data...</div>

    <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
    <script src="https://unpkg.com/leaflet.heat@0.2.0/dist/leaflet-heat.js"></script>
    <script src="https://unpkg.com/leaflet.markercluster@1.5.3/dist/leaflet.markercluster.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/dom-to-image@2.6.0/dist/dom-to-image.min.js"></script>

    <script>
        // Configuration
        const CENTER = [{center_lat}, {center_lon}];
        const BOUNDS = [[{min_lat}, {min_lon}], [{max_lat}, {max_lon}]];
        const STADIA_API_KEY = '{STADIA_API_KEY}';
        const DATA_DIR = '{data_dir}';

        // Initialize map
        var map = L.map('map', {{
            center: CENTER,
            zoom: 10,
            zoomSnap: 0.25,
            zoomDelta: 0.25
        }});

        // Add tile layer
        if (STADIA_API_KEY) {{
            L.tileLayer(
                'https://tiles.stadiamaps.com/tiles/alidade_smooth_dark/{{z}}/{{x}}/{{y}}{{r}}.png?api_key=' + STADIA_API_KEY,
                {{
                    attribution: '&copy; <a href="https://stadiamaps.com/">Stadia Maps</a>'
                }}
            ).addTo(map);
        }} else {{
            L.tileLayer('https://{{s}}.basemaps.cartocdn.com/dark_all/{{z}}/{{x}}/{{y}}{{r}}.png', {{
                attribution: '&copy; OpenStreetMap contributors, &copy; CARTO'
            }}).addTo(map);
        }}

        // Fit bounds
        map.fitBounds(BOUNDS, {{ padding: [30, 30] }});

        // Data layers
        var heatmapLayer = null;
        var altitudeLayer = L.layerGroup();
        var airportLayer = L.markerClusterGroup({{
            showCoverageOnHover: false,
            zoomToBoundsOnClick: true,
            spiderfyOnMaxZoom: true,
            disableClusteringAtZoom: 12,
            maxClusterRadius: 25,
            iconCreateFunction: function(cluster) {{
                // Extract ICAO codes from all markers in cluster
                var markers = cluster.getAllChildMarkers();
                var icaoCodes = markers.map(function(marker) {{
                    return marker.options.icao || 'APT';
                }}).filter(function(value, index, self) {{
                    return self.indexOf(value) === index;  // Remove duplicates
                }});

                // Join with commas, limit to 4 for readability
                var displayText = icaoCodes.slice(0, 4).join(', ');
                if (icaoCodes.length > 4) {{
                    displayText += ' +' + (icaoCodes.length - 4);
                }}

                // Create merged airport marker
                var html = `
                <div style="display: flex; flex-direction: column; align-items: center; transform: translate(-50%, -100%);">
                    <div style="background-color: #28a745; color: white; padding: 4px 8px;
                                border: 2px solid #1e7e34; border-radius: 4px 4px 0 0;
                                font-family: monospace; font-size: 13px; font-weight: bold;
                                box-shadow: 0 2px 4px rgba(0,0,0,0.3); white-space: nowrap;">
                        ${{displayText}}
                    </div>
                    <div style="width: 0; height: 0;
                                border-left: 6px solid transparent;
                                border-right: 6px solid transparent;
                                border-top: 8px solid #1e7e34;"></div>
                </div>`;

                return L.divIcon({{
                    html: html,
                    iconSize: [1, 1],
                    iconAnchor: [0, 0],
                    className: 'airport-cluster-marker'
                }});
            }}
        }});
        var currentResolution = null;
        var loadedData = {{}};

        // Layer control (only for altitude and airports - heatmap is always visible)
        var layerControl = L.control.layers(null, {{
            'Altitude Profile': altitudeLayer,
            'Airports': airportLayer
        }}, {{ collapsed: false }}).addTo(map);

        // Add airports layer by default
        airportLayer.addTo(map);

        // Load data based on zoom level (5 resolution levels for smoother transitions)
        function getResolutionForZoom(zoom) {{
            if (zoom <= 4) return 'z0_4';
            if (zoom <= 7) return 'z5_7';
            if (zoom <= 10) return 'z8_10';
            if (zoom <= 13) return 'z11_13';
            return 'z14_plus';
        }}

        function showLoading() {{
            document.getElementById('loading').style.display = 'block';
        }}

        function hideLoading() {{
            document.getElementById('loading').style.display = 'none';
        }}

        async function loadData(resolution) {{
            if (loadedData[resolution]) {{
                return loadedData[resolution];
            }}

            showLoading();
            try {{
                const response = await fetch(DATA_DIR + '/data_' + resolution + '.json');
                const data = await response.json();
                loadedData[resolution] = data;
                console.log('Loaded ' + resolution + ' resolution:', data.downsampled_points + ' points');
                return data;
            }} catch (error) {{
                console.error('Error loading data:', error);
                return null;
            }} finally {{
                hideLoading();
            }}
        }}

        async function loadAirports() {{
            try {{
                const response = await fetch(DATA_DIR + '/airports.json');
                const data = await response.json();
                return data.airports;
            }} catch (error) {{
                console.error('Error loading airports:', error);
                return [];
            }}
        }}

        async function loadMetadata() {{
            try {{
                const response = await fetch(DATA_DIR + '/metadata.json');
                return await response.json();
            }} catch (error) {{
                console.error('Error loading metadata:', error);
                return null;
            }}
        }}

        async function updateLayers() {{
            const zoom = map.getZoom();
            const resolution = getResolutionForZoom(zoom);

            if (resolution === currentResolution) {{
                return;
            }}

            currentResolution = resolution;
            const data = await loadData(resolution);

            if (!data) return;

            // Update heatmap (always visible - not in layer control)
            if (heatmapLayer) {{
                map.removeLayer(heatmapLayer);
            }}

            heatmapLayer = L.heatLayer(data.coordinates, {{
                radius: {kwargs.get('radius', 10)},
                blur: {kwargs.get('blur', 15)},
                minOpacity: 0.25,
                maxOpacity: 0.6,
                gradient: {{
                    0.0: 'blue',
                    0.3: 'cyan',
                    0.5: 'lime',
                    0.7: 'yellow',
                    1.0: 'red'
                }}
            }}).addTo(map);

            // Update altitude layer
            altitudeLayer.clearLayers();
            data.path_segments.forEach(function(segment) {{
                L.polyline(segment.coords, {{
                    color: segment.color,
                    weight: 4,
                    opacity: 0.85
                }}).bindPopup('Altitude: ' + segment.altitude_ft + 'ft (' + segment.altitude_m + 'm)')
                  .addTo(altitudeLayer);
            }});

            console.log('Updated to ' + resolution + ' resolution');
        }}

        // Load airports once
        (async function() {{
            const airports = await loadAirports();
            const metadata = await loadMetadata();

            // Add airport markers
            airports.forEach(function(airport) {{
                const icaoMatch = airport.name ? airport.name.match(/\\b([A-Z]{{4}})\\b/) : null;
                const icao = icaoMatch ? icaoMatch[1] : 'APT';

                const markerHtml = `
                <div style="display: flex; flex-direction: column; align-items: center; transform: translate(-50%, -100%);">
                    <div style="background-color: #28a745; color: white; padding: 4px 8px;
                                border: 2px solid #1e7e34; border-radius: 4px 4px 0 0;
                                font-family: monospace; font-size: 13px; font-weight: bold;
                                box-shadow: 0 2px 4px rgba(0,0,0,0.3); white-space: nowrap;">
                        ${{icao}}
                    </div>
                    <div style="width: 0; height: 0;
                                border-left: 6px solid transparent;
                                border-right: 6px solid transparent;
                                border-top: 8px solid #1e7e34;"></div>
                </div>`;

                const popup = `
                <div style="font-size: 12px; min-width: 150px;">
                    <b>🛫 ${{airport.name || 'Unknown'}}</b><br>
                    <b>Flights:</b> ${{airport.flight_count}}<br>
                </div>`;

                L.marker([airport.lat, airport.lon], {{
                    icon: L.divIcon({{
                        html: markerHtml,
                        iconSize: [1, 1],
                        iconAnchor: [0, 0]
                    }}),
                    icao: icao  // Store ICAO for cluster icon function
                }}).bindPopup(popup).addTo(airportLayer);
            }});

            // Load statistics
            if (metadata && metadata.stats) {{
                updateStatsPanel(metadata.stats);
            }}

            // Initial data load
            updateLayers();
        }})();

        // Update on zoom
        map.on('zoomend', updateLayers);

        // Statistics panel
        function updateStatsPanel(stats) {{
            let html = '<p style="margin:0 0 10px 0; font-weight:bold; font-size:15px;">📊 Flight Statistics</p>';
            html += '<div style="margin-bottom: 8px;"><strong>Data Points:</strong><br>';
            html += '<span style="margin-left: 10px;">• Total Points: ' + stats.total_points.toLocaleString() + '</span><br>';
            html += '<span style="margin-left: 10px;">• Number of Paths: ' + stats.num_paths + '</span></div>';
            html += '<div style="margin-bottom: 8px;"><strong>Airports Visited:</strong> ' + stats.num_airports + '</div>';

            if (stats.airport_names && stats.airport_names.length > 0) {{
                html += '<div style="margin-bottom: 8px; max-height: 150px; overflow-y: auto;"><strong>Airports:</strong><br>';
                stats.airport_names.forEach(function(name) {{
                    html += '<span style="margin-left: 10px;">• ' + name + '</span><br>';
                }});
                html += '</div>';
            }}

            html += '<div style="margin-bottom: 8px;"><strong>Distance:</strong> ' + stats.total_distance_nm.toFixed(1) + ' nm</div>';

            if (stats.total_flight_time_str) {{
                html += '<div style="margin-bottom: 8px;"><strong>Total Flight Time:</strong> ' + stats.total_flight_time_str + '</div>';
            }}

            if (stats.max_altitude_ft) {{
                html += '<div style="margin-bottom: 8px;"><strong>Max Altitude:</strong> ' + Math.round(stats.max_altitude_ft) + 'ft</div>';
                html += '<div style="margin-bottom: 8px;"><strong>Elevation Gain:</strong> ' + Math.round(stats.total_altitude_gain_ft) + 'ft</div>';
            }}

            document.getElementById('stats-panel').innerHTML = html;
        }}

        function toggleStats() {{
            const panel = document.getElementById('stats-panel');
            panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
        }}

        function exportMap() {{
            const btn = document.getElementById('export-btn');
            btn.disabled = true;
            btn.textContent = '⏳ Exporting...';

            const mapContainer = document.getElementById('map');
            const controls = [
                document.querySelector('.leaflet-control-zoom'),
                document.querySelector('.leaflet-control-layers'),
                document.getElementById('stats-btn'),
                document.getElementById('export-btn'),
                document.getElementById('stats-panel'),
                document.getElementById('loading')
            ];

            const displayStates = controls.map(el => el ? el.style.display : null);
            controls.forEach(el => {{ if (el) el.style.display = 'none'; }});

            setTimeout(function() {{
                domtoimage.toJpeg(mapContainer, {{
                    width: mapContainer.offsetWidth * 2,
                    height: mapContainer.offsetHeight * 2,
                    bgcolor: '#1a1a1a',
                    quality: 0.95,
                    style: {{
                        transform: 'scale(2)',
                        transformOrigin: 'top left'
                    }}
                }}).then(function(dataUrl) {{
                    controls.forEach((el, i) => {{ if (el) el.style.display = displayStates[i] || ''; }});
                    btn.disabled = false;
                    btn.textContent = '📷 Export';

                    const link = document.createElement('a');
                    link.download = 'heatmap_' + new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-') + '.jpg';
                    link.href = dataUrl;
                    link.click();
                }}).catch(function(error) {{
                    controls.forEach((el, i) => {{ if (el) el.style.display = displayStates[i] || ''; }});
                    alert('Export failed: ' + error.message);
                    btn.disabled = false;
                    btn.textContent = '📷 Export';
                }});
            }}, 200);
        }}
    </script>
</body>
</html>
"""

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
    --output FILE        Output HTML filename (default: index.html)
    --data-dir DIR       Directory for JSON data files (default: data)
    --radius N           Heatmap point radius in pixels (default: 10)
    --blur N             Heatmap blur amount (default: 15)
    --debug              Enable debug output to diagnose parsing issues
    --help, -h           Show this help message

PROGRESSIVE LOADING:
    The generator now uses progressive loading by default, which:
    • Creates a lightweight HTML file (~20-40 KB)
    • Stores data in external JSON files at 3 resolution levels
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
    docker run -v $(pwd):/data kml-heatmap *.kml && \
    docker run -p 8000:8000 -v $(pwd):/data --entrypoint python kml-heatmap /app/serve.py

    # Python usage - single file
    python kml-heatmap.py flight.kml
    python -m http.server 8000  # Serve the files

    # Process all KML files in a directory
    python kml-heatmap.py ./my_flights/

    # Multiple files with custom output
    python kml-heatmap.py *.kml --output my_map.html --radius 15

    # Debug mode for troubleshooting
    python kml-heatmap.py --debug problematic.kml

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
    output_file = "index.html"
    data_dir = "data"
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
        elif arg == '--data-dir':
            if i + 1 < len(sys.argv):
                data_dir = sys.argv[i + 1]
                i += 2
            else:
                print("Error: --data-dir requires a directory name")
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

    print(f"\nKML Heatmap Generator (Progressive Mode)")
    print(f"{'=' * 50}\n")

    # Create progressive heatmap (default)
    success = create_progressive_heatmap(kml_files, output_file, data_dir, **kwargs)

    if not success:
        sys.exit(1)


if __name__ == "__main__":
    main()
