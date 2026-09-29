/**
 * The points of the replay of all flights: every flight's curve with the
 * seconds into its flight at each point, thinned for the zoom it is drawn
 * at, the step from one curve to the next left out.
 */
import { describe, it, expect } from "vitest";
import {
  REPLAY_ALL_POINT_FLOATS,
  replayAllPoints,
  type ReplayAllPoints,
} from "../../../../kml_heatmap/frontend/calculations/replayAll";
import { flightClock } from "../../../../kml_heatmap/frontend/calculations/flightClock";
import { smoothFlights } from "../../../../kml_heatmap/frontend/calculations/smoothing";
import type { PathSegment } from "../../../../kml_heatmap/frontend/types";

/**
 * A flight of `path_id`: `count` fixes a thousandth of a degree apart
 * along the latitude `lat`, 5 s apart, or untimed at `knots`
 */
function flight(
  path_id: number,
  lat: number,
  { count = 41, timed = true, knots = 100, altitude = 3000 } = {},
): PathSegment[] {
  return Array.from({ length: count - 1 }, (_, i) => ({
    path_id,
    coords: [
      [lat, 11 + i * 0.001],
      [lat, 11 + (i + 1) * 0.001],
    ],
    altitude_ft: altitude,
    groundspeed_knots: knots,
    ...(timed ? { time: i * 5 } : {}),
  }));
}

function build(
  segments: PathSegment[],
  {
    keep = () => true,
    detail = 12,
    level = 6,
  }: {
    keep?: (pathId: number) => boolean;
    detail?: number;
    level?: number;
  } = {},
): ReplayAllPoints {
  const flights = smoothFlights(segments, (i) => segments[i]!.altitude_ft, {
    groundOf: () => 1000,
  });
  return replayAllPoints(
    segments,
    flights,
    flightClock(segments),
    keep,
    detail,
    level,
  );
}

/** Field `f` of every point */
function column(points: ReplayAllPoints, f: number): number[] {
  const values: number[] = [];
  for (let k = 0; k < points.count; k++) {
    values.push(points.points[k * REPLAY_ALL_POINT_FLOATS + f]!);
  }
  return values;
}

describe("replayAllPoints", () => {
  it("gives every point the seconds into its flight, from 0", () => {
    const points = build(flight(1, 47));
    const times = column(points, 4);

    expect(times[0]).toBe(0);
    for (let k = 1; k < times.length; k++) {
      expect(times[k]!).toBeGreaterThan(times[k - 1]!);
    }
    // The last fix is at 195 s, and its segment takes its length at 100 kt
    expect(times[times.length - 1]).toBeCloseTo(points.duration, 3);
    expect(points.duration).toBeGreaterThan(195);
  });

  it("starts every flight at 0 and joins no curve to the next", () => {
    const points = build([...flight(1, 47), ...flight(2, 48)]);
    const times = column(points, 4);
    const joins = column(points, 5);

    expect(points.flights).toBe(2);
    const second = times.indexOf(0, 1);
    expect(second).toBeGreaterThan(0);
    // The last point of the first curve leads nowhere, every other one on
    expect(joins[second - 1]).toBe(0);
    expect(joins[joins.length - 1]).toBe(0);
    expect(joins.filter((join) => join === 0)).toHaveLength(2);
  });

  it("thins the curves for the zoom, more closely the closer in", () => {
    const segments = flight(1, 47, { count: 401 });

    const far = build(segments, { detail: 8 });
    const near = build(segments, { detail: 14 });

    // 0.4 degrees of longitude, 30 km: at zoom 8.5 some 200 pixels, about
    // 50 points 4 pixels apart; at 14.5 every fix, 76 m apart
    expect(far.count).toBeLessThan(60);
    expect(far.count).toBeGreaterThan(40);
    expect(near.count).toBe(401);
    // Either end of the curve is kept
    expect(column(far, 4)[0]).toBe(0);
    expect(column(far, 4)[far.count - 1]).toBeCloseTo(far.duration, 3);
  });

  it("keeps a point where the height changes, the more the more it is exaggerated", () => {
    // Climbing 100 ft a fix
    const segments = flight(1, 47, { count: 101 }).map((segment, i) => ({
      ...segment,
      altitude_ft: 1000 + i * 100,
    }));
    const level = (at: number): number =>
      build(segments, { detail: 6, level: at }).count;

    // Ten times its height out to level 7, twice from level 10 in
    expect(level(6)).toBeGreaterThan(level(10));
    // A level flight keeps the points of its length alone, at every level
    const cruise = flight(1, 47, { count: 101 });
    const cruising = build(cruise, { detail: 6, level: 6 }).count;
    expect(build(cruise, { detail: 6, level: 10 }).count).toBe(cruising);
    expect(level(10)).toBeGreaterThan(cruising);
  });

  it("plays only the flights it is asked to", () => {
    const segments = [...flight(1, 47), ...flight(2, 48), ...flight(3, 49)];

    const points = build(segments, { keep: (id) => id !== 2 });

    expect(points.flights).toBe(2);
    const [west, south, east, north] = points.bounds!;
    expect(south).toBe(47);
    expect(north).toBe(49);
    expect(west).toBe(11);
    expect(east).toBeCloseTo(11.04, 6);
  });

  it("clocks an untimed flight by its speed, and leaves out one without either", () => {
    const segments = [
      ...flight(1, 47, { timed: false, knots: 50 }),
      ...flight(2, 48, { timed: false, knots: 0 }),
    ];

    const points = build(segments);

    expect(points.flights).toBe(1);
    // Twice as long as at 100 kt
    const fast = build(flight(1, 47, { timed: false, knots: 100 }));
    expect(points.duration).toBeCloseTo(2 * fast.duration, 3);
  });

  it("gives its points from an origin near them", () => {
    const points = build(flight(1, 47));

    const xs = column(points, 0);
    expect(Math.max(...xs.map(Math.abs))).toBeLessThan(1e-4);
    expect(points.origin[0]).toBeCloseTo((11.02 + 180) / 360, 6);
  });

  it("takes a flight across the antimeridian the short way", () => {
    const segments = Array.from({ length: 20 }, (_, i) => {
      const lng = (k: number): number => {
        const east = 179.95 + k * 0.005;
        return east > 180 ? east - 360 : east;
      };
      return {
        path_id: 1,
        coords: [
          [10, lng(i)],
          [10, lng(i + 1)],
        ] as [[number, number], [number, number]],
        altitude_ft: 3000,
        groundspeed_knots: 100,
        time: i * 5,
      };
    });
    for (const detail of [4, 12, 16]) {
      const points = build(segments, { detail });
      const xs = column(points, 0);
      expect(xs.length).toBeGreaterThan(1);
      const steps = xs.slice(1).map((x, k) => Math.abs(x - xs[k]!));
      expect(Math.max(...steps)).toBeLessThan(0.2 / 360);
      // On past 180 rather than back round the world
      expect(points.bounds![0]).toBeCloseTo(179.95, 6);
      expect(points.bounds![2]).toBeCloseTo(180.05, 6);
    }
  });

  it("has nothing to play without flights", () => {
    const points = build([]);

    expect(points.count).toBe(0);
    expect(points.flights).toBe(0);
    expect(points.duration).toBe(0);
    expect(points.bounds).toBeNull();
  });
});
