"""KML file parsing functionality.

This module provides comprehensive KML (Keyhole Markup Language) parsing for
flight tracking data, supporting both standard KML and Google Earth Track formats.

Key Features:
- Parses standard KML <coordinates> elements
- Supports Google Earth Track (gx:coord) extension
- Extracts timestamps and metadata from Placemarks
- Caches parsed results for performance
- Detects mid-flight starts and validates landings
- Handles various coordinate formats and namespaces

Performance:
- File-based caching with modification time tracking
- Inline validation for coordinate parsing speed
- Pre-compiled regex patterns for timestamp extraction
- lxml support for faster XML parsing when available

Coordinate Formats:
- Standard KML: "lon,lat,alt" (comma-separated)
- Google Earth Track: "lon lat alt" (space-separated)
- Optional altitude values (defaults to None if missing)
- Automatic clamping of negative altitudes to 0

Example:
    >>> from kml_heatmap.parser import parse_kml_coordinates
    >>> coords, paths, metadata = parse_kml_coordinates('flight.kml')
    >>> print(f"Loaded {len(coords)} points from {len(paths)} paths")
    Loaded 1234 points from 3 paths
"""

import re
import os
import json
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
from .logger import logger
from .kml_parsers import validate_and_normalize_coordinate
from .constants import (
    MID_FLIGHT_MIN_ALTITUDE_M,
    MID_FLIGHT_MAX_VARIATION_M,
    LANDING_MAX_VARIATION_M,
    LANDING_MAX_ALTITUDE_M,
    LANDING_FALLBACK_ALTITUDE_M,
    PATH_SAMPLE_MAX_SIZE,
    PATH_SAMPLE_MIN_SIZE,
    LAT_MIN,
    LAT_MAX,
    LON_MIN,
    LON_MAX,
    ALT_MIN_M,
    ALT_MAX_M,
    CACHE_DIR_NAME,
    KML_NAMESPACES,
)

__all__ = [
    'USING_LXML',
    'get_cache_key',
    'load_cached_parse',
    'save_to_cache',
    'extract_year_from_timestamp',
    'sample_path_altitudes',
    'is_mid_flight_start',
    'is_valid_landing',
    'parse_kml_coordinates',
    'parse_coordinate_point',
    'find_xml_element',
    'find_xml_elements',
    'extract_placemark_metadata',
    'process_standard_coordinates',
    'process_gx_track',
]

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
    except (ValueError, AttributeError, TypeError) as e:
        logger.debug(f"Could not parse timestamp '{timestamp}': {e}")

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
        return end_alt < LANDING_FALLBACK_ALTITUDE_M

    # Valid landing: either descending significantly OR stable at low variation
    # Also accept any endpoint if variation at end is small - indicates stable landing
    return sample['variation'] < LANDING_MAX_VARIATION_M or end_alt < LANDING_MAX_ALTITUDE_M


def parse_coordinate_point(point: str, kml_file: str) -> Optional[Tuple[float, float, Optional[float]]]:
    """
    Parse a single coordinate point from KML format.

    Args:
        point: Coordinate string in format "lon,lat,alt" or "lon,lat"
        kml_file: Path to KML file (for error messages)

    Returns:
        Tuple of (lat, lon, alt) or None if invalid
    """
    point = point.strip()
    if not point:
        return None

    parts = point.split(',')
    if len(parts) < 2:
        return None

    try:
        lon = float(parts[0])
        lat = float(parts[1])
        alt = float(parts[2]) if len(parts) >= 3 else None

        # Use centralized validation and normalization
        return validate_and_normalize_coordinate(lat, lon, alt, Path(kml_file).name)
    except ValueError as e:
        logger.debug(f"Failed to parse coordinate '{point}': {e}")
        return None


def find_xml_element(parent: Any, namespaced_path: str, fallback_path: str, namespaces: Dict[str, str]) -> Optional[Any]:
    """
    Find XML element trying namespaced path first, then fallback without namespace.

    Args:
        parent: Parent XML element to search within
        namespaced_path: XPath with namespace prefix (e.g., './/kml:name')
        fallback_path: XPath without namespace (e.g., './/name')
        namespaces: XML namespace dict

    Returns:
        Found XML element or None
    """
    elem = parent.find(namespaced_path, namespaces)
    if elem is None:
        elem = parent.find(fallback_path)
    return elem


def find_xml_elements(parent: Any, namespaced_path: str, fallback_path: str, namespaces: Dict[str, str]) -> List[Any]:
    """
    Find XML elements trying namespaced path first, then fallback without namespace.

    Args:
        parent: Parent XML element to search within
        namespaced_path: XPath with namespace prefix (e.g., './/kml:when')
        fallback_path: XPath without namespace (e.g., './/when')
        namespaces: XML namespace dict

    Returns:
        List of found XML elements (empty list if none found)
    """
    elems = parent.findall(namespaced_path, namespaces)
    if not elems:
        elems = parent.findall(fallback_path)
    return elems


def extract_placemark_metadata(placemark: Any, namespaces: Dict[str, str]) -> Dict[str, Any]:
    """
    Extract metadata from a KML Placemark element.

    Args:
        placemark: XML element representing a Placemark
        namespaces: XML namespace dict

    Returns:
        Dict with 'airport_name', 'timestamp', 'end_timestamp', 'year' keys
    """
    # Extract name
    name_elem = find_xml_element(placemark, './/kml:name', './/name', namespaces)
    airport_name = name_elem.text.strip() if name_elem is not None and name_elem.text else None

    # Extract timestamps - both start and end for tracks with multiple when elements
    time_elems = find_xml_elements(placemark, './/kml:when', './/when', namespaces)

    # Also try TimeStamp element (single timestamp)
    if not time_elems:
        time_elem = find_xml_element(placemark, './/kml:TimeStamp/kml:when', './/TimeStamp/when', namespaces)
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

    year = extract_year_from_timestamp(timestamp)

    return {
        'airport_name': airport_name,
        'timestamp': timestamp,
        'end_timestamp': end_timestamp,
        'year': year
    }


def _build_path_metadata_dict(
    kml_file: str,
    path_start: List[float],
    airport_name: Optional[str],
    timestamp: Optional[str],
    end_timestamp: Optional[str]
) -> Dict[str, Any]:
    """
    Build path metadata dictionary.

    Args:
        kml_file: Path to KML file
        path_start: First coordinate of path [lat, lon, alt]
        airport_name: Airport name from metadata
        timestamp: Start timestamp
        end_timestamp: End timestamp

    Returns:
        Dict with path metadata
    """
    year = extract_year_from_timestamp(timestamp)
    aircraft_info = parse_aircraft_from_filename(Path(kml_file).name)

    meta = {
        'timestamp': timestamp,
        'end_timestamp': end_timestamp,
        'filename': Path(kml_file).name,
        'start_point': path_start,
        'airport_name': airport_name,
        'year': year
    }

    # Add aircraft info if available
    if aircraft_info:
        meta['aircraft_registration'] = aircraft_info.get('registration')
        meta['aircraft_type'] = aircraft_info.get('type')

    return meta


def process_standard_coordinates(
    coord_elements: List[Any],
    coord_to_metadata: Dict[int, Dict[str, Any]],
    kml_file: str,
    coordinates: List[List[float]],
    path_groups: List[List[List[float]]],
    path_metadata: List[Dict[str, Any]]
) -> None:
    """
    Process standard KML <coordinates> elements.

    Args:
        coord_elements: List of XML coordinate elements
        coord_to_metadata: Mapping from element ID to metadata dict
        kml_file: Path to KML file
        coordinates: Output list for all [lat, lon] pairs
        path_groups: Output list for path groups with altitude
        path_metadata: Output list for path metadata
    """
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

        # Split by whitespace (spaces, tabs, newlines)
        points = coord_text.split()

        # Create a new path group for this coordinate element
        current_path = []
        element_coords = 0

        for point in points:
            parsed = parse_coordinate_point(point, kml_file)
            if parsed is None:
                continue

            lat, lon, alt = parsed

            # Swap to [lat, lon] for folium
            coordinates.append([lat, lon])

            # Add to current path group with altitude
            if alt is not None:
                current_path.append([lat, lon, alt])

            element_coords += 1

        # Add this path group to the list if it has coordinates
        if current_path:
            path_groups.append(current_path)
            meta = _build_path_metadata_dict(
                kml_file, current_path[0], airport_name, timestamp, end_timestamp
            )
            path_metadata.append(meta)

        if element_coords > 0:
            coord_type = "Point" if element_coords == 1 else f"Path ({element_coords} points)"
            logger.debug(f"Element {idx}: {coord_type}")


def _extract_gx_track_metadata(
    placemarks: List[Any],
    namespaces: Dict[str, str]
) -> Dict[str, Optional[str]]:
    """
    Extract metadata from gx:Track placemarks.

    Args:
        placemarks: List of Placemark XML elements
        namespaces: XML namespace dict

    Returns:
        Dict with 'airport_name', 'timestamp', 'end_timestamp' keys
    """
    for placemark in placemarks:
        # Check if this placemark contains gx:coord elements
        placemark_gx_coords = find_xml_elements(placemark, './/gx:coord', './/coord', namespaces)

        if placemark_gx_coords:
            meta = extract_placemark_metadata(placemark, namespaces)

            if meta['timestamp']:
                logger.debug(f"Found gx:Track start timestamp: {meta['timestamp']}")
            if meta['end_timestamp']:
                logger.debug(f"Found gx:Track end timestamp: {meta['end_timestamp']}")
            if meta['timestamp'] is None and meta['airport_name']:
                logger.debug(f"No timestamp found for gx:Track with name: {meta['airport_name']}")

            return meta

    return {'airport_name': None, 'timestamp': None, 'end_timestamp': None, 'year': None}


def _extract_gx_when_elements(
    placemarks: List[Any],
    gx_coords: List[Any],
    namespaces: Dict[str, str]
) -> List[Any]:
    """
    Extract <when> elements that correspond to gx:coord elements.

    Args:
        placemarks: List of Placemark XML elements
        gx_coords: List of gx:coord elements
        namespaces: XML namespace dict

    Returns:
        List of <when> elements matching gx:coord count
    """
    for placemark in placemarks:
        when_elems = find_xml_elements(placemark, './/kml:when', './/when', namespaces)
        if when_elems and len(when_elems) == len(gx_coords):
            return when_elems
    return []


def _parse_gx_coordinates(
    gx_coords: List[Any],
    when_elems: List[Any],
    kml_file: str,
    coordinates: List[List[float]]
) -> List[List[Any]]:
    """
    Parse gx:coord elements into path coordinates.

    Args:
        gx_coords: List of gx:coord XML elements
        when_elems: List of corresponding <when> timestamp elements
        kml_file: Path to KML file (for error messages)
        coordinates: Output list for [lat, lon] pairs

    Returns:
        List of parsed coordinates with altitude and timestamps
    """
    gx_path = []

    for idx, gx_coord in enumerate(gx_coords):
        if gx_coord.text is None:
            continue

        coord_text = gx_coord.text.strip()
        if not coord_text:
            continue

        parts = coord_text.split()
        if len(parts) < 2:
            continue

        try:
            lon = float(parts[0])
            lat = float(parts[1])
            alt = float(parts[2]) if len(parts) >= 3 else None

            # Use centralized validation and normalization
            validated = validate_and_normalize_coordinate(lat, lon, alt, f"{Path(kml_file).name} (gx:Track)")
            if validated is None:
                continue

            lat, lon, alt = validated

            # Get corresponding timestamp
            timestamp_str = None
            if idx < len(when_elems) and when_elems[idx].text:
                timestamp_str = when_elems[idx].text.strip()

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

    return gx_path


def process_gx_track(
    gx_coords: List[Any],
    placemarks: List[Any],
    namespaces: Dict[str, str],
    kml_file: str,
    coordinates: List[List[float]],
    path_groups: List[List[List[float]]],
    path_metadata: List[Dict[str, Any]]
) -> None:
    """
    Process Google Earth Track (gx:coord) elements.

    Args:
        gx_coords: List of gx:coord XML elements
        placemarks: List of Placemark XML elements
        namespaces: XML namespace dict
        kml_file: Path to KML file
        coordinates: Output list for all [lat, lon] pairs
        path_groups: Output list for path groups with altitude
        path_metadata: Output list for path metadata
    """
    if not gx_coords:
        return

    # Extract metadata from placemarks
    track_meta = _extract_gx_track_metadata(placemarks, namespaces)

    # Extract timestamp elements
    when_elems = _extract_gx_when_elements(placemarks, gx_coords, namespaces)

    # Parse coordinates
    gx_path = _parse_gx_coordinates(gx_coords, when_elems, kml_file, coordinates)

    # Add gx:Track as a single path group
    if gx_path:
        path_groups.append(gx_path)
        meta = _build_path_metadata_dict(
            kml_file,
            gx_path[0],
            track_meta['airport_name'],
            track_meta['timestamp'],
            track_meta['end_timestamp']
        )
        path_metadata.append(meta)

    logger.debug(f"Parsed {len(gx_coords)} gx:coord elements into 1 track")


def _parse_kml_tree(kml_file: str) -> Optional[Any]:
    """
    Parse KML file and return XML root element.

    Args:
        kml_file: Path to KML file

    Returns:
        XML root element or None on error
    """
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

        return root

    except ET.ParseError as e:
        logger.error(f"XML parsing error in {kml_file}: {e}")
        logger.error("The file may be corrupted or not a valid KML file")
        return None
    except (IOError, OSError) as e:
        logger.error(f"File I/O error parsing {kml_file}: {e}")
        return None


def _extract_kml_elements(root: Any, namespaces: Dict[str, str]) -> Tuple[List[Any], List[Any], List[Any]]:
    """
    Extract coordinate elements and placemarks from KML root.

    Args:
        root: XML root element
        namespaces: XML namespace dict

    Returns:
        Tuple of (coord_elements, gx_coords, placemarks)
    """
    # Try with namespace
    coord_elements = root.findall('.//kml:coordinates', namespaces)
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

    # Find all Placemarks
    placemarks = root.findall('.//kml:Placemark', namespaces)
    if not placemarks:
        placemarks = root.findall('.//Placemark')  # Without namespace

    return coord_elements, gx_coords, placemarks


def _build_coord_metadata_map(
    placemarks: List[Any],
    namespaces: Dict[str, str]
) -> Dict[int, Dict[str, Any]]:
    """
    Create mapping from coordinate elements to their metadata.

    Args:
        placemarks: List of Placemark XML elements
        namespaces: XML namespace dict

    Returns:
        Dict mapping element ID to metadata dict
    """
    coord_to_metadata = {}
    for placemark in placemarks:
        # Find coordinates within this placemark
        placemark_coords = find_xml_elements(placemark, './/kml:coordinates', './/coordinates', namespaces)

        # Extract metadata using helper function
        metadata = extract_placemark_metadata(placemark, namespaces)

        # Store metadata for each coordinates element in this placemark
        for coord_elem in placemark_coords:
            coord_to_metadata[id(coord_elem)] = metadata

    return coord_to_metadata


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
                logger.info(f"  ({total_alt_points} points have altitude data in {len(path_groups)} path(s))")
            return coordinates, path_groups, path_metadata

    # Initialize output lists
    coordinates = []
    path_groups = []
    path_metadata = []

    try:
        # Parse KML file
        root = _parse_kml_tree(kml_file)
        if root is None:
            return [], [], []

        # KML namespaces
        namespaces = {
            'kml': 'http://www.opengis.net/kml/2.2',
            'gx': 'http://www.google.com/kml/ext/2.2'
        }

        # Extract elements
        coord_elements, gx_coords, placemarks = _extract_kml_elements(root, namespaces)

        # Build metadata mapping
        coord_to_metadata = _build_coord_metadata_map(placemarks, namespaces)

        # Process standard KML coordinates
        process_standard_coordinates(
            coord_elements,
            coord_to_metadata,
            kml_file,
            coordinates,
            path_groups,
            path_metadata
        )

        # Process Google Earth Track (gx:coord) elements
        process_gx_track(
            gx_coords,
            placemarks,
            namespaces,
            kml_file,
            coordinates,
            path_groups,
            path_metadata
        )

        # Log results
        total_alt_points = sum(len(path) for path in path_groups)
        logger.info(f"✓ Loaded {len(coordinates)} points from {Path(kml_file).name}")
        if path_groups:
            logger.info(f"  ({total_alt_points} points have altitude data in {len(path_groups)} path(s))")

        if len(coordinates) == 0:
            logger.warning("No valid coordinates found!")
            logger.warning("This could mean:")
            logger.warning("  - The KML file uses a different structure")
            logger.warning("  - The coordinates are in an unexpected format")
            logger.warning("  - Try running with --debug flag for more information")

        # Save to cache
        if cache_path:
            save_to_cache(cache_path, coordinates, path_groups, path_metadata)

        return coordinates, path_groups, path_metadata

    except (ValueError, TypeError, AttributeError) as e:
        logger.error(f"Data parsing error in {kml_file}: {e}")
        logger.debug("Stack trace:", exc_info=True)
        return [], [], []
