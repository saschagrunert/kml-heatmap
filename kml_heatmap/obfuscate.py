"""KML date and timestamp obfuscation for privacy.

Shifts all timestamps of a file so the flight starts on January 1st of its
actual year, preserving the original time-of-day and the relative intervals
between points. Covered are ``<when>`` (gx:Track and TimeStamp),
``<TimeSpan><begin>/<end>``, Charterware description dates
("Flight Jan 12 2026 03:01PM"), route names with dates
("EDDS to EDDP - 16 Aug 2026") and the SkyDemon marker names (Log Start,
Takeoff, Landing, Log Stop). The ``creator`` attribute is replaced with a
generic value. Files are rewritten atomically and in place.
"""

import argparse
import contextlib
import os
import re
import shutil
import sys
import tempfile
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import TYPE_CHECKING

from .helpers import parse_iso_timestamp
from .logger import logger

if TYPE_CHECKING:
    from collections.abc import Iterable

__all__ = [
    "check_directory_obfuscated",
    "check_kml_obfuscated",
    "obfuscate_kml_content",
    "obfuscate_kml_directory",
    "obfuscate_kml_file",
    "obfuscate_kml_files",
]

# Full ISO timestamps: gx:Track/TimeStamp <when> and TimeSpan <begin>/<end>
FULL_TIMESTAMP_PATTERN = re.compile(r"(<(when|begin|end)>)([^<]+)(</\2>)")
FRACTION_PATTERN = re.compile(r"\.\d+")

_NAME_DATE_RE = r"<name>(Log Start|Takeoff|Landing|Log Stop):\s*\d{2}\s+\w{3}\s+"
NAME_DATE_PATTERN = re.compile(_NAME_DATE_RE + r"(\d{4})\s+\d{2}:\d{2}\s+Z</name>")
CHECK_NAME_DATE_PATTERN = re.compile(_NAME_DATE_RE + r"\d{4}\s+\d{2}:\d{2}\s+Z")

# Charterware description: "Flight Jan 12 2026 03:01PM path of OE-AKI"
DESCRIPTION_DATE_PATTERN = re.compile(
    r"(Flight\s+)([A-Za-z]{3,9})\s+(\d{1,2})\s+(\d{4})\s+(\d{2}):(\d{2})(AM|PM)"
)
# Route name with date: "<name>EDDS to EDDP - 16 Aug 2026</name>"
ROUTE_DATE_PATTERN = re.compile(
    r"(<name>[^<]*?\s-\s)(\d{2})\s+([A-Za-z]{3})\s+(\d{4})(\s*</name>)"
)
CREATOR_PATTERN = re.compile(r'(\screator=")([^"]*)(")')
GENERIC_CREATOR = "kml-heatmap"

MONTHS_SHORT = (
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
)
MONTHS_LONG = (
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
)


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


def _month_number(month_str: str) -> int | None:
    lowered = month_str.lower()
    for index, name in enumerate(MONTHS_LONG):
        if lowered in (name.lower(), name[:3].lower()):
            return index + 1
    return None


def _parse_description_date(match: re.Match[str]) -> datetime | None:
    """Parse a Charterware description date match into a UTC datetime."""
    _, month_str, day, year, hour_str, minute, meridiem = match.groups()
    month = _month_number(month_str)
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
    _, day, month_str, year, _ = match.groups()
    month = _month_number(month_str)
    if month is None:
        return None
    try:
        return datetime(int(year), month, int(day), tzinfo=UTC)
    except ValueError:
        return None


def _find_anchor(content: str) -> datetime | None:
    """Find the timestamp that defines the shift (first full timestamp wins)."""
    full = FULL_TIMESTAMP_PATTERN.search(content)
    if full:
        return _parse_full_timestamp(full.group(3).strip())
    description = DESCRIPTION_DATE_PATTERN.search(content)
    if description:
        return _parse_description_date(description)
    route = ROUTE_DATE_PATTERN.search(content)
    if route:
        return _parse_route_date(route)
    return None


def _is_jan_first(dt: datetime | None) -> bool:
    return dt is not None and dt.month == 1 and dt.day == 1


def _has_real_creator(content: str) -> bool:
    """True when the creator attribute still names the recording device."""
    match = CREATOR_PATTERN.search(content)
    return match is not None and match.group(2) != GENERIC_CREATOR


def _is_already_obfuscated(first_dt: datetime, content: str) -> bool:
    """Check if a file is already obfuscated."""
    if not _is_jan_first(first_dt):
        return False
    if _has_real_creator(content):
        return False
    if CHECK_NAME_DATE_PATTERN.search(content):
        return False
    if any(
        not _is_jan_first(_parse_description_date(m))
        for m in DESCRIPTION_DATE_PATTERN.finditer(content)
    ):
        return False
    return all(
        _is_jan_first(_parse_route_date(m))
        for m in ROUTE_DATE_PATTERN.finditer(content)
    )


def obfuscate_kml_content(content: str) -> str | None:
    """Obfuscate dates and timestamps in KML content.

    Returns the obfuscated content, or None if the file is already obfuscated
    or contains no usable timestamp.
    """
    anchor = _find_anchor(content)
    if anchor is None:
        return None

    if _is_already_obfuscated(anchor, content):
        return None

    target_start = datetime(
        anchor.year,
        1,
        1,
        anchor.hour,
        anchor.minute,
        anchor.second,
        anchor.microsecond,
        tzinfo=UTC,
    )
    offset: timedelta = target_start - anchor

    def shift_full(match: re.Match[str]) -> str:
        ts_str = match.group(3).strip()
        dt = _parse_full_timestamp(ts_str)
        if dt is None:
            return match.group(0)
        shifted = _format_timestamp(dt + offset, _extract_frac(ts_str))
        return f"{match.group(1)}{shifted}{match.group(4)}"

    def shift_description(match: re.Match[str]) -> str:
        dt = _parse_description_date(match)
        if dt is None:
            return match.group(0)
        long_month = len(match.group(2)) > 3
        return _format_description_date(match.group(1), dt + offset, long_month)

    def shift_route(match: re.Match[str]) -> str:
        dt = _parse_route_date(match)
        if dt is None:
            return match.group(0)
        shifted = dt + offset
        return (
            f"{match.group(1)}{shifted.day:02d} {MONTHS_SHORT[shifted.month - 1]} "
            f"{shifted.year}{match.group(5)}"
        )

    def replace_creator(match: re.Match[str]) -> str:
        return f"{match.group(1)}{GENERIC_CREATOR}{match.group(3)}"

    new_content = FULL_TIMESTAMP_PATTERN.sub(shift_full, content)
    new_content = NAME_DATE_PATTERN.sub(r"<name>\1: \2-01-01</name>", new_content)
    new_content = DESCRIPTION_DATE_PATTERN.sub(shift_description, new_content)
    new_content = ROUTE_DATE_PATTERN.sub(shift_route, new_content)
    new_content = CREATOR_PATTERN.sub(replace_creator, new_content)

    return new_content if new_content != content else None


def _write_atomic(filepath: Path, content: str) -> bool:
    """Write content via a temp file in the same directory and os.replace."""
    tmp_name: str | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=filepath.parent,
            prefix=f".{filepath.name}.",
            suffix=".tmp",
            delete=False,
        ) as tmp:
            tmp_name = tmp.name
            tmp.write(content)
        shutil.copymode(filepath, tmp_name)
        os.replace(tmp_name, filepath)
        tmp_name = None
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

    Returns True if the file was modified, False otherwise.
    """
    try:
        content = filepath.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        logger.warning("Skipping %s: not valid UTF-8", filepath)
        return False
    except OSError as e:
        logger.warning("Skipping %s: cannot read file (%s)", filepath, e)
        return False

    new_content = obfuscate_kml_content(content)
    if new_content is None:
        return False

    return _write_atomic(filepath, new_content)


def obfuscate_kml_files(filepaths: Iterable[Path]) -> int:
    """Obfuscate several files; a failure on one file does not stop the run."""
    modified = 0
    for filepath in filepaths:
        try:
            if obfuscate_kml_file(filepath):
                modified += 1
        except Exception:
            logger.exception("Failed to obfuscate %s", filepath)
    return modified


def obfuscate_kml_directory(directory: Path) -> int:
    """Obfuscate all KML files in a directory. Returns count of modified files."""
    return obfuscate_kml_files(sorted(directory.glob("*.kml")))


# Date shapes that may appear anywhere in a document written by another tool:
# 2024-03-14, 14.03.2024, 14/03/2024 and "14 Mar 2024" / "March 14 2024".
_STRAY_DATE_PATTERNS = (
    re.compile(r"\b(\d{4})-(\d{2})-(\d{2})\b"),
    re.compile(r"\b(\d{2})[./](\d{2})[./](\d{4})\b"),
)
_STRAY_TEXT_MONTH = re.compile(
    r"\b(\d{1,2})\s+([A-Z][a-z]{2,8})\s+(\d{4})\b|"
    r"\b([A-Z][a-z]{2,8})\s+(\d{1,2}),?\s+(\d{4})\b"
)


def _find_stray_dates(content: str) -> list[str]:
    """Return date-like tokens in the document that are not January 1st."""
    found: list[str] = []

    for pattern in _STRAY_DATE_PATTERNS:
        for match in pattern.finditer(content):
            groups = match.groups()
            # ISO puts the year first, the dotted format puts the day first
            month, day = (
                (groups[1], groups[2])
                if len(groups[0]) == 4
                else (groups[1], groups[0])
            )
            if (month, day) != ("01", "01"):
                found.append(match.group(0))

    months = {name.lower(): i + 1 for i, name in enumerate(MONTHS_LONG)}
    months.update({name.lower(): i + 1 for i, name in enumerate(MONTHS_SHORT)})
    for match in _STRAY_TEXT_MONTH.finditer(content):
        if match.group(1) is not None:
            day, month_name = match.group(1), match.group(2)
        else:
            day, month_name = match.group(5), match.group(4)
        month = months.get(month_name.lower())
        if month is not None and (month, int(day)) != (1, 1):
            found.append(match.group(0))

    return found


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

    violations.extend(
        f"Name element contains date: {match.group(0)}"
        for match in CHECK_NAME_DATE_PATTERN.finditer(content)
    )

    first_full = FULL_TIMESTAMP_PATTERN.search(content)
    if first_full:
        ts_str = first_full.group(3).strip()
        dt = _parse_full_timestamp(ts_str)
        if dt is not None and not _is_jan_first(dt):
            violations.append(f"First timestamp not on Jan 1: {ts_str}")

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
        violations.append(f"Creator identifies the recording device: {match.group(2)}")

    # Catch-all: any remaining date-shaped token that is not January 1st.
    # The checks above only know the elements this tool writes, so scan the
    # whole document for dates a different exporter may have put anywhere.
    violations.extend(
        f"Date not on Jan 1: {text}" for text in _find_stray_dates(content)
    )

    return violations


def check_directory_obfuscated(directory: Path) -> dict[str, list[str]]:
    """Check all KML files in a directory for obfuscation violations.

    Returns a dict mapping filenames to their violations (only files
    with violations are included).
    """
    results: dict[str, list[str]] = {}
    for kml_file in sorted(directory.glob("*.kml")):
        violations = check_kml_obfuscated(kml_file)
        if violations:
            results[kml_file.name] = violations
    return results


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

    kml_count = len(list(args.directory.glob("*.kml")))
    if args.check:
        violations = check_directory_obfuscated(args.directory)
        if violations:
            print("Obfuscation violations found:")
            for filename, issues in violations.items():
                for issue in issues:
                    print(f"  {filename}: {issue}")
            sys.exit(1)
        print(f"All {kml_count} KML file(s) are properly obfuscated.")
    else:
        modified = obfuscate_kml_directory(args.directory)
        print(f"Obfuscated {modified} of {kml_count} KML file(s).")


if __name__ == "__main__":
    main()
