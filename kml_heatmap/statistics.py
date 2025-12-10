"""Statistics calculation for flight data."""

from datetime import datetime
from .geometry import haversine_distance
from .aircraft import lookup_aircraft_model
from .airports import is_point_marker

# Constants
METERS_TO_FEET = 3.28084
KM_TO_NAUTICAL_MILES = 0.539957


def calculate_statistics(all_coordinates, all_path_groups, all_path_metadata=None):
    """
    Calculate statistics from coordinate and path data.

    Args:
        all_coordinates: List of [lat, lon] pairs
        all_path_groups: List of path groups with altitude data
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

    # Calculate total flight time from path metadata
    if all_path_metadata:
        total_seconds = 0

        for metadata in all_path_metadata:
            start_ts = metadata.get('timestamp')
            end_ts = metadata.get('end_timestamp')

            # Only calculate duration if both start and end timestamps exist
            if start_ts and end_ts:
                try:
                    # Try to parse ISO format timestamp (e.g., "2025-03-03T08:58:01Z")
                    if 'T' in start_ts and 'T' in end_ts:
                        start_dt = datetime.fromisoformat(start_ts.replace('Z', '+00:00'))
                        end_dt = datetime.fromisoformat(end_ts.replace('Z', '+00:00'))
                        duration = (end_dt - start_dt).total_seconds()
                        if duration > 0:  # Only count positive durations
                            total_seconds += duration
                except (ValueError, TypeError):
                    # Skip if parsing fails - timestamps are optional
                    pass

        stats['total_flight_time_seconds'] = total_seconds

        # Format flight time as human-readable string
        if total_seconds > 0:
            hours = int(total_seconds // 3600)
            minutes = int((total_seconds % 3600) // 60)
            if hours > 0:
                stats['total_flight_time_str'] = f"{hours}h {minutes}m"
            else:
                stats['total_flight_time_str'] = f"{minutes}m"

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

        for metadata in all_path_metadata:
            reg = metadata.get('aircraft_registration')
            atype = metadata.get('aircraft_type')
            filename = metadata.get('filename')

            if reg:
                aircraft_registrations.add(reg)
                if reg not in aircraft_flights:
                    aircraft_flights[reg] = {'type': atype, 'count': 0, 'files': set()}

                # Only count unique filenames (each file = one flight)
                if filename and filename not in aircraft_flights[reg]['files']:
                    aircraft_flights[reg]['files'].add(filename)
                    aircraft_flights[reg]['count'] += 1

            if atype:
                aircraft_types.add(atype)

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

            aircraft_list.append({
                'registration': reg,
                'type': info['type'],  # Keep original type for backwards compatibility
                'model': full_model,   # Full model name
                'flights': info['count']
            })

        stats['num_aircraft'] = len(aircraft_registrations)
        stats['aircraft_types'] = sorted(aircraft_types)
        stats['aircraft_list'] = aircraft_list

    return stats
