/**
 * The heat lines: the flights as lines, each stretch of them telling how
 * long the aircraft spent around it.
 *
 * The heatmap hands over to them when zoomed in (see HEAT_LINES in
 * constants.ts), and they keep saying what it said: where the time was
 * spent. The heatmap counts fixes, which a logger writes at a steady pace,
 * so its density is time as well. Here the time is added up per cell of a
 * grid over the ground, and every stretch takes the time of the cells it
 * lies in. A taxiway, a holding point or a circuit flown every week come
 * out hot; a route flown once at cruise speed stays cool.
 */
import type { PathSegment } from "../types";
import { DEGREES_TO_RADIANS, METRES_PER_DEGREE } from "../utils/geometry";
import { toLngLat, type LngLatTuple } from "../utils/mapHelpers";
import { appendCurve, flatCurves } from "./curves";
import { segmentDistance } from "./statistics";

/**
 * Edge of a grid cell in metres. About the width of a taxiway: the tracks
 * of one taxi route fall into the same cells, those of the next taxiway
 * over do not.
 */
const HEAT_CELL_M = 40;
/**
 * A segment that took longer than this is a break in the log (the logger
 * paused, the aircraft stood with it switched off), not time spent on it
 */
const MAX_LOGGED_STEP_S = 600;
/** Most time one segment adds, so a long stand at one spot saturates */
const MAX_SEGMENT_S = 120;
const KNOTS_TO_METRES_PER_SECOND = 1852 / 3600;
/** Rows of the grid are numbered into one key with their column */
const ROW_STRIDE = 2 ** 22;
const COLUMN_OFFSET = 2 ** 21;

/**
 * How long a segment took. A segment's time is when it starts, so the time
 * of the next one of its path is when it ends. The last segment of a path,
 * and a track without times (a planned route, an old export), fall back to
 * its length at its groundspeed, and to no time at all without either.
 */
function segmentSeconds(
  segment: PathSegment,
  next: PathSegment | undefined,
): number {
  let seconds = -1;
  if (
    next?.path_id === segment.path_id &&
    segment.time !== undefined &&
    next.time !== undefined
  ) {
    seconds = next.time - segment.time;
  }
  if (seconds < 0 || seconds > MAX_LOGGED_STEP_S) {
    const knots = segment.groundspeed_knots;
    seconds =
      knots > 1
        ? (segmentDistance(segment) * 1000) /
          (knots * KNOTS_TO_METRES_PER_SECOND)
        : 0;
  }
  return Math.min(seconds, MAX_SEGMENT_S);
}

/** The cells of the grid: a row per `HEAT_CELL_M` of latitude */
const ROW_DEGREES = HEAT_CELL_M / METRES_PER_DEGREE;

function rowOf(lat: number): number {
  return Math.floor(lat / ROW_DEGREES);
}

/**
 * A column is `HEAT_CELL_M` wide at the middle of its row, so the cells
 * stay square from the equator to the north of Norway
 */
function columnOf(row: number, lng: number): number {
  let width = columnWidths.get(row);
  if (width === undefined) {
    const lat = (row + 0.5) * ROW_DEGREES;
    width = ROW_DEGREES / Math.cos(lat * DEGREES_TO_RADIANS);
    columnWidths.set(row, width);
  }
  return Math.floor(lng / width);
}

/** Width of the columns by row, in degrees: a row is met again and again */
const columnWidths = new Map<number, number>();

function cellKey(row: number, column: number): number {
  return row * ROW_STRIDE + column + COLUMN_OFFSET;
}

/**
 * The time spent around a point: the most any cell of the three by three
 * around its own holds. A fix a few metres off the line the others share
 * still counts as on it.
 */
function secondsAround(
  cells: Map<number, number>,
  [lat, lng]: [number, number],
): number {
  const row = rowOf(lat);
  const column = columnOf(row, lng);
  let most = 0;
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      const seconds = cells.get(cellKey(row + dr, column + dc)) ?? 0;
      if (seconds > most) most = seconds;
    }
  }
  return most;
}

/** The least heat a stretch is drawn with, in seconds */
const MIN_SECONDS = 0.5;
/**
 * Segments on either side of one that its heat is averaged over. The time
 * around a stretch jumps from cell to cell of the grid; rounded to steps as
 * it is, it made a busy band flicker between two shades. Five segments of
 * a flight in the air are about a kilometre, on the ground a few dozen
 * metres, both far less than a change of place the map has to show.
 */
const SMOOTHING_SEGMENTS = 2;

/**
 * The heat of each stretch, averaged (as a power of two, so a geometric
 * mean) over its neighbours along the same flight: `heats` by segment,
 * `joins` telling where a segment carries on the one before. A mean never
 * reaches across a gap in the log or into another flight.
 */
function smoothAlongFlights(
  heats: Float64Array,
  joins: Uint8Array,
): Float64Array {
  const smoothed = new Float64Array(heats.length);
  let runStart = 0;
  for (let index = 0; index <= heats.length; index++) {
    if (index < heats.length && (index === 0 || joins[index])) continue;
    // A run of joined segments ends before `index`
    for (let at = runStart; at < index; at++) {
      const from = Math.max(runStart, at - SMOOTHING_SEGMENTS);
      const to = Math.min(index - 1, at + SMOOTHING_SEGMENTS);
      let sum = 0;
      for (let i = from; i <= to; i++) sum += heats[i]!;
      smoothed[at] = sum / (to - from + 1);
    }
    runStart = index;
  }
  return smoothed;
}

/**
 * The content of the heat line source: the flights `keep` accepts, `[lng,
 * lat]`, as lines with the seconds spent around them as `heat`.
 *
 * Every segment's time goes half to the cell of each end. A segment then
 * takes the lesser of the time around its two ends: one that only crosses
 * a busy place (a departure across the runway) is not drawn as busy along
 * its whole length. Only the kept flights count, so a filter recolours the
 * lines the way it redraws the heatmap.
 *
 * The heat is then smoothed along each flight and rounded to a power of
 * two, so that neighbouring segments of about the same heat merge into one
 * line: far fewer features for the map's worker than one per segment. That
 * is two steps per stop of the colour ramp, which the eye does not tell
 * apart on a line. The lines run along the curve through the fixes (see
 * calculations/curves.ts), the way the colour lines do; the time is added
 * up at the fixes, where it was logged.
 */
export function heatLineFeatures(
  segments: readonly PathSegment[],
  keep: (pathId: number) => boolean,
): GeoJSON.FeatureCollection<GeoJSON.LineString, { heat: number }> {
  const kept: PathSegment[] = [];
  /** Where each kept segment is in `segments`, and so on its curve */
  const keptIndex: number[] = [];
  const cells = new Map<number, number>();
  const addTo = ([lat, lng]: [number, number], seconds: number): void => {
    const row = rowOf(lat);
    const key = cellKey(row, columnOf(row, lng));
    cells.set(key, (cells.get(key) ?? 0) + seconds);
  };

  segments.forEach((segment, index) => {
    if (!keep(segment.path_id)) return;
    const seconds = segmentSeconds(segment, segments[index + 1]);
    addTo(segment.coords[0], seconds / 2);
    addTo(segment.coords[1], seconds / 2);
    kept.push(segment);
    keptIndex.push(index);
  });

  // The heat of every kept segment, as a power of two, and whether it
  // carries on the one before (same flight, no gap in the log)
  const heats = new Float64Array(kept.length);
  const joins = new Uint8Array(kept.length);
  // The end of one segment is the start of the next: look it up once
  let lastEndSeconds = 0;
  kept.forEach((segment, index) => {
    const [start, end] = segment.coords;
    const last = index > 0 ? kept[index - 1]! : null;
    const lastEnd = last?.coords[1];
    const carriesOn =
      last?.path_id === segment.path_id &&
      lastEnd?.[0] === start[0] &&
      lastEnd[1] === start[1];
    joins[index] = carriesOn ? 1 : 0;
    const startSeconds = carriesOn
      ? lastEndSeconds
      : secondsAround(cells, start);
    lastEndSeconds = secondsAround(cells, end);
    heats[index] = Math.log2(
      Math.max(Math.min(startSeconds, lastEndSeconds), MIN_SECONDS),
    );
  });

  const smoothed = smoothAlongFlights(heats, joins);

  const curves = flatCurves(segments);
  const features: GeoJSON.Feature<GeoJSON.LineString, { heat: number }>[] = [];
  let line: LngLatTuple[] = [];
  let lineStep = 0;
  const flush = (): void => {
    if (line.length >= 2) {
      features.push({
        type: "Feature",
        properties: { heat: 2 ** lineStep },
        geometry: { type: "LineString", coordinates: line },
      });
    }
    line = [];
  };

  kept.forEach((segment, index) => {
    const step = Math.round(smoothed[index]!);
    if (!joins[index] || step !== lineStep) {
      flush();
      line.push(toLngLat(segment.coords[0]));
      lineStep = step;
    }
    appendCurve(line, curves, keptIndex[index]!);
  });
  flush();

  return { type: "FeatureCollection", features };
}
