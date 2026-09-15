"""Standard KML <coordinates> processing."""

import re
from pathlib import Path
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

_SPACE_AFTER_COMMA = re.compile(r",\s+")


def process_standard_coordinates(
    coord_elements: list[etree._Element],
    coord_to_metadata: dict[int, PlacemarkMetadata],
    kml_file: str,
    coordinates: FlightPath,
    path_groups: FlightPathGroup,
    path_metadata: list[PathMetadata],
    aircraft_info: dict[str, str | None],
) -> None:
    """Process standard KML <coordinates> elements.

    A flight path needs at least two points: a lone ``<Point>`` (a waypoint,
    a home field) is kept in ``coordinates`` but is no path, so it neither
    gets exported nor registers an airport.
    """
    lines_without_altitude = 0
    # Once per file: parse_coordinate_point runs once per coordinate
    filename = Path(kml_file).name

    for idx, coord_elem in enumerate(coord_elements):
        if coord_elem.text is None:
            logger.debug("Coordinate element %d has None text, skipping", idx)
            continue

        coord_text = coord_elem.text.strip()
        if not coord_text:
            logger.debug("Coordinate element %d has empty text, skipping", idx)
            continue

        metadata = coord_to_metadata.get(id(coord_elem), empty_placemark_metadata())

        # Tuples are separated by whitespace and their values by commas.
        # Google Earth also accepts a space after the comma ("8.5, 50.0, 300"),
        # which the split below would tear apart.
        if _SPACE_AFTER_COMMA.search(coord_text):
            coord_text = _SPACE_AFTER_COMMA.sub(",", coord_text)

        current_path: FlightPath = []
        element_coords = 0

        for point_text in coord_text.split():
            parsed = parse_coordinate_point(point_text, filename)
            if parsed is None:
                continue

            lat, lon, alt = parsed
            point = TrackPoint(lat, lon, alt, None)
            coordinates.append(point)

            # Only points with a known altitude form the flight path
            if alt is not None:
                current_path.append(point)

            element_coords += 1

        if len(current_path) > 1:
            # No synthetic timestamps for Charterware files: their coordinates
            # are not at fixed intervals.
            path_groups.append(current_path)
            path_metadata.append(
                _build_path_metadata_dict(
                    kml_file, current_path[0], metadata, aircraft_info
                )
            )
        elif element_coords > 1:
            lines_without_altitude += 1

        if element_coords > 0:
            coord_type = (
                "Point" if element_coords == 1 else f"Path ({element_coords} points)"
            )
            logger.debug("Element %d: %s", idx, coord_type)

    if lines_without_altitude:
        # Only the file's point count would show it otherwise, and that is
        # not zero, so the missing flight would go unnoticed
        logger.warning(
            "%s: %d line(s) without usable altitudes were ignored",
            filename,
            lines_without_altitude,
        )
