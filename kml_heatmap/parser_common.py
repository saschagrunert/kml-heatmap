"""Shared KML parsing utilities and helpers."""

import re
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING

from .aircraft import parse_aircraft_from_filename
from .airport_lookup import standardize_airport_name
from .constants import (
    LANDING_FALLBACK_ALTITUDE_M,
    LANDING_MAX_ALTITUDE_M,
    LANDING_MAX_VARIATION_M,
    MID_FLIGHT_MAX_VARIATION_M,
    MID_FLIGHT_MIN_ALTITUDE_M,
    PATH_SAMPLE_MAX_SIZE,
    PATH_SAMPLE_MIN_SIZE,
)
from .kml_parsers import validate_and_normalize_coordinate
from .logger import logger

if TYPE_CHECKING:
    from lxml import etree

    from .types import FlightPath, PathMetadata, PlacemarkMetadata, TrackPoint

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


def sample_path_altitudes(
    path: FlightPath, from_end: bool = False
) -> dict[str, float] | None:
    """Extract altitude statistics from a path sample."""
    if len(path) <= 10:
        return None

    sample_size = min(PATH_SAMPLE_MAX_SIZE, len(path) // 4)
    if sample_size <= PATH_SAMPLE_MIN_SIZE:
        return None

    sample = path[-sample_size:] if from_end else path[:sample_size]
    alts = [point.alt for point in sample if point.alt is not None]
    if not alts:
        return None
    return {"min": min(alts), "max": max(alts), "variation": max(alts) - min(alts)}


def is_mid_flight_start(path: FlightPath, start_alt: float | None) -> bool:
    """Detect if a path started mid-flight by analyzing altitude patterns."""
    if start_alt is None:
        return False

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

    if is_mid_flight:
        logger.debug(
            "Detected mid-flight start at %.0fm (variation: %.0fm)",
            start_alt,
            sample["variation"],
        )

    return is_mid_flight


def is_valid_landing(path: FlightPath, end_alt: float | None) -> bool:
    """Check if a path ends with a valid landing."""
    sample = sample_path_altitudes(path, from_end=True)
    if not sample:
        # Short path, just accept if altitude seems reasonable
        return end_alt is not None and end_alt < LANDING_FALLBACK_ALTITUDE_M

    # Valid landing: either descending significantly OR stable at low variation
    # Also accept any endpoint if variation at end is small - indicates stable landing
    return sample["variation"] < LANDING_MAX_VARIATION_M or (
        end_alt is not None and end_alt < LANDING_MAX_ALTITUDE_M
    )


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


def extract_placemark_metadata(
    placemark: etree._Element, namespaces: dict[str, str]
) -> PlacemarkMetadata:
    """Extract metadata from a KML Placemark element."""
    name_elem = find_xml_element(placemark, ".//kml:name", ".//name", namespaces)
    kml_name = (
        name_elem.text.strip() if name_elem is not None and name_elem.text else None
    )

    # Standardize airport name using ICAO codes from the name itself
    airport_name = standardize_airport_name(kml_name)

    # Timestamps: <when> elements of gx:Track and TimeStamp/TimeSpan alike
    time_elems = find_xml_elements(placemark, ".//kml:when", ".//when", namespaces)

    timestamp = None
    end_timestamp = None
    if time_elems:
        if time_elems[0].text:
            timestamp = time_elems[0].text.strip()
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
            timestamp = extract_charterware_timestamp(desc_elem.text.strip())

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

        if route is not None:
            meta["route"] = route

    return meta
