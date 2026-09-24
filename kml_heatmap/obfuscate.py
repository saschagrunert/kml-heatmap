"""KML date and timestamp obfuscation for privacy.

Shifts the timestamps of a file so that every flight starts on January 1st of
its actual (UTC) year, preserving the time of day and the intervals between
the points of a flight. The timestamps are grouped into flights (see
``_timestamp_groups``), so a file with flights on several dates puts each of
them on January 1st of its own year. Covered are ``<when>`` (gx:Track and
TimeStamp) and ``<TimeSpan><begin>/<end>``, with or without a namespace
prefix.

Dates without a time move to January 1st of their own year: date-only
timestamps, Charterware description dates ("Flight Jan 12 2026 03:01PM"),
route names with dates ("EDDS to EDDP - 16 Aug 2026") and the SkyDemon marker
names (Log Start, Takeoff, Landing, Log Stop). The ``creator`` attribute is
replaced with a generic value. Files are rewritten atomically and in place;
``rename_charterware_files`` removes the date and time from Charterware file
names ("2026-01-12_1513h_OE-AKI_LOAV-LOAV.kml").
"""

import argparse
import contextlib
import html
import os
import re
import shutil
import sys
import tempfile
from bisect import bisect_right
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import TYPE_CHECKING, NamedTuple

from .date_tokens import (
    MONTHS_LONG,
    MONTHS_SHORT,
    find_date_tokens,
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
    "obfuscate_kml_directory",
    "obfuscate_kml_file",
    "obfuscate_kml_files",
    "rename_charterware_files",
]

# An optional namespace prefix of an element name ("kml:when")
_PREFIX = r"(?:[\w.-]+:)?"

# gx:Track/TimeStamp <when> and TimeSpan <begin>/<end>, plain or in CDATA
TIMESTAMP_PATTERN = re.compile(
    r"(<(" + _PREFIX + r"(?:when|begin|end))\b[^>]*>)"
    r"((?:<!\[CDATA\[.*?\]\]>|[^<])*)(</\2\s*>)"
)
CDATA_PATTERN = re.compile(r"^\s*<!\[CDATA\[(.*?)\]\]>\s*$", re.DOTALL)
FRACTION_PATTERN = re.compile(r"\.\d+")
UTC_OFFSET_PATTERN = re.compile(r"[+-]\d{2}:?\d{2}$")
# Valid KML timestamps without a time: xsd:date and xsd:gYearMonth
DATE_ONLY_PATTERN = re.compile(r"(\d{4})-\d{2}-\d{2}(Z|[+-]\d{2}:\d{2})?")
YEAR_MONTH_PATTERN = re.compile(r"(\d{4})-(\d{2})(Z|[+-]\d{2}:\d{2})?")

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

# Charterware description: "Flight Jan 12 2026 03:01PM path of OE-AKI"
DESCRIPTION_DATE_PATTERN = re.compile(
    r"(Flight\s+)([A-Za-z]{3,9})\s+(\d{1,2})\s+(\d{4})\s+(\d{1,2}):(\d{2})(AM|PM)"
)
# Route name with date: "<name>EDDS to EDDP - 16 Aug 2026</name>"
ROUTE_DATE_PATTERN = re.compile(
    r"(?P<head><(?P<tag>" + _PREFIX + r"name)\b[^>]*>[^<]*?\s-\s)"
    r"(?P<day>\d{1,2})\s+(?P<month>[A-Za-z]{3})\s+(?P<year>\d{4})"
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

# The temp file of _write_atomic: ".<name>.kml.XXXXXXXX.tmp"
TEMP_FILE_PATTERN = re.compile(r"^\..*\.kml\.[^.]+\.tmp$", re.IGNORECASE)

# Timestamps further apart than this belong to different flights, unless they
# are in the same Placemark (see _timestamp_groups)
FLIGHT_GAP = timedelta(hours=12)
# Closer than this, timestamps are one flight even across New Year
CONTINUOUS_GAP = timedelta(hours=2)

# Coordinate lists: most of a track's text, and numbers only
COORDINATES_PATTERN = re.compile(
    r"<(" + _PREFIX + r"(?:coordinates|coord))\b[^>]*>[^<]*</\1\s*>"
)

PLACEMARK_PATTERN = re.compile(r"<(" + _PREFIX + r"Placemark)\b.*?</\1\s*>", re.DOTALL)


def _timestamp_text(raw: str) -> str:
    """The timestamp of a <when> element in the form the rewrite emits.

    A CDATA section is unwrapped, a space between date and time becomes the
    "T" and a lowercase "z" the "Z"; anything else is left as it is.
    """
    text = raw.strip()
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
    """Extract the fractional seconds portion (e.g. '.5848380') from a timestamp."""
    match = FRACTION_PATTERN.search(ts_str)
    return match.group(0) if match else ""


def _format_timestamp(dt: datetime, frac: str = "") -> str:
    """Format a UTC datetime back to KML timestamp format."""
    return f"{dt.strftime('%Y-%m-%dT%H:%M:%S')}{frac}Z"


def _parse_description_date(match: re.Match[str]) -> datetime | None:
    """Parse a Charterware description date match into a UTC datetime."""
    _, month_str, day, year, hour_str, minute, meridiem = match.groups()
    month = month_number(month_str)
    if month is None:
        return None
    hour = int(hour_str)
    if meridiem == "PM" and hour != 12:
        hour += 12
    elif meridiem == "AM" and hour == 12:
        hour = 0
    try:
        return datetime(int(year), month, int(day), hour, int(minute), tzinfo=UTC)
    except ValueError:
        return None


def _format_description_date(prefix: str, dt: datetime, long_month: bool) -> str:
    month = MONTHS_LONG[dt.month - 1] if long_month else MONTHS_SHORT[dt.month - 1]
    hour12 = dt.hour % 12 or 12
    meridiem = "AM" if dt.hour < 12 else "PM"
    return (
        f"{prefix}{month} {dt.day:02d} {dt.year} {hour12:02d}:{dt.minute:02d}{meridiem}"
    )


def _parse_route_date(match: re.Match[str]) -> datetime | None:
    """Parse a route name date match ("16 Aug 2026") into a UTC datetime."""
    month = month_number(match["month"])
    if month is None:
        return None
    try:
        return datetime(int(match["year"]), month, int(match["day"]), tzinfo=UTC)
    except ValueError:
        return None


def _is_jan_first(dt: datetime | None) -> bool:
    return dt is not None and dt.month == 1 and dt.day == 1


def _timestamp_groups(
    timestamps: Iterable[datetime], placemarks: Iterable[Iterable[datetime]]
) -> list[list[datetime]]:
    """Group timestamps into flights, each sorted, in the order of their start.

    A Placemark is one piece of a flight however long it runs, and so is each
    timestamp outside a Placemark. Pieces in time order join the flight
    before them when they overlap it, when they follow it within
    ``CONTINUOUS_GAP`` (a pause within one flight), or when they follow it within
    ``FLIGHT_GAP`` in the same UTC year; a flight on January 1st must not
    move into the year of the flight that ended the night before. A flight is
    never split: one that runs past the days after January 1st keeps its
    intervals and fails the check instead of running backwards in time.
    """
    pieces = [sorted(set(placemark)) for placemark in placemarks]
    in_placemark = {dt for piece in pieces for dt in piece}
    pieces = [piece for piece in pieces if piece]
    pieces.extend([dt] for dt in set(timestamps) - in_placemark)
    pieces.sort()

    groups: list[list[datetime]] = []
    group_end: datetime | None = None
    for piece in pieces:
        start = piece[0]
        if group_end is not None and (
            start <= group_end
            or start - group_end <= CONTINUOUS_GAP
            or (start - group_end <= FLIGHT_GAP and start.year == groups[-1][0].year)
        ):
            groups[-1].extend(piece)
            group_end = max(group_end, piece[-1])
        else:
            groups.append(list(piece))
            group_end = piece[-1]
    return [sorted(set(group)) for group in groups]


def _timestamp_offsets(groups: list[list[datetime]]) -> dict[datetime, timedelta]:
    """Map every timestamp to the shift that puts its flight on January 1st.

    The start of a flight moves to January 1st of its year at the same time
    of day, and the rest of the flight moves with it. A second pass finds
    every flight on January 1st already.
    """
    offsets: dict[datetime, timedelta] = {}
    for group in groups:
        start = group[0]
        offset = start.replace(month=1, day=1) - start
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


def _scan_timestamps(content: str) -> _Timestamps:
    first_text: dict[datetime, str] = {}
    has_utc_offset = False
    has_loose_text = False
    dates_to_move: list[str] = []
    spans = [match.span() for match in PLACEMARK_PATTERN.finditer(content)]
    span_starts = [start for start, _ in spans]
    placemarks: list[list[datetime]] = [[] for _ in spans]
    for match in TIMESTAMP_PATTERN.finditer(content):
        text = _timestamp_text(match.group(3))
        if text != match.group(3):
            has_loose_text = True
        dt = _parse_full_timestamp(text)
        if dt is not None:
            first_text.setdefault(dt, text)
            if not has_utc_offset:
                has_utc_offset = UTC_OFFSET_PATTERN.search(text) is not None
            index = bisect_right(span_starts, match.start()) - 1
            if index >= 0 and match.start() < spans[index][1]:
                placemarks[index].append(dt)
        elif _date_only_on_jan_first(text) not in (None, text):
            dates_to_move.append(text)
    groups = _timestamp_groups(first_text, placemarks)
    return _Timestamps(
        first_text, groups, has_utc_offset, dates_to_move, has_loose_text
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
    def description_on_jan_first(match: re.Match[str]) -> str:
        dt = _parse_description_date(match)
        if dt is None:
            return match.group(0)
        long_month = len(match.group(2)) > 3
        return _format_description_date(
            match.group(1), dt.replace(month=1, day=1), long_month
        )

    def route_on_jan_first(match: re.Match[str]) -> str:
        if _parse_route_date(match) is None:
            return match.group(0)
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
    new_content = DESCRIPTION_DATE_PATTERN.sub(description_on_jan_first, new_content)
    new_content = ROUTE_DATE_PATTERN.sub(route_on_jan_first, new_content)
    new_content = CREATOR_PATTERN.sub(replace_creator, new_content)

    return new_content if new_content != content else None


def _fsync_directory(directory: Path) -> None:
    """Flush a directory entry to disk (best effort, not every FS supports it)."""
    try:
        fd = os.open(directory, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)


def _write_atomic(filepath: Path, content: str) -> bool:
    """Write content via a temp file in the same directory and os.replace.

    The file being replaced is the user's only copy of the flight, so the data
    is flushed to disk before the rename and the directory entry after it: a
    crash in between leaves either the old file or the complete new one. Line
    endings are written as they were read, and the file keeps its mode.
    """
    tmp_name: str | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            newline="",
            dir=filepath.parent,
            prefix=f".{filepath.name}.",
            suffix=".tmp",
            delete=False,
        ) as tmp:
            tmp_name = tmp.name
            tmp.write(content)
            tmp.flush()
            os.fsync(tmp.fileno())
        shutil.copymode(filepath, tmp_name)
        os.replace(tmp_name, filepath)
        tmp_name = None
        _fsync_directory(filepath.parent)
    except OSError as e:
        logger.warning("Skipping %s: failed to write (%s)", filepath, e)
        return False
    finally:
        if tmp_name is not None:
            with contextlib.suppress(OSError):
                os.unlink(tmp_name)
    return True


def obfuscate_kml_file(filepath: Path) -> bool:
    """Obfuscate a KML file in place.

    Returns True if the file was modified, False otherwise. A symlink is
    skipped like the generator skips it, and a file the user may not write is
    reported instead of being replaced behind its read-only mode.
    """
    if filepath.is_symlink():
        logger.warning("Skipping %s: symlinks are not allowed", filepath)
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
        except Exception:
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


def obfuscate_kml_directory(directory: Path) -> int:
    """Obfuscate all KML files in a directory, including Charterware names.

    Returns the number of files that were renamed or rewritten.
    """
    return _obfuscate_listed_files(find_kml_files(directory))


# Date shapes that may appear anywhere in a document written by another tool
# are those of date_tokens, plus one only data values hold:
# Unix time (seconds or milliseconds) in a data value: "<value>1710406320</value>"
_EPOCH_VALUE_PATTERN = re.compile(
    r"<("
    + _PREFIX
    + r"(?:value|SimpleData))\b[^>]*>\s*(\d{10}|\d{13})(?:\.\d+)?\s*</\1\s*>"
)
_EPOCH_RANGE = (
    datetime(2000, 1, 1, tzinfo=UTC).timestamp(),
    datetime(2100, 1, 1, tzinfo=UTC).timestamp(),
)


def _epoch_near_jan_first(value: str) -> bool:
    seconds = int(value) / (1000 if len(value) == 13 else 1)
    if not _EPOCH_RANGE[0] <= seconds < _EPOCH_RANGE[1]:
        # Not a time of this era: some other number
        return True
    dt = datetime.fromtimestamp(seconds, tz=UTC)
    return near_jan_first(dt.month, dt.day)


def _find_stray_dates(content: str) -> list[str]:
    """Return date-like tokens that are not within the days after January 1st."""
    if "&#" in content:
        # A parser reads "2024&#45;03&#45;14" as a date as well
        content = content + "\n" + html.unescape(content)
    found = find_date_tokens(content, skip_near_jan_first=True)
    found.extend(
        match.group(2)
        for match in _EPOCH_VALUE_PATTERN.finditer(content)
        if not _epoch_near_jan_first(match.group(2))
    )
    return found


def _timestamp_violations(content: str) -> list[str]:
    """Flights that do not start on January 1st, and date-only timestamps."""
    timestamps = _scan_timestamps(content)
    violations = [
        f"Flight does not start on Jan 1: {timestamps.first_text[group[0]]}"
        for group in timestamps.groups
        if not _is_jan_first(group[0])
    ]

    violations.extend(
        f"Timestamp not on Jan 1: {text}" for text in timestamps.dates_to_move
    )
    return violations


def check_kml_obfuscated(filepath: Path) -> list[str]:
    """Check if a KML file is properly obfuscated.

    Returns a list of violation descriptions (empty means the file is clean).
    """
    violations: list[str] = []
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
        f"Name element contains date: {match.group(0)}"
        for match in CHECK_NAME_DATE_PATTERN.finditer(content)
    )

    violations.extend(_timestamp_violations(content))

    violations.extend(
        f"Description date not on Jan 1: {match.group(0)}"
        for match in DESCRIPTION_DATE_PATTERN.finditer(content)
        if not _is_jan_first(_parse_description_date(match))
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
    violations.extend(
        f"Date not on Jan 1: {text}"
        for text in _find_stray_dates(COORDINATES_PATTERN.sub("", content))
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
        sys.exit(1)
    if args.check:
        print(f"All {len(kml_files)} KML file(s) are properly obfuscated.")


if __name__ == "__main__":
    main()
