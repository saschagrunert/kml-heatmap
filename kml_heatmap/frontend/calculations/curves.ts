/**
 * The flights drawn flat on the map, along a curve through their fixes.
 *
 * A logger writes a fix every few seconds: some 200 metres apart in
 * cruise, and 80 in a turn, where the heading changes by ten degrees from
 * one to the next. Drawn straight from fix to fix, a turn is a polygon
 * once zoomed in. The colour lines, the heat lines, the selection's lines
 * and the replay all draw the curve of calculations/lift.ts through the
 * same fixes instead, cut into more points where the flight turns, so they
 * lie on top of each other. The fixes stay where they are: a colour still
 * changes at a fix, and every point of the curve belongs to the segment it
 * lies on.
 */
import type { PathSegment } from "../types";
import { toLngLatAfter, type LngLatTuple } from "../utils/mapHelpers";
import { smoothFlights, type SmoothedFlights } from "./lift";

/**
 * Degrees of turn per point of the curve. The ribbons of the 3D view take
 * eight (see lift.ts), which left the corners of a gentle turn to be seen
 * on a flat line at zoom 16.
 */
export const FLAT_TURN_STEP_DEG = 4;

/** The curves of a segment array, worked out once for it */
const curvesOf = new WeakMap<readonly PathSegment[], SmoothedFlights>();

/**
 * Every flight of `segments` along its curve, flat. Kept for the array it
 * was worked out for: the data of a year does not change while it is on
 * the map, and the colour lines and the heat lines draw the same one.
 */
export function flatCurves(segments: readonly PathSegment[]): SmoothedFlights {
  let curves = curvesOf.get(segments);
  if (!curves) {
    curves = smoothFlights(segments, () => 0, {
      turnStepDeg: FLAT_TURN_STEP_DEG,
    });
    curvesOf.set(segments, curves);
  }
  return curves;
}

/**
 * Carry `line`, which ends where the segment at `index` starts, on to its
 * end along the curve, each point in the copy of the world of the one
 * before (see toLngLatAfter)
 */
export function appendCurve(
  line: LngLatTuple[],
  curves: SmoothedFlights,
  index: number,
): void {
  const chain = curves.chains[curves.chainOf[index]!];
  if (!chain) return;
  for (let i = curves.from[index]! + 1; i <= curves.to[index]!; i++) {
    line.push(toLngLatAfter(chain.points[i]!, line[line.length - 1]));
  }
}
