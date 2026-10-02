"""KML date and timestamp obfuscation for privacy.

Shifts the timestamps of a file so that every flight starts at midnight
(00:00:00 UTC) on January 1st of its actual (UTC) year: neither the date nor
the time of day of a flight is kept. A flight moves by one offset of whole
seconds, so everything computed from its timestamps stays exactly as it was:
the intervals between its points, the gaps between its tracks, their order,
its durations, speeds, landings and flight time, and its year. The
timestamps are grouped into flights (see ``_timestamp_groups``); a file
usually holds one and moves by one offset, while a file with flights on
several dates puts each of them at midnight on January 1st of its own year.
Covered are ``<when>`` (gx:Track and TimeStamp) and
``<TimeSpan><begin>/<end>``, with or without a namespace prefix. The check
holds every flight to that start (see ``_timestamp_violations``).

Dates without a timestamp move to January 1st of their own year: date-only
timestamps, Charterware description dates ("Flight Jan 12 2026 03:01PM"
becomes "Flight Jan 01 2026 12:00AM"), route names with dates ("EDDS to
EDDP - 16 Aug 2026", "EDDS to EDDP - 2026-08-16") and the SkyDemon marker
names (Log Start, Takeoff, Landing, Log Stop), which lose their time. The
``creator`` attribute is replaced with a generic value. Files are rewritten
atomically and in place; ``rename_charterware_files`` removes the date and
time from Charterware file names ("2026-01-12_1513h_OE-AKI_LOAV-LOAV.kml").
"""

import argparse
import html
import os
import re
import sys
from bisect import bisect_right
from datetime import UTC, datetime, time, timedelta
from pathlib import Path
from typing import TYPE_CHECKING, NamedTuple

from .cache import atomic_write
from .constants import MAX_TIMESTAMP_DISTANCE_SECONDS
from .date_tokens import (
    CHARTERWARE_DATE_PATTERN,
    MONTHS_LONG,
    MONTHS_SHORT,
    charterware_datetime,
    find_date_tokens,
    find_time_tokens,
    find_weekday_tokens,
    month_number,
    near_jan_first,
)
from .helpers import normalize_timestamp_text, parse_iso_timestamp
from .logger import logger
from .validation import find_kml_files as _find_kml_files

if TYPE_CHECKING:
    from collections.abc import Iterable

__all__ = [
    "check_directory_obfuscated",
    "check_kml_obfuscated",
    "find_kml_files",
    "obfuscate_kml_content",
    "obfuscate_kml_file",
    "obfuscate_kml_files",
    "rename_charterware_files",
]

# An optional namespace prefix of an element name ("kml:when")
_PREFIX = r"(?:[\w.-]+:)?"

# gx:Track/TimeStamp <when> and TimeSpan <begin>/<end>, plain or in CDATA,
# and with a comment or a processing instruction inside, which the parser
# drops as well
TIMESTAMP_PATTERN = re.compile(
    r"(<(" + _PREFIX + r"(?:when|begin|end))\b[^>]*>)"
    r"((?:<!\[CDATA\[.*?\]\]>|<!--(?s:.*?)-->|<\?(?s:.*?)\?>|[^<])*)(</\2\s*>)"
)
CDATA_PATTERN = re.compile(r"^\s*<!\[CDATA\[(.*?)\]\]>\s*$", re.DOTALL)
# Comments and processing instructions, which the parser drops
COMMENT_PATTERN = re.compile(r"<!--.*?-->|<\?.*?\?>", re.DOTALL)
# The declaration a document starts with, the one processing instruction
# every KML file has
XML_DECLARATION_PATTERN = re.compile(r"\A\ufeff?\s*<\?xml\b.*?\?>", re.DOTALL)
# ISO 8601 writes a fraction of a second with a dot or a comma, and Python
# reads both ("09:12:00,5Z")
FRACTION_PATTERN = re.compile(r"[.,](\d+)")
UTC_OFFSET_PATTERN = re.compile(r"[+-]\d{2}:?\d{2}$")
# Valid KML timestamps without a time: xsd:date and xsd:gYearMonth
DATE_ONLY_PATTERN = re.compile(r"(\d{4})-\d{2}-\d{2}(Z|[+-]\d{2}:\d{2})?")
YEAR_MONTH_PATTERN = re.compile(r"(\d{4})-(\d{2})(Z|[+-]\d{2}:\d{2})?")
# xsd:gYear: a year alone gives nothing away the export does not keep
YEAR_ONLY_PATTERN = re.compile(r"\d{4}(?:Z|[+-]\d{2}:\d{2})?")

# SkyDemon marker: "Takeoff: 03 Mar 2025 08:31 Z", with or without seconds
_MARKER_DATE_RE = r"(Log Start|Takeoff|Landing|Log Stop):\s*\d{1,2}\s+\w{3}\s+"
_MARKER_TIME_RE = r"\d{2}:\d{2}(?::\d{2})?\s+Z"
NAME_DATE_PATTERN = re.compile(
    r"(<("
    + _PREFIX
    + r"name)\b[^>]*>)\s*"
    + _MARKER_DATE_RE
    + r"(\d{4})\s+"
    + _MARKER_TIME_RE
    + r"\s*(</\2\s*>)"
)
CHECK_NAME_DATE_PATTERN = re.compile(_MARKER_DATE_RE + r"\d{4}\s+" + _MARKER_TIME_RE)

# Route name with date: "<name>EDDS to EDDP - 16 Aug 2026</name>", or in the
# ISO form the parser reads too ("EDDS to EDDP - 2026-08-16", see
# helpers.DATE_PATTERN)
ROUTE_DATE_PATTERN = re.compile(
    r"(?P<head><(?P<tag>" + _PREFIX + r"name)\b[^>]*>[^<]*?\s-\s)"
    r"(?:(?P<day>\d{1,2})\s+(?P<month>[A-Za-z]{3})\s+(?P<year>\d{4})"
    r"|(?P<iso_year>\d{4})-(?P<iso_month>\d{2})-(?P<iso_day>\d{2}))"
    r"(?P<tail>\s*</(?P=tag)\s*>)"
)
# Either quote: creator="SkyDemon" or creator='SkyDemon'
CREATOR_PATTERN = re.compile(r"""(\screator=(?P<quote>["']))(.*?)((?P=quote))""")
GENERIC_CREATOR = "kml-heatmap"

# Charterware file name: YYYY-MM-DD_HHMMh_REGISTRATION_ROUTE (see aircraft.py)
CHARTERWARE_NAME_PATTERN = re.compile(
    r"(?P<year>\d{4})-(?P<month>\d{2})-(?P<day>\d{2})"
    r"_(?P<hour>[01]\d|2[0-3])(?P<minute>[0-5]\d)h_(?P<rest>.+)"
)
MINUTES_PER_DAY = 24 * 60

# The temp file of _write_atomic (cache.atomic_write): ".<name>.kml.XXXXXXXX.tmp"
TEMP_FILE_PATTERN = re.compile(r"^\..*\.kml\.[^.]+\.tmp$", re.IGNORECASE)

# Timestamps further apart than this belong to different flights, unless they
# are in the same track (see _timestamp_groups)
FLIGHT_GAP = timedelta(hours=12)
# Closer than this, a timestamp outside every track joins the flight before it
# even across New Year
CONTINUOUS_GAP = timedelta(hours=2)

# Coordinate lists: most of a track's text, and numbers only
COORDINATES_PATTERN = re.compile(
    r"<(" + _PREFIX + r"(?:coordinates|coord))\b[^>]*>[^<]*</\1\s*>"
)

PLACEMARK_PATTERN = re.compile(r"<(" + _PREFIX + r"Placemark)\b.*?</\1\s*>", re.DOTALL)
# What the parser makes one path of: a gx:MultiTrack, else a gx:Track (see
# parser_gx_track._flights)
MULTI_TRACK_PATTERN = re.compile(
    r"<(" + _PREFIX + r"MultiTrack)\b.*?</\1\s*>", re.DOTALL
)
TRACK_PATTERN = re.compile(r"<(" + _PREFIX + r"Track)\b.*?</\1\s*>", re.DOTALL)
# A point marker: a Placemark with a Point and no path, whose TimeStamp is no
# track but joins the flight it belongs to (see _timestamp_groups)
POINT_PATTERN = re.compile(r"<" + _PREFIX + r"Point\b")
PATH_GEOMETRY_PATTERN = re.compile(
    r"<" + _PREFIX + r"(?:LineString|Track|MultiTrack)\b"
)


def _timestamp_text(raw: str) -> str:
    """The timestamp of a <when> element in the form the rewrite emits.

    A comment or a processing instruction is dropped and a CDATA section
    unwrapped, a space between date and time becomes the "T" and a
    lowercase "z" the "Z"; anything else is left as it is.
    """
    has_markup = "<!--" in raw or "<?" in raw
    text = COMMENT_PATTERN.sub("", raw).strip() if has_markup else raw.strip()
    cdata = CDATA_PATTERN.match(text)
    if cdata:
        text = cdata.group(1).strip()
    # "2024-03-14 09:12:00" and a lowercase "z" are read by the parsers of
    # some tools, so they are read here too (the same rule as the parser's);
    # the rewrite emits the canonical form
    return normalize_timestamp_text(text)


def _parse_full_timestamp(ts_str: str) -> datetime | None:
    """Parse an ISO timestamp as an aware UTC datetime (naive values are UTC)."""
    dt = parse_iso_timestamp(ts_str)
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=UTC)
    return dt.astimezone(UTC)


def _extract_frac(ts_str: str) -> str:
    """The fraction of a second of a timestamp ('.5848380'), '' without one.

    With a dot, the way the rewrite writes it, also when the timestamp had
    a comma: dropping that fraction changed the intervals of the flight.
    """
    match = FRACTION_PATTERN.search(ts_str)
    return f".{match.group(1)}" if match else ""


def _format_timestamp(dt: datetime, frac: str = "") -> str:
    """Format a UTC datetime back to KML timestamp format."""
    return f"{dt.strftime('%Y-%m-%dT%H:%M:%S')}{frac}Z"


def _format_description_date(prefix: str, dt: datetime, long_month: bool) -> str:
    month = MONTHS_LONG[dt.month - 1] if long_month else MONTHS_SHORT[dt.month - 1]
    hour12 = dt.hour % 12 or 12
    meridiem = "AM" if dt.hour < 12 else "PM"
    return (
        f"{prefix}{month} {dt.day:02d} {dt.year} {hour12:02d}:{dt.minute:02d}{meridiem}"
    )


def _parse_route_date(match: re.Match[str]) -> datetime | None:
    """Parse a route name date match ("16 Aug 2026", "2026-08-16") in UTC."""
    if match["iso_year"] is not None:
        year, day = int(match["iso_year"]), int(match["iso_day"])
        month: int | None = int(match["iso_month"])
    else:
        year, day = int(match["year"]), int(match["day"])
        month = month_number(match["month"])
    if month is None:
        return None
    try:
        return datetime(year, month, day, tzinfo=UTC)
    except ValueError:
        return None


def _is_jan_first(dt: datetime | None) -> bool:
    return dt is not None and dt.month == 1 and dt.day == 1


def _is_canonical_start(dt: datetime | None) -> bool:
    """Whether a time is midnight on January 1st, the start of every flight.

    A fraction of a second may follow: the shift is one of whole seconds, so
    that every timestamp keeps the fraction it was written with.
    """
    return (
        dt is not None
        and _is_jan_first(dt)
        and dt.time().replace(microsecond=0) == time()
    )


def _timestamp_groups(
    timestamps: Iterable[datetime], tracks: Iterable[Iterable[datetime]]
) -> list[list[datetime]]:
    """Group timestamps into flights, each sorted, in the order of their start.

    A track is one piece of a flight however long it runs, and so is each
    timestamp outside one. A track is what the parser makes a path of, and
    gives the year of its start: a gx:Track, the tracks of a gx:MultiTrack
    together, and a Placemark for the timestamps of no track in it (the
    TimeSpan of a LineString); a point marker's TimeStamp (a Placemark with
    a Point and no path) is outside every track. Pieces in time order join
    the flight before them when they overlap it, or when they follow it
    within ``FLIGHT_GAP`` in the same UTC year: a track that starts on
    January 1st must not move into the year of the flight that ended the
    night before, since the parser keeps it in its own. Only a timestamp
    outside every track joins within ``CONTINUOUS_GAP`` across New Year too:
    no path takes its year from it. A flight is never split: one that runs
    past the days after January 1st keeps its intervals and fails the check
    instead of running backwards in time.

    A timestamp of a track more than ``MAX_TIMESTAMP_DISTANCE_SECONDS`` from
    the median of the track is a clock error, as the parser has it (a
    logger's clock at its default date until the GPS fix): it is a piece of
    its own, so it neither holds the flight back from moving nor stays
    behind with a date of its own.
    """
    pieces: list[list[datetime]] = []
    for track in tracks:
        piece = sorted(set(track))
        if not piece:
            continue
        median = piece[len(piece) // 2]
        limit = timedelta(seconds=MAX_TIMESTAMP_DISTANCE_SECONDS)
        pieces.append([dt for dt in piece if abs(dt - median) <= limit])
        pieces.extend([dt] for dt in piece if abs(dt - median) > limit)
    in_track = {dt for piece in pieces for dt in piece}
    loose = set(timestamps) - in_track
    pieces.extend([dt] for dt in loose)
    pieces.sort()

    groups: list[list[datetime]] = []
    group_end: datetime | None = None
    for piece in pieces:
        start = piece[0]
        if group_end is not None and (
            start <= group_end
            or (start - group_end <= FLIGHT_GAP and start.year == groups[-1][0].year)
            or (start in loose and start - group_end <= CONTINUOUS_GAP)
        ):
            groups[-1].extend(piece)
            group_end = max(group_end, piece[-1])
        else:
            groups.append(list(piece))
            group_end = piece[-1]
    return [sorted(set(group)) for group in groups]


def _timestamp_offsets(groups: list[list[datetime]]) -> dict[datetime, timedelta]:
    """Map every timestamp to the shift that starts its flight at midnight.

    The start of a flight moves to 00:00:00 on January 1st of its year, and
    the rest of the flight moves with it, so the flight keeps its intervals
    and its year and gives neither its date nor its time of day away. The
    shift is one of whole seconds (see ``_is_canonical_start``). A second
    pass finds every flight at midnight on January 1st already: the flights
    of one file may overlap in time then, and every one they form together
    still starts at midnight.
    """
    offsets: dict[datetime, timedelta] = {}
    for group in groups:
        start = group[0]
        offset = start.replace(month=1, day=1, hour=0, minute=0, second=0) - start
        for dt in group:
            offsets[dt] = offset
    return offsets


def _date_only_on_jan_first(text: str) -> str | None:
    """Move a date-only timestamp to January of its year (None if it is none)."""
    match = DATE_ONLY_PATTERN.fullmatch(text)
    if match:
        return f"{match.group(1)}-01-01{match.group(2) or ''}"
    match = YEAR_MONTH_PATTERN.fullmatch(text)
    if match:
        return f"{match.group(1)}-01{match.group(3) or ''}"
    return None


class _Timestamps(NamedTuple):
    """What one pass over the timestamp elements of a document found."""

    # Every full timestamp in UTC, with the text it first appeared as
    first_text: dict[datetime, str]
    # The flights the timestamps form (see _timestamp_groups)
    groups: list[list[datetime]]
    # A full timestamp with a UTC offset other than Z: its local date may not
    # be the UTC date that the check expects, so it is rewritten even unshifted
    has_utc_offset: bool
    # Date-only timestamps that are not on January 1st
    dates_to_move: list[str]
    # A timestamp not written the way the rewrite writes it (CDATA, a space
    # instead of the "T"): rewritten so the parsers read it like the check
    has_loose_text: bool
    # Timestamps neither a full one nor a date: the rewrite cannot move them
    # ("1710406320", "14.03.2024 09:12"), so they would keep what they hold
    not_understood: list[str]


def _is_point_marker(placemark: str) -> bool:
    """Whether a Placemark is a point marker (a Point and no path)."""
    return (
        POINT_PATTERN.search(placemark) is not None
        and PATH_GEOMETRY_PATTERN.search(placemark) is None
    )


class _Spans:
    """The spans of the matches of an element, to find the one at a position."""

    def __init__(self, matches: Iterable[re.Match[str]]) -> None:
        self.spans = [match.span() for match in matches]
        self.starts = [start for start, _ in self.spans]

    def holding(self, position: int) -> int | None:
        """The index of the span that holds ``position``, None for none."""
        index = bisect_right(self.starts, position) - 1
        if index >= 0 and position < self.spans[index][1]:
            return index
        return None


def _scan_timestamps(content: str) -> _Timestamps:
    first_text: dict[datetime, str] = {}
    has_utc_offset = False
    has_loose_text = False
    dates_to_move: list[str] = []
    not_understood: list[str] = []
    # The innermost of a gx:MultiTrack, a gx:Track and a Placemark that is no
    # point marker holds the timestamp's track (see _timestamp_groups)
    containers = [
        _Spans(MULTI_TRACK_PATTERN.finditer(content)),
        _Spans(TRACK_PATTERN.finditer(content)),
        _Spans(
            match
            for match in PLACEMARK_PATTERN.finditer(content)
            if not _is_point_marker(match.group(0))
        ),
    ]
    tracks: dict[tuple[int, int], list[datetime]] = {}
    for match in TIMESTAMP_PATTERN.finditer(content):
        text = _timestamp_text(match.group(3))
        if text != match.group(3):
            has_loose_text = True
        dt = _parse_full_timestamp(text)
        if dt is not None:
            first_text.setdefault(dt, text)
            if not has_utc_offset:
                has_utc_offset = UTC_OFFSET_PATTERN.search(text) is not None
            for kind, spans in enumerate(containers):
                index = spans.holding(match.start())
                if index is not None:
                    tracks.setdefault((kind, index), []).append(dt)
                    break
        elif (moved := _date_only_on_jan_first(text)) is not None:
            if moved != text:
                dates_to_move.append(text)
        elif text and not YEAR_ONLY_PATTERN.fullmatch(text):
            not_understood.append(text)
    groups = _timestamp_groups(first_text, tracks.values())
    return _Timestamps(
        first_text,
        groups,
        has_utc_offset,
        dates_to_move,
        has_loose_text,
        not_understood,
    )


def _has_real_creator(content: str) -> bool:
    """True when the creator attribute still names the recording device."""
    match = CREATOR_PATTERN.search(content)
    return match is not None and match.group(3) != GENERIC_CREATOR


def obfuscate_kml_content(content: str) -> str | None:
    """Obfuscate dates and timestamps in KML content.

    Returns the obfuscated content, or None if nothing had to change (the
    content is already obfuscated or holds no date).
    """
    timestamps = _scan_timestamps(content)
    offsets = _timestamp_offsets(timestamps.groups)

    def shift_timestamp(match: re.Match[str]) -> str:
        ts_str = _timestamp_text(match.group(3))
        dt = _parse_full_timestamp(ts_str)
        if dt is not None:
            shifted = _format_timestamp(dt + offsets[dt], _extract_frac(ts_str))
        else:
            date_only = _date_only_on_jan_first(ts_str)
            if date_only is None:
                return match.group(0)
            shifted = date_only
        return f"{match.group(1)}{shifted}{match.group(4)}"

    def marker_on_jan_first(match: re.Match[str]) -> str:
        opening, _, label, year, closing = match.groups()
        return f"{opening}{label}: {year}-01-01{closing}"

    # Route and description dates are local dates, not UTC like the
    # timestamps, so they move to January 1st of their own year directly.
    # Shifting them with a timestamp offset could leave them on January 2nd.
    # The time of a description goes to midnight, like the start of a flight.
    def description_on_jan_first(match: re.Match[str]) -> str:
        dt = charterware_datetime(match)
        if dt is None:
            return match.group(0)
        long_month = len(match.group(2)) > 3
        return _format_description_date(
            match.group(1), dt.replace(month=1, day=1, hour=0, minute=0), long_month
        )

    def route_on_jan_first(match: re.Match[str]) -> str:
        if _parse_route_date(match) is None:
            return match.group(0)
        if match["iso_year"] is not None:
            return f"{match['head']}{match['iso_year']}-01-01{match['tail']}"
        return f"{match['head']}01 Jan {match['year']}{match['tail']}"

    def replace_creator(match: re.Match[str]) -> str:
        return f"{match.group(1)}{GENERIC_CREATOR}{match.group(4)}"

    # Rewriting every timestamp of an obfuscated file only reproduces it, and
    # the CLI checks all inputs on every run
    new_content = content
    if (
        timestamps.has_utc_offset
        or timestamps.has_loose_text
        or timestamps.dates_to_move
        or any(offsets.values())
    ):
        new_content = TIMESTAMP_PATTERN.sub(shift_timestamp, content)
    new_content = NAME_DATE_PATTERN.sub(marker_on_jan_first, new_content)
    new_content = CHARTERWARE_DATE_PATTERN.sub(description_on_jan_first, new_content)
    new_content = ROUTE_DATE_PATTERN.sub(route_on_jan_first, new_content)
    new_content = CREATOR_PATTERN.sub(replace_creator, new_content)

    return new_content if new_content != content else None


def _write_atomic(filepath: Path, content: str) -> bool:
    """Write content via a temp file in the same directory and os.replace.

    The file being replaced is the user's only copy of the flight, so the data
    is flushed to disk before the rename and the directory entry after it: a
    crash in between leaves either the old file or the complete new one. Line
    endings are written as they were read, and the file keeps its mode.
    """
    try:
        atomic_write(
            filepath,
            lambda tmp: tmp.write(content),
            newline="",
            durable=True,
            keep_mode=True,
        )
    except OSError as e:
        logger.warning("Skipping %s: failed to write (%s)", filepath, e)
        return False
    return True


KMZ_REFUSAL = (
    "the obfuscator cannot check or rewrite the dates inside a zip archive; "
    "unzip it and keep the .kml file instead"
)


def _is_kmz(filepath: Path) -> bool:
    return filepath.suffix.lower() == ".kmz"


def obfuscate_kml_file(filepath: Path) -> bool:
    """Obfuscate a KML file in place.

    Returns True if the file was modified, False otherwise. A symlink is
    skipped like the generator skips it, and a file the user may not write is
    reported instead of being replaced behind its read-only mode.
    """
    if filepath.is_symlink():
        logger.warning("Skipping %s: symlinks are not allowed", filepath)
        return False
    if _is_kmz(filepath):
        # Rewriting a member of a zip archive in place is not worth the risk
        # of a broken archive; the check keeps failing until it is unzipped
        logger.error("Cannot obfuscate %s: %s", filepath, KMZ_REFUSAL)
        return False

    try:
        # newline="" keeps CRLF line endings as they are
        with open(filepath, encoding="utf-8", newline="") as f:
            content = f.read()
    except UnicodeDecodeError:
        logger.warning("Skipping %s: not valid UTF-8", filepath)
        return False
    except OSError as e:
        logger.warning("Skipping %s: cannot read file (%s)", filepath, e)
        return False

    new_content = obfuscate_kml_content(content)
    if new_content is None:
        return False

    if not os.access(filepath, os.W_OK):
        logger.error("Cannot obfuscate %s: the file is not writable", filepath)
        return False

    return _write_atomic(filepath, new_content)


def obfuscate_kml_files(filepaths: Iterable[Path]) -> int:
    """Obfuscate several files; a failure on one file does not stop the run."""
    modified = 0
    for filepath in filepaths:
        try:
            if obfuscate_kml_file(filepath):
                modified += 1
        except OSError as e:
            # Expected (a read-only or vanished file): no traceback needed
            logger.error("Failed to obfuscate %s: %s", filepath, e)
        # One file's failure must not stop the others from being scrubbed;
        # the check afterwards fails on the file that is left
        except Exception:  # noqa: BLE001
            logger.exception("Failed to obfuscate %s", filepath)
    return modified


def _charterware_name(path: Path) -> re.Match[str] | None:
    return CHARTERWARE_NAME_PATTERN.fullmatch(path.stem)


def _has_jan_first_date(match: re.Match[str]) -> bool:
    return match["month"] == "01" and match["day"] == "01"


def _used_charterware_slots(directory: Path, year: str) -> set[int]:
    """The sequence numbers of the January 1st Charterware names of a year."""
    try:
        entries = list(directory.iterdir())
    except OSError:
        return set()
    slots = set()
    for entry in entries:
        match = _charterware_name(entry)
        if match and match["year"] == year and _has_jan_first_date(match):
            slots.add(int(match["hour"]) * 60 + int(match["minute"]))
    return slots


def _free_charterware_slots(used: set[int]) -> Iterable[int]:
    """Free sequence numbers, after the highest used one first."""
    start = max(used) + 1 if used else 0
    for slot in (*range(start, MINUTES_PER_DAY), *range(start)):
        if slot not in used:
            yield slot


def _rename_exclusive(path: Path, target: Path) -> None:
    """Rename ``path`` to ``target`` unless ``target`` exists.

    os.rename replaces an existing file, so a run renaming into the same
    directory at the same time could overwrite a flight between a check and
    the rename. A hard link fails atomically instead.
    """
    if target.is_symlink():
        raise FileExistsError(target)
    try:
        os.link(path, target, follow_symlinks=False)
    except FileExistsError:
        raise
    except OSError:
        # No hard links on this file system (FAT, some network shares)
        if target.exists():
            raise FileExistsError(target) from None
        os.rename(path, target)
        return
    os.unlink(path)


def rename_charterware_files(filepaths: Iterable[Path]) -> list[Path]:
    """Move Charterware file names to January 1st without their time.

    ``2026-01-12_1513h_OE-AKI_LOAV-LOAV.kml`` becomes
    ``2026-01-01_0000h_OE-AKI_LOAV-LOAV.kml``. The time slot turns into a
    sequence number per directory and year, written as a time (0059h is
    followed by 0100h), so the names keep the format ``aircraft.py``
    recognizes and keep sorting in flight order: files are numbered in the
    order of their original names, after the highest number already in the
    directory. No existing file is ever replaced.

    Returns the given paths in their order, with the new path of every renamed
    file. A file that could not be renamed keeps its path and fails the check.
    """
    paths = list(filepaths)
    result = {path: path for path in paths}

    # The part after the time of every file to rename, by directory and year
    groups: dict[tuple[Path, str], dict[Path, str]] = {}
    for path in paths:
        # An archive is refused with its dates inside it: a new name would
        # only hide which file the refusal is about
        if _is_kmz(path):
            continue
        match = _charterware_name(path)
        if match is None or _has_jan_first_date(match) or path.is_symlink():
            continue
        groups.setdefault((path.parent, match["year"]), {})[path] = match["rest"]

    for (directory, year), rests in groups.items():
        free_slots = iter(
            _free_charterware_slots(_used_charterware_slots(directory, year))
        )
        for path in sorted(rests):
            target = None
            error: OSError | None = None
            for slot in free_slots:
                candidate = directory / (
                    f"{year}-01-01_{slot // 60:02d}{slot % 60:02d}h_"
                    f"{rests[path]}{path.suffix}"
                )
                try:
                    _rename_exclusive(path, candidate)
                except FileExistsError:
                    continue
                except OSError as e:
                    error = e
                    break
                target = candidate
                break
            if target is None:
                logger.error(
                    "Cannot rename %s: %s",
                    path,
                    error or f"no free January 1st name left for {year}",
                )
                continue
            logger.info("Renamed %s to %s", path.name, target.name)
            result[path] = target

    return [result[path] for path in paths]


def find_kml_files(directory: Path) -> list[Path]:
    """List the KML files of a directory tree, the ones the generator reads.

    The generator (``cli._collect_kml_files``) and this module share
    ``validation.find_kml_files``, so they agree on the extension (``.kml``
    and ``.KML`` alike) and on the subdirectories: a file in a subfolder of
    the data directory is checked like the generator publishes it. Symlinks
    are skipped with a warning, as the generator refuses them: rewriting one
    would replace the link with a regular file and leave the dates in its
    target.
    """
    kml_files = []
    for path in _find_kml_files(directory):
        if path.is_symlink():
            logger.warning("Skipping %s: symlinks are not allowed", path)
        else:
            kml_files.append(path)
    return kml_files


def _leftover_temp_files(directory: Path) -> list[Path]:
    """The temp files of rewrites that were killed before the rename.

    They hold the complete un-obfuscated file, with a name the KML listing
    ignores, so the check names them instead of certifying the directory.
    """
    leftovers: list[Path] = []
    for root, dirs, files in os.walk(directory):
        dirs[:] = sorted(d for d in dirs if not (Path(root) / d).is_symlink())
        leftovers.extend(
            Path(root) / name for name in sorted(files) if TEMP_FILE_PATTERN.match(name)
        )
    return leftovers


def _obfuscate_listed_files(kml_files: list[Path]) -> int:
    renamed = rename_charterware_files(kml_files)
    modified = 0
    for original, path in zip(kml_files, renamed, strict=True):
        if obfuscate_kml_files([path]) or path != original:
            modified += 1
    return modified


# Date shapes that may appear anywhere in a document written by another tool
# are those of date_tokens, plus Unix time (seconds or milliseconds), in a
# data value ("<value>1710406320</value>"), a name ("Flight 1710406320") or
# anywhere else in the text but the coordinates, which the check leaves out
# first: ten or thirteen digits that are no part of a longer number. The
# fraction of a decimal number (12.1710406320) is none either, but a dot
# after a word ("log.1710406320") is only a separator.
_EPOCH_PATTERN = re.compile(r"(?<!\d)(?<!\d\.)(\d{13}|\d{10})(?:\.\d+)?(?!\d)")
# Before 2000 a ten-digit number is no time a flight log would hold
_EPOCH_START = datetime(2000, 1, 1, tzinfo=UTC).timestamp()
# The latest a recorded flight can be: its time is never in the future. A
# day of slack covers a clock ahead of UTC.
_EPOCH_SLACK = timedelta(days=1)
# A start or end tag with its attributes. Attribute values are ids and
# references (a 13-digit style id), and the dates in them are checked by the
# date patterns, so the Unix time scan reads the text between the tags only.
# A quoted value may hold a ">".
_TAG_PATTERN = re.compile(
    r"""</?[A-Za-z_][^<>"']*(?:(?:"[^"]*"|'[^']*')[^<>"']*)*/?>"""
)
# The numbers of a view or an extent (a LookAt 1234567890 m away): distances,
# angles and positions, never a time
_VIEW_NUMBER_PATTERN = re.compile(
    r"<("
    + _PREFIX
    + r"(?:range|altitude|heading|tilt|roll|longitude|latitude|north|south|east"
    r"|west|rotation|minAltitude|maxAltitude))\b[^>]*>[^<]*</\1\s*>"
)
# The elements of KML 2.2 whose text is a reference (an anyURI): a style
# ("#1712345678901" or "styles.kml#1712345678901"), a link, an Update's
# target and a Model's texture. The fragment after "#" names an id, which
# the attribute strip already lets pass where it is declared and which the
# obfuscator cannot rewrite either, so the scan drops it here as well. The
# path before it is still read. targetId and schemaUrl are attributes in
# KML 2.2, so the tag strip covers them.
_REFERENCE_PATTERN = re.compile(
    r"<(" + _PREFIX + r"(?:styleUrl|href|targetHref|sourceHref))\b[^>]*>([^<]*)</\1\s*>"
)


def _epoch_is_obfuscated(value: str) -> bool:
    """Whether a Unix time gives neither a date nor a time of day away.

    The rewrite leaves data values alone, so only midnight passes, on
    January 1st or the days a flight runs into after it.
    """
    seconds = int(value) / (1000 if len(value) == 13 else 1)
    latest = (datetime.now(UTC) + _EPOCH_SLACK).timestamp()
    if not _EPOCH_START <= seconds < latest:
        # Not the time of a past flight: a phone number, a serial number
        return True
    dt = datetime.fromtimestamp(seconds, tz=UTC)
    return near_jan_first(dt.month, dt.day) and dt.time() == time()


def _with_markup_dropped(content: str) -> str:
    """The content, and after it again without comments and PIs.

    A reader, the parser among them, sees the text of an element without
    them: "16<!-- -->.08.2026" reads as 16.08.2026, which the patterns only
    find once the comment is out. The content itself stays, since a comment
    holds dates as well. A document whose only processing instruction is
    the XML declaration is scanned once.
    """
    body = XML_DECLARATION_PATTERN.sub("", content, count=1)
    if "<!--" not in body and "<?" not in body:
        return content
    return content + "\n" + COMMENT_PATTERN.sub("", body)


def _with_unescaped(content: str) -> str:
    if "&#" in content:
        # A parser reads "2024&#45;03&#45;14" as a date as well
        return content + "\n" + html.unescape(content)
    return content


def _epoch_text(content: str) -> str:
    """The text of ``content`` the Unix time scan reads.

    Without the tags and their attributes, both those of the document and
    those of an escaped HTML description, without the numbers of a view and
    without the id a reference points to.
    """
    text = _REFERENCE_PATTERN.sub(
        lambda match: " " + html.unescape(match.group(2)).partition("#")[0] + " ",
        _VIEW_NUMBER_PATTERN.sub(" ", content),
    )
    text = _TAG_PATTERN.sub(" ", text)
    if "&" in text:
        text = _TAG_PATTERN.sub(" ", html.unescape(text))
    return text


def _find_stray_epochs(content: str) -> list[str]:
    """The Unix times of past flights that are not midnight near January 1st.

    Anywhere in the text of ``content``: the caller strips the coordinates,
    whose digits are no times.
    """
    return [
        match.group(1)
        for match in _EPOCH_PATTERN.finditer(_epoch_text(content))
        if not _epoch_is_obfuscated(match.group(1))
    ]


def _stray_dates_of(unescaped: str, epochs: list[str]) -> list[str]:
    """The stray dates of content that ``_with_unescaped`` has prepared.

    ``epochs`` are its stray Unix times, which the caller has already
    scanned for: the scan strips the tags twice and is the slow part.
    """
    return find_date_tokens(unescaped, skip_near_jan_first=True) + epochs


def _find_stray_dates(content: str) -> list[str]:
    """Return date-like tokens that are not within the days after January 1st."""
    unescaped = _with_unescaped(content)
    return _stray_dates_of(unescaped, _find_stray_epochs(unescaped))


def _find_stray_times(content: str, stray_dates: list[str]) -> list[str]:
    """The times of day in a name or a description ("Flight 14:30").

    The obfuscator does not take them out: they have to go by hand. The
    timestamps, which ``_timestamp_violations`` checks, and the description
    dates of Charterware, which the rewrite puts at 12:00AM, are left out,
    and so are the dates already reported: the year of the next one in a
    list of dates ("2025-09-21 2025-09-22") would read as a time after it.
    """
    text = _with_unescaped(
        CHARTERWARE_DATE_PATTERN.sub("", TIMESTAMP_PATTERN.sub("", content))
    )
    for date in dict.fromkeys(stray_dates):
        text = text.replace(date, " ")
    return find_time_tokens(text)


def _timestamp_violations(content: str) -> list[str]:
    """Flights that do not start at midnight on January 1st, and dates.

    The rule of the rewrite: the first timestamp of every flight (see
    ``_timestamp_groups``) is 00:00:00 UTC on January 1st, give or take a
    fraction of a second. Any other start carries the date or the time of
    day of the flight.
    """
    timestamps = _scan_timestamps(content)
    violations = [
        (
            "Flight does not start at 00:00:00 on Jan 1: "
            f"{timestamps.first_text[group[0]]}"
        )
        for group in timestamps.groups
        if not _is_canonical_start(group[0])
    ]

    violations.extend(
        f"Timestamp not on Jan 1: {text}" for text in timestamps.dates_to_move
    )
    # Neither the parser nor the rewrite reads it, so it is left as it is:
    # a Unix time, or a local format, still holds the date and the time
    violations.extend(
        f"Timestamp not understood, remove or fix it: {text}"
        for text in timestamps.not_understood
    )
    return violations


def check_kml_obfuscated(filepath: Path) -> list[str]:
    """Check if a KML file is properly obfuscated.

    Returns a list of violation descriptions (empty means the file is clean).
    """
    violations: list[str] = []
    if _is_kmz(filepath):
        # Its dates are inside a compressed member, which neither the
        # rewrite nor this check reads
        return [f"KMZ archive: {KMZ_REFUSAL}"]
    try:
        content = filepath.read_text(encoding="utf-8")
    except (UnicodeDecodeError, OSError) as e:
        # A file that cannot be read cannot be certified as obfuscated
        return [f"Cannot read file: {e}"]

    # rename_charterware_files puts the date exactly on January 1st
    charterware_name = _charterware_name(filepath)
    if charterware_name and not _has_jan_first_date(charterware_name):
        violations.append(f"File name contains the flight date: {filepath.name}")
    else:
        violations.extend(
            f"File name contains a date: {text}"
            for text in _find_stray_dates(filepath.name)
        )
        violations.extend(
            f"File name contains a weekday: {text}"
            for text in find_weekday_tokens(filepath.name)
        )
        # A name keeps no time of day either ("1_DEHYL_1513h"): the export
        # takes it out, but the file is public. The time slot of a renamed
        # Charterware name is its sequence number.
        violations.extend(
            f"File name contains a time of day: {text}"
            for text in find_time_tokens(
                charterware_name["rest"] if charterware_name else filepath.stem
            )
        )

    violations.extend(
        f"Name element contains date: {match.group(0)}"
        for match in CHECK_NAME_DATE_PATTERN.finditer(content)
    )

    violations.extend(_timestamp_violations(content))

    violations.extend(
        f"Description date not on Jan 1 at 12:00AM: {match.group(0)}"
        for match in CHARTERWARE_DATE_PATTERN.finditer(content)
        if not _is_canonical_start(charterware_datetime(match))
    )

    violations.extend(
        f"Route name date not on Jan 1: {match.group(0)}"
        for match in ROUTE_DATE_PATTERN.finditer(content)
        if not _is_jan_first(_parse_route_date(match))
    )

    if _has_real_creator(content):
        match = CREATOR_PATTERN.search(content)
        assert match is not None  # noqa: S101 - guarded by _has_real_creator
        violations.append(f"Creator identifies the recording device: {match.group(3)}")

    # Catch-all: any remaining date-shaped token that is not January 1st (or
    # the days a flight may run into after it). The checks above only know
    # the elements this tool writes, so scan the whole document for dates a
    # different exporter may have put anywhere.
    # Coordinates cannot hold a date the parser would accept, and skipping
    # them saves most of the time the patterns take on a track
    without_coordinates = _with_markup_dropped(COORDINATES_PATTERN.sub("", content))
    unescaped = _with_unescaped(without_coordinates)
    epochs = _find_stray_epochs(unescaped)
    stray_dates = _stray_dates_of(unescaped, epochs)
    # A Unix time on January 1st fails for its time of day
    epoch_set = set(epochs)
    violations.extend(
        f"Unix time not at midnight on Jan 1, remove it: {text}"
        if text in epoch_set
        else f"Date not on Jan 1: {text}"
        for text in stray_dates
    )
    # The obfuscator neither moves a weekday along with the timestamps nor
    # takes one out: it has to go by hand
    violations.extend(
        f"Weekday gives the day of the flight away, remove it: {text}"
        for text in find_weekday_tokens(unescaped)
    )
    violations.extend(
        f"Time of day gives the flight away, remove it: {text}"
        for text in _find_stray_times(without_coordinates, stray_dates)
    )

    # A track repeats its date in every timestamp; one line per date is enough
    return list(dict.fromkeys(violations))


def _relative_name(path: Path, directory: Path) -> str:
    """The name a violation is reported under: the path below ``directory``."""
    return path.relative_to(directory).as_posix()


def _check_listed_files(kml_files: list[Path], directory: Path) -> dict[str, list[str]]:
    results: dict[str, list[str]] = {}
    for kml_file in kml_files:
        violations = check_kml_obfuscated(kml_file)
        if violations:
            results[_relative_name(kml_file, directory)] = violations
    for leftover in _leftover_temp_files(directory):
        results[_relative_name(leftover, directory)] = [
            (
                "Leftover temporary file of an interrupted rewrite, holds the "
                "original dates: remove it"
            )
        ]
    return results


def check_directory_obfuscated(directory: Path) -> dict[str, list[str]]:
    """Check all KML files in a directory tree for obfuscation violations.

    Returns a dict mapping file names (relative to ``directory``) to their
    violations; only files with violations are included. A temp file left by
    an interrupted rewrite is a violation as well.
    """
    return _check_listed_files(find_kml_files(directory), directory)


def main() -> None:
    """CLI entry point for obfuscation."""
    parser = argparse.ArgumentParser(
        description="Obfuscate (in place) or verify KML date obfuscation."
    )
    parser.add_argument(
        "directory",
        type=Path,
        help="Directory containing KML files",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Verify files are obfuscated (exit 1 if not)",
    )

    args = parser.parse_args()

    if not args.directory.is_dir():
        print(f"Error: {args.directory} is not a directory", file=sys.stderr)
        sys.exit(1)

    kml_files = find_kml_files(args.directory)
    if not args.check:
        modified = _obfuscate_listed_files(kml_files)
        print(f"Obfuscated {modified} of {len(kml_files)} KML file(s).")
        # Renamed files carry new names; a file that could not be rewritten
        # (read-only, or a date in a place the tool does not touch) fails below
        kml_files = find_kml_files(args.directory)

    violations = _check_listed_files(kml_files, args.directory)
    if violations:
        print("Obfuscation violations found:")
        for filename, issues in violations.items():
            for issue in issues:
                print(f"  {filename}: {issue}")
        if args.check:
            # A file obfuscated by an earlier version, which kept the time of
            # day, only needs the rewrite
            print(
                "Run `python -m kml_heatmap.obfuscate "
                f"{args.directory}` (`make obfuscate`) to rewrite the "
                "timestamps, dates and names it knows; remove the rest by hand."
            )
        sys.exit(1)
    if args.check:
        print(f"All {len(kml_files)} KML file(s) are properly obfuscated.")


if __name__ == "__main__":
    main()
