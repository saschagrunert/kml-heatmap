"""Statistics calculation for flight data."""

from datetime import datetime
from typing import List, Dict, Optional, Any
from .geometry import haversine_distance
from .aircraft import lookup_aircraft_model
from .airports import is_point_marker
from .constants import METERS_TO_FEET, KM_TO_NAUTICAL_MILES
from .helpers import parse_iso_timestamp, format_flight_time


def calculate_statistics(
    all_coordinates: List[List[float]],
    all_path_groups: List[List[List[float]]],
    all_path_metadata: Optional[List[Dict[str, Any]]] = None
) -> Dict[str, Any]:
    """
    Calculate statistics from coordinate and path data.

    Args:
        all_coordinates: List of [lat, lon] pairs
        all_path_groups: List of path groups with altitude data (can be [lat,lon,alt] or [lat,lon,alt,timestamp])
        all_path_metadata: List of metadata dicts for each path (optional)

    Returns:
        Dictionary of statistics
    """
    # Count only actual flight paths, not point markers
    num_flight_paths = 0
    if all_path_metadata:
        for metadata in all_path_metadata:
            airport_name = metadata.get('airport_name', '')
            if not is_point_marker(airport_name):
                num_flight_paths += 1
    else:
        # Fallback if no metadata available
        num_flight_paths = len(all_path_groups)

    stats = {
        'total_points': len(all_coordinates),
        'num_paths': num_flight_paths,
        'total_distance_km': 0.0,
        'total_distance_nm': 0.0,
        'total_altitude_gain_m': 0.0,
        'total_altitude_gain_ft': 0.0,
        'min_altitude_m': None,
        'max_altitude_m': None,
        'min_altitude_ft': None,
        'max_altitude_ft': None,
        'total_flight_time_seconds': 0,
        'total_flight_time_str': None,
    }

    if not all_path_groups:
        return stats

    # Calculate statistics from all path groups (filter out short paths)
    valid_paths = [path for path in all_path_groups if len(path) >= 2]
    if not valid_paths:
        return stats

    # Collect all altitudes
    all_altitudes = [coord[2] for path in valid_paths for coord in path]

    # Calculate distance and elevation changes
    total_distance_km = 0.0
    total_gain_m = 0.0

    for path in valid_paths:
        for i in range(len(path) - 1):
            # Handle both 3-element [lat,lon,alt] and 4-element [lat,lon,alt,timestamp]
            lat1, lon1, alt1 = path[i][0], path[i][1], path[i][2]
            lat2, lon2, alt2 = path[i + 1][0], path[i + 1][1], path[i + 1][2]

            # Add to total distance
            total_distance_km += haversine_distance(lat1, lon1, lat2, lon2)

            # Calculate altitude change (only track gain)
            alt_change = alt2 - alt1
            if alt_change > 0:
                total_gain_m += alt_change

    # Update statistics
    if all_altitudes:
        stats['min_altitude_m'] = min(all_altitudes)
        stats['max_altitude_m'] = max(all_altitudes)
        stats['min_altitude_ft'] = stats['min_altitude_m'] * METERS_TO_FEET
        stats['max_altitude_ft'] = stats['max_altitude_m'] * METERS_TO_FEET

    stats['total_distance_km'] = total_distance_km
    stats['total_distance_nm'] = total_distance_km * KM_TO_NAUTICAL_MILES
    stats['total_altitude_gain_m'] = total_gain_m
    stats['total_altitude_gain_ft'] = total_gain_m * METERS_TO_FEET

    # Calculate total flight time from path timestamps (4th element in coordinates)
    total_seconds = 0
    paths_with_timestamps = 0
    for path_idx, path in enumerate(valid_paths):
        # Extract timestamps from path coordinates (4th element if present)
        timestamps = []
        for coord in path:
            if len(coord) >= 4 and coord[3] is not None:
                # Parse timestamp if it's a string (ISO format)
                timestamp = coord[3]
                if isinstance(timestamp, str):
                    dt = parse_iso_timestamp(timestamp)
                    if dt:
                        timestamp = dt.timestamp()
                    else:
                        continue
                timestamps.append(timestamp)

        # Calculate flight duration from min/max timestamps
        if len(timestamps) >= 2:
            min_time = min(timestamps)
            max_time = max(timestamps)
            duration = max_time - min_time
            if duration > 0:
                total_seconds += duration
                paths_with_timestamps += 1

    # Debug output
    if paths_with_timestamps > 0:
        print(f"  Calculated flight time from {paths_with_timestamps}/{len(valid_paths)} paths with timestamps")

    stats['total_flight_time_seconds'] = total_seconds

    # Format flight time as human-readable string
    stats['total_flight_time_str'] = format_flight_time(total_seconds)

    # Calculate average groundspeed in knots (nautical miles per hour)
    if stats['total_flight_time_seconds'] > 0 and stats['total_distance_nm'] > 0:
        hours = stats['total_flight_time_seconds'] / 3600
        stats['average_groundspeed_knots'] = stats['total_distance_nm'] / hours
    else:
        stats['average_groundspeed_knots'] = 0

    # Max groundspeed will be added later from path segments
    stats['max_groundspeed_knots'] = 0

    # Collect unique aircraft from metadata
    if all_path_metadata:
        aircraft_registrations = set()
        aircraft_types = set()
        aircraft_list = []  # List of {registration, type, flights_count}
        aircraft_flights = {}  # Count unique flights (KML files) per aircraft registration

        # Build a map of path index to aircraft registration
        path_to_aircraft = {}
        for idx, metadata in enumerate(all_path_metadata):
            reg = metadata.get('aircraft_registration')
            atype = metadata.get('aircraft_type')
            filename = metadata.get('filename')

            if reg:
                aircraft_registrations.add(reg)
                if reg not in aircraft_flights:
                    aircraft_flights[reg] = {'type': atype, 'count': 0, 'files': set(), 'flight_time_seconds': 0}

                # Only count unique filenames (each file = one flight)
                if filename and filename not in aircraft_flights[reg]['files']:
                    aircraft_flights[reg]['files'].add(filename)
                    aircraft_flights[reg]['count'] += 1

                # Store the mapping for later use
                path_to_aircraft[idx] = reg

            if atype:
                aircraft_types.add(atype)

        # Calculate flight time per aircraft from path timestamps (4th element in coordinates)
        # Use same filter as total flight time calculation (paths with >= 2 points)
        for idx, path in enumerate(all_path_groups):
            # Skip short paths (same filter as valid_paths)
            if len(path) < 2:
                continue

            if idx not in path_to_aircraft:
                continue

            reg = path_to_aircraft[idx]

            # Extract timestamps from path coordinates (4th element if present)
            timestamps = []
            for coord in path:
                if len(coord) >= 4 and coord[3] is not None:
                    # Parse timestamp if it's a string (ISO format)
                    timestamp = coord[3]
                    if isinstance(timestamp, str):
                        dt = parse_iso_timestamp(timestamp)
                        if dt:
                            timestamp = dt.timestamp()
                        else:
                            continue
                    timestamps.append(timestamp)

            # Calculate flight duration from min/max timestamps
            if len(timestamps) >= 2:
                min_time = min(timestamps)
                max_time = max(timestamps)
                duration = max_time - min_time
                if duration > 0:
                    aircraft_flights[reg]['flight_time_seconds'] += duration

        # Create sorted aircraft list by flight count with full model lookup
        print("✈️  Looking up aircraft model information...")
        for reg, info in sorted(aircraft_flights.items(), key=lambda x: x[1]['count'], reverse=True):
            # Try to lookup full aircraft model
            full_model = lookup_aircraft_model(reg)
            if full_model:
                print(f"  ✓ {reg}: {full_model}")
            else:
                full_model = info['type']  # Fallback to basic type if lookup fails
                if full_model:
                    print(f"  ⚠ {reg}: {full_model} (lookup failed, using KML type)")

            # Format flight time as human-readable string
            flight_time_seconds = info['flight_time_seconds']
            flight_time_str = format_flight_time(flight_time_seconds)

            aircraft_list.append({
                'registration': reg,
                'type': info['type'],  # Keep original type for backwards compatibility
                'model': full_model,   # Full model name
                'flights': info['count'],
                'flight_time_seconds': flight_time_seconds,
                'flight_time_str': flight_time_str
            })

        stats['num_aircraft'] = len(aircraft_registrations)
        stats['aircraft_types'] = sorted(aircraft_types)
        stats['aircraft_list'] = aircraft_list

    return stats
