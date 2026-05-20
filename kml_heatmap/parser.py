"""KML file parsing functionality.

This module provides comprehensive KML (Keyhole Markup Language) parsing for
flight tracking data, supporting both standard KML and Google Earth Track formats.

Key Features:
- Parses standard KML <coordinates> elements
- Supports Google Earth Track (gx:coord) extension
- Extracts timestamps and metadata from Placemarks
- Caches parsed results for performance
- Detects mid-flight starts and validates landings
- Handles various coordinate formats and namespaces

Performance:
- File-based caching with modification time tracking
- Inline validation for coordinate parsing speed
- Pre-compiled regex patterns for timestamp extraction
- lxml support for faster XML parsing when available

Coordinate Formats:
- Standard KML: "lon,lat,alt" (comma-separated)
- Google Earth Track: "lon lat alt" (space-separated)
- Optional altitude values (defaults to None if missing)
- Automatic clamping of negative altitudes to 0

Example:
    >>> from kml_heatmap.parser import parse_kml_coordinates
    >>> coords, paths, metadata = parse_kml_coordinates('flight.kml')
    >>> print(f"Loaded {len(coords)} points from {len(paths)} paths")
    Loaded 1234 points from 3 paths
"""

from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from lxml import etree as ET

from .logger import logger
from .airport_lookup import (
    extract_icao_codes_from_name,
    standardize_airport_name,
)
from .parser_cache import KML_CACHE_DIR  # noqa: F401 - re-exported for test compatibility
from .parser_cache import (
    get_cache_key as _get_cache_key,
    load_cached_parse,
    save_to_cache as _save_to_cache,
)
from .parser_common import (
    extract_year_from_timestamp,
    sample_path_altitudes,
    is_mid_flight_start,
    is_valid_landing,
    parse_coordinate_point,
    find_xml_element,
    find_xml_elements,
    extract_charterware_timestamp,  # noqa: F401 - re-exported for backward compatibility
    extract_placemark_metadata,
)
from .parser_standard import process_standard_coordinates
from .parser_gx_track import process_gx_track

__all__ = [
    "get_cache_key",
    "load_cached_parse",
    "save_to_cache",
    "extract_year_from_timestamp",
    "extract_icao_codes_from_name",
    "standardize_airport_name",
    "sample_path_altitudes",
    "is_mid_flight_start",
    "is_valid_landing",
    "parse_kml_coordinates",
    "parse_coordinate_point",
    "find_xml_element",
    "find_xml_elements",
    "extract_placemark_metadata",
    "process_standard_coordinates",
    "process_gx_track",
]


def get_cache_key(kml_file: str) -> Tuple[Optional[Path], bool]:
    """Generate cache key using the module-level KML_CACHE_DIR."""
    return _get_cache_key(kml_file, cache_dir=KML_CACHE_DIR)


def save_to_cache(
    cache_path: Path,
    coordinates: List[List[float]],
    path_groups: List[List[List[float]]],
    path_metadata: List[Dict[str, Any]],
) -> None:
    """Save parse results using the module-level KML_CACHE_DIR."""
    _save_to_cache(
        cache_path, coordinates, path_groups, path_metadata, cache_dir=KML_CACHE_DIR
    )


def _parse_kml_tree(kml_file: str) -> Optional[Any]:
    """
    Parse KML file and return XML root element.

    Args:
        kml_file: Path to KML file

    Returns:
        XML root element or None on error
    """
    try:
        tree = ET.parse(kml_file)
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
        logger.error(f"XML parsing error in {kml_file}: {e}")
        logger.error("The file may be corrupted or not a valid KML file")
        return None
    except (IOError, OSError) as e:
        logger.error(f"File I/O error parsing {kml_file}: {e}")
        return None


def _extract_kml_elements(
    root: Any, namespaces: Dict[str, str]
) -> Tuple[List[Any], List[Any], List[Any]]:
    """
    Extract coordinate elements and placemarks from KML root.

    Args:
        root: XML root element
        namespaces: XML namespace dict

    Returns:
        Tuple of (coord_elements, gx_coords, placemarks)
    """
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
    placemarks: List[Any], namespaces: Dict[str, str], kml_file: str
) -> Dict[int, Dict[str, Any]]:
    """
    Create mapping from coordinate elements to their metadata.

    Args:
        placemarks: List of Placemark XML elements
        namespaces: XML namespace dict
        kml_file: KML filename for ICAO extraction

    Returns:
        Dict mapping element ID to metadata dict
    """
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
) -> Tuple[List[List[float]], List[List[List[float]]], List[Dict[str, Any]]]:
    """
    Extract coordinates from a KML file.

    Args:
        kml_file: Path to KML file

    Returns:
        Tuple of (coordinates, path_groups, path_metadata)
        - coordinates: List of [lat, lon] pairs for heatmap (all points)
        - path_groups: List of path groups, where each group is a list of [lat, lon, alt]
                      (keeps separate paths separate for proper line drawing)
        - path_metadata: List of metadata dicts for each path (timestamp, filename, etc.)
    """
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
        if root is None:
            return [], [], []

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

    except (ValueError, TypeError, AttributeError) as e:
        logger.error(f"Data parsing error in {kml_file}: {e}")
        logger.debug("Stack trace:", exc_info=True)
        return [], [], []
