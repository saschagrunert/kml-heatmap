"""Shared KML parsing utilities and helpers."""

import re
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from .aircraft import parse_aircraft_from_filename
from .airport_lookup import standardize_airport_name
from .kml_parsers import validate_and_normalize_coordinate
from .logger import logger
from .constants import (
    MID_FLIGHT_MIN_ALTITUDE_M,
    MID_FLIGHT_MAX_VARIATION_M,
    LANDING_MAX_VARIATION_M,
    LANDING_MAX_ALTITUDE_M,
    LANDING_FALLBACK_ALTITUDE_M,
    PATH_SAMPLE_MAX_SIZE,
    PATH_SAMPLE_MIN_SIZE,
)

# Pre-compiled regex patterns for performance
DATE_PATTERN = re.compile(r"(\d{2}\s+\w{3}\s+\d{4}|\d{4}-\d{2}-\d{2})")
YEAR_PATTERN = re.compile(r"\b(20\d{2})\b")


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
        if "T" in timestamp:
            dt = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
            return dt.year
        # Try to extract year from date string (e.g., "03 Mar 2025" or "2025-03-03")
        year_match = YEAR_PATTERN.search(timestamp)
        if year_match:
            return int(year_match.group(1))
    except (ValueError, AttributeError, TypeError) as e:
        logger.debug(f"Could not parse timestamp '{timestamp}': {e}")

    return None


def sample_path_altitudes(
    path: List[List[float]], from_end: bool = False
) -> Optional[Dict[str, float]]:
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
    return {"min": min(alts), "max": max(alts), "variation": max(alts) - min(alts)}


def is_mid_flight_start(
    path: List[List[float]], start_alt: float, debug: bool = False
) -> bool:
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
    is_mid_flight = (
        start_alt > MID_FLIGHT_MIN_ALTITUDE_M
        and sample["variation"] < MID_FLIGHT_MAX_VARIATION_M
    )

    if is_mid_flight and debug:
        logger.debug(
            f"Detected mid-flight start at {start_alt:.0f}m (variation: {sample['variation']:.0f}m)"
        )

    return is_mid_flight


def is_valid_landing(
    path: List[List[float]], end_alt: float, debug: bool = False
) -> bool:
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
    return (
        sample["variation"] < LANDING_MAX_VARIATION_M
        or end_alt < LANDING_MAX_ALTITUDE_M
    )


def parse_coordinate_point(
    point: str, kml_file: str
) -> Optional[Tuple[float, float, Optional[float]]]:
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

    parts = point.split(",")
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


def find_xml_element(
    parent: Any, namespaced_path: str, fallback_path: str, namespaces: Dict[str, str]
) -> Optional[Any]:
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


def find_xml_elements(
    parent: Any, namespaced_path: str, fallback_path: str, namespaces: Dict[str, str]
) -> List[Any]:
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
    elems: List[Any] = parent.findall(namespaced_path, namespaces)
    if not elems:
        elems = parent.findall(fallback_path)
    return elems


def extract_charterware_timestamp(description: str) -> Optional[str]:
    """
    Extract timestamp from Charterware description field.

    Example: "Flight Jan 12 2026 03:01PM path of OE-AKI"
    Returns ISO-format timestamp like "2026-01-12T15:01:00Z"

    Args:
        description: Description text from Charterware KML

    Returns:
        ISO-format timestamp or None if extraction fails
    """
    if not description:
        return None

    # Pattern: "Flight Jan 12 2026 03:01PM" or "Flight January 12 2026 03:01PM"
    pattern = r"Flight\s+(\w{3,9})\s+(\d{1,2})\s+(\d{4})\s+(\d{2}):(\d{2})(AM|PM)"
    match = re.search(pattern, description)

    if match:
        month_str, day, year, hour, minute, meridiem = match.groups()

        # Convert 12-hour to 24-hour
        hour = int(hour)
        if meridiem == "PM" and hour != 12:
            hour += 12
        elif meridiem == "AM" and hour == 12:
            hour = 0

        # Parse month name (supports both short and full month names)
        try:
            dt_str = f"{day} {month_str} {year} {hour:02d}:{minute}"
            # Try short month name first (Jan, Feb, etc.)
            dt = datetime.strptime(dt_str, "%d %b %Y %H:%M")
        except ValueError:
            # Try full month name (January, February, etc.)
            try:
                dt = datetime.strptime(dt_str, "%d %B %Y %H:%M")
            except ValueError:
                logger.debug(f"Failed to parse Charterware timestamp: {description}")
                return None

        # Return ISO format with UTC timezone
        return dt.isoformat() + "Z"

    return None


def extract_placemark_metadata(
    placemark: Any, namespaces: Dict[str, str], kml_file: Optional[str] = None
) -> Dict[str, Any]:
    """
    Extract metadata from a KML Placemark element.

    Args:
        placemark: XML element representing a Placemark
        namespaces: XML namespace dict
        kml_file: Optional KML filename (unused, kept for backward compatibility)

    Returns:
        Dict with 'airport_name', 'timestamp', 'end_timestamp', 'year' keys
    """
    # Extract name from KML
    name_elem = find_xml_element(placemark, ".//kml:name", ".//name", namespaces)
    kml_name = (
        name_elem.text.strip() if name_elem is not None and name_elem.text else None
    )

    # Standardize airport name using ICAO codes from the name itself
    airport_name = standardize_airport_name(kml_name)

    # Extract timestamps - both start and end for tracks with multiple when elements
    time_elems = find_xml_elements(placemark, ".//kml:when", ".//when", namespaces)

    # Also try TimeStamp element (single timestamp)
    if not time_elems:
        time_elem = find_xml_element(
            placemark, ".//kml:TimeStamp/kml:when", ".//TimeStamp/when", namespaces
        )
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
    elif kml_name:
        # Try to extract date from original KML name (before standardization)
        # (e.g., "Log Start: 03 Mar 2025 08:58 Z" or "EDDS to EDDP - 16 Aug 2026")
        match = DATE_PATTERN.search(kml_name)
        if match:
            timestamp = match.group(1)

    # If still no timestamp, check description for Charterware format
    if timestamp is None:
        desc_elem = find_xml_element(
            placemark, ".//kml:description", ".//description", namespaces
        )
        if desc_elem is not None and desc_elem.text:
            # Try Charterware format: "Flight Jan 12 2026 03:01PM path of OE-AKI"
            timestamp = extract_charterware_timestamp(desc_elem.text.strip())

    year = extract_year_from_timestamp(timestamp)

    return {
        "airport_name": airport_name,
        "timestamp": timestamp,
        "end_timestamp": end_timestamp,
        "year": year,
    }


def _build_path_metadata_dict(
    kml_file: str,
    path_start: List[float],
    airport_name: Optional[str],
    timestamp: Optional[str],
    end_timestamp: Optional[str],
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

    # For Charterware files, use route information for airport name
    # Route format: DEPARTURE-ARRIVAL (e.g., LOAV-LOAV or EDDF-EDDM)
    # Convert to exporter format: "DEPARTURE - ARRIVAL" (with spaces around hyphen)
    if (
        aircraft_info
        and aircraft_info.get("route")
        and aircraft_info.get("format") == "charterware"
    ):
        route = aircraft_info.get("route")
        # Extract airports from route and format for exporter
        if route and "-" in route:
            route_parts = route.split("-")
            departure_airport = route_parts[0]
            arrival_airport = route_parts[1]
            # Use route as airport_name if current name is empty or is not a 4-letter ICAO code
            # ICAO codes are exactly 4 uppercase letters (e.g., LOAV, EDDF, EDDM)
            # Aircraft registrations contain hyphens (e.g., OE-AKI, D-EXYZ)
            # Format: "DEPARTURE - ARRIVAL" (with spaces) for exporter compatibility
            if not airport_name or len(airport_name) != 4:
                airport_name = f"{departure_airport} - {arrival_airport}"
                # Look up full airport names from ICAO codes
                airport_name = standardize_airport_name(airport_name)

    meta = {
        "timestamp": timestamp,
        "end_timestamp": end_timestamp,
        "filename": Path(kml_file).name,
        "start_point": path_start,
        "airport_name": airport_name,
        "year": year,
    }

    # Add aircraft info if available
    if aircraft_info:
        meta["aircraft_registration"] = aircraft_info.get("registration")

        # Handle optional aircraft type (may be None for Charterware)
        aircraft_type = aircraft_info.get("type")
        if aircraft_type is not None:
            meta["aircraft_type"] = aircraft_type

        # Handle optional route (Charterware specific)
        route = aircraft_info.get("route")
        if route is not None:
            meta["route"] = route

    return meta
