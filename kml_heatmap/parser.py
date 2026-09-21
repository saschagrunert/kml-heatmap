"""KML file parsing for flight tracking data."""

import logging
from pathlib import Path
from typing import TYPE_CHECKING, cast

from lxml import etree

from .aircraft import parse_aircraft_from_filename
from .constants import KML_NAMESPACE, KML_NAMESPACES
from .exceptions import KMLParseError
from .logger import logger
from .parser_cache import get_cache_key, load_cached_parse, save_to_cache
from .parser_common import (
    NON_MSL_ALTITUDE_MODES,
    altitude_mode,
    extract_placemark_metadata,
    find_xml_element,
    find_xml_elements,
    local_name,
)
from .parser_gx_track import process_gx_track
from .parser_standard import process_standard_coordinates

if TYPE_CHECKING:
    from .types import FlightPath, FlightPathGroup, PathMetadata, PlacemarkMetadata

__all__ = [
    "load_cached_kml",
    "parse_kml_coordinates",
]

# gx:coord elements the track parser never reads. libxml2 counts them in one
# pass; walking the tree twice in Python took a fifth of the parse time.
_LOOSE_GX_COORDS = etree.XPath(
    "count(//*[local-name()='coord'][not(ancestor::*[local-name()='Track'])])"
)
_TRACK_GX_COORDS = etree.XPath(
    "count(//*[local-name()='Track']//*[local-name()='coord'])"
)


def _parse_kml_tree(kml_file: str) -> etree._Element:
    """Parse KML file and return XML root element."""
    try:
        # huge_tree lifts libxml2's 10 MB limit per text node, which a single
        # long <coordinates> reaches well below the accepted file size.
        # Entities stay unresolved and the amplification limit still applies.
        parser = etree.XMLParser(
            resolve_entities=False, no_network=True, huge_tree=True
        )
        tree = etree.parse(kml_file, parser)
        root = tree.getroot()

        if logger.isEnabledFor(logging.DEBUG):
            logger.debug("\n  Root tag: %s", root.tag)
            logger.debug("Root attrib: %s", root.attrib)
            all_tags = {local_name(elem.tag) for elem in root.iter()}
            logger.debug("All unique tags in file: %s", sorted(all_tags))

        return root

    except etree.ParseError as e:
        raise KMLParseError(
            f"XML parsing error: {e}", file_path=kml_file, line_number=e.lineno
        ) from e
    except OSError as e:
        raise KMLParseError(f"File I/O error: {e}", file_path=kml_file) from e


def _document_namespaces(root: etree._Element) -> dict[str, str]:
    """The namespaces to search a document with.

    Google Earth's legacy namespaces (http://earth.google.com/kml/2.x) hold
    the same elements as the OGC one and are used together with gx:Track.
    A root element in such a namespace takes the place of the ``kml`` prefix.
    """
    namespace = etree.QName(root).namespace
    if namespace and namespace != KML_NAMESPACE and local_name(root.tag) == "kml":
        return {**KML_NAMESPACES, "kml": namespace}
    return KML_NAMESPACES


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
    else:
        # One kind may still be in another (or no) namespace, such as an
        # unprefixed <Track> next to a namespaced <Point>. The wildcard
        # iteration runs in C and the tree is left as it is.
        if not coord_elements:
            coord_elements = list(root.iter("{*}coordinates"))
        if not tracks:
            tracks = list(root.iter("{*}Track"))

    logger.debug("Found %d coordinate elements", len(coord_elements))
    for i, elem in enumerate(coord_elements[:2]):
        logger.debug(
            "Element %d text preview: %s",
            i,
            str(elem.text)[:100] if elem.text else "None",
        )

    if tracks:
        if logger.isEnabledFor(logging.DEBUG):
            logger.debug(
                "Found %d gx:Track element(s) with %d gx:coord elements",
                len(tracks),
                int(cast("float", _TRACK_GX_COORDS(root))),
            )
        loose_gx_coords = int(cast("float", _LOOSE_GX_COORDS(root)))
        if loose_gx_coords:
            logger.warning(
                "%s: %d gx:coord element(s) outside of gx:Track were ignored",
                Path(kml_file).name,
                loose_gx_coords,
            )

    placemarks = root.findall(".//kml:Placemark", namespaces)
    if not placemarks:
        placemarks = root.findall(".//Placemark")

    return coord_elements, tracks, placemarks


def _build_coord_metadata_map(
    placemarks: list[etree._Element], namespaces: dict[str, str]
) -> tuple[dict[int, PlacemarkMetadata], set[int]]:
    """Map coordinate elements to their placemark metadata.

    Also returns the ids of the LineString coordinates to skip: a placemark
    holding both a gx:Track and a LineString (a MultiGeometry) is one
    feature, and the LineString is the fallback geometry for viewers without
    gx support. Parsing both would count the flight twice.
    """
    coord_to_metadata: dict[int, PlacemarkMetadata] = {}
    track_fallback_lines: set[int] = set()
    for placemark in placemarks:
        placemark_coords = find_xml_elements(
            placemark, ".//kml:coordinates", ".//coordinates", namespaces
        )
        if not placemark_coords:
            continue

        track = find_xml_element(placemark, ".//gx:Track", ".//Track", namespaces)
        if track is not None:
            for coord_elem in placemark_coords:
                parent = coord_elem.getparent()
                if parent is not None and local_name(parent.tag) == "LineString":
                    track_fallback_lines.add(id(coord_elem))

        metadata = extract_placemark_metadata(placemark, namespaces)
        for coord_elem in placemark_coords:
            coord_to_metadata[id(coord_elem)] = metadata

    if track_fallback_lines:
        logger.debug(
            "Ignoring %d LineString(s) next to a gx:Track in the same placemark",
            len(track_fallback_lines),
        )
    return coord_to_metadata, track_fallback_lines


def _select_line_coordinates(
    coord_elements: list[etree._Element], kml_file: str
) -> tuple[list[etree._Element], set[int]]:
    """The <coordinates> that are parsed, and the lines without altitudes.

    Only a LineString (on its own or in a MultiGeometry) is a flight path. A
    Point is kept: it is counted, but a single position never forms a path.
    Everything else, the rings of a Polygon above all, is an area rather than
    a flight and is skipped. The second value holds the ids of the lines
    whose altitudes are not above sea level (see NON_MSL_ALTITUDE_MODES).
    """
    selected: list[etree._Element] = []
    unknown_altitude: set[int] = set()
    skipped = 0
    for elem in coord_elements:
        parent = elem.getparent()
        kind = local_name(parent.tag) if parent is not None else ""
        if parent is not None and kind == "LineString":
            mode = altitude_mode(parent)
            if mode in NON_MSL_ALTITUDE_MODES:
                logger.warning(
                    "%s: LineString with altitudeMode %s ignored: its altitudes "
                    "are not above sea level",
                    Path(kml_file).name,
                    mode,
                )
                unknown_altitude.add(id(elem))
        elif kind != "Point":
            # SkyDemon writes an empty <coordinates /> into its gx:Track
            if elem.text and elem.text.strip():
                skipped += 1
            continue
        selected.append(elem)
    if skipped:
        logger.warning(
            "%s: %d <coordinates> outside of a LineString or Point (such as a "
            "Polygon) ignored",
            Path(kml_file).name,
            skipped,
        )
    return selected, unknown_altitude


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


def _read_cache(
    kml_file: str, cache_path: Path | None, cache_valid: bool
) -> tuple[FlightPath, FlightPathGroup, list[PathMetadata]] | None:
    if not (cache_valid and cache_path):
        return None
    cached_result = load_cached_parse(cache_path)
    if cached_result:
        _log_parse_result(kml_file, cached_result[0], cached_result[1], cached=True)
    return cached_result


def load_cached_kml(
    kml_file: str,
) -> tuple[FlightPath, FlightPathGroup, list[PathMetadata]] | None:
    """The cached parse result of a KML file, None when there is none."""
    return _read_cache(kml_file, *get_cache_key(kml_file))


def parse_kml_coordinates(
    kml_file: str,
) -> tuple[FlightPath, FlightPathGroup, list[PathMetadata]]:
    """Extract coordinates from a KML file."""
    cache_path, cache_valid = get_cache_key(kml_file)
    cached_result = _read_cache(kml_file, cache_path, cache_valid)
    if cached_result:
        return cached_result

    coordinates: FlightPath = []
    path_groups: FlightPathGroup = []
    path_metadata: list[PathMetadata] = []

    root = _parse_kml_tree(kml_file)
    namespaces = _document_namespaces(root)

    coord_elements, tracks, placemarks = _extract_kml_elements(
        root, namespaces, kml_file
    )
    coord_to_metadata, track_fallback_lines = _build_coord_metadata_map(
        placemarks, namespaces
    )
    if track_fallback_lines:
        coord_elements = [
            elem for elem in coord_elements if id(elem) not in track_fallback_lines
        ]
    coord_elements, unknown_altitude = _select_line_coordinates(
        coord_elements, kml_file
    )

    # Once per file: it logs its complaints about the name on every call
    aircraft_info = parse_aircraft_from_filename(Path(kml_file).name)

    process_standard_coordinates(
        coord_elements,
        coord_to_metadata,
        kml_file,
        coordinates,
        path_groups,
        path_metadata,
        aircraft_info,
        unknown_altitude,
    )

    process_gx_track(
        tracks,
        namespaces,
        kml_file,
        coordinates,
        path_groups,
        path_metadata,
        aircraft_info,
    )

    _log_parse_result(kml_file, coordinates, path_groups, cached=False)

    if not coordinates:
        # One line with the file name: the files of a run are parsed in
        # parallel, so the lines of several warnings would interleave
        logger.warning(
            "%s: No valid coordinates found (unexpected structure or coordinate "
            "format; run with --debug for details)",
            Path(kml_file).name,
        )

    if cache_path:
        save_to_cache(cache_path, coordinates, path_groups, path_metadata)

    return coordinates, path_groups, path_metadata
