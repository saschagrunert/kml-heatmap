/**
 * The altitude profile of one flight: what ui/flightProfile.ts draws, and
 * the figures of its stats row.
 *
 * The profile runs along the flight's time where it has one, and along the
 * distance flown where it has none. Each point is a segment: its altitude
 * and the ground under it, at the time (or the distance) it starts, as the
 * replay reads a segment's time (see ReplayRenderer.placeAirplane).
 */
import { heightsAboveGround, segmentDistance } from "./statistics";
import { calculateDistance, type Coordinate } from "../utils/geometry";
import type { PathSegment } from "../types";

/**
 * How far around each field the en-route figures leave the flight out, in
 * km: the climb-out, the circuit's turns and the approach are low on
 * purpose
 */
export const FIELD_RADIUS_KM = 2;

/** Height above the ground below which the flight counts as low, in feet */
export const LOW_HEIGHT_FT = 1000;

/**
 * About FIELD_RADIUS_KM in degrees of latitude and more: a field further
 * off than this in latitude is not measured at all
 */
const FIELD_RADIUS_DEG = 0.03;

export interface FlightProfile {
  /** The flight's segments, in the order they were flown */
  segments: readonly PathSegment[];
  /** Whether `x` is seconds into the flight, rather than km along it */
  timed: boolean;
  /** Where each segment starts: its time, or the km flown before it */
  x: Float64Array;
  altitudeFt: Float64Array;
  /** The ground under each segment, see heightsAboveGround */
  groundFt: Float64Array;
  /**
   * Whether the ground is the terrain under the flight (so heights over it
   * are AGL), not the level of its field
   */
  fromTerrain: boolean;
  maxAltitudeFt: number;
  /**
   * Lowest height above the ground further than FIELD_RADIUS_KM from every
   * field, null for a flight that never got that far
   */
  lowestEnRouteFt: number | null;
  /**
   * Seconds spent below LOW_HEIGHT_FT above the ground that far from every
   * field; null for a flight without times
   */
  lowSeconds: number | null;
}

/**
 * The profile of one flight's `segments`, in the order they were flown.
 * `fields` are the airfields around which the en-route figures leave the
 * flight out; the flight's own first and last point count as fields too,
 * for an airfield the site has no marker for. `maxAltitudeFt` is the exact
 * highest altitude where the export carries one (the segments' altitudes
 * are rounded). Null for a flight of fewer than two segments.
 */
export function flightProfile(
  segments: readonly PathSegment[],
  fields: readonly Coordinate[],
  maxAltitudeFt?: number,
): FlightProfile | null {
  const count = segments.length;
  if (count < 2) return null;
  const first = segments[0]!;
  const last = segments[count - 1]!;
  const timed =
    segments.every((segment) => segment.time !== undefined) &&
    last.time! > first.time!;
  const heights = heightsAboveGround(segments as PathSegment[]);
  const x = new Float64Array(count);
  const altitudeFt = new Float64Array(count);
  const groundFt = new Float64Array(count);
  const places = [first.coords[0], last.coords[1], ...fields];
  let highest = -Infinity;
  let lowest = Infinity;
  let lowSeconds = 0;
  let along = 0;
  for (let i = 0; i < count; i++) {
    const segment = segments[i]!;
    const altitude = segment.altitude_ft;
    const height = heights.heightFt(segment, altitude);
    x[i] = timed ? segment.time! : along;
    along += segmentDistance(segment);
    altitudeFt[i] = altitude;
    groundFt[i] = altitude - height;
    if (altitude > highest) highest = altitude;
    if (!enRoute(segment.coords[1], places)) continue;
    if (height < lowest) lowest = height;
    const next = segments[i + 1];
    if (timed && next && height < LOW_HEIGHT_FT) {
      lowSeconds += next.time! - segment.time!;
    }
  }
  return {
    segments,
    timed,
    x,
    altitudeFt,
    groundFt,
    fromTerrain: heights.fromTerrain,
    maxAltitudeFt: maxAltitudeFt ?? highest,
    // A height a little below the ground is the elevation model's error
    lowestEnRouteFt: lowest === Infinity ? null : Math.max(0, lowest),
    lowSeconds: timed ? lowSeconds : null,
  };
}

/** Whether `point` is further than FIELD_RADIUS_KM from every place */
function enRoute(point: Coordinate, places: readonly Coordinate[]): boolean {
  for (const place of places) {
    if (
      Math.abs(place[0] - point[0]) < FIELD_RADIUS_DEG &&
      calculateDistance(place, point) <= FIELD_RADIUS_KM
    ) {
      return false;
    }
  }
  return true;
}

/** A point of the profile: in segment `index`, `fraction` of the way on */
export interface ProfilePoint {
  index: number;
  fraction: number;
}

/**
 * The point where `valueOf`, which grows with the index over `count`
 * segments, reaches `value`: the last segment that starts at or before it,
 * and how far on to the start of the next one. Clamped to the ends.
 */
export function locate(
  count: number,
  valueOf: (index: number) => number,
  value: number,
): ProfilePoint {
  let lo = 0;
  let hi = count - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (valueOf(mid) <= value) lo = mid;
    else hi = mid - 1;
  }
  if (lo >= count - 1) return { index: Math.max(0, count - 1), fraction: 0 };
  // The next segment starts after `value`, so the span is never empty
  const start = valueOf(lo);
  const fraction = (value - start) / (valueOf(lo + 1) - start);
  return { index: lo, fraction: Math.min(1, Math.max(0, fraction)) };
}

/** The value `valueOf` has at a point, between two segments' starts */
export function valueAt(
  valueOf: (index: number) => number,
  count: number,
  { index, fraction }: ProfilePoint,
): number {
  const start = valueOf(index);
  return index + 1 < count
    ? start + (valueOf(index + 1) - start) * fraction
    : start;
}
