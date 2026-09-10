/**
 * Statistics calculation utilities
 * Pure functions for calculating flight statistics from path data
 */

import {
  CRUISE_ALTITUDE_THRESHOLD_FT,
  FEET_TO_METERS,
  KM_TO_NAUTICAL_MILES,
  METERS_TO_FEET,
} from "../utils/constants";
import { calculateDistance } from "../utils/geometry";
import { formatFlightTime } from "../utils/formatters";
import { findMax, findMinMax } from "../utils/arrayHelpers";
import type {
  PathInfo,
  PathSegment,
  AircraftAggregate,
  AltitudeStats,
  SpeedStats,
  FilteredStatistics,
} from "../types";

/**
 * Great-circle length of a segment in kilometres.
 *
 * Every statistics refresh needs the distance of the same segments three
 * times (total distance, longest flight, cruise weighting), so the result is
 * memoised on the segment. The value only depends on `coords`, which the
 * data loader never changes after expansion.
 */
export function segmentDistance(segment: PathSegment): number {
  const cached = segment.distance_km;
  if (cached !== undefined) return cached;

  const coords = segment.coords;
  const distance =
    coords && coords.length === 2 ? calculateDistance(coords[0], coords[1]) : 0;
  segment.distance_km = distance;
  return distance;
}

/**
 * Group timed segments by path and return per-path flight seconds.
 * Shared by aggregateAircraft (per-aircraft time) and
 * calculateFilteredStatistics (total time).
 */
export function perPathSeconds(
  segments: PathSegment[],
  pathIds?: Set<number>,
): Map<number, number> {
  const timesByPath = new Map<number, number[]>();
  for (const seg of segments) {
    if (seg.time === undefined) continue;
    if (pathIds && !pathIds.has(seg.path_id)) continue;
    let times = timesByPath.get(seg.path_id);
    if (!times) {
      times = [];
      timesByPath.set(seg.path_id, times);
    }
    times.push(seg.time);
  }
  const result = new Map<number, number>();
  for (const [pathId, times] of timesByPath) {
    if (times.length > 0) {
      const { min, max } = findMinMax(times);
      result.set(pathId, max - min);
    }
  }
  return result;
}

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
  aircraft: string,
): PathInfo[] {
  return pathInfo.filter((path) => {
    if (year !== "all" && (!path.year || path.year.toString() !== year)) {
      return false;
    }
    if (
      aircraft !== "all" &&
      (!path.aircraft_registration || path.aircraft_registration !== aircraft)
    ) {
      return false;
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
  for (const path of pathInfo) {
    if (path.start_airport) airports.add(path.start_airport);
    if (path.end_airport) airports.add(path.end_airport);
  }
  return airports;
}

/**
 * Aggregate aircraft data from path info
 * @param pathInfo - Array of path info objects
 * @returns Array of aircraft objects with registration, type, and flight count
 */
export function aggregateAircraft(
  pathInfo: PathInfo[],
  segments?: PathSegment[],
  secondsByPath?: Map<number, number>,
): AircraftAggregate[] {
  const aircraftMap: Record<string, AircraftAggregate> = {};
  const pathToReg = new Map<number, string>();

  for (const path of pathInfo) {
    if (path.aircraft_registration) {
      const reg = path.aircraft_registration;
      pathToReg.set(path.id, reg);
      const entry = aircraftMap[reg] ?? {
        registration: reg,
        type: path.aircraft_type,
        flights: 0,
        flight_time_seconds: 0,
      };
      aircraftMap[reg] = entry;
      entry.flights += 1;
    }
  }

  if (segments || secondsByPath) {
    const seconds =
      secondsByPath ??
      perPathSeconds(segments ?? [], new Set(pathToReg.keys()));
    for (const [pathId, secs] of seconds) {
      const reg = pathToReg.get(pathId);
      if (reg && aircraftMap[reg]) {
        aircraftMap[reg].flight_time_seconds! += secs;
      }
    }
    for (const agg of Object.values(aircraftMap)) {
      if (agg.flight_time_seconds && agg.flight_time_seconds > 0) {
        agg.flight_time_str = formatFlightTime(agg.flight_time_seconds);
      }
    }
  }

  // Sort by flight count descending
  return Object.values(aircraftMap).sort((a, b) => b.flights - a.flights);
}

/**
 * Filter segments by path IDs
 * @param segments - Array of all segments
 * @param pathInfo - Array of filtered path info objects
 * @returns Filtered segments
 */
export function filterSegmentsByPaths(
  segments: PathSegment[],
  pathInfo: PathInfo[],
): PathSegment[] {
  const pathIds = new Set(pathInfo.map((p) => p.id));
  return segments.filter((segment) => pathIds.has(segment.path_id));
}

/**
 * Calculate total distance from segments
 * @param segments - Array of segment objects with coords
 * @returns Total distance in kilometers
 */
export function calculateTotalDistance(segments: PathSegment[]): number {
  let total = 0;
  for (const segment of segments) {
    total += segmentDistance(segment);
  }
  return total;
}

/**
 * Calculate altitude statistics from segments (altitude_ft, converted)
 * @param segments - Array of segment objects
 * @returns Altitude statistics in meters
 */
export function calculateAltitudeStats(
  segments: PathSegment[],
  paths?: PathInfo[],
): AltitudeStats {
  let min = Infinity;
  let max = -Infinity;
  let gain = 0;
  let prevAlt: number | null = null;
  let prevPathId: number | null = null;

  for (const segment of segments) {
    // Altitude gain is accumulated per path (segments are grouped per
    // path): the previous altitude resets at every path boundary
    if (segment.path_id !== prevPathId) {
      prevPathId = segment.path_id;
      prevAlt = null;
    }
    if (segment.altitude_ft === undefined) continue;
    const alt = segment.altitude_ft * FEET_TO_METERS;
    if (alt < min) min = alt;
    if (alt > max) max = alt;
    if (prevAlt !== null && alt > prevAlt) {
      gain += alt - prevAlt;
    }
    prevAlt = alt;
  }

  // Segment altitudes are rounded to 100 ft, so prefer the exact per-path
  // range the exporter carries in path_info when it is available
  if (paths) {
    for (const path of paths) {
      if (path.min_altitude_ft !== undefined) {
        min = Math.min(min, path.min_altitude_ft * FEET_TO_METERS);
      }
      if (path.max_altitude_ft !== undefined) {
        max = Math.max(max, path.max_altitude_ft * FEET_TO_METERS);
      }
    }
  }

  if (min === Infinity) {
    return { min: 0, max: 0, gain: 0 };
  }

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

  const max = findMax(speeds);
  let sum = 0;
  for (const speed of speeds) {
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

  for (const segment of segments) {
    const distance = segmentDistance(segment);
    if (distance > 0) {
      if (!pathDistances[segment.path_id]) {
        pathDistances[segment.path_id] = 0;
      }
      pathDistances[segment.path_id]! += distance;
    }
  }

  const distances = Object.values(pathDistances);
  if (distances.length === 0) return 0;

  return findMax(distances);
}

function emptyStatistics(): FilteredStatistics {
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
  preFiltered?: { paths: PathInfo[]; segments: PathSegment[] };
}): FilteredStatistics {
  const {
    pathInfo,
    segments,
    year = "all",
    aircraft = "all",
    preFiltered,
  } = options;

  if (!pathInfo || !segments) {
    return emptyStatistics();
  }

  const filteredPaths =
    preFiltered?.paths ?? filterPaths(pathInfo, year, aircraft);

  if (filteredPaths.length === 0) {
    return emptyStatistics();
  }

  // Collect data
  const airports = collectAirports(filteredPaths);
  const filteredSegments =
    preFiltered?.segments ?? filterSegmentsByPaths(segments, filteredPaths);
  // One grouping pass feeds both the per-aircraft times and the total
  const secondsByPath = perPathSeconds(
    filteredSegments,
    new Set(filteredPaths.map((p) => p.id)),
  );
  const aircraftList = aggregateAircraft(
    filteredPaths,
    filteredSegments,
    secondsByPath,
  );

  // Calculate metrics
  const totalDistanceKm = calculateTotalDistance(filteredSegments);
  const altitudeStats = calculateAltitudeStats(filteredSegments, filteredPaths);
  const speedStats = calculateSpeedStats(filteredSegments);
  const longestFlight = calculateLongestFlight(filteredSegments);
  let flightTime = 0;
  for (const secs of secondsByPath.values()) flightTime += secs;

  // Unit conversions
  const maxAltitudeFt = altitudeStats.max * METERS_TO_FEET;
  const minAltitudeFt = altitudeStats.min * METERS_TO_FEET;
  const totalAltitudeGainFt = altitudeStats.gain * METERS_TO_FEET;
  const longestFlightNm = longestFlight * KM_TO_NAUTICAL_MILES;

  // Format flight time
  const flightTimeStr =
    flightTime > 0 ? formatFlightTime(flightTime) : undefined;

  // Compute per-path minimum altitude for AGL-based cruise detection
  const pathMinAltFt = new Map<number, number>();
  for (const seg of filteredSegments) {
    if (seg.altitude_ft !== undefined) {
      const current = pathMinAltFt.get(seg.path_id);
      if (current === undefined || seg.altitude_ft < current) {
        pathMinAltFt.set(seg.path_id, seg.altitude_ft);
      }
    }
  }

  // Calculate cruise speed (segments above 1000 ft AGL)
  const cruiseSegments = filteredSegments.filter((seg) => {
    // altitude_ft may legitimately be 0, so compare against undefined
    if (
      seg.altitude_ft === undefined ||
      !seg.groundspeed_knots ||
      seg.groundspeed_knots <= 0
    )
      return false;
    const groundLevelFt = pathMinAltFt.get(seg.path_id) ?? 0;
    return seg.altitude_ft - groundLevelFt > CRUISE_ALTITUDE_THRESHOLD_FT;
  });

  // Calculate weighted average speed (distance/time) instead of simple average
  // This matches the Python backend calculation
  let cruiseSpeed: number | undefined;
  if (cruiseSegments.length > 0) {
    let totalDistanceNm = 0;
    let totalTimeHours = 0;

    for (const seg of cruiseSegments) {
      const distanceKm = segmentDistance(seg);
      if (
        distanceKm > 0 &&
        seg.groundspeed_knots &&
        seg.groundspeed_knots > 0
      ) {
        const distanceNm = distanceKm * KM_TO_NAUTICAL_MILES;
        const timeHours = distanceNm / seg.groundspeed_knots;

        totalDistanceNm += distanceNm;
        totalTimeHours += timeHours;
      }
    }

    cruiseSpeed =
      totalTimeHours > 0 ? totalDistanceNm / totalTimeHours : undefined;
  }

  // Calculate most common cruise altitude
  // Use 100ft bins to match Python backend
  let mostCommonCruiseAltitudeFt: number | undefined;
  let mostCommonCruiseAltitudeM: number | undefined;
  if (cruiseSegments.length > 0) {
    const altitudeBuckets: { [key: number]: number } = {};
    for (const seg of cruiseSegments) {
      if (seg.altitude_ft !== undefined) {
        const groundLevelFt = pathMinAltFt.get(seg.path_id) ?? 0;
        const altAglFt = seg.altitude_ft - groundLevelFt;
        const bucketFt = Math.round(altAglFt / 100) * 100;
        altitudeBuckets[bucketFt] = (altitudeBuckets[bucketFt] || 0) + 1;
      }
    }
    // Most frequent bin wins; ties resolve to the lowest bin (backend parity)
    const mostCommonBucket = Object.entries(altitudeBuckets).sort(
      (a, b) => b[1] - a[1] || Number(a[0]) - Number(b[0]),
    )[0];
    if (mostCommonBucket) {
      mostCommonCruiseAltitudeFt = Number(mostCommonBucket[0]);
      mostCommonCruiseAltitudeM = mostCommonCruiseAltitudeFt * FEET_TO_METERS;
    }
  }

  // Track points behind the filtered segments: every segment contributes its
  // start point and each path adds the end point of its last segment. This is
  // exactly what the heatmap draws, so the figure follows every filter and
  // means the same thing for a filter and for a selection.
  const pathsWithSegments = new Set<number>();
  for (const seg of filteredSegments) pathsWithSegments.add(seg.path_id);
  const totalPoints = filteredSegments.length + pathsWithSegments.size;

  return {
    total_points: totalPoints,
    num_paths: filteredPaths.length,
    num_airports: airports.size,
    airport_names: Array.from(airports),
    num_aircraft: aircraftList.length,
    aircraft_list: aircraftList,
    total_distance_km: totalDistanceKm,
    total_distance_nm: totalDistanceKm * KM_TO_NAUTICAL_MILES,
    max_altitude_m: altitudeStats.max,
    min_altitude_m: altitudeStats.min,
    total_altitude_gain_m: altitudeStats.gain,
    max_altitude_ft: maxAltitudeFt,
    min_altitude_ft: minAltitudeFt,
    total_altitude_gain_ft: totalAltitudeGainFt,
    max_groundspeed_knots: speedStats.max,
    avg_groundspeed_knots: speedStats.avg,
    cruise_speed_knots: cruiseSpeed,
    longest_flight_km: longestFlight,
    longest_flight_nm: longestFlightNm,
    total_flight_time_seconds: flightTime,
    total_flight_time_str: flightTimeStr,
    most_common_cruise_altitude_ft: mostCommonCruiseAltitudeFt,
    most_common_cruise_altitude_m: mostCommonCruiseAltitudeM,
  };
}
