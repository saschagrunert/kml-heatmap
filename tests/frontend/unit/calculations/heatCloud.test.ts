/**
 * The points of the heat cloud of the 3D view: the fixes of the flights the
 * heatmap shows, at the heights of the ribbons, merged for the level, with
 * the seconds spent on each stretch between them.
 */
import { describe, it, expect } from "vitest";
import {
  CLOUD_POINT_FLOATS,
  CLOUD_STEP_PX,
  cloudPoints,
  mercatorOf,
  type CloudPoints,
} from "../../../../kml_heatmap/frontend/calculations/heatCloud";
import { levelGroundFt } from "../../../../kml_heatmap/frontend/calculations/groundProfile";
import { segmentSeconds } from "../../../../kml_heatmap/frontend/calculations/heatLines";
import { liftFt } from "../../../../kml_heatmap/frontend/calculations/lift";
import { smoothFlights } from "../../../../kml_heatmap/frontend/calculations/smoothing";
import {
  DEGREES_TO_RADIANS,
  metresPerPixel,
  type Coordinate,
} from "../../../../kml_heatmap/frontend/utils/geometry";
import type { PathSegment } from "../../../../kml_heatmap/frontend/types";

/** A point of the cloud, read back from its floats */
interface Point {
  x: number;
  y: number;
  ground: number;
  lift: number;
  heat: number;
}

/** The points of a cloud, without the empty one before and after them */
function pointsOf(cloud: CloudPoints): Point[] {
  const out: Point[] = [];
  for (let k = 1; k <= cloud.count; k++) {
    const at = k * CLOUD_POINT_FLOATS;
    const p = cloud.points;
    out.push({
      x: p[at]! + cloud.origin[0],
      y: p[at + 1]! + cloud.origin[1],
      ground: p[at + 2]!,
      lift: p[at + 3]!,
      heat: p[at + 4]!,
    });
  }
  return out;
}

/**
 * A flight of `path_id` through `fixes`, a segment from each to the next,
 * `seconds` apart, at the altitudes `altitudes` (the one a segment ends at)
 */
function flight(
  path_id: number,
  fixes: Coordinate[],
  altitudes: number[] = fixes.slice(1).map(() => 3000),
  seconds = 5,
): PathSegment[] {
  return fixes.slice(1).map((to, i) => ({
    path_id,
    coords: [fixes[i]!, to],
    altitude_ft: altitudes[i]!,
    groundspeed_knots: 100,
    time: i * seconds,
  }));
}

/** `count` fixes `stepDeg` of longitude apart along the latitude `lat` */
function line(
  count: number,
  lat = 47,
  lng = 11,
  stepDeg = 0.003,
): Coordinate[] {
  return Array.from({ length: count }, (_, i) => [lat, lng + i * stepDeg]);
}

const everything = (): boolean => true;

/**
 * The cloud of `segments` along their curves smoothed on the ground
 * `ground` (by segment, see smoothFlights), as groundedFlights smooths them
 */
function cloudOf(
  segments: PathSegment[],
  keep: (pathId: number) => boolean,
  ground: ArrayLike<number>,
  level: number,
): CloudPoints {
  const flights = smoothFlights(segments, (i) => segments[i]!.altitude_ft, {
    groundOf: (i) => ground[i]!,
  });
  return cloudPoints(segments, flights, keep, level);
}

/**
 * The seconds of every segment as the heat lines count them: the time to
 * the next of its path, and the last at its groundspeed
 */
function secondsOf(segments: PathSegment[]): number[] {
  return segments.map((segment, i) => segmentSeconds(segment, segments[i + 1]));
}

describe("mercatorOf", () => {
  it("puts null island in the middle of the world and the antimeridian at its edges", () => {
    expect(mercatorOf([0, 0])).toEqual([0.5, 0.5]);
    expect(mercatorOf([0, -180])[0]).toBe(0);
    expect(mercatorOf([0, 180])[0]).toBe(1);
  });

  it("puts the north above the south, further apart towards the poles", () => {
    const [, y45] = mercatorOf([45, 0]);
    const [, y60] = mercatorOf([60, 0]);
    expect(y45).toBeLessThan(0.5);
    expect(y60).toBeLessThan(y45);
    expect(0.5 - y45).toBeCloseTo(
      Math.log(Math.tan(Math.PI / 4 + (45 * DEGREES_TO_RADIANS) / 2)) /
        (2 * Math.PI),
      12,
    );
  });
});

describe("cloudPoints", () => {
  it("is empty without segments, or where the filter keeps none", () => {
    expect(cloudOf([], everything, [], 8).count).toBe(0);
    const segments = flight(1, line(4));
    const none = cloudOf(segments, () => false, [0, 0, 0], 8);
    expect(none.count).toBe(0);
    // The empty point before and after is there all the same
    expect(none.points).toHaveLength(2 * CLOUD_POINT_FLOATS);
  });

  it("keeps every fix where they are further apart than the step, the first at the start of the first segment", () => {
    const fixes = line(4);
    const segments = flight(1, fixes);
    const cloud = cloudOf(segments, everything, [0, 0, 0], 11);
    const points = pointsOf(cloud);
    expect(points).toHaveLength(4);
    points.forEach((point, i) => {
      const [x, y] = mercatorOf(fixes[i]!);
      expect(point.x).toBeCloseTo(x, 9);
      expect(point.y).toBeCloseTo(y, 9);
    });
  });

  it("gives the points from an origin in the middle of them, and has an empty point before and after them", () => {
    const segments = flight(1, line(3, 47, 11, 0.5));
    const cloud = cloudOf(segments, everything, [0, 0], 11);
    const west = mercatorOf([47, 11])[0];
    const east = mercatorOf([47, 12])[0];
    expect(cloud.origin[0]).toBeCloseTo((west + east) / 2, 12);
    expect(cloud.origin[1]).toBeCloseTo(mercatorOf([47, 11])[1], 12);
    const floats = cloud.points;
    expect(floats).toHaveLength((cloud.count + 2) * CLOUD_POINT_FLOATS);
    expect([...floats.slice(0, CLOUD_POINT_FLOATS)]).toEqual([0, 0, 0, 0, 0]);
    expect([...floats.slice(-CLOUD_POINT_FLOATS)]).toEqual([0, 0, 0, 0, 0]);
    // Small numbers around the origin, which a 32-bit float holds exactly
    expect(Math.abs(floats[CLOUD_POINT_FLOATS]!)).toBeLessThan(0.002);
  });

  it("stands every point on the ground under it, at its altitude above that, never below", () => {
    // Far enough apart for the curve to climb and sink as they did (see
    // MAX_SLOPE in smoothing.ts)
    const segments = flight(1, line(4, 47, 11, 0.05), [2500, 1500, 4000]);
    // The ground under the end of each segment
    const ground = [2000, 1800, 1000];
    const points = pointsOf(cloudOf(segments, everything, ground, 11));
    // The first fix takes the altitude and the ground of the first segment,
    // as the ribbons do (see smoothFlights)
    expect(points.map((p) => p.ground)).toEqual([2000, 2000, 1800, 1000]);
    expect(points.map((p) => p.lift)).toEqual([
      liftFt(2500, 2000),
      500,
      0,
      3000,
    ]);
  });

  it("stands on the ground of the relief level it is cut for, the one the ribbons stand on", () => {
    const fixes = line(40, 46.5, 10, 0.01);
    const segments = flight(
      1,
      fixes,
      fixes.slice(1).map(() => 9000),
    ).map((segment, i) => ({
      ...segment,
      ground_ft: 3000 + 1500 * Math.sin(i),
    }));
    const level = 11;
    const ground = levelGroundFt(segments, true, level);
    const points = pointsOf(cloudOf(segments, everything, ground, level));
    expect(points.slice(1).map((p) => p.ground)).toEqual(
      [...ground].map((feet) => Math.fround(feet)),
    );
    // At its altitude, over whatever ground
    for (const point of points) {
      expect(point.ground + point.lift).toBeCloseTo(9000, 2);
    }
  });

  it("carries the seconds spent on a stretch on the point it starts from, and none on the last of a flight", () => {
    const segments = flight(1, line(4), undefined, 7);
    const points = pointsOf(cloudOf(segments, everything, [0, 0, 0], 11));
    const seconds = secondsOf(segments);
    // The last segment of a path has no next: it is at its groundspeed
    expect(seconds.slice(0, 2)).toEqual([7, 7]);
    expect(points.map((p) => p.heat)).toEqual(
      [...seconds, 0].map((s) => Math.fround(s)),
    );
  });

  it("merges the fixes closer than the step at the level, with their heat, keeping the ends", () => {
    // 300 m apart, where a step at level 4 is kilometres
    const fixes = line(21, 47, 11, 0.004);
    const segments = flight(1, fixes, undefined, 6);
    const points = pointsOf(
      cloudOf(segments, everything, new Array(20).fill(0), 4),
    );
    expect(points.length).toBeLessThan(21);
    expect(points.length).toBeGreaterThanOrEqual(2);
    const [x0] = mercatorOf(fixes[0]!);
    const [xn] = mercatorOf(fixes[20]!);
    expect(points[0]!.x).toBeCloseTo(x0, 9);
    expect(points[points.length - 1]!.x).toBeCloseTo(xn, 9);
    // Every second of the flight is on a stretch still
    const total = points.reduce((sum, p) => sum + p.heat, 0);
    const seconds = secondsOf(segments).reduce((sum, s) => sum + s, 0);
    expect(total).toBeCloseTo(seconds, 3);
  });

  it("keeps a fix a step apart from the last kept, the step being pixels of the level", () => {
    const level = 6;
    const lat = 47;
    const stepM =
      CLOUD_STEP_PX *
      metresPerPixel(level + 0.5) *
      Math.cos(lat * DEGREES_TO_RADIANS);
    // Fixes a third of a step apart: every third is kept
    const stepDeg = stepM / 3 / (111320 * Math.cos(lat * DEGREES_TO_RADIANS));
    const segments = flight(1, line(10, lat, 11, stepDeg * 1.0001));
    const points = pointsOf(
      cloudOf(segments, everything, new Array(9).fill(0), level),
    );
    expect(points).toHaveLength(4);
  });

  it("keeps a climb a climb: a fix where the height has changed by a pixel since the last kept", () => {
    const fixes = line(21, 47, 11, 0.004);
    const level = 4;
    const flat = flight(1, fixes);
    const climbing = flight(
      1,
      fixes,
      fixes.slice(1).map((_, i) => 1000 + 800 * i),
    );
    const ground = new Array(20).fill(0);
    const kept = (segments: PathSegment[]): number =>
      cloudOf(segments, everything, ground, level).count;
    expect(kept(climbing)).toBeGreaterThan(kept(flat));
  });

  it("follows the filter, flight by flight", () => {
    const segments = [
      ...flight(1, line(3, 47)),
      ...flight(2, line(3, 48)),
      ...flight(3, line(3, 49)),
    ];
    const ground = new Array(segments.length).fill(0);
    const points = pointsOf(cloudOf(segments, (id) => id !== 2, ground, 11));
    expect(points).toHaveLength(6);
    const ys = points.map((p) => p.y);
    expect(
      ys.filter((y) => Math.abs(y - mercatorOf([48, 11])[1]) < 1e-9),
    ).toEqual([]);
  });

  it("starts a flight anew where the next segment does not start where the last ended, or is of another path", () => {
    const a = flight(1, line(3, 47));
    // The same path again, somewhere else: a gap in the log
    const b = flight(1, line(3, 47.5));
    const c = flight(2, [line(3, 47.5)[2]!, [47.6, 11]]);
    const segments = [...a, ...b, ...c];
    const points = pointsOf(
      cloudOf(segments, everything, new Array(segments.length).fill(0), 11),
    );
    expect(points).toHaveLength(3 + 3 + 2);
    // No stretch from the end of one to the start of the next
    const seconds = secondsOf(segments).map((s) => Math.fround(s));
    expect(points.map((p) => p.heat)).toEqual([
      ...seconds.slice(0, 2),
      0,
      ...seconds.slice(2, 4),
      0,
      seconds[4],
      0,
    ]);
    expect(points[0]!.heat).toBe(5);
  });

  it("takes a flight across the antimeridian the short way", () => {
    const segments = flight(1, [
      [10, 179.99],
      [10, -179.99],
    ]);
    const points = pointsOf(cloudOf(segments, everything, [0], 11));
    // Past 1 rather than back across the world
    expect(points[1]!.x - points[0]!.x).toBeCloseTo(0.02 / 360, 9);
  });

  it("gives a stretch without times or speeds a trace of heat, so it is still one", () => {
    const segments = flight(1, line(3)).map((segment) => ({
      ...segment,
      time: undefined,
      groundspeed_knots: 0,
    }));
    const points = pointsOf(cloudOf(segments, everything, [0, 0], 11));
    expect(points[0]!.heat).toBeGreaterThan(0);
    expect(points[0]!.heat).toBeLessThan(0.1);
  });

  it("lies on the curve the ribbons are cut from, where a flight turns, not on the chords between its fixes", () => {
    // A right angle over three fixes a kilometre apart
    const fixes: Coordinate[] = [
      [47, 11],
      [47, 11.0132],
      [47.009, 11.0132],
    ];
    const segments = flight(1, fixes, undefined, 20);
    const flights = smoothFlights(segments, (i) => segments[i]!.altitude_ft, {
      groundOf: () => 0,
    });
    const curve = flights.chains[0]!.points;
    // The spline adds points in the bend
    expect(curve.length).toBeGreaterThan(fixes.length);
    // At a level where no point of the curve is within a step of the next
    const points = pointsOf(cloudPoints(segments, flights, everything, 16));
    expect(points).toHaveLength(curve.length);
    points.forEach((point, j) => {
      const [x, y] = mercatorOf(curve[j]!);
      expect(point.x).toBeCloseTo(x, 9);
      expect(point.y).toBeCloseTo(y, 9);
    });
  });

  it("spreads the seconds of a segment over the stretches of the curve along it by their length", () => {
    const fixes: Coordinate[] = [
      [47, 11],
      [47, 11.0132],
      [47.009, 11.0132],
      [47.018, 11.0132],
    ];
    const segments = flight(1, fixes, undefined, 20);
    const flights = smoothFlights(segments, (i) => segments[i]!.altitude_ft, {
      groundOf: () => 0,
    });
    const points = pointsOf(cloudPoints(segments, flights, everything, 16));
    const total = points.reduce((sum, p) => sum + p.heat, 0);
    const seconds = secondsOf(segments).reduce((sum, t) => sum + t, 0);
    expect(total).toBeCloseTo(seconds, 3);
    // The segment into the bend is cut into pieces of a few seconds each
    const { from, to } = flights;
    const pieces = to[1]! - from[1]!;
    expect(pieces).toBeGreaterThan(1);
    const bend = points.slice(from[1], to[1]).map((p) => p.heat);
    expect(bend.reduce((sum, t) => sum + t, 0)).toBeCloseTo(20, 3);
    for (const heat of bend) expect(heat).toBeLessThan(20);
  });
});
