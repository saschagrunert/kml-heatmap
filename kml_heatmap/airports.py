"""Airport deduplication and name extraction.

Uses a spatial grid approach for O(1) proximity lookups: divides the map into
~2km grid cells and checks the cell plus 8 neighbors for nearby airports,
avoiding O(n^2) pairwise distance checks.
"""

import math
import re
from collections.abc import Callable

from .geometry import haversine_distance
from .logger import logger
from .constants import AIRPORT_DISTANCE_THRESHOLD_KM, AIRPORT_GRID_SIZE_DEGREES
from .types import AirportData, PathMetadata

__all__ = [
    "POINT_MARKERS",
    "is_point_marker",
    "extract_airport_name",
    "deduplicate_airports",
    "AirportDeduplicator",
]

# Marker types to filter out
POINT_MARKERS = ["Log Start", "Log Stop", "Takeoff", "Landing"]


def is_point_marker(name: str | None) -> bool:
    """Check if a name represents a point marker (not a flight path)."""
    if not name:
        return True
    return any(marker in name for marker in POINT_MARKERS)


def extract_airport_name(full_name: str, is_at_path_end: bool = False) -> str | None:
    """Extract clean airport name from route name."""
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
    """Efficiently deduplicate airports using spatial grid indexing."""

    def __init__(self, grid_size: float = AIRPORT_GRID_SIZE_DEGREES):
        """Initialize the airport deduplicator."""
        self.grid_size = grid_size
        self.unique_airports: list[AirportData] = []
        self.spatial_grid: dict[tuple, list[int]] = {}

    def _get_grid_key(self, lat: float, lon: float) -> tuple[int, int]:
        """Get grid cell key for a coordinate."""
        return (math.floor(lat / self.grid_size), math.floor(lon / self.grid_size))

    def _find_nearby_airport(self, lat: float, lon: float) -> int | None:
        """Find airport within threshold using spatial grid."""
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
        name: str | None,
        timestamp: str | None,
        path_index: int,
        is_at_path_end: bool,
    ) -> int:
        """Add new airport or update existing one."""
        # If name contains ICAO code, use OurAirports coordinates for deduplication
        # This ensures all references to the same ICAO code are merged at the correct location
        corrected_lat = lat
        corrected_lon = lon

        if name:
            from .airport_lookup import (
                extract_icao_codes_from_name,
                lookup_airport_coordinates,
            )

            icao_codes = extract_icao_codes_from_name(name)

            # For routes, extract the relevant ICAO code based on position
            if " - " in name and len(icao_codes) == 2:
                # Use departure ICAO for start, arrival ICAO for end
                icao_code = icao_codes[1] if is_at_path_end else icao_codes[0]
            elif len(icao_codes) == 1:
                icao_code = icao_codes[0]
            else:
                icao_code = None

            # Look up correct coordinates if we have an ICAO code
            if icao_code:
                coords = lookup_airport_coordinates(icao_code)
                if coords:
                    corrected_lat, corrected_lon, _ = coords
                    logger.debug(
                        f"Using OurAirports coordinates for {icao_code}: "
                        f"({corrected_lat:.6f}, {corrected_lon:.6f}) "
                        f"instead of KML ({lat:.6f}, {lon:.6f})"
                    )

        # Check for duplicates using corrected coordinates
        apt_idx = self._find_nearby_airport(corrected_lat, corrected_lon)

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
            # Add new unique airport using corrected coordinates
            timestamps = (
                [timestamp] if timestamp and not is_point_marker(name or "") else []
            )
            new_idx = len(self.unique_airports)
            self.unique_airports.append(
                {
                    "lat": corrected_lat,
                    "lon": corrected_lon,
                    "timestamps": timestamps,
                    "name": name,
                    "path_index": path_index,
                    "is_at_path_end": is_at_path_end,
                }
            )
            self._add_to_grid(corrected_lat, corrected_lon, new_idx)
            return new_idx

    def get_unique_airports(self) -> list[AirportData]:
        """Get the list of deduplicated airports."""
        return self.unique_airports


def deduplicate_airports(
    all_path_metadata: list[PathMetadata],
    all_path_groups: list[list[list[float]]],
    is_mid_flight_start_func: Callable[[list[list[float]], float], bool],
    is_valid_landing_func: Callable[[list[list[float]], float], bool],
) -> list[AirportData]:
    """Deduplicate airports by location using spatial grid indexing."""
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
