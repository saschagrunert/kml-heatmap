/**
 * Layer rendering helpers
 * Pure functions used by the LayerManager for colour ranges, segment
 * styling, legend labels and tooltips.
 */

import type { PathInfo, PathSegment } from "../types";
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

/**
 * Groundspeed range (knots) of the given segments, ignoring segments without
 * a positive speed. Falls back to `defaultRange` when none has one.
 */
export function calculateAirspeedRange(
  segments: PathSegment[],
  defaultRange: Range = DEFAULT_AIRSPEED_RANGE,
): Range {
  let min = Infinity;
  let max = -Infinity;
  for (const segment of segments) {
    const speed = segment.groundspeed_knots;
    if (speed === undefined || speed <= 0) continue;
    if (speed < min) min = speed;
    if (speed > max) max = speed;
  }
  return min === Infinity ? defaultRange : { min, max };
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
 * @param segments - Candidate segments (must have coords)
 * @param lat - Latitude of the point
 * @param lng - Longitude of the point
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
    const d = distanceToSegmentSquared(lat, lng, coords[0], coords[1]);
    if (d < bestDistance) {
      bestDistance = d;
      best = segment;
    }
  }
  return best;
}
