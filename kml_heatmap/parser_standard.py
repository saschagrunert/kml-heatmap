"""Standard KML <coordinates> processing."""

import re
from itertools import pairwise
from pathlib import Path
from typing import TYPE_CHECKING

from .geometry import haversine_distance
from .logger import logger
from .parser_common import (
    _build_path_metadata_dict,
    empty_placemark_metadata,
    parse_coordinate_point,
)
from .types import TrackPoint

if TYPE_CHECKING:
    from collections.abc import Collection

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
    unknown_altitude: Collection[int] = frozenset(),
) -> None:
    """Process standard KML <coordinates> elements.

    A flight path needs at least two points: a lone ``<Point>`` (a waypoint,
    a home field) is kept in ``coordinates`` but is no path, so it neither
    gets exported nor registers an airport.

    ``unknown_altitude`` holds the ids of the elements whose altitudes are to
    be ignored (the caller has said why); they form no path either.
    """
    lines_without_altitude = 0
    # Once per file: parse_coordinate_point runs once per coordinate
    filename = Path(kml_file).name
    first_path = len(path_groups)

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
        altitude_known = id(coord_elem) not in unknown_altitude

        for point_text in coord_text.split():
            parsed = parse_coordinate_point(point_text, filename)
            if parsed is None:
                continue

            lat, lon, alt = parsed
            if not altitude_known:
                alt = None
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
        elif element_coords > 1 and altitude_known:
            lines_without_altitude += 1

        if element_coords > 0:
            coord_type = (
                "Point" if element_coords == 1 else f"Path ({element_coords} points)"
            )
            logger.debug("Element %d: %s", idx, coord_type)

    _share_time_spans(path_groups[first_path:], path_metadata[first_path:])

    if lines_without_altitude:
        # Only the file's point count would show it otherwise, and that is
        # not zero, so the missing flight would go unnoticed
        logger.warning(
            "%s: %d line(s) without usable altitudes were ignored",
            filename,
            lines_without_altitude,
        )


def _path_distance_km(path: FlightPath) -> float:
    return sum(
        haversine_distance(p1.lat, p1.lon, p2.lat, p2.lon) for p1, p2 in pairwise(path)
    )


def _share_time_spans(paths: FlightPathGroup, metadata: list[PathMetadata]) -> None:
    """Split a time span that several lines have between them.

    A TimeSpan of a MultiGeometry, or one the lines inherit from their Folder
    or Document, is the time of all of them together, not of each one: taken
    for each line, it made every one of them as slow as all of them. The
    lines of a file with the same begin and end share it, each by its part
    of their distance (``span_share``, see ``export_pipeline.path_duration``).
    That gives every line the average speed of all of them, the best guess
    without the times of the lines themselves; their order in time is not
    known, so no line gets a begin or end of its own.
    """
    sharing: dict[tuple[str, str], list[int]] = {}
    for index, meta in enumerate(metadata):
        begin, end = meta.get("timestamp"), meta.get("end_timestamp")
        if begin and end:
            sharing.setdefault((begin, end), []).append(index)
    for indices in sharing.values():
        if len(indices) < 2:
            continue
        distances = [_path_distance_km(paths[index]) for index in indices]
        total = sum(distances)
        for index, distance in zip(indices, distances, strict=True):
            metadata[index]["span_share"] = (
                distance / total if total > 0 else 1 / len(indices)
            )
