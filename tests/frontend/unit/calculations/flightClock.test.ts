/**
 * The clock of every flight: seconds into its flight at each segment and at
 * each point of its curve, from its logged times or, without them, from its
 * length at its groundspeed.
 */
import { describe, it, expect } from "vitest";
import {
  chainTimes,
  flightClock,
} from "../../../../kml_heatmap/frontend/calculations/flightClock";
import {
  smoothFlights,
  type SmoothedFlights,
} from "../../../../kml_heatmap/frontend/calculations/smoothing";
import type { PathSegment } from "../../../../kml_heatmap/frontend/types";

/** A segment of `path_id` along the latitude 47, `step` hundredths east */
function along(
  path_id: number,
  step: number,
  fields: Partial<PathSegment> = {},
): PathSegment {
  return {
    path_id,
    coords: [
      [47, 11 + step * 0.01],
      [47, 11 + (step + 1) * 0.01],
    ],
    altitude_ft: 3000,
    groundspeed_knots: 100,
    ...fields,
  };
}

/** Seconds of 0.01 degrees of longitude at 47 north at `knots` */
function secondsAt(knots: number): number {
  // The great-circle length the statistics measure, at the speed
  const metres = 0.01 * 111195 * Math.cos((47 * Math.PI) / 180);
  return metres / ((knots * 1852) / 3600);
}

describe("flightClock", () => {
  it("counts a logged flight by its logged seconds", () => {
    const clock = flightClock([
      along(1, 0, { time: 0 }),
      along(1, 1, { time: 20 }),
      along(1, 2, { time: 50 }),
    ]);

    expect([...clock.start.slice(0, 2)]).toEqual([0, 20]);
    expect(clock.spent[1]).toBe(30);
    expect(clock.start[2]).toBe(50);
  });

  it("gives the last segment of a flight its length at its groundspeed", () => {
    const clock = flightClock([
      along(1, 0, { time: 0 }),
      along(1, 1, { time: 20 }),
    ]);

    expect(clock.spent[1]).toBeCloseTo(secondsAt(100), 0);
    expect(clock.duration.get(1)).toBeCloseTo(20 + secondsAt(100), 0);
  });

  it("does not count a break in the log as time flown", () => {
    const clock = flightClock([
      along(1, 0, { time: 0 }),
      // An hour on the ground with the logger off
      along(1, 1, { time: 3600 }),
      along(1, 2, { time: 3610 }),
    ]);

    // The segment before the break takes its length at its speed
    expect(clock.spent[0]).toBeCloseTo(secondsAt(100), 0);
    expect(clock.spent[1]).toBe(10);
    expect(clock.start[2]).toBeCloseTo(secondsAt(100) + 10, 0);
  });

  it("clocks a flight without times by its length at its groundspeed", () => {
    const clock = flightClock([
      along(1, 0, { groundspeed_knots: 50 }),
      along(1, 1, { groundspeed_knots: 100 }),
    ]);

    expect(clock.spent[0]).toBeCloseTo(secondsAt(50), 0);
    expect(clock.start[1]).toBeCloseTo(secondsAt(50), 0);
    expect(clock.duration.get(1)).toBeCloseTo(
      secondsAt(50) + secondsAt(100),
      0,
    );
  });

  it("takes a long leg at its speed, not the two minutes the heat stops at", () => {
    // Ten hundredths of a degree, some 2.4 minutes at 50 kt
    const leg: PathSegment = {
      ...along(1, 0, { groundspeed_knots: 50 }),
      coords: [
        [47, 11],
        [47, 11.1],
      ],
    };

    const clock = flightClock([leg]);

    expect(clock.spent[0]).toBeGreaterThan(120);
    expect(clock.spent[0]).toBeCloseTo(10 * secondsAt(50), -1);
  });

  it("gives a leg no more than ten minutes, as long as a logged step", () => {
    const leg: PathSegment = {
      ...along(1, 0, { groundspeed_knots: 50 }),
      coords: [
        [47, 11],
        [47, 12],
      ],
    };

    expect(flightClock([leg]).spent[0]).toBe(600);
  });

  it("gives a flight with neither times nor speeds no time at all", () => {
    const clock = flightClock([
      along(1, 0, { groundspeed_knots: 0 }),
      along(1, 1, { groundspeed_knots: 0 }),
    ]);

    expect(clock.duration.get(1)).toBe(0);
  });

  it("starts every flight at 0, even where its segments are not together", () => {
    const clock = flightClock([
      along(1, 0, { time: 100 }),
      along(2, 0, { time: 5000 }),
      along(1, 1, { time: 110 }),
      along(2, 1, { time: 5040 }),
    ]);

    expect(clock.start[0]).toBe(0);
    expect(clock.start[1]).toBe(0);
    expect(clock.start[2]).toBe(10);
    expect(clock.start[3]).toBe(40);
    expect(clock.spent[0]).toBe(10);
  });
});

describe("chainTimes", () => {
  it("puts each point of a curve as far into its segment's time as it is along it", () => {
    const segments = [
      along(1, 0, { time: 0 }),
      along(1, 1, { time: 60 }),
      along(1, 2, { time: 90 }),
    ];
    const flights = smoothFlights(segments, () => 1000);
    const clock = flightClock(segments);

    const times = chainTimes(flights, clock, 0, segments.length);

    const { from, to } = flights;
    // The fixes keep the times of their segments
    expect(times[from[0]!]).toBe(0);
    expect(times[from[1]!]).toBe(60);
    expect(times[to[1]!]).toBe(90);
    for (let j = 1; j < times.length; j++) {
      expect(times[j]!).toBeGreaterThanOrEqual(times[j - 1]!);
    }
  });

  it("shares a segment's time out by the length of the pieces of its curve", () => {
    const segment = along(1, 0, { time: 0, groundspeed_knots: 0 });
    // One segment cut into two pieces, the second twice the first
    const flights: SmoothedFlights = {
      chains: [
        {
          points: [
            [47, 11],
            [47, 11.01],
            [47, 11.03],
          ],
          heights: [0, 0, 0],
          vertex: [0, 2],
        },
      ],
      chainOf: Int32Array.of(0),
      from: Int32Array.of(0),
      to: Int32Array.of(2),
    };
    const clock = flightClock([segment]);
    clock.spent[0] = 30;

    const times = chainTimes(flights, clock, 0, 1);

    expect(times[0]).toBe(0);
    expect(times[1]).toBeCloseTo(10, 6);
    expect(times[2]).toBeCloseTo(30, 6);
  });

  it("shares the time of a segment of no length out by its points", () => {
    const standing: PathSegment = {
      path_id: 1,
      coords: [
        [47, 11],
        [47, 11],
      ],
      altitude_ft: 1000,
      groundspeed_knots: 0,
      time: 0,
    };
    const segments = [standing, { ...standing, time: 30 }];
    const flights = smoothFlights(segments, () => 0);
    const clock = flightClock(segments);

    const times = chainTimes(flights, clock, 0, 2);

    expect(times[flights.to[0]!]).toBe(30);
  });
});
