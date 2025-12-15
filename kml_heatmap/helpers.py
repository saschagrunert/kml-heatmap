"""Helper functions for common operations.

This module provides reusable utility functions that are used across
multiple modules to reduce code duplication and maintain consistency.

Functions Overview:
-------------------

parse_iso_timestamp(timestamp_str)
    Parse ISO 8601 timestamp strings into datetime objects.
    Handles various formats including Zulu time (Z suffix) and timezone offsets.

    Example:
        >>> dt = parse_iso_timestamp("2025-03-15T14:30:00Z")
        >>> dt.year, dt.month, dt.day
        (2025, 3, 15)

calculate_duration_seconds(start_timestamp, end_timestamp)
    Calculate duration in seconds between two ISO timestamps.
    Returns None if either timestamp is invalid.

    Example:
        >>> duration = calculate_duration_seconds(
        ...     "2025-03-15T14:00:00Z",
        ...     "2025-03-15T16:30:00Z"
        ... )
        >>> duration  # 2.5 hours = 9000 seconds
        9000

format_flight_time(total_seconds)
    Format duration as human-readable string (e.g., "2h 30m").

    Example:
        >>> format_flight_time(9000)
        '2h 30m'
        >>> format_flight_time(45)
        '45s'

parse_coordinates_from_string(coord_str)
    Parse coordinate string in KML format (lon,lat,alt or lon,lat).
    Returns tuple of (lat, lon, alt) with altitude optional.

    Example:
        >>> lat, lon, alt = parse_coordinates_from_string("8.5,50.0,300")
        >>> lat, lon, alt
        (50.0, 8.5, 300.0)

Design Principles:
------------------
- Type-safe with comprehensive type hints
- Robust error handling (returns None on failure)
- Pure functions without side effects
- No external dependencies beyond stdlib
- Consistent naming and parameter order
"""

from datetime import datetime
from typing import Optional, Tuple
from .constants import SECONDS_PER_HOUR

__all__ = [
    'parse_iso_timestamp',
    'calculate_duration_seconds',
    'format_flight_time',
    'parse_coordinates_from_string',
]


def parse_iso_timestamp(timestamp_str: str) -> Optional[datetime]:
    """
    Parse ISO format timestamp string to datetime object.

    Args:
        timestamp_str: Timestamp string in ISO format (e.g., "2025-03-03T08:58:01Z")

    Returns:
        datetime object or None if parsing fails
    """
    if not timestamp_str or 'T' not in timestamp_str:
        return None

    try:
        return datetime.fromisoformat(timestamp_str.replace('Z', '+00:00'))
    except (ValueError, TypeError):
        return None


def calculate_duration_seconds(start_timestamp: Optional[str], end_timestamp: Optional[str]) -> float:
    """
    Calculate duration in seconds between two ISO timestamp strings.

    Args:
        start_timestamp: Start time in ISO format
        end_timestamp: End time in ISO format

    Returns:
        Duration in seconds, or 0 if parsing fails
    """
    if not start_timestamp or not end_timestamp:
        return 0.0

    start_dt = parse_iso_timestamp(start_timestamp)
    end_dt = parse_iso_timestamp(end_timestamp)

    if start_dt and end_dt:
        return (end_dt - start_dt).total_seconds()

    return 0.0


def format_flight_time(seconds: float) -> str:
    """
    Format flight time in seconds to human-readable string.

    Args:
        seconds: Time in seconds

    Returns:
        Formatted string like "2h 15m" or "45m"
    """
    if seconds <= 0:
        return "---"

    hours = int(seconds // SECONDS_PER_HOUR)
    minutes = int((seconds % SECONDS_PER_HOUR) // 60)

    if hours > 0:
        return f"{hours}h {minutes}m"
    return f"{minutes}m"


def parse_coordinates_from_string(coord_str: str) -> Optional[Tuple[float, float, Optional[float]]]:
    """
    Parse coordinate string in KML format.

    Args:
        coord_str: Coordinate string like "lon,lat,alt" or "lon,lat"

    Returns:
        Tuple of (lat, lon, alt) where alt may be None, or None if parsing fails
    """
    if not coord_str:
        return None

    parts = coord_str.strip().split(',')
    if len(parts) < 2:
        return None

    try:
        lon = float(parts[0])
        lat = float(parts[1])
        alt = float(parts[2]) if len(parts) >= 3 else None
        return (lat, lon, alt)
    except (ValueError, IndexError):
        return None
