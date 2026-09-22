/**
 * Lifting the flights to their altitude: the 3D view
 *
 * MapLibre cannot lift a line off the ground, so a lifted flight is drawn
 * as a ribbon of `fill-extrusion`: a thin quad along every segment, raised
 * to the height of the segment above the ground of its flight and given a
 * band of height of its own, so it shows edge on as well. The heights are
 * above ground (AGL): without terrain the map is at sea level everywhere,
 * and a traffic pattern at 1,000 ft over a field at 1,500 ft belongs 1,000
 * ft up, not 2,500. The ground of a flight runs from the field it left to
 * the one it landed on, as its taxiing there recorded them (see
 * groundProfileFt), so a flight taxis on the map at both ends. Terrain
 * would go underneath later (issue #297).
 *
 * The heights are exaggerated, more the further out the map is: at true
 * scale a circuit is a hair above the ground at any zoom where the
 * airfield is more than a dot.
 */
import type { ExpressionSpecification, Map as MapLibreMap } from "maplibre-gl";
import type { Coordinate } from "../utils/geometry";
import type { PathSegment } from "../types";
import { groundLevelsFt } from "./statistics";

/**
 * A sloping ribbon is cut into pieces this many feet apart; a piece is one
 * feature. At zoom 13 it is about a pixel, so a climb shows as a slope and
 * not as a staircase.
 */
export const LIFT_STEP_FT = 20;

/**
 * How wide a ribbon is drawn, in pixels, about as wide as a flight's line.
 * Its width is part of its geometry, which the map cannot scale by zoom, so
 * the flights are cut again for every whole zoom level (see
 * ribbonWidthZoom), and this is the width in the middle of the level: 2 to
 * 4 pixels across it. A ribbon of fixed metres would be a hairline zoomed
 * out, which is all but gone seen from straight above, and gaps where the
 * flight runs towards the camera and its walls are seen edge on.
 */
const RIBBON_WIDTH_PX = 3;

/**
 * The map zoom from which the flights are drawn flat again, as lines, in
 * the 3D view. Zoomed in that far the camera is a few hundred metres up,
 * lower than a circuit even at true scale: the flights around it would
 * stand as walls in front of it, fill the screen from above, or be behind
 * it, and only the taxiing on the ground would be left to see.
 */
export const LIFT_MAX_ZOOM = 17;

/** Whether the 3D view lifts the flights at the map zoom `zoom` */
export function isLiftedAt(zoom: number): boolean {
  return zoom < LIFT_MAX_ZOOM;
}

/**
 * The steepest a flight climbs or descends on its ribbon, in feet per foot
 * over the ground (about 17 degrees). A light aircraft climbs at a tenth
 * of that and descends on a glide path of a twentieth, so no flight is
 * changed by it; a height that jumps while the aircraft stands or rolls,
 * as the altitude of a GPS settles before takeoff, would otherwise stand
 * as a tower of pieces over one spot.
 */
const MAX_SLOPE = 0.3;

const FEET_PER_METRE = 1 / 0.3048;

/** The circumference of the earth, in metres, at the equator */
const EARTH_CIRCUMFERENCE_M = 40075016.686;

/** Metres a pixel spans at the equator at a map zoom, of 512 pixel tiles */
function metresPerPixel(zoom: number): number {
  return EARTH_CIRCUMFERENCE_M / (512 * 2 ** zoom);
}

/**
 * The zoom a ribbon's width is worked out for at the map zoom `zoom`: the
 * whole level it is in. A change of it is what cuts the flights again, and
 * what hands them to the lines at LIFT_MAX_ZOOM.
 */
export function ribbonWidthZoom(zoom: number): number {
  return Math.floor(zoom);
}

/**
 * By map zoom: how much the heights are exaggerated, and the band of
 * height a ribbon has, in metres, about three pixels at every zoom. The
 * flights are lifted at every zoom, the whole of a long flight in view
 * included, so the stops reach down to a map of half of Europe.
 */
const LIFT_STOPS: readonly (readonly [
  zoom: number,
  exaggeration: number,
  bandM: number,
])[] = [
  [4, 60, 12000],
  [6, 25, 3000],
  [8, 10, 750],
  [9.5, 6, 250],
  [11, 3, 110],
  [13, 2, 28],
  [16, 1.5, 6],
];

const FEET_TO_METRES = 0.3048;
const METRES_PER_DEGREE = 111320;
const DEGREES_TO_RADIANS = Math.PI / 180;

/** A segment's altitude as feet above its flight's ground, never below */
export function liftFt(altitudeFt: number, groundFt: number): number {
  return Math.max(altitudeFt - groundFt, 0);
}

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
 * starts or ends in the air, or without speeds to tell.
 */
function fieldFt(
  segments: readonly PathSegment[],
  indices: readonly number[],
): number | null {
  const altitudes: number[] = [];
  for (const index of indices) {
    const segment = segments[index]!;
    const speed = segment.groundspeed_knots;
    if (speed === undefined || speed >= TAXI_KNOTS) break;
    if (segment.altitude_ft !== undefined) altitudes.push(segment.altitude_ft);
  }
  if (altitudes.length < TAXI_MIN_FIXES) return null;
  altitudes.sort((a, b) => a - b);
  return altitudes[Math.floor(altitudes.length / 2)]!;
}

/**
 * The ground under every segment, in feet, by its index: from the field a
 * flight left to the one it landed on, as its taxiing recorded them, and
 * in between along the way it flew, in proportion to the distance. The
 * heights are the recorder's own, so its taxiing is on the map whatever
 * its altimeter was off by; and an altitude that dips below the fields in
 * flight, as a glitch of the recorder does, takes no flight up with it.
 *
 * A flight that starts or ends in the air has a field at one end only, and
 * stands on it; one with neither, or without speeds, on the lowest part
 * of its time (groundLevelsFt).
 */
export function groundProfileFt(
  segments: readonly PathSegment[],
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
    const start = fieldFt(segments, indices);
    const end = fieldFt(segments, [...indices].reverse());
    if (start === null && end === null) {
      lowest ??= groundLevelsFt(segments as PathSegment[]);
      const level = lowest.get(pathId) ?? 0;
      for (const index of indices) ground[index] = level;
      continue;
    }
    const from = start ?? end!;
    const to = end ?? start!;
    // Metres flown to the end of each segment
    const along = new Float64Array(indices.length);
    let total = 0;
    indices.forEach((index, i) => {
      const coords = segments[index]!.coords;
      if (coords) {
        const [[lat0, lng0], [lat1, lng1]] = coords;
        total += Math.hypot(
          (lng1 - lng0) *
            METRES_PER_DEGREE *
            Math.cos(((lat0 + lat1) / 2) * DEGREES_TO_RADIANS),
          (lat1 - lat0) * METRES_PER_DEGREE,
        );
      }
      along[i] = total;
    });
    indices.forEach((index, i) => {
      const t = total > 0 ? along[i]! / total : 0;
      ground[index] = from + (to - from) * t;
    });
  }
  return ground;
}

/** How far a mitred corner may reach out, in ribbon half widths */
const MITER_LIMIT = 3;

/**
 * The two edges of a ribbon along a line of `[lat, lng]` points, as
 * `[lng, lat]`: every point moved half of RIBBON_WIDTH_PX to the left and to
 * the right of the line, at the zoom `widthZoom` (see ribbonWidthZoom). At a bend the offset follows the bisector of the two
 * segments, lengthened so the edges stay parallel to both (a mitred join),
 * and capped at MITER_LIMIT half widths for a hairpin. `before` and `after`
 * are the points the line continues from and to, outside it: a ribbon cut
 * into features at its height steps then joins its neighbours without a
 * gap.
 */
function ribbonEdges(
  points: readonly Coordinate[],
  widthZoom: number,
  before?: Coordinate,
  after?: Coordinate,
): { left: number[][]; right: number[][] } {
  // At the middle of the level, and in metres on the ground at the
  // equator: Mercator draws them larger by as much as it shrinks a degree
  // of longitude, so a ribbon is as many pixels wide at every latitude
  const halfWidth = (RIBBON_WIDTH_PX / 2) * metresPerPixel(widthZoom + 0.5);
  const all = [
    ...(before ? [before] : []),
    ...points,
    ...(after ? [after] : []),
  ];
  const first = before ? 1 : 0;
  const left: number[][] = [];
  const right: number[][] = [];
  for (let i = first; i < first + points.length; i++) {
    const [lat, lng] = all[i]!;
    const metresPerLng = METRES_PER_DEGREE * Math.cos(lat * DEGREES_TO_RADIANS);
    // The unit normal (to the left) of the segment from `a` to `b`, in metres
    const normal = (
      a: Coordinate | undefined,
      b: Coordinate | undefined,
    ): [number, number] | null => {
      if (!a || !b) return null;
      const dx = (b[1] - a[1]) * metresPerLng;
      const dy = (b[0] - a[0]) * METRES_PER_DEGREE;
      const length = Math.hypot(dx, dy);
      return length > 0 ? [-dy / length, dx / length] : null;
    };
    const incoming = normal(all[i - 1], all[i]);
    const outgoing = normal(all[i], all[i + 1]);
    let offset: [number, number] = incoming ?? outgoing ?? [0, 0];
    let scale = 1;
    if (incoming && outgoing) {
      const sum: [number, number] = [
        incoming[0] + outgoing[0],
        incoming[1] + outgoing[1],
      ];
      const length = Math.hypot(sum[0], sum[1]);
      if (length > 1e-9) {
        offset = [sum[0] / length, sum[1] / length];
        // The bisector is shorter across the ribbon than either normal
        const cos = offset[0] * incoming[0] + offset[1] * incoming[1];
        scale = Math.min(1 / Math.max(cos, 1e-9), MITER_LIMIT);
      } else {
        // Straight back the way it came: no corner to mitre
        offset = outgoing;
      }
    }
    const reach = halfWidth * Math.cos(lat * DEGREES_TO_RADIANS) * scale;
    const dLng = (offset[0] * reach) / metresPerLng;
    const dLat = (offset[1] * reach) / METRES_PER_DEGREE;
    left.push([lng + dLng, lat + dLat]);
    right.push([lng - dLng, lat - dLat]);
  }
  return { left, right };
}

/**
 * How many degrees of turn at either end of a segment are one more point
 * on the curve through it, and the most points a segment is cut into. A
 * straight segment stays one, so smoothing costs only where the flight
 * turns; a straight climb stays a straight slope.
 */
const SMOOTH_TURN_DEG = 8;
const SMOOTH_MAX_STEPS = 8;

/** A line smoothed through its points, see smoothLine */
export interface SmoothedLine {
  /** `[lat, lng]` points along the curve, the given ones among them */
  points: Coordinate[];
  /** Feet above ground at each point */
  heights: number[];
  /** Where each given point is in `points` */
  vertex: number[];
}

/** Degrees the direction turns at `b`, from `a` over `b` to `c` */
function turnDeg(a: number[], b: number[], c: number[]): number {
  const ux = b[0]! - a[0]!;
  const uy = b[1]! - a[1]!;
  const vx = c[0]! - b[0]!;
  const vy = c[1]! - b[1]!;
  const lu = Math.hypot(ux, uy);
  const lv = Math.hypot(vx, vy);
  if (lu === 0 || lv === 0) return 0;
  const cos = Math.min(Math.max((ux * vx + uy * vy) / (lu * lv), -1), 1);
  return Math.acos(cos) / DEGREES_TO_RADIANS;
}

/**
 * A point of the centripetal Catmull-Rom spline from `p1` to `p2`, at `t`
 * from 0 to 1. Centripetal: it neither loops nor overshoots where the
 * points are unevenly spaced, as the fixes of a flight are.
 */
function catmullRom(
  p0: number[],
  p1: number[],
  p2: number[],
  p3: number[],
  t: number,
): number[] {
  const knot = (a: number[], b: number[]): number =>
    Math.max(Math.sqrt(Math.hypot(b[0]! - a[0]!, b[1]! - a[1]!)), 1e-9);
  const t1 = knot(p0, p1);
  const t2 = t1 + knot(p1, p2);
  const t3 = t2 + knot(p2, p3);
  const u = t1 + (t2 - t1) * t;
  const mix = (a: number[], b: number[], ta: number, tb: number): number[] => {
    const w = (u - ta) / (tb - ta);
    return [a[0]! + (b[0]! - a[0]!) * w, a[1]! + (b[1]! - a[1]!) * w];
  };
  const a1 = mix(p0, p1, 0, t1);
  const a2 = mix(p1, p2, t1, t2);
  const a3 = mix(p2, p3, t2, t3);
  const b1 = mix(a1, a2, 0, t2);
  const b2 = mix(a2, a3, t1, t3);
  return mix(b1, b2, t1, t2);
}

/**
 * The height at `t` on a segment from `h1` to `h2`, as a curve through its
 * neighbours `h0` and `h3`, never above or below the segment's own two: a
 * climb eases in and out, and a level stretch stays level
 */
function smoothHeight(
  h0: number,
  h1: number,
  h2: number,
  h3: number,
  t: number,
): number {
  const m1 = (h2 - h0) / 2;
  const m2 = (h3 - h1) / 2;
  const t2 = t * t;
  const t3 = t2 * t;
  const h =
    (2 * t3 - 3 * t2 + 1) * h1 +
    (t3 - 2 * t2 + t) * m1 +
    (-2 * t3 + 3 * t2) * h2 +
    (t3 - t2) * m2;
  return Math.min(Math.max(h, Math.min(h1, h2)), Math.max(h1, h2));
}

/**
 * A line of `[lat, lng]` points with the feet above ground at each, drawn
 * as a smooth curve through its points: the logged positions stay where
 * they are, and a segment where the flight turns is cut into more points
 * along a spline through its neighbours; its heights change no faster
 * than MAX_SLOPE allows. The whole of a flight is smoothed at once, so the ribbons cut from it at its colour and height steps meet
 * in the same points and fit together without a seam.
 */
export function smoothLine(
  points: readonly Coordinate[],
  heights: readonly number[],
): SmoothedLine {
  if (points.length === 0) return { points: [], heights: [], vertex: [] };
  // Planar metres around the line, so the curve is round on the ground
  const [lat0] = points[0]!;
  const scale = Math.cos(lat0 * DEGREES_TO_RADIANS);
  const planar = points.map(([lat, lng]) => [
    lng * scale * METRES_PER_DEGREE,
    lat * METRES_PER_DEGREE,
  ]);
  const out: SmoothedLine = {
    points: [points[0]!],
    heights: [heights[0]!],
    vertex: [0],
  };
  for (let i = 0; i + 1 < points.length; i++) {
    const p1 = planar[i]!;
    const p2 = planar[i + 1]!;
    // Where the line ends, its neighbour is the next point mirrored: the
    // curve then leaves and arrives along the segment, straight
    const p0 = planar[i - 1] ?? [2 * p1[0]! - p2[0]!, 2 * p1[1]! - p2[1]!];
    const p3 = planar[i + 2] ?? [2 * p2[0]! - p1[0]!, 2 * p2[1]! - p1[1]!];
    const h1 = heights[i]!;
    const h2 = heights[i + 1]!;
    const h0 = heights[i - 1] ?? h1;
    const h3 = heights[i + 2] ?? h2;
    const turn = Math.max(turnDeg(p0, p1, p2), turnDeg(p1, p2, p3));
    const steps = Math.min(
      Math.max(Math.ceil(turn / SMOOTH_TURN_DEG), 1),
      SMOOTH_MAX_STEPS,
    );
    for (let k = 1; k < steps; k++) {
      const [x, y] = catmullRom(p0, p1, p2, p3, k / steps);
      out.points.push([y! / METRES_PER_DEGREE, x! / scale / METRES_PER_DEGREE]);
      out.heights.push(smoothHeight(h0, h1, h2, h3, k / steps));
    }
    out.points.push(points[i + 1]!);
    out.heights.push(h2);
    out.vertex.push(out.points.length - 1);
  }
  limitSlope(out.points, out.heights);
  return out;
}

/**
 * Hold the heights of a line to MAX_SLOPE, from its start on: a height
 * that changes faster than that over the ground to the point before is
 * taken as far as the slope allows, and the line goes on from there
 */
function limitSlope(points: readonly Coordinate[], heights: number[]): void {
  for (let i = 1; i < points.length; i++) {
    const [lat0, lng0] = points[i - 1]!;
    const [lat1, lng1] = points[i]!;
    const dx =
      (lng1 - lng0) *
      METRES_PER_DEGREE *
      Math.cos(((lat0 + lat1) / 2) * DEGREES_TO_RADIANS);
    const dy = (lat1 - lat0) * METRES_PER_DEGREE;
    const reach = Math.hypot(dx, dy) * FEET_PER_METRE * MAX_SLOPE;
    const previous = heights[i - 1]!;
    heights[i] = Math.min(
      Math.max(heights[i]!, previous - reach),
      previous + reach,
    );
  }
}

/**
 * Every flight of a list of segments smoothed (see smoothLine), and where
 * each segment lies on its flight's curve. A flight is a chain of segments
 * of one path, each starting where the one before ends.
 */
export interface SmoothedFlights {
  chains: SmoothedLine[];
  /** Per segment: its chain, or -1 for one without coordinates */
  chainOf: Int32Array;
  /** Per segment: where its start is on its chain's curve */
  from: Int32Array;
  /** Per segment: where its end is on its chain's curve */
  to: Int32Array;
}

/**
 * Smooth the flights of `segments`, the height of each point from
 * `heightOf`: the feet above ground a segment ends at. A segment's
 * altitude is the one at its end, so a chain's first point takes the
 * height of its first segment.
 */
export function smoothFlights(
  segments: readonly {
    path_id: number;
    coords?: readonly [Coordinate, Coordinate] | undefined;
  }[],
  heightOf: (index: number) => number,
): SmoothedFlights {
  const count = segments.length;
  const chainOf = new Int32Array(count).fill(-1);
  const from = new Int32Array(count);
  const to = new Int32Array(count);
  const chains: SmoothedLine[] = [];
  let i = 0;
  while (i < count) {
    const first = segments[i]!;
    if (!first.coords) {
      i++;
      continue;
    }
    const members = [i];
    let end = first.coords[1];
    while (i + members.length < count) {
      const next = segments[i + members.length]!;
      if (
        next.path_id !== first.path_id ||
        !next.coords ||
        next.coords[0][0] !== end[0] ||
        next.coords[0][1] !== end[1]
      ) {
        break;
      }
      members.push(i + members.length);
      end = next.coords[1];
    }
    const points: Coordinate[] = [first.coords[0]];
    const heights: number[] = [heightOf(i)];
    for (const m of members) {
      points.push(segments[m]!.coords![1]);
      heights.push(heightOf(m));
    }
    const line = smoothLine(points, heights);
    members.forEach((m, j) => {
      chainOf[m] = chains.length;
      from[m] = line.vertex[j]!;
      to[m] = line.vertex[j + 1]!;
    });
    chains.push(line);
    i += members.length;
  }
  return { chains, chainOf, from, to };
}

/**
 * The ribbon of the segments `start` to `end` (exclusive) of one flight,
 * cut from its smoothed curve: the neighbouring points of the curve on
 * either side are its `before` and `after`, so it meets the ribbons next to
 * it corner to corner
 */
export function ribbonOf(
  smoothed: SmoothedFlights,
  start: number,
  end: number,
  widthZoom: number,
): RibbonPiece[] {
  const chain = smoothed.chains[smoothed.chainOf[start]!];
  if (!chain) return [];
  const a = smoothed.from[start]!;
  const b = smoothed.to[end - 1]!;
  return ribbonPieces(
    chain.points.slice(a, b + 1),
    chain.heights.slice(a, b + 1),
    widthZoom,
    chain.points[a - 1],
    chain.points[b + 1],
  );
}

/**
 * Where on its flight's smoothed curve a segment is at `fraction` of the
 * way from its start to its end, and the feet above ground there: on the
 * ribbon, which runs along the curve and not along the straight segment.
 * The points the curve cuts a segment into are evenly spaced in its
 * parameter, which is close enough to evenly in time. Null for a segment
 * without coordinates.
 */
export function pointOnFlight(
  smoothed: SmoothedFlights,
  index: number,
  fraction: number,
): { position: Coordinate; heightFt: number } | null {
  const chain = smoothed.chains[smoothed.chainOf[index] ?? -1];
  if (!chain) return null;
  const from = smoothed.from[index]!;
  const to = smoothed.to[index]!;
  const along = from + Math.min(Math.max(fraction, 0), 1) * (to - from);
  const i = Math.min(Math.floor(along), to - 1);
  const t = to > from ? along - i : 0;
  const a = chain.points[i]!;
  const b = chain.points[Math.min(i + 1, to)]!;
  const ha = chain.heights[i]!;
  const hb = chain.heights[Math.min(i + 1, to)]!;
  return {
    position: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t],
    heightFt: ha + (hb - ha) * t,
  };
}

/** A piece of a ribbon: the quads it is made of, at one height step */
export interface RibbonPiece {
  /** Feet above the flight's ground: the height in the piece's middle */
  h: number;
  geometry: GeoJSON.MultiPolygon;
}

/**
 * The ribbon along a line of `[lat, lng]` points, climbing and descending
 * with it: `heights` are the feet above ground at each point, and between
 * two points the ribbon slopes from one to the other. A feature has one
 * height, so a sloping segment is cut into pieces a LIFT_STEP_FT apart, and
 * pieces of the same height that follow each other make one feature. The
 * quads share their corners (see ribbonEdges), so the ribbon runs on through
 * its bends and its climbs without a gap. See ribbonEdges for `widthZoom`,
 * `before` and `after`.
 */
export function ribbonPieces(
  points: readonly Coordinate[],
  heights: readonly number[],
  widthZoom: number,
  before?: Coordinate,
  after?: Coordinate,
): RibbonPiece[] {
  const { left, right } = ribbonEdges(points, widthZoom, before, after);
  const pieces: RibbonPiece[] = [];
  const lerp = (a: number[], b: number[], t: number): number[] => [
    a[0]! + (b[0]! - a[0]!) * t,
    a[1]! + (b[1]! - a[1]!) * t,
  ];
  for (let i = 0; i + 1 < points.length; i++) {
    const from = heights[i]!;
    const to = heights[i + 1]!;
    const count = Math.max(1, Math.ceil(Math.abs(to - from) / LIFT_STEP_FT));
    for (let k = 0; k < count; k++) {
      const t0 = k / count;
      const t1 = (k + 1) / count;
      const h = from + ((to - from) * (k + 0.5)) / count;
      const a = lerp(left[i]!, left[i + 1]!, t0);
      const b = lerp(left[i]!, left[i + 1]!, t1);
      const c = lerp(right[i]!, right[i + 1]!, t1);
      const d = lerp(right[i]!, right[i + 1]!, t0);
      const quad = [[a, b, c, d, a]];
      const last = pieces[pieces.length - 1];
      if (last?.h === h) last.geometry.coordinates.push(quad);
      else
        pieces.push({
          h,
          geometry: { type: "MultiPolygon", coordinates: [quad] },
        });
    }
  }
  return pieces;
}

/**
 * The paint of a ribbon's bottom and top by zoom, from the height `h` of
 * its feature, in feet. `zoom` may only be the input of a top-level
 * interpolation, hence the height inside every stop.
 */
export function ribbonHeights(): {
  base: ExpressionSpecification;
  height: ExpressionSpecification;
} {
  const metres = (exaggeration: number): ExpressionSpecification => [
    "*",
    ["get", "h"],
    FEET_TO_METRES * exaggeration,
  ];
  const byZoom = (
    at: (exaggeration: number, bandM: number) => ExpressionSpecification,
  ): ExpressionSpecification =>
    [
      "interpolate",
      ["linear"],
      ["zoom"],
      ...LIFT_STOPS.flatMap(([zoom, exaggeration, bandM]) => [
        zoom,
        at(exaggeration, bandM),
      ]),
    ] as ExpressionSpecification;
  return {
    // A piece spans its step, half of it below its middle and half above,
    // so the pieces of a slope meet; the band goes on top of that
    base: byZoom((exaggeration) => [
      "max",
      [
        "-",
        metres(exaggeration),
        (LIFT_STEP_FT / 2) * FEET_TO_METRES * exaggeration,
      ],
      0,
    ]),
    height: byZoom((exaggeration, bandM) => [
      "+",
      metres(exaggeration),
      (LIFT_STEP_FT / 2) * FEET_TO_METRES * exaggeration + bandM,
    ]),
  };
}

/** Linear between the stops of LIFT_STOPS, held beyond the ends */
function atZoom(
  zoom: number,
  pick: (stop: (typeof LIFT_STOPS)[number]) => number,
): number {
  const first = LIFT_STOPS[0]!;
  const last = LIFT_STOPS[LIFT_STOPS.length - 1]!;
  if (zoom <= first[0]) return pick(first);
  if (zoom >= last[0]) return pick(last);
  for (let i = 1; i < LIFT_STOPS.length; i++) {
    const upper = LIFT_STOPS[i]!;
    if (zoom > upper[0]) continue;
    const lower = LIFT_STOPS[i - 1]!;
    const t = (zoom - lower[0]) / (upper[0] - lower[0]);
    return pick(lower) + t * (pick(upper) - pick(lower));
  }
  return pick(last);
}

/**
 * How far up the screen a point `heightFt` above the ground is drawn, in
 * pixels, where the map draws the ground at `lat`: the height as the
 * ribbons have it at this zoom, over the metres a pixel spans there,
 * foreshortened by the tilt. Flat, a height takes no room on the screen.
 * An approximation that leaves the perspective out, close enough to put
 * the airplane on its ribbon and to rank what is under the pointer.
 */
export function liftOffsetPx(
  map: MapLibreMap,
  lat: number,
  heightFt: number,
  zoom = map.getZoom(),
): number {
  const pitch = map.getPitch() * DEGREES_TO_RADIANS;
  const metres =
    heightFt *
    FEET_TO_METRES *
    atZoom(zoom, ([, exaggeration]) => exaggeration);
  const metresPerPx = metresPerPixel(zoom) * Math.cos(lat * DEGREES_TO_RADIANS);
  return (metres / metresPerPx) * Math.sin(pitch);
}

/**
 * How far up the screen the replay's airplane is drawn at `zoom`: at its
 * height, on its trail, where the trail is lifted (see isLiftedAt).
 * `heightFt` is null while the trail is flat.
 */
export function airplaneLiftPx(
  map: MapLibreMap,
  lat: number,
  heightFt: number | null,
  zoom = map.getZoom(),
): number {
  return heightFt === null || !isLiftedAt(zoom)
    ? 0
    : liftOffsetPx(map, lat, heightFt, zoom);
}
