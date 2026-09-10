/**
 * Layer rendering helpers
 * Pure functions used by the LayerManager for colour ranges, filtering,
 * segment styling and legend labels.
 */

import type { PathInfo, PathSegment } from "../types";
import type { Range } from "../state/store";
import { FEET_TO_METERS, NAUTICAL_MILES_TO_KM } from "../utils/constants";
import { formatNumber } from "../utils/formatters";

/**
 * Segment rendering properties
 */
export interface SegmentProperties {
  weight: number;
  opacity: number;
  color: string;
  isSelected: boolean;
}

/**
 * Legend labels
 */
export interface LegendLabels {
  min: string;
  max: string;
}

export const DEFAULT_ALTITUDE_RANGE: Range = { min: 0, max: 10000 };
export const DEFAULT_AIRSPEED_RANGE: Range = { min: 0, max: 200 };

/**
 * Range over the matching segments, or null when none matched.
 *
 * @param seenPathIds - Filled with the ids of the paths that contributed
 */
function calculateRange(
  segments: PathSegment[],
  getValue: (seg: PathSegment) => number | undefined,
  filterValue: (v: number) => boolean,
  selectedPathIds: Set<number> | null,
  seenPathIds?: Set<number>,
): Range | null {
  const useSelection = selectedPathIds !== null && selectedPathIds.size > 0;
  let min = Infinity;
  let max = -Infinity;

  for (const seg of segments) {
    if (useSelection && !selectedPathIds.has(seg.path_id)) continue;
    const v = getValue(seg);
    if (v === undefined || !filterValue(v)) continue;
    seenPathIds?.add(seg.path_id);
    if (v < min) min = v;
    if (v > max) max = v;
  }

  return min === Infinity ? null : { min, max };
}

/**
 * Altitude colour range (feet) of the given segments, optionally restricted
 * to the selected paths. Falls back to `defaultRange` when nothing matches.
 * Negative altitudes (below the MSL reference) are kept in the data but drawn
 * with the lowest colour: the scale's lower bound is clamped at 0 ft so the
 * legend and colours match the previous (clamped) exports.
 */
export function calculateAltitudeRange(
  segments: PathSegment[],
  selectedPathIds: Set<number> | null = null,
  defaultRange: Range = DEFAULT_ALTITUDE_RANGE,
  paths?: PathInfo[],
): Range {
  const contributing = new Set<number>();
  const range = calculateRange(
    segments,
    (s) => s.altitude_ft,
    () => true,
    selectedPathIds,
    contributing,
  );

  // Nothing matched, so there is nothing to widen: mixing the fallback with
  // real per-path altitudes would report a range that is half invented
  if (range === null) return defaultRange;

  // Segment altitudes are rounded to 100 ft, so widen to the exact per-path
  // range the exporter carries. Without this the legend reads 10400 ft while
  // the statistics panel, which does use it, reads 10419 ft right beside it.
  //
  // Only the paths that are actually in the range get to widen it. Taking
  // every path that passes the selection would let one whose segments were
  // all filtered out stretch the legend past anything drawn on the map.
  let { min, max } = range;
  if (paths) {
    for (const path of paths) {
      if (!contributing.has(path.id)) continue;
      if (path.min_altitude_ft !== undefined)
        min = Math.min(min, path.min_altitude_ft);
      if (path.max_altitude_ft !== undefined)
        max = Math.max(max, path.max_altitude_ft);
    }
  }

  return min < 0 ? { min: 0, max: Math.max(max, 0) } : { min, max };
}

/**
 * Groundspeed range (knots) of the given segments, ignoring segments without
 * a positive speed. Optionally restricted to the selected paths.
 */
export function calculateAirspeedRange(
  segments: PathSegment[],
  selectedPathIds: Set<number> | null = null,
  defaultRange: Range = DEFAULT_AIRSPEED_RANGE,
): Range {
  return (
    calculateRange(
      segments,
      (s) => s.groundspeed_knots,
      (v) => v > 0,
      selectedPathIds,
    ) ?? defaultRange
  );
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
 * Format legend labels for altitude
 * @param min - Minimum altitude in feet
 * @param max - Maximum altitude in feet
 * @returns Formatted labels
 */
export function formatAltitudeLegendLabels(
  min: number,
  max: number,
): LegendLabels {
  return {
    min: formatAltitudeLabel(min),
    max: formatAltitudeLabel(max),
  };
}

/**
 * Format legend labels for airspeed
 * @param min - Minimum speed in knots
 * @param max - Maximum speed in knots
 * @returns Formatted labels
 */
export function formatAirspeedLegendLabels(
  min: number,
  max: number,
): LegendLabels {
  return {
    min: formatAirspeedLabel(min),
    max: formatAirspeedLabel(max),
  };
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
 * tooltip data on polylines that were merged from several segments.
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
