"""KML file parsing functionality."""

import re
import os
import json
import hashlib
from pathlib import Path
from datetime import datetime
from typing import List, Dict, Tuple, Optional, Any

# Try to use lxml for better performance, fall back to standard library
try:
    from lxml import etree as ET
    USING_LXML = True
except ImportError:
    from xml.etree import ElementTree as ET
    USING_LXML = False

from .aircraft import parse_aircraft_from_filename
from .validation import validate_coordinates, validate_altitude
from .logger import logger
from .constants import (
    MID_FLIGHT_MIN_ALTITUDE_M,
    MID_FLIGHT_MAX_VARIATION_M,
    LANDING_MAX_VARIATION_M,
    LANDING_MAX_ALTITUDE_M,
    PATH_SAMPLE_MAX_SIZE,
    PATH_SAMPLE_MIN_SIZE,
    LAT_MIN,
    LAT_MAX,
    LON_MIN,
    LON_MAX,
    ALT_MIN_M,
    ALT_MAX_M,
    CACHE_DIR_NAME,
)

# Pre-compiled regex patterns for performance
DATE_PATTERN = re.compile(r'(\d{2}\s+\w{3}\s+\d{4}|\d{4}-\d{2}-\d{2})')
YEAR_PATTERN = re.compile(r'\b(20\d{2})\b')

# Pre-computed validation ranges (avoid function call overhead)
LAT_RANGE = (LAT_MIN, LAT_MAX)
LON_RANGE = (LON_MIN, LON_MAX)
ALT_RANGE = (ALT_MIN_M, ALT_MAX_M)

# Cache directory for parsed KML files
CACHE_DIR = Path(CACHE_DIR_NAME)


def get_cache_key(kml_file: str) -> Tuple[Optional[Path], bool]:
    """Generate cache key based on file path and modification time.

    Args:
        kml_file: Path to KML file

    Returns:
        Tuple of (cache_path, is_valid) where is_valid indicates if cached data can be used
    """
    kml_path = Path(kml_file)

    # Create cache directory if it doesn't exist
    CACHE_DIR.mkdir(exist_ok=True)

    # Get file modification time
    try:
        mtime = kml_path.stat().st_mtime
    except (OSError, FileNotFoundError):
        return None, False

    # Create cache filename from KML filename and modification time
    cache_name = f"{kml_path.stem}_{int(mtime)}.json"
    cache_path = CACHE_DIR / cache_name

    # Check if cache file exists
    if cache_path.exists():
        return cache_path, True

    # Clean up old cache files for this KML file
    for old_cache in CACHE_DIR.glob(f"{kml_path.stem}_*.json"):
        try:
            old_cache.unlink()
        except OSError:
            pass

    return cache_path, False


def load_cached_parse(cache_path: Path) -> Optional[Tuple[List[List[float]], List[List[List[float]]], List[Dict[str, Any]]]]:
    """Load cached parse results.

    Args:
        cache_path: Path to cache file

    Returns:
        Tuple of (coordinates, path_groups, path_metadata) or None if cache invalid
    """
    try:
        with open(cache_path, 'r') as f:
            cached = json.load(f)
        return cached['coordinates'], cached['path_groups'], cached['path_metadata']
    except (json.JSONDecodeError, KeyError, OSError):
        return None


def save_to_cache(cache_path: Path, coordinates: List[List[float]], path_groups: List[List[List[float]]], path_metadata: List[Dict[str, Any]]) -> None:
    """Save parse results to cache.

    Args:
        cache_path: Path to cache file
        coordinates: List of coordinates
        path_groups: List of path groups
        path_metadata: List of path metadata dicts
    """
    try:
        with open(cache_path, 'w') as f:
            json.dump({
                'coordinates': coordinates,
                'path_groups': path_groups,
                'path_metadata': path_metadata
            }, f)
    except OSError as e:
        logger.debug(f"Failed to save cache: {e}")


def extract_year_from_timestamp(timestamp: Optional[str]) -> Optional[int]:
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
        year_match = YEAR_PATTERN.search(timestamp)
        if year_match:
            return int(year_match.group(1))
    except ValueError as e:
        logger.debug(f"Could not parse timestamp '{timestamp}': {e}")
    except Exception as e:
        logger.debug(f"Unexpected error parsing timestamp '{timestamp}': {e}")

    return None


def sample_path_altitudes(path: List[List[float]], from_end: bool = False) -> Optional[Dict[str, float]]:
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


def is_mid_flight_start(path: List[List[float]], start_alt: float, debug: bool = False) -> bool:
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
    is_mid_flight = start_alt > MID_FLIGHT_MIN_ALTITUDE_M and sample['variation'] < MID_FLIGHT_MAX_VARIATION_M

    if is_mid_flight and debug:
        logger.debug(f"Detected mid-flight start at {start_alt:.0f}m (variation: {sample['variation']:.0f}m)")

    return is_mid_flight


def is_valid_landing(path: List[List[float]], end_alt: float, debug: bool = False) -> bool:
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
    return sample['variation'] < LANDING_MAX_VARIATION_M or end_alt < LANDING_MAX_ALTITUDE_M


def parse_kml_coordinates(kml_file: str) -> Tuple[List[List[float]], List[List[List[float]]], List[Dict[str, Any]]]:
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
    # Check cache first
    cache_path, cache_valid = get_cache_key(kml_file)
    if cache_valid and cache_path:
        cached_result = load_cached_parse(cache_path)
        if cached_result:
            coordinates, path_groups, path_metadata = cached_result
            logger.info(f"✓ Loaded {len(coordinates)} points from {Path(kml_file).name} (cached)")
            if path_groups:
                total_alt_points = sum(len(path) for path in path_groups)
                print(f"  ({total_alt_points} points have altitude data in {len(path_groups)} path(s))")
            return coordinates, path_groups, path_metadata

    coordinates = []
    path_groups = []  # List of separate paths
    path_metadata = []  # Metadata for each path

    try:
        tree = ET.parse(kml_file)
        root = tree.getroot()

        logger.debug(f"\n  Root tag: {root.tag}")
        logger.debug(f"Root attrib: {root.attrib}")
        all_tags = set()
        for elem in root.iter():
            tag = elem.tag.split('}')[-1] if '}' in elem.tag else elem.tag
            all_tags.add(tag)
        logger.debug(f"All unique tags in file: {sorted(all_tags)}")

        # KML uses XML namespaces
        namespaces = {
            'kml': 'http://www.opengis.net/kml/2.2',
            'gx': 'http://www.google.com/kml/ext/2.2'
        }

        # Try with namespace
        coord_elements = root.findall('.//kml:coordinates', namespaces)

        # Also try to find gx:coord elements (Google Earth Track extension)
        gx_coords = root.findall('.//gx:coord', namespaces)

        if gx_coords:
            logger.debug(f"Found {len(gx_coords)} gx:coord elements (Google Earth Track)")

        # If no results, try without namespace (some KML files don't use it)
        if not coord_elements and not gx_coords:
            # Remove namespace from tags
            for elem in root.iter():
                if '}' in elem.tag:
                    elem.tag = elem.tag.split('}', 1)[1]
            coord_elements = root.findall('.//coordinates')
            gx_coords = root.findall('.//coord')  # gx:coord without namespace

        logger.debug(f"Found {len(coord_elements)} coordinate elements")
        if coord_elements:
            for i, elem in enumerate(coord_elements[:2]):  # Show first 2
                logger.debug(f"Element {i} text preview: {str(elem.text)[:100] if elem.text else 'None'}")

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
                match = DATE_PATTERN.search(airport_name)
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
                logger.debug(f"Coordinate element {idx} has None text, skipping")
                continue

            coord_text = coord_elem.text.strip()
            if not coord_text:
                logger.debug(f"Coordinate element {idx} has empty text, skipping")
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

                        # Inline validation (faster than function calls)
                        if not (LAT_RANGE[0] <= lat <= LAT_RANGE[1] and LON_RANGE[0] <= lon <= LON_RANGE[1]):
                            logger.debug(f"Invalid coordinates [{lat}, {lon}] in {Path(kml_file).name}")
                            continue

                        # Validate altitude if present
                        if alt is not None and not (ALT_RANGE[0] <= alt <= ALT_RANGE[1]):
                            logger.debug(f"Invalid altitude {alt}m in {Path(kml_file).name}")
                            alt = None

                        # Clamp negative altitudes to 0 (below sea level = 0ft)
                        if alt is not None and alt < 0:
                            alt = 0.0

                        # Swap to [lat, lon] for folium
                        coordinates.append([lat, lon])

                        # Add to current path group with altitude
                        if alt is not None:
                            current_path.append([lat, lon, alt])

                        element_coords += 1
                    except ValueError as e:
                        # Skip invalid coordinates
                        logger.debug(f"Failed to parse coordinate '{point}': {e}")
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

            if element_coords > 0:
                coord_type = "Point" if element_coords == 1 else f"Path ({element_coords} points)"
                logger.debug(f"Element {idx}: {coord_type}")

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
                            logger.debug(f"Found gx:Track start timestamp: {gx_timestamp}")

                        # Get last timestamp (end time) if available
                        if len(time_elems) > 1 and time_elems[-1].text:
                            gx_end_timestamp = time_elems[-1].text.strip()
                            logger.debug(f"Found gx:Track end timestamp: {gx_end_timestamp}")
                    elif gx_airport_name:
                        # Try to extract date from name
                        match = DATE_PATTERN.search(gx_airport_name)
                        if match:
                            gx_timestamp = match.group(1)
                            logger.debug(f"Extracted timestamp from gx:Track name: {gx_timestamp}")

                    if gx_timestamp is None:
                        logger.debug(f"No timestamp found for gx:Track with name: {gx_airport_name}")

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

                        # Inline validation (faster than function calls)
                        if not (LAT_RANGE[0] <= lat <= LAT_RANGE[1] and LON_RANGE[0] <= lon <= LON_RANGE[1]):
                            logger.debug(f"Invalid coordinates [{lat}, {lon}] in {Path(kml_file).name} (gx:Track)")
                            continue

                        # Validate altitude if present
                        if alt is not None and not (ALT_RANGE[0] <= alt <= ALT_RANGE[1]):
                            logger.debug(f"Invalid altitude {alt}m in {Path(kml_file).name} (gx:Track)")
                            alt = None

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
                        logger.debug(f"Failed to parse gx:coord: {coord_text}")
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

            logger.debug(f"Parsed {len(gx_coords)} gx:coord elements into 1 track")

        # Count total points with altitude across all path groups
        total_alt_points = sum(len(path) for path in path_groups)

        logger.info(f"✓ Loaded {len(coordinates)} points from {Path(kml_file).name}")
        if path_groups:
            print(f"  ({total_alt_points} points have altitude data in {len(path_groups)} path(s))")

        if len(coordinates) == 0:
            print(f"  WARNING: No valid coordinates found!")
            print(f"  This could mean:")
            print(f"    - The KML file uses a different structure")
            print(f"    - The coordinates are in an unexpected format")
            print(f"    - Try running with --debug flag for more information")

        # Save to cache
        if cache_path:
            save_to_cache(cache_path, coordinates, path_groups, path_metadata)

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
