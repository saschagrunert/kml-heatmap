/**
 * Path ribbons - what the runs of the 3D view are cut for
 *
 * In the 3D view (calculations/lift.ts) each run of the colour layers is
 * written as a ribbon at its height rather than as a line, cut from its
 * flight's smoothed curve, and from CULL_FROM_ZOOM on only for the part of
 * the map around the view (see utils/viewBox.ts). The layer manager
 * (ui/layerManager.ts) decides when the ribbons are cut again: as the
 * relief comes or goes, as a zoom ends on another level and as the view
 * leaves the part they were written for. This module holds what those cuts
 * are made of: every flight smoothed at its height on the ground of the
 * relief's level (`smoothedFlights`), how high the highest of them may be
 * drawn (`topM`) and the part of the map the ribbon of one run lies in
 * (`runBox`).
 */
import type { MapApp } from "../mapApp";
import type { PathSegment } from "../types";
import type { SmoothedFlights } from "../calculations/smoothing";
import { groundedFlights } from "../calculations/groundProfile";
import { ribbonsTopM, type Box } from "../utils/viewBox";
import type { Run } from "./pathRuns";

/**
 * Every flight smoothed at its height above its ground, on the ground and
 * at the level the relief is drawn for (see groundedFlights), kept for as
 * long as the dataset, the ground and the level are the same
 */
export function smoothedFlights(
  app: MapApp,
  segments: PathSegment[],
): SmoothedFlights {
  return groundedFlights(segments, app.terrainActive, app.reliefLevel);
}

/**
 * How high the highest flight may be drawn above its ground, in metres,
 * in the 3D view: no higher than its altitude
 */
export function topM(app: MapApp): number {
  return ribbonsTopM(app.altitudeRange.max, app.reliefLevel);
}

/** The part of the map the ribbon of a run lies in, along its curve */
export function runBox(run: Run, smoothed: SmoothedFlights): Box {
  const { points } = smoothed.chains[smoothed.chainOf[run.start]!]!;
  let [west, south, east, north] = [540, 90, -540, -90];
  const last = smoothed.to[run.end - 1]!;
  for (let j = smoothed.from[run.start]!; j <= last; j++) {
    const [lat, lng] = points[j]!;
    west = Math.min(west, lng);
    east = Math.max(east, lng);
    south = Math.min(south, lat);
    north = Math.max(north, lat);
  }
  return [west, south, east, north];
}
