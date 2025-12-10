"""Airport deduplication and name extraction."""

import re
from .geometry import haversine_distance

# Airport deduplication threshold
AIRPORT_DISTANCE_THRESHOLD_KM = 1.5

# Marker types to filter out
POINT_MARKERS = ['Log Start', 'Log Stop', 'Takeoff', 'Landing']

# Global DEBUG flag (will be set by main script)
DEBUG = False


def is_point_marker(name):
    """Check if a name represents a point marker (not a flight path)."""
    if not name:
        return True
    return any(marker in name for marker in POINT_MARKERS)


def extract_airport_name(full_name, is_at_path_end=False):
    """
    Extract clean airport name from route name.

    Args:
        full_name: Full airport/route name (e.g., "EDAQ Halle - EDMV Vilshofen")
        is_at_path_end: If True, extract arrival airport; else departure

    Returns:
        str: Cleaned airport name or None if invalid
    """
    if not full_name or full_name in ['Airport', 'Unknown', '']:
        return None

    # Check if it's a marker prefix that shouldn't have made it here
    marker_pattern = r'^(Log Start|Takeoff|Landing|Log Stop):\s*.+$'
    if re.match(marker_pattern, full_name):
        return None

    # Extract airport from route format "XXX - YYY"
    if ' - ' in full_name and full_name.count(' - ') == 1:
        parts = full_name.split(' - ')
        airport_name = parts[1].strip() if is_at_path_end else parts[0].strip()
    else:
        airport_name = full_name

    # Validate: must have ICAO code OR be multi-word name
    has_icao_code = bool(re.search(r'\b[A-Z]{4}\b', airport_name))
    is_single_word = len(airport_name.split()) == 1

    # Skip if it's "Unknown" or single-word without ICAO code
    if airport_name == 'Unknown' or (not has_icao_code and is_single_word):
        return None

    return airport_name


def deduplicate_airports(all_path_metadata, all_path_groups, is_mid_flight_start_func, is_valid_landing_func):
    """
    Deduplicate airports by location and extract valid airport information.

    Args:
        all_path_metadata: List of metadata dicts for each path
        all_path_groups: List of path groups with altitude data
        is_mid_flight_start_func: Function to detect mid-flight starts
        is_valid_landing_func: Function to validate landings

    Returns:
        List of unique airport dicts with lat, lon, timestamps, name, etc.
    """
    unique_airports = []

    # Process start points from metadata
    for idx, metadata in enumerate(all_path_metadata):
        start_lat, start_lon = metadata['start_point'][0], metadata['start_point'][1]
        start_alt = metadata['start_point'][2] if len(metadata['start_point']) > 2 else 0
        airport_name = metadata.get('airport_name', '')

        # Skip point markers - they don't contain airport info
        if is_point_marker(airport_name):
            if DEBUG:
                print(f"  DEBUG: Skipping point marker '{airport_name}'")
            continue

        # Skip mid-flight starts
        path = all_path_groups[idx] if idx < len(all_path_groups) else []
        if is_mid_flight_start_func(path, start_alt, DEBUG):
            if DEBUG:
                print(f"  DEBUG: Skipping mid-flight start '{airport_name}'")
            continue

        # Check for duplicates
        is_duplicate = False
        for airport in unique_airports:
            dist = haversine_distance(start_lat, start_lon, airport['lat'], airport['lon'])
            if dist < AIRPORT_DISTANCE_THRESHOLD_KM:
                # Update existing airport
                if metadata['timestamp'] and not is_point_marker(airport_name):
                    airport['timestamps'].append(metadata['timestamp'])

                # Prefer route names over marker names
                new_name = metadata.get('airport_name')
                current_name = airport.get('name', '')
                if new_name and (not current_name or
                               (is_point_marker(current_name) and not is_point_marker(new_name))):
                    airport['name'] = new_name
                is_duplicate = True
                break

        if not is_duplicate:
            # Add new unique airport
            timestamps = [metadata['timestamp']] if metadata['timestamp'] and not is_point_marker(airport_name) else []
            unique_airports.append({
                'lat': start_lat,
                'lon': start_lon,
                'timestamps': timestamps,
                'name': metadata.get('airport_name'),
                'path_index': idx,
                'is_at_path_end': False
            })

    # Process path endpoints (landings and takeoffs)
    for idx, path in enumerate(all_path_groups):
        if len(path) <= 1 or idx >= len(all_path_metadata):
            continue

        start_lat, start_lon, start_alt = path[0][0], path[0][1], path[0][2]
        end_lat, end_lon, end_alt = path[-1][0], path[-1][1], path[-1][2]
        route_name = all_path_metadata[idx].get('airport_name', '')
        route_timestamp = all_path_metadata[idx].get('timestamp')

        # Skip if not a proper route name
        if is_point_marker(route_name):
            continue

        # Check for mid-flight starts
        starts_at_high_altitude = is_mid_flight_start_func(path, start_alt, DEBUG)
        if starts_at_high_altitude and DEBUG:
            print(f"  DEBUG: Path '{route_name}' detected as mid-flight start")

        # Process departure airport (if not high altitude start)
        if not starts_at_high_altitude:
            start_found = False
            for airport in unique_airports:
                if haversine_distance(airport['lat'], airport['lon'], start_lat, start_lon) < AIRPORT_DISTANCE_THRESHOLD_KM:
                    start_found = True
                    if ' - ' in route_name and airport.get('name', '') != route_name:
                        airport['name'] = route_name
                        airport['is_at_path_end'] = False
                    if route_timestamp and route_timestamp not in airport['timestamps']:
                        airport['timestamps'].append(route_timestamp)
                    break

            if not start_found and ' - ' in route_name:
                unique_airports.append({
                    'lat': start_lat,
                    'lon': start_lon,
                    'timestamps': [route_timestamp] if route_timestamp else [],
                    'name': route_name,
                    'is_at_path_end': False
                })
                if DEBUG:
                    print(f"  DEBUG: Created departure airport for '{route_name}' at {start_alt:.0f}m altitude")

        # Process landing airport
        end_found = False
        for airport in unique_airports:
            if haversine_distance(airport['lat'], airport['lon'], end_lat, end_lon) < AIRPORT_DISTANCE_THRESHOLD_KM:
                end_found = True
                if is_point_marker(airport.get('name', '')):
                    airport['name'] = route_name
                    airport['is_at_path_end'] = True
                if not starts_at_high_altitude and route_timestamp and route_timestamp not in airport['timestamps']:
                    airport['timestamps'].append(route_timestamp)
                break

        if not end_found and ' - ' in route_name and is_valid_landing_func(path, end_alt, DEBUG):
            unique_airports.append({
                'lat': end_lat,
                'lon': end_lon,
                'timestamps': [route_timestamp] if not starts_at_high_altitude and route_timestamp else [],
                'name': route_name,
                'is_at_path_end': True
            })
            if DEBUG:
                print(f"  DEBUG: Created endpoint airport for '{route_name}' at {end_alt:.0f}m altitude")

    return unique_airports
