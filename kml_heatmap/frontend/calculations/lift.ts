/**
 * Lifting the flights to their altitude: the 3D view
 *
 * MapLibre cannot lift a line off the ground, so a lifted flight is drawn
 * as a ribbon of `fill-extrusion`: a thin quad along every segment, raised
 * to the height of the segment above the ground of its flight and given a
 * band of height of its own, so it shows edge on as well. The heights are
 * above ground (AGL): without terrain the map is at sea level everywhere,
 * and a traffic pattern at 1,000 ft over a field at 1,500 ft belongs 1,000
 * ft up, not 2,500. The ground of a flight is the one the build sampled
 * under it from an elevation model, anchored to the fields it left and
 * landed on (kml_heatmap/terrain.py), and without it the line from the one
 * field to the other (see groundProfileFt); either way a flight taxis on
 * the map at both ends. Off the globe the map draws the relief under the
 * flights, and the ribbons stand on it.
 *
 * The heights are exaggerated, and the relief as much, more the further
 * out the map is: at true scale a circuit is a hair above the ground at
 * any zoom where the airfield is more than a dot.
 */
import type { ExpressionSpecification, Map as MapLibreMap } from "maplibre-gl";
import {
  DEGREES_TO_RADIANS,
  EARTH_CIRCUMFERENCE_M,
  METRES_PER_DEGREE,
  planarMetres,
  type Coordinate,
} from "../utils/geometry";
import type { PathSegment } from "../types";
import { FEET_TO_METERS, METERS_TO_FEET } from "../utils/constants";
import { unwrapLng } from "../utils/mapHelpers";
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

/**
 * The deepest level of the elevation tiles, the one the build samples the
 * ground at (TERRAIN_ZOOM in terrain.py); the map stretches it beyond.
 */
export const TERRAIN_TILE_MAX_ZOOM = 10;

/**
 * The whole level the relief and the heights of the flights are drawn for
 * at the map zoom `zoom`: the level the ribbons are cut for (see
 * ribbonWidthZoom), up to the one whose ribbons stand on the deepest
 * elevation tiles (see reliefPixelM), from where neither the exaggeration
 * nor the ground changes any more.
 */
export function reliefLevel(zoom: number): number {
  return Math.min(Math.max(ribbonWidthZoom(zoom), 0), RELIEF_MAX_LEVEL);
}

/** The last relief level, see reliefLevel */
export const RELIEF_MAX_LEVEL = TERRAIN_TILE_MAX_ZOOM + 1;

/**
 * The relief levels, counted from the one the flights are cut for, whose
 * ground a ribbon carries as well. MapLibre lifts a ribbon by the relief of
 * the level of the tile it is drawn in, and not every tile is of the level
 * the flights are cut for: while a zoom goes on, the tiles of the next
 * level in or out take over before the zoom ends and the flights are cut
 * for it, and in the distance of a tilted view the tiles are a level or two
 * further out. The paint takes the ground of the tile's own level (see
 * ribbonHeights), so a ribbon stands on the relief under it at every one of
 * these; a level further away takes the ground of the nearest of them.
 */
export const GROUND_LEVELS: readonly number[] = [-2, -1, 1];

/**
 * The feature property that carries the ground of the level `step` levels
 * from the one a ribbon was cut for (see GROUND_LEVELS)
 */
function groundKey(step: number): `o${number}` {
  return `o${step}`;
}

/**
 * The finest step the ground offsets are rounded to, in feet: the ground
 * is written in steps of 10 ft (GROUND_STEP in segment_codec.py)
 */
const GROUND_OFFSET_STEP_FT = 10;

/**
 * How much the relief and the heights of the flights are exaggerated, by
 * relief level from 0 on, the last for every level beyond. Further out
 * than 10x the Alps stand as a wall across the map, and a level flight
 * saws up and down over the ridges: the ground it is measured against
 * follows the relief the map draws only to within about 100 m there (see
 * groundProfileFt), which the exaggeration multiplies, and at 10x that is
 * under a pixel. The flights are lifted as much, so the lift ramps down
 * from there as it did, to twice their height closer in.
 */
const EXAGGERATION_BY_LEVEL: readonly number[] = [
  10, 10, 10, 10, 10, 10, 10, 7, 4, 2,
];

/**
 * How much the relief and the heights of the flights are exaggerated at
 * the relief level `level` (see reliefLevel). The map adds the relief's
 * exaggerated elevation to a ribbon's own height, so a flight only stays
 * at its height over the ground it flew over where the two factors are
 * the same: the map takes one number for the relief, so both are one per
 * level, and switch together (see LayerManager.syncTerrain).
 */
export function liftExaggeration(level: number): number {
  const last = EXAGGERATION_BY_LEVEL.length - 1;
  return EXAGGERATION_BY_LEVEL[Math.min(Math.max(level, 0), last)]!;
}

/**
 * Whether the ribbons cut for the relief level `level` are known to the map
 * by an id (see ribbonId): those of a level next to one with another
 * exaggeration, which a zoom across one level switches them to (see
 * ribbonHeights). Every feature the map knows so costs the map a few bytes
 * in every tile it is in, and the flights zoomed out, the most of them, are
 * left out.
 */
export function switchesExaggeration(level: number): boolean {
  const own = liftExaggeration(level);
  return (
    liftExaggeration(level - 1) !== own || liftExaggeration(level + 1) !== own
  );
}

/**
 * Whether the ribbons cut for the relief level `cut` stay on the relief the
 * map draws for the level `level` until they are cut for it: with the same
 * exaggeration, or one they switch to (switchesExaggeration). Their ground
 * is that of the nearest level they carry (see GROUND_LEVELS).
 */
export function followsLevel(cut: number, level: number): boolean {
  return (
    liftExaggeration(cut) === liftExaggeration(level) ||
    switchesExaggeration(cut)
  );
}

/**
 * The id the map knows the ribbons cut for the relief level `level` by, in
 * the `epoch`-th visit of a level (LayerManager.ribbonEpoch): a feature
 * state for it reaches all of them, and them only (see ui/terrain.ts).
 * MapLibre keeps an entry for every id it was given a state for, and works
 * out the paint of every feature of such an id anew in each tile it loads,
 * which for a whole cut takes seconds on a slow machine; a cut of a later
 * visit has an id no state has been given.
 */
export function ribbonId(level: number, epoch: number): number {
  return level + (RELIEF_MAX_LEVEL + 1) * epoch;
}

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
 * By map zoom: the band of height a ribbon has, in metres, about three
 * pixels at every zoom. The flights are lifted at every zoom, the whole of
 * a long flight in view included, so the stops reach down to a map of half
 * of Europe.
 */
const BAND_STOPS: readonly (readonly [zoom: number, bandM: number])[] = [
  [4, 12000],
  [6, 3000],
  [7, 1900],
  [9, 480],
  [10, 200],
  [11, 110],
  [13, 28],
  [16, 6],
];

/**
 * The step the ground offsets of ribbons cut at the zoom `widthZoom` (see
 * ribbonWidthZoom) are rounded to, in feet: GROUND_OFFSET_STEP_FT, doubled
 * as long as it stays at most a quarter of a pixel in the middle of the
 * level, exaggerated as the level is. Rounding moves a ribbon by an eighth
 * of a pixel at most then, a quarter on the tiles of the next level in, and
 * over flat land most offsets round to nothing and are left out of the
 * features (see ribbonProperties), of which the map's worker holds hundreds
 * of thousands.
 */
export function groundOffsetStepFt(widthZoom: number): number {
  const quarterPxFt =
    metresPerPixel(widthZoom + 0.5) /
    4 /
    liftExaggeration(reliefLevel(widthZoom)) /
    FEET_TO_METERS;
  let step = GROUND_OFFSET_STEP_FT;
  while (step * 2 <= quarterPxFt) step *= 2;
  return step;
}

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
              reliefPixelM(level, segments[indices[0]!]!.coords?.[0][0] ?? 0),
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
  if (!sampled) {
    return { ground: groundProfileFt(segments, false), offsets: null };
  }
  // The levels of a cut are mostly those of the cut before, a level away
  let byLevel = sampledGround.get(segments);
  if (!byLevel) {
    sampledGround.set(segments, (byLevel = new Map<number, Float64Array>()));
  }
  const at = (wanted: number): Float64Array => {
    const clamped = Math.min(Math.max(wanted, 0), RELIEF_MAX_LEVEL);
    let profile = byLevel.get(clamped);
    if (!profile) {
      profile = groundProfileFt(segments, true, clamped);
      byLevel.set(clamped, profile);
    }
    return profile;
  };
  const ground = at(level);
  const offsets = GROUND_LEVELS.map((step) => {
    const other = at(level + step);
    return ground.map((feet, i) => feet - other[i]!);
  });
  return { ground, offsets };
}

/**
 * The sampled ground of the segments of a dataset by relief level, as
 * groundProfilesFt has worked it out: a dataset does not change while it
 * is on the map, and goes with it
 */
const sampledGround = new WeakMap<
  readonly PathSegment[],
  Map<number, Float64Array>
>();

/**
 * The levels whose ground a ribbon stands on, counted from the one it was
 * cut for, in order: the ones of GROUND_LEVELS, and that one itself, whose
 * ground is the one its height is above
 */
const STANDING_LEVELS = [...GROUND_LEVELS, 0].sort((a, b) => a - b);

/**
 * Which level's ground stands for the level `step` levels from the one cut
 * for: the first of STANDING_LEVELS at or above it, the last above them
 * all. The paint picks them alike (see ribbonHeights).
 */
function standingLevel(step: number): number {
  return (
    STANDING_LEVELS.find((level) => level >= step) ??
    STANDING_LEVELS[STANDING_LEVELS.length - 1]!
  );
}

/**
 * Of the ground offsets `offsets` of a point cut for the relief level
 * `cutLevel` (see GROUND_LEVELS), the one of the relief under a tile of the
 * map zoom `zoom`
 */
export function groundOffsetFt(
  offsets: ArrayLike<number> | undefined,
  cutLevel: number,
  zoom: number,
): number {
  const index = GROUND_LEVELS.indexOf(
    standingLevel(reliefLevel(zoom) - cutLevel),
  );
  return offsets && index >= 0 ? offsets[index]! : 0;
}

/**
 * The feet above the relief under a tile of the map zoom `zoom` of a point
 * `heightFt` above the ground of the relief level `cutLevel`, with the
 * ground offsets there (see groundOffsetFt), never below
 */
export function heightOnReliefFt(
  heightFt: number,
  offsets: ArrayLike<number> | undefined,
  cutLevel: number,
  zoom: number,
): number {
  return Math.max(heightFt + groundOffsetFt(offsets, cutLevel, zoom), 0);
}

/**
 * A point's feet above the ground of the relief level `level`, and the
 * ground of the levels around it there (see groundOffsetFt); a height of
 * null is none, where the flights are not lifted
 */
export interface GroundedHeight {
  heightFt: number | null;
  offsetsFt?: readonly number[] | undefined;
  level?: number | undefined;
}

/**
 * The feet above the relief under a tile of the map zoom `zoom` of a point
 * lifted as `point` says (see heightOnReliefFt), or null for none
 */
export function heightAtZoomFt(
  point: GroundedHeight,
  zoom: number,
): number | null {
  return point.heightFt === null
    ? null
    : heightOnReliefFt(
        point.heightFt,
        point.offsetsFt,
        point.level ?? reliefLevel(zoom),
        zoom,
      );
}

/** Metres flown to the end of each of the segments `indices` of a flight */
function alongMetres(
  segments: readonly PathSegment[],
  indices: readonly number[],
): Float64Array {
  const along = new Float64Array(indices.length);
  let total = 0;
  indices.forEach((index, i) => {
    const coords = segments[index]!.coords;
    if (coords) total += planarMetres(coords[0], coords[1]);
    along[i] = total;
  });
  return along;
}

/**
 * The metres a pixel spans at `lat` of the elevation tiles the ribbons of
 * the relief level `level` stand on. MapLibre raises a ribbon by the
 * relief under it from the tiles one level coarser than its own (a
 * raster-dem source's tiles are drawn at twice their size), so the ground
 * sampled at TERRAIN_TILE_MAX_ZOOM is theirs only from a level beyond.
 */
export function reliefPixelM(level: number, lat: number): number {
  const zoom = Math.min(level - 1, TERRAIN_TILE_MAX_ZOOM);
  return (
    (EARTH_CIRCUMFERENCE_M / (256 * 2 ** zoom)) *
    Math.cos(lat * DEGREES_TO_RADIANS)
  );
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
 * turns; a straight climb stays a straight slope. The ribbons take 8, the
 * flat lines 4 (see calculations/curves.ts).
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
  /**
   * With the ground of other levels (see SmoothOptions): the offsets of
   * each at every point, by level in the order of GROUND_LEVELS
   */
  offsets?: number[][];
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

/** How smoothLine smooths a line */
export interface SmoothOptions {
  /** Degrees of turn per point of the curve (see SMOOTH_TURN_DEG) */
  turnStepDeg?: number | undefined;
  /**
   * The ground under each point, in feet: the heights are altitudes then,
   * and the ground is taken off them after they are smoothed
   */
  ground?: readonly number[] | undefined;
  /**
   * The ground of the levels around the one of `ground` at each point, as
   * offsets to it (see groundProfilesFt), by level: they run along the
   * curve as the ground does
   */
  offsets?: readonly (readonly number[])[] | undefined;
}

/**
 * A line of `[lat, lng]` points with the feet above ground at each, drawn
 * as a smooth curve through its points: the logged positions stay where
 * they are, and a segment where the flight turns is cut into more points
 * along a spline through its neighbours; its heights change no faster
 * than MAX_SLOPE allows. The whole of a flight is smoothed at once, so the ribbons cut from it at its colour and height steps meet
 * in the same points and fit together without a seam.
 *
 * `turnStepDeg` is the turn per point of the curve. With `ground`, the
 * ground under each point, `heights` are altitudes, and
 * are smoothed and held to the slope as such before the ground is taken
 * off: a flight level over a ridge stays level, where its height above the
 * relief changes faster than any climb.
 */
export function smoothLine(
  points: readonly Coordinate[],
  heights: readonly number[],
  { turnStepDeg = SMOOTH_TURN_DEG, ground, offsets }: SmoothOptions = {},
): SmoothedLine {
  if (points.length === 0) return { points: [], heights: [], vertex: [] };
  // The ground at every point of the curve, straight between the given
  // ones, and the offsets of the other levels' as well
  const under = ground && [ground[0]!];
  const around = offsets?.map((level) => [level[0]!]);
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
      Math.max(Math.ceil(turn / turnStepDeg), 1),
      SMOOTH_MAX_STEPS,
    );
    for (let k = 1; k < steps; k++) {
      const [x, y] = catmullRom(p0, p1, p2, p3, k / steps);
      out.points.push([y! / METRES_PER_DEGREE, x! / scale / METRES_PER_DEGREE]);
      out.heights.push(smoothHeight(h0, h1, h2, h3, k / steps));
      under?.push(ground![i]! + ((ground![i + 1]! - ground![i]!) * k) / steps);
      around?.forEach((level, l) => {
        const given = offsets![l]!;
        level.push(given[i]! + ((given[i + 1]! - given[i]!) * k) / steps);
      });
    }
    out.points.push(points[i + 1]!);
    out.heights.push(h2);
    under?.push(ground![i + 1]!);
    around?.forEach((level, l) => level.push(offsets![l]![i + 1]!));
    out.vertex.push(out.points.length - 1);
  }
  limitSlope(out.points, out.heights);
  if (under) {
    out.heights = out.heights.map((feet, j) => liftFt(feet, under[j]!));
  }
  if (around) out.offsets = around;
  return out;
}

/**
 * Hold the heights of a line to MAX_SLOPE, from its start on: a height
 * that changes faster than that over the ground to the point before is
 * taken as far as the slope allows, and the line goes on from there
 */
function limitSlope(points: readonly Coordinate[], heights: number[]): void {
  for (let i = 1; i < points.length; i++) {
    const reach =
      planarMetres(points[i - 1]!, points[i]!) * METERS_TO_FEET * MAX_SLOPE;
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

/** How smoothFlights smooths the flights */
export interface SmoothFlightsOptions {
  /** Degrees of turn per point of the curve (see SMOOTH_TURN_DEG) */
  turnStepDeg?: number | undefined;
  /**
   * The ground under the end of a segment, in feet: `heightOf` gives
   * altitudes then (see SmoothOptions)
   */
  groundOf?: ((index: number) => number) | undefined;
  /**
   * With `groundOf`, the ground of the levels around its one under the end
   * of each segment, as offsets to it by level (see groundProfilesFt)
   */
  offsets?: readonly ArrayLike<number>[] | null | undefined;
}

/**
 * Smooth the flights of `segments`, the height of each point from
 * `heightOf`: the feet above ground a segment ends at, or with `groundOf`
 * its altitude, and the ground under it from that (see smoothLine). A
 * segment's altitude is the one at its end, so a chain's first point takes
 * the height of its first segment. `turnStepDeg` is the turn per point of
 * the curve (see SMOOTH_TURN_DEG).
 */
export function smoothFlights(
  segments: readonly {
    path_id: number;
    coords?: readonly [Coordinate, Coordinate] | undefined;
  }[],
  heightOf: (index: number) => number,
  { turnStepDeg, groundOf, offsets }: SmoothFlightsOptions = {},
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
    const ground = groundOf && [groundOf(i)];
    const around = groundOf && offsets?.map((level) => [level[i]!]);
    for (const m of members) {
      // Across the antimeridian the curve goes on past 180 rather than
      // round the world, through the spline points it would add there
      const end = segments[m]!.coords![1];
      const lng = unwrapLng(end[1], points[points.length - 1]![1]);
      points.push(lng === end[1] ? end : [end[0], lng]);
      heights.push(heightOf(m));
      ground?.push(groundOf!(m));
      around?.forEach((level, l) => level.push(offsets![l]![m]!));
    }
    const line = smoothLine(points, heights, {
      turnStepDeg,
      ground,
      offsets: around,
    });
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
    chain.offsets?.map((level) => level.slice(a, b + 1)),
  );
}

/** A piece of a ribbon: the quads it is made of, at one height step */
export interface RibbonPiece {
  /** Feet above the flight's ground: the height in the piece's middle */
  h: number;
  /**
   * The ground of the levels around the one of `h` in the piece's middle,
   * as offsets to it in the steps of groundOffsetStepFt, by level in the
   * order of GROUND_LEVELS; absent where the ground is the same at every
   * level
   */
  o?: number[];
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
 * `before` and `after`. `offsets` are the ground of the levels around the
 * one of `heights` at each point (see SmoothedLine), which each piece takes
 * along from its middle.
 */
export function ribbonPieces(
  points: readonly Coordinate[],
  heights: readonly number[],
  widthZoom: number,
  before?: Coordinate,
  after?: Coordinate,
  offsets?: readonly (readonly number[])[],
): RibbonPiece[] {
  const { left, right } = ribbonEdges(points, widthZoom, before, after);
  const pieces: RibbonPiece[] = [];
  const step = groundOffsetStepFt(widthZoom);
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
      const o = offsets?.map((level) => {
        const offset =
          level[i]! + ((level[i + 1]! - level[i]!) * (k + 0.5)) / count;
        // Without a negative zero, which JSON writes as a zero anyway
        return Math.round(offset / step) * step || 0;
      });
      const a = lerp(left[i]!, left[i + 1]!, t0);
      const b = lerp(left[i]!, left[i + 1]!, t1);
      const c = lerp(right[i]!, right[i + 1]!, t1);
      const d = lerp(right[i]!, right[i + 1]!, t0);
      const quad = [[a, b, c, d, a]];
      const last = pieces[pieces.length - 1];
      if (last?.h === h && sameOffsets(last.o, o)) {
        last.geometry.coordinates.push(quad);
      } else {
        pieces.push({
          h,
          ...(o && { o }),
          geometry: { type: "MultiPolygon", coordinates: [quad] },
        });
      }
    }
  }
  return pieces;
}

/** Whether two pieces stand on the same ground at every level */
function sameOffsets(
  a: readonly number[] | undefined,
  b: readonly number[] | undefined,
): boolean {
  return a === b || (!!a && !!b && a.every((offset, i) => offset === b[i]));
}

/** What a feature of a ribbon carries of its piece, see ribbonProperties */
export interface RibbonProperties {
  /** Feet above the ground of the level `l`, see RibbonPiece */
  h: number;
  /** The relief level the ribbon was cut for (see reliefLevel) */
  l: number;
  /**
   * The id the map knows the ribbon by (see ribbonId), where it switches
   * the exaggeration (see switchesExaggeration)
   */
  k?: number;
  /**
   * The ground of another level (see groundKey), where it is not the one
   * of `l`
   */
  [ground: `o${number}`]: number;
}

/**
 * The properties of the feature of a ribbon piece cut for the relief level
 * `level` in the `epoch`-th visit of a level: its height, the level, the id
 * where the map is to know the feature by one (see ribbonId), and the
 * ground of the levels around it where that is not the level's own: an
 * offset of zero is left out, and the paint takes a ground left out for the
 * one of the level (see ribbonHeights). Over flat land most pieces have
 * none.
 */
export function ribbonProperties(
  piece: RibbonPiece,
  level: number,
  epoch: number,
): RibbonProperties {
  const properties: RibbonProperties = {
    h: piece.h,
    l: level,
    ...(switchesExaggeration(level) && { k: ribbonId(level, epoch) }),
  };
  piece.o?.forEach((offset, k) => {
    if (offset !== 0) properties[groundKey(GROUND_LEVELS[k]!)] = offset;
  });
  return properties;
}

/**
 * The feet a ribbon's feature is drawn above the relief under a tile of
 * the map zoom `zoom`, from its properties (see ribbonProperties), as the
 * paint has it
 */
export function ribbonHeightFt(
  properties: Partial<RibbonProperties>,
  zoom: number,
): number {
  const { h = 0, l = reliefLevel(zoom) } = properties;
  return heightOnReliefFt(
    h,
    GROUND_LEVELS.map((step) => properties[groundKey(step)] ?? 0),
    l,
    zoom,
  );
}

/**
 * The feature state that gives the ribbons cut for another relief level
 * the exaggeration of the one the map is drawn for, see ribbonHeights
 */
export const EXAGGERATION_STATE = "e";

/** By map zoom: the band of height of a ribbon, in metres (BAND_STOPS) */
function bandM(zoom: number): number {
  const i = BAND_STOPS.findIndex(([stop]) => stop > zoom);
  if (i === 0) return BAND_STOPS[0]![1];
  if (i < 0) return BAND_STOPS[BAND_STOPS.length - 1]![1];
  const [z0, m0] = BAND_STOPS[i - 1]!;
  const [z1, m1] = BAND_STOPS[i]!;
  return m0 + ((m1 - m0) * (zoom - z0)) / (z1 - z0);
}

/** The exaggeration of the relief level `level` (liftExaggeration) */
function exaggerationOf(
  level: ExpressionSpecification,
): ExpressionSpecification {
  const stops = EXAGGERATION_BY_LEVEL.flatMap((factor, i) =>
    i > 0 && factor !== EXAGGERATION_BY_LEVEL[i - 1] ? [i, factor] : [],
  );
  return [
    "step",
    level,
    EXAGGERATION_BY_LEVEL[0]!,
    ...stops,
  ] as ExpressionSpecification;
}

/**
 * The feet to add to a ribbon's height to have it above the ground of the
 * relief level `level`, from the ground its feature carries: the one of
 * the nearest level it has (see standingLevel), and a ground it leaves out
 * the one it was cut on
 */
function groundOffsetAt(level: number): ExpressionSpecification {
  const step: ExpressionSpecification = ["-", level, ["get", "l"]];
  const offset = (standing: number): ExpressionSpecification | number =>
    standing === 0 ? 0 : ["coalesce", ["get", groundKey(standing)], 0];
  return [
    "case",
    ...STANDING_LEVELS.slice(0, -1).flatMap((standing) => [
      ["<=", step, standing],
      offset(standing),
    ]),
    offset(STANDING_LEVELS[STANDING_LEVELS.length - 1]!),
  ] as ExpressionSpecification;
}

/**
 * The paint of a ribbon's bottom and top, from the height `h` of its
 * feature, in feet above the ground of the relief level `l` it was cut
 * for, and the ground it carries of the levels around (see
 * ribbonProperties).
 *
 * MapLibre works out a paint that goes by zoom for each tile at the tile's
 * own zoom, and lifts the ribbons of a tile by the relief of that tile's
 * level. A step by zoom takes the ground of the tile's level, so a ribbon
 * stands on the relief under it whichever level's tiles the map draws: the
 * next level's while a zoom goes on, before the flights are cut for it as
 * it ends, and coarser ones in the distance of a tilted view. The band goes
 * by the tile's zoom, as the one of the middle of its level, as the width
 * does (see RIBBON_WIDTH_PX): an interpolation by zoom would mix the ground
 * of the tile's level with the next one's by the map's zoom. On the tiles
 * of a level further out than the one cut for, the distance of a tilted
 * view, it is the band of the next level in, as thin as an interpolation
 * made it there: MapLibre takes the value of the level after a tile's for
 * every map zoom past it.
 *
 * The exaggeration does not go by the tile: it is the relief's, one number
 * for the whole map, which switches as a zoom ends. A ribbon has the one of
 * the level it was cut for, and one of another level, still drawn while the
 * flights are cut for the new one, the new one from a feature state for its
 * id (EXAGGERATION_STATE, see ui/terrain.ts and ribbonId): the map applies
 * it to all of its tiles in the frame it switches the relief, where a new
 * paint would have them cut again one by one.
 */
export function ribbonHeights(): {
  base: ExpressionSpecification;
  height: ExpressionSpecification;
} {
  const exaggeration: ExpressionSpecification = [
    "coalesce",
    ["feature-state", EXAGGERATION_STATE],
    exaggerationOf(["get", "l"]),
  ];
  // A piece spans its step, half of it below its middle and half above, so
  // the pieces of a slope meet; the band goes on top of that
  const halfStep: ExpressionSpecification = [
    "*",
    exaggeration,
    (LIFT_STEP_FT / 2) * FEET_TO_METERS,
  ];
  const base: unknown[] = [];
  const height: unknown[] = [];
  for (let zoom = 0; zoom < LIFT_MAX_ZOOM; zoom++) {
    const level = reliefLevel(zoom);
    const metres: ExpressionSpecification = [
      "*",
      ["max", ["+", ["get", "h"], groundOffsetAt(level)], 0],
      ["*", exaggeration, FEET_TO_METERS],
    ];
    const band: ExpressionSpecification | number =
      level < RELIEF_MAX_LEVEL
        ? [
            "case",
            [">", ["get", "l"], level],
            bandM(zoom + 1),
            bandM(zoom + 0.5),
          ]
        : bandM(zoom + 0.5);
    // The first output is the one below the first stop
    if (zoom > 0) {
      base.push(zoom);
      height.push(zoom);
    }
    base.push(["max", ["-", metres, halfStep], 0]);
    height.push(["+", metres, halfStep, band]);
  }
  return {
    base: ["step", ["zoom"], ...base] as ExpressionSpecification,
    height: ["step", ["zoom"], ...height] as ExpressionSpecification,
  };
}

/**
 * How far up the screen a point `heightFt` above the ground is drawn, in
 * pixels: the height as the ribbons have it, exaggerated by `exaggeration`
 * (the one of the level the map is drawn for, see liftMetres), over the
 * metres a pixel spans at `zoom`, foreshortened by the tilt. Flat, a height
 * takes no room on the screen. MapLibre scales every extrusion by the
 * metres of a pixel at the map's centre, wherever the extrusion stands, so
 * `lat` is the centre's latitude (for a camera move, the one it ends at),
 * not the point's. An
 * approximation that leaves the perspective out, close enough to put the
 * airplane on its ribbon and to rank what is under the pointer.
 */
export function liftOffsetPx(
  map: MapLibreMap,
  lat: number,
  heightFt: number,
  exaggeration: number,
  zoom = map.getZoom(),
): number {
  const pitch = map.getPitch() * DEGREES_TO_RADIANS;
  const metresPerPx = metresPerPixel(zoom) * Math.cos(lat * DEGREES_TO_RADIANS);
  return (liftMetres(heightFt, exaggeration) / metresPerPx) * Math.sin(pitch);
}

/**
 * How high a point `heightFt` above the ground is drawn, in metres over
 * the ground under it: its height, exaggerated by `exaggeration` like the
 * ribbons' (see liftExaggeration). That is the one of the level the map
 * is drawn for (reliefLevel in the store), not of the zoom: while a zoom
 * crosses a level the ribbons and the relief keep the exaggeration of the
 * level before until it ends (see ribbonHeights).
 */
export function liftMetres(heightFt: number, exaggeration: number): number {
  return heightFt * FEET_TO_METERS * exaggeration;
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
  exaggeration: number,
  zoom = map.getZoom(),
): number {
  return heightFt === null || !isLiftedAt(zoom)
    ? 0
    : liftOffsetPx(map, lat, heightFt, exaggeration, zoom);
}
