/**
 * Statistics calculation utilities
 * Pure functions for calculating flight statistics from path data
 *
 * What the map itself needs is here: the filters, the per-path segment
 * slices, distances, the altitude range of the colour scale and the ground
 * levels. The figures only the statistics panel and Wrapped show are in
 * panelStats.ts, which is part of the lazily loaded Wrapped bundle.
 */

import { calculateDistance } from "../utils/geometry";
import { formatFlightTime } from "../utils/formatters";
import type { Range } from "../state/store";
import type { PathInfo, PathSegment, AircraftAggregate } from "../types";

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
 * calculateFilteredStatistics (total time, see panelStats.ts).
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
export function pathsById(paths: PathInfo[]): Map<number, PathInfo> {
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
 * Taken from path_info, which carries the exact range of every path with an
 * altitude: segment altitudes are rounded to 100 ft and can land on either
 * side of the exact value (1,291 ft rounds to 1,300 ft). The exporter writes
 * the range of every path whose points have an altitude, and a path without
 * one has no segment altitudes either (see the export contract test). Paths
 * without a segment here do not count at all. Null when none has a range.
 */
export function altitudeRangeFt(
  segments: PathSegment[],
  paths: PathInfo[],
): Range | null {
  const byId = pathsById(paths);
  let min = Infinity;
  let max = -Infinity;
  let pathId = NaN;
  for (const segment of segments) {
    // A path's segments are contiguous, so each path is looked up once
    if (segment.path_id === pathId) continue;
    pathId = segment.path_id;
    const info = byId.get(pathId);
    if (info?.min_altitude_ft === undefined) continue;
    if (info.max_altitude_ft === undefined) continue;
    if (info.min_altitude_ft < min) min = info.min_altitude_ft;
    if (info.max_altitude_ft > max) max = info.max_altitude_ft;
  }
  return min === Infinity ? null : { min, max };
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
