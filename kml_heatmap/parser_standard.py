"""Standard KML coordinate processing."""

from typing import Any

from lxml import etree

from .logger import logger
from .parser_common import _build_path_metadata_dict, parse_coordinate_point
from .types import FlightPath, FlightPathGroup, PathMetadata


def process_standard_coordinates(
    coord_elements: list[etree._Element],
    coord_to_metadata: dict[int, dict[str, Any]],
    kml_file: str,
    coordinates: FlightPath,
    path_groups: FlightPathGroup,
    path_metadata: list[PathMetadata],
) -> None:
    """Process standard KML <coordinates> elements."""
    for idx, coord_elem in enumerate(coord_elements):
        # Handle None text
        if coord_elem.text is None:
            logger.debug("Coordinate element %d has None text, skipping", idx)
            continue

        coord_text = coord_elem.text.strip()
        if not coord_text:
            logger.debug("Coordinate element %d has empty text, skipping", idx)
            continue

        # Get metadata for this coordinate element
        metadata = coord_to_metadata.get(id(coord_elem), {})
        airport_name = metadata.get("airport_name")
        timestamp = metadata.get("timestamp")
        end_timestamp = metadata.get("end_timestamp")

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

            # Swap to [lat, lon] for leaflet
            coordinates.append([lat, lon])

            # Add to current path group with altitude
            if alt is not None:
                current_path.append([lat, lon, alt])

            element_coords += 1

        # Add this path group to the list if it has coordinates
        if current_path:
            # Do NOT generate synthetic timestamps for Charterware files
            # As per https://github.com/saschagrunert/kml-heatmap/issues/16
            # Charterware coordinates are not at fixed intervals, making time/speed inference inaccurate

            path_groups.append(current_path)
            meta = _build_path_metadata_dict(
                kml_file, current_path[0], airport_name, timestamp, end_timestamp
            )
            path_metadata.append(meta)

        if element_coords > 0:
            coord_type = (
                "Point" if element_coords == 1 else f"Path ({element_coords} points)"
            )
            logger.debug("Element %d: %s", idx, coord_type)
