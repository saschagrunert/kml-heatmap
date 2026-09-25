/**
 * The ground a flight stands on in the 3D view (see lift.ts): the one the
 * build sampled under it, smoothed as the relief of a level draws it, or
 * the line between the fields it taxied on, and the ground of the levels
 * around a level, which its ribbons carry.
 */
import type { PathSegment } from "../types";
import { planarMetres } from "../utils/geometry";
import {
  GROUND_LEVELS,
  RELIEF_MAX_LEVEL,
  reliefPixelM,
  TERRAIN_TILE_MAX_ZOOM,
} from "./lift";
import { groundLevelsFt } from "./statistics";
import { smoothFlights, type SmoothedFlights } from "./smoothing";

/**
 * Groundspeed below which a flight is taken to be taxiing, in knots: a
 * light aircraft lifts off at 50 or more, and taxies at a walking pace to
 * 20
 */
const TAXI_KNOTS = 40;

/** Fixes of taxiing it takes to tell where the field is */
const TAXI_MIN_FIXES = 3;

/**
 * The height of the field at one end of a flight, in feet: the middle of
 * the altitudes it recorded taxiing there, from `indices` in the order
 * away from that end up to its first fast segment. Null for a flight that
 * starts or ends in the air, or without speeds to tell. A speed of 0 is no
 * speed, as the build writes an unknown one (a log without timing), and
 * ends the taxiing like a fast one, as it does in the build
 * (_field_offset_ft in kml_heatmap/terrain.py): counted as taxiing, every
 * fix of such a flight would be, and its field the middle of its altitudes.
 */
function fieldFt(
  segments: readonly PathSegment[],
  indices: readonly number[],
): number | null {
  const altitudes: number[] = [];
  for (const index of indices) {
    const segment = segments[index]!;
    const speed = segment.groundspeed_knots;
    if (!(speed > 0 && speed < TAXI_KNOTS)) break;
    altitudes.push(segment.altitude_ft);
  }
  if (altitudes.length < TAXI_MIN_FIXES) return null;
  altitudes.sort((a, b) => a - b);
  return altitudes[Math.floor(altitudes.length / 2)]!;
}

/**
 * The ground under every segment, in feet, by its index: what the build
 * sampled under a flight (PathSegment.ground_ft), where it has that for
 * every segment and `sampled` asks for it, smoothed as the relief the map
 * draws at the relief level `level` (see reliefPixelM), and as sampled
 * without one. The sampled ground follows the relief, so it is only the
 * ground where the relief is drawn: over a flat map a level flight above
 * it would climb and sink with every ridge it crossed, and over a relief
 * coarser than it with every ridge the relief leaves out. Otherwise from
 * the field a flight left to the one it
 * landed on, as its taxiing recorded them, and in between along the way it
 * flew, in proportion to the distance. The heights are the recorder's own,
 * so its taxiing is on the map whatever its altimeter was off by; and an
 * altitude that dips below the fields in flight, as a glitch of the
 * recorder does, takes no flight up with it.
 *
 * A flight that starts or ends in the air has a field at one end only, and
 * stands on it; one with neither, or without speeds, on the lowest part
 * of its time (groundLevelsFt).
 */
export function groundProfileFt(
  segments: readonly PathSegment[],
  sampled = true,
  level = Infinity,
): Float64Array {
  const byPath = new Map<number, number[]>();
  segments.forEach((segment, index) => {
    const indices = byPath.get(segment.path_id);
    if (indices) indices.push(index);
    else byPath.set(segment.path_id, [index]);
  });
  const ground = new Float64Array(segments.length);
  let lowest: Map<number, number> | null = null;
  for (const [pathId, indices] of byPath) {
    const samples = indices.map((index) => segments[index]!.ground_ft);
    if (sampled && !samples.includes(undefined)) {
      const smoothed =
        level > TERRAIN_TILE_MAX_ZOOM
          ? (samples as number[])
          : smoothAlong(
              samples as number[],
              alongMetres(segments, indices),
              reliefPixelM(level, segments[indices[0]!]!.coords[0][0]),
            );
      smoothed.forEach((feet, i) => (ground[indices[i]!] = feet));
      continue;
    }
    const start = fieldFt(segments, indices);
    const end = fieldFt(segments, [...indices].reverse());
    if (start === null && end === null) {
      lowest ??= groundLevelsFt(segments as PathSegment[]);
      const floor = lowest.get(pathId) ?? 0;
      for (const index of indices) ground[index] = floor;
      continue;
    }
    const from = start ?? end!;
    const to = end ?? start!;
    const along = alongMetres(segments, indices);
    const total = along[along.length - 1] ?? 0;
    indices.forEach((index, i) => {
      const t = total > 0 ? along[i]! / total : 0;
      ground[index] = from + (to - from) * t;
    });
  }
  return ground;
}

/**
 * The ground under every segment at the relief level `level` (see
 * groundProfileFt), and the ground of each of the levels around it that a
 * ribbon carries (GROUND_LEVELS): as the feet to add to a height above the
 * one to have it above the other, in the order of GROUND_LEVELS. They are
 * null without the sampled ground: the line between the fields is the same
 * at every level.
 */
export function groundProfilesFt(
  segments: readonly PathSegment[],
  sampled: boolean,
  level: number,
): { ground: Float64Array; offsets: Float64Array[] | null } {
  const ground = levelGroundFt(segments, sampled, level);
  if (!sampled) return { ground, offsets: null };
  const offsets = GROUND_LEVELS.map((step) => {
    const other = levelGroundFt(segments, true, level + step);
    return ground.map((feet, i) => feet - other[i]!);
  });
  return { ground, offsets };
}

/**
 * The ground under every segment at the relief level `level` alone (see
 * groundProfileFt), kept per level where it is the sampled one: the levels
 * of a cut are mostly those of the cut before, a level away
 */
export function levelGroundFt(
  segments: readonly PathSegment[],
  sampled: boolean,
  level: number,
): Float64Array {
  if (!sampled) return groundProfileFt(segments, false);
  let byLevel = sampledGround.get(segments);
  if (!byLevel) {
    sampledGround.set(segments, (byLevel = new Map<number, Float64Array>()));
  }
  const clamped = Math.min(Math.max(level, 0), RELIEF_MAX_LEVEL);
  let profile = byLevel.get(clamped);
  if (!profile) {
    profile = groundProfileFt(segments, true, clamped);
    byLevel.set(clamped, profile);
  }
  return profile;
}

/**
 * The sampled ground of the segments of a dataset by relief level, as
 * groundProfilesFt has worked it out: a dataset does not change while it
 * is on the map, and goes with it, or with the 3D view (see
 * releaseGroundProfiles)
 */
let sampledGround = new WeakMap<
  readonly PathSegment[],
  Map<number, Float64Array>
>();

/**
 * Let go of the ground worked out for every level, and of the flights
 * smoothed on it, as the 3D view goes: a profile is a number per segment,
 * and a dataset of all years kept one for each level it was shown at, for
 * as long as it stayed on the flat map
 */
export function releaseGroundProfiles(): void {
  sampledGround = new WeakMap();
  releaseGroundedFlights();
}

/**
 * The flights of a dataset smoothed on their ground (see groundedFlights),
 * the last worked out, and the ground and level they stand on
 */
let grounded: {
  segments: readonly PathSegment[];
  level: number;
  flights: SmoothedFlights;
} | null = null;

/**
 * Every flight of `segments` smoothed at its height above its ground
 * (smoothFlights): the sampled ground of the relief level `level` where
 * `sampled`, with the ground of the levels around it, and otherwise the
 * line between its fields, which is the same at every level. The ribbons
 * of the colour layers are cut from these and the heat cloud is drawn
 * along them (calculations/heatCloud.ts), so the last is kept for both:
 * smoothing every flight of all years is most of the work of turning the
 * 3D view on. It holds a curve point by point, which for all years is tens
 * of megabytes; the layer manager lets go of it once neither needs it
 * (releaseGroundedFlights).
 */
export function groundedFlights(
  segments: readonly PathSegment[],
  sampled: boolean,
  level: number,
): SmoothedFlights {
  const key = sampled ? Math.min(Math.max(level, 0), RELIEF_MAX_LEVEL) : -1;
  if (grounded?.segments === segments && grounded.level === key) {
    return grounded.flights;
  }
  // Each flight stands on its own fields (groundProfileFt), and on the
  // relief where it is drawn, as coarse as the level draws it, with the
  // ground of the levels around it
  const { ground, offsets } = groundProfilesFt(segments, sampled, level);
  const flights = smoothFlights(segments, (i) => segments[i]!.altitude_ft, {
    groundOf: (i) => ground[i]!,
    offsets,
  });
  grounded = { segments, level: key, flights };
  return flights;
}

/** Whether flights smoothed by groundedFlights are held, and of what */
export function heldGroundedFlights(): readonly PathSegment[] | null {
  return grounded?.segments ?? null;
}

/** Let go of the flights smoothed by groundedFlights */
export function releaseGroundedFlights(): void {
  grounded = null;
}

/** Metres flown to the end of each of the segments `indices` of a flight */
function alongMetres(
  segments: readonly PathSegment[],
  indices: readonly number[],
): Float64Array {
  const along = new Float64Array(indices.length);
  let total = 0;
  indices.forEach((index, i) => {
    const [from, to] = segments[index]!.coords;
    total += planarMetres(from, to);
    along[i] = total;
  });
  return along;
}

/**
 * `values` at the distances `along`, smoothed as the relief the map draws
 * from coarser tiles smooths the ground: a pixel `pixelM` across stands
 * for the ground under and around it, and the map draws the straight line
 * from one pixel to the next. Twice a moving average over two pixels,
 * which of the averages tried followed the relief the map drew along a
 * flight over the Alps closest: at every level from 4 to 9 it halved the
 * difference, to about 100 m out to 30 m in. What is left is the relief
 * beside the flight, which no smoothing along it can know. Where the
 * flight ends, the average is of the part it flew.
 */
export function smoothAlong(
  values: readonly number[],
  along: ArrayLike<number>,
  pixelM: number,
): number[] {
  const width = 2 * pixelM;
  return boxAverage(boxAverage(values, along, width), along, width);
}

/**
 * The average of the line through `values` at `along` over `width` metres
 * around each point, cut off at the ends
 */
function boxAverage(
  values: readonly number[],
  along: ArrayLike<number>,
  width: number,
): number[] {
  const n = values.length;
  // The integral of the line from the first point to each point
  const integral = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    integral[i] =
      integral[i - 1]! +
      ((values[i]! + values[i - 1]!) / 2) * (along[i]! - along[i - 1]!);
  }
  // The integral up to `x`, and the point before it, looked for from the
  // point `i` on: either end of the window only moves on
  const integralAt = (x: number, i: number): [number, number] => {
    while (i + 1 < n && along[i + 1]! <= x) i++;
    if (i + 1 >= n) return [integral[n - 1]!, i];
    const span = along[i + 1]! - along[i]!;
    const t = span > 0 ? (x - along[i]!) / span : 0;
    const v = values[i]! + (values[i + 1]! - values[i]!) * t;
    return [integral[i]! + ((values[i]! + v) / 2) * (x - along[i]!), i];
  };
  const out = new Array<number>(n);
  let lower = 0;
  let upper = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.max(along[i]! - width / 2, along[0]!);
    const b = Math.min(along[i]! + width / 2, along[n - 1]!);
    if (b <= a) {
      out[i] = values[i]!;
      continue;
    }
    let from: number;
    let to: number;
    [from, lower] = integralAt(a, lower);
    [to, upper] = integralAt(b, upper);
    out[i] = (to - from) / (b - a);
  }
  return out;
}
