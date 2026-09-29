/**
 * The flights of the replay of all flights (ui/replayAll.ts) as the points
 * its layer draws (ui/replayAllLayer.ts): every flight's curve, uploaded
 * once with the seconds into its flight at each point (flightClock.ts), so
 * a frame only tells the layer the time. The curves and their heights are
 * the ones the ribbons and the heat cloud are cut from (groundedFlights),
 * thinned as the heat cloud thins them (CLOUD_STEP_PX): a year of flights
 * is some 150,000 points, which a phone cannot draw every frame, and a few
 * thousand zoomed out.
 */
import type { PathSegment } from "../types";
import {
  DEGREES_TO_RADIANS,
  metresPerPixel,
  planarMetres,
} from "../utils/geometry";
import { FEET_TO_METERS } from "../utils/constants";
import { chainPieces, type FlightClock } from "./flightClock";
import { mercatorOf } from "./heatCloud";
import { liftExaggeration } from "./lift";
import type { SmoothedFlights } from "./smoothing";

/**
 * The points of a flight's curve are kept this many pixels apart at most,
 * at the middle of the zoom level they are cut for; closer ones are merged
 * into the stretch between the ones kept, and the airplane moves along
 * that stretch in the time of all of them. A trail is narrower than the
 * cloud's glow, so it keeps its points closer.
 */
const REPLAY_ALL_STEP_PX = 4;

/** A point is kept as well where the height has changed by this many pixels */
const HEIGHT_STEP_PX = 1;

/** A flight shorter than this has no clock to play by, and sits out */
const MIN_FLIGHT_S = 1;

/**
 * The floats of a point: x, y, ground, lift, the seconds into its flight,
 * and 1 where the stretch to the next point is drawn (0 at the last point
 * of a curve)
 */
export const REPLAY_ALL_POINT_FLOATS = 6;

/** The points of the replay of all flights, see replayAllPoints */
export interface ReplayAllPoints {
  /**
   * `REPLAY_ALL_POINT_FLOATS` floats per point, one curve after the other:
   * x and y in Mercator units from `origin`, the ground under the point
   * and the height above it in feet (as for the heat cloud, see
   * CloudPoints), the seconds into its flight, and whether it joins the
   * next point
   */
  points: Float32Array;
  /** The number of points */
  count: number;
  /** The Mercator point the points are given from */
  origin: readonly [number, number];
  /** The seconds of the longest flight: when the last one has landed */
  duration: number;
  /** The flights among the points */
  flights: number;
  /** West, south, east and north of the points in degrees, null for none */
  bounds: [number, number, number, number] | null;
}

/**
 * The points of the flights `keep` accepts, along their curves `flights`
 * (see groundedFlights) with the clock `clock` of their segments. A point
 * of a curve is kept where it is REPLAY_ALL_STEP_PX on from the last one
 * kept at the middle of the zoom level `detail`, where its height has
 * changed by HEIGHT_STEP_PX as exaggerated at the relief level `level`,
 * and at either end of a curve. A flight whose clock is shorter than
 * MIN_FLIGHT_S (no times and no speeds) sits out.
 */
export function replayAllPoints(
  segments: readonly PathSegment[],
  flights: SmoothedFlights,
  clock: FlightClock,
  keep: (pathId: number) => boolean,
  detail: number,
  level: number,
): ReplayAllPoints {
  const exaggeration = liftExaggeration(level);
  const values: number[] = [];
  const played = new Set<number>();
  let duration = 0;
  let west = Infinity;
  let east = -Infinity;
  let south = Infinity;
  let north = -Infinity;
  const { chains, chainOf } = flights;
  const count = segments.length;
  let i = 0;
  while (i < count) {
    let end = i + 1;
    while (end < count && chainOf[end] === chainOf[i]) end++;
    const chain = chains[chainOf[i]!];
    const pathId = segments[i]!.path_id;
    const seconds = clock.duration.get(pathId) ?? 0;
    if (
      chain &&
      chain.points.length > 1 &&
      seconds >= MIN_FLIGHT_S &&
      keep(pathId)
    ) {
      played.add(pathId);
      duration = Math.max(duration, seconds);
      const { points, heights, ground } = chain;
      const { times } = chainPieces(segments, flights, i, end, clock);
      const pixelM =
        metresPerPixel(detail + 0.5) *
        Math.cos(points[0]![0] * DEGREES_TO_RADIANS);
      const stepM = REPLAY_ALL_STEP_PX * pixelM;
      const heightStepFt =
        (HEIGHT_STEP_PX * pixelM) / exaggeration / FEET_TO_METERS;
      const heightAt = (j: number): number => (ground?.[j] ?? 0) + heights[j]!;
      let keptFt = heightAt(0);
      let along = 0;
      const push = (j: number, joins: number): void => {
        const [lat, lng] = points[j]!;
        west = Math.min(west, lng);
        east = Math.max(east, lng);
        south = Math.min(south, lat);
        north = Math.max(north, lat);
        const [x, y] = mercatorOf(points[j]!);
        values.push(x, y, ground?.[j] ?? 0, heights[j]!, times[j]!, joins);
        keptFt = heightAt(j);
      };
      push(0, 1);
      const last = points.length - 1;
      for (let j = 1; j <= last; j++) {
        along += planarMetres(points[j - 1]!, points[j]!);
        if (
          j === last ||
          along >= stepM ||
          Math.abs(heightAt(j) - keptFt) >= heightStepFt
        ) {
          push(j, j === last ? 0 : 1);
          along = 0;
        }
      }
    }
    i = end;
  }
  const size = REPLAY_ALL_POINT_FLOATS;
  const total = values.length / size;
  let origin: [number, number] = [0.5, 0.5];
  if (total > 0) {
    const [x0, y0] = mercatorOf([north, west]);
    const [x1, y1] = mercatorOf([south, east]);
    origin = [(x0 + x1) / 2, (y0 + y1) / 2];
  }
  const points = new Float32Array(values.length);
  for (let k = 0; k < values.length; k += size) {
    points[k] = values[k]! - origin[0];
    points[k + 1] = values[k + 1]! - origin[1];
    for (let f = 2; f < size; f++) points[k + f] = values[k + f]!;
  }
  return {
    points,
    count: total,
    origin,
    duration,
    flights: played.size,
    bounds: total > 0 ? [west, south, east, north] : null,
  };
}
