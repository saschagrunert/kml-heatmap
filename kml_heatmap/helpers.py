"""Helper functions for common operations."""

import re
from datetime import UTC, datetime
from pathlib import Path

__all__ = [
    "DATE_PATTERN",
    "calculate_duration_seconds",
    "numeric_filename_key",
    "parse_iso_timestamp",
    "parse_timestamp_epoch",
]

# A date as flight logs write it into names: "16 Aug 2026" or "2026-08-16"
DATE_PATTERN = re.compile(r"(\d{2}\s+\w{3}\s+\d{4}|\d{4}-\d{2}-\d{2})")


def parse_iso_timestamp(timestamp_str: str | None) -> datetime | None:
    """Parse ISO format timestamp string to datetime object."""
    if not timestamp_str or "T" not in timestamp_str:
        return None

    try:
        return datetime.fromisoformat(timestamp_str)
    except ValueError, TypeError:
        return None


def parse_timestamp_epoch(timestamp_str: str | None) -> float | None:
    """Parse an ISO timestamp to Unix epoch seconds (naive values are UTC)."""
    dt = parse_iso_timestamp(timestamp_str)
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt.timestamp()


def calculate_duration_seconds(
    start_timestamp: str | None, end_timestamp: str | None
) -> float:
    """Calculate duration in seconds between two ISO timestamp strings."""
    if not start_timestamp or not end_timestamp:
        return 0.0

    start = parse_timestamp_epoch(start_timestamp)
    end = parse_timestamp_epoch(end_timestamp)

    if start is not None and end is not None:
        return end - start

    return 0.0


def numeric_filename_key(path: str) -> tuple[int, int, str]:
    """Sort key that orders files numerically by leading digits in the filename."""
    name = Path(path).name
    match = re.match(r"(\d+)", name)
    if match:
        return (0, int(match.group(1)), name)
    return (1, 0, name)
