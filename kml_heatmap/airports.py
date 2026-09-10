"""Airport deduplication and name extraction.

Uses a spatial grid approach for O(1) proximity lookups: divides the map into
~2km grid cells and checks the cell plus 8 neighbors for nearby airports,
avoiding O(n^2) pairwise distance checks.
"""

import math
import re
from collections.abc import Callable

from .airport_lookup import extract_icao_codes_from_name, lookup_airport_coordinates
from .constants import AIRPORT_DISTANCE_THRESHOLD_KM, AIRPORT_GRID_SIZE_DEGREES
from .geometry import haversine_distance
from .logger import logger
from .types import AirportData, FlightPath, FlightPathGroup, PathMetadata

__all__ = [
    "POINT_MARKERS",
    "AirportDeduplicator",
    "deduplicate_airports",
    "extract_airport_name",
    "is_point_marker",
]

# Marker types to filter out
POINT_MARKERS = ["Log Start", "Log Stop", "Takeoff", "Landing"]

AltitudeCheck = Callable[[FlightPath, float | None], bool]


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
        self.spatial_grid: dict[tuple[int, int], list[int]] = {}

    def _get_grid_key(self, lat: float, lon: float) -> tuple[int, int]:
        """Get grid cell key for a coordinate."""
        return (math.floor(lat / self.grid_size), math.floor(lon / self.grid_size))

    def _find_nearby_airport(self, lat: float, lon: float) -> int | None:
        """Find airport within threshold using spatial grid."""
        grid_key = self._get_grid_key(lat, lon)
        # Check current cell and 8 neighbors
        for dlat in (-1, 0, 1):
            for dlon in (-1, 0, 1):
                neighbor_key = (grid_key[0] + dlat, grid_key[1] + dlon)
                for apt_idx in self.spatial_grid.get(neighbor_key, ()):
                    airport = self.unique_airports[apt_idx]
                    dist = haversine_distance(lat, lon, airport["lat"], airport["lon"])
                    if dist < AIRPORT_DISTANCE_THRESHOLD_KM:
                        return apt_idx
        return None

    def _add_to_grid(self, lat: float, lon: float, airport_idx: int) -> None:
        """Add airport to spatial grid."""
        grid_key = self._get_grid_key(lat, lon)
        self.spatial_grid.setdefault(grid_key, []).append(airport_idx)

    def add_or_update_airport(
        self,
        lat: float,
        lon: float,
        name: str | None,
        path_index: int,
        is_at_path_end: bool,
    ) -> int:
        """Add new airport or update existing one."""
        # If name contains ICAO code, use OurAirports coordinates
        # so all references to the same code merge at the right spot
        corrected_lat = lat
        corrected_lon = lon

        if name:
            icao_codes = extract_icao_codes_from_name(name)

            # For routes, extract the relevant ICAO code based on position
            if " - " in name and len(icao_codes) == 2:
                # Use departure ICAO for start, arrival ICAO for end
                icao_code = icao_codes[1] if is_at_path_end else icao_codes[0]
            elif len(icao_codes) == 1:
                icao_code = icao_codes[0]
            else:
                icao_code = None

            if icao_code:
                coords = lookup_airport_coordinates(icao_code)
                if coords:
                    corrected_lat, corrected_lon, _ = coords
                    logger.debug(
                        "Using OurAirports coordinates for %s: "
                        "(%.6f, %.6f) instead of KML (%.6f, %.6f)",
                        icao_code,
                        corrected_lat,
                        corrected_lon,
                        lat,
                        lon,
                    )

        apt_idx = self._find_nearby_airport(corrected_lat, corrected_lon)

        if apt_idx is not None:
            airport = self.unique_airports[apt_idx]

            # Prefer route names over marker names
            current_name = airport.get("name", "")
            if name and (
                not current_name
                or (is_point_marker(current_name) and not is_point_marker(name))
            ):
                airport["name"] = name

            return apt_idx

        new_idx = len(self.unique_airports)
        self.unique_airports.append(
            {
                "lat": corrected_lat,
                "lon": corrected_lon,
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


def _add_metadata_start_points(
    deduplicator: AirportDeduplicator,
    all_path_metadata: list[PathMetadata],
    all_path_groups: FlightPathGroup,
    is_mid_flight_start_func: AltitudeCheck,
) -> None:
    """Register the start point every path reported in its metadata.

    This pass sees every path, including the ones whose name is a single
    airport rather than a route, which is why it cannot be folded into
    ``_add_path_endpoints`` below. The altitude comes from the metadata's
    ``start_point`` and defaults to 0 when the point carries none.
    """
    for idx, metadata in enumerate(all_path_metadata):
        start_point = metadata["start_point"]
        start_lat, start_lon = start_point[0], start_point[1]
        start_alt = start_point[2] if len(start_point) > 2 else 0.0
        airport_name = metadata.get("airport_name", "")

        # Skip point markers - they don't contain airport info
        if is_point_marker(airport_name):
            logger.debug("Skipping point marker '%s'", airport_name)
            continue

        # Skip mid-flight starts
        path = all_path_groups[idx] if idx < len(all_path_groups) else []
        if is_mid_flight_start_func(path, start_alt):
            logger.debug("Skipping mid-flight start '%s'", airport_name)
            continue

        deduplicator.add_or_update_airport(
            lat=start_lat,
            lon=start_lon,
            name=airport_name,
            path_index=idx,
            is_at_path_end=False,
        )


def _add_path_endpoints(
    deduplicator: AirportDeduplicator,
    all_path_metadata: list[PathMetadata],
    all_path_groups: FlightPathGroup,
    is_mid_flight_start_func: AltitudeCheck,
    is_valid_landing_func: AltitudeCheck,
) -> None:
    """Register the two ends of every path whose name is a route.

    Only routes ("DEPARTURE - ARRIVAL") reach this pass, because only they say
    which airport each end belongs to. The departure is re-registered with the
    path's own first point, which is more accurate than the metadata start
    point handled above and merges into the same entry. The arrival is only
    registered when the path actually ends in a landing.
    """
    for idx, path in enumerate(all_path_groups):
        if len(path) <= 1 or idx >= len(all_path_metadata):
            continue

        start, end = path[0], path[-1]
        route_name = all_path_metadata[idx].get("airport_name", "")

        # Skip if not a proper route name
        if is_point_marker(route_name) or " - " not in route_name:
            continue

        starts_at_high_altitude = is_mid_flight_start_func(path, start.alt)
        if starts_at_high_altitude:
            logger.debug("Path '%s' detected as mid-flight start", route_name)

        if not starts_at_high_altitude:
            deduplicator.add_or_update_airport(
                lat=start.lat,
                lon=start.lon,
                name=route_name,
                path_index=idx,
                is_at_path_end=False,
            )
            logger.debug(
                "Processed departure airport for '%s' at %sm altitude",
                route_name,
                start.alt,
            )

        if is_valid_landing_func(path, end.alt):
            deduplicator.add_or_update_airport(
                lat=end.lat,
                lon=end.lon,
                name=route_name,
                path_index=idx,
                is_at_path_end=True,
            )
            logger.debug(
                "Processed arrival airport for '%s' at %sm altitude",
                route_name,
                end.alt,
            )


def deduplicate_airports(
    all_path_metadata: list[PathMetadata],
    all_path_groups: FlightPathGroup,
    is_mid_flight_start_func: AltitudeCheck,
    is_valid_landing_func: AltitudeCheck,
) -> list[AirportData]:
    """Deduplicate airports by location using spatial grid indexing.

    Two passes feed the deduplicator: the metadata start points of every path,
    then the two endpoints of the paths whose name is a route. Entries that
    land within ``AIRPORT_DISTANCE_THRESHOLD_KM`` of each other merge, so a
    departure seen by both passes stays one airport.
    """
    deduplicator = AirportDeduplicator()
    _add_metadata_start_points(
        deduplicator, all_path_metadata, all_path_groups, is_mid_flight_start_func
    )
    _add_path_endpoints(
        deduplicator,
        all_path_metadata,
        all_path_groups,
        is_mid_flight_start_func,
        is_valid_landing_func,
    )
    return deduplicator.get_unique_airports()
