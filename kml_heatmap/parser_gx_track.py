"""Google Earth Track (gx:Track) processing.

Every gx:Track element becomes one flight path. The <when> and <gx:coord>
children of a track are paired by position in document order; metadata is
taken from the enclosing Placemark.
"""

from pathlib import Path
from typing import TYPE_CHECKING

from .helpers import parse_timestamp_epoch
from .logger import logger
from .parser_common import (
    _build_path_metadata_dict,
    empty_placemark_metadata,
    extract_placemark_metadata,
    extract_year_from_timestamp,
    validate_and_normalize_coordinate,
)
from .types import TrackPoint

if TYPE_CHECKING:
    from lxml import etree

    from .types import FlightPath, FlightPathGroup, PathMetadata, PlacemarkMetadata


def local_name(tag: object) -> str:
    """Return the tag name of an element without its namespace."""
    if not isinstance(tag, str):
        return ""
    return tag.rsplit("}", 1)[-1]


def _find_placemark(track: etree._Element) -> etree._Element | None:
    """Find the Placemark element enclosing a gx:Track."""
    for ancestor in track.iterancestors():
        if local_name(ancestor.tag) == "Placemark":
            return ancestor
    return None


def _collect_track_children(
    track: etree._Element,
) -> tuple[list[str], list[str | None]]:
    """Collect <when> texts and <gx:coord> texts of a track in document order."""
    whens: list[str] = []
    coords: list[str | None] = []
    for child in track:
        name = local_name(child.tag)
        if name == "when":
            whens.append((child.text or "").strip())
        elif name == "coord":
            coords.append(child.text)
    return whens, coords


def parse_gx_track(
    track: etree._Element, kml_file: str, coordinates: FlightPath
) -> tuple[FlightPath, list[str]]:
    """Parse one gx:Track into a flight path.

    Returns the path (points with altitude) and the <when> texts of the
    path's points that carry a timestamp, in path order: the first and last
    of them are the time span of the path. A <when> that is unparsable, or
    that belongs to a coordinate that was rejected or has no altitude, is
    not among them. Points are appended to ``coordinates`` as well.

    A timestamp earlier than the one before it (a GPS week rollover, a clock
    resync) is dropped, so time never runs backwards along a path.
    """
    whens, coord_texts = _collect_track_children(track)
    filename = Path(kml_file).name
    source = f"{filename} (gx:Track)"

    if whens and len(whens) != len(coord_texts):
        logger.warning(
            "%s: gx:Track has %d <when> but %d <gx:coord> elements; "
            "pairing them by position",
            filename,
            len(whens),
            len(coord_texts),
        )

    path: FlightPath = []
    path_whens: list[str] = []
    last_ts: float | None = None
    for idx, coord_text in enumerate(coord_texts):
        if not coord_text or not coord_text.strip():
            continue

        parts = coord_text.split()
        if len(parts) < 2:
            continue

        try:
            lon = float(parts[0])
            lat = float(parts[1])
            alt = float(parts[2]) if len(parts) >= 3 else None
        except ValueError:
            logger.debug("Failed to parse gx:coord: %s", coord_text)
            continue

        validated = validate_and_normalize_coordinate(lat, lon, alt, source)
        if validated is None:
            continue
        lat, lon, alt = validated

        ts = None
        if idx < len(whens) and whens[idx]:
            ts = parse_timestamp_epoch(whens[idx])
            if ts is None:
                logger.debug("Unparsable <when> in %s: %s", source, whens[idx])
            elif last_ts is not None and ts < last_ts:
                logger.debug(
                    "Out-of-order <when> in %s dropped: %s", source, whens[idx]
                )
                ts = None
            else:
                last_ts = ts

        point = TrackPoint(lat, lon, alt, ts)
        coordinates.append(point)
        if alt is not None:
            path.append(point)
            if ts is not None:
                path_whens.append(whens[idx])

    return path, path_whens


def process_gx_track(
    tracks: list[etree._Element],
    namespaces: dict[str, str],
    kml_file: str,
    coordinates: FlightPath,
    path_groups: FlightPathGroup,
    path_metadata: list[PathMetadata],
    aircraft_info: dict[str, str | None],
) -> None:
    """Process all gx:Track elements of a KML document, one path per track."""
    if not tracks:
        return

    filename = Path(kml_file).name
    metadata_cache: dict[int, PlacemarkMetadata] = {}

    for track in tracks:
        placemark = _find_placemark(track)
        if placemark is None:
            placemark_meta = empty_placemark_metadata()
        else:
            key = id(placemark)
            if key not in metadata_cache:
                metadata_cache[key] = extract_placemark_metadata(placemark, namespaces)
            placemark_meta = metadata_cache[key]

        path, whens = parse_gx_track(track, kml_file, coordinates)
        if not path:
            logger.debug("gx:Track without usable coordinates in %s", filename)
            continue

        track_meta = placemark_meta.copy()
        if whens:
            # The track's own timestamps are authoritative for its time span:
            # those of the path's points, not of the raw <when> list, whose
            # first entry may be unparsable or belong to a rejected coordinate
            track_meta["timestamp"] = whens[0]
            track_meta["end_timestamp"] = whens[-1] if len(whens) > 1 else None
            track_meta["year"] = extract_year_from_timestamp(whens[0])

        if track_meta["timestamp"] is None and track_meta["airport_name"]:
            logger.debug(
                "No timestamp found for gx:Track with name: %s",
                track_meta["airport_name"],
            )

        path_groups.append(path)
        path_metadata.append(
            _build_path_metadata_dict(kml_file, path[0], track_meta, aircraft_info)
        )

    logger.debug("Parsed %d gx:Track element(s) in %s", len(tracks), filename)
