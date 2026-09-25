/**
 * Layer rendering helpers
 * Pure functions used by the LayerManager for colour ranges, segment
 * styling, legend labels and tooltips.
 */

import type { PathInfo, PathSegment } from "../types";
import type { Coordinate } from "../utils/geometry";
import type { SmoothedFlights } from "../calculations/lift";
import {
  DEFAULT_AIRSPEED_RANGE,
  DEFAULT_ALTITUDE_RANGE,
  type Range,
} from "../state/store";
import { FEET_TO_METERS, NAUTICAL_MILES_TO_KM } from "../utils/constants";
import { formatNumber } from "../utils/formatters";
import { altitudeRangeFt } from "../calculations/statistics";

/**
 * Segment rendering properties
 */
export interface SegmentProperties {
  weight: number;
  opacity: number;
  color: string;
  isSelected: boolean;
}

export { DEFAULT_ALTITUDE_RANGE, DEFAULT_AIRSPEED_RANGE };

/**
 * Altitude colour range (feet) of the given segments, falling back to
 * `defaultRange` when none has an altitude. Callers pass the segments of the
 * paths the range is for (the selection, or the whole dataset).
 *
 * The range uses the exact per-path altitudes from `paths` where they exist,
 * like the statistics panel beside the legend does (see altitudeRangeFt).
 * Negative altitudes (below the MSL reference) are kept in the data but drawn
 * with the lowest colour: the scale's lower bound is clamped at 0 ft so the
 * legend and colours match the previous (clamped) exports.
 */
export function calculateAltitudeRange(
  segments: PathSegment[],
  defaultRange: Range = DEFAULT_ALTITUDE_RANGE,
  paths?: PathInfo[],
): Range {
  const range = altitudeRangeFt(segments, paths);
  if (range === null) return defaultRange;

  const { min, max } = range;
  return min < 0 ? { min: 0, max: Math.max(max, 0) } : { min, max };
}

/** Share of the speeds that falls below and above the ends of the scale */
const AIRSPEED_RANGE_TAIL = 0.05;

/**
 * Groundspeed colour range (knots) of the given segments, ignoring segments
 * without a positive speed. Falls back to `defaultRange` when none has one.
 *
 * The scale runs from the 5th to the 95th percentile rather than from the
 * slowest to the fastest segment. Most of a flight is spent near its cruise
 * speed, and a few taxi crawls and one fast descent stretched the full range
 * so far that more than half the segments fell into a handful of adjacent
 * steps of the ramp. The tails take the colours of the ends, and the legend
 * says so. A dataset whose middle has no spread keeps the full range.
 */
export function calculateAirspeedRange(
  segments: PathSegment[],
  defaultRange: Range = DEFAULT_AIRSPEED_RANGE,
): Range {
  const speeds: number[] = [];
  for (const segment of segments) {
    const speed = segment.groundspeed_knots;
    if (speed !== undefined && speed > 0) speeds.push(speed);
  }
  if (speeds.length === 0) return defaultRange;
  const sorted = Float64Array.from(speeds).sort();
  const last = sorted.length - 1;
  const min = sorted[Math.floor(AIRSPEED_RANGE_TAIL * last)]!;
  const max = sorted[Math.ceil((1 - AIRSPEED_RANGE_TAIL) * last)]!;
  return min < max ? { min, max } : { min: sorted[0]!, max: sorted[last]! };
}

/**
 * Calculate segment rendering properties (weight, opacity, colour) from the
 * selection state.
 *
 * - no selection: normal weight, 0.85 opacity
 * - selected path: heavier line, full opacity
 * - unselected path while a selection exists: dimmed
 * - isolate mode: only selected paths are drawn, at normal weight
 */
export function calculateSegmentProperties(options: {
  pathId: number;
  selectedPathIds?: Set<number>;
  isolateSelection?: boolean;
  colorFunction?: (value: number, min: number, max: number) => string;
  colorMin?: number;
  colorMax?: number;
  value?: number; // altitude_ft or groundspeed_knots
}): SegmentProperties {
  const {
    pathId,
    selectedPathIds = new Set<number>(),
    isolateSelection = false,
    colorFunction,
    colorMin = 0,
    colorMax = 0,
    value = 0,
  } = options;

  const hasSelection = selectedPathIds.size > 0;
  const isSelected = selectedPathIds.has(pathId);
  const inSolo = isolateSelection && isSelected;

  return {
    weight: isSelected && !inSolo ? 6 : 4,
    opacity: inSolo ? 0.85 : isSelected ? 1.0 : hasSelection ? 0.1 : 0.85,
    color: colorFunction ? colorFunction(value, colorMin, colorMax) : "#3388ff",
    isSelected,
  };
}

/**
 * Format an altitude legend label, e.g. "1000 ft (305 m)"
 */
export function formatAltitudeLabel(valueFt: number): string {
  return (
    formatNumber(valueFt) +
    " ft (" +
    formatNumber(valueFt * FEET_TO_METERS) +
    " m)"
  );
}

/**
 * Format a groundspeed legend label, e.g. "100 kt (185 km/h)"
 */
export function formatAirspeedLabel(valueKt: number): string {
  return (
    formatNumber(valueKt) +
    " kt (" +
    formatNumber(valueKt * NAUTICAL_MILES_TO_KM) +
    " km/h)"
  );
}

/**
 * Squared planar distance (in degrees, longitude scaled by cos(lat)) from a
 * point to a line segment.
 */
function distanceToSegmentSquared(
  lat: number,
  lng: number,
  a: [number, number],
  b: [number, number],
): number {
  const scale = Math.cos((lat * Math.PI) / 180);
  const ax = a[1] * scale;
  const ay = a[0];
  const bx = b[1] * scale;
  const by = b[0];
  const px = lng * scale;
  const py = lat;

  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  let t = 0;
  if (lengthSquared > 0) {
    t = ((px - ax) * dx + (py - ay) * dy) / lengthSquared;
    t = Math.max(0, Math.min(1, t));
  }
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return (px - cx) * (px - cx) + (py - cy) * (py - cy);
}

/**
 * Find the segment closest to a geographic point. Used to show per-segment
 * tooltip data on lines that were merged from several segments.
 *
 * The map draws copies of the world, so the longitude of the point may be
 * any number of turns away from the one a segment is stored with, and a run
 * that crosses the antimeridian has segments on either side of it. Each
 * segment is measured against the point as seen from its own copy.
 * @param segments - Candidate segments (must have coords)
 * @param lat - Latitude of the point
 * @param lng - Longitude of the point, wrapped or not
 * @returns Nearest segment or undefined for an empty list
 */
export function findNearestSegment(
  segments: PathSegment[],
  lat: number,
  lng: number,
): PathSegment | undefined {
  let best: PathSegment | undefined;
  let bestDistance = Infinity;
  for (const segment of segments) {
    const coords = segment.coords;
    if (!coords) continue;
    const turns = Math.round((coords[0][1] - lng) / 360);
    const d = distanceToSegmentSquared(
      lat,
      lng + 360 * turns,
      coords[0],
      coords[1],
    );
    if (d < bestDistance) {
      bestDistance = d;
      best = segment;
    }
  }
  return best;
}

/**
 * `findNearestSegment` for segments drawn along their flight's curve (see
 * calculations/curves.ts): the index, from `start` to `end` (exclusive), of
 * the segment whose part of the curve passes nearest to the point, and the
 * piece of the curve it passes nearest on. A point of the curve belongs to
 * the segment it lies on, so near a fix in a turn the answer is the segment
 * drawn under the point, not the one whose straight line is nearer.
 */
export function findNearestOnCurve(
  curves: SmoothedFlights,
  start: number,
  end: number,
  lat: number,
  lng: number,
): { index: number; piece: [Coordinate, Coordinate] } | null {
  let best: { index: number; piece: [Coordinate, Coordinate] } | null = null;
  let bestDistance = Infinity;
  for (let index = start; index < end; index++) {
    const points = curves.chains[curves.chainOf[index]!]?.points;
    if (!points) continue;
    for (let i = curves.from[index]!; i < curves.to[index]!; i++) {
      const a = points[i]!;
      const b = points[i + 1]!;
      const turns = Math.round((a[1] - lng) / 360);
      const d = distanceToSegmentSquared(lat, lng + 360 * turns, a, b);
      if (d < bestDistance) {
        bestDistance = d;
        best = { index, piece: [a, b] };
      }
    }
  }
  return best;
}
