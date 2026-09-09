"""KML file parsing for flight tracking data."""

import logging
from pathlib import Path
from typing import TYPE_CHECKING

from lxml import etree

from .constants import KML_NAMESPACES
from .exceptions import KMLParseError
from .logger import logger
from .parser_cache import get_cache_key, load_cached_parse, save_to_cache
from .parser_common import extract_placemark_metadata, find_xml_elements
from .parser_gx_track import local_name, process_gx_track
from .parser_standard import process_standard_coordinates

if TYPE_CHECKING:
    from .types import FlightPath, FlightPathGroup, PathMetadata, PlacemarkMetadata

__all__ = [
    "parse_kml_coordinates",
]


def _parse_kml_tree(kml_file: str) -> etree._Element:
    """Parse KML file and return XML root element."""
    try:
        parser = etree.XMLParser(resolve_entities=False, no_network=True)
        tree = etree.parse(kml_file, parser)
        root = tree.getroot()

        if logger.isEnabledFor(logging.DEBUG):
            logger.debug("\n  Root tag: %s", root.tag)
            logger.debug("Root attrib: %s", root.attrib)
            all_tags = {local_name(elem.tag) for elem in root.iter()}
            logger.debug("All unique tags in file: %s", sorted(all_tags))

        return root

    except etree.ParseError as e:
        raise KMLParseError(f"XML parsing error: {e}", file_path=kml_file) from e
    except OSError as e:
        raise KMLParseError(f"File I/O error: {e}", file_path=kml_file) from e


def _extract_kml_elements(
    root: etree._Element, namespaces: dict[str, str], kml_file: str
) -> tuple[list[etree._Element], list[etree._Element], list[etree._Element]]:
    """Extract coordinate elements, gx:Track elements and placemarks."""
    coord_elements = root.findall(".//kml:coordinates", namespaces)
    tracks = root.findall(".//gx:Track", namespaces)

    # If no results, try without namespace (some KML files don't use it)
    if not coord_elements and not tracks:
        for elem in root.iter():
            if isinstance(elem.tag, str) and "}" in elem.tag:
                elem.tag = elem.tag.split("}", 1)[1]
        coord_elements = root.findall(".//coordinates")
        tracks = root.findall(".//Track")

    logger.debug("Found %d coordinate elements", len(coord_elements))
    for i, elem in enumerate(coord_elements[:2]):
        logger.debug(
            "Element %d text preview: %s",
            i,
            str(elem.text)[:100] if elem.text else "None",
        )

    total_gx_coords = sum(1 for elem in root.iter() if local_name(elem.tag) == "coord")
    in_track = sum(
        1
        for track in tracks
        for elem in track.iter()
        if local_name(elem.tag) == "coord"
    )
    if tracks:
        logger.debug(
            "Found %d gx:Track element(s) with %d gx:coord elements",
            len(tracks),
            in_track,
        )
    if total_gx_coords > in_track:
        logger.warning(
            "%s: %d gx:coord element(s) outside of gx:Track were ignored",
            Path(kml_file).name,
            total_gx_coords - in_track,
        )

    placemarks = root.findall(".//kml:Placemark", namespaces)
    if not placemarks:
        placemarks = root.findall(".//Placemark")

    return coord_elements, tracks, placemarks


def _build_coord_metadata_map(
    placemarks: list[etree._Element], namespaces: dict[str, str]
) -> dict[int, PlacemarkMetadata]:
    """Create mapping from coordinate elements to their placemark metadata."""
    coord_to_metadata: dict[int, PlacemarkMetadata] = {}
    for placemark in placemarks:
        placemark_coords = find_xml_elements(
            placemark, ".//kml:coordinates", ".//coordinates", namespaces
        )
        if not placemark_coords:
            continue

        metadata = extract_placemark_metadata(placemark, namespaces)
        for coord_elem in placemark_coords:
            coord_to_metadata[id(coord_elem)] = metadata

    return coord_to_metadata


def _log_parse_result(
    kml_file: str,
    coordinates: FlightPath,
    path_groups: FlightPathGroup,
    cached: bool,
) -> None:
    suffix = " (cached)" if cached else ""
    logger.info(
        "✓ Loaded %d points from %s%s", len(coordinates), Path(kml_file).name, suffix
    )
    if path_groups:
        total_alt_points = sum(len(path) for path in path_groups)
        logger.info(
            "  (%d points have altitude data in %d path(s))",
            total_alt_points,
            len(path_groups),
        )


def parse_kml_coordinates(
    kml_file: str,
) -> tuple[FlightPath, FlightPathGroup, list[PathMetadata]]:
    """Extract coordinates from a KML file."""
    cache_path, cache_valid = get_cache_key(kml_file)
    if cache_valid and cache_path:
        cached_result = load_cached_parse(cache_path)
        if cached_result:
            _log_parse_result(kml_file, cached_result[0], cached_result[1], cached=True)
            return cached_result

    coordinates: FlightPath = []
    path_groups: FlightPathGroup = []
    path_metadata: list[PathMetadata] = []

    root = _parse_kml_tree(kml_file)
    namespaces = KML_NAMESPACES

    coord_elements, tracks, placemarks = _extract_kml_elements(
        root, namespaces, kml_file
    )
    coord_to_metadata = _build_coord_metadata_map(placemarks, namespaces)

    process_standard_coordinates(
        coord_elements,
        coord_to_metadata,
        kml_file,
        coordinates,
        path_groups,
        path_metadata,
    )

    process_gx_track(
        tracks, namespaces, kml_file, coordinates, path_groups, path_metadata
    )

    _log_parse_result(kml_file, coordinates, path_groups, cached=False)

    if not coordinates:
        logger.warning("No valid coordinates found!")
        logger.warning("This could mean:")
        logger.warning("  - The KML file uses a different structure")
        logger.warning("  - The coordinates are in an unexpected format")
        logger.warning("  - Try running with --debug flag for more information")

    if cache_path:
        save_to_cache(cache_path, coordinates, path_groups, path_metadata)

    return coordinates, path_groups, path_metadata
