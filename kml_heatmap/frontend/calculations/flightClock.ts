/**
 * The clock of every flight: how many seconds into its flight each segment
 * starts, and each point of the curve it is drawn along. Replay of all
 * flights (ui/replayAll.ts) plays every flight from its own first fix at
 * once, so the only clock it needs is the one each flight carries, never
 * the date or the hour it was flown.
 *
 * A logged flight keeps its logged seconds. A break in the log (the logger
 * paused, the aircraft stood with it switched off), a track without times
 * (a planned route, an old export) and the last segment of a flight take
 * their length at their groundspeed instead, as the heat lines count them
 * (segmentSeconds), and a segment with neither takes no time at all. The
 * heat stops counting at two minutes a segment, so a long stand does not
 * outshine the rest; a clock that did would fly a long leg in two minutes,
 * and it stops at MAX_CLOCK_STEP_S instead. The heat cloud's flow
 * animation wants the same seconds along the same curves; the two share
 * this module.
 */
import type { PathSegment } from "../types";
import type { SmoothedFlights } from "./smoothing";
import { planarMetres } from "../utils/geometry";
import { segmentSeconds } from "./heatLines";

/**
 * A logged step longer than this is a break in the log rather than time
 * spent flying, as for the heat lines (MAX_LOGGED_STEP_S in heatLines.ts)
 */
const MAX_CLOCK_STEP_S = 600;

/** The clock of the segments of a dataset, see flightClock */
export interface FlightClock {
  /** Per segment: the seconds into its flight at its start */
  start: Float64Array;
  /** Per segment: the seconds it took */
  spent: Float64Array;
  /** Per flight (path id): the seconds from its first fix to its last */
  duration: Map<number, number>;
}

/**
 * The seconds each segment of `segments` took and how far into its flight
 * it starts. A segment's time is when it starts, so the time of the next
 * one of its flight is when it ends; the segments of a flight need not be
 * next to each other.
 */
export function flightClock(segments: readonly PathSegment[]): FlightClock {
  const count = segments.length;
  const start = new Float64Array(count);
  const spent = new Float64Array(count);
  const duration = new Map<number, number>();
  const last = new Map<number, number>();
  // The next segment of the same flight, for every segment
  const next = new Int32Array(count).fill(-1);
  for (let i = 0; i < count; i++) {
    const pathId = segments[i]!.path_id;
    const before = last.get(pathId);
    if (before !== undefined) next[before] = i;
    last.set(pathId, i);
  }
  for (let i = 0; i < count; i++) {
    const segment = segments[i]!;
    const after = segments[next[i]!];
    let seconds = -1;
    if (after && segment.time !== undefined && after.time !== undefined) {
      seconds = after.time - segment.time;
    }
    if (seconds < 0 || seconds > MAX_CLOCK_STEP_S) {
      // Its length at its groundspeed: segmentSeconds without a next one
      seconds = segmentSeconds(segment, undefined, MAX_CLOCK_STEP_S);
    }
    const pathId = segment.path_id;
    const at = duration.get(pathId) ?? 0;
    start[i] = at;
    spent[i] = seconds;
    duration.set(pathId, at + seconds);
  }
  return { start, spent, duration };
}

/**
 * The seconds into its flight at each point of the curve of the chain the
 * segments `first` to `end` (exclusive) are smoothed into (see
 * smoothFlights): a point between two fixes is as far into its segment's
 * time as it is along its piece of the curve.
 */
export function chainTimes(
  flights: SmoothedFlights,
  clock: FlightClock,
  first: number,
  end: number,
): Float64Array {
  const { chains, chainOf, from, to } = flights;
  const points = chains[chainOf[first]!]!.points;
  const times = new Float64Array(points.length);
  for (let m = first; m < end; m++) {
    const a = from[m]!;
    const b = to[m]!;
    const begins = clock.start[m]!;
    const spent = clock.spent[m]!;
    times[a] = begins;
    let total = 0;
    for (let j = a + 1; j <= b; j++) {
      total += planarMetres(points[j - 1]!, points[j]!);
    }
    let along = 0;
    for (let j = a + 1; j <= b; j++) {
      along += planarMetres(points[j - 1]!, points[j]!);
      times[j] =
        begins + spent * (total > 0 ? along / total : (j - a) / (b - a));
    }
  }
  return times;
}
