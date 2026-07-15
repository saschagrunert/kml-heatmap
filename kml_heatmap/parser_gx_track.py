"""Google Earth Track (gx:coord) processing."""

from pathlib import Path
from typing import Any

from .kml_parsers import validate_and_normalize_coordinate
from .logger import logger
from .parser_common import (
    extract_placemark_metadata,
    find_xml_elements,
    _build_path_metadata_dict,
)
from .types import PathMetadata


def _extract_gx_track_metadata(
    placemarks: list[Any], namespaces: dict[str, str], kml_file: str
) -> dict[str, str | None]:
    """Extract metadata from gx:Track placemarks."""
    for placemark in placemarks:
        # Check if this placemark contains gx:coord elements
        placemark_gx_coords = find_xml_elements(
            placemark, ".//gx:coord", ".//coord", namespaces
        )

        if placemark_gx_coords:
            meta = extract_placemark_metadata(placemark, namespaces, kml_file)

            if meta["timestamp"]:
                logger.debug(f"Found gx:Track start timestamp: {meta['timestamp']}")
            if meta["end_timestamp"]:
                logger.debug(f"Found gx:Track end timestamp: {meta['end_timestamp']}")
            if meta["timestamp"] is None and meta["airport_name"]:
                logger.debug(
                    f"No timestamp found for gx:Track with name: {meta['airport_name']}"
                )

            return meta

    return {
        "airport_name": None,
        "timestamp": None,
        "end_timestamp": None,
        "year": None,
    }


def _extract_gx_when_elements(
    placemarks: list[Any], gx_coords: list[Any], namespaces: dict[str, str]
) -> list[Any]:
    """Extract <when> elements that correspond to gx:coord elements."""
    for placemark in placemarks:
        when_elems = find_xml_elements(placemark, ".//kml:when", ".//when", namespaces)
        if when_elems and len(when_elems) == len(gx_coords):
            return when_elems
    return []


def _parse_gx_coordinates(
    gx_coords: list[Any],
    when_elems: list[Any],
    kml_file: str,
    coordinates: list[list[float]],
) -> list[list[Any]]:
    """Parse gx:coord elements into path coordinates."""
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
            validated = validate_and_normalize_coordinate(
                lat, lon, alt, f"{Path(kml_file).name} (gx:Track)"
            )
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
    gx_coords: list[Any],
    placemarks: list[Any],
    namespaces: dict[str, str],
    kml_file: str,
    coordinates: list[list[float]],
    path_groups: list[list[list[float]]],
    path_metadata: list[PathMetadata],
) -> None:
    """Process Google Earth Track (gx:coord) elements."""
    if not gx_coords:
        return

    # Extract metadata from placemarks
    track_meta = _extract_gx_track_metadata(placemarks, namespaces, kml_file)

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
            track_meta["airport_name"],
            track_meta["timestamp"],
            track_meta["end_timestamp"],
        )
        path_metadata.append(meta)

    logger.debug(f"Parsed {len(gx_coords)} gx:coord elements into 1 track")
