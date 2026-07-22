"""KML file parsing for flight tracking data."""

from pathlib import Path
from typing import Any

from lxml import etree as ET

from .exceptions import KMLParseError
from .logger import logger
from .parser_cache import KML_CACHE_DIR
from .parser_cache import (
    get_cache_key as _get_cache_key,
    load_cached_parse,
    save_to_cache as _save_to_cache,
)
from .parser_common import (
    find_xml_elements,
    extract_placemark_metadata,
)
from .parser_standard import process_standard_coordinates
from .parser_gx_track import process_gx_track
from .types import PathMetadata

__all__ = [
    "get_cache_key",
    "save_to_cache",
    "parse_kml_coordinates",
]


def get_cache_key(kml_file: str) -> tuple[Path | None, bool]:
    """Generate cache key using the module-level KML_CACHE_DIR."""
    return _get_cache_key(kml_file, cache_dir=KML_CACHE_DIR)


def save_to_cache(
    cache_path: Path,
    coordinates: list[list[float]],
    path_groups: list[list[list[float]]],
    path_metadata: list[PathMetadata],
) -> None:
    """Save parse results using the module-level KML_CACHE_DIR."""
    _save_to_cache(
        cache_path, coordinates, path_groups, path_metadata, cache_dir=KML_CACHE_DIR
    )


def _parse_kml_tree(kml_file: str) -> Any:
    """Parse KML file and return XML root element."""
    try:
        parser = ET.XMLParser(resolve_entities=False, no_network=True)
        tree = ET.parse(kml_file, parser)
        root = tree.getroot()

        logger.debug(f"\n  Root tag: {root.tag}")
        logger.debug(f"Root attrib: {root.attrib}")
        all_tags = set()
        for elem in root.iter():
            tag = elem.tag.split("}")[-1] if "}" in elem.tag else elem.tag
            all_tags.add(tag)
        logger.debug(f"All unique tags in file: {sorted(all_tags)}")

        return root

    except ET.ParseError as e:
        raise KMLParseError(f"XML parsing error: {e}", file_path=kml_file) from e
    except (IOError, OSError) as e:
        raise KMLParseError(f"File I/O error: {e}", file_path=kml_file) from e


def _extract_kml_elements(
    root: Any, namespaces: dict[str, str]
) -> tuple[list[Any], list[Any], list[Any]]:
    """Extract coordinate elements and placemarks from KML root."""
    # Try with namespace
    coord_elements = root.findall(".//kml:coordinates", namespaces)
    gx_coords = root.findall(".//gx:coord", namespaces)

    if gx_coords:
        logger.debug(f"Found {len(gx_coords)} gx:coord elements (Google Earth Track)")

    # If no results, try without namespace (some KML files don't use it)
    if not coord_elements and not gx_coords:
        # Remove namespace from tags
        for elem in root.iter():
            if "}" in elem.tag:
                elem.tag = elem.tag.split("}", 1)[1]
        coord_elements = root.findall(".//coordinates")
        gx_coords = root.findall(".//coord")  # gx:coord without namespace

    logger.debug(f"Found {len(coord_elements)} coordinate elements")
    if coord_elements:
        for i, elem in enumerate(coord_elements[:2]):  # Show first 2
            logger.debug(
                f"Element {i} text preview: {str(elem.text)[:100] if elem.text else 'None'}"
            )

    # Find all Placemarks
    placemarks = root.findall(".//kml:Placemark", namespaces)
    if not placemarks:
        placemarks = root.findall(".//Placemark")  # Without namespace

    return coord_elements, gx_coords, placemarks


def _build_coord_metadata_map(
    placemarks: list[Any], namespaces: dict[str, str], kml_file: str
) -> dict[int, dict[str, Any]]:
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
) -> tuple[list[list[float]], list[list[list[float]]], list[PathMetadata]]:
    """Extract coordinates from a KML file."""
    # Check cache first
    cache_path, cache_valid = get_cache_key(kml_file)
    if cache_valid and cache_path:
        cached_result = load_cached_parse(cache_path)
        if cached_result:
            coordinates, path_groups, path_metadata = cached_result
            logger.info(
                f"✓ Loaded {len(coordinates)} points from {Path(kml_file).name} (cached)"
            )
            if path_groups:
                total_alt_points = sum(len(path) for path in path_groups)
                logger.info(
                    f"  ({total_alt_points} points have altitude data in {len(path_groups)} path(s))"
                )
            return coordinates, path_groups, path_metadata

    # Initialize output lists
    coordinates = []
    path_groups = []
    path_metadata = []

    try:
        # Parse KML file
        root = _parse_kml_tree(kml_file)

        # KML namespaces
        namespaces = {
            "kml": "http://www.opengis.net/kml/2.2",
            "gx": "http://www.google.com/kml/ext/2.2",
        }

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
        logger.info(f"✓ Loaded {len(coordinates)} points from {Path(kml_file).name}")
        if path_groups:
            logger.info(
                f"  ({total_alt_points} points have altitude data in {len(path_groups)} path(s))"
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
        logger.error(f"KML parsing error in {kml_file}: {e}")
        logger.debug("Stack trace:", exc_info=True)
        return [], [], []
