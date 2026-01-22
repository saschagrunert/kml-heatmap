"""Specialized parsers for different KML coordinate formats.

This module breaks down the complex KML parsing logic into focused,
single-responsibility parsers for different KML formats.

KML Format Support:
1. Standard KML: <coordinates> elements with comma-separated values
2. Google Earth Track: gx:Track format with gx:coord and when elements
3. Placemark metadata: Extracts names, timestamps, and descriptions

Each parser is designed to:
- Handle one specific KML format
- Return consistent data structures
- Gracefully handle malformed data
- Log parsing issues for debugging
"""

from typing import List, Dict, Any, Optional, Tuple

from .logger import logger
from .constants import LAT_MIN, LAT_MAX, LON_MIN, LON_MAX, ALT_MIN_M, ALT_MAX_M
from .helpers import parse_iso_timestamp

__all__ = [
    "validate_coordinate",
    "validate_and_normalize_coordinate",
    "parse_coordinate_string",
    "parse_gx_coordinate_string",
]

# Pre-computed validation ranges
LAT_RANGE = (LAT_MIN, LAT_MAX)
LON_RANGE = (LON_MIN, LON_MAX)
ALT_RANGE = (ALT_MIN_M, ALT_MAX_M)


def validate_coordinate(
    lat: float, lon: float, alt: Optional[float], filename: str
) -> bool:
    """
    Validate a single coordinate point.

    Args:
        lat: Latitude
        lon: Longitude
        alt: Altitude (can be None)
        filename: Source filename for error messages

    Returns:
        True if valid, False otherwise
    """
    if not (
        LAT_RANGE[0] <= lat <= LAT_RANGE[1] and LON_RANGE[0] <= lon <= LON_RANGE[1]
    ):
        logger.debug(f"Invalid coordinates [{lat}, {lon}] in {filename}")
        return False

    if alt is not None and not (ALT_RANGE[0] <= alt <= ALT_RANGE[1]):
        logger.debug(f"Invalid altitude {alt}m in {filename}")
        return False

    return True


def validate_and_normalize_coordinate(
    lat: float, lon: float, alt: Optional[float], filename: str
) -> Optional[Tuple[float, float, Optional[float]]]:
    """
    Validate and normalize a coordinate point.

    This function combines validation and normalization in one step:
    - Validates latitude and longitude ranges
    - Validates altitude range (if provided)
    - Clamps negative altitudes to 0 (below sea level)
    - Returns None if coordinates are invalid

    Args:
        lat: Latitude
        lon: Longitude
        alt: Altitude in meters (can be None)
        filename: Source filename for error messages

    Returns:
        Tuple of (lat, lon, normalized_alt) or None if invalid

    Example:
        >>> coord = validate_and_normalize_coordinate(50.0, 8.0, -10.0, "test.kml")
        >>> coord
        (50.0, 8.0, 0.0)  # Negative altitude clamped to 0
    """
    # Validate latitude and longitude
    if not (
        LAT_RANGE[0] <= lat <= LAT_RANGE[1] and LON_RANGE[0] <= lon <= LON_RANGE[1]
    ):
        logger.debug(f"Invalid coordinates [{lat}, {lon}] in {filename}")
        return None

    # Validate and normalize altitude
    normalized_alt = alt
    if alt is not None:
        if not (ALT_RANGE[0] <= alt <= ALT_RANGE[1]):
            logger.debug(f"Invalid altitude {alt}m in {filename}")
            normalized_alt = None
        elif alt < 0:
            # Clamp negative altitudes to 0 (below sea level = 0)
            normalized_alt = 0.0

    return (lat, lon, normalized_alt)


def parse_coordinate_string(
    coord_str: str,
) -> Optional[Tuple[float, float, Optional[float]]]:
    """
    Parse KML coordinate string (lon,lat,alt or lon,lat).

    Args:
        coord_str: Coordinate string like "lon,lat,alt"

    Returns:
        Tuple of (lat, lon, alt) or None if parsing fails
    """
    parts = coord_str.split(",")
    if len(parts) < 2:
        return None

    try:
        lon = float(parts[0])
        lat = float(parts[1])
        alt = float(parts[2]) if len(parts) >= 3 else None
        return (lat, lon, alt)
    except (ValueError, IndexError):
        return None


def parse_gx_coordinate_string(
    coord_str: str,
) -> Optional[Tuple[float, float, Optional[float]]]:
    """
    Parse gx:coord string (lon lat alt - space-separated).

    Args:
        coord_str: Coordinate string like "lon lat alt"

    Returns:
        Tuple of (lat, lon, alt) or None if parsing fails
    """
    parts = coord_str.split()
    if len(parts) < 2:
        return None

    try:
        lon = float(parts[0])
        lat = float(parts[1])
        alt = float(parts[2]) if len(parts) >= 3 else None
        return (lat, lon, alt)
    except (ValueError, IndexError):
        return None


class PlacemarkMetadata:
    """Container for placemark metadata (names, timestamps, etc.)."""

    def __init__(self) -> None:
        """Initialize metadata with None values."""
        self.name: Optional[str] = None
        self.timestamp: Optional[str] = None
        self.end_timestamp: Optional[str] = None
        self.year: Optional[int] = None

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary format."""
        return {
            "airport_name": self.name,
            "timestamp": self.timestamp,
            "end_timestamp": self.end_timestamp,
            "year": self.year,
        }


def extract_placemark_metadata(
    placemark, namespaces: Dict[str, str]
) -> PlacemarkMetadata:
    """
    Extract metadata from a Placemark element.

    Args:
        placemark: XML Placemark element
        namespaces: XML namespace dict

    Returns:
        PlacemarkMetadata object
    """
    metadata = PlacemarkMetadata()

    # Extract name
    name_elem = placemark.find(".//kml:name", namespaces)
    if name_elem is None:
        name_elem = placemark.find(".//name")
    if name_elem is not None and name_elem.text:
        metadata.name = name_elem.text.strip()

    # Extract timestamps
    time_elems = placemark.findall(".//kml:when", namespaces)
    if not time_elems:
        time_elems = placemark.findall(".//when")

    # Also try TimeStamp element
    if not time_elems:
        time_elem = placemark.find(".//kml:TimeStamp/kml:when", namespaces)
        if time_elem is None:
            time_elem = placemark.find(".//TimeStamp/when")
        if time_elem is not None:
            time_elems = [time_elem]

    if time_elems and len(time_elems) > 0:
        if time_elems[0].text:
            metadata.timestamp = time_elems[0].text.strip()
        if len(time_elems) > 1 and time_elems[-1].text:
            metadata.end_timestamp = time_elems[-1].text.strip()

    # Extract year from timestamp
    if metadata.timestamp:
        dt = parse_iso_timestamp(metadata.timestamp)
        if dt:
            metadata.year = dt.year

    return metadata


def parse_standard_coordinates(
    coord_elem, metadata: PlacemarkMetadata, filename: str
) -> Tuple[List[List[float]], List[List[float]]]:
    """
    Parse standard KML <coordinates> element.

    Args:
        coord_elem: XML coordinates element
        metadata: Associated placemark metadata
        filename: Source filename for logging

    Returns:
        Tuple of (coordinates_2d, coordinates_3d)
        - coordinates_2d: [[lat, lon], ...]
        - coordinates_3d: [[lat, lon, alt], ...]

    Note:
        Synthetic timestamp generation for Charterware files is handled
        in parser.py during the main parsing flow.
    """
    if coord_elem.text is None or not coord_elem.text.strip():
        return [], []

    coordinates_2d = []
    coordinates_3d = []

    # Split by whitespace (spaces, tabs, newlines)
    points = coord_elem.text.split()

    for point in points:
        point = point.strip()
        if not point:
            continue

        parsed = parse_coordinate_string(point)
        if not parsed:
            logger.debug(f"Failed to parse coordinate '{point}' in {filename}")
            continue

        lat, lon, alt = parsed

        # Validate
        if not validate_coordinate(lat, lon, alt, filename):
            continue

        # Clamp negative altitudes to 0
        if alt is not None and alt < 0:
            alt = 0.0

        # Add to 2D list
        coordinates_2d.append([lat, lon])

        # Add to 3D list if altitude available
        if alt is not None:
            coordinates_3d.append([lat, lon, alt])

    return coordinates_2d, coordinates_3d


def parse_gx_track_coordinates(
    placemark, namespaces: Dict[str, str], filename: str
) -> Tuple[List[List[float]], List[List[float]], PlacemarkMetadata]:
    """
    Parse Google Earth Track (gx:Track) format.

    gx:Track uses separate gx:coord and when elements paired 1:1.

    Args:
        placemark: XML Placemark containing gx:Track
        namespaces: XML namespace dict
        filename: Source filename for logging

    Returns:
        Tuple of (coordinates_2d, coordinates_3d, metadata)
    """
    # Find gx:coord elements
    gx_coords = placemark.findall(".//gx:coord", namespaces)
    if not gx_coords:
        gx_coords = placemark.findall(".//coord")

    if not gx_coords:
        return [], [], PlacemarkMetadata()

    # Extract metadata
    metadata = extract_placemark_metadata(placemark, namespaces)

    # Get corresponding when elements
    when_elems = placemark.findall(".//kml:when", namespaces)
    if not when_elems:
        when_elems = placemark.findall(".//when")

    coordinates_2d = []
    coordinates_3d = []

    for idx, gx_coord in enumerate(gx_coords):
        if gx_coord.text is None or not gx_coord.text.strip():
            continue

        parsed = parse_gx_coordinate_string(gx_coord.text.strip())
        if not parsed:
            logger.debug(f"Failed to parse gx:coord '{gx_coord.text}' in {filename}")
            continue

        lat, lon, alt = parsed

        # Validate
        if not validate_coordinate(lat, lon, alt, filename):
            continue

        # Clamp negative altitudes to 0
        if alt is not None and alt < 0:
            alt = 0.0

        # Get corresponding timestamp
        timestamp_str = None
        if idx < len(when_elems) and when_elems[idx].text:
            timestamp_str = when_elems[idx].text.strip()

        # Add to 2D list
        coordinates_2d.append([lat, lon])

        # Add to 3D list
        if alt is not None:
            if timestamp_str:
                coordinates_3d.append([lat, lon, alt, timestamp_str])
            else:
                coordinates_3d.append([lat, lon, alt])

    return coordinates_2d, coordinates_3d, metadata


def remove_xml_namespaces(root):
    """
    Remove XML namespaces from all elements in tree.

    This is used as a fallback when namespace-aware parsing fails.

    Args:
        root: XML root element
    """
    for elem in root.iter():
        if "}" in elem.tag:
            elem.tag = elem.tag.split("}", 1)[1]
