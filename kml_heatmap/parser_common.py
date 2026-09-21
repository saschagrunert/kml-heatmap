"""Shared KML parsing utilities and helpers."""

import math
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING

from .airport_lookup import standardize_airport_names, standardize_route
from .constants import ALT_MAX_M, ALT_MIN_M, LAT_MAX, LAT_MIN, LON_MAX, LON_MIN
from .helpers import DATE_PATTERN, parse_iso_timestamp
from .logger import logger

if TYPE_CHECKING:
    from lxml import etree

    from .types import PathMetadata, PlacemarkMetadata, TrackPoint

# Pre-compiled regex patterns for performance
YEAR_PATTERN = re.compile(r"\b(20\d{2})\b")
# A KML time without a time of day: xsd:date, xsd:gYearMonth or xsd:gYear
_DATE_ONLY_PATTERN = re.compile(r"\d{4}(?:-\d{2}(?:-\d{2})?)?(?:Z|[+-]\d{2}:\d{2})?")
# Charterware description: "Flight Jan 12 2026 03:01PM" or "Flight January 12 ..."
CHARTERWARE_PATTERN = re.compile(
    r"Flight\s+(\w{3,9})\s+(\d{1,2})\s+(\d{4})\s+(\d{2}):(\d{2})(AM|PM)"
)


# altitudeMode values under which a coordinate's altitude is not its height
# above mean sea level. clampToGround (and clampToSeaFloor) tell a viewer to
# ignore the altitude; relativeToGround (and relativeToSeaFloor) make it a
# height above the terrain, which only a terrain model could turn into an
# altitude. Neither can be mixed into altitudes above sea level: the colors,
# the altitude statistics and the airport heuristics all compare them. So
# the altitudes of such a geometry are treated as unknown. A missing
# altitudeMode is read as absolute, although KML defaults to clampToGround:
# flight logs that leave it out still write altitudes above sea level.
NON_MSL_ALTITUDE_MODES = frozenset(
    {"clampToGround", "clampToSeaFloor", "relativeToGround", "relativeToSeaFloor"}
)


def local_name(tag: object) -> str:
    """Return the tag name of an element without its namespace."""
    if not isinstance(tag, str):
        return ""
    return tag.rsplit("}", 1)[-1]


def altitude_mode(geometry: etree._Element) -> str | None:
    """The altitudeMode (kml: or gx:) of a LineString or gx:Track, if any."""
    for child in geometry:
        if local_name(child.tag) == "altitudeMode":
            return (child.text or "").strip() or None
    return None


def empty_placemark_metadata() -> PlacemarkMetadata:
    """Return placemark metadata with no information."""
    return {
        "airport_name": None,
        "start_airport": None,
        "end_airport": None,
        "timestamp": None,
        "end_timestamp": None,
        "year": None,
    }


def extract_year_from_timestamp(timestamp: str | None) -> int | None:
    """Extract year from a timestamp string."""
    if not timestamp:
        return None

    # Try to parse ISO format timestamp (e.g., "2025-03-03T08:58:01Z").
    # The obfuscator anchors on the UTC date, so this is the UTC year:
    # 2025-01-01T00:30:00+02:00 belongs to 2024 before and after it.
    parsed = parse_iso_timestamp(timestamp)
    if parsed is not None:
        if parsed.tzinfo is not None:
            parsed = parsed.astimezone(UTC)
        return parsed.year

    # A date string ("03 Mar 2025", "2025-03-03"), also one that holds a "T"
    # without being an ISO timestamp ("Takeoff: 03 Mar 2025 08:58 Z")
    year_match = YEAR_PATTERN.search(timestamp)
    if year_match:
        return int(year_match.group(1))
    return None


def validate_and_normalize_coordinate(
    lat: float, lon: float, alt: float | None, filename: str
) -> tuple[float, float, float | None] | None:
    """Validate a coordinate point.

    Returns None if the latitude/longitude are invalid, including 0,0: a GPS
    receiver without a fix reports it, and a flight to "Null Island" in the
    Gulf of Guinea would stretch the map across half the globe. An altitude
    that is non-finite or outside the plausible range is treated as missing
    (None); valid negative altitudes (down to ALT_MIN_M) are kept.
    """
    if not (
        math.isfinite(lat)
        and math.isfinite(lon)
        and LAT_MIN <= lat <= LAT_MAX
        and LON_MIN <= lon <= LON_MAX
        and (lat != 0 or lon != 0)
    ):
        logger.debug("Invalid coordinates [%s, %s] in %s", lat, lon, filename)
        return None

    normalized_alt = alt
    if alt is not None and not (math.isfinite(alt) and ALT_MIN_M <= alt <= ALT_MAX_M):
        logger.debug("Invalid altitude %sm in %s, treating as missing", alt, filename)
        normalized_alt = None

    return (lat, lon, normalized_alt)


def parse_coordinate_point(
    point: str, filename: str
) -> tuple[float, float, float | None] | None:
    """Parse a single coordinate point from KML format (lon,lat[,alt]).

    ``filename`` only names the file in log messages. It is a plain string
    because this runs once per coordinate: building a ``Path`` here took
    most of the time of parsing a large LineString.
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
    except ValueError as e:
        logger.debug("Failed to parse coordinate '%s': %s", point, e)
        return None

    return validate_and_normalize_coordinate(lat, lon, alt, filename)


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


def _usable_time(text: str | None) -> str | None:
    """A KML time as it was written, or None when it cannot be read.

    A timestamp has to parse; a date without a time of day (xsd:date,
    gYearMonth and gYear are valid KML times) still tells the year. An
    unreadable <when> must not take the place of a date that the name or
    the description still holds.
    """
    if text is None:
        return None
    if parse_iso_timestamp(text) is not None or _DATE_ONLY_PATTERN.fullmatch(text):
        return text
    return None


def _time_span(
    element: etree._Element, prefix: str, namespaces: dict[str, str]
) -> tuple[str | None, str | None]:
    """The ``<TimeSpan>`` begin and end below ``element`` (see ``prefix``)."""
    begin = find_xml_element(
        element,
        f"{prefix}kml:TimeSpan/kml:begin",
        f"{prefix}TimeSpan/begin",
        namespaces,
    )
    end = find_xml_element(
        element, f"{prefix}kml:TimeSpan/kml:end", f"{prefix}TimeSpan/end", namespaces
    )
    return _usable_time(_element_text(begin)), _usable_time(_element_text(end))


def _extract_time_range(
    placemark: etree._Element, namespaces: dict[str, str]
) -> tuple[str | None, str | None]:
    """The first and last timestamp of a placemark.

    ``<when>`` elements (gx:Track and TimeStamp) win; a placemark without
    them may still carry a ``<TimeSpan>`` with ``<begin>`` and ``<end>``.
    Times that cannot be read are skipped (see ``_usable_time``).
    """
    elems = find_xml_elements(placemark, ".//kml:when", ".//when", namespaces)
    # Only the first and the last usable one are needed: a gx:Track holds
    # thousands, and reading every one of them took a third of the parse
    first = next(
        (
            index
            for index, elem in enumerate(elems)
            if _usable_time(_element_text(elem)) is not None
        ),
        None,
    )
    if first is None:
        return _time_span(placemark, ".//", namespaces)
    last = next(
        index
        for index in range(len(elems) - 1, first - 1, -1)
        if _usable_time(_element_text(elems[index])) is not None
    )
    end = _element_text(elems[last]) if last != first else None
    return _element_text(elems[first]), end


def _inherited_time_range(
    placemark: etree._Element, namespaces: dict[str, str]
) -> tuple[str | None, str | None]:
    """The time of the nearest Folder or Document around a placemark.

    In KML a feature without a time of its own takes the one of its
    container. Only a container's own ``<TimeStamp>`` or ``<TimeSpan>``
    counts, never one of another placemark inside it.
    """
    for ancestor in placemark.iterancestors():
        when = _usable_time(
            _element_text(
                find_xml_element(
                    ancestor, "kml:TimeStamp/kml:when", "TimeStamp/when", namespaces
                )
            )
        )
        if when is not None:
            return when, None
        begin, end = _time_span(ancestor, "", namespaces)
        if begin is not None or end is not None:
            return begin, end
    return None, None


def extract_placemark_metadata(
    placemark: etree._Element, namespaces: dict[str, str]
) -> PlacemarkMetadata:
    """Extract metadata from a KML Placemark element."""
    name_elem = find_xml_element(placemark, ".//kml:name", ".//name", namespaces)
    kml_name = _element_text(name_elem)

    # Standardize airport name using ICAO codes from the name itself
    airport_names = standardize_airport_names(kml_name)

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

    # Last, the time of the Folder or Document the placemark is in
    if timestamp is None:
        timestamp, end_timestamp = _inherited_time_range(placemark, namespaces)

    return {
        "airport_name": airport_names.name,
        "start_airport": airport_names.start_airport,
        "end_airport": airport_names.end_airport,
        "timestamp": timestamp,
        "end_timestamp": end_timestamp,
        "year": extract_year_from_timestamp(timestamp),
    }


def _build_path_metadata_dict(
    kml_file: str,
    path_start: TrackPoint,
    placemark_meta: PlacemarkMetadata,
    aircraft_info: dict[str, str | None],
) -> PathMetadata:
    """Build path metadata dictionary.

    ``aircraft_info`` is ``parse_aircraft_from_filename`` of the file, parsed
    once per file by the caller.
    """
    airport_name = placemark_meta["airport_name"]
    start_airport = placemark_meta["start_airport"]
    end_airport = placemark_meta["end_airport"]

    # For Charterware files, use the route of the file name (DEPARTURE-ARRIVAL,
    # such as LOAV-LOAV or EDDF-EDDM) unless the placemark name is a route
    # itself. Charterware names its placemarks after the aircraft, and even
    # a name that is a single airport says nothing about the arrival.
    route = aircraft_info.get("route")
    if (
        aircraft_info.get("format") == "charterware"
        and route
        and "-" in route
        and start_airport is None
    ):
        departure_airport, arrival_airport = route.split("-", 1)
        airport_name, start_airport, end_airport = standardize_route(
            departure_airport, arrival_airport
        )

    start_point = [path_start.lat, path_start.lon]
    if path_start.alt is not None:
        start_point.append(path_start.alt)

    meta: PathMetadata = {
        "start_point": start_point,
        "airport_name": airport_name or "",
        "start_airport": start_airport,
        "end_airport": end_airport,
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
