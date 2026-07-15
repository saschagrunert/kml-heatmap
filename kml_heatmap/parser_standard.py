"""Standard KML coordinate processing."""

from typing import Any

from .logger import logger
from .parser_common import parse_coordinate_point, _build_path_metadata_dict
from .types import PathMetadata


def process_standard_coordinates(
    coord_elements: list[Any],
    coord_to_metadata: dict[int, dict[str, Any]],
    kml_file: str,
    coordinates: list[list[float]],
    path_groups: list[list[list[float]]],
    path_metadata: list[PathMetadata],
) -> None:
    """Process standard KML <coordinates> elements."""
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
            logger.debug(f"Element {idx}: {coord_type}")
