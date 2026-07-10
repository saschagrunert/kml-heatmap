"""KML timestamp obfuscation for privacy.

Shifts all <when> timestamps so each flight starts on January 1st of its
actual year, preserving the original time-of-day and relative intervals
between points. Strips dates from Placemark name elements (Log Start,
Takeoff, Landing, Log Stop) while keeping the labels and year.
"""

import argparse
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional

WHEN_PATTERN = re.compile(r"(<when>)([^<]+)(</when>)")

NAME_DATE_PATTERN = re.compile(
    r"<name>(Log Start|Takeoff|Landing|Log Stop):\s*\d{2}\s+\w{3}\s+(\d{4})\s+\d{2}:\d{2}\s+Z</name>",
)
CHECK_NAME_DATE_PATTERN = re.compile(
    r"<name>(Log Start|Takeoff|Landing|Log Stop):\s*\d{2}\s+\w{3}\s+\d{4}\s+\d{2}:\d{2}\s+Z"
)


def _parse_timestamp(ts_str: str) -> Optional[datetime]:
    """Parse an ISO 8601 timestamp, handling Z suffix and high precision."""
    ts_str = ts_str.strip()
    if not ts_str or "T" not in ts_str:
        return None
    try:
        return datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None


def _extract_frac(ts_str: str) -> str:
    """Extract the fractional seconds portion (e.g. '.5848380') from a timestamp."""
    dot = ts_str.find(".")
    if dot == -1:
        return ""
    end = ts_str.find("Z", dot)
    return ts_str[dot : end if end != -1 else len(ts_str)]


def _format_timestamp(dt: datetime, frac: str = "") -> str:
    """Format a datetime back to KML timestamp format, preserving original fractional precision."""
    base = dt.strftime("%Y-%m-%dT%H:%M:%S")
    return f"{base}{frac}Z"


def _is_already_obfuscated(first_dt: datetime, content: str) -> bool:
    """Check if a file is already obfuscated."""
    if first_dt.month != 1 or first_dt.day != 1:
        return False
    if CHECK_NAME_DATE_PATTERN.search(content):
        return False
    return True


def obfuscate_kml_content(content: str) -> Optional[str]:
    """Obfuscate timestamps in KML content string.

    Returns the obfuscated content, or None if already obfuscated or no
    timestamps found.
    """
    when_matches = WHEN_PATTERN.findall(content)
    if not when_matches:
        return None

    first_ts_str = when_matches[0][1].strip()
    first_dt = _parse_timestamp(first_ts_str)
    if first_dt is None:
        return None

    if _is_already_obfuscated(first_dt, content):
        return None

    target_start = datetime(
        first_dt.year,
        1,
        1,
        first_dt.hour,
        first_dt.minute,
        first_dt.second,
        first_dt.microsecond,
        tzinfo=timezone.utc,
    )
    offset = target_start - first_dt

    def shift_when(match: re.Match[str]) -> str:
        ts_str = match.group(2).strip()
        dt = _parse_timestamp(ts_str)
        if dt is None:
            return match.group(0)
        shifted = dt + offset
        frac = _extract_frac(ts_str)
        return match.group(1) + _format_timestamp(shifted, frac) + match.group(3)

    new_content = WHEN_PATTERN.sub(shift_when, content)
    new_content = NAME_DATE_PATTERN.sub(r"<name>\1: \2-01-01</name>", new_content)

    return new_content if new_content != content else None


def obfuscate_kml_file(filepath: Path) -> bool:
    """Obfuscate timestamps in a KML file in-place.

    Returns True if the file was modified, False if already obfuscated.
    """
    content = filepath.read_text(encoding="utf-8")
    new_content = obfuscate_kml_content(content)
    if new_content is None:
        return False
    filepath.write_text(new_content, encoding="utf-8")
    return True


def obfuscate_kml_directory(directory: Path) -> int:
    """Obfuscate all KML files in a directory. Returns count of modified files."""
    modified = 0
    for kml_file in sorted(directory.glob("*.kml")):
        if obfuscate_kml_file(kml_file):
            modified += 1
    return modified


def check_kml_obfuscated(filepath: Path) -> List[str]:
    """Check if a KML file is properly obfuscated.

    Returns a list of violation descriptions (empty means the file is clean).
    """
    violations: List[str] = []
    content = filepath.read_text(encoding="utf-8")

    for match in CHECK_NAME_DATE_PATTERN.finditer(content):
        violations.append(f"Name element contains date: {match.group(0)}")

    first_when = WHEN_PATTERN.search(content)
    if first_when:
        dt = _parse_timestamp(first_when.group(2).strip())
        if dt and (dt.month != 1 or dt.day != 1):
            violations.append(
                f"First timestamp not on Jan 1: {first_when.group(2).strip()}"
            )

    return violations


def check_directory_obfuscated(directory: Path) -> Dict[str, List[str]]:
    """Check all KML files in a directory for obfuscation violations.

    Returns a dict mapping filenames to their violations (only files
    with violations are included).
    """
    results: Dict[str, List[str]] = {}
    for kml_file in sorted(directory.glob("*.kml")):
        violations = check_kml_obfuscated(kml_file)
        if violations:
            results[kml_file.name] = violations
    return results


def main() -> None:
    """CLI entry point for obfuscation."""
    parser = argparse.ArgumentParser(
        description="Obfuscate or verify KML timestamp obfuscation."
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
        print(f"Error: {args.directory} is not a directory")
        sys.exit(1)

    if args.check:
        violations = check_directory_obfuscated(args.directory)
        if violations:
            print("Obfuscation violations found:")
            for filename, issues in violations.items():
                for issue in issues:
                    print(f"  {filename}: {issue}")
            sys.exit(1)
        else:
            kml_count = len(list(args.directory.glob("*.kml")))
            print(f"All {kml_count} KML file(s) are properly obfuscated.")
    else:
        modified = obfuscate_kml_directory(args.directory)
        kml_count = len(list(args.directory.glob("*.kml")))
        print(f"Obfuscated {modified} of {kml_count} KML file(s).")


if __name__ == "__main__":
    main()
