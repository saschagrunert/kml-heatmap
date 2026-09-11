"""Shared KML parsing utilities and helpers."""

import math
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING

from .aircraft import parse_aircraft_from_filename
from .airport_lookup import standardize_airport_name
from .constants import ALT_MAX_M, ALT_MIN_M, LAT_MAX, LAT_MIN, LON_MAX, LON_MIN
from .logger import logger

if TYPE_CHECKING:
    from lxml import etree

    from .types import PathMetadata, PlacemarkMetadata, TrackPoint

# Pre-compiled regex patterns for performance
DATE_PATTERN = re.compile(r"(\d{2}\s+\w{3}\s+\d{4}|\d{4}-\d{2}-\d{2})")
YEAR_PATTERN = re.compile(r"\b(20\d{2})\b")
# Charterware description: "Flight Jan 12 2026 03:01PM" or "Flight January 12 ..."
CHARTERWARE_PATTERN = re.compile(
    r"Flight\s+(\w{3,9})\s+(\d{1,2})\s+(\d{4})\s+(\d{2}):(\d{2})(AM|PM)"
)


def empty_placemark_metadata() -> PlacemarkMetadata:
    """Return placemark metadata with no information."""
    return {
        "airport_name": None,
        "timestamp": None,
        "end_timestamp": None,
        "year": None,
    }


def extract_year_from_timestamp(timestamp: str | None) -> int | None:
    """Extract year from a timestamp string."""
    if not timestamp:
        return None

    try:
        # Try to parse ISO format timestamp (e.g., "2025-03-03T08:58:01Z")
        if "T" in timestamp:
            return datetime.fromisoformat(timestamp).year
        # Try to extract year from date string (e.g., "03 Mar 2025" or "2025-03-03")
        year_match = YEAR_PATTERN.search(timestamp)
        if year_match:
            return int(year_match.group(1))
    except (ValueError, AttributeError, TypeError) as e:
        logger.debug("Could not parse timestamp '%s': %s", timestamp, e)

    return None


def validate_and_normalize_coordinate(
    lat: float, lon: float, alt: float | None, filename: str
) -> tuple[float, float, float | None] | None:
    """Validate a coordinate point.

    Returns None if the latitude/longitude are invalid. An altitude that is
    non-finite or outside the plausible range is treated as missing (None);
    valid negative altitudes (down to ALT_MIN_M) are kept.
    """
    if not (
        math.isfinite(lat)
        and math.isfinite(lon)
        and LAT_MIN <= lat <= LAT_MAX
        and LON_MIN <= lon <= LON_MAX
    ):
        logger.debug("Invalid coordinates [%s, %s] in %s", lat, lon, filename)
        return None

    normalized_alt = alt
    if alt is not None and not (math.isfinite(alt) and ALT_MIN_M <= alt <= ALT_MAX_M):
        logger.debug("Invalid altitude %sm in %s, treating as missing", alt, filename)
        normalized_alt = None

    return (lat, lon, normalized_alt)


def parse_coordinate_point(
    point: str, kml_file: str
) -> tuple[float, float, float | None] | None:
    """Parse a single coordinate point from KML format (lon,lat[,alt])."""
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
    except ValueError as e:
        logger.debug("Failed to parse coordinate '%s': %s", point, e)
        return None

    return validate_and_normalize_coordinate(lat, lon, alt, Path(kml_file).name)


def find_xml_element(
    parent: etree._Element,
    namespaced_path: str,
    fallback_path: str,
    namespaces: dict[str, str],
) -> etree._Element | None:
    """Find XML element trying namespaced path first, then fallback."""
    elem = parent.find(namespaced_path, namespaces)
    if elem is None:
        elem = parent.find(fallback_path)
    return elem


def find_xml_elements(
    parent: etree._Element,
    namespaced_path: str,
    fallback_path: str,
    namespaces: dict[str, str],
) -> list[etree._Element]:
    """Find XML elements trying namespaced path first, then fallback."""
    elems: list[etree._Element] = parent.findall(namespaced_path, namespaces)
    if not elems:
        elems = parent.findall(fallback_path)
    return elems


def _element_text(elem: etree._Element | None) -> str | None:
    if elem is None or not elem.text:
        return None
    return elem.text.strip() or None


def extract_charterware_timestamp(description: str | None) -> str | None:
    """Extract an ISO timestamp from a Charterware description field."""
    if not description:
        return None

    match = CHARTERWARE_PATTERN.search(description)
    if not match:
        return None

    month_str, day, year, hour_str, minute, meridiem = match.groups()

    # Convert 12-hour to 24-hour
    hour = int(hour_str)
    if meridiem == "PM" and hour != 12:
        hour += 12
    elif meridiem == "AM" and hour == 12:
        hour = 0

    dt_str = f"{day} {month_str} {year} {hour:02d}:{minute}"
    # Short month name first (Jan), then full month name (January)
    for fmt in ("%d %b %Y %H:%M", "%d %B %Y %H:%M"):
        try:
            return datetime.strptime(dt_str, fmt).replace(tzinfo=UTC).isoformat()
        except ValueError:
            continue

    logger.debug("Failed to parse Charterware timestamp: %s", description)
    return None


def _extract_time_range(
    placemark: etree._Element, namespaces: dict[str, str]
) -> tuple[str | None, str | None]:
    """The first and last timestamp of a placemark.

    ``<when>`` elements (gx:Track and TimeStamp) win; a placemark without
    them may still carry a ``<TimeSpan>`` with ``<begin>`` and ``<end>``.
    """
    time_elems = find_xml_elements(placemark, ".//kml:when", ".//when", namespaces)
    if time_elems:
        timestamp = _element_text(time_elems[0])
        end_timestamp = _element_text(time_elems[-1]) if len(time_elems) > 1 else None
        return timestamp, end_timestamp

    begin = find_xml_element(
        placemark, ".//kml:TimeSpan/kml:begin", ".//TimeSpan/begin", namespaces
    )
    end = find_xml_element(
        placemark, ".//kml:TimeSpan/kml:end", ".//TimeSpan/end", namespaces
    )
    return _element_text(begin), _element_text(end)


def extract_placemark_metadata(
    placemark: etree._Element, namespaces: dict[str, str]
) -> PlacemarkMetadata:
    """Extract metadata from a KML Placemark element."""
    name_elem = find_xml_element(placemark, ".//kml:name", ".//name", namespaces)
    kml_name = _element_text(name_elem)

    # Standardize airport name using ICAO codes from the name itself
    airport_name = standardize_airport_name(kml_name)

    timestamp, end_timestamp = _extract_time_range(placemark, namespaces)

    if timestamp is None and kml_name:
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
        timestamp = extract_charterware_timestamp(_element_text(desc_elem))

    return {
        "airport_name": airport_name,
        "timestamp": timestamp,
        "end_timestamp": end_timestamp,
        "year": extract_year_from_timestamp(timestamp),
    }


def _build_path_metadata_dict(
    kml_file: str,
    path_start: TrackPoint,
    placemark_meta: PlacemarkMetadata,
) -> PathMetadata:
    """Build path metadata dictionary."""
    aircraft_info = parse_aircraft_from_filename(Path(kml_file).name)
    airport_name = placemark_meta["airport_name"]

    # For Charterware files, use route information for airport name
    # Route format: DEPARTURE-ARRIVAL (e.g., LOAV-LOAV or EDDF-EDDM)
    # Convert to exporter format: "DEPARTURE - ARRIVAL" (with spaces around hyphen)
    route = aircraft_info.get("route")
    if aircraft_info.get("format") == "charterware" and route and "-" in route:
        departure_airport, arrival_airport = route.split("-", 1)
        # Use route as airport_name if name is empty or not an ICAO code
        # (ICAO codes are exactly 4 uppercase letters, registrations have hyphens)
        if not airport_name or len(airport_name) != 4:
            airport_name = standardize_airport_name(
                f"{departure_airport} - {arrival_airport}"
            )

    start_point = [path_start.lat, path_start.lon]
    if path_start.alt is not None:
        start_point.append(path_start.alt)

    meta: PathMetadata = {
        "start_point": start_point,
        "airport_name": airport_name or "",
        "timestamp": placemark_meta["timestamp"],
        "end_timestamp": placemark_meta["end_timestamp"],
        "filename": Path(kml_file).name,
        "year": placemark_meta["year"],
    }

    if aircraft_info:
        meta["aircraft_registration"] = aircraft_info.get("registration")

        aircraft_type = aircraft_info.get("type")
        if aircraft_type is not None:
            meta["aircraft_type"] = aircraft_type

    return meta
