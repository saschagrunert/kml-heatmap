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

# Get API keys from environment variables
STADIA_API_KEY = os.environ.get('STADIA_API_KEY', '')
OPENAIP_API_KEY = os.environ.get('OPENAIP_API_KEY', '')

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


def extract_year_from_timestamp(timestamp):
    """Extract year from timestamp string.

    Args:
        timestamp: Timestamp string in ISO format (e.g., "2025-03-03T08:58:01Z")
                   or other date formats

    Returns:
        Year as integer, or None if extraction fails
    """
    if not timestamp:
        return None

    try:
        # Try to parse ISO format timestamp (e.g., "2025-03-03T08:58:01Z")
        if 'T' in timestamp:
            dt = datetime.fromisoformat(timestamp.replace('Z', '+00:00'))
            return dt.year
        # Try to extract year from date string (e.g., "03 Mar 2025" or "2025-03-03")
        year_match = re.search(r'\b(20\d{2})\b', timestamp)
        if year_match:
            return int(year_match.group(1))
    except Exception:
        pass

    return None


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
            year = extract_year_from_timestamp(timestamp)
            for coord_elem in placemark_coords:
                coord_to_metadata[id(coord_elem)] = {
                    'airport_name': airport_name,
                    'timestamp': timestamp,
                    'end_timestamp': end_timestamp,
                    'year': year
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
                year = extract_year_from_timestamp(timestamp)
                path_metadata.append({
                    'timestamp': timestamp,
                    'end_timestamp': end_timestamp,
                    'filename': Path(kml_file).name,
                    'start_point': current_path[0],  # [lat, lon, alt]
                    'airport_name': airport_name,
                    'year': year
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
                gx_year = extract_year_from_timestamp(gx_timestamp)
                path_metadata.append({
                    'timestamp': gx_timestamp,
                    'end_timestamp': gx_end_timestamp,
                    'filename': Path(kml_file).name,
                    'start_point': gx_path[0],  # [lat, lon, alt]
                    'airport_name': gx_airport_name,
                    'year': gx_year
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
    # Count only actual flight paths, not point markers
    num_flight_paths = 0
    if all_path_metadata:
        for metadata in all_path_metadata:
            airport_name = metadata.get('airport_name', '')
            if not is_point_marker(airport_name):
                num_flight_paths += 1
    else:
        # Fallback if no metadata available
        num_flight_paths = len(all_path_groups)

    stats = {
        'total_points': len(all_coordinates),
        'num_paths': num_flight_paths,
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

                # Store path info with airport relationships
                path_info.append({
                    'id': path_idx,
                    'start_airport': start_airport,
                    'end_airport': end_airport,
                    'start_coords': [path[0][0], path[0][1]],
                    'end_coords': [path[-1][0], path[-1][1]],
                    'segment_count': len(path) - 1,
                    'year': path_year
                })

                # Create segments for this path
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
                        'altitude_m': round(avg_alt_m, 0),
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

    # Export statistics and metadata
    meta_data = {
        'stats': stats,
        'min_alt_m': min_alt_m,
        'max_alt_m': max_alt_m,
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


def create_heatmap(kml_files, output_file="heatmap.html"):
    """
    Create an interactive heatmap from one or more KML files.

    Args:
        kml_files: List of KML file paths
        output_file: Output HTML file path

    Note:
        This function generates a standalone HTML file with all data embedded.
        For better performance, use create_progressive_heatmap() instead.
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
    results = []
    completed_count = 0
    with ThreadPoolExecutor(max_workers=min(len(valid_files), 8)) as executor:
        # Submit all parsing tasks
        future_to_file = {executor.submit(parse_with_error_handling, f): f for f in valid_files}

        # Collect results as they complete with progress
        for future in as_completed(future_to_file):
            kml_file, (coords, path_groups, path_metadata) = future.result()
            results.append((kml_file, coords, path_groups, path_metadata))

            # Update progress
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
        wheel_pix_per_zoom_level=120  # 2 scrolls = 1 zoom level (matches button steps)
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
        radius=10,
        blur=15,
        min_opacity=0.25,  # Reduced from 0.4 for less obstruction
        max_opacity=0.6,  # Cap maximum opacity to keep paths visible underneath
        max_zoom=18,
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

            # Convert to degrees, minutes, seconds
            def dd_to_dms(dd, is_lat):
                direction = 'N' if dd >= 0 else 'S' if is_lat else 'E' if dd >= 0 else 'W'
                dd = abs(dd)
                degrees = int(dd)
                minutes = int((dd - degrees) * 60)
                seconds = ((dd - degrees) * 60 - minutes) * 60
                return f"{degrees}°{minutes}'{seconds:.1f}\"{direction}"

            lat_dms = dd_to_dms(airport['lat'], True)
            lon_dms = dd_to_dms(airport['lon'], False)
            google_maps_link = f"https://www.google.com/maps?q={airport['lat']},{airport['lon']}"

            popup_html = f"""
            <div style="font-size: 12px; min-width: 150px;">
                <b>🛫 {airport_name}</b><br>
                <a href="{google_maps_link}" target="_blank" style="color: #4285f4; text-decoration: none;">{lat_dms} {lon_dms}</a><br>
                <b>Dates:</b><br>{dates_str}<br>
                <b>Flights:</b> {len(airport['timestamps']) if airport['timestamps'] else '1'}
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
    Minify HTML, CSS, and JavaScript using specialized minification libraries.

    Args:
        html: HTML string to minify

    Returns:
        Minified HTML string
    """
    import re
    import rcssmin
    import rjsmin
    import minify_html as mh

    # First, minify inline CSS and JavaScript
    def minify_css_tags(match):
        css_content = match.group(1)
        minified_css = rcssmin.cssmin(css_content)
        return f'<style>{minified_css}</style>'

    def minify_js_tags(match):
        js_content = match.group(1)
        minified_js = rjsmin.jsmin(js_content)
        return f'<script>{minified_js}</script>'

    # Minify inline CSS
    html = re.sub(r'<style>(.*?)</style>', minify_css_tags, html, flags=re.DOTALL)

    # Minify inline JavaScript (not script tags with src attribute)
    html = re.sub(r'<script>(.*?)</script>', minify_js_tags, html, flags=re.DOTALL)

    # Use minify-html for HTML minification
    # minify-html is a Rust-based minifier with simple API
    minified = mh.minify(html)

    return minified


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

    # Export data to JSON files (strip timestamps by default for privacy)
    data_files = export_data_json(all_coordinates, all_path_groups, all_path_metadata, unique_airports, stats, data_dir, strip_timestamps=True)

    # Generate lightweight HTML with progressive loading
    print(f"\n💾 Generating progressive HTML...")

    # Use only the directory name for DATA_DIR (relative path for web serving)
    data_dir_name = os.path.basename(data_dir)

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
        #map {{
            position: absolute;
            top: 0;
            bottom: 0;
            right: 0;
            left: 0;
        }}

        /* Button styles */
        .control-btn {{
            position: fixed;
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
            touch-action: manipulation;
        }}
        .control-btn:hover {{ background-color: #3b3b3b; }}

        /* Left side buttons */
        .control-btn.left {{ left: 50px; }}
        #stats-btn {{ top: 10px; }}
        #export-btn {{ top: 50px; }}
        #wrapped-btn {{ top: 90px; }}

        /* Right side buttons */
        .control-btn.right {{
            right: 10px;
            min-width: 120px;
            text-align: center;
        }}
        #year-filter {{ top: 10px; }}
        #heatmap-btn {{ top: 50px; }}
        #airports-btn {{ top: 90px; }}
        #altitude-btn {{ top: 130px; }}
        #aviation-btn {{ top: 170px; }}

        /* Year filter dropdown - styled like other buttons */
        #year-filter {{
            background-color: #2b2b2b;
            color: #ffffff;
            border: 2px solid #555;
            border-radius: 4px;
            padding: 6px 12px;
            cursor: pointer;
            font-size: 14px;
            font-weight: bold;
            box-shadow: 0 1px 5px rgba(0,0,0,0.4);
            touch-action: manipulation;
            width: 120px;
            box-sizing: border-box;
            text-align: center;
        }}
        #year-filter select {{
            background: transparent;
            color: #ffffff;
            border: 0 !important;
            border-style: none !important;
            border-width: 0 !important;
            border-color: transparent !important;
            border-image: none !important;
            cursor: pointer;
            font-size: 14px;
            font-weight: bold;
            width: calc(100% + 24px);
            margin: -6px -12px;
            padding: 6px 12px;
            outline: none !important;
            box-shadow: none !important;
            text-align: center;
            text-align-last: center;
            -webkit-appearance: none;
            -moz-appearance: none;
            appearance: none;
        }}
        #year-filter select:focus {{
            outline: none !important;
            border: 0 !important;
            border-style: none !important;
            box-shadow: none !important;
        }}
        #year-filter select:active {{
            border: 0 !important;
            border-style: none !important;
        }}
        #year-filter select option {{
            background-color: #2b2b2b;
            color: #ffffff;
            text-align: center;
        }}
        #year-filter:hover {{
            background-color: #3b3b3b;
        }}

        /* Altitude legend */
        #altitude-legend {{
            position: fixed;
            bottom: 30px;
            left: 10px;
            background-color: rgba(43, 43, 43, 0.9);
            color: #ffffff;
            border: 2px solid #555;
            border-radius: 4px;
            padding: 10px;
            z-index: 1000;
            font-size: 12px;
            min-width: 200px;
            display: none;
        }}
        #altitude-legend .legend-title {{
            font-weight: bold;
            margin-bottom: 8px;
            font-size: 13px;
        }}
        #altitude-legend .gradient-bar {{
            height: 20px;
            background: linear-gradient(to right,
                rgb(80, 160, 255) 0%,
                rgb(0, 255, 255) 20%,
                rgb(0, 255, 0) 40%,
                rgb(255, 255, 0) 60%,
                rgb(255, 165, 0) 80%,
                rgb(255, 66, 66) 100%);
            border-radius: 3px;
            margin-bottom: 5px;
        }}
        #altitude-legend .labels {{
            display: flex;
            justify-content: space-between;
            font-size: 11px;
        }}

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

        /* Wrapped card modal */
        #wrapped-modal {{
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: linear-gradient(135deg, rgba(10, 10, 20, 0.97) 0%, rgba(15, 20, 35, 0.97) 100%);
            z-index: 20000;
            display: none;
            justify-content: center;
            align-items: center;
            padding: 40px;
            box-sizing: border-box;
        }}
        #wrapped-container {{
            display: flex;
            gap: 30px;
            width: 100%;
            height: 100%;
        }}
        #wrapped-map-container {{
            flex: 1;
            background-color: #1a1a1a;
            border-radius: 20px;
            overflow: hidden;
            box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);
            position: relative;
            display: flex;
            align-items: center;
            justify-content: center;
        }}
        #wrapped-map-snapshot {{
            width: 100%;
            height: 100%;
            object-fit: cover;
        }}
        #wrapped-card {{
            background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
            border-radius: 20px;
            padding: 40px;
            width: 500px;
            flex-shrink: 0;
            overflow: hidden;
            box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);
            color: #ffffff;
            position: relative;
            display: flex;
            flex-direction: column;
        }}
        #wrapped-card h1 {{
            font-size: 48px;
            margin: 0 0 10px 0;
            background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
            text-fill-color: transparent;
        }}
        #wrapped-card .year {{
            font-size: 72px;
            font-weight: bold;
            text-align: center;
            margin: 20px 0;
            background: linear-gradient(135deg, #4facfe 0%, #00f2fe 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
            text-fill-color: transparent;
        }}
        #wrapped-card .stat-grid {{
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 20px;
            margin: 30px 0;
        }}
        #wrapped-card .stat-card {{
            background-color: rgba(255, 255, 255, 0.1);
            border-radius: 12px;
            padding: 20px;
            text-align: center;
        }}
        #wrapped-card .stat-value {{
            font-size: 36px;
            font-weight: bold;
            color: #4facfe;
            margin-bottom: 5px;
        }}
        #wrapped-card .stat-label {{
            font-size: 14px;
            opacity: 0.8;
            text-transform: uppercase;
            letter-spacing: 1px;
        }}
        #wrapped-card .close-btn {{
            position: absolute;
            top: 20px;
            right: 20px;
            background: transparent;
            border: none;
            color: #ffffff;
            font-size: 32px;
            cursor: pointer;
            padding: 0;
            width: 40px;
            height: 40px;
            line-height: 40px;
            text-align: center;
            border-radius: 50%;
            transition: background-color 0.2s;
        }}
        #wrapped-card .close-btn:hover {{
            background-color: rgba(255, 255, 255, 0.1);
        }}
        #wrapped-card .fun-facts {{
            margin: 25px 0;
            padding: 20px;
            background: linear-gradient(135deg, rgba(79, 172, 254, 0.15) 0%, rgba(0, 242, 254, 0.15) 100%);
            border-radius: 12px;
            border: 1px solid rgba(79, 172, 254, 0.3);
        }}
        #wrapped-card .fun-facts-title {{
            font-size: 16px;
            font-weight: bold;
            margin-bottom: 12px;
            color: #4facfe;
            text-transform: uppercase;
            letter-spacing: 1px;
        }}
        #wrapped-card .fun-fact {{
            font-size: 14px;
            margin: 8px 0;
            opacity: 0.9;
            line-height: 1.6;
        }}
        #wrapped-card .fun-fact strong {{
            color: #00f2fe;
        }}
        #wrapped-card .top-airports {{
            margin: 25px 0;
        }}
        #wrapped-card .top-airports-title {{
            font-size: 16px;
            font-weight: bold;
            margin-bottom: 12px;
            color: #f5576c;
            text-transform: uppercase;
            letter-spacing: 1px;
        }}
        #wrapped-card .top-airport {{
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 10px 15px;
            margin: 8px 0;
            background-color: rgba(245, 87, 108, 0.15);
            border-radius: 8px;
            border-left: 3px solid #f5576c;
        }}
        #wrapped-card .top-airport-name {{
            font-size: 14px;
            font-weight: 500;
        }}
        #wrapped-card .top-airport-count {{
            font-size: 14px;
            font-weight: bold;
            color: #f5576c;
        }}
        #wrapped-card .airports-grid {{
            margin: 25px 0;
        }}
        #wrapped-card .airports-grid-title {{
            font-size: 16px;
            font-weight: bold;
            margin-bottom: 12px;
            color: #f093fb;
            text-transform: uppercase;
            letter-spacing: 1px;
        }}
        #wrapped-card .airport-badges {{
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
        }}
        #wrapped-card .airport-badge {{
            background: linear-gradient(135deg, rgba(240, 147, 251, 0.2) 0%, rgba(245, 87, 108, 0.2) 100%);
            border: 1px solid rgba(240, 147, 251, 0.4);
            padding: 6px 12px;
            border-radius: 20px;
            font-size: 12px;
            font-weight: 500;
            color: #ffffff;
            white-space: nowrap;
        }}
        #wrapped-card-content {{
            flex: 1;
            overflow-y: auto;
            overflow-x: hidden;
            margin: 0 -40px;
            padding: 0 40px;
        }}
        #wrapped-card-content::-webkit-scrollbar {{
            width: 8px;
        }}
        #wrapped-card-content::-webkit-scrollbar-track {{
            background: rgba(255, 255, 255, 0.05);
            border-radius: 4px;
        }}
        #wrapped-card-content::-webkit-scrollbar-thumb {{
            background: rgba(255, 255, 255, 0.2);
            border-radius: 4px;
        }}
        #wrapped-card-content::-webkit-scrollbar-thumb:hover {{
            background: rgba(255, 255, 255, 0.3);
        }}
        #wrapped-card .export-wrapped-btn {{
            background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
            border: none;
            color: #ffffff;
            padding: 15px 30px;
            border-radius: 25px;
            font-size: 16px;
            font-weight: bold;
            cursor: pointer;
            margin-top: 30px;
            width: 100%;
            box-shadow: 0 5px 15px rgba(245, 87, 108, 0.3);
            transition: transform 0.2s, box-shadow 0.2s;
            flex-shrink: 0;
        }}
        #wrapped-card .export-wrapped-btn:hover {{
            transform: translateY(-2px);
            box-shadow: 0 7px 20px rgba(245, 87, 108, 0.4);
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

        /* Modern dot marker styles */
        .airport-marker {{
            width: 12px;
            height: 12px;
            background-color: #28a745;
            border: 2px solid #ffffff;
            border-radius: 50%;
            box-shadow: 0 2px 6px rgba(0,0,0,0.4);
            cursor: pointer;
            transition: all 0.2s ease;
            flex-shrink: 0;
        }}

        /* Airport label styles */
        .airport-label {{
            background-color: rgba(43, 43, 43, 0.9);
            border: 1px solid #28a745;
            color: #ffffff;
            font-family: monospace;
            font-weight: bold;
            font-size: 11px;
            padding: 2px 6px;
            border-radius: 3px;
            white-space: nowrap;
            pointer-events: none;
            box-shadow: 0 1px 3px rgba(0, 0, 0, 0.4);
            position: absolute;
            bottom: 18px;
            left: 50%;
            transform: translateX(-50%);
        }}
        .airport-marker-container {{
            position: relative;
            display: flex;
            align-items: center;
            justify-content: center;
            width: 12px;
            height: 12px;
        }}
        .airport-marker-container:hover .airport-marker {{
            transform: scale(1.3);
            box-shadow: 0 3px 8px rgba(0,0,0,0.6);
        }}

        /* Cluster dot styles */
        .airport-cluster-dot {{
            width: 20px;
            height: 20px;
            background-color: #28a745;
            border: 3px solid #ffffff;
            border-radius: 50%;
            box-shadow: 0 3px 8px rgba(0,0,0,0.5);
            display: flex;
            align-items: center;
            justify-content: center;
            color: #ffffff;
            font-weight: bold;
            font-size: 11px;
            cursor: pointer;
            transition: all 0.2s ease;
        }}
        .airport-cluster-dot:hover {{
            transform: scale(1.2);
            box-shadow: 0 4px 10px rgba(0,0,0,0.7);
        }}

        /* Tooltip styles */
        .leaflet-tooltip {{
            background-color: #2b2b2b;
            border: 2px solid #28a745;
            color: #ffffff;
            font-family: monospace;
            font-weight: bold;
            font-size: 12px;
            padding: 4px 8px;
            border-radius: 4px;
            box-shadow: 0 2px 6px rgba(0,0,0,0.4);
        }}
        .leaflet-tooltip-top:before {{
            border-top-color: #28a745;
        }}
        .leaflet-tooltip-bottom:before {{
            border-bottom-color: #28a745;
        }}
        .leaflet-tooltip-left:before {{
            border-left-color: #28a745;
        }}
        .leaflet-tooltip-right:before {{
            border-right-color: #28a745;
        }}
    </style>
</head>
<body>
    <div id="map"></div>
    <!-- Left side buttons -->
    <button id="stats-btn" class="control-btn left" onclick="toggleStats()">📊 Stats</button>
    <button id="export-btn" class="control-btn left" onclick="exportMap()">📷 Export</button>
    <button id="wrapped-btn" class="control-btn left" onclick="showWrapped()">✨ Wrapped</button>

    <!-- Right side buttons -->
    <button id="heatmap-btn" class="control-btn right" onclick="toggleHeatmap()">🔥 Heatmap</button>
    <button id="airports-btn" class="control-btn right" onclick="toggleAirports()">✈️ Airports</button>
    <button id="altitude-btn" class="control-btn right" onclick="toggleAltitude()">⛰️ Altitude</button>
    <button id="aviation-btn" class="control-btn right" onclick="toggleAviation()" style="display: none;">🗺️ Aviation</button>
    <div id="year-filter" class="control-btn right">
        <select id="year-select" onchange="filterByYear()">
            <option value="all">📅 Years</option>
        </select>
    </div>

    <div id="stats-panel"></div>
    <div id="altitude-legend">
        <div class="legend-title">⛰️ Altitude</div>
        <div class="gradient-bar"></div>
        <div class="labels">
            <span id="legend-min">0 ft</span>
            <span id="legend-max">10,000 ft</span>
        </div>
    </div>
    <div id="loading">Loading data...</div>

    <!-- Wrapped Card Modal -->
    <div id="wrapped-modal" onclick="closeWrapped(event)">
        <div id="wrapped-container" onclick="event.stopPropagation()">
            <div id="wrapped-card">
                <button class="close-btn" onclick="closeWrapped()">×</button>
                <h1>✨ Your Year in Flight</h1>
                <div class="year" id="wrapped-year">2025</div>
                <div id="wrapped-card-content">
                    <div class="stat-grid" id="wrapped-stats"></div>
                    <div class="fun-facts" id="wrapped-fun-facts"></div>
                    <div class="top-airports" id="wrapped-top-airports"></div>
                    <div class="airports-grid" id="wrapped-airports-grid"></div>
                </div>
                <button class="export-wrapped-btn" onclick="exportWrappedCard()">📷 Export Wrapped Card</button>
            </div>
            <div id="wrapped-map-container">
                <img id="wrapped-map-snapshot" alt="Flight map">
            </div>
        </div>
    </div>

    <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
    <script src="https://unpkg.com/leaflet.heat@0.2.0/dist/leaflet-heat.js"></script>
    <script src="https://unpkg.com/leaflet.markercluster@1.5.3/dist/leaflet.markercluster.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/dom-to-image@2.6.0/dist/dom-to-image.min.js"></script>

    <script>
        // Configuration
        const CENTER = [{center_lat}, {center_lon}];
        const BOUNDS = [[{min_lat}, {min_lon}], [{max_lat}, {max_lon}]];
        const STADIA_API_KEY = '{STADIA_API_KEY}';
        const OPENAIP_API_KEY = '{OPENAIP_API_KEY}';
        const DATA_DIR = '{data_dir_name}';

        // Convert decimal degrees to degrees, minutes, seconds
        function ddToDms(dd, isLat) {{
            const direction = dd >= 0 ? (isLat ? 'N' : 'E') : (isLat ? 'S' : 'W');
            dd = Math.abs(dd);
            const degrees = Math.floor(dd);
            const minutes = Math.floor((dd - degrees) * 60);
            const seconds = ((dd - degrees) * 60 - minutes) * 60;
            return degrees + "°" + minutes + "'" + seconds.toFixed(1) + '"' + direction;
        }}

        // Initialize map
        var map = L.map('map', {{
            center: CENTER,
            zoom: 10,
            zoomSnap: 0.25,
            zoomDelta: 0.25,
            wheelPxPerZoomLevel: 120,  // 2 scrolls = 1 zoom level (matches button steps)
            preferCanvas: true  // Use canvas for better performance
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

        // Create canvas renderer for better performance during pan
        var canvasRenderer = L.canvas({{ padding: 0.5 }});

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

                // Create cluster dot with count
                var count = markers.length;
                var html = '<div class="airport-cluster-dot">' + count + '</div>';

                return L.divIcon({{
                    html: html,
                    iconSize: [20, 20],
                    iconAnchor: [10, 10],
                    popupAnchor: [0, -10],
                    className: 'airport-cluster-marker'
                }});
            }}
        }});
        var currentResolution = null;
        var loadedData = {{}};
        var currentData = null;  // Store current loaded data for redrawing
        var fullStats = null;  // Store original full statistics
        var altitudeRange = {{ min: 0, max: 10000 }};  // Store altitude range for legend

        // Layer visibility state
        var heatmapVisible = true;
        var altitudeVisible = false;
        var airportsVisible = true;
        var aviationVisible = false;

        // Track selection state
        var selectedPathIds = new Set();  // Set of selected path IDs
        var pathSegments = {{}};  // Map of path_id to array of polyline objects
        var pathToAirports = {{}};  // Map of path_id to {{start: name, end: name}}
        var airportToPaths = {{}};  // Map of airport name to array of path IDs
        var airportMarkers = {{}};  // Map of airport name to marker object

        // OpenAIP layer (if API key is provided)
        // Note: As of May 2023, OpenAIP consolidated all layers into one "openaip" layer
        var openaipLayers = {{}};
        if (OPENAIP_API_KEY) {{
            openaipLayers['Aviation Data'] = L.tileLayer(
                'https://{{s}}.api.tiles.openaip.net/api/data/openaip/{{z}}/{{x}}/{{y}}.png?apiKey=' + OPENAIP_API_KEY,
                {{
                    attribution: '&copy; <a href="https://www.openaip.net">OpenAIP</a>',
                    maxZoom: 18,
                    minZoom: 7,
                    subdomains: ['a', 'b', 'c']
                }}
            );
        }}

        // Add cluster click handler to show popup with ICAO codes
        airportLayer.on('clusterclick', function(cluster) {{
            var markers = cluster.layer.getAllChildMarkers();
            var icaoCodes = markers.map(function(marker) {{
                return marker.options.icao || 'APT';
            }}).filter(function(value, index, self) {{
                return self.indexOf(value) === index;
            }}).sort();

            var popupContent = '<div style="font-size: 12px;"><b>' + markers.length + ' Airports</b><br>' +
                             '<div style="max-height: 150px; overflow-y: auto; margin-top: 5px;">' +
                             icaoCodes.join(', ') + '</div></div>';
            cluster.layer.bindPopup(popupContent).openPopup();
        }});

        // Add airports layer by default
        airportLayer.addTo(map);

        // Set initial button states
        document.getElementById('altitude-btn').style.opacity = '0.5';  // Altitude starts hidden
        document.getElementById('aviation-btn').style.opacity = '0.5';  // Aviation starts hidden

        // Show aviation button if API key is available
        if (OPENAIP_API_KEY) {{
            document.getElementById('aviation-btn').style.display = 'block';
        }}

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

            currentData = data;  // Store for redrawing

            // Update heatmap - only add if visible
            if (heatmapLayer) {{
                map.removeLayer(heatmapLayer);
            }}

            heatmapLayer = L.heatLayer(data.coordinates, {{
                radius: 10,
                blur: 15,
                minOpacity: 0.25,
                maxOpacity: 0.6,
                max: 1.0,  // Maximum point intensity for better performance
                gradient: {{
                    0.0: 'blue',
                    0.3: 'cyan',
                    0.5: 'lime',
                    0.7: 'yellow',
                    1.0: 'red'
                }}
            }});

            // Make heatmap non-interactive so clicks pass through to paths
            if (heatmapLayer._canvas) {{
                heatmapLayer._canvas.style.pointerEvents = 'none';
            }}

            // Only add to map if heatmap is visible
            if (heatmapVisible) {{
                heatmapLayer.addTo(map);
            }}

            // Build path-to-airport relationships from path_info
            pathToAirports = {{}};
            airportToPaths = {{}};

            if (data.path_info) {{
                data.path_info.forEach(function(pathInfo) {{
                    var pathId = pathInfo.id;

                    // Store path-to-airport mapping
                    pathToAirports[pathId] = {{
                        start: pathInfo.start_airport,
                        end: pathInfo.end_airport
                    }};

                    // Build reverse mapping: airport to paths
                    if (pathInfo.start_airport) {{
                        if (!airportToPaths[pathInfo.start_airport]) {{
                            airportToPaths[pathInfo.start_airport] = [];
                        }}
                        airportToPaths[pathInfo.start_airport].push(pathId);
                    }}
                    if (pathInfo.end_airport) {{
                        if (!airportToPaths[pathInfo.end_airport]) {{
                            airportToPaths[pathInfo.end_airport] = [];
                        }}
                        airportToPaths[pathInfo.end_airport].push(pathId);
                    }}
                }});
            }}

            // Calculate altitude range from all segments
            if (data.path_segments && data.path_segments.length > 0) {{
                var altitudes = data.path_segments.map(function(s) {{ return s.altitude_ft; }});
                altitudeRange.min = Math.min(...altitudes);
                altitudeRange.max = Math.max(...altitudes);
            }}

            // Create altitude layer paths (this will also update the legend)
            redrawAltitudePaths();

            console.log('Updated to ' + resolution + ' resolution');
        }}

        function redrawAltitudePaths() {{
            if (!currentData) return;

            // Clear altitude layer and path references
            altitudeLayer.clearLayers();
            pathSegments = {{}};

            // Calculate altitude range for color scaling
            var colorMinAlt, colorMaxAlt;
            if (selectedPathIds.size > 0) {{
                // Use selected paths' altitude range
                var selectedSegments = currentData.path_segments.filter(function(segment) {{
                    return selectedPathIds.has(segment.path_id);
                }});
                if (selectedSegments.length > 0) {{
                    var altitudes = selectedSegments.map(function(s) {{ return s.altitude_ft; }});
                    colorMinAlt = Math.min(...altitudes);
                    colorMaxAlt = Math.max(...altitudes);
                }} else {{
                    colorMinAlt = altitudeRange.min;
                    colorMaxAlt = altitudeRange.max;
                }}
            }} else {{
                // Use full altitude range
                colorMinAlt = altitudeRange.min;
                colorMaxAlt = altitudeRange.max;
            }}

            // Create path segments with interactivity and rescaled colors
            currentData.path_segments.forEach(function(segment) {{
                var pathId = segment.path_id;

                // Filter by year if selected
                if (selectedYear !== 'all') {{
                    var pathInfo = currentData.path_info.find(function(p) {{ return p.id === pathId; }});
                    if (pathInfo && pathInfo.year && pathInfo.year.toString() !== selectedYear) {{
                        return;  // Skip this segment
                    }}
                }}
                var isSelected = selectedPathIds.has(pathId);

                // Recalculate color based on current altitude range
                var color = getColorForAltitude(segment.altitude_ft, colorMinAlt, colorMaxAlt);

                var polyline = L.polyline(segment.coords, {{
                    color: color,
                    weight: isSelected ? 6 : 4,
                    opacity: isSelected ? 1.0 : (selectedPathIds.size > 0 ? 0.1 : 0.85),
                    renderer: canvasRenderer
                }}).bindPopup('Altitude: ' + segment.altitude_ft + ' ft (' + segment.altitude_m + ' m)')
                  .addTo(altitudeLayer);

                // Make path clickable
                polyline.on('click', function(e) {{
                    L.DomEvent.stopPropagation(e);
                    togglePathSelection(pathId);
                }});

                // Store reference to polyline by path_id
                if (!pathSegments[pathId]) {{
                    pathSegments[pathId] = [];
                }}
                pathSegments[pathId].push(polyline);
            }});

            // Update legend to show current altitude range
            updateAltitudeLegend(colorMinAlt, colorMaxAlt);

            // Update airport marker opacity based on selection
            updateAirportOpacity();

            // Update statistics panel based on selection
            updateStatsForSelection();
        }}

        function getColorForAltitude(altitude, minAlt, maxAlt) {{
            // Normalize altitude to 0-1 range
            var normalized = (altitude - minAlt) / Math.max(maxAlt - minAlt, 1);
            normalized = Math.max(0, Math.min(1, normalized)); // Clamp to 0-1

            // Color gradient: light blue → cyan → green → yellow → orange → light red
            // Lighter terminal colors for better visibility on dark background
            var r, g, b;

            if (normalized < 0.2) {{
                // Light Blue to Cyan (0.0 - 0.2)
                var t = normalized / 0.2;
                r = Math.round(80 * (1 - t)); // Start at 80, go to 0
                g = Math.round(160 + 95 * t); // 160 to 255
                b = 255;
            }} else if (normalized < 0.4) {{
                // Cyan to Green (0.2 - 0.4)
                var t = (normalized - 0.2) / 0.2;
                r = 0;
                g = 255;
                b = Math.round(255 * (1 - t));
            }} else if (normalized < 0.6) {{
                // Green to Yellow (0.4 - 0.6)
                var t = (normalized - 0.4) / 0.2;
                r = Math.round(255 * t);
                g = 255;
                b = 0;
            }} else if (normalized < 0.8) {{
                // Yellow to Orange (0.6 - 0.8)
                var t = (normalized - 0.6) / 0.2;
                r = 255;
                g = Math.round(255 * (1 - t * 0.35)); // ~165 at t=1
                b = 0;
            }} else {{
                // Orange to Light Red (0.8 - 1.0)
                var t = (normalized - 0.8) / 0.2;
                r = 255;
                g = Math.round(165 * (1 - t * 0.6)); // End at ~66 instead of 0
                b = Math.round(66 * t); // Add some blue component for lighter red
            }}

            return 'rgb(' + r + ',' + g + ',' + b + ')';
        }}

        function updateAirportOpacity() {{
            if (selectedPathIds.size === 0) {{
                // No selection - restore all airports to full opacity
                Object.keys(airportMarkers).forEach(function(airportName) {{
                    var marker = airportMarkers[airportName];
                    marker.setOpacity(1.0);
                }});
                return;
            }}

            // Collect airports involved in selected paths
            var selectedAirports = new Set();
            selectedPathIds.forEach(function(pathId) {{
                var airports = pathToAirports[pathId];
                if (airports) {{
                    if (airports.start) selectedAirports.add(airports.start);
                    if (airports.end) selectedAirports.add(airports.end);
                }}
            }});

            // Update opacity for all airport markers
            Object.keys(airportMarkers).forEach(function(airportName) {{
                var marker = airportMarkers[airportName];
                if (selectedAirports.has(airportName)) {{
                    marker.setOpacity(1.0);  // Full opacity for selected airports
                }} else {{
                    marker.setOpacity(0.3);  // Dim non-selected airports
                }}
            }});
        }}

        // Global variable for selected year
        var selectedYear = 'all';

        // Function to filter data by year
        function filterByYear() {{
            const yearSelect = document.getElementById('year-select');
            selectedYear = yearSelect.value;

            // Clear current paths and reload
            altitudeLayer.clearLayers();
            pathSegments = {{}};
            selectedPathIds.clear();

            // Reload current resolution data to apply filter
            currentResolution = null;  // Force reload
            updateLayers();
        }}

        // Load airports once
        (async function() {{
            const airports = await loadAirports();
            const metadata = await loadMetadata();

            // Populate year filter dropdown
            if (metadata && metadata.available_years) {{
                const yearSelect = document.getElementById('year-select');
                metadata.available_years.forEach(function(year) {{
                    const option = document.createElement('option');
                    option.value = year;
                    option.textContent = '📅 ' + year;
                    yearSelect.appendChild(option);
                }});
            }}

            // Add airport markers
            airports.forEach(function(airport) {{
                const icaoMatch = airport.name ? airport.name.match(/\\b([A-Z]{{4}})\\b/) : null;
                const icao = icaoMatch ? icaoMatch[1] : 'APT';

                const markerHtml = '<div class="airport-marker-container"><div class="airport-marker"></div><div class="airport-label">' + icao + '</div></div>';

                const latDms = ddToDms(airport.lat, true);
                const lonDms = ddToDms(airport.lon, false);
                const googleMapsLink = `https://www.google.com/maps?q=${{airport.lat}},${{airport.lon}}`;

                const popup = `
                <div style="font-size: 12px; min-width: 150px;">
                    <b>🛫 ${{airport.name || 'Unknown'}}</b><br>
                    <a href="${{googleMapsLink}}" target="_blank" style="color: #4285f4; text-decoration: none;">${{latDms}} ${{lonDms}}</a><br>
                    <b>Flights:</b> ${{airport.flight_count}}
                </div>`;

                var marker = L.marker([airport.lat, airport.lon], {{
                    icon: L.divIcon({{
                        html: markerHtml,
                        iconSize: [12, 12],
                        iconAnchor: [6, 6],
                        popupAnchor: [2, -6],
                        className: ''
                    }}),
                    icao: icao  // Store ICAO for cluster icon function
                }})
                .bindPopup(popup, {{ autoPanPadding: [50, 50] }});

                // Add click handler to select paths connected to this airport
                marker.on('click', function(e) {{
                    selectPathsByAirport(airport.name);
                }});

                marker.addTo(airportLayer);

                // Store marker reference for opacity control
                airportMarkers[airport.name] = marker;
            }});

            // Load and store full statistics
            if (metadata && metadata.stats) {{
                fullStats = metadata.stats;
                updateStatsPanel(fullStats, false);
            }}

            // Initial data load
            updateLayers();
        }})();

        // Update layers on zoom change only
        map.on('zoomend', updateLayers);

        // Clear selection when clicking on the map background
        map.on('click', function(e) {{
            if (selectedPathIds.size > 0) {{
                clearSelection();
            }}
        }});

        // Path and airport selection functions
        function togglePathSelection(pathId) {{
            if (selectedPathIds.has(pathId)) {{
                selectedPathIds.delete(pathId);
            }} else {{
                selectedPathIds.add(pathId);
            }}
            redrawAltitudePaths();
        }}

        function selectPathsByAirport(airportName) {{
            var pathIds = airportToPaths[airportName] || [];
            pathIds.forEach(function(pathId) {{
                selectedPathIds.add(pathId);
            }});
            redrawAltitudePaths();
        }}

        function clearSelection() {{
            selectedPathIds.clear();
            redrawAltitudePaths();
        }}

        function updateAltitudeLegend(minAlt, maxAlt) {{
            var minFt = Math.round(minAlt);
            var maxFt = Math.round(maxAlt);
            var minM = Math.round(minAlt * 0.3048);
            var maxM = Math.round(maxAlt * 0.3048);

            document.getElementById('legend-min').textContent = minFt.toLocaleString() + ' ft (' + minM.toLocaleString() + ' m)';
            document.getElementById('legend-max').textContent = maxFt.toLocaleString() + ' ft (' + maxM.toLocaleString() + ' m)';
        }}

        function updateStatsForSelection() {{
            if (selectedPathIds.size === 0) {{
                // No selection - show full stats
                if (fullStats) {{
                    updateStatsPanel(fullStats, false);
                }}
                return;
            }}

            // Calculate stats for selected paths only
            var selectedSegments = currentData.path_segments.filter(function(segment) {{
                return selectedPathIds.has(segment.path_id);
            }});

            if (selectedSegments.length === 0) return;

            // Calculate statistics from selected segments
            var selectedPathInfos = currentData.path_info.filter(function(pathInfo) {{
                return selectedPathIds.has(pathInfo.id);
            }});

            // Collect unique airports from selected paths
            var selectedAirports = new Set();
            selectedPathInfos.forEach(function(pathInfo) {{
                if (pathInfo.start_airport) selectedAirports.add(pathInfo.start_airport);
                if (pathInfo.end_airport) selectedAirports.add(pathInfo.end_airport);
            }});

            // Calculate distance (approximate using segment coordinates)
            var totalDistanceKm = 0;
            selectedSegments.forEach(function(segment) {{
                var coords = segment.coords;
                if (coords && coords.length === 2) {{
                    var lat1 = coords[0][0] * Math.PI / 180;
                    var lon1 = coords[0][1] * Math.PI / 180;
                    var lat2 = coords[1][0] * Math.PI / 180;
                    var lon2 = coords[1][1] * Math.PI / 180;

                    var dlat = lat2 - lat1;
                    var dlon = lon2 - lon1;
                    var a = Math.sin(dlat/2) * Math.sin(dlat/2) +
                            Math.cos(lat1) * Math.cos(lat2) *
                            Math.sin(dlon/2) * Math.sin(dlon/2);
                    var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
                    totalDistanceKm += 6371 * c;  // Earth radius in km
                }}
            }});

            // Get altitude range from selected segments
            var altitudes = selectedSegments.map(function(s) {{ return s.altitude_m; }});
            var minAltitudeM = Math.min(...altitudes);
            var maxAltitudeM = Math.max(...altitudes);

            // Build selected stats object
            var selectedStats = {{
                total_points: selectedSegments.length * 2,  // Each segment has 2 points
                num_paths: selectedPathIds.size,
                num_airports: selectedAirports.size,
                airport_names: Array.from(selectedAirports).sort(),
                total_distance_nm: totalDistanceKm * 0.539957,
                max_altitude_ft: maxAltitudeM * 3.28084,
                min_altitude_ft: minAltitudeM * 3.28084
            }};

            updateStatsPanel(selectedStats, true);
        }}

        // Statistics panel
        function updateStatsPanel(stats, isSelection) {{
            let html = '';

            // Add indicator if showing selected paths only
            if (isSelection) {{
                html += '<p style="margin:0 0 10px 0; font-weight:bold; font-size:15px;">📊 Selected Paths Statistics</p>';
                html += '<div style="background-color: #3a5a7a; padding: 4px 8px; margin-bottom: 8px; border-radius: 3px; font-size: 11px; color: #a0c0e0;">Showing stats for ' + stats.num_paths + ' selected path(s)</div>';
            }} else {{
                html += '<p style="margin:0 0 10px 0; font-weight:bold; font-size:15px;">📊 Flight Statistics</p>';
            }}

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

            // Distance with km conversion
            var distanceKm = (stats.total_distance_nm * 1.852).toFixed(1);
            html += '<div style="margin-bottom: 8px;"><strong>Distance:</strong> ' + stats.total_distance_nm.toFixed(1) + ' nm (' + distanceKm + ' km)</div>';

            if (stats.total_flight_time_str) {{
                html += '<div style="margin-bottom: 8px;"><strong>Total Flight Time:</strong> ' + stats.total_flight_time_str + '</div>';
            }}

            if (stats.max_altitude_ft) {{
                // Altitude with meter conversion
                var maxAltitudeM = Math.round(stats.max_altitude_ft * 0.3048);
                html += '<div style="margin-bottom: 8px;"><strong>Max Altitude:</strong> ' + Math.round(stats.max_altitude_ft) + ' ft (' + maxAltitudeM + ' m)</div>';

                // Elevation gain with meter conversion (only show for full stats)
                if (!isSelection && stats.total_altitude_gain_ft) {{
                    var elevationGainM = Math.round(stats.total_altitude_gain_ft * 0.3048);
                    html += '<div style="margin-bottom: 8px;"><strong>Elevation Gain:</strong> ' + Math.round(stats.total_altitude_gain_ft) + ' ft (' + elevationGainM + ' m)</div>';
                }}
            }}

            document.getElementById('stats-panel').innerHTML = html;
        }}

        function toggleStats() {{
            const panel = document.getElementById('stats-panel');
            panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
        }}

        function toggleHeatmap() {{
            if (heatmapVisible) {{
                if (heatmapLayer) {{
                    map.removeLayer(heatmapLayer);
                }}
                heatmapVisible = false;
                document.getElementById('heatmap-btn').style.opacity = '0.5';
            }} else {{
                if (heatmapLayer) {{
                    map.addLayer(heatmapLayer);
                    // Ensure heatmap is non-interactive after adding to map
                    if (heatmapLayer._canvas) {{
                        heatmapLayer._canvas.style.pointerEvents = 'none';
                    }}
                }}
                heatmapVisible = true;
                document.getElementById('heatmap-btn').style.opacity = '1.0';
            }}
        }}

        function toggleAltitude() {{
            if (altitudeVisible) {{
                map.removeLayer(altitudeLayer);
                altitudeVisible = false;
                document.getElementById('altitude-btn').style.opacity = '0.5';
                document.getElementById('altitude-legend').style.display = 'none';
            }} else {{
                map.addLayer(altitudeLayer);
                altitudeVisible = true;
                document.getElementById('altitude-btn').style.opacity = '1.0';
                document.getElementById('altitude-legend').style.display = 'block';
            }}
        }}

        function toggleAirports() {{
            if (airportsVisible) {{
                map.removeLayer(airportLayer);
                airportsVisible = false;
                document.getElementById('airports-btn').style.opacity = '0.5';
            }} else {{
                map.addLayer(airportLayer);
                airportsVisible = true;
                document.getElementById('airports-btn').style.opacity = '1.0';
            }}
        }}

        function toggleAviation() {{
            if (OPENAIP_API_KEY && openaipLayers['Aviation Data']) {{
                if (aviationVisible) {{
                    map.removeLayer(openaipLayers['Aviation Data']);
                    aviationVisible = false;
                    document.getElementById('aviation-btn').style.opacity = '0.5';
                }} else {{
                    map.addLayer(openaipLayers['Aviation Data']);
                    aviationVisible = true;
                    document.getElementById('aviation-btn').style.opacity = '1.0';
                }}
            }}
        }}

        function exportMap() {{
            const btn = document.getElementById('export-btn');
            btn.disabled = true;
            btn.textContent = '⏳ Exporting...';

            const mapContainer = document.getElementById('map');
            const controls = [
                document.querySelector('.leaflet-control-zoom'),
                document.getElementById('stats-btn'),
                document.getElementById('export-btn'),
                document.getElementById('wrapped-btn'),
                document.getElementById('year-filter'),
                document.getElementById('heatmap-btn'),
                document.getElementById('altitude-btn'),
                document.getElementById('airports-btn'),
                document.getElementById('aviation-btn'),
                document.getElementById('stats-panel'),
                document.getElementById('altitude-legend'),
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

        // Wrapped card functionality
        function showWrapped() {{
            // Determine which year to show
            const year = selectedYear !== 'all' ? selectedYear : (fullStats.available_years ? fullStats.available_years[fullStats.available_years.length - 1] : new Date().getFullYear());

            // Calculate year-specific stats
            const yearStats = calculateYearStats(year);

            // Update card content
            document.getElementById('wrapped-year').textContent = year;

            // Build stats grid
            const statsHtml = `
                <div class="stat-card">
                    <div class="stat-value">${{yearStats.total_flights}}</div>
                    <div class="stat-label">Flights</div>
                </div>
                <div class="stat-card">
                    <div class="stat-value">${{yearStats.total_distance_nm.toFixed(0)}}</div>
                    <div class="stat-label">Nautical Miles</div>
                </div>
                <div class="stat-card">
                    <div class="stat-value">${{yearStats.num_airports}}</div>
                    <div class="stat-label">Airports</div>
                </div>
                <div class="stat-card">
                    <div class="stat-value">${{yearStats.flight_time}}</div>
                    <div class="stat-label">Flight Time</div>
                </div>
            `;

            document.getElementById('wrapped-stats').innerHTML = statsHtml;

            // Build fun facts section
            const earthCircumferenceKm = 40075;
            const moonDistanceKm = 384400;
            const timesAroundEarth = (yearStats.total_distance_nm * 1.852 / earthCircumferenceKm).toFixed(1);
            const percentToMoon = (yearStats.total_distance_nm * 1.852 / moonDistanceKm * 100).toFixed(1);

            const funFactsHtml = `
                <div class="fun-facts-title">🌍 Fun Facts</div>
                <div class="fun-fact">You flew <strong>${{timesAroundEarth}}x</strong> around the Earth</div>
                <div class="fun-fact">That's <strong>${{percentToMoon}}%</strong> of the distance to the Moon</div>
                <div class="fun-fact">Average flight: <strong>${{(yearStats.total_distance_nm / yearStats.total_flights).toFixed(0)}} nm</strong></div>
            `;
            document.getElementById('wrapped-fun-facts').innerHTML = funFactsHtml;

            // Build top airports section if we have airport data
            if (fullStats && fullStats.airport_names && fullStats.airport_names.length > 0) {{
                // Load airport data to get flight counts
                loadAirports().then(function(airports) {{
                    // Sort airports by flight count
                    const sortedAirports = airports.sort((a, b) => b.flight_count - a.flight_count);
                    const top3 = sortedAirports.slice(0, 3);

                    let topAirportsHtml = '<div class="top-airports-title">✈️ Top Airports</div>';
                    top3.forEach(function(airport) {{
                        topAirportsHtml += `
                            <div class="top-airport">
                                <div class="top-airport-name">${{airport.name}}</div>
                                <div class="top-airport-count">${{airport.flight_count}} flights</div>
                            </div>
                        `;
                    }});
                    document.getElementById('wrapped-top-airports').innerHTML = topAirportsHtml;
                }});

                // Build all airports badge grid
                let airportBadgesHtml = '<div class="airports-grid-title">🗺️ All Airports</div><div class="airport-badges">';
                fullStats.airport_names.forEach(function(airportName) {{
                    airportBadgesHtml += `<div class="airport-badge">${{airportName}}</div>`;
                }});
                airportBadgesHtml += '</div>';
                document.getElementById('wrapped-airports-grid').innerHTML = airportBadgesHtml;
            }}

            // Store current map view to restore later
            const originalCenter = map.getCenter();
            const originalZoom = map.getZoom();

            // Zoom to fit all data
            map.fitBounds(BOUNDS, {{ padding: [30, 30] }});

            // Force map to invalidate and recalculate size
            setTimeout(function() {{
                map.invalidateSize();

                // Calculate actual pixel dimensions of the bounds on the map after fitBounds completes
                const bounds = map.getBounds();
                const northWest = map.latLngToContainerPoint(bounds.getNorthWest());
                const southEast = map.latLngToContainerPoint(bounds.getSouthEast());
                const mapWidth = Math.abs(southEast.x - northWest.x);
                const mapHeight = Math.abs(southEast.y - northWest.y);
                const actualAspectRatio = mapWidth / mapHeight;

                // Set the aspect ratio of the wrapped map container
                const wrappedMapContainer = document.getElementById('wrapped-map-container');
                wrappedMapContainer.style.aspectRatio = actualAspectRatio.toString();
            }}, 100);

            // Capture map snapshot after zoom completes
            const mapContainer = document.getElementById('map');
            const controls = [
                document.querySelector('.leaflet-control-zoom'),
                document.getElementById('stats-btn'),
                document.getElementById('export-btn'),
                document.getElementById('wrapped-btn'),
                document.getElementById('heatmap-btn'),
                document.getElementById('airports-btn'),
                document.getElementById('altitude-btn'),
                document.getElementById('aviation-btn'),
                document.getElementById('year-filter'),
                document.getElementById('stats-panel'),
                document.getElementById('altitude-legend'),
                document.getElementById('loading')
            ];

            // Hide all controls temporarily
            const displayStates = controls.map(el => el ? el.style.display : null);
            controls.forEach(el => {{ if (el) el.style.display = 'none'; }});

            // Wait for map to finish zooming and rendering tiles, then capture
            setTimeout(function() {{
                domtoimage.toJpeg(mapContainer, {{
                    width: mapContainer.offsetWidth,
                    height: mapContainer.offsetHeight,
                    bgcolor: '#1a1a1a',
                    quality: 0.9
                }}).then(function(dataUrl) {{
                    // Restore controls
                    controls.forEach((el, i) => {{ if (el) el.style.display = displayStates[i] || ''; }});

                    // Restore original map view
                    map.setView(originalCenter, originalZoom);

                    // Set map snapshot
                    document.getElementById('wrapped-map-snapshot').src = dataUrl;

                    // Show modal
                    document.getElementById('wrapped-modal').style.display = 'flex';
                }}).catch(function(error) {{
                    // Restore controls on error
                    controls.forEach((el, i) => {{ if (el) el.style.display = displayStates[i] || ''; }});

                    // Restore original map view
                    map.setView(originalCenter, originalZoom);

                    console.error('Map capture failed:', error);

                    // Show modal anyway without map
                    document.getElementById('wrapped-modal').style.display = 'flex';
                }});
            }}, 1500);
        }}

        function closeWrapped(event) {{
            if (!event || event.target.id === 'wrapped-modal') {{
                document.getElementById('wrapped-modal').style.display = 'none';
            }}
        }}

        function calculateYearStats(year) {{
            // If we don't have full stats, return empty
            if (!fullStats) {{
                return {{
                    total_flights: 0,
                    total_distance_nm: 0,
                    num_airports: 0,
                    flight_time: '0h 0m'
                }};
            }}

            // Check if the requested year is in our available years
            if (fullStats.available_years && fullStats.available_years.length > 0) {{
                const yearStr = year.toString();

                // If there's only one year and it matches, or if we're showing all years,
                // use the full stats directly (most accurate)
                if (fullStats.available_years.length === 1 &&
                    fullStats.available_years[0].toString() === yearStr) {{
                    return {{
                        total_flights: fullStats.num_paths,
                        total_distance_nm: fullStats.total_distance_nm,
                        num_airports: fullStats.num_airports,
                        flight_time: fullStats.total_flight_time_str || '---'
                    }};
                }}
            }}

            // For multiple years, we would need to filter by year
            // This is a placeholder for future multi-year support
            // Currently all data is from 2025, so just return full stats
            return {{
                total_flights: fullStats.num_paths,
                total_distance_nm: fullStats.total_distance_nm,
                num_airports: fullStats.num_airports,
                flight_time: fullStats.total_flight_time_str || '---'
            }};
        }}

        function exportWrappedCard() {{
            const container = document.getElementById('wrapped-container');
            const closeBtn = document.querySelector('#wrapped-card .close-btn');
            const exportBtn = document.querySelector('#wrapped-card .export-wrapped-btn');

            // Hide buttons during export
            closeBtn.style.display = 'none';
            exportBtn.style.display = 'block';
            exportBtn.style.opacity = '0';
            exportBtn.style.pointerEvents = 'none';

            // Clone the container to avoid modifying the original
            const containerClone = container.cloneNode(true);

            // Remove buttons from clone
            const clonedCloseBtn = containerClone.querySelector('#wrapped-card .close-btn');
            const clonedExportBtn = containerClone.querySelector('#wrapped-card .export-wrapped-btn');
            if (clonedCloseBtn) clonedCloseBtn.remove();
            if (clonedExportBtn) clonedExportBtn.remove();

            // Create temporary wrapper for export with proper styling
            const wrapper = document.createElement('div');
            wrapper.style.cssText = `
                position: fixed;
                top: 0;
                left: 0;
                background: linear-gradient(135deg, rgba(10, 10, 20, 0.97) 0%, rgba(15, 20, 35, 0.97) 100%);
                padding: 60px;
                border-radius: 20px;
                width: auto;
                height: auto;
                max-width: none;
                max-height: none;
                z-index: 99999;
                visibility: hidden;
            `;

            wrapper.appendChild(containerClone);
            document.body.appendChild(wrapper);

            // Force a layout calculation
            wrapper.offsetHeight;

            // Small delay to ensure wrapper is rendered
            setTimeout(function() {{
                // Make wrapper visible for capture
                wrapper.style.visibility = 'visible';

                // Capture the wrapper
                domtoimage.toJpeg(wrapper, {{
                    width: wrapper.offsetWidth * 2,
                    height: wrapper.offsetHeight * 2,
                    quality: 0.95,
                    style: {{
                        transform: 'scale(2)',
                        transformOrigin: 'top left',
                        visibility: 'visible'
                    }}
                }}).then(function(dataUrl) {{
                    // Remove wrapper
                    document.body.removeChild(wrapper);

                    // Restore buttons
                    closeBtn.style.display = 'block';
                    exportBtn.style.opacity = '1';
                    exportBtn.style.pointerEvents = 'auto';

                    // Download
                    const link = document.createElement('a');
                    const year = document.getElementById('wrapped-year').textContent;
                    link.download = 'flight_wrapped_' + year + '.jpg';
                    link.href = dataUrl;
                    link.click();
                }}).catch(function(error) {{
                    // Remove wrapper on error
                    if (document.body.contains(wrapper)) {{
                        document.body.removeChild(wrapper);
                    }}

                    // Restore buttons
                    closeBtn.style.display = 'block';
                    exportBtn.style.opacity = '1';
                    exportBtn.style.pointerEvents = 'auto';

                    alert('Export failed: ' + error.message);
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
    docker run -v $(pwd):/data kml-heatmap *.kml && \
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
            DEBUG = True
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

    # Ensure output directory exists
    os.makedirs(output_dir, exist_ok=True)

    # Create paths for output files
    output_file = os.path.join(output_dir, "index.html")
    data_dir = os.path.join(output_dir, "data")

    # Create progressive heatmap (default)
    success = create_progressive_heatmap(kml_files, output_file, data_dir)

    if not success:
        sys.exit(1)


if __name__ == "__main__":
    main()
