/**
 * Statistics calculation utilities
 * Pure functions for calculating flight statistics from path data
 */

import { calculateDistance } from "../utils/geometry";
import type {
  PathInfo,
  PathSegment,
  AircraftAggregate,
  AltitudeStats,
  SpeedStats,
  FilteredStatistics,
} from "../types";

/**
 * Filter path info by year and aircraft
 * @param pathInfo - Array of path info objects
 * @param year - Year filter ('all' or specific year)
 * @param aircraft - Aircraft registration filter ('all' or specific registration)
 * @returns Filtered path info array
 */
export function filterPaths(
  pathInfo: PathInfo[],
  year: string,
  aircraft: string
): PathInfo[] {
  return pathInfo.filter(function (path) {
    // Apply year filter
    if (year !== "all") {
      if (!path.year || path.year.toString() !== year) {
        return false;
      }
    }

    // Apply aircraft filter
    if (aircraft !== "all") {
      if (
        !path.aircraft_registration ||
        path.aircraft_registration !== aircraft
      ) {
        return false;
      }
    }

    return true;
  });
}

/**
 * Collect unique airports from path info
 * @param pathInfo - Array of path info objects
 * @returns Set of unique airport codes
 */
export function collectAirports(pathInfo: PathInfo[]): Set<string> {
  const airports = new Set<string>();
  pathInfo.forEach(function (path) {
    if (path.start_airport) airports.add(path.start_airport);
    if (path.end_airport) airports.add(path.end_airport);
  });
  return airports;
}

/**
 * Aggregate aircraft data from path info
 * @param pathInfo - Array of path info objects
 * @returns Array of aircraft objects with registration, type, and flight count
 */
export function aggregateAircraft(pathInfo: PathInfo[]): AircraftAggregate[] {
  const aircraftMap: Record<string, AircraftAggregate> = {};

  pathInfo.forEach(function (path) {
    if (path.aircraft_registration) {
      const reg = path.aircraft_registration;
      if (!aircraftMap[reg]) {
        aircraftMap[reg] = {
          registration: reg,
          type: path.aircraft_type,
          flights: 0,
        };
      }
      aircraftMap[reg].flights += 1;
    }
  });

  // Sort by flight count descending
  return Object.values(aircraftMap).sort(function (a, b) {
    return b.flights - a.flights;
  });
}

/**
 * Filter segments by path IDs
 * @param segments - Array of all segments
 * @param pathInfo - Array of filtered path info objects
 * @returns Filtered segments
 */
export function filterSegmentsByPaths(
  segments: PathSegment[],
  pathInfo: PathInfo[]
): PathSegment[] {
  const pathIds = new Set(pathInfo.map((p) => p.id));
  return segments.filter(function (segment) {
    return pathIds.has(segment.path_id);
  });
}

/**
 * Calculate total distance from segments
 * @param segments - Array of segment objects with coords
 * @returns Total distance in kilometers
 */
export function calculateTotalDistance(segments: PathSegment[]): number {
  let total = 0;

  segments.forEach(function (segment) {
    const coords = segment.coords;
    if (coords && coords.length === 2) {
      const distance = calculateDistance(coords[0], coords[1]);
      total += distance;
    }
  });

  return total;
}

/**
 * Calculate altitude statistics from segments
 * @param segments - Array of segment objects
 * @returns Altitude statistics in meters
 */
export function calculateAltitudeStats(segments: PathSegment[]): AltitudeStats {
  const altitudes = segments
    .map((s) => s.altitude_m)
    .filter((a): a is number => a !== undefined);

  if (altitudes.length === 0) {
    return { min: 0, max: 0, gain: 0 };
  }

  // Use reduce to avoid stack overflow with large arrays
  let min = altitudes[0] ?? 0;
  let max = altitudes[0] ?? 0;
  for (let i = 1; i < altitudes.length; i++) {
    const alt = altitudes[i] ?? 0;
    if (alt < min) min = alt;
    if (alt > max) max = alt;
  }

  // Calculate total altitude gain
  let gain = 0;
  let prevAlt: number | null = null;

  segments.forEach(function (segment) {
    if (
      segment.altitude_m !== undefined &&
      prevAlt !== null &&
      segment.altitude_m > prevAlt
    ) {
      gain += segment.altitude_m - prevAlt;
    }
    if (segment.altitude_m !== undefined) {
      prevAlt = segment.altitude_m;
    }
  });

  return { min, max, gain };
}

/**
 * Calculate groundspeed statistics from segments
 * @param segments - Array of segment objects
 * @returns Speed statistics in knots
 */
export function calculateSpeedStats(segments: PathSegment[]): SpeedStats {
  const speeds = segments
    .map((s) => s.groundspeed_knots)
    .filter((s): s is number => s !== undefined && s > 0);

  if (speeds.length === 0) {
    return { max: 0, avg: 0 };
  }

  // Use loop to avoid stack overflow with large arrays
  let max = speeds[0] ?? 0;
  let sum = 0;
  for (let i = 0; i < speeds.length; i++) {
    const speed = speeds[i] ?? 0;
    if (speed > max) max = speed;
    sum += speed;
  }
  const avg = sum / speeds.length;

  return { max, avg };
}

/**
 * Calculate longest flight distance
 * @param segments - Array of segment objects
 * @returns Longest flight distance in kilometers
 */
export function calculateLongestFlight(segments: PathSegment[]): number {
  const pathDistances: Record<number, number> = {};

  segments.forEach(function (segment) {
    const coords = segment.coords;
    if (coords && coords.length === 2) {
      const distance = calculateDistance(coords[0], coords[1]);

      if (!pathDistances[segment.path_id]) {
        pathDistances[segment.path_id] = 0;
      }
      pathDistances[segment.path_id]! += distance;
    }
  });

  const distances = Object.values(pathDistances);
  if (distances.length === 0) return 0;

  // Use loop to avoid stack overflow with large arrays
  let max = distances[0] ?? 0;
  for (let i = 1; i < distances.length; i++) {
    const dist = distances[i] ?? 0;
    if (dist > max) max = dist;
  }
  return max;
}

/**
 * Calculate flight time statistics from segments
 * @param segments - Array of segment objects with time property
 * @param pathInfo - Array of path info objects
 * @returns Total flight time in seconds
 */
export function calculateFlightTime(
  segments: PathSegment[],
  pathInfo: PathInfo[]
): number {
  let totalSeconds = 0;
  const pathIds = new Set(pathInfo.map((p) => p.id));

  pathIds.forEach(function (pathId) {
    const pathSegments = segments.filter(
      (seg) =>
        seg.path_id === pathId && seg.time !== undefined && seg.time !== null
    );

    if (pathSegments.length > 0) {
      const times = pathSegments.map((seg) => seg.time!);
      // Use loop to avoid stack overflow with large arrays
      let minTime = times[0] ?? 0;
      let maxTime = times[0] ?? 0;
      for (let i = 1; i < times.length; i++) {
        const time = times[i] ?? 0;
        if (time < minTime) minTime = time;
        if (time > maxTime) maxTime = time;
      }
      totalSeconds += maxTime - minTime;
    }
  });

  return totalSeconds;
}

/**
 * Calculate comprehensive statistics from filtered data
 * @param options - Options object
 * @returns Statistics object
 */
export function calculateFilteredStatistics(options: {
  pathInfo: PathInfo[];
  segments: PathSegment[];
  year?: string;
  aircraft?: string;
  coordinateCount?: number;
}): FilteredStatistics {
  const {
    pathInfo,
    segments,
    year = "all",
    aircraft = "all",
    coordinateCount,
  } = options;

  if (!pathInfo || !segments) {
    return {
      total_points: 0,
      num_paths: 0,
      num_airports: 0,
      airport_names: [],
      num_aircraft: 0,
      aircraft_list: [],
      total_distance_nm: 0,
      total_distance_km: 0,
    };
  }

  // Filter paths
  const filteredPaths = filterPaths(pathInfo, year, aircraft);

  if (filteredPaths.length === 0) {
    return {
      total_points: 0,
      num_paths: 0,
      num_airports: 0,
      airport_names: [],
      num_aircraft: 0,
      aircraft_list: [],
      total_distance_nm: 0,
      total_distance_km: 0,
    };
  }

  // Collect data
  const airports = collectAirports(filteredPaths);
  const aircraftList = aggregateAircraft(filteredPaths);
  const filteredSegments = filterSegmentsByPaths(segments, filteredPaths);

  // Calculate metrics
  const totalDistanceKm = calculateTotalDistance(filteredSegments);
  const altitudeStats = calculateAltitudeStats(filteredSegments);
  const speedStats = calculateSpeedStats(filteredSegments);
  const longestFlight = calculateLongestFlight(filteredSegments);
  const flightTime = calculateFlightTime(filteredSegments, filteredPaths);

  // Unit conversions
  const maxAltitudeFt =
    altitudeStats.max !== undefined ? altitudeStats.max * 3.28084 : undefined;
  const minAltitudeFt =
    altitudeStats.min !== undefined ? altitudeStats.min * 3.28084 : undefined;
  const totalAltitudeGainFt =
    altitudeStats.gain !== undefined ? altitudeStats.gain * 3.28084 : undefined;
  const longestFlightNm =
    longestFlight !== undefined ? longestFlight * 0.539957 : undefined;

  // Format flight time
  const formatTime = (seconds: number): string => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${hours}h ${minutes}m`;
  };
  const flightTimeStr = flightTime > 0 ? formatTime(flightTime) : undefined;

  // Calculate cruise speed (segments above 1000ft AGL)
  // Note: We don't have terrain elevation data, so we approximate using altitude MSL
  const cruiseSegments = filteredSegments.filter(
    (seg) =>
      seg.altitude_m &&
      seg.altitude_m > 304.8 && // >1000ft in meters
      seg.groundspeed_knots &&
      seg.groundspeed_knots > 0
  );

  // Calculate weighted average speed (distance/time) instead of simple average
  // This matches the Python backend calculation
  let cruiseSpeed: number | undefined;
  if (cruiseSegments.length > 0) {
    let totalDistanceNm = 0;
    let totalTimeHours = 0;

    cruiseSegments.forEach((seg) => {
      if (
        seg.coords &&
        seg.coords.length === 2 &&
        seg.groundspeed_knots &&
        seg.groundspeed_knots > 0
      ) {
        // Calculate segment distance
        const distanceKm = calculateDistance(seg.coords[0], seg.coords[1]);
        const distanceNm = distanceKm * 0.539957;

        // Derive time from distance and speed: time = distance / speed
        const timeHours = distanceNm / seg.groundspeed_knots;

        totalDistanceNm += distanceNm;
        totalTimeHours += timeHours;
      }
    });

    cruiseSpeed =
      totalTimeHours > 0 ? totalDistanceNm / totalTimeHours : undefined;
  }

  // Calculate most common cruise altitude
  // Use 100ft bins to match Python backend
  let mostCommonCruiseAltitudeFt: number | undefined;
  let mostCommonCruiseAltitudeM: number | undefined;
  if (cruiseSegments.length > 0) {
    const altitudeBuckets: { [key: number]: number } = {};
    cruiseSegments.forEach((seg) => {
      if (seg.altitude_m) {
        // Convert to feet and round to nearest 100ft for bucketing
        const altFt = seg.altitude_m * 3.28084;
        const bucketFt = Math.round(altFt / 100) * 100;
        altitudeBuckets[bucketFt] = (altitudeBuckets[bucketFt] || 0) + 1;
      }
    });
    const mostCommonBucket = Object.entries(altitudeBuckets).sort(
      (a, b) => b[1] - a[1]
    )[0];
    if (mostCommonBucket) {
      mostCommonCruiseAltitudeFt = Number(mostCommonBucket[0]);
      mostCommonCruiseAltitudeM = mostCommonCruiseAltitudeFt / 3.28084;
    }
  }

  // Use provided coordinate count if available, otherwise count unique coordinates from filtered segments
  // Note: coordinateCount represents the actual heatmap coordinates, not segment endpoints
  const totalPoints = coordinateCount ?? filteredSegments.length * 2;

  return {
    total_points: totalPoints,
    num_paths: filteredPaths.length,
    num_airports: airports.size,
    airport_names: Array.from(airports),
    num_aircraft: aircraftList.length,
    aircraft_list: aircraftList,
    total_distance_km: totalDistanceKm,
    total_distance_nm: totalDistanceKm * 0.539957,
    max_altitude_m: altitudeStats.max,
    min_altitude_m: altitudeStats.min,
    total_altitude_gain_m: altitudeStats.gain,
    max_altitude_ft: maxAltitudeFt,
    min_altitude_ft: minAltitudeFt,
    total_altitude_gain_ft: totalAltitudeGainFt,
    max_groundspeed_knots: speedStats.max,
    avg_groundspeed_knots: speedStats.avg,
    average_groundspeed_knots: speedStats.avg, // Alias
    cruise_speed_knots: cruiseSpeed,
    longest_flight_km: longestFlight,
    longest_flight_nm: longestFlightNm,
    total_flight_time_seconds: flightTime,
    total_flight_time_str: flightTimeStr,
    most_common_cruise_altitude_ft: mostCommonCruiseAltitudeFt,
    most_common_cruise_altitude_m: mostCommonCruiseAltitudeM,
  };
}
