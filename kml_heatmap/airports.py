"""Airport deduplication and name extraction.

This module handles the complex task of identifying unique airports from
flight path data and extracting clean airport names from various naming
formats.

Key Challenges:
1. Multiple flights to the same airport create duplicate entries
2. GPS coordinates have slight variations even for the same airport
3. Route names contain both departure and arrival airports
4. Point markers (takeoff/landing events) need filtering
5. Mid-flight starts don't have valid departure airports

Deduplication Strategy:
Uses a spatial grid approach for O(1) proximity lookups:
- Divides map into ~2km grid cells
- Checks cell + 8 neighbors for nearby airports
- Only compares airports within potentially overlapping cells
- Much faster than naive O(n²) distance checks

Name Extraction Logic:
- Handles route format: "EDAQ Halle - EDMV Vilshofen"
- Extracts departure or arrival based on position in path
- Validates ICAO codes (4-letter airport identifiers)
- Filters out single-word names without ICAO codes
- Removes point marker prefixes (Log Start, Takeoff, etc.)

Performance:
- Grid-based spatial indexing: O(1) average case lookups
- Processes thousands of flights in milliseconds
- Memory efficient with set-based deduplication
"""

import re
from typing import List, Dict, Optional, Any, Callable
from .geometry import haversine_distance
from .logger import logger
from .constants import AIRPORT_DISTANCE_THRESHOLD_KM, AIRPORT_GRID_SIZE_DEGREES

__all__ = [
    "POINT_MARKERS",
    "is_point_marker",
    "extract_airport_name",
    "deduplicate_airports",
    "AirportDeduplicator",
]

# Marker types to filter out
POINT_MARKERS = ["Log Start", "Log Stop", "Takeoff", "Landing"]


def is_point_marker(name: Optional[str]) -> bool:
    """Check if a name represents a point marker (not a flight path).

    Point markers are GPS events like "Log Start", "Takeoff", "Landing"
    that mark specific points but aren't flight paths between airports.

    Args:
        name: Name to check (can be None)

    Returns:
        True if this is a point marker, False if it's a flight path

    Example:
        >>> is_point_marker("Log Start: EDAQ")
        True
        >>> is_point_marker("EDAQ Halle - EDMV Vilshofen")
        False
    """
    if not name:
        return True
    return any(marker in name for marker in POINT_MARKERS)


def extract_airport_name(full_name: str, is_at_path_end: bool = False) -> Optional[str]:
    """
    Extract clean airport name from route name.

    Handles multiple naming formats:
    - Route format: "EDAQ Halle - EDMV Vilshofen"
    - Single airport: "EDAQ Halle"
    - ICAO only: "EDAQ"
    - City names: "Halle Airport"

    Args:
        full_name: Full airport/route name (e.g., "EDAQ Halle - EDMV Vilshofen")
        is_at_path_end: If True, extract arrival airport; else departure

    Returns:
        Cleaned airport name or None if invalid

    Example:
        >>> extract_airport_name("EDAQ Halle - EDMV Vilshofen", is_at_path_end=False)
        'EDAQ Halle'
        >>> extract_airport_name("EDAQ Halle - EDMV Vilshofen", is_at_path_end=True)
        'EDMV Vilshofen'
        >>> extract_airport_name("Unknown")
        None

    Note:
        Filters out single-word names without ICAO codes to avoid
        false positives like "Unknown" or arbitrary marker names.
    """
    if not full_name or full_name in ["Airport", "Unknown", ""]:
        return None

    # Check if it's a marker prefix that shouldn't have made it here
    marker_pattern = r"^(Log Start|Takeoff|Landing|Log Stop):\s*.+$"
    if re.match(marker_pattern, full_name):
        return None

    # Extract airport from route format "XXX - YYY"
    if " - " in full_name and full_name.count(" - ") == 1:
        parts = full_name.split(" - ")
        airport_name = parts[1].strip() if is_at_path_end else parts[0].strip()
    else:
        airport_name = full_name

    # Validate: must have ICAO code OR be multi-word name
    has_icao_code = bool(re.search(r"\b[A-Z]{4}\b", airport_name))
    is_single_word = len(airport_name.split()) == 1

    # Skip if it's "Unknown" or single-word without ICAO code
    if airport_name == "Unknown" or (not has_icao_code and is_single_word):
        return None

    return airport_name


class AirportDeduplicator:
    """
    Efficiently deduplicate airports using spatial grid indexing.

    This class provides O(1) average-case airport proximity lookups using
    a spatial grid approach, much faster than naive O(n²) distance checks.

    Attributes:
        grid_size: Size of spatial grid cells (~2km at equator)
        unique_airports: List of deduplicated airport dicts
        spatial_grid: Dict mapping grid cells to airport indices
    """

    def __init__(self, grid_size: float = AIRPORT_GRID_SIZE_DEGREES):
        """
        Initialize the airport deduplicator.

        Args:
            grid_size: Grid cell size in degrees (~2km at equator)
        """
        self.grid_size = grid_size
        self.unique_airports: List[Dict[str, Any]] = []
        self.spatial_grid: Dict[tuple, List[int]] = {}

    def _get_grid_key(self, lat: float, lon: float) -> tuple:
        """Get grid cell key for a coordinate."""
        return (int(lat / self.grid_size), int(lon / self.grid_size))

    def _find_nearby_airport(self, lat: float, lon: float) -> Optional[int]:
        """
        Find airport within threshold using spatial grid.

        Args:
            lat: Latitude
            lon: Longitude

        Returns:
            Index of nearby airport or None if not found
        """
        grid_key = self._get_grid_key(lat, lon)
        # Check current cell and 8 neighbors
        for dlat in [-1, 0, 1]:
            for dlon in [-1, 0, 1]:
                neighbor_key = (grid_key[0] + dlat, grid_key[1] + dlon)
                if neighbor_key in self.spatial_grid:
                    for apt_idx in self.spatial_grid[neighbor_key]:
                        airport = self.unique_airports[apt_idx]
                        dist = haversine_distance(
                            lat, lon, airport["lat"], airport["lon"]
                        )
                        if dist < AIRPORT_DISTANCE_THRESHOLD_KM:
                            return apt_idx
        return None

    def _add_to_grid(self, lat: float, lon: float, airport_idx: int) -> None:
        """Add airport to spatial grid."""
        grid_key = self._get_grid_key(lat, lon)
        if grid_key not in self.spatial_grid:
            self.spatial_grid[grid_key] = []
        self.spatial_grid[grid_key].append(airport_idx)

    def add_or_update_airport(
        self,
        lat: float,
        lon: float,
        name: Optional[str],
        timestamp: Optional[str],
        path_index: int,
        is_at_path_end: bool,
    ) -> int:
        """
        Add new airport or update existing one.

        Args:
            lat: Latitude
            lon: Longitude
            name: Airport name
            timestamp: Timestamp string
            path_index: Index of the path
            is_at_path_end: Whether this is at the end of a path

        Returns:
            Index of the airport (new or existing)
        """
        # Check for duplicates
        apt_idx = self._find_nearby_airport(lat, lon)

        if apt_idx is not None:
            # Update existing airport
            airport = self.unique_airports[apt_idx]
            # Only add timestamp if it's not already present (avoid duplicates)
            if (
                timestamp
                and not is_point_marker(name or "")
                and timestamp not in airport["timestamps"]
            ):
                airport["timestamps"].append(timestamp)

            # Prefer route names over marker names
            current_name = airport.get("name", "")
            if name and (
                not current_name
                or (is_point_marker(current_name) and not is_point_marker(name))
            ):
                airport["name"] = name

            return apt_idx
        else:
            # Add new unique airport
            timestamps = (
                [timestamp] if timestamp and not is_point_marker(name or "") else []
            )
            new_idx = len(self.unique_airports)
            self.unique_airports.append(
                {
                    "lat": lat,
                    "lon": lon,
                    "timestamps": timestamps,
                    "name": name,
                    "path_index": path_index,
                    "is_at_path_end": is_at_path_end,
                }
            )
            self._add_to_grid(lat, lon, new_idx)
            return new_idx

    def get_unique_airports(self) -> List[Dict[str, Any]]:
        """Get the list of deduplicated airports."""
        return self.unique_airports


def deduplicate_airports(
    all_path_metadata: List[Dict[str, Any]],
    all_path_groups: List[List[List[float]]],
    is_mid_flight_start_func: Callable[[List[List[float]], float], bool],
    is_valid_landing_func: Callable[[List[List[float]], float], bool],
) -> List[Dict[str, Any]]:
    """
    Deduplicate airports by location and extract valid airport information.

    This function uses AirportDeduplicator class for efficient spatial indexing.

    Args:
        all_path_metadata: List of metadata dicts for each path
        all_path_groups: List of path groups with altitude data
        is_mid_flight_start_func: Function to detect mid-flight starts
        is_valid_landing_func: Function to validate landings

    Returns:
        List of unique airport dicts with lat, lon, timestamps, name, etc.
    """
    deduplicator = AirportDeduplicator()

    # Process start points from metadata
    for idx, metadata in enumerate(all_path_metadata):
        start_lat, start_lon = metadata["start_point"][0], metadata["start_point"][1]
        start_alt = (
            metadata["start_point"][2] if len(metadata["start_point"]) > 2 else 0
        )
        airport_name = metadata.get("airport_name", "")

        # Skip point markers - they don't contain airport info
        if is_point_marker(airport_name):
            logger.debug(f"Skipping point marker '{airport_name}'")
            continue

        # Skip mid-flight starts
        path = all_path_groups[idx] if idx < len(all_path_groups) else []
        if is_mid_flight_start_func(path, start_alt):
            logger.debug(f"Skipping mid-flight start '{airport_name}'")
            continue

        # Add or update airport
        deduplicator.add_or_update_airport(
            lat=start_lat,
            lon=start_lon,
            name=airport_name,
            timestamp=metadata.get("timestamp"),
            path_index=idx,
            is_at_path_end=False,
        )

    # Process path endpoints (landings and takeoffs)
    for idx, path in enumerate(all_path_groups):
        if len(path) <= 1 or idx >= len(all_path_metadata):
            continue

        start_lat, start_lon, start_alt = path[0][0], path[0][1], path[0][2]
        end_lat, end_lon, end_alt = path[-1][0], path[-1][1], path[-1][2]
        route_name = all_path_metadata[idx].get("airport_name", "")
        route_timestamp = all_path_metadata[idx].get("timestamp")

        # Skip if not a proper route name
        if is_point_marker(route_name):
            continue

        # Check for mid-flight starts
        starts_at_high_altitude = is_mid_flight_start_func(path, start_alt)
        if starts_at_high_altitude:
            logger.debug(f"Path '{route_name}' detected as mid-flight start")

        # Process departure airport (if not high altitude start and is a route)
        if not starts_at_high_altitude and " - " in route_name:
            deduplicator.add_or_update_airport(
                lat=start_lat,
                lon=start_lon,
                name=route_name,
                timestamp=route_timestamp,
                path_index=idx,
                is_at_path_end=False,
            )
            logger.debug(
                f"Processed departure airport for '{route_name}' at {start_alt:.0f}m altitude"
            )

        # Process landing airport (if valid landing and is a route)
        if " - " in route_name and is_valid_landing_func(path, end_alt):
            deduplicator.add_or_update_airport(
                lat=end_lat,
                lon=end_lon,
                name=route_name,
                timestamp=route_timestamp if not starts_at_high_altitude else None,
                path_index=idx,
                is_at_path_end=True,
            )
            logger.debug(
                f"Processed arrival airport for '{route_name}' at {end_alt:.0f}m altitude"
            )

    return deduplicator.get_unique_airports()
