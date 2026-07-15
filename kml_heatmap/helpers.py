"""Helper functions for common operations."""

import re
from datetime import datetime
from pathlib import Path

from .constants import SECONDS_PER_HOUR

__all__ = [
    "parse_iso_timestamp",
    "calculate_duration_seconds",
    "format_flight_time",
    "parse_coordinates_from_string",
    "numeric_filename_key",
]


def parse_iso_timestamp(timestamp_str: str) -> datetime | None:
    """Parse ISO format timestamp string to datetime object."""
    if not timestamp_str or "T" not in timestamp_str:
        return None

    try:
        return datetime.fromisoformat(timestamp_str.replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None


def calculate_duration_seconds(
    start_timestamp: str | None, end_timestamp: str | None
) -> float:
    """Calculate duration in seconds between two ISO timestamp strings."""
    if not start_timestamp or not end_timestamp:
        return 0.0

    start_dt = parse_iso_timestamp(start_timestamp)
    end_dt = parse_iso_timestamp(end_timestamp)

    if start_dt and end_dt:
        return (end_dt - start_dt).total_seconds()

    return 0.0


def format_flight_time(seconds: float) -> str:
    """Format flight time in seconds to human-readable string."""
    if seconds <= 0:
        return "---"

    hours = int(seconds // SECONDS_PER_HOUR)
    minutes = int((seconds % SECONDS_PER_HOUR) // 60)

    if hours > 0:
        return f"{hours}h {minutes}m"
    return f"{minutes}m"


def numeric_filename_key(path: str) -> tuple[int, int, str]:
    """Sort key that orders files numerically by leading digits in the filename."""
    name = Path(path).name
    match = re.match(r"(\d+)", name)
    if match:
        return (0, int(match.group(1)), name)
    return (1, 0, name)


def parse_coordinates_from_string(
    coord_str: str,
) -> tuple[float, float, float | None] | None:
    """Parse coordinate string in KML format (lon,lat,alt or lon,lat)."""
    if not coord_str:
        return None

    parts = coord_str.strip().split(",")
    if len(parts) < 2:
        return None

    try:
        lon = float(parts[0])
        lat = float(parts[1])
        alt = float(parts[2]) if len(parts) >= 3 else None
        return (lat, lon, alt)
    except (ValueError, IndexError):
        return None
