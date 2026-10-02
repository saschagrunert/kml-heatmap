/**
 * The flights of the replay of all flights (ui/replayAll.ts) as the points its
 * layer draws (ui/replayAllLayer.ts): every flight's curve, uploaded once with
 * the seconds into its flight at each point (flightClock.ts), so a frame only
 * tells the layer the time. The curves and their heights are the ones the
 * ribbons and the heat cloud are cut from (groundedFlights), thinned as the
 * heat cloud thins them, a little closer (REPLAY_ALL_STEP_PX): a year of
 * flights is some 150,000 points, which a phone cannot draw every frame, and a
 * few thousand zoomed out.
 */
import type { PathSegment } from "../types";
import {
  DEGREES_TO_RADIANS,
  metresPerPixel,
  planarMetres,
  TILE_SIZE_PX,
} from "../utils/geometry";
import { FEET_TO_METERS } from "../utils/constants";
import { chainPieces, type FlightClock } from "./flightClock";
import {
  lngLatOfMercator,
  mercatorOf,
  mercatorX,
  mercatorY,
} from "./heatCloud";
import { heatWeight } from "./heatLines";
import { liftExaggeration } from "./lift";
import type { SmoothedFlights, SmoothedLine } from "./smoothing";

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
  // The points are picked first, and the bounds with them, which the
  // origin is taken from; then they are written straight into the array
  // the layer is given. The index into its curve of every point kept,
  // curve after curve, and each curve with the end of its points in it.
  const kept: number[] = [];
  const curves: { line: SmoothedLine; times: Float64Array; end: number }[] = [];
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
      // Weighed as the heat cloud weighs them, which keeps one weighing of
      // the curve for both: the times are the same for every weighing
      const { times } = chainPieces(
        segments,
        flights,
        i,
        end,
        clock,
        heatWeight,
      );
      const pixelM =
        metresPerPixel(detail + 0.5) *
        Math.cos(points[0]![0] * DEGREES_TO_RADIANS);
      const stepM = REPLAY_ALL_STEP_PX * pixelM;
      const heightStepFt =
        (HEIGHT_STEP_PX * pixelM) / exaggeration / FEET_TO_METERS;
      const heightAt = (j: number): number => (ground?.[j] ?? 0) + heights[j]!;
      let keptFt = heightAt(0);
      let along = 0;
      const keep = (j: number): void => {
        const [lat, lng] = points[j]!;
        west = Math.min(west, lng);
        east = Math.max(east, lng);
        south = Math.min(south, lat);
        north = Math.max(north, lat);
        kept.push(j);
        keptFt = heightAt(j);
      };
      keep(0);
      const last = points.length - 1;
      for (let j = 1; j <= last; j++) {
        along += planarMetres(points[j - 1]!, points[j]!);
        if (
          j === last ||
          along >= stepM ||
          Math.abs(heightAt(j) - keptFt) >= heightStepFt
        ) {
          keep(j);
          along = 0;
        }
      }
      curves.push({ line: chain, times, end: kept.length });
    }
    i = end;
  }
  const size = REPLAY_ALL_POINT_FLOATS;
  const total = kept.length;
  let origin: [number, number] = [0.5, 0.5];
  if (total > 0) {
    const [x0, y0] = mercatorOf([north, west]);
    const [x1, y1] = mercatorOf([south, east]);
    origin = [(x0 + x1) / 2, (y0 + y1) / 2];
  }
  const points = new Float32Array(total * size);
  let n = 0;
  for (const { line, times, end } of curves) {
    const { ground, heights } = line;
    // Every point joins the next but the last of its curve
    for (; n < end; n++) {
      const j = kept[n]!;
      const [lat, lng] = line.points[j]!;
      const k = n * size;
      points[k] = mercatorX(lng) - origin[0];
      points[k + 1] = mercatorY(lat) - origin[1];
      points[k + 2] = ground?.[j] ?? 0;
      points[k + 3] = heights[j]!;
      points[k + 4] = times[j]!;
      points[k + 5] = n < end - 1 ? 1 : 0;
    }
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

/** A camera of the fit of the flights: its centre, `[lng, lat]`, and zoom */
export interface FitCamera {
  center: [number, number];
  zoom: number;
}

/**
 * The map a fit is for, north up: its size in pixels, the pixels kept free
 * along each edge, its tilt and its vertical field of view in degrees
 */
export interface FitMap {
  width: number;
  height: number;
  padding: { top: number; right: number; bottom: number; left: number };
  pitch: number;
  fov: number;
}

/** How often the fit measures the flights on the screen and moves */
const FIT_ROUNDS = 4;

/**
 * The most a round of the fit zooms in or out, in levels: a flight behind
 * the camera of a steep tilt has no pixel, and the next round measures
 * from closer to where they fit
 */
const FIT_STEP_ZOOM = 2;

/**
 * The camera, from `camera` on, that shows the flights `run` as large as
 * the room of `map` within its padding allows. A fit of their bounds in a
 * tilted view left them small in the middle of it, the far part of the map
 * empty: it fits the corners of the bounds, which the tilt spreads, rather
 * than the flights. Each round measures their points on the screen of the
 * camera, as MapLibre draws the flat map in Mercator (the camera
 * looks at the middle of the map from the distance its field of view puts
 * it at, tilted towards the north, and a point south of the middle comes
 * nearer and lower on the screen; the globe is taken for the flat map),
 * moves their middle to the middle of the room and zooms by how much more
 * room there is. The tilt makes the next measure differ a little, and
 * FIT_ROUNDS fill the room to a hundredth. No closer in than `maxZoom`.
 */
export function fitTilted(
  run: ReplayAllPoints,
  camera: FitCamera,
  map: FitMap,
  maxZoom: number,
): FitCamera {
  const { points, count, origin } = run;
  const { width, height, padding } = map;
  const across = width - padding.left - padding.right;
  const down = height - padding.top - padding.bottom;
  if (count === 0 || across <= 0 || down <= 0) return camera;
  const distance = height / 2 / Math.tan((map.fov * DEGREES_TO_RADIANS) / 2);
  const sin = Math.sin(map.pitch * DEGREES_TO_RADIANS);
  const cos = Math.cos(map.pitch * DEGREES_TO_RADIANS);
  // The centre in Mercator units from the origin of the points
  const [mx, my] = mercatorOf([camera.center[1], camera.center[0]]);
  let x = mx - origin[0];
  let y = my - origin[1];
  let zoom = camera.zoom;
  for (let round = 0; round < FIT_ROUNDS; round++) {
    const world = TILE_SIZE_PX * 2 ** zoom;
    // Left, top, right and bottom, in pixels from the middle of the map
    let [left, top, right, bottom] = [Infinity, Infinity, -Infinity, -Infinity];
    for (let k = 0; k < points.length; k += REPLAY_ALL_POINT_FLOATS) {
      const south = (points[k + 1]! - y) * world;
      const depth = distance - south * sin;
      // Behind the camera, or level with it: further out, where it comes
      // into view
      if (depth <= 0) top = -Infinity;
      const scale = distance / depth;
      const px = (points[k]! - x) * world * scale;
      const py = south * cos * scale;
      left = Math.min(left, px);
      right = Math.max(right, px);
      top = Math.min(top, py);
      bottom = Math.max(bottom, py);
    }
    const scale = Math.min(across / (right - left), down / (bottom - top));
    // Their middle, from where it is to the middle of the room
    const dx = (left + right - across + width) / 2 - padding.left;
    const dy = (top + bottom - down + height) / 2 - padding.top;
    const south = (dy * distance) / (distance * cos + dy * sin);
    if (top > -Infinity) {
      x += (dx * (distance - south * sin)) / distance / world;
      y += south / world;
    }
    zoom = Math.min(
      zoom +
        Math.min(Math.max(Math.log2(scale), -FIT_STEP_ZOOM), FIT_STEP_ZOOM),
      maxZoom,
    );
  }
  return {
    center: lngLatOfMercator(x + origin[0], y + origin[1]),
    zoom,
  };
}
