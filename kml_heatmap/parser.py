"""KML file parsing for flight tracking data."""

import logging
from pathlib import Path

from lxml import etree as ET

from .constants import KML_NAMESPACES
from .exceptions import KMLParseError
from .logger import logger
from .parser_cache import (
    KML_CACHE_DIR,
    load_cached_parse,
)
from .parser_cache import (
    get_cache_key as _get_cache_key,
)
from .parser_cache import (
    save_to_cache as _save_to_cache,
)
from .parser_common import (
    extract_placemark_metadata,
    find_xml_elements,
)
from .parser_gx_track import process_gx_track
from .parser_standard import process_standard_coordinates
from .types import FlightPath, FlightPathGroup, PathMetadata

__all__ = [
    "get_cache_key",
    "parse_kml_coordinates",
    "save_to_cache",
]


def get_cache_key(kml_file: str) -> tuple[Path | None, bool]:
    """Generate cache key using the module-level KML_CACHE_DIR."""
    return _get_cache_key(kml_file, cache_dir=KML_CACHE_DIR)


def save_to_cache(
    cache_path: Path,
    coordinates: FlightPath,
    path_groups: FlightPathGroup,
    path_metadata: list[PathMetadata],
) -> None:
    """Save parse results using the module-level KML_CACHE_DIR."""
    _save_to_cache(
        cache_path, coordinates, path_groups, path_metadata, cache_dir=KML_CACHE_DIR
    )


def _parse_kml_tree(kml_file: str) -> ET._Element:
    """Parse KML file and return XML root element."""
    try:
        parser = ET.XMLParser(resolve_entities=False, no_network=True)
        tree = ET.parse(kml_file, parser)
        root = tree.getroot()

        if logger.isEnabledFor(logging.DEBUG):
            logger.debug("\n  Root tag: %s", root.tag)
            logger.debug("Root attrib: %s", root.attrib)
            all_tags = set()
            for elem in root.iter():
                tag = elem.tag.split("}")[-1] if "}" in elem.tag else elem.tag
                all_tags.add(tag)
            logger.debug("All unique tags in file: %s", sorted(all_tags))

        return root

    except ET.ParseError as e:
        raise KMLParseError(f"XML parsing error: {e}", file_path=kml_file) from e
    except OSError as e:
        raise KMLParseError(f"File I/O error: {e}", file_path=kml_file) from e


def _extract_kml_elements(
    root: ET._Element, namespaces: dict[str, str]
) -> tuple[list[ET._Element], list[ET._Element], list[ET._Element]]:
    """Extract coordinate elements and placemarks from KML root."""
    # Try with namespace
    coord_elements = root.findall(".//kml:coordinates", namespaces)
    gx_coords = root.findall(".//gx:coord", namespaces)

    if gx_coords:
        logger.debug("Found %d gx:coord elements (Google Earth Track)", len(gx_coords))

    # If no results, try without namespace (some KML files don't use it)
    if not coord_elements and not gx_coords:
        # Remove namespace from tags
        for elem in root.iter():
            if "}" in elem.tag:
                elem.tag = elem.tag.split("}", 1)[1]
        coord_elements = root.findall(".//coordinates")
        gx_coords = root.findall(".//coord")  # gx:coord without namespace

    logger.debug("Found %d coordinate elements", len(coord_elements))
    if coord_elements:
        for i, elem in enumerate(coord_elements[:2]):  # Show first 2
            logger.debug(
                "Element %d text preview: %s",
                i,
                str(elem.text)[:100] if elem.text else "None",
            )

    # Find all Placemarks
    placemarks = root.findall(".//kml:Placemark", namespaces)
    if not placemarks:
        placemarks = root.findall(".//Placemark")  # Without namespace

    return coord_elements, gx_coords, placemarks


def _build_coord_metadata_map(
    placemarks: list[ET._Element], namespaces: dict[str, str], kml_file: str
) -> dict[int, dict[str, object]]:
    """Create mapping from coordinate elements to their metadata."""
    coord_to_metadata = {}
    for placemark in placemarks:
        # Find coordinates within this placemark
        placemark_coords = find_xml_elements(
            placemark, ".//kml:coordinates", ".//coordinates", namespaces
        )

        # Extract metadata using helper function
        metadata = extract_placemark_metadata(placemark, namespaces, kml_file)

        # Store metadata for each coordinates element in this placemark
        for coord_elem in placemark_coords:
            coord_to_metadata[id(coord_elem)] = metadata

    return coord_to_metadata


def parse_kml_coordinates(
    kml_file: str,
) -> tuple[FlightPath, FlightPathGroup, list[PathMetadata]]:
    """Extract coordinates from a KML file."""
    # Check cache first
    cache_path, cache_valid = get_cache_key(kml_file)
    if cache_valid and cache_path:
        cached_result = load_cached_parse(cache_path)
        if cached_result:
            coordinates, path_groups, path_metadata = cached_result
            logger.info(
                "✓ Loaded %d points from %s (cached)",
                len(coordinates),
                Path(kml_file).name,
            )
            if path_groups:
                total_alt_points = sum(len(path) for path in path_groups)
                logger.info(
                    "  (%d points have altitude data in %d path(s))",
                    total_alt_points,
                    len(path_groups),
                )
            return coordinates, path_groups, path_metadata

    # Initialize output lists
    coordinates = []
    path_groups = []
    path_metadata = []

    try:
        # Parse KML file
        root = _parse_kml_tree(kml_file)

        namespaces = KML_NAMESPACES

        # Extract elements
        coord_elements, gx_coords, placemarks = _extract_kml_elements(root, namespaces)

        # Build metadata mapping
        coord_to_metadata = _build_coord_metadata_map(placemarks, namespaces, kml_file)

        # Process standard KML coordinates
        process_standard_coordinates(
            coord_elements,
            coord_to_metadata,
            kml_file,
            coordinates,
            path_groups,
            path_metadata,
        )

        # Process Google Earth Track (gx:coord) elements
        process_gx_track(
            gx_coords,
            placemarks,
            namespaces,
            kml_file,
            coordinates,
            path_groups,
            path_metadata,
        )

        # Log results
        total_alt_points = sum(len(path) for path in path_groups)
        logger.info("✓ Loaded %d points from %s", len(coordinates), Path(kml_file).name)
        if path_groups:
            logger.info(
                "  (%d points have altitude data in %d path(s))",
                total_alt_points,
                len(path_groups),
            )

        if len(coordinates) == 0:
            logger.warning("No valid coordinates found!")
            logger.warning("This could mean:")
            logger.warning("  - The KML file uses a different structure")
            logger.warning("  - The coordinates are in an unexpected format")
            logger.warning("  - Try running with --debug flag for more information")

        # Save to cache
        if cache_path:
            save_to_cache(cache_path, coordinates, path_groups, path_metadata)

        return coordinates, path_groups, path_metadata

    except KMLParseError as e:
        logger.error("KML parsing error in %s: %s", kml_file, e)
        logger.debug("Stack trace:", exc_info=True)
        return [], [], []
