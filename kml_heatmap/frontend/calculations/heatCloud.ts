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
 */
import type { PathSegment } from "../types";
import {
  DEGREES_TO_RADIANS,
  metresPerPixel,
  planarMetres,
  type Coordinate,
} from "../utils/geometry";
import { FEET_TO_METERS } from "../utils/constants";
import { segmentSeconds } from "./heatLines";
import { liftExaggeration } from "./lift";
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

/** The floats of a point of the cloud: x, y, ground, lift and heat */
export const CLOUD_POINT_FLOATS = 5;

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
 *   and the stretch from it to the next flight's first is not drawn.
 */
export interface CloudPoints {
  points: Float32Array;
  /** The number of points, without the two around them */
  count: number;
  /** The Mercator point the points are given from */
  origin: readonly [number, number];
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
 * the curve it is merged from.
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
      const heightAt = (j: number): number => (ground?.[j] ?? 0) + heights[j]!;
      let along = 0;
      let heat = 0;
      let keptFt = heightAt(0);
      const push = (j: number): void => {
        const [x, y] = mercatorOf(points[j]!);
        west = Math.min(west, x);
        east = Math.max(east, x);
        north = Math.min(north, y);
        south = Math.max(south, y);
        values.push(x, y, ground?.[j] ?? 0, heights[j]!, 0);
        keptFt = heightAt(j);
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
          values[values.length - 1] = Math.max(heat, MIN_HEAT_S);
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
  for (let k = 0; k < values.length; k += CLOUD_POINT_FLOATS) {
    const at = k + CLOUD_POINT_FLOATS;
    points[at] = values[k]! - origin[0];
    points[at + 1] = values[k + 1]! - origin[1];
    points[at + 2] = values[k + 2]!;
    points[at + 3] = values[k + 3]!;
    points[at + 4] = values[k + 4]!;
  }
  return { points, count: values.length / CLOUD_POINT_FLOATS, origin };
}
