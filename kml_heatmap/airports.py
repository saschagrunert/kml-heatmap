"""Airport deduplication, name extraction and the altitude heuristics behind it.

Uses a spatial grid approach for O(1) proximity lookups: divides the map into
~2km grid cells and checks the cells within the merge distance for nearby
airports, avoiding O(n^2) pairwise distance checks.
"""

import math
import re
from typing import TYPE_CHECKING

from .airport_lookup import (
    airport_icao_code,
    lookup_airport_coordinates,
    lookup_airport_elevation,
    split_route_name,
)
from .constants import (
    AIRPORT_DISTANCE_THRESHOLD_KM,
    AIRPORT_GRID_SIZE_DEGREES,
    LANDING_FALLBACK_ALTITUDE_M,
    LANDING_MAX_ALTITUDE_M,
    LANDING_MAX_VARIATION_M,
    MID_FLIGHT_MAX_VARIATION_M,
    MID_FLIGHT_MIN_ALTITUDE_M,
    PATH_SAMPLE_MAX_SIZE,
    PATH_SAMPLE_MIN_SIZE,
)
from .geometry import EARTH_RADIUS_KM, haversine_distance
from .logger import logger

if TYPE_CHECKING:
    from .types import AirportData, FlightPath, FlightPathGroup, PathMetadata

__all__ = [
    "POINT_MARKERS",
    "AirportDeduplicator",
    "airport_elevation",
    "deduplicate_airports",
    "extract_airport_name",
    "is_mid_flight_start",
    "is_point_marker",
    "is_valid_landing",
    "reference_altitude",
    "route_airports",
    "sample_path_altitudes",
]

# Marker types to filter out
POINT_MARKERS = ["Log Start", "Log Stop", "Takeoff", "Landing"]
# SkyDemon writes "Landing: 03 Mar 2025 08:50 Z". Only the start of a name
# counts: dozens of airports have "Landing" in their name (CYNL, KNFE, ...).
_POINT_MARKER_PATTERN = re.compile(
    "(?:" + "|".join(map(re.escape, POINT_MARKERS)) + ")(?::|$)"
)
_KM_PER_DEGREE = math.radians(EARTH_RADIUS_KM)


def sample_path_altitudes(
    path: FlightPath, from_end: bool = False
) -> dict[str, float] | None:
    """Extract altitude statistics from a path sample."""
    if len(path) <= 10:
        return None

    sample_size = min(PATH_SAMPLE_MAX_SIZE, len(path) // 4)
    if sample_size <= PATH_SAMPLE_MIN_SIZE:
        return None

    sample = path[-sample_size:] if from_end else path[:sample_size]
    alts = [point.alt for point in sample if point.alt is not None]
    if not alts:
        return None
    return {"min": min(alts), "max": max(alts), "variation": max(alts) - min(alts)}


def airport_elevation(name: str | None, is_at_path_end: bool) -> float | None:
    """The field elevation in meters of the airport a name refers to.

    A route name refers to its departure or its arrival, selected by
    ``is_at_path_end``. None when the name holds no ICAO code or the
    database does not know the field or its elevation.
    """
    if not name:
        return None
    return lookup_airport_elevation(
        airport_icao_code(_airport_at(name, is_at_path_end))
    )


def reference_altitude(path: FlightPath, airport_elevation_m: float | None) -> float:
    """The ground altitude the start or end of a path is compared against.

    The altitudes of a track are above sea level, but whether a flat start
    is a taxi or a cruise depends on the height above the field: Munich lies
    at 453 m, Samedan at 1707 m. The elevation of the named airport is the
    reference when the database has it. Otherwise the lowest altitude of the
    path stands in for the ground, provided the path climbs or descends at
    all; a recording that is flat throughout never touched the ground, and
    sea level keeps its flat start from counting as a departure.
    """
    if airport_elevation_m is not None:
        return airport_elevation_m
    altitudes = [point.alt for point in path if point.alt is not None]
    if altitudes and max(altitudes) - min(altitudes) > MID_FLIGHT_MAX_VARIATION_M:
        return min(altitudes)
    return 0.0


def is_mid_flight_start(
    path: FlightPath, start_alt: float | None, reference_alt: float = 0.0
) -> bool:
    """Detect if a path started mid-flight by analyzing altitude patterns.

    ``reference_alt`` is the ground altitude the start is measured against
    (see ``reference_altitude``); the default is sea level.
    """
    if start_alt is None:
        return False

    sample = sample_path_altitudes(path, from_end=False)
    if not sample:
        return False

    # Mid-flight indicators:
    # - Starting well above the ground
    # - AND altitude variation in first part is small (not climbing/descending much)
    is_mid_flight = (
        start_alt - reference_alt > MID_FLIGHT_MIN_ALTITUDE_M
        and sample["variation"] < MID_FLIGHT_MAX_VARIATION_M
    )

    if is_mid_flight:
        logger.debug(
            "Detected mid-flight start at %.0fm (%.0fm above the reference, "
            "variation: %.0fm)",
            start_alt,
            start_alt - reference_alt,
            sample["variation"],
        )

    return is_mid_flight


def is_valid_landing(
    path: FlightPath, end_alt: float | None, reference_alt: float = 0.0
) -> bool:
    """Check if a path ends with a valid landing.

    ``reference_alt`` is the ground altitude the end is measured against
    (see ``reference_altitude``); the default is sea level.
    """
    height = end_alt - reference_alt if end_alt is not None else None
    sample = sample_path_altitudes(path, from_end=True)
    if not sample:
        # Short path, just accept if the height seems reasonable
        return height is not None and height < LANDING_FALLBACK_ALTITUDE_M

    # Valid landing: either descending significantly OR stable at low variation
    # Also accept any endpoint if variation at end is small - indicates stable landing
    return sample["variation"] < LANDING_MAX_VARIATION_M or (
        height is not None and height < LANDING_MAX_ALTITUDE_M
    )


def is_point_marker(name: str | None) -> bool:
    """Check if a name represents a point marker (not a flight path)."""
    if not name:
        return True
    return _POINT_MARKER_PATTERN.match(name) is not None


def route_airports(metadata: PathMetadata) -> tuple[str | None, str | None]:
    """The departure and arrival airport of a path, both None for no route.

    The parser records both when it standardizes the name, because airport
    names may contain " - " and the display name cannot be split reliably.
    Only metadata built without those keys falls back to splitting it.
    """
    if "start_airport" in metadata or "end_airport" in metadata:
        return metadata.get("start_airport"), metadata.get("end_airport")
    route = split_route_name(metadata.get("airport_name"))
    return route if route is not None else (None, None)


def _airport_at(name: str, is_at_path_end: bool) -> str:
    """The departure or arrival of a route name; any other name as it is."""
    route = split_route_name(name)
    if route is None:
        return name
    return route[1] if is_at_path_end else route[0]


def extract_airport_name(full_name: str, is_at_path_end: bool = False) -> str | None:
    """Extract a clean airport name, or None when it is no airport.

    ``deduplicate_airports`` stores the name of one airport. A route name
    ("DEPARTURE - ARRIVAL") yields the airport selected by ``is_at_path_end``.
    """
    if not full_name or full_name in ["Airport", "Unknown", ""]:
        return None

    # Check if it's a marker prefix that shouldn't have made it here
    if is_point_marker(full_name):
        return None

    airport_name = _airport_at(full_name, is_at_path_end)

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

    def _search_cells(self, lat: float) -> tuple[int, int]:
        """How many cells around a point, per axis, can hold a nearby airport.

        A degree of longitude shrinks with the cosine of the latitude: at 51°N
        a 0.018° cell is only 1.26 km wide, less than the merge distance, so
        a single neighbor cell is not enough. The pole side of the search
        radius is the narrowest, so its width decides.
        """
        cell_km = self.grid_size * _KM_PER_DEGREE
        lat_cells = math.ceil(AIRPORT_DISTANCE_THRESHOLD_KM / cell_km)
        edge_lat = min(90.0, abs(lat) + lat_cells * self.grid_size)
        lon_cell_km = cell_km * math.cos(math.radians(edge_lat))
        max_lon_cells = math.ceil(360 / self.grid_size)
        if lon_cell_km * max_lon_cells <= AIRPORT_DISTANCE_THRESHOLD_KM:
            return lat_cells, max_lon_cells
        lon_cells = math.ceil(AIRPORT_DISTANCE_THRESHOLD_KM / lon_cell_km)
        return lat_cells, min(lon_cells, max_lon_cells)

    def _find_nearby_airport(self, lat: float, lon: float) -> int | None:
        """Find airport within threshold using spatial grid."""
        grid_key = self._get_grid_key(lat, lon)
        lat_cells, lon_cells = self._search_cells(lat)
        for dlat in range(-lat_cells, lat_cells + 1):
            for dlon in range(-lon_cells, lon_cells + 1):
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
            icao_code = airport_icao_code(_airport_at(name, is_at_path_end))
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


def _add_departures(
    deduplicator: AirportDeduplicator,
    all_path_metadata: list[PathMetadata],
    all_path_groups: FlightPathGroup,
) -> None:
    """Register the start point every path reported in its metadata.

    The parsers build the metadata start point from the path's first point,
    so this pass covers the departure of every path, including the ones whose
    name is a single airport rather than a route. The altitude comes from the
    metadata's ``start_point`` and defaults to 0 when the point carries none.
    A route registers its departure airport under that airport's own name,
    the name the path info of the export refers to.

    A path with fewer than two points is no flight: a lone waypoint or a
    stationary recording gets no entry in the export either, and its airport
    would tell where it was.
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

        path = all_path_groups[idx] if idx < len(all_path_groups) else []
        if len(path) < 2:
            logger.debug("Skipping the start of '%s': no flight path", airport_name)
            continue

        # Skip mid-flight starts
        start_airport, _ = route_airports(metadata)
        name = start_airport or airport_name
        reference = reference_altitude(path, airport_elevation(name, False))
        if is_mid_flight_start(path, start_alt, reference):
            logger.debug("Skipping mid-flight start '%s'", airport_name)
            continue

        deduplicator.add_or_update_airport(
            lat=start_lat,
            lon=start_lon,
            name=name,
            path_index=idx,
            is_at_path_end=False,
        )


def _add_arrivals(
    deduplicator: AirportDeduplicator,
    all_path_metadata: list[PathMetadata],
    all_path_groups: FlightPathGroup,
) -> None:
    """Register the end point of every path whose name is a route.

    Only routes ("DEPARTURE - ARRIVAL") reach this pass, because only they say
    which airport the end belongs to. The arrival is only registered when the
    path actually ends in a landing, under the arrival airport's own name.
    """
    for idx, path in enumerate(all_path_groups):
        if len(path) <= 1 or idx >= len(all_path_metadata):
            continue

        end = path[-1]
        metadata = all_path_metadata[idx]
        route_name = metadata.get("airport_name", "")
        _, end_airport = route_airports(metadata)

        # Skip if not a proper route name
        if is_point_marker(route_name) or not end_airport:
            continue

        reference = reference_altitude(path, airport_elevation(end_airport, True))
        if is_valid_landing(path, end.alt, reference):
            deduplicator.add_or_update_airport(
                lat=end.lat,
                lon=end.lon,
                name=end_airport,
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
) -> list[AirportData]:
    """Deduplicate airports by location using spatial grid indexing.

    Two passes feed the deduplicator: the start point of every path, then the
    end point of the paths whose name is a route. Entries that land within
    ``AIRPORT_DISTANCE_THRESHOLD_KM`` of each other merge.
    """
    deduplicator = AirportDeduplicator()
    _add_departures(deduplicator, all_path_metadata, all_path_groups)
    _add_arrivals(deduplicator, all_path_metadata, all_path_groups)
    return deduplicator.get_unique_airports()
