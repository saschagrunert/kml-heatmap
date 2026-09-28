/**
 * Where a year's flights went that no flight of an earlier year did: the
 * ground cut into cells of about a square kilometre, and the cells each
 * set of flights passed over. The heatmap draws the places of a year in
 * cells no earlier year visited in warm colours (see ui/newAreas.ts), and
 * Wrapped counts them as the airspace new that year.
 *
 * A kilometre is coarse on purpose: a route flown a few hundred metres
 * beside last year's is the same country seen again, not new ground.
 *
 * The app and both lazy bundles reach this module (the data manager counts
 * the area for Wrapped, see DataManager.newAreaKm2, and the feature bundle
 * draws the places), so it is part of the shared chunk: see features.ts.
 */
import type { KMLDataset, PathSegment } from "../types";
import {
  DEGREES_TO_RADIANS,
  METRES_PER_DEGREE,
  type Coordinate,
} from "../utils/geometry";
import { segmentDistance } from "./statistics";

/** Edge of a cell in metres */
const CELL_M = 1000;
/** The area of a cell in square kilometres */
export const CELL_KM2 = (CELL_M / 1000) ** 2;
/** A row of cells per `CELL_M` of latitude */
const ROW_DEGREES = CELL_M / METRES_PER_DEGREE;
/** Rows are numbered into one key with their column */
const ROW_STRIDE = 2 ** 22;
const COLUMN_OFFSET = 2 ** 21;

/**
 * The cell of a `[lat, lng]` point, as a number. A column is `CELL_M` wide
 * at the middle of its row, so the cells stay about square at every
 * latitude and each is about CELL_KM2.
 */
export function cellOf([lat, lng]: Readonly<Coordinate>): number {
  const row = Math.floor(lat / ROW_DEGREES);
  const width =
    ROW_DEGREES / Math.cos((row + 0.5) * ROW_DEGREES * DEGREES_TO_RADIANS);
  return row * ROW_STRIDE + Math.floor(lng / width) + COLUMN_OFFSET;
}

/**
 * The cells `segments` pass over. A segment is sampled every half a cell
 * along its length, so one whose fixes are far apart (a planned route, a
 * slow logger) leaves out none of the cells between them.
 */
export function visitedCells(segments: readonly PathSegment[]): Set<number> {
  const cells = new Set<number>();
  for (const segment of segments) {
    const [[lat0, lng0], [lat1, lng1]] = segment.coords;
    const steps = Math.ceil((segmentDistance(segment) * 2000) / CELL_M);
    for (let step = 0; step <= steps; step++) {
      const along = steps > 0 ? step / steps : 0;
      cells.add(
        cellOf([lat0 + (lat1 - lat0) * along, lng0 + (lng1 - lng0) * along]),
      );
    }
  }
  return cells;
}

/** The cells of each dataset, worked out the first time they are asked for */
const cellsOfDataset = new WeakMap<KMLDataset, Set<number>>();

/**
 * The cells the flights of `data` pass over, kept with the dataset: the
 * years the data loader holds are the same objects for the session, so the
 * places a year is compared with are worked out once for the New areas
 * switch and Wrapped together
 */
export function datasetCells(data: KMLDataset): Set<number> {
  let cells = cellsOfDataset.get(data);
  if (!cells) {
    cells = visitedCells(data.path_segments);
    cellsOfDataset.set(data, cells);
  }
  return cells;
}

/** Whether any of `earlier` passed over `cell` */
export function visitedBefore(
  earlier: readonly Set<number>[],
  cell: number,
): boolean {
  return earlier.some((cells) => cells.has(cell));
}

/**
 * Which of `points` lie in cells none of `earlier` holds: 1 by index, as
 * the heatmap draws them apart (see Heat in ui/dataManager.ts)
 */
export function freshPoints(
  points: readonly Readonly<Coordinate>[],
  earlier: readonly Set<number>[],
): Uint8Array {
  return Uint8Array.from(points, (point) =>
    visitedBefore(earlier, cellOf(point)) ? 0 : 1,
  );
}

/**
 * The area in square kilometres that `segments` pass over and none of the
 * cells in `earlier` (see datasetCells) hold
 */
export function newAreaKm2(
  segments: readonly PathSegment[],
  earlier: readonly Set<number>[],
): number {
  let fresh = 0;
  for (const cell of visitedCells(segments)) {
    if (!visitedBefore(earlier, cell)) fresh++;
  }
  return fresh * CELL_KM2;
}
