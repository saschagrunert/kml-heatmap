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
import urllib.request
import urllib.error
from html.parser import HTMLParser

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
        # For circular paths where start == end, use haversine distance from start
        if line_start[:2] == line_end[:2]:
            return haversine_distance(point[0], point[1], line_start[0], line_start[1])

        # Using simple Euclidean approximation for small distances
        x0, y0 = point[0], point[1]
        x1, y1 = line_start[0], line_start[1]
        x2, y2 = line_end[0], line_end[1]

        num = abs((y2 - y1) * x0 - (x2 - x1) * y0 + x2 * y1 - y2 * x1)
        den = sqrt((y2 - y1)**2 + (x2 - x1)**2)

        if den == 0:
            # Shouldn't happen if we checked line_start == line_end above, but safety fallback
            return haversine_distance(point[0], point[1], line_start[0], line_start[1])
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


class AircraftDataParser(HTMLParser):
    """HTML parser to extract aircraft model from airport-data.com"""
    def __init__(self):
        super().__init__()
        self.model = None
        self.in_title = False

    def handle_starttag(self, tag, attrs):
        if tag == 'title':
            self.in_title = True

    def handle_data(self, data):
        if self.in_title and 'Aircraft Data' in data:
            # Extract model from title like "Aircraft Data D-EAGJ, Diamond DA-20A-1 Katana C/N 10115..."
            match = re.search(r', ([^,]+) C/N', data)
            if match:
                model = match.group(1).strip()
                # Remove leading year (e.g., "1978 Cessna 172N" -> "Cessna 172N")
                model = re.sub(r'^\d{4}\s+', '', model)
                self.model = model

    def handle_endtag(self, tag):
        if tag == 'title':
            self.in_title = False


def lookup_aircraft_model(registration, cache_file='aircraft_cache.json'):
    """
    Look up aircraft model from airport-data.com

    Args:
        registration: Aircraft registration (e.g., 'D-EAGJ')
        cache_file: Path to JSON cache file

    Returns:
        Full aircraft model name or None if not found
    """
    # Load cache
    cache = {}
    if os.path.exists(cache_file):
        try:
            with open(cache_file, 'r') as f:
                cache = json.load(f)
        except:
            pass

    # Check cache
    if registration in cache:
        return cache[registration]

    # Fetch from airport-data.com
    try:
        url = f'https://airport-data.com/aircraft/{registration}.html'
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})

        with urllib.request.urlopen(req, timeout=10) as response:
            html = response.read().decode('utf-8')

        parser = AircraftDataParser()
        parser.feed(html)

        if parser.model:
            # Update cache
            cache[registration] = parser.model
            try:
                with open(cache_file, 'w') as f:
                    json.dump(cache, f, indent=2)
            except:
                pass

            return parser.model
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError):
        pass

    return None


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


def parse_aircraft_from_filename(filename):
    """
    Parse aircraft information from KML filename.

    Expected format: YYYYMMDD_HHMM_AIRPORT_REGISTRATION_TYPE.kml
    Example: 20250822_1013_EDAV_DEHYL_DA40.kml

    Args:
        filename: KML filename (without path)

    Returns:
        Dict with 'registration' and 'type' keys, or empty dict if parsing fails
    """
    import re

    # Remove .kml extension
    name = filename.replace('.kml', '')

    # Pattern: YYYYMMDD_HHMM_AIRPORT_REGISTRATION_TYPE
    # Registration is typically D-EXXX format (but stored as DEEXXX in filename)
    # Type is typically letters/numbers like DA20, DA40, C172, etc.
    parts = name.split('_')

    if len(parts) >= 5:
        # Format: DATE_TIME_AIRPORT_REGISTRATION_TYPE
        registration_raw = parts[3]
        aircraft_type = parts[4]

        # Format registration: if starts with D, insert hyphen after first char (D-EXXX)
        registration = registration_raw
        if registration_raw.startswith('D') and len(registration_raw) > 1:
            registration = registration_raw[0] + '-' + registration_raw[1:]

        return {
            'registration': registration,
            'type': aircraft_type
        }

    return {}


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
                aircraft_info = parse_aircraft_from_filename(Path(kml_file).name)
                metadata = {
                    'timestamp': timestamp,
                    'end_timestamp': end_timestamp,
                    'filename': Path(kml_file).name,
                    'start_point': current_path[0],  # [lat, lon, alt]
                    'airport_name': airport_name,
                    'year': year
                }
                # Add aircraft info if available
                if aircraft_info:
                    metadata['aircraft_registration'] = aircraft_info.get('registration')
                    metadata['aircraft_type'] = aircraft_info.get('type')
                path_metadata.append(metadata)

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

            # Get all <when> elements in order - they correspond 1:1 with gx:coord elements
            when_elems = []
            for placemark in placemarks:
                placemark_when = placemark.findall('.//kml:when', namespaces)
                if not placemark_when:
                    placemark_when = placemark.findall('.//when')
                if placemark_when and len(placemark_when) == len(gx_coords):
                    when_elems = placemark_when
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

                        # Get corresponding timestamp
                        timestamp_str = None
                        if idx < len(when_elems) and when_elems[idx].text:
                            timestamp_str = when_elems[idx].text.strip()

                        # Clamp negative altitudes to 0 (below sea level = 0ft)
                        if alt is not None and alt < 0:
                            alt = 0.0

                        coordinates.append([lat, lon])

                        if alt is not None:
                            # Store as [lat, lon, alt, timestamp]
                            if timestamp_str:
                                gx_path.append([lat, lon, alt, timestamp_str])
                            else:
                                gx_path.append([lat, lon, alt])
                    except ValueError:
                        if DEBUG:
                            print(f"  DEBUG: Failed to parse gx:coord: {coord_text}")
                        continue

            # Add gx:Track as a single path group
            if gx_path:
                path_groups.append(gx_path)
                gx_year = extract_year_from_timestamp(gx_timestamp)
                aircraft_info = parse_aircraft_from_filename(Path(kml_file).name)
                metadata = {
                    'timestamp': gx_timestamp,
                    'end_timestamp': gx_end_timestamp,
                    'filename': Path(kml_file).name,
                    'start_point': gx_path[0],  # [lat, lon, alt]
                    'airport_name': gx_airport_name,
                    'year': gx_year
                }
                # Add aircraft info if available
                if aircraft_info:
                    metadata['aircraft_registration'] = aircraft_info.get('registration')
                    metadata['aircraft_type'] = aircraft_info.get('type')
                path_metadata.append(metadata)

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
            # Handle both 3-element [lat,lon,alt] and 4-element [lat,lon,alt,timestamp]
            lat1, lon1, alt1 = path[i][0], path[i][1], path[i][2]
            lat2, lon2, alt2 = path[i + 1][0], path[i + 1][1], path[i + 1][2]

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

    # Calculate average groundspeed in knots (nautical miles per hour)
    if stats['total_flight_time_seconds'] > 0 and stats['total_distance_nm'] > 0:
        hours = stats['total_flight_time_seconds'] / 3600
        stats['average_groundspeed_knots'] = stats['total_distance_nm'] / hours
    else:
        stats['average_groundspeed_knots'] = 0

    # Max groundspeed will be added later from path segments
    stats['max_groundspeed_knots'] = 0

    # Collect unique aircraft from metadata
    if all_path_metadata:
        aircraft_registrations = set()
        aircraft_types = set()
        aircraft_list = []  # List of {registration, type, flights_count}
        aircraft_flights = {}  # Count unique flights (KML files) per aircraft registration

        for metadata in all_path_metadata:
            reg = metadata.get('aircraft_registration')
            atype = metadata.get('aircraft_type')
            filename = metadata.get('filename')

            if reg:
                aircraft_registrations.add(reg)
                if reg not in aircraft_flights:
                    aircraft_flights[reg] = {'type': atype, 'count': 0, 'files': set()}

                # Only count unique filenames (each file = one flight)
                if filename and filename not in aircraft_flights[reg]['files']:
                    aircraft_flights[reg]['files'].add(filename)
                    aircraft_flights[reg]['count'] += 1

            if atype:
                aircraft_types.add(atype)

        # Create sorted aircraft list by flight count with full model lookup
        print("✈️  Looking up aircraft model information...")
        for reg, info in sorted(aircraft_flights.items(), key=lambda x: x[1]['count'], reverse=True):
            # Try to lookup full aircraft model
            full_model = lookup_aircraft_model(reg)
            if full_model:
                print(f"  ✓ {reg}: {full_model}")
            else:
                full_model = info['type']  # Fallback to basic type if lookup fails
                if full_model:
                    print(f"  ⚠ {reg}: {full_model} (lookup failed, using KML type)")

            aircraft_list.append({
                'registration': reg,
                'type': info['type'],  # Keep original type for backwards compatibility
                'model': full_model,   # Full model name
                'flights': info['count']
            })

        stats['num_aircraft'] = len(aircraft_registrations)
        stats['aircraft_types'] = sorted(aircraft_types)
        stats['aircraft_list'] = aircraft_list

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
                # Handle both 3-element [lat,lon,alt] and 4-element [lat,lon,alt,timestamp]
                lat1, lon1, alt1_m = path[i][0], path[i][1], path[i][2]
                lat2, lon2, alt2_m = path[i + 1][0], path[i + 1][1], path[i + 1][2]

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
                    except Exception:
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
                        except Exception:
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
    if stats.get('average_groundspeed_knots', 0) > 0:
        kmh_avg = stats['average_groundspeed_knots'] * 1.852
        print(f"  • Average groundspeed: {stats['average_groundspeed_knots']:.1f} kt ({kmh_avg:.1f} km/h)")
    if stats.get('max_groundspeed_knots', 0) > 0:
        kmh_max = stats['max_groundspeed_knots'] * 1.852
        print(f"  • Max groundspeed: {stats['max_groundspeed_knots']:.1f} kt ({kmh_max:.1f} km/h)")
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
        # rjsmin preserves some newlines for ASI (Automatic Semicolon Insertion) safety.
        # Since our generated code uses explicit semicolons, we can safely remove
        # remaining newlines. Replace with space to maintain token separation where needed.
        minified_js = re.sub(r'\s*\n\s*', '', minified_js)
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
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover, user-scalable=no">
    <meta name="theme-color" content="#1a1a1a">
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
    <title>KML Heatmap</title>
    <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
    <link rel="stylesheet" href="https://unpkg.com/leaflet.heat@0.2.0/dist/leaflet-heat.css" />
    <style>
        * {{
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Helvetica Neue', Arial, sans-serif;
            -webkit-tap-highlight-color: transparent;
        }}
        html {{
            margin: 0;
            padding: 0;
            width: 100%;
            height: 100%;
            overflow: hidden;
            background: #1a1a1a;
            overscroll-behavior: none;
            -webkit-overflow-scrolling: touch;
        }}
        body {{
            margin: 0;
            padding: 0;
            width: 100vw;
            min-height: 100vh;
            min-height: 100dvh;
            overflow: hidden;
            background: #1a1a1a;
            position: relative;
            overscroll-behavior: none;
            -webkit-overflow-scrolling: touch;
        }}
        #map {{
            position: absolute;
            top: 0;
            bottom: 0;
            right: 0;
            left: 0;
            background: #1a1a1a;
            overscroll-behavior: none;
        }}
        .leaflet-control-zoom {{
            display: none !important;
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
        .control-btn.left {{ left: 10px; }}
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
        #aircraft-filter {{ top: 50px; }}
        #heatmap-btn {{ top: 90px; }}
        #airports-btn {{ top: 130px; }}
        #altitude-btn {{ top: 170px; }}
        #airspeed-btn {{ top: 210px; }}
        #aviation-btn {{ top: 250px; }}

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

        /* Aircraft filter dropdown - styled like year filter */
        #aircraft-filter {{
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
        #aircraft-filter select {{
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
        #aircraft-filter select:focus {{
            outline: none !important;
            border: 0 !important;
            border-style: none !important;
            box-shadow: none !important;
        }}
        #aircraft-filter select:active {{
            border: 0 !important;
            border-style: none !important;
        }}
        #aircraft-filter select option {{
            background-color: #2b2b2b;
            color: #ffffff;
            text-align: center;
        }}
        #aircraft-filter:hover {{
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

        /* Airspeed legend */
        #airspeed-legend {{
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
        #airspeed-legend .legend-title {{
            font-weight: bold;
            margin-bottom: 8px;
            font-size: 13px;
        }}
        #airspeed-legend .gradient-bar {{
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
        #airspeed-legend .labels {{
            display: flex;
            justify-content: space-between;
            font-size: 11px;
        }}

        /* Statistics panel */
        #stats-panel {{
            position: fixed;
            top: 130px;
            left: 10px;
            width: 280px;
            background-color: #2b2b2b;
            border: 2px solid #555;
            border-radius: 4px;
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
            padding: 0;
            box-sizing: border-box;
        }}
        #wrapped-container {{
            display: flex;
            flex-direction: column;
            width: 100%;
            height: 100%;
            overflow-y: auto;
        }}
        #wrapped-header {{
            display: flex;
            justify-content: flex-end;
            align-items: center;
            padding: 12px 40px;
            background: transparent;
            flex-shrink: 0;
        }}
        #wrapped-content {{
            display: flex;
            gap: 30px;
            flex: 1;
            overflow-y: auto;
            align-items: stretch;
            padding: 0 40px 40px 40px;
        }}

        /* Map container - left side */
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
            min-width: 400px;
            opacity: 0;
            animation: fadeInUp 0.8s ease-out 0.9s forwards;
        }}
        #wrapped-map-snapshot {{
            width: 100%;
            height: 100%;
            object-fit: cover;
        }}

        /* Cards container - right side */
        #wrapped-cards-column {{
            display: flex;
            flex-direction: column;
            gap: 20px;
            width: 500px;
            flex-shrink: 0;
        }}

        /* Square card base styles */
        .wrapped-square-card {{
            background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
            border-radius: 20px;
            padding: 30px;
            flex-shrink: 0;
            box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);
            color: #ffffff;
            position: relative;
            display: flex;
            flex-direction: column;
            opacity: 0;
            animation: fadeInUp 0.6s ease-out forwards;
        }}
        .wrapped-square-card:nth-child(1) {{
            animation-delay: 0.1s;
        }}
        .wrapped-square-card:nth-child(2) {{
            animation-delay: 0.3s;
        }}
        .wrapped-square-card:nth-child(3) {{
            animation-delay: 0.5s;
        }}
        .wrapped-square-card:nth-child(4) {{
            animation-delay: 0.7s;
        }}

        /* Card 1: Stats */
        #wrapped-card-stats {{
        }}

        /* Card 2: Facts */
        #wrapped-card-facts {{
        }}

        /* Card 3: Airports */
        #wrapped-card-airports {{
        }}

        /* Shared card styles */
        .wrapped-square-card h1 {{
            font-size: 36px;
            margin: 0 0 10px 0;
            text-align: center;
            background: linear-gradient(135deg, #f093fb 0%, #f5576c 50%, #ffd93d 100%);
            background-size: 200% 200%;
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
            text-fill-color: transparent;
            animation: shimmer 4s ease-in-out infinite;
        }}
        .wrapped-square-card .year {{
            font-size: 80px;
            font-weight: 900;
            text-align: center;
            margin: 25px 0;
            background: linear-gradient(135deg, #4facfe 0%, #00f2fe 50%, #ffd700 100%);
            background-size: 200% 200%;
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
            text-fill-color: transparent;
            letter-spacing: 8px;
            text-shadow: 0 0 30px rgba(79, 172, 254, 0.5);
            animation: shimmer 3s ease-in-out infinite;
            position: relative;
        }}
        @keyframes shimmer {{
            0%, 100% {{
                background-position: 0% 50%;
            }}
            50% {{
                background-position: 100% 50%;
            }}
        }}
        @keyframes fadeInUp {{
            from {{
                opacity: 0;
                transform: translateY(30px);
            }}
            to {{
                opacity: 1;
                transform: translateY(0);
            }}
        }}
        @keyframes countUp {{
            from {{
                opacity: 0;
                transform: scale(0.5);
            }}
            to {{
                opacity: 1;
                transform: scale(1);
            }}
        }}
        @keyframes pulse {{
            0%, 100% {{
                transform: scale(1);
            }}
            50% {{
                transform: scale(1.05);
            }}
        }}
        .wrapped-square-card .stat-grid {{
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 20px;
            margin: 30px 0;
        }}
        .wrapped-square-card .stat-card {{
            background: rgba(255, 255, 255, 0.08);
            border-radius: 12px;
            padding: 20px;
            text-align: center;
            transition: all 0.3s ease;
            border: 1px solid rgba(79, 172, 254, 0.15);
        }}
        .wrapped-square-card .stat-card:hover {{
            transform: translateY(-5px);
            background: rgba(255, 255, 255, 0.12);
            box-shadow: 0 10px 25px rgba(79, 172, 254, 0.2);
            border: 1px solid rgba(79, 172, 254, 0.4);
        }}
        .wrapped-square-card .stat-value {{
            font-size: 32px;
            font-weight: bold;
            color: #4facfe;
            margin-bottom: 5px;
            animation: countUp 0.8s ease-out;
        }}
        .wrapped-square-card .stat-label {{
            font-size: 12px;
            opacity: 0.8;
            text-transform: uppercase;
            letter-spacing: 1px;
        }}
        #wrapped-header .close-btn {{
            background: transparent;
            border: none;
            color: rgba(255, 255, 255, 0.6);
            font-size: 14px;
            cursor: pointer;
            padding: 6px 12px;
            border-radius: 6px;
            transition: all 0.2s ease;
            font-weight: 500;
            display: flex;
            align-items: center;
            gap: 6px;
            letter-spacing: 0.5px;
        }}
        #wrapped-header .close-btn:hover {{
            background-color: rgba(255, 255, 255, 0.08);
            color: rgba(255, 255, 255, 0.9);
        }}
        .wrapped-square-card .fun-facts {{
            margin: 25px 0;
            padding: 20px;
            background: linear-gradient(135deg, rgba(79, 172, 254, 0.15) 0%, rgba(0, 242, 254, 0.15) 100%);
            border-radius: 12px;
            border: 1px solid rgba(79, 172, 254, 0.3);
        }}
        .wrapped-square-card .fun-facts-title {{
            font-size: 16px;
            font-weight: bold;
            margin-bottom: 12px;
            color: #4facfe;
            text-transform: uppercase;
            letter-spacing: 1px;
        }}
        .wrapped-square-card .fun-fact {{
            font-size: 14px;
            margin: 10px 0;
            padding: 10px 12px;
            opacity: 0;
            line-height: 1.6;
            border-radius: 8px;
            background: rgba(255, 255, 255, 0.05);
            border-left: 3px solid;
            transition: all 0.2s ease;
            display: flex;
            gap: 8px;
            animation: fadeInUp 0.5s ease-out forwards;
        }}
        .wrapped-square-card .fun-fact:nth-child(2) {{
            animation-delay: 0.1s;
        }}
        .wrapped-square-card .fun-fact:nth-child(3) {{
            animation-delay: 0.2s;
        }}
        .wrapped-square-card .fun-fact:nth-child(4) {{
            animation-delay: 0.3s;
        }}
        .wrapped-square-card .fun-fact:nth-child(5) {{
            animation-delay: 0.4s;
        }}
        .wrapped-square-card .fun-fact:nth-child(6) {{
            animation-delay: 0.5s;
        }}
        .wrapped-square-card .fun-fact:nth-child(7) {{
            animation-delay: 0.6s;
        }}
        .wrapped-square-card .fun-fact-icon {{
            flex-shrink: 0;
        }}
        .wrapped-square-card .fun-fact-text {{
            flex: 1;
        }}
        .wrapped-square-card .fun-fact:hover {{
            opacity: 1;
            background: rgba(255, 255, 255, 0.08);
            transform: translateX(3px);
        }}
        .wrapped-square-card .fun-fact strong {{
            color: #00f2fe;
            font-weight: 600;
        }}
        /* Category-specific colors */
        .wrapped-square-card .fun-fact[data-category="distance"] {{
            border-left-color: #4facfe;
        }}
        .wrapped-square-card .fun-fact[data-category="altitude"] {{
            border-left-color: #f093fb;
        }}
        .wrapped-square-card .fun-fact[data-category="time"] {{
            border-left-color: #ffd93d;
        }}
        .wrapped-square-card .fun-fact[data-category="airports"] {{
            border-left-color: #6bcf7f;
        }}
        .wrapped-square-card .fun-fact[data-category="frequency"] {{
            border-left-color: #ff6b9d;
        }}
        .wrapped-square-card .fun-fact[data-category="achievement"] {{
            border-left-color: #ffa500;
            background: linear-gradient(135deg, rgba(255, 165, 0, 0.1) 0%, rgba(255, 215, 0, 0.1) 100%);
        }}
        .wrapped-square-card .top-airports {{
            margin: 25px 0;
        }}
        .wrapped-square-card .top-airports-title {{
            font-size: 16px;
            font-weight: bold;
            margin-bottom: 12px;
            color: #f5576c;
            text-transform: uppercase;
            letter-spacing: 1px;
        }}
        .wrapped-square-card .top-airport {{
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 10px 15px;
            margin: 8px 0;
            background-color: rgba(245, 87, 108, 0.15);
            border-radius: 8px;
            border-left: 3px solid #f5576c;
        }}
        .wrapped-square-card .top-airport-name {{
            font-size: 14px;
            font-weight: 500;
        }}
        .wrapped-square-card .top-airport-count {{
            font-size: 14px;
            font-weight: bold;
            color: #f5576c;
        }}
        .wrapped-square-card .airports-grid {{
            margin: 25px 0;
        }}
        .wrapped-square-card .airports-grid-title {{
            font-size: 16px;
            font-weight: bold;
            margin-bottom: 12px;
            color: #f093fb;
            text-transform: uppercase;
            letter-spacing: 1px;
        }}
        .wrapped-square-card .airport-badges {{
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
        }}
        .wrapped-square-card .airport-badge {{
            background: linear-gradient(135deg, rgba(240, 147, 251, 0.2) 0%, rgba(245, 87, 108, 0.2) 100%);
            border: 1px solid rgba(240, 147, 251, 0.4);
            padding: 6px 12px;
            border-radius: 20px;
            font-size: 12px;
            font-weight: 500;
            color: #ffffff;
            white-space: nowrap;
            transition: all 0.3s ease;
            opacity: 0;
            animation: fadeInUp 0.4s ease-out forwards;
        }}
        .wrapped-square-card .airport-badge:hover {{
            transform: scale(1.1);
            box-shadow: 0 5px 15px rgba(240, 147, 251, 0.4);
            border: 1px solid rgba(240, 147, 251, 0.8);
        }}
        .wrapped-square-card .aircraft-fleet {{
            margin: 25px 0;
        }}
        .wrapped-square-card .aircraft-fleet-title {{
            font-size: 16px;
            font-weight: bold;
            margin-bottom: 12px;
            color: #4facfe;
            text-transform: uppercase;
            letter-spacing: 1px;
        }}
        .wrapped-square-card .fleet-aircraft {{
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 10px 15px;
            margin: 8px 0;
            border-radius: 8px;
        }}
        .wrapped-square-card .fleet-aircraft-high {{
            background-color: rgba(245, 87, 108, 0.15);
            border-left: 3px solid #f5576c;
        }}
        .wrapped-square-card .fleet-aircraft-high .fleet-aircraft-count {{
            color: #f5576c;
        }}
        .wrapped-square-card .fleet-aircraft-medium-high {{
            background-color: rgba(107, 207, 127, 0.15);
            border-left: 3px solid #6bcf7f;
        }}
        .wrapped-square-card .fleet-aircraft-medium-high .fleet-aircraft-count {{
            color: #6bcf7f;
        }}
        .wrapped-square-card .fleet-aircraft-medium-low {{
            background-color: rgba(0, 242, 254, 0.15);
            border-left: 3px solid #00f2fe;
        }}
        .wrapped-square-card .fleet-aircraft-medium-low .fleet-aircraft-count {{
            color: #00f2fe;
        }}
        .wrapped-square-card .fleet-aircraft-low {{
            background-color: rgba(79, 172, 254, 0.15);
            border-left: 3px solid #4facfe;
        }}
        .wrapped-square-card .fleet-aircraft-low .fleet-aircraft-count {{
            color: #4facfe;
        }}
        .wrapped-square-card .fleet-aircraft-name {{
            font-size: 14px;
            font-weight: 500;
        }}
        .wrapped-square-card .fleet-aircraft-count {{
            font-size: 14px;
            font-weight: bold;
        }}
        #wrapped-card-content {{
            flex: 1;
            margin: 0 -40px;
            padding: 0 40px;
        }}

        /* Responsive styles for mobile portrait mode */
        @media (max-width: 768px) {{
            #wrapped-modal {{
                padding: 0;
            }}
            #wrapped-header {{
                padding: 10px 20px;
            }}
            #wrapped-header .close-btn {{
                font-size: 13px;
                padding: 5px 10px;
            }}
            #wrapped-content {{
                flex-direction: column;
                gap: 20px;
                padding: 0 20px 20px 20px;
            }}
            #wrapped-cards-column {{
                width: 100%;
                gap: 15px;
            }}
            .wrapped-square-card {{
                width: 100%;
                height: auto;
                padding: 20px;
                box-sizing: border-box;
            }}
            #wrapped-map-container {{
                width: 100%;
                padding-bottom: 100%;
                position: relative;
                height: 0;
                min-width: 0;
            }}
            #wrapped-map-container > * {{
                position: absolute;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
            }}
            .wrapped-square-card h1 {{
                font-size: 24px;
                word-wrap: break-word;
                line-height: 1.2;
            }}
            .wrapped-square-card .year {{
                font-size: 56px;
                margin: 20px 0;
                letter-spacing: 4px;
            }}
            .wrapped-square-card .stat-grid {{
                gap: 12px;
                margin: 20px 0;
            }}
            .wrapped-square-card .stat-card {{
                padding: 15px 10px;
            }}
            .wrapped-square-card .stat-value {{
                font-size: 28px;
            }}
            .wrapped-square-card .stat-label {{
                font-size: 11px;
            }}
            .wrapped-square-card .fun-facts {{
                margin: 15px 0;
                padding: 15px;
            }}
            .wrapped-square-card .fun-facts-title {{
                font-size: 14px;
            }}
            .wrapped-square-card .fun-fact {{
                font-size: 12px;
                padding: 8px 10px;
                margin: 8px 0;
            }}
            .wrapped-square-card .fun-fact:hover {{
                transform: translateX(2px);
            }}
            .wrapped-square-card .top-airports {{
                margin: 15px 0;
            }}
            .wrapped-square-card .top-airports-title {{
                font-size: 14px;
            }}
            .wrapped-square-card .top-airport {{
                padding: 8px 12px;
            }}
            .wrapped-square-card .top-airport-name {{
                font-size: 12px;
            }}
            .wrapped-square-card .top-airport-count {{
                font-size: 12px;
            }}
            .wrapped-square-card .airports-grid {{
                margin: 15px 0;
            }}
            .wrapped-square-card .airports-grid-title {{
                font-size: 14px;
            }}
            .wrapped-square-card .airport-badge {{
                padding: 5px 10px;
                font-size: 11px;
            }}
            .wrapped-square-card .aircraft-fleet {{
                margin: 15px 0;
            }}
            .wrapped-square-card .aircraft-fleet-title {{
                font-size: 14px;
            }}
            .wrapped-square-card .fleet-aircraft {{
                padding: 8px 12px;
            }}
            .wrapped-square-card .fleet-aircraft-name {{
                font-size: 12px;
            }}
            .wrapped-square-card .fleet-aircraft-count {{
                font-size: 12px;
            }}
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

        /* Modern dot marker styles - base (zoom < 6) */
        .airport-marker {{
            width: 6px;
            height: 6px;
            background-color: #28a745;
            border: 1px solid #ffffff;
            border-radius: 50%;
            box-shadow: 0 2px 6px rgba(0,0,0,0.4);
            cursor: pointer;
            transition: all 0.2s ease;
            flex-shrink: 0;
        }}

        /* Home base marker (airport with most flights) */
        .airport-marker-home {{
            background-color: #007bff !important;
        }}

        /* Airport label styles - base (zoom < 6) */
        .airport-label {{
            background-color: rgba(43, 43, 43, 0.9);
            border: 1px solid #28a745;
            color: #ffffff;
            font-family: monospace;
            font-weight: bold;
            font-size: 9px;
            padding: 1px 3px;
            border-radius: 3px;
            white-space: nowrap;
            pointer-events: none;
            box-shadow: 0 1px 3px rgba(0, 0, 0, 0.4);
            position: absolute;
            bottom: 10px;
            left: 50%;
            transform: translateX(-50%);
        }}

        /* Home base label */
        .airport-label-home {{
            border-color: #007bff !important;
        }}
        .airport-marker-container {{
            position: relative;
            display: flex;
            align-items: center;
            justify-content: center;
            width: 6px;
            height: 6px;
        }}
        .airport-marker-container:hover .airport-marker {{
            transform: scale(1.3);
            box-shadow: 0 3px 8px rgba(0,0,0,0.6);
        }}

        /* Small zoom (6-7) */
        .airport-marker-small {{
            width: 7px;
            height: 7px;
            border: 1px solid #ffffff;
        }}
        .airport-label-small {{
            font-size: 10px;
            padding: 1px 3px;
            bottom: 11px;
        }}
        .airport-marker-container-small {{
            width: 7px;
            height: 7px;
        }}

        /* Medium-small zoom (8-9) */
        .airport-marker-medium-small {{
            width: 8px;
            height: 8px;
            border: 1px solid #ffffff;
        }}
        .airport-label-medium-small {{
            font-size: 11px;
            padding: 1px 4px;
            bottom: 12px;
        }}
        .airport-marker-container-medium-small {{
            width: 8px;
            height: 8px;
        }}

        /* Medium zoom (10-11) */
        .airport-marker-medium {{
            width: 10px;
            height: 10px;
            border: 2px solid #ffffff;
        }}
        .airport-label-medium {{
            font-size: 12px;
            padding: 2px 5px;
            bottom: 14px;
        }}
        .airport-marker-container-medium {{
            width: 10px;
            height: 10px;
        }}

        /* Large zoom (12-13) */
        .airport-marker-large {{
            width: 11px;
            height: 11px;
            border: 2px solid #ffffff;
        }}
        .airport-label-large {{
            font-size: 12px;
            padding: 2px 5px;
            bottom: 16px;
        }}
        .airport-marker-container-large {{
            width: 11px;
            height: 11px;
        }}

        /* Extra large zoom (14+) */
        .airport-marker-xlarge {{
            width: 12px;
            height: 12px;
            border: 2px solid #ffffff;
        }}
        .airport-label-xlarge {{
            font-size: 13px;
            padding: 2px 6px;
            bottom: 18px;
        }}
        .airport-marker-container-xlarge {{
            width: 12px;
            height: 12px;
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
    <button id="airports-btn" class="control-btn right" onclick="toggleAirports()">🏢 Airports</button>
    <button id="altitude-btn" class="control-btn right" onclick="toggleAltitude()">⛰️ Altitude</button>
    <button id="airspeed-btn" class="control-btn right" onclick="toggleAirspeed()">🚀 Speed</button>
    <button id="aviation-btn" class="control-btn right" onclick="toggleAviation()" style="display: none;">🗺️ Aviation</button>
    <div id="year-filter" class="control-btn right">
        <select id="year-select" onchange="filterByYear()">
            <option value="all">📅 Years</option>
        </select>
    </div>

    <div id="aircraft-filter" class="control-btn right">
        <select id="aircraft-select" onchange="filterByAircraft()">
            <option value="all">✈️ Aircraft</option>
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
    <div id="airspeed-legend">
        <div class="legend-title">🚀 Groundspeed</div>
        <div class="gradient-bar"></div>
        <div class="labels">
            <span id="airspeed-legend-min">0 kt</span>
            <span id="airspeed-legend-max">200 kt</span>
        </div>
    </div>
    <div id="loading">Loading data...</div>

    <!-- Wrapped Card Modal -->
    <div id="wrapped-modal" onclick="closeWrapped(event)">
        <div id="wrapped-container" onclick="event.stopPropagation()">
            <div id="wrapped-header">
                <button class="close-btn" onclick="closeWrapped()">✕ Close</button>
            </div>
            <div id="wrapped-content">
                <!-- Cards column - left side -->
                <div id="wrapped-cards-column">
                    <!-- Card 1: Stats -->
                    <div id="wrapped-card-stats" class="wrapped-square-card">
                        <h1>✨ Your Year in Flight</h1>
                        <div class="year" id="wrapped-year">2025</div>
                        <div class="stat-grid" id="wrapped-stats"></div>
                    </div>

                    <!-- Card 2: Facts -->
                    <div id="wrapped-card-facts" class="wrapped-square-card">
                        <div class="fun-facts" id="wrapped-fun-facts"></div>
                    </div>

                    <!-- Card 3: Aircraft Fleet -->
                    <div id="wrapped-card-fleet" class="wrapped-square-card">
                        <div class="aircraft-fleet" id="wrapped-aircraft-fleet"></div>
                    </div>

                    <!-- Card 4: Airports -->
                    <div id="wrapped-card-airports" class="wrapped-square-card">
                        <div class="top-airports" id="wrapped-top-airports"></div>
                        <div class="airports-grid" id="wrapped-airports-grid"></div>
                    </div>
                </div>

                <!-- Map - right side -->
                <div id="wrapped-map-container">
                    <!-- Map will be moved here when wrapped is shown -->
                </div>
            </div>
        </div>
    </div>

    <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
    <script src="https://unpkg.com/leaflet.heat@0.2.0/dist/leaflet-heat.js"></script>
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

        // Use SVG renderer for better click detection reliability
        // Canvas has known issues with event handling after layer updates
        var altitudeRenderer = L.svg();
        var airspeedRenderer = L.svg();

        // Data layers
        var heatmapLayer = null;
        var altitudeLayer = L.layerGroup();
        var airspeedLayer = L.layerGroup();
        var airportLayer = L.layerGroup();
        var currentResolution = null;
        var loadedData = {{}};
        var currentData = null;  // Store current loaded data for redrawing
        var fullStats = null;  // Store original full statistics
        var fullPathInfo = null;  // Store full resolution path_info for filtering
        var fullPathSegments = null;  // Store full resolution path_segments for filtering
        var altitudeRange = {{ min: 0, max: 10000 }};  // Store altitude range for legend
        var airspeedRange = {{ min: 0, max: 200 }};  // Store airspeed range for legend

        // Layer visibility state
        var heatmapVisible = true;
        var altitudeVisible = false;
        var airspeedVisible = false;
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

        // Add airports layer by default
        airportLayer.addTo(map);

        // Set initial button states
        document.getElementById('altitude-btn').style.opacity = '0.5';  // Altitude starts hidden
        document.getElementById('airspeed-btn').style.opacity = '0.5';  // Airspeed starts hidden
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

            // Filter coordinates based on active filters
            var filteredCoordinates = data.coordinates;
            if ((selectedYear !== 'all' || selectedAircraft !== 'all') && data.path_segments) {{
                // Get filtered path IDs
                var filteredPathIds = new Set();
                if (data.path_info) {{
                    data.path_info.forEach(function(pathInfo) {{
                        var matchesYear = selectedYear === 'all' || (pathInfo.year && pathInfo.year.toString() === selectedYear);
                        var matchesAircraft = selectedAircraft === 'all' || (pathInfo.aircraft_registration === selectedAircraft);
                        if (matchesYear && matchesAircraft) {{
                            filteredPathIds.add(pathInfo.id);
                        }}
                    }});
                }}

                // Extract coordinates from filtered segments
                var coordSet = new Set();
                data.path_segments.forEach(function(segment) {{
                    if (filteredPathIds.has(segment.path_id)) {{
                        var coords = segment.coords;
                        if (coords && coords.length === 2) {{
                            coordSet.add(JSON.stringify(coords[0]));
                            coordSet.add(JSON.stringify(coords[1]));
                        }}
                    }}
                }});

                filteredCoordinates = Array.from(coordSet).map(function(str) {{
                    return JSON.parse(str);
                }});
            }}

            // Update heatmap - only add if visible
            if (heatmapLayer) {{
                map.removeLayer(heatmapLayer);
            }}

            heatmapLayer = L.heatLayer(filteredCoordinates, {{
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

                var pathInfo = currentData.path_info.find(function(p) {{ return p.id === pathId; }});

                // Filter by year if selected
                if (selectedYear !== 'all') {{
                    if (pathInfo && pathInfo.year && pathInfo.year.toString() !== selectedYear) {{
                        return;  // Skip this segment
                    }}
                }}

                // Filter by aircraft if selected
                if (selectedAircraft !== 'all') {{
                    if (pathInfo && pathInfo.aircraft_registration !== selectedAircraft) {{
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
                    renderer: altitudeRenderer,
                    interactive: true
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
            // Check if filters are active
            var hasFilters = selectedYear !== 'all' || selectedAircraft !== 'all';
            var hasSelection = selectedPathIds.size > 0;

            if (!hasFilters && !hasSelection) {{
                // No filters or selection - show all airports
                Object.keys(airportMarkers).forEach(function(airportName) {{
                    var marker = airportMarkers[airportName];
                    marker.setOpacity(1.0);
                }});
                return;
            }}

            var visibleAirports = new Set();

            // If filters are active, collect airports from filtered paths
            if (hasFilters && fullPathInfo) {{
                fullPathInfo.forEach(function(pathInfo) {{
                    // Check if path matches filters
                    var matchesYear = selectedYear === 'all' || (pathInfo.year && pathInfo.year.toString() === selectedYear);
                    var matchesAircraft = selectedAircraft === 'all' || (pathInfo.aircraft_registration === selectedAircraft);

                    if (matchesYear && matchesAircraft) {{
                        if (pathInfo.start_airport) visibleAirports.add(pathInfo.start_airport);
                        if (pathInfo.end_airport) visibleAirports.add(pathInfo.end_airport);
                    }}
                }});
            }}

            // If paths are selected, collect airports from selected paths (overrides filter)
            if (hasSelection) {{
                selectedPathIds.forEach(function(pathId) {{
                    var airports = pathToAirports[pathId];
                    if (airports) {{
                        if (airports.start) visibleAirports.add(airports.start);
                        if (airports.end) visibleAirports.add(airports.end);
                    }}
                }});
            }}

            // Update opacity for all airport markers
            Object.keys(airportMarkers).forEach(function(airportName) {{
                var marker = airportMarkers[airportName];
                if (visibleAirports.has(airportName)) {{
                    marker.setOpacity(1.0);  // Full opacity for visited airports
                }} else {{
                    marker.setOpacity(0.0);  // Hide non-visited airports
                }}
            }});
        }}

        // Global variable for selected year
        var selectedYear = 'all';
        var selectedAircraft = 'all';

        // Function to calculate filtered statistics
        function calculateFilteredStats() {{
            if (!fullPathInfo || !fullPathSegments) {{
                return fullStats;
            }}

            // Filter path_info based on current filters
            var filteredPathInfo = fullPathInfo.filter(function(pathInfo) {{
                // Apply year filter
                if (selectedYear !== 'all') {{
                    if (!pathInfo.year || pathInfo.year.toString() !== selectedYear) {{
                        return false;
                    }}
                }}

                // Apply aircraft filter
                if (selectedAircraft !== 'all') {{
                    if (!pathInfo.aircraft_registration || pathInfo.aircraft_registration !== selectedAircraft) {{
                        return false;
                    }}
                }}

                return true;
            }});

            // If no paths match filters, return empty stats
            if (filteredPathInfo.length === 0) {{
                return {{
                    total_points: 0,
                    num_paths: 0,
                    num_airports: 0,
                    airport_names: [],
                    num_aircraft: 0,
                    aircraft_list: [],
                    total_distance_nm: 0
                }};
            }}

            // Collect airports
            var airports = new Set();
            filteredPathInfo.forEach(function(pathInfo) {{
                if (pathInfo.start_airport) airports.add(pathInfo.start_airport);
                if (pathInfo.end_airport) airports.add(pathInfo.end_airport);
            }});

            // Collect aircraft
            var aircraftMap = {{}};
            filteredPathInfo.forEach(function(pathInfo) {{
                if (pathInfo.aircraft_registration) {{
                    var reg = pathInfo.aircraft_registration;
                    if (!aircraftMap[reg]) {{
                        aircraftMap[reg] = {{
                            registration: reg,
                            type: pathInfo.aircraft_type,
                            flights: 0
                        }};
                    }}
                    aircraftMap[reg].flights += 1;
                }}
            }});

            var aircraftList = Object.values(aircraftMap).sort(function(a, b) {{
                return b.flights - a.flights;
            }});

            // Calculate filtered stats from FULL RESOLUTION segments
            var filteredSegments = fullPathSegments.filter(function(segment) {{
                var pathInfo = filteredPathInfo.find(function(p) {{ return p.id === segment.path_id; }});
                return pathInfo !== undefined;
            }});

            var totalDistanceKm = 0;
            filteredSegments.forEach(function(segment) {{
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
                    totalDistanceKm += 6371 * c;
                }}
            }});

            // Get altitude range
            var altitudes = filteredSegments.map(function(s) {{ return s.altitude_m; }});
            var maxAltitudeM = altitudes.length > 0 ? Math.max(...altitudes) : 0;
            var minAltitudeM = altitudes.length > 0 ? Math.min(...altitudes) : 0;

            // Get groundspeed
            var groundspeeds = filteredSegments
                .map(function(s) {{ return s.groundspeed_knots; }})
                .filter(function(s) {{ return s > 0; }});
            var maxGroundspeedKnots = groundspeeds.length > 0 ? Math.max(...groundspeeds) : 0;
            var avgGroundspeedKnots = 0;
            if (groundspeeds.length > 0) {{
                avgGroundspeedKnots = groundspeeds.reduce(function(a, b) {{ return a + b; }}, 0) / groundspeeds.length;
            }}

            // Calculate total altitude gain
            var totalAltitudeGainM = 0;
            var prevAltM = null;
            filteredSegments.forEach(function(segment) {{
                if (prevAltM !== null && segment.altitude_m > prevAltM) {{
                    totalAltitudeGainM += segment.altitude_m - prevAltM;
                }}
                prevAltM = segment.altitude_m;
            }});

            // Calculate longest flight (max distance per path)
            var longestFlightKm = 0;
            var pathDistances = {{}};
            filteredSegments.forEach(function(segment) {{
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
                    var dist = 6371 * c;

                    if (!pathDistances[segment.path_id]) {{
                        pathDistances[segment.path_id] = 0;
                    }}
                    pathDistances[segment.path_id] += dist;
                }}
            }});
            Object.values(pathDistances).forEach(function(dist) {{
                if (dist > longestFlightKm) longestFlightKm = dist;
            }});

            // Calculate total flight time from filtered paths
            var totalFlightTimeSeconds = 0;
            filteredPathInfo.forEach(function(pathInfo) {{
                // We don't have duration per path in path_info, so we estimate from fullStats
                if (fullStats && fullStats.total_flight_time_seconds && fullStats.num_paths > 0) {{
                    totalFlightTimeSeconds += fullStats.total_flight_time_seconds / fullStats.num_paths;
                }}
            }});

            var hours = Math.floor(totalFlightTimeSeconds / 3600);
            var minutes = Math.floor((totalFlightTimeSeconds % 3600) / 60);
            var totalFlightTimeStr = hours + 'h ' + minutes + 'm';

            // Calculate cruise speed and most common cruise altitude
            // Filter segments above 1000ft AGL (we approximate AGL as altitude - min_altitude)
            var cruiseSegments = filteredSegments.filter(function(seg) {{
                return seg.altitude_ft > (minAltitudeM * 3.28084 + 1000);
            }});

            var cruiseSpeedKnots = 0;
            if (cruiseSegments.length > 0) {{
                var cruiseSpeeds = cruiseSegments
                    .map(function(s) {{ return s.groundspeed_knots; }})
                    .filter(function(s) {{ return s > 0; }});
                if (cruiseSpeeds.length > 0) {{
                    cruiseSpeedKnots = cruiseSpeeds.reduce(function(a, b) {{ return a + b; }}, 0) / cruiseSpeeds.length;
                }}
            }}

            // Most common cruise altitude (500ft bins)
            var altitudeBins = {{}};
            cruiseSegments.forEach(function(seg) {{
                var bin = Math.round(seg.altitude_ft / 500) * 500;
                altitudeBins[bin] = (altitudeBins[bin] || 0) + 1;
            }});
            var mostCommonCruiseAltFt = 0;
            var maxCount = 0;
            Object.keys(altitudeBins).forEach(function(bin) {{
                if (altitudeBins[bin] > maxCount) {{
                    maxCount = altitudeBins[bin];
                    mostCommonCruiseAltFt = parseInt(bin);
                }}
            }});

            return {{
                total_points: filteredSegments.length * 2,
                num_paths: filteredPathInfo.length,
                num_airports: airports.size,
                airport_names: Array.from(airports).sort(),
                num_aircraft: aircraftList.length,
                aircraft_list: aircraftList,
                total_distance_nm: totalDistanceKm * 0.539957,
                total_distance_km: totalDistanceKm,
                longest_flight_nm: longestFlightKm * 0.539957,
                longest_flight_km: longestFlightKm,
                max_altitude_ft: maxAltitudeM * 3.28084,
                max_altitude_m: maxAltitudeM,
                min_altitude_ft: minAltitudeM * 3.28084,
                min_altitude_m: minAltitudeM,
                total_altitude_gain_ft: totalAltitudeGainM * 3.28084,
                total_altitude_gain_m: totalAltitudeGainM,
                max_groundspeed_knots: maxGroundspeedKnots,
                average_groundspeed_knots: avgGroundspeedKnots,
                cruise_speed_knots: cruiseSpeedKnots,
                most_common_cruise_altitude_ft: mostCommonCruiseAltFt,
                most_common_cruise_altitude_m: Math.round(mostCommonCruiseAltFt * 0.3048),
                total_flight_time_seconds: totalFlightTimeSeconds,
                total_flight_time_str: totalFlightTimeStr
            }};
        }}

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

            // Update stats based on filter
            var filteredStats = calculateFilteredStats();
            updateStatsPanel(filteredStats, false);

            // Update airport visibility based on filter
            updateAirportOpacity();
        }}

        // Function to filter data by aircraft
        function filterByAircraft() {{
            const aircraftSelect = document.getElementById('aircraft-select');
            selectedAircraft = aircraftSelect.value;

            // Clear current paths and reload
            altitudeLayer.clearLayers();
            pathSegments = {{}};
            selectedPathIds.clear();

            // Reload current resolution data to apply filter
            currentResolution = null;  // Force reload
            updateLayers();

            // Update stats based on filter
            var filteredStats = calculateFilteredStats();
            updateStatsPanel(filteredStats, false);

            // Update airport visibility based on filter
            updateAirportOpacity();
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

            // Populate aircraft filter dropdown
            if (metadata && metadata.stats && metadata.stats.aircraft_list) {{
                const aircraftSelect = document.getElementById('aircraft-select');
                metadata.stats.aircraft_list.forEach(function(aircraft) {{
                    const option = document.createElement('option');
                    option.value = aircraft.registration;
                    var typeStr = aircraft.type ? ' (' + aircraft.type + ')' : '';
                    option.textContent = '✈️ ' + aircraft.registration + typeStr;
                    aircraftSelect.appendChild(option);
                }});
            }}

            // Find the airport with the most flights (home base)
            let homeBaseAirport = null;
            if (airports.length > 0) {{
                homeBaseAirport = airports.reduce((max, airport) =>
                    airport.flight_count > max.flight_count ? airport : max
                , airports[0]);
            }}

            // Add airport markers
            airports.forEach(function(airport) {{
                const icaoMatch = airport.name ? airport.name.match(/\\b([A-Z]{{4}})\\b/) : null;
                const icao = icaoMatch ? icaoMatch[1] : 'APT';

                // Check if this is the home base
                const isHomeBase = homeBaseAirport && airport.name === homeBaseAirport.name;
                const homeClass = isHomeBase ? ' airport-marker-home' : '';
                const homeLabelClass = isHomeBase ? ' airport-label-home' : '';

                const markerHtml = '<div class="airport-marker-container"><div class="airport-marker' + homeClass + '"></div><div class="airport-label' + homeLabelClass + '">' + icao + '</div></div>';

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

            // Load full resolution path_info and path_segments for accurate filtering
            try {{
                const fullResData = await loadData('z14_plus');
                if (fullResData && fullResData.path_info) {{
                    fullPathInfo = fullResData.path_info;
                }}
                if (fullResData && fullResData.path_segments) {{
                    fullPathSegments = fullResData.path_segments;
                }}
            }} catch (error) {{
                console.error('Failed to load full path data:', error);
            }}

            // Load groundspeed range from metadata (from full resolution data)
            if (metadata && metadata.min_groundspeed_knots !== undefined && metadata.max_groundspeed_knots !== undefined) {{
                airspeedRange.min = metadata.min_groundspeed_knots;
                airspeedRange.max = metadata.max_groundspeed_knots;
                // Update airspeed legend with the correct range
                updateAirspeedLegend(airspeedRange.min, airspeedRange.max);
            }}

            // Initial data load
            updateLayers();

            // Set initial airport marker sizes based on current zoom
            updateAirportMarkerSizes();
        }})();

        // Update layers on zoom change only
        map.on('zoomend', function() {{
            updateLayers();
            updateAirportMarkerSizes();
        }});

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
            if (airspeedVisible) {{
                redrawAirspeedPaths();
            }}
        }}

        function selectPathsByAirport(airportName) {{
            var pathIds = airportToPaths[airportName] || [];
            pathIds.forEach(function(pathId) {{
                selectedPathIds.add(pathId);
            }});
            redrawAltitudePaths();
            if (airspeedVisible) {{
                redrawAirspeedPaths();
            }}
        }}

        function clearSelection() {{
            selectedPathIds.clear();
            redrawAltitudePaths();
            if (airspeedVisible) {{
                redrawAirspeedPaths();
            }}
        }}

        function updateAirportMarkerSizes() {{
            const zoom = map.getZoom();
            let sizeClass = '';

            if (zoom >= 14) {{
                sizeClass = 'xlarge';
            }} else if (zoom >= 12) {{
                sizeClass = 'large';
            }} else if (zoom >= 10) {{
                sizeClass = 'medium';
            }} else if (zoom >= 8) {{
                sizeClass = 'medium-small';
            }} else if (zoom >= 6) {{
                sizeClass = 'small';
            }}

            // Update all airport markers
            document.querySelectorAll('.airport-marker-container').forEach(function(container) {{
                const marker = container.querySelector('.airport-marker');
                const label = container.querySelector('.airport-label');

                // Hide labels when zoomed out below level 5, but keep dots visible
                if (zoom < 5) {{
                    label.style.display = 'none';
                }} else {{
                    label.style.display = '';
                }}

                // Remove all size classes
                container.classList.remove('airport-marker-container-small', 'airport-marker-container-medium-small', 'airport-marker-container-medium', 'airport-marker-container-large', 'airport-marker-container-xlarge');
                marker.classList.remove('airport-marker-small', 'airport-marker-medium-small', 'airport-marker-medium', 'airport-marker-large', 'airport-marker-xlarge');
                label.classList.remove('airport-label-small', 'airport-label-medium-small', 'airport-label-medium', 'airport-label-large', 'airport-label-xlarge');

                // Add appropriate size class
                if (sizeClass) {{
                    container.classList.add('airport-marker-container-' + sizeClass);
                    marker.classList.add('airport-marker-' + sizeClass);
                    label.classList.add('airport-label-' + sizeClass);
                }}
            }});
        }}

        function updateAltitudeLegend(minAlt, maxAlt) {{
            var minFt = Math.round(minAlt);
            var maxFt = Math.round(maxAlt);
            var minM = Math.round(minAlt * 0.3048);
            var maxM = Math.round(maxAlt * 0.3048);

            document.getElementById('legend-min').textContent = minFt.toLocaleString() + ' ft (' + minM.toLocaleString() + ' m)';
            document.getElementById('legend-max').textContent = maxFt.toLocaleString() + ' ft (' + maxM.toLocaleString() + ' m)';
        }}

        function redrawAirspeedPaths() {{
            if (!currentData) return;

            // Clear airspeed layer
            airspeedLayer.clearLayers();

            // Calculate groundspeed range for color scaling
            var colorMinSpeed, colorMaxSpeed;
            if (selectedPathIds.size > 0) {{
                // Use selected paths' groundspeed range
                var selectedSegments = currentData.path_segments.filter(function(segment) {{
                    return selectedPathIds.has(segment.path_id) && segment.groundspeed_knots > 0;
                }});
                if (selectedSegments.length > 0) {{
                    var groundspeeds = selectedSegments.map(function(s) {{ return s.groundspeed_knots; }});
                    colorMinSpeed = Math.min(...groundspeeds);
                    colorMaxSpeed = Math.max(...groundspeeds);
                }} else {{
                    colorMinSpeed = airspeedRange.min;
                    colorMaxSpeed = airspeedRange.max;
                }}
            }} else {{
                // Use full groundspeed range from metadata (not from current resolution)
                colorMinSpeed = airspeedRange.min;
                colorMaxSpeed = airspeedRange.max;
            }}

            // Create path segments with groundspeed colors and rescaled colors
            currentData.path_segments.forEach(function(segment) {{
                var pathId = segment.path_id;

                var pathInfo = currentData.path_info.find(function(p) {{ return p.id === pathId; }});

                // Filter by year if selected
                if (selectedYear !== 'all') {{
                    if (pathInfo && pathInfo.year && pathInfo.year.toString() !== selectedYear) {{
                        return;  // Skip this segment
                    }}
                }}

                // Filter by aircraft if selected
                if (selectedAircraft !== 'all') {{
                    if (pathInfo && pathInfo.aircraft_registration !== selectedAircraft) {{
                        return;  // Skip this segment
                    }}
                }}

                if (segment.groundspeed_knots > 0) {{
                    var isSelected = selectedPathIds.has(pathId);

                    // Recalculate color based on current groundspeed range
                    var color = getColorForAltitude(segment.groundspeed_knots, colorMinSpeed, colorMaxSpeed);

                    var polyline = L.polyline(segment.coords, {{
                        color: color,
                        weight: isSelected ? 6 : 4,
                        opacity: isSelected ? 1.0 : (selectedPathIds.size > 0 ? 0.1 : 0.85),
                        renderer: airspeedRenderer,
                        interactive: true
                    }}).addTo(airspeedLayer);

                    // Make path clickable
                    polyline.on('click', function(e) {{
                        L.DomEvent.stopPropagation(e);
                        togglePathSelection(pathId);
                    }});
                }}
            }});

            // Update legend
            updateAirspeedLegend(colorMinSpeed, colorMaxSpeed);
        }}

        function updateAirspeedLegend(minSpeed, maxSpeed) {{
            var minKnots = Math.round(minSpeed);
            var maxKnots = Math.round(maxSpeed);
            var minKmh = Math.round(minSpeed * 1.852);
            var maxKmh = Math.round(maxSpeed * 1.852);

            document.getElementById('airspeed-legend-min').textContent = minKnots.toLocaleString() + ' kt (' + minKmh.toLocaleString() + ' km/h)';
            document.getElementById('airspeed-legend-max').textContent = maxKnots.toLocaleString() + ' kt (' + maxKmh.toLocaleString() + ' km/h)';
        }}

        function updateStatsForSelection() {{
            if (selectedPathIds.size === 0) {{
                // No selection - show filtered stats (or full stats if no filter active)
                var statsToShow = (selectedYear !== 'all' || selectedAircraft !== 'all')
                    ? calculateFilteredStats()
                    : fullStats;
                if (statsToShow) {{
                    updateStatsPanel(statsToShow, false);
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

            // Collect unique aircraft from selected paths
            var selectedAircraftMap = {{}};
            selectedPathInfos.forEach(function(pathInfo) {{
                if (pathInfo.aircraft_registration) {{
                    var reg = pathInfo.aircraft_registration;
                    if (!selectedAircraftMap[reg]) {{
                        selectedAircraftMap[reg] = {{
                            registration: reg,
                            type: pathInfo.aircraft_type,
                            flights: 0
                        }};
                    }}
                    selectedAircraftMap[reg].flights += 1;
                }}
            }});

            // Convert aircraft map to sorted array
            var selectedAircraftList = Object.values(selectedAircraftMap).sort(function(a, b) {{
                return b.flights - a.flights;
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

            // Calculate altitude gain for selected paths
            var totalAltitudeGainM = 0;
            var prevAltitudeM = null;
            selectedSegments.forEach(function(segment) {{
                if (prevAltitudeM !== null) {{
                    var gain = segment.altitude_m - prevAltitudeM;
                    if (gain > 0) {{
                        totalAltitudeGainM += gain;
                    }}
                }}
                prevAltitudeM = segment.altitude_m;
            }});

            // Get groundspeed range from selected segments
            var groundspeeds = selectedSegments
                .map(function(s) {{ return s.groundspeed_knots; }})
                .filter(function(s) {{ return s > 0; }});
            var maxGroundspeedKnots = groundspeeds.length > 0 ? Math.max(...groundspeeds) : 0;

            // Calculate average groundspeed
            var avgGroundspeedKnots = 0;
            if (groundspeeds.length > 0) {{
                var sumSpeed = groundspeeds.reduce(function(a, b) {{ return a + b; }}, 0);
                avgGroundspeedKnots = sumSpeed / groundspeeds.length;
            }}

            // Calculate longest flight (max distance per selected path)
            var longestFlightKm = 0;
            var pathDistances = {{}};
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
                    var dist = 6371 * c;

                    if (!pathDistances[segment.path_id]) {{
                        pathDistances[segment.path_id] = 0;
                    }}
                    pathDistances[segment.path_id] += dist;
                }}
            }});
            Object.values(pathDistances).forEach(function(dist) {{
                if (dist > longestFlightKm) longestFlightKm = dist;
            }});

            // Estimate total flight time for selected paths
            var totalFlightTimeSeconds = 0;
            selectedPathInfos.forEach(function(pathInfo) {{
                if (fullStats && fullStats.total_flight_time_seconds && fullStats.num_paths > 0) {{
                    totalFlightTimeSeconds += fullStats.total_flight_time_seconds / fullStats.num_paths;
                }}
            }});
            var hours = Math.floor(totalFlightTimeSeconds / 3600);
            var minutes = Math.floor((totalFlightTimeSeconds % 3600) / 60);
            var totalFlightTimeStr = hours + 'h ' + minutes + 'm';

            // Calculate cruise speed and most common cruise altitude for selected paths
            var cruiseSegments = selectedSegments.filter(function(seg) {{
                return seg.altitude_ft > (minAltitudeM * 3.28084 + 1000);
            }});

            var cruiseSpeedKnots = 0;
            if (cruiseSegments.length > 0) {{
                var cruiseSpeeds = cruiseSegments
                    .map(function(s) {{ return s.groundspeed_knots; }})
                    .filter(function(s) {{ return s > 0; }});
                if (cruiseSpeeds.length > 0) {{
                    cruiseSpeedKnots = cruiseSpeeds.reduce(function(a, b) {{ return a + b; }}, 0) / cruiseSpeeds.length;
                }}
            }}

            // Most common cruise altitude (500ft bins)
            var altitudeBins = {{}};
            cruiseSegments.forEach(function(seg) {{
                var bin = Math.round(seg.altitude_ft / 500) * 500;
                altitudeBins[bin] = (altitudeBins[bin] || 0) + 1;
            }});
            var mostCommonCruiseAltFt = 0;
            var maxCount = 0;
            Object.keys(altitudeBins).forEach(function(bin) {{
                if (altitudeBins[bin] > maxCount) {{
                    maxCount = altitudeBins[bin];
                    mostCommonCruiseAltFt = parseInt(bin);
                }}
            }});

            // Build selected stats object
            var selectedStats = {{
                total_points: selectedSegments.length * 2,
                num_paths: selectedPathIds.size,
                num_airports: selectedAirports.size,
                airport_names: Array.from(selectedAirports).sort(),
                num_aircraft: selectedAircraftList.length,
                aircraft_list: selectedAircraftList,
                total_distance_nm: totalDistanceKm * 0.539957,
                total_distance_km: totalDistanceKm,
                longest_flight_nm: longestFlightKm * 0.539957,
                longest_flight_km: longestFlightKm,
                max_altitude_ft: maxAltitudeM * 3.28084,
                max_altitude_m: maxAltitudeM,
                min_altitude_ft: minAltitudeM * 3.28084,
                min_altitude_m: minAltitudeM,
                total_altitude_gain_ft: totalAltitudeGainM * 3.28084,
                total_altitude_gain_m: totalAltitudeGainM,
                average_groundspeed_knots: avgGroundspeedKnots,
                max_groundspeed_knots: maxGroundspeedKnots,
                cruise_speed_knots: cruiseSpeedKnots,
                most_common_cruise_altitude_ft: mostCommonCruiseAltFt,
                most_common_cruise_altitude_m: Math.round(mostCommonCruiseAltFt * 0.3048),
                total_flight_time_seconds: totalFlightTimeSeconds,
                total_flight_time_str: totalFlightTimeStr
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

            html += '<div style="margin-bottom: 8px;"><strong>Data Points:</strong> ' + stats.total_points.toLocaleString() + '</div>';
            html += '<div style="margin-bottom: 8px;"><strong>Flights:</strong> ' + stats.num_paths + '</div>';
            html += '<div style="margin-bottom: 8px;"><strong>Airports Visited:</strong> ' + stats.num_airports + '</div>';

            if (stats.airport_names && stats.airport_names.length > 0) {{
                html += '<div style="margin-bottom: 8px; max-height: 150px; overflow-y: auto;"><strong>Airports:</strong><br>';
                stats.airport_names.forEach(function(name) {{
                    html += '<span style="margin-left: 10px;">• ' + name + '</span><br>';
                }});
                html += '</div>';
            }}

            // Aircraft information (below airports)
            if (stats.num_aircraft && stats.num_aircraft > 0) {{
                html += '<div style="margin-bottom: 8px;"><strong>Aircrafts Used:</strong> ' + stats.num_aircraft + '</div>';

                if (stats.aircraft_list && stats.aircraft_list.length > 0) {{
                    html += '<div style="margin-bottom: 8px; max-height: 150px; overflow-y: auto;"><strong>Aircraft Details:</strong><br>';
                    stats.aircraft_list.forEach(function(aircraft) {{
                        var typeStr = aircraft.type ? ' (' + aircraft.type + ')' : '';
                        html += '<span style="margin-left: 10px;">• ' + aircraft.registration + typeStr + ' - ' + aircraft.flights + ' flight(s)</span><br>';
                    }});
                    html += '</div>';
                }}
            }}

            if (stats.total_flight_time_str) {{
                html += '<div style="margin-bottom: 8px;"><strong>Total Flight Time:</strong> ' + stats.total_flight_time_str + '</div>';
            }}

            // Distance with km conversion
            var distanceKm = (stats.total_distance_nm * 1.852).toFixed(1);
            html += '<div style="margin-bottom: 8px;"><strong>Distance:</strong> ' + stats.total_distance_nm.toFixed(1) + ' nm (' + distanceKm + ' km)</div>';

            // Average distance per trip
            if (stats.num_paths > 0) {{
                var avgDistanceNm = (stats.total_distance_nm / stats.num_paths).toFixed(1);
                var avgDistanceKm = (avgDistanceNm * 1.852).toFixed(1);
                html += '<div style="margin-bottom: 8px;"><strong>Average Distance per Trip:</strong> ' + avgDistanceNm + ' nm (' + avgDistanceKm + ' km)</div>';
            }}

            // Longest single flight distance
            if (stats.longest_flight_nm && stats.longest_flight_nm > 0) {{
                var longestKm = stats.longest_flight_km.toFixed(1);
                html += '<div style="margin-bottom: 8px;"><strong>Longest Flight:</strong> ' + stats.longest_flight_nm.toFixed(1) + ' nm (' + longestKm + ' km)</div>';
            }}

            if (stats.average_groundspeed_knots && stats.average_groundspeed_knots > 0) {{
                var kmh = (stats.average_groundspeed_knots * 1.852).toFixed(1);
                html += '<div style="margin-bottom: 8px;"><strong>Average Groundspeed:</strong> ' + stats.average_groundspeed_knots.toFixed(1) + ' kt (' + kmh + ' km/h)</div>';
            }}

            if (stats.cruise_speed_knots && stats.cruise_speed_knots > 0) {{
                var kmh_cruise = (stats.cruise_speed_knots * 1.852).toFixed(1);
                html += '<div style="margin-bottom: 8px;"><strong>Cruise Speed (>1000ft AGL):</strong> ' + stats.cruise_speed_knots.toFixed(1) + ' kt (' + kmh_cruise + ' km/h)</div>';
            }}

            if (stats.max_groundspeed_knots && stats.max_groundspeed_knots > 0) {{
                var kmh_max = (stats.max_groundspeed_knots * 1.852).toFixed(1);
                html += '<div style="margin-bottom: 8px;"><strong>Max Groundspeed:</strong> ' + stats.max_groundspeed_knots.toFixed(1) + ' kt (' + kmh_max + ' km/h)</div>';
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

            // Most common cruise altitude
            if (stats.most_common_cruise_altitude_ft && stats.most_common_cruise_altitude_ft > 0) {{
                var cruiseAltM = Math.round(stats.most_common_cruise_altitude_m);
                html += '<div style="margin-bottom: 8px;"><strong>Most Common Cruise Altitude:</strong> ' + stats.most_common_cruise_altitude_ft.toLocaleString() + ' ft (' + cruiseAltM.toLocaleString() + ' m) AGL</div>';
            }}

            document.getElementById('stats-panel').innerHTML = html;
        }}

        function toggleStats() {{
            const panel = document.getElementById('stats-panel');
            panel.style.display = panel.style.display === 'block' ? 'none' : 'block';
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
                // Hide airspeed if it's visible
                if (airspeedVisible) {{
                    map.removeLayer(airspeedLayer);
                    airspeedVisible = false;
                    document.getElementById('airspeed-btn').style.opacity = '0.5';
                    document.getElementById('airspeed-legend').style.display = 'none';
                }}
                map.addLayer(altitudeLayer);
                altitudeVisible = true;
                document.getElementById('altitude-btn').style.opacity = '1.0';
                document.getElementById('altitude-legend').style.display = 'block';
                redrawAltitudePaths();  // Draw altitude paths when enabled
            }}
        }}

        function toggleAirspeed() {{
            if (airspeedVisible) {{
                map.removeLayer(airspeedLayer);
                airspeedVisible = false;
                document.getElementById('airspeed-btn').style.opacity = '0.5';
                document.getElementById('airspeed-legend').style.display = 'none';
            }} else {{
                // Hide altitude if it's visible
                if (altitudeVisible) {{
                    map.removeLayer(altitudeLayer);
                    altitudeVisible = false;
                    document.getElementById('altitude-btn').style.opacity = '0.5';
                    document.getElementById('altitude-legend').style.display = 'none';
                }}
                map.addLayer(airspeedLayer);
                airspeedVisible = true;
                document.getElementById('airspeed-btn').style.opacity = '1.0';
                document.getElementById('airspeed-legend').style.display = 'block';
                redrawAirspeedPaths();  // Draw airspeed paths when enabled
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
                document.getElementById('aircraft-filter'),
                document.getElementById('heatmap-btn'),
                document.getElementById('altitude-btn'),
                document.getElementById('airspeed-btn'),
                document.getElementById('airports-btn'),
                document.getElementById('aviation-btn'),
                document.getElementById('stats-panel'),
                document.getElementById('altitude-legend'),
                document.getElementById('airspeed-legend'),
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

        // Generate dynamic fun facts based on data
        function generateFunFacts(yearStats) {{
            const allFacts = [];

            // Distance comparisons
            const earthCircumferenceKm = 40075;
            const everestHeightFt = 29032;
            const everestHeightM = 8849;
            const commercialCruiseAltFt = 35000;

            // Famous flight routes (approximate great circle distances)
            const newYorkToLondonKm = 5585;
            const newYorkToLAKm = 3944;
            const parisToTokyoKm = 9715;
            const londonToSydneyKm = 17015;
            const berlinToNewYorkKm = 6385;

            const totalDistanceKm = yearStats.total_distance_nm * 1.852;
            const timesAroundEarth = totalDistanceKm / earthCircumferenceKm;

            // Distance facts
            if (timesAroundEarth >= 0.5) {{
                allFacts.push({{
                    category: 'distance',
                    icon: '🌍',
                    text: `You flew <strong>${{timesAroundEarth.toFixed(1)}}x</strong> around the Earth`,
                    priority: timesAroundEarth >= 1 ? 10 : 7
                }});
            }}

            // Compare to famous routes
            if (totalDistanceKm >= londonToSydneyKm) {{
                const timesLondonSydney = (totalDistanceKm / londonToSydneyKm).toFixed(1);
                allFacts.push({{
                    category: 'distance',
                    icon: '✈️',
                    text: `Your <strong>${{yearStats.total_distance_nm.toFixed(0)}} nm</strong> could fly you London to Sydney <strong>${{timesLondonSydney}}x</strong>`,
                    priority: 9
                }});
            }} else if (totalDistanceKm >= parisToTokyoKm) {{
                const timesParisToTokyo = (totalDistanceKm / parisToTokyoKm).toFixed(1);
                allFacts.push({{
                    category: 'distance',
                    icon: '🗼',
                    text: `Your <strong>${{yearStats.total_distance_nm.toFixed(0)}} nm</strong> could fly you Paris to Tokyo <strong>${{timesParisToTokyo}}x</strong>`,
                    priority: 8
                }});
            }} else if (totalDistanceKm >= berlinToNewYorkKm) {{
                const timesBerlinNY = (totalDistanceKm / berlinToNewYorkKm).toFixed(1);
                allFacts.push({{
                    category: 'distance',
                    icon: '🗽',
                    text: `Your <strong>${{yearStats.total_distance_nm.toFixed(0)}} nm</strong> could fly you Berlin to New York <strong>${{timesBerlinNY}}x</strong>`,
                    priority: 7
                }});
            }} else if (totalDistanceKm >= newYorkToLAKm) {{
                const timesNYToLA = (totalDistanceKm / newYorkToLAKm).toFixed(1);
                allFacts.push({{
                    category: 'distance',
                    icon: '🌉',
                    text: `Your <strong>${{yearStats.total_distance_nm.toFixed(0)}} nm</strong> could fly you New York to LA <strong>${{timesNYToLA}}x</strong>`,
                    priority: 6
                }});
            }}


            // Altitude facts (from fullStats) - only elevation gain, not max altitude
            if (fullStats && fullStats.total_altitude_gain_ft) {{
                const gainFt = Math.round(fullStats.total_altitude_gain_ft);
                const timesEverest = gainFt / everestHeightFt;

                if (timesEverest >= 1) {{
                    allFacts.push({{
                        category: 'altitude',
                        icon: '⬆️',
                        text: `You climbed <strong>${{gainFt.toLocaleString()}} ft</strong> - that's scaling Everest <strong>${{timesEverest.toFixed(1)}}x</strong>!`,
                        priority: 9
                    }});
                }} else if (gainFt > 10000) {{
                    allFacts.push({{
                        category: 'altitude',
                        icon: '⬆️',
                        text: `Total elevation gain: <strong>${{gainFt.toLocaleString()}} ft</strong>`,
                        priority: 5
                    }});
                }}
            }}

            // Time-based facts
            if (fullStats && fullStats.total_flight_time_seconds) {{
                const totalHours = fullStats.total_flight_time_seconds / 3600;
                const totalDays = totalHours / 24;
                const hoursPerYear = 8760;
                const percentOfYear = (totalHours / hoursPerYear * 100).toFixed(2);

                if (totalDays >= 1) {{
                    allFacts.push({{
                        category: 'time',
                        icon: '⏱️',
                        text: `You spent <strong>${{totalDays.toFixed(1)}} days</strong> in the air - that's <strong>${{percentOfYear}}%</strong> of the year!`,
                        priority: 8
                    }});
                }} else if (totalHours >= 10) {{
                    allFacts.push({{
                        category: 'time',
                        icon: '⏰',
                        text: `Total airtime: <strong>${{totalHours.toFixed(1)}} hours</strong>`,
                        priority: 5
                    }});
                }}
            }}

            // Cruise speed fun fact (with average distance per trip)
            if (fullStats && fullStats.cruise_speed_knots && fullStats.cruise_speed_knots > 0 && yearStats.total_flights > 0) {{
                const cruiseSpeedKt = Math.round(fullStats.cruise_speed_knots);
                const avgDistanceNm = Math.round(yearStats.total_distance_nm / yearStats.total_flights);
                allFacts.push({{
                    category: 'speed',
                    icon: '✈️',
                    text: `Cruising at <strong>${{cruiseSpeedKt}} kt</strong>, averaging <strong>${{avgDistanceNm}} nm</strong> per adventure`,
                    priority: 8
                }});
            }}

            // Longest flight fun facts
            if (fullStats && fullStats.longest_flight_nm && fullStats.longest_flight_nm > 0) {{
                const longestFlightNm = fullStats.longest_flight_nm;
                const longestFlightKm = fullStats.longest_flight_km;

                // Famous distances for comparison
                const munichToHamburgKm = 612;  // Similar to longest flight!
                const berlinToMunichKm = 504;
                const frankfurtToViennaKm = 516;
                const parisToBarcelonaKm = 831;
                const londonToEdinburghKm = 534;

                if (longestFlightKm >= munichToHamburgKm * 0.9 && longestFlightKm <= munichToHamburgKm * 1.1) {{
                    allFacts.push({{
                        category: 'distance',
                        icon: '🛫',
                        text: `Your longest adventure was <strong>${{longestFlightNm.toFixed(0)}} nm</strong> - like flying Munich to Hamburg!`,
                        priority: 8
                    }});
                }} else if (longestFlightKm >= berlinToMunichKm * 0.9) {{
                    allFacts.push({{
                        category: 'distance',
                        icon: '🛫',
                        text: `Your longest journey: <strong>${{longestFlightNm.toFixed(0)}} nm</strong> - that's Berlin to Munich distance!`,
                        priority: 8
                    }});
                }} else if (longestFlightKm >= 200) {{
                    allFacts.push({{
                        category: 'distance',
                        icon: '🛫',
                        text: `Your longest single flight covered <strong>${{longestFlightNm.toFixed(0)}} nm</strong> (<strong>${{longestFlightKm.toFixed(0)}} km</strong>)`,
                        priority: 7
                    }});
                }}
            }}

            // Most common cruise altitude fun facts
            if (fullStats && fullStats.most_common_cruise_altitude_ft && fullStats.most_common_cruise_altitude_ft > 0) {{
                const cruiseAltFt = fullStats.most_common_cruise_altitude_ft;
                const cruiseAltM = Math.round(fullStats.most_common_cruise_altitude_m);

                // Famous heights for comparison
                const eiffelTowerM = 330;
                const empireStateBuildingM = 381;
                const berlinTVTowerM = 368;
                const cologneMonM = 157;

                if (cruiseAltM >= empireStateBuildingM * 0.9 && cruiseAltM <= empireStateBuildingM * 1.3) {{
                    allFacts.push({{
                        category: 'altitude',
                        icon: '🏔️',
                        text: `Your sweet spot: <strong>${{cruiseAltFt.toLocaleString()}} ft</strong> AGL - about the height of the Empire State Building!`,
                        priority: 8
                    }});
                }} else if (cruiseAltM >= eiffelTowerM * 0.9 && cruiseAltM <= eiffelTowerM * 1.5) {{
                    allFacts.push({{
                        category: 'altitude',
                        icon: '🗼',
                        text: `Preferred cruise altitude: <strong>${{cruiseAltFt.toLocaleString()}} ft</strong> AGL - like flying over the Eiffel Tower!`,
                        priority: 8
                    }});
                }} else if (cruiseAltFt >= 1000 && cruiseAltFt <= 3000) {{
                    allFacts.push({{
                        category: 'altitude',
                        icon: '✈️',
                        text: `You love the low-level views at <strong>${{cruiseAltFt.toLocaleString()}} ft</strong> AGL - classic VFR territory!`,
                        priority: 7
                    }});
                }} else if (cruiseAltFt > 3000) {{
                    allFacts.push({{
                        category: 'altitude',
                        icon: '⬆️',
                        text: `Most common cruise: <strong>${{cruiseAltFt.toLocaleString()}} ft</strong> AGL (<strong>${{cruiseAltM.toLocaleString()}} m</strong>)`,
                        priority: 7
                    }});
                }}
            }}

            // Aircraft fun facts
            if (fullStats && fullStats.aircraft_list && fullStats.aircraft_list.length > 0) {{
                const primaryAircraft = fullStats.aircraft_list[0];
                const totalAircraft = fullStats.aircraft_list.length;

                const primaryModel = primaryAircraft.model || primaryAircraft.type || 'aircraft';

                if (totalAircraft === 1) {{
                    allFacts.push({{
                        category: 'aircraft',
                        icon: '✈️',
                        text: `Loyal to <strong>${{primaryAircraft.registration}}</strong> - all ${{primaryAircraft.flights}} flights in this ${{primaryModel}}!`,
                        priority: 9
                    }});
                }} else if (totalAircraft >= 4) {{
                    allFacts.push({{
                        category: 'aircraft',
                        icon: '🛩️',
                        text: `You explored <strong>${{totalAircraft}} different aircraft</strong> - a true aviator!`,
                        priority: 9
                    }});
                }} else {{
                    allFacts.push({{
                        category: 'aircraft',
                        icon: '✈️',
                        text: `Your go-to: <strong>${{primaryAircraft.registration}}</strong> (${{primaryModel}}) with <strong>${{primaryAircraft.flights}} flights</strong>`,
                        priority: 9
                    }});
                }}
            }}

            // Special achievements
            if (fullStats && fullStats.max_altitude_ft > 40000) {{
                allFacts.push({{
                    category: 'achievement',
                    icon: '🚀',
                    text: `You're practically an astronaut at <strong>${{Math.round(fullStats.max_altitude_ft).toLocaleString()}} ft</strong>!`,
                    priority: 10
                }});
            }}

            // Sort by priority (highest first) and select top facts
            allFacts.sort((a, b) => b.priority - a.priority);

            // Select diverse facts - aim for 4-6 facts from different categories
            const selectedFacts = [];
            const usedCategories = new Set();
            const maxFactsPerCategory = 2;
            const categoryCount = {{}};

            for (const fact of allFacts) {{
                const catCount = categoryCount[fact.category] || 0;

                // Add fact if we haven't maxed out this category yet
                if (catCount < maxFactsPerCategory) {{
                    selectedFacts.push(fact);
                    categoryCount[fact.category] = catCount + 1;
                    usedCategories.add(fact.category);

                    // Stop when we have enough facts
                    if (selectedFacts.length >= 6) break;
                }}
            }}

            // If we still need more facts, add remaining high-priority ones
            if (selectedFacts.length < 4) {{
                for (const fact of allFacts) {{
                    if (!selectedFacts.includes(fact)) {{
                        selectedFacts.push(fact);
                        if (selectedFacts.length >= 4) break;
                    }}
                }}
            }}

            return selectedFacts;
        }}

        // Store original map parent for restoring later
        let originalMapParent = null;
        let originalMapIndex = 0;

        // Wrapped card functionality
        function showWrapped() {{
            // Determine which year to show
            const year = selectedYear !== 'all' ? selectedYear : (fullStats.available_years ? fullStats.available_years[fullStats.available_years.length - 1] : new Date().getFullYear());

            // Calculate year-specific stats
            const yearStats = calculateYearStats(year);

            // Update card content
            document.getElementById('wrapped-year').textContent = year;

            // Build stats grid (6 cards: changed Max Speed to Max Groundspeed, added Max Altitude)
            const statsHtml = `
                <div class="stat-card">
                    <div class="stat-value">${{yearStats.total_flights}}</div>
                    <div class="stat-label">Flights</div>
                </div>
                <div class="stat-card">
                    <div class="stat-value">${{yearStats.num_airports}}</div>
                    <div class="stat-label">Airports</div>
                </div>
                <div class="stat-card">
                    <div class="stat-value">${{yearStats.total_distance_nm.toFixed(0)}}</div>
                    <div class="stat-label">Nautical Miles</div>
                </div>
                <div class="stat-card">
                    <div class="stat-value">${{yearStats.flight_time}}</div>
                    <div class="stat-label">Flight Time</div>
                </div>
                <div class="stat-card">
                    <div class="stat-value">${{(fullStats.max_groundspeed_knots || 0).toFixed(0)}} kt</div>
                    <div class="stat-label">Max Groundspeed</div>
                </div>
                <div class="stat-card">
                    <div class="stat-value">${{Math.round(fullStats.max_altitude_ft || 0).toLocaleString()}} ft</div>
                    <div class="stat-label">Max Altitude</div>
                </div>
            `;

            document.getElementById('wrapped-stats').innerHTML = statsHtml;

            // Build fun facts section with dynamic, varied facts
            const funFacts = generateFunFacts(yearStats);

            let funFactsHtml = '<div class="fun-facts-title">✨ Facts</div>';
            funFacts.forEach(function(fact) {{
                funFactsHtml += `<div class="fun-fact" data-category="${{fact.category}}"><span class="fun-fact-icon">${{fact.icon}}</span><span class="fun-fact-text">${{fact.text}}</span></div>`;
            }});

            document.getElementById('wrapped-fun-facts').innerHTML = funFactsHtml;

            // Build aircraft fleet section
            if (fullStats && fullStats.aircraft_list && fullStats.aircraft_list.length > 0) {{
                let fleetHtml = '<div class="aircraft-fleet-title">✈️ Fleet</div>';

                // Show all aircraft sorted by flight count with color coding based on flights
                const maxFlights = fullStats.aircraft_list[0].flights;
                const minFlights = fullStats.aircraft_list[fullStats.aircraft_list.length - 1].flights;
                const flightRange = maxFlights - minFlights;

                fullStats.aircraft_list.forEach(function(aircraft, index) {{
                    // Use full model if available, otherwise fall back to type
                    const modelStr = aircraft.model || aircraft.type || '';

                    // Calculate color based on flight count (normalized 0-1)
                    const normalized = flightRange > 0 ? (aircraft.flights - minFlights) / flightRange : 1;

                    // Determine color class based on normalized value
                    let colorClass;
                    if (normalized >= 0.75) {{
                        colorClass = 'fleet-aircraft-high';  // Most flights - warm color
                    }} else if (normalized >= 0.5) {{
                        colorClass = 'fleet-aircraft-medium-high';
                    }} else if (normalized >= 0.25) {{
                        colorClass = 'fleet-aircraft-medium-low';
                    }} else {{
                        colorClass = 'fleet-aircraft-low';  // Least flights - cool color
                    }}

                    fleetHtml += `
                        <div class="fleet-aircraft ${{colorClass}}">
                            <div class="fleet-aircraft-name">${{aircraft.registration}} - ${{modelStr}}</div>
                            <div class="fleet-aircraft-count">${{aircraft.flights}} flights</div>
                        </div>
                    `;
                }});

                document.getElementById('wrapped-aircraft-fleet').innerHTML = fleetHtml;
            }}

            // Build home base section if we have airport data
            if (fullStats && fullStats.airport_names && fullStats.airport_names.length > 0) {{
                // Load airport data to get flight counts
                loadAirports().then(function(airports) {{
                    // Sort airports by flight count to find home base
                    const sortedAirports = airports.sort((a, b) => b.flight_count - a.flight_count);
                    const homeBase = sortedAirports[0];

                    let homeBaseHtml = '<div class="top-airports-title">🏠 Home Base</div>';
                    homeBaseHtml += `
                        <div class="top-airport">
                            <div class="top-airport-name">${{homeBase.name}}</div>
                            <div class="top-airport-count">${{homeBase.flight_count}} flights</div>
                        </div>
                    `;
                    document.getElementById('wrapped-top-airports').innerHTML = homeBaseHtml;

                    // Build all destinations badge grid (excluding home base)
                    const destinations = fullStats.airport_names.filter(name => name !== homeBase.name);
                    let airportBadgesHtml = '<div class="airports-grid-title">🗺️ Destinations</div><div class="airport-badges">';
                    destinations.forEach(function(airportName) {{
                        airportBadgesHtml += `<div class="airport-badge">${{airportName}}</div>`;
                    }});
                    airportBadgesHtml += '</div>';
                    document.getElementById('wrapped-airports-grid').innerHTML = airportBadgesHtml;
                }});
            }}

            // Move the map into the wrapped container
            const mapContainer = document.getElementById('map');
            const wrappedMapContainer = document.getElementById('wrapped-map-container');

            // Store original position if not already stored
            if (!originalMapParent) {{
                originalMapParent = mapContainer.parentNode;
                originalMapIndex = Array.from(originalMapParent.children).indexOf(mapContainer);
            }}

            // Zoom to fit all data with extra padding
            map.fitBounds(BOUNDS, {{ padding: [80, 80] }});

            // Hide controls in wrapped view FIRST
            const controls = [
                document.querySelector('.leaflet-control-zoom'),
                document.getElementById('stats-btn'),
                document.getElementById('export-btn'),
                document.getElementById('wrapped-btn'),
                document.getElementById('heatmap-btn'),
                document.getElementById('airports-btn'),
                document.getElementById('altitude-btn'),
                document.getElementById('airspeed-btn'),
                document.getElementById('aviation-btn'),
                document.getElementById('year-filter'),
                document.getElementById('aircraft-filter'),
                document.getElementById('stats-panel'),
                document.getElementById('altitude-legend'),
                document.getElementById('airspeed-legend'),
                document.getElementById('loading')
            ];
            controls.forEach(el => {{ if (el) el.style.display = 'none'; }});

            // Show modal first to ensure wrapped-map-container has dimensions
            document.getElementById('wrapped-modal').style.display = 'flex';

            // Wait for modal to render and have dimensions
            setTimeout(function() {{
                // Now move map into wrapped container (which now has dimensions)
                wrappedMapContainer.appendChild(mapContainer);

                // Make sure the map container fills the wrapped container
                mapContainer.style.width = '100%';
                mapContainer.style.height = '100%';
                mapContainer.style.borderRadius = '12px';
                mapContainer.style.overflow = 'hidden';

                // Force a layout recalculation
                wrappedMapContainer.offsetHeight;

                // Now that container has dimensions, invalidate map size
                setTimeout(function() {{
                    map.invalidateSize();
                    map.fitBounds(BOUNDS, {{ padding: [80, 80] }});
                }}, 100);
            }}, 50);
        }}

        function closeWrapped(event) {{
            if (!event || event.target.id === 'wrapped-modal') {{
                // Move map back to original position
                const mapContainer = document.getElementById('map');
                if (originalMapParent) {{
                    const children = Array.from(originalMapParent.children);
                    if (originalMapIndex >= children.length) {{
                        originalMapParent.appendChild(mapContainer);
                    }} else {{
                        originalMapParent.insertBefore(mapContainer, children[originalMapIndex]);
                    }}

                    // Restore map styling
                    mapContainer.style.width = '';
                    mapContainer.style.height = '';
                    mapContainer.style.borderRadius = '';
                    mapContainer.style.overflow = '';

                    // Show controls again
                    const controls = [
                        document.querySelector('.leaflet-control-zoom'),
                        document.getElementById('stats-btn'),
                        document.getElementById('export-btn'),
                        document.getElementById('wrapped-btn'),
                        document.getElementById('heatmap-btn'),
                        document.getElementById('airports-btn'),
                        document.getElementById('altitude-btn'),
                        document.getElementById('airspeed-btn'),
                        document.getElementById('year-filter'),
                        document.getElementById('aircraft-filter'),
                        document.getElementById('stats-panel'),
                        document.getElementById('altitude-legend'),
                        document.getElementById('airspeed-legend'),
                        document.getElementById('loading')
                    ];
                    controls.forEach(el => {{ if (el) el.style.display = ''; }});

                    // Only show aviation button if API key is available
                    if (OPENAIP_API_KEY) {{
                        const aviationBtn = document.getElementById('aviation-btn');
                        if (aviationBtn) aviationBtn.style.display = '';
                    }}

                    // Force map to recalculate size
                    setTimeout(function() {{
                        map.invalidateSize();
                    }}, 100);
                }}

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
