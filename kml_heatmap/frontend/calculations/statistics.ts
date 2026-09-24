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
import { findMax } from "../utils/arrayHelpers";
import type { Range } from "../state/store";
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
 *
 * Only the first and last time of each path matter, so a running min and
 * max per path replaces collecting every timestamp.
 */
export function perPathSeconds(
  segments: PathSegment[],
  pathIds?: Set<number>,
): Map<number, number> {
  const bounds = new Map<number, { min: number; max: number }>();
  for (const seg of segments) {
    if (seg.time === undefined) continue;
    if (pathIds && !pathIds.has(seg.path_id)) continue;
    const range = bounds.get(seg.path_id);
    if (!range) {
      bounds.set(seg.path_id, { min: seg.time, max: seg.time });
    } else {
      if (seg.time < range.min) range.min = seg.time;
      if (seg.time > range.max) range.max = seg.time;
    }
  }
  const result = new Map<number, number>();
  for (const [pathId, { min, max }] of bounds) {
    result.set(pathId, max - min);
  }
  return result;
}

/** Half-open index range `[start, end)` of one path within a segment array */
type SegmentRange = [start: number, end: number];

/** Path id to its range; null when the array is not grouped by path */
export type SegmentRanges = Map<number, SegmentRange> | null;

/** One index per segment array; the arrays never change after expansion */
const segmentRangesCache = new WeakMap<PathSegment[], SegmentRanges>();

/**
 * Locate every path's segments in one pass. The exporter writes the
 * segments of a path contiguously and the loader keeps that order, so a
 * path is a slice of the array. An array where a path id comes back after
 * a different one is not indexable and yields null, which makes the callers
 * fall back to a filter.
 */
export function buildSegmentRanges(segments: PathSegment[]): SegmentRanges {
  const ranges = new Map<number, SegmentRange>();
  let current = -1;
  for (let i = 0; i < segments.length; i++) {
    const pathId = segments[i]!.path_id;
    if (pathId === current) {
      ranges.get(pathId)![1] = i + 1;
      continue;
    }
    if (ranges.has(pathId)) return null;
    ranges.set(pathId, [i, i + 1]);
    current = pathId;
  }
  return ranges;
}

/**
 * The index of a segment array, built once per array. Every dataset the
 * loader produces gets exactly one; temporary arrays are indexed on demand
 * and dropped with the array.
 */
export function segmentRangesFor(segments: PathSegment[]): SegmentRanges {
  const cached = segmentRangesCache.get(segments);
  if (cached !== undefined) return cached;
  const ranges = buildSegmentRanges(segments);
  segmentRangesCache.set(segments, ranges);
  return ranges;
}

/**
 * The segments of the given paths, in array order. Sliced through the index
 * where the array has one, so the cost is the size of the result rather than
 * the size of the dataset.
 */
export function segmentsForPathIds(
  segments: PathSegment[],
  pathIds: Iterable<number>,
): PathSegment[] {
  const ranges = segmentRangesFor(segments);
  if (ranges === null) {
    const wanted = pathIds instanceof Set ? pathIds : new Set(pathIds);
    return segments.filter((segment) => wanted.has(segment.path_id));
  }

  const found: SegmentRange[] = [];
  for (const pathId of pathIds) {
    const range = ranges.get(pathId);
    if (range) found.push(range);
  }
  if (found.length === 0) return [];
  // Array order, whatever order the ids came in
  found.sort((a, b) => a[0] - b[0]);

  let total = 0;
  for (const [start, end] of found) total += end - start;
  const result: PathSegment[] = new Array<PathSegment>(total);
  let index = 0;
  for (const [start, end] of found) {
    for (let i = start; i < end; i++) {
      result[index++] = segments[i]!;
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
  // A Map, as a registration is data: "constructor" is no key of it
  const aircraftMap = new Map<string, AircraftAggregate>();
  const pathToReg = new Map<number, string>();

  for (const path of pathInfo) {
    if (path.aircraft_registration) {
      const reg = path.aircraft_registration;
      pathToReg.set(path.id, reg);
      let entry = aircraftMap.get(reg);
      if (!entry) {
        entry = {
          registration: reg,
          type: path.aircraft_type,
          flights: 0,
          flight_time_seconds: 0,
        };
        aircraftMap.set(reg, entry);
      }
      entry.flights += 1;
      // Mixed sources: a later path may carry the type the first one lacks
      entry.type ??= path.aircraft_type;
    }
  }

  if (segments || secondsByPath) {
    const seconds =
      secondsByPath ??
      perPathSeconds(segments ?? [], new Set(pathToReg.keys()));
    for (const [pathId, secs] of seconds) {
      const entry = aircraftMap.get(pathToReg.get(pathId) ?? "");
      if (entry) entry.flight_time_seconds! += secs;
    }
    for (const agg of aircraftMap.values()) {
      if (agg.flight_time_seconds && agg.flight_time_seconds > 0) {
        agg.flight_time_str = formatFlightTime(agg.flight_time_seconds);
      }
    }
  }

  // Sort by flight count descending
  return [...aircraftMap.values()].sort((a, b) => b.flights - a.flights);
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
  return segmentsForPathIds(
    segments,
    pathInfo.map((p) => p.id),
  );
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

const pathsByIdCache = new WeakMap<PathInfo[], Map<number, PathInfo>>();

/** Paths by id, kept with the array: a filter view hands the same one again */
function pathsById(paths: PathInfo[]): Map<number, PathInfo> {
  let byId = pathsByIdCache.get(paths);
  if (!byId) {
    byId = new Map(paths.map((path) => [path.id, path]));
    pathsByIdCache.set(paths, byId);
  }
  return byId;
}

/**
 * Altitude range in feet of the paths the segments belong to.
 *
 * Segment altitudes are rounded to 100 ft and can land on either side of
 * the exact value (1,291 ft rounds to 1,300 ft), so a path's exact range
 * from path_info replaces its rounded one. The rounded extremes only stand
 * in for a path that does not carry it. Paths without a segment here do not
 * count at all. Null when no segment has an altitude.
 */
export function altitudeRangeFt(
  segments: PathSegment[],
  paths?: PathInfo[],
): Range | null {
  const exact = paths ? pathsById(paths) : null;
  let min = Infinity;
  let max = -Infinity;
  let pathId = NaN;
  let pathMin = Infinity;
  let pathMax = -Infinity;

  const closePath = (): void => {
    if (pathMin === Infinity) return;
    const info = exact?.get(pathId);
    min = Math.min(min, info?.min_altitude_ft ?? pathMin);
    max = Math.max(max, info?.max_altitude_ft ?? pathMax);
  };

  for (const segment of segments) {
    if (segment.path_id !== pathId) {
      closePath();
      pathId = segment.path_id;
      pathMin = Infinity;
      pathMax = -Infinity;
    }
    const alt = segment.altitude_ft;
    if (alt === undefined) continue;
    if (alt < pathMin) pathMin = alt;
    if (alt > pathMax) pathMax = alt;
  }
  closePath();

  return min === Infinity ? null : { min, max };
}

/**
 * Smallest climb or descent the gain of a path without an exact one counts.
 * Segment altitudes are rounded to 100 ft, so a level flight on a rounding
 * boundary flips between two values; a single 100 ft step is that noise.
 */
const GAIN_HYSTERESIS_FT = 200;

/**
 * Calculate altitude statistics from segments (altitude_ft, converted)
 * @param segments - Array of segment objects
 * @param paths - Path info carrying the exact per-path altitude range and gain
 * @returns Altitude statistics in meters
 */
export function calculateAltitudeStats(
  segments: PathSegment[],
  paths?: PathInfo[],
): AltitudeStats {
  const exact = paths ? pathsById(paths) : null;
  let gainFt = 0;
  // The climbs of the current path, used only when it has no exact gain
  let pathGainFt = 0;
  let pathId = NaN;
  let low = NaN;
  let high = NaN;

  // A climb from its low to its high counts once it ends
  const closeClimb = (): void => {
    if (high - low >= GAIN_HYSTERESIS_FT) pathGainFt += high - low;
  };
  const closePath = (): void => {
    closeClimb();
    const info = exact?.get(pathId);
    gainFt += info?.altitude_gain_ft ?? pathGainFt;
    pathGainFt = 0;
  };

  for (const segment of segments) {
    // Altitude gain is accumulated per path (segments are grouped per path)
    if (segment.path_id !== pathId) {
      if (!Number.isNaN(pathId)) closePath();
      pathId = segment.path_id;
      low = high = NaN;
    }
    const alt = segment.altitude_ft;
    if (alt === undefined) continue;
    if (Number.isNaN(low)) {
      low = high = alt;
    } else if (alt > high) {
      high = alt;
    } else if (high - alt >= GAIN_HYSTERESIS_FT) {
      // A descent of the threshold ends the climb, and the next starts here
      closeClimb();
      low = high = alt;
    } else if (alt < low) {
      low = high = alt;
    }
  }
  if (!Number.isNaN(pathId)) closePath();
  const gain = gainFt * FEET_TO_METERS;

  const range = altitudeRangeFt(segments, paths);
  if (range === null) {
    return { min: 0, max: 0, gain: 0 };
  }

  return {
    min: range.min * FEET_TO_METERS,
    max: range.max * FEET_TO_METERS,
    gain,
  };
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

/** Share of a path's altitude samples that may lie below its ground level */
const GROUND_LEVEL_PERCENTILE = 0.01;

/**
 * Ground level of every path, in feet: the altitude at index
 * `floor((n - 1) * 0.01)` of the path's `n` segment altitudes sorted in
 * ascending order.
 *
 * The lowest sample alone is not robust: one barometric glitch to -1,400 ft
 * lifts a taxi at 0 ft 1,400 ft above "ground" and counts it as cruise. A
 * glitch is a handful of samples while the time on the ground is many more,
 * so the first percentile skips the one and still lands on the other.
 */
export function groundLevelsFt(segments: PathSegment[]): Map<number, number> {
  // Altitudes are rounded to 100 ft, so a histogram per path holds a few
  // dozen entries where sorting every sample would copy all of them
  const histograms = new Map<number, Map<number, number>>();
  let pathId = NaN;
  let histogram: Map<number, number> | undefined;
  for (const segment of segments) {
    const alt = segment.altitude_ft;
    if (alt === undefined) continue;
    if (segment.path_id !== pathId || !histogram) {
      pathId = segment.path_id;
      histogram = histograms.get(pathId);
      if (!histogram) {
        histogram = new Map();
        histograms.set(pathId, histogram);
      }
    }
    histogram.set(alt, (histogram.get(alt) ?? 0) + 1);
  }

  const levels = new Map<number, number>();
  for (const [id, counts] of histograms) {
    let samples = 0;
    for (const count of counts.values()) samples += count;
    const index = Math.floor((samples - 1) * GROUND_LEVEL_PERCENTILE);
    let seen = 0;
    for (const alt of [...counts.keys()].sort((a, b) => a - b)) {
      seen += counts.get(alt)!;
      if (seen > index) {
        levels.set(id, alt);
        break;
      }
    }
  }
  return levels;
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
  // A filter without any altitude reports none instead of 0 m, so that a
  // flight that never left sea level still shows its altitude
  const hasAltitude = filteredSegments.some(
    (seg) => seg.altitude_ft !== undefined,
  );
  const maxAltitudeFt = altitudeStats.max * METERS_TO_FEET;
  const minAltitudeFt = altitudeStats.min * METERS_TO_FEET;
  const totalAltitudeGainFt = altitudeStats.gain * METERS_TO_FEET;
  const longestFlightNm = longestFlight * KM_TO_NAUTICAL_MILES;

  // Format flight time
  const flightTimeStr =
    flightTime > 0 ? formatFlightTime(flightTime) : undefined;

  // Per-path ground level for AGL-based cruise detection
  const groundLevels = groundLevelsFt(filteredSegments);

  // Calculate cruise speed (segments above 1000 ft AGL)
  const cruiseSegments = filteredSegments.filter((seg) => {
    // altitude_ft may legitimately be 0, so compare against undefined
    if (
      seg.altitude_ft === undefined ||
      !seg.groundspeed_knots ||
      seg.groundspeed_knots <= 0
    )
      return false;
    const groundLevelFt = groundLevels.get(seg.path_id) ?? 0;
    return seg.altitude_ft - groundLevelFt > CRUISE_ALTITUDE_THRESHOLD_FT;
  });

  // Weighted by distance (total distance over total time) rather than a
  // plain mean of the segment speeds: segments differ in length, and a
  // mean would let a burst of short ones outweigh the rest of the cruise
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

  // Most common cruise altitude, in 100 ft bins: that is the precision the
  // exported segment altitudes carry (see export_pipeline.py)
  let mostCommonCruiseAltitudeFt: number | undefined;
  let mostCommonCruiseAltitudeM: number | undefined;
  if (cruiseSegments.length > 0) {
    const altitudeBuckets: { [key: number]: number } = {};
    for (const seg of cruiseSegments) {
      if (seg.altitude_ft !== undefined) {
        const groundLevelFt = groundLevels.get(seg.path_id) ?? 0;
        const altAglFt = seg.altitude_ft - groundLevelFt;
        const bucketFt = Math.round(altAglFt / 100) * 100;
        altitudeBuckets[bucketFt] = (altitudeBuckets[bucketFt] || 0) + 1;
      }
    }
    // Most frequent bin wins; ties resolve to the lowest bin, so the figure
    // does not move with the iteration order of the bins
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
    max_altitude_m: hasAltitude ? altitudeStats.max : undefined,
    min_altitude_m: hasAltitude ? altitudeStats.min : undefined,
    total_altitude_gain_m: hasAltitude ? altitudeStats.gain : undefined,
    max_altitude_ft: hasAltitude ? maxAltitudeFt : undefined,
    min_altitude_ft: hasAltitude ? minAltitudeFt : undefined,
    total_altitude_gain_ft: hasAltitude ? totalAltitudeGainFt : undefined,
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
