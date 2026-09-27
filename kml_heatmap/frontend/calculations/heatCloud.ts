/**
 * The heat of the 3D view as a cloud in the air: the flights the heatmap
 * shows, along the curves the ribbons are cut from, as the points of a line
 * that the cloud's layer draws as a soft glow (see ui/heatCloudLayer.ts).
 * This module is the data: which points of the curves, where and how high,
 * and how much heat each stretch between two of them carries: the seconds
 * spent on it, as the heat lines count them (segmentSeconds). The heatmap
 * counts fixes, which a logger writes at a steady pace, but not every
 * logger does: one that writes a fix per turn or per change of speed left
 * a straight cruise in beads of light and dark.
 *
 * The curves and their heights are the ribbons' (smoothing.ts, lift.ts):
 * each flight smoothed through its fixes, at its altitude above the ground
 * of its flight at the relief level the map is drawn for, never below it,
 * and on the relief the ground itself under that (see groundedFlights,
 * which both take them from). The ribbons stand on the relief MapLibre
 * draws, which that ground follows to within a pixel at every level (see
 * groundProfileFt); the cloud stands on the ground, since a custom layer
 * cannot ask the map for its relief.
 *
 * Each point also carries the time into its flight it was flown at, which
 * the pulses of the layer run along, and the heat is added up in coarse
 * cells on the way, for the exposure the layer draws the cloud with.
 */
import type { PathSegment } from "../types";
import {
  DEGREES_TO_RADIANS,
  metresPerPixel,
  planarMetres,
  TILE_SIZE_PX,
  type Coordinate,
} from "../utils/geometry";
import { FEET_TO_METERS } from "../utils/constants";
import { segmentSeconds } from "./heatLines";
import { liftExaggeration } from "./lift";
import { chainTimes, flightClockOf } from "./flightClock";
import type { SmoothedFlights } from "./smoothing";

/**
 * The points of a flight's curve are kept this many pixels apart at most,
 * in the middle of the relief level the cloud is cut for: closer ones are
 * merged into the stretch between the ones kept, and their heat with it.
 * The glow of a stretch is wider (see CLOUD_STOPS in
 * ui/heatCloudLayer.ts), so a stretch is a chord of the curve that no one
 * tells from it, and zoomed out a year's flights are a few thousand
 * stretches instead of a hundred thousand.
 */
export const CLOUD_STEP_PX = 6;

/**
 * A fix is kept as well where the height of the track has changed by this
 * many pixels since the last one kept, exaggerated as the level is, so a
 * climb stays a climb and does not turn into a slope to the next fix kept.
 */
const CLOUD_HEIGHT_STEP_PX = 1;

/** The least heat a stretch carries, in seconds */
const MIN_HEAT_S = 0.01;

/**
 * The cells the heat is added up in for the exposure of the cloud (see
 * CloudPoints.busiest), this many pixels wide in the middle of the relief
 * level: about as wide as the glow of a stretch (see CLOUD_STOPS in
 * ui/heatCloudLayer.ts), so the heat of a cell is about what glows on its
 * brightest pixels
 */
const CLOUD_CELL_PX = 16;

/** The part of the cells of heat that are less busy than CloudPoints.busiest */
const CLOUD_BUSIEST_PERCENTILE = 0.99;

/** The floats of a point of the cloud: x, y, ground, lift, heat and time */
export const CLOUD_POINT_FLOATS = 6;

/**
 * The points of the cloud, one after the other along each flight, with a
 * point of no heat before the first and after the last, so the layer can
 * read the points on either side of every stretch (see
 * ui/heatCloudLayer.ts). Each is `CLOUD_POINT_FLOATS` floats:
 * - x and y in Mercator units (the world is 0 to 1), from `origin`, so a
 *   32-bit float holds them to a fraction of a pixel at every zoom the map
 *   has;
 * - the ground under the point, in feet (see groundProfilesFt);
 * - its height above that ground, in feet, never below 0 (see liftFt);
 * - the heat of the stretch from it to the next point: the seconds spent
 *   on the segments merged into it. The last point of a flight has none,
 *   and the stretch from it to the next flight's first is not drawn;
 * - its time: the seconds into its flight at which it was flown, by the
 *   clock replay all plays the flights by (see flightClock), from 0 at the
 *   flight's first fix and on across a gap in its log, so the pulses run
 *   the way the flight went, in step with replay all.
 */
export interface CloudPoints {
  points: Float32Array;
  /** The number of points, without the two around them */
  count: number;
  /** The Mercator point the points are given from */
  origin: readonly [number, number];
  /**
   * The heat per metre where the cloud is busiest: of the cells of
   * CLOUD_CELL_PX the heat of the stretches in them is added up in, the
   * one CLOUD_BUSIEST_PERCENTILE of the others are below, its heat over
   * its width, in seconds per metre; 0 without any. The layer sets its
   * exposure by it (see cloudExposure in ui/heatCloudLayer.ts).
   */
  busiest: number;
}

/** The Mercator x and y (0 to 1) of a `[lat, lng]` point */
export function mercatorOf([lat, lng]: Readonly<Coordinate>): [number, number] {
  const sin = Math.sin(lat * DEGREES_TO_RADIANS);
  return [
    (lng + 180) / 360,
    0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI),
  ];
}

/**
 * The points of the cloud of the flights `keep` accepts, along their curves
 * `flights`, smoothed on their ground at the relief level `level` (see
 * groundedFlights): the curve the ribbons are cut from, at the heights
 * they have, so the cloud lies on them. A point of the curve is kept where
 * it is CLOUD_STEP_PX on from the last one kept, or its height has changed
 * by CLOUD_HEIGHT_STEP_PX, and at either end of a flight. The seconds of a
 * segment (segmentSeconds) are spread over the stretches of the curve
 * along it by their length, and a stretch of the cloud carries those of
 * the curve it is merged from, and the time its first point was flown at.
 */
export function cloudPoints(
  segments: readonly PathSegment[],
  flights: SmoothedFlights,
  keep: (pathId: number) => boolean,
  level: number,
): CloudPoints {
  const exaggeration = liftExaggeration(level);
  const values: number[] = [];
  let west = Infinity;
  let east = -Infinity;
  let north = Infinity;
  let south = -Infinity;
  const { chains, chainOf, from, to } = flights;
  const count = segments.length;
  // The cells of heat, in Mercator units, and the heat per metre in each
  const cell = CLOUD_CELL_PX / (TILE_SIZE_PX * 2 ** (level + 0.5));
  const cells = new Map<number, number>();
  // The time of the points, as replay all plays them
  const clock = flightClockOf(segments);
  let i = 0;
  while (i < count) {
    // The segments of the chain of `i`, one after the other
    let end = i + 1;
    while (end < count && chainOf[end] === chainOf[i]) end++;
    const chain = chains[chainOf[i]!];
    if (chain && chain.points.length > 1 && keep(segments[i]!.path_id)) {
      const { points, heights, ground } = chain;
      const [lat] = points[0]!;
      const pixelM =
        metresPerPixel(level + 0.5) * Math.cos(lat * DEGREES_TO_RADIANS);
      const stepM = CLOUD_STEP_PX * pixelM;
      const cellM = CLOUD_CELL_PX * pixelM;
      const heightStepFt =
        (CLOUD_HEIGHT_STEP_PX * pixelM) / exaggeration / FEET_TO_METERS;
      // The seconds of each stretch of the curve, from its segment's
      const seconds = new Float64Array(points.length);
      const lengths = new Float64Array(points.length);
      for (let m = i; m < end; m++) {
        let total = 0;
        for (let j = from[m]! + 1; j <= to[m]!; j++) {
          lengths[j] = planarMetres(points[j - 1]!, points[j]!);
          total += lengths[j]!;
        }
        const spent = segmentSeconds(segments[m]!, segments[m + 1]);
        const pieces = to[m]! - from[m]!;
        for (let j = from[m]! + 1; j <= to[m]!; j++) {
          seconds[j] =
            total > 0 ? (spent * lengths[j]!) / total : spent / pieces;
        }
      }
      const times = chainTimes(flights, clock, i, end, lengths);
      const heightAt = (j: number): number => (ground?.[j] ?? 0) + heights[j]!;
      let along = 0;
      let heat = 0;
      let keptFt = heightAt(0);
      let keptX = 0;
      let keptY = 0;
      const push = (j: number): void => {
        const [x, y] = mercatorOf(points[j]!);
        west = Math.min(west, x);
        east = Math.max(east, x);
        north = Math.min(north, y);
        south = Math.max(south, y);
        values.push(x, y, ground?.[j] ?? 0, heights[j]!, 0, times[j]!);
        keptFt = heightAt(j);
        keptX = x;
        keptY = y;
      };
      push(0);
      const last = points.length - 1;
      for (let j = 1; j <= last; j++) {
        along += lengths[j]!;
        heat += seconds[j]!;
        if (
          j === last ||
          along >= stepM ||
          Math.abs(heightAt(j) - keptFt) >= heightStepFt
        ) {
          // The heat of the stretch goes on the point it starts from; a
          // stretch of none (a track without times or speeds) gets a trace,
          // since none is no stretch at all to the layer
          const stretch = Math.max(heat, MIN_HEAT_S);
          values[values.length - 2] = stretch;
          // Into the cell it starts in, over as many metres as it spans
          const key =
            Math.floor(keptX / cell) * 2 ** 26 + Math.floor(keptY / cell);
          cells.set(
            key,
            (cells.get(key) ?? 0) + stretch / Math.max(along, cellM),
          );
          push(j);
          along = 0;
          heat = 0;
        }
      }
    }
    i = end;
  }
  const origin: [number, number] =
    values.length > 0 ? [(west + east) / 2, (north + south) / 2] : [0.5, 0.5];
  const points = new Float32Array(values.length + 2 * CLOUD_POINT_FLOATS);
  points.set(values, CLOUD_POINT_FLOATS);
  for (let k = 0; k < values.length; k += CLOUD_POINT_FLOATS) {
    points[k + CLOUD_POINT_FLOATS] = values[k]! - origin[0];
    points[k + CLOUD_POINT_FLOATS + 1] = values[k + 1]! - origin[1];
  }
  const busy = Float64Array.from(cells.values());
  return {
    points,
    count: values.length / CLOUD_POINT_FLOATS,
    origin,
    busiest:
      busy.length > 0
        ? nthSmallest(
            busy,
            Math.floor(CLOUD_BUSIEST_PERCENTILE * (busy.length - 1)),
          )
        : 0,
  };
}

/**
 * The value that would be at `n` (from 0) of `values` sorted, which it
 * reorders: Hoare's selection, since sorting every cell of the cloud for
 * one of them was a third of the work of cloudPoints
 */
export function nthSmallest(values: Float64Array, n: number): number {
  let low = 0;
  let high = values.length - 1;
  while (low < high) {
    const pivot = values[(low + high) >>> 1]!;
    let i = low;
    let j = high;
    while (i <= j) {
      while (values[i]! < pivot) i++;
      while (values[j]! > pivot) j--;
      if (i <= j) {
        const swap = values[i]!;
        values[i++] = values[j]!;
        values[j--] = swap;
      }
    }
    // Below j none is greater than the pivot, from i none is less, and
    // between the two all are the pivot
    if (n <= j) high = j;
    else if (n >= i) low = i;
    else return pivot;
  }
  return values[n]!;
}
