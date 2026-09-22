import { describe, it, expect } from "vitest";
import { heatLineFeatures } from "../../../../kml_heatmap/frontend/calculations/heatLines";
import type { PathSegment } from "../../../../kml_heatmap/frontend/types";
import { createSegment } from "../../testHelpers";

/** Degrees of latitude per metre */
const DEG_PER_M = 1 / 111320;

/**
 * A flight due north from `lat`, `lng`: `count` segments of `stepM` metres,
 * each taking `stepS` seconds, with the log's relative times unless
 * `timed` is false (then only the groundspeed says how long they took)
 */
function flight(
  pathId: number,
  {
    lat = 50,
    lng = 8,
    count = 10,
    stepM = 235,
    stepS = 5,
    timed = true,
  }: {
    lat?: number;
    lng?: number;
    count?: number;
    stepM?: number;
    stepS?: number;
    timed?: boolean;
  } = {},
): PathSegment[] {
  const knots = stepM / stepS / (1852 / 3600);
  return Array.from({ length: count }, (_, i) =>
    createSegment({
      path_id: pathId,
      coords: [
        [lat + i * stepM * DEG_PER_M, lng],
        [lat + (i + 1) * stepM * DEG_PER_M, lng],
      ],
      groundspeed_knots: knots,
      time: timed ? (i + 1) * stepS : undefined,
    }),
  );
}

const all = (): boolean => true;

/** The heat of the line that holds `[lng, lat]` */
function heatAt(
  collection: ReturnType<typeof heatLineFeatures>,
  lat: number,
  lng: number,
): number {
  const feature = collection.features.find((f) =>
    f.geometry.coordinates.some(
      ([x, y]) => Math.abs(x! - lng) < 1e-9 && Math.abs(y! - lat) < 1e-9,
    ),
  );
  expect(feature).toBeDefined();
  return feature!.properties.heat;
}

describe("heatLineFeatures", () => {
  it("draws every fix of a flight, in order, longitude first", () => {
    const segments = flight(1, { count: 4 });

    const lines = heatLineFeatures(segments, all).features.map(
      (feature) => feature.geometry.coordinates,
    );

    // Lines of one flight meet where one heat hands over to the next
    const fixes = lines.flatMap((line, index) =>
      index === 0 ? line : line.slice(1),
    );
    expect(fixes).toEqual([
      ...segments.map((s) => [s.coords![0][1], s.coords![0][0]]),
      [segments[3]!.coords![1][1], segments[3]!.coords![1][0]],
    ]);
  });

  it("merges a stretch of even heat into one line", () => {
    const segments = flight(1, { count: 60 });

    const { features } = heatLineFeatures(segments, all);

    // Only the ends, which have a neighbour on one side, run cooler
    expect(features.length).toBeLessThanOrEqual(3);
  });

  it("makes a place hotter the longer the aircraft stayed there", () => {
    const cruise = flight(1, { lng: 8, stepS: 5 });
    const taxi = flight(2, { lng: 9, stepS: 50 });

    const lines = heatLineFeatures([...cruise, ...taxi], all);

    const middle = 50 + 5 * 235 * DEG_PER_M;
    expect(heatAt(lines, middle, 9)).toBeGreaterThan(
      heatAt(lines, middle, 8) * 4,
    );
  });

  it("takes the time from the groundspeed when the log has none", () => {
    const fast = flight(1, { lng: 8, stepS: 5, timed: false });
    const slow = flight(2, { lng: 9, stepS: 50, timed: false });

    const lines = heatLineFeatures([...fast, ...slow], all);

    const middle = 50 + 5 * 235 * DEG_PER_M;
    expect(heatAt(lines, middle, 9)).toBeGreaterThan(
      heatAt(lines, middle, 8) * 4,
    );
  });

  it("does not count a break in the log as time spent", () => {
    const segments = flight(1, { count: 3 });
    // An hour between the second and the third fix: the logger was off
    segments[2]!.time = 3600;
    const withBreak = heatLineFeatures(segments, all);
    const without = heatLineFeatures(flight(1, { count: 3 }), all);

    // The segment takes what its groundspeed says instead, five seconds
    const end = 50 + 3 * 235 * DEG_PER_M;
    expect(heatAt(withBreak, end, 8)).toBe(heatAt(without, end, 8));
  });

  it("adds up the flights over the same place", () => {
    const one = heatLineFeatures(flight(1), all);
    const three = heatLineFeatures(
      [...flight(1), ...flight(2), ...flight(3)],
      all,
    );

    const middle = 50 + 5 * 235 * DEG_PER_M;
    expect(heatAt(three, middle, 8)).toBeGreaterThan(
      heatAt(one, middle, 8) * 2,
    );
  });

  it("keeps a flight that only crosses a busy place cool", () => {
    // Ten flights stand around one spot, a lone one passes it at speed
    const busy = Array.from({ length: 10 }, (_, i) =>
      flight(i + 1, { count: 2, stepM: 5, stepS: 60 }),
    ).flat();
    const passing = createSegment({
      path_id: 99,
      coords: [
        [50 - 200 * DEG_PER_M, 8],
        [50 + 200 * DEG_PER_M, 8],
      ],
      groundspeed_knots: 100,
    });

    const lines = heatLineFeatures([...busy, passing], all);

    expect(heatAt(lines, 50 + 200 * DEG_PER_M, 8)).toBeLessThan(
      heatAt(lines, 50, 8) / 10,
    );
  });

  it("draws and counts only the flights the filter keeps", () => {
    const segments = [...flight(1), ...flight(2), ...flight(3, { lng: 9 })];

    const both = heatLineFeatures(segments, all);
    const one = heatLineFeatures(segments, (id) => id !== 2);

    const middle = 50 + 5 * 235 * DEG_PER_M;
    expect(heatAt(one, middle, 8)).toBeLessThan(heatAt(both, middle, 8));
    // Path 3 alone at 9 degrees, path 1 alone at 8: the same heat
    expect(heatAt(one, middle, 8)).toBe(heatAt(one, middle, 9));
    expect(heatLineFeatures(segments, () => false).features).toEqual([]);
  });

  it("skips segments without coordinates", () => {
    expect(
      heatLineFeatures([{ path_id: 1 }, ...flight(1, { count: 2 })], all)
        .features.length,
    ).toBeGreaterThan(0);
    expect(heatLineFeatures([{ path_id: 1 }], all).features).toEqual([]);
  });

  it("never joins two flights, even where one starts at the other's end", () => {
    const first = flight(1, { count: 1 });
    const second = flight(2, { count: 1, lat: 50 + 235 * DEG_PER_M });

    expect(heatLineFeatures([...first, ...second], all).features).toHaveLength(
      2,
    );
  });
});

describe("heatLineFeatures smoothing", () => {
  it("does not let one hot cell break a flight into a short hot stretch", () => {
    // A long lone flight, and a second one that shares a single fix of it
    const lone = flight(1, { count: 40 });
    const at = lone[20]!.coords![0];
    const crossing = createSegment({
      path_id: 2,
      coords: [
        [at[0], at[1] - 0.00001],
        [at[0], at[1] + 0.00001],
      ],
      groundspeed_knots: 2,
    });

    const { features } = heatLineFeatures([...lone, crossing], all);

    // The lone flight stays a few long lines, not a string of short ones
    const lines = features.filter((f) => f.geometry.coordinates.length > 2);
    expect(lines.length).toBeLessThanOrEqual(5);
  });

  it("never averages across two flights", () => {
    const cool = flight(1, { count: 5, stepS: 5 });
    const hot = flight(2, {
      count: 5,
      lat: 50 + 5 * 235 * DEG_PER_M,
      stepM: 20,
      stepS: 60,
    });

    const lines = heatLineFeatures([...cool, ...hot], all);

    const coolStart = heatAt(lines, 50, 8);
    const hotEnd = heatAt(lines, 50 + (5 * 235 + 100) * DEG_PER_M, 8);
    expect(hotEnd).toBeGreaterThan(coolStart * 16);
  });
});
