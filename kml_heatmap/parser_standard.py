"""Standard KML <coordinates> processing."""

from typing import TYPE_CHECKING

from .logger import logger
from .parser_common import (
    _build_path_metadata_dict,
    empty_placemark_metadata,
    parse_coordinate_point,
)
from .types import TrackPoint

if TYPE_CHECKING:
    from lxml import etree

    from .types import FlightPath, FlightPathGroup, PathMetadata, PlacemarkMetadata


def process_standard_coordinates(
    coord_elements: list[etree._Element],
    coord_to_metadata: dict[int, PlacemarkMetadata],
    kml_file: str,
    coordinates: FlightPath,
    path_groups: FlightPathGroup,
    path_metadata: list[PathMetadata],
) -> None:
    """Process standard KML <coordinates> elements."""
    for idx, coord_elem in enumerate(coord_elements):
        if coord_elem.text is None:
            logger.debug("Coordinate element %d has None text, skipping", idx)
            continue

        coord_text = coord_elem.text.strip()
        if not coord_text:
            logger.debug("Coordinate element %d has empty text, skipping", idx)
            continue

        metadata = coord_to_metadata.get(id(coord_elem), empty_placemark_metadata())

        # Split by whitespace (spaces, tabs, newlines)
        current_path: FlightPath = []
        element_coords = 0

        for point_text in coord_text.split():
            parsed = parse_coordinate_point(point_text, kml_file)
            if parsed is None:
                continue

            lat, lon, alt = parsed
            point = TrackPoint(lat, lon, alt, None)
            coordinates.append(point)

            # Only points with a known altitude form the flight path
            if alt is not None:
                current_path.append(point)

            element_coords += 1

        if current_path:
            # No synthetic timestamps for Charterware files: their coordinates
            # are not at fixed intervals.
            path_groups.append(current_path)
            path_metadata.append(
                _build_path_metadata_dict(kml_file, current_path[0], metadata)
            )

        if element_coords > 0:
            coord_type = (
                "Point" if element_coords == 1 else f"Path ({element_coords} points)"
            )
            logger.debug("Element %d: %s", idx, coord_type)
