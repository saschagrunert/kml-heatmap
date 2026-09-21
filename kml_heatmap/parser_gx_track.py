"""Google Earth Track (gx:Track) processing.

Every gx:Track element becomes one flight path. The <when> and <gx:coord>
children of a track are paired by position in document order; metadata is
taken from the enclosing Placemark.
"""

from bisect import bisect_right
from itertools import pairwise
from pathlib import Path
from typing import TYPE_CHECKING

from .helpers import parse_timestamp_epoch
from .logger import logger
from .parser_common import (
    NON_MSL_ALTITUDE_MODES,
    _build_path_metadata_dict,
    altitude_mode,
    empty_placemark_metadata,
    extract_placemark_metadata,
    extract_year_from_timestamp,
    local_name,
    validate_and_normalize_coordinate,
)
from .types import TrackPoint

# How far a <when> may be from the median of its track before it counts as a
# clock error. Generous for a flight, which is over within a day, and even
# for a logger left running for days; far below the errors it catches (a
# clock at its default date, a GPS week rollover of almost 20 years)
MAX_TIMESTAMP_DISTANCE_SECONDS = 7 * 24 * 3600

if TYPE_CHECKING:
    from lxml import etree

    from .types import FlightPath, FlightPathGroup, PathMetadata, PlacemarkMetadata


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


def _consistent_timestamps(timestamps: list[float | None]) -> list[bool]:
    """Which of a track's timestamps to keep (True) and which to drop.

    Loggers write the odd wrong <when>: a clock at its default date until
    the GPS fix, a single stamp years ahead, a GPS week rollover. Two rules
    keep one such stamp from spoiling the rest of the track:

    - A stamp more than ``MAX_TIMESTAMP_DISTANCE_SECONDS`` from the median of
      the track is wrong. The median belongs to the majority of the stamps,
      however wrong the first ones are.
    - Of the rest, the longest run of stamps that never goes backwards is
      kept (the longest non-decreasing subsequence). A stamp out of order
      with its neighbours is dropped, whichever direction it is off in,
      and the stamps around it are kept: rejecting everything before a
      later stamp, as a plain "not before the previous one" rule would,
      lost the whole track after a single stamp from the future.

    Time therefore never runs backwards along the kept stamps.
    """
    keep = [ts is not None for ts in timestamps]
    present = [ts for ts in timestamps if ts is not None]
    if not present:
        return keep
    # The usual track is in order and within the limit: nothing to drop
    in_order = all(a <= b for a, b in pairwise(present))
    if in_order:
        median = present[len(present) // 2]
        if max(median - present[0], present[-1] - median) <= (
            MAX_TIMESTAMP_DISTANCE_SECONDS
        ):
            return keep
    else:
        median = sorted(present)[len(present) // 2]
    for index, ts in enumerate(timestamps):
        if ts is not None and abs(ts - median) > MAX_TIMESTAMP_DISTANCE_SECONDS:
            keep[index] = False

    # Longest non-decreasing subsequence in O(n log n): tails[k] is the
    # smallest last stamp of a run of length k + 1, and predecessor links
    # the stamps of the best run back to its start
    candidates = [
        (index, ts)
        for index, (ts, kept) in enumerate(zip(timestamps, keep, strict=True))
        if kept and ts is not None
    ]
    tails: list[float] = []
    tail_index: list[int] = []
    predecessor: dict[int, int | None] = {}
    for index, ts in candidates:
        length = bisect_right(tails, ts)
        predecessor[index] = tail_index[length - 1] if length else None
        if length == len(tails):
            tails.append(ts)
            tail_index.append(index)
        else:
            tails[length] = ts
            tail_index[length] = index

    in_run: set[int] = set()
    current = tail_index[-1] if tail_index else None
    while current is not None:
        in_run.add(current)
        current = predecessor[current]
    for index, _ in candidates:
        if index not in in_run:
            keep[index] = False
    return keep


def parse_gx_track(
    track: etree._Element, kml_file: str, coordinates: FlightPath
) -> tuple[FlightPath, list[str]]:
    """Parse one gx:Track into a flight path.

    Returns the path (points with altitude) and the <when> texts of the
    path's points that carry a timestamp, in path order: the first and last
    of them are the time span of the path. A <when> that is unparsable,
    inconsistent with the rest of the track (see ``_consistent_timestamps``),
    or that belongs to a coordinate that was rejected or has no altitude, is
    not among them. Points are appended to ``coordinates`` as well.
    """
    whens, coord_texts = _collect_track_children(track)
    filename = Path(kml_file).name
    source = f"{filename} (gx:Track)"
    # See NON_MSL_ALTITUDE_MODES: such a track has no usable altitudes
    mode = altitude_mode(track)
    msl_altitudes = mode not in NON_MSL_ALTITUDE_MODES
    if not msl_altitudes:
        logger.warning(
            "%s: gx:Track with altitudeMode %s ignored: its altitudes are not "
            "above sea level",
            filename,
            mode,
        )

    if whens and len(whens) != len(coord_texts):
        logger.warning(
            "%s: gx:Track has %d <when> but %d <gx:coord> elements; "
            "pairing them by position",
            filename,
            len(whens),
            len(coord_texts),
        )

    # The valid coordinates with their <when> index and parsed timestamp
    points: list[tuple[float, float, float | None, int]] = []
    timestamps: list[float | None] = []
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

        validated = validate_and_normalize_coordinate(
            lat, lon, alt if msl_altitudes else None, source
        )
        if validated is None:
            continue

        ts = None
        if idx < len(whens) and whens[idx]:
            ts = parse_timestamp_epoch(whens[idx])
            if ts is None:
                logger.debug("Unparsable <when> in %s: %s", source, whens[idx])
        points.append((*validated, idx))
        timestamps.append(ts)

    keep = _consistent_timestamps(timestamps)
    dropped = sum(
        1
        for ts, kept in zip(timestamps, keep, strict=True)
        if ts is not None and not kept
    )
    if dropped:
        logger.debug("Dropped %d inconsistent <when> in %s", dropped, source)

    path: FlightPath = []
    path_whens: list[str] = []
    for (lat, lon, alt, idx), ts, kept in zip(points, timestamps, keep, strict=True):
        point = TrackPoint(lat, lon, alt, ts if kept else None)
        coordinates.append(point)
        if alt is not None:
            path.append(point)
            if point.ts is not None:
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
            # first entry may be unparsable or belong to a rejected coordinate.
            # The year is the one of the median stamp (they are in order), the
            # year most of the flight took place in.
            track_meta["timestamp"] = whens[0]
            track_meta["end_timestamp"] = whens[-1] if len(whens) > 1 else None
            track_meta["year"] = extract_year_from_timestamp(whens[len(whens) // 2])

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
