import { describe, it, expect } from "vitest";
import {
  drawHeat,
  flatLines,
  HEAT_MERGE_ZOOM,
  linesSource,
  type HeatLines,
} from "../../../../kml_heatmap/frontend/services/heatSource";
import { HEAT_LINES } from "../../../../kml_heatmap/frontend/utils/constants";
import {
  exposedHeat,
  heatColumns,
} from "../../../../kml_heatmap/frontend/calculations/heatExposure";
import { heatLineFeatures } from "../../../../kml_heatmap/frontend/calculations/heatLines";
import { createSegment } from "../../testHelpers";

/** `count` points along a line, `[lat, lng]`, and a heat for each */
const line = (
  count: number,
): { points: [number, number][]; weights: number[] } => ({
  points: Array.from({ length: count }, (_, i): [number, number] => [
    50 + i / 7,
    8 + i / 3,
  ]),
  weights: Array.from({ length: count }, (_, i) => 0.5 + i / 11),
});

/** What the heat source used to be handed: a Point per point, heat as `w` */
const features = (
  points: [number, number][],
  weights: ArrayLike<number>,
): GeoJSON.FeatureCollection<GeoJSON.Point, { w: number }> => ({
  type: "FeatureCollection",
  features: points.map(([lat, lng], i) => ({
    type: "Feature",
    properties: { w: weights[i]! },
    geometry: { type: "Point", coordinates: [lng, lat] },
  })),
});

describe("drawHeat", () => {
  it("draws the heat as the heatmap does, and writes the GeoJSON JSON.stringify writes", async () => {
    const { points, weights } = line(3);
    const heat = heatColumns(points, weights);

    const drawn = drawHeat(heat);

    const expected = exposedHeat(heat);
    expect(drawn.exposure).toBe(expected.exposure);
    expect(drawn.source.type).toBe("application/json");
    expect(await drawn.source.text()).toBe(
      JSON.stringify(features(points, expected.weights)),
    );
  });

  it("writes every point of a heat of many parts, and none of none", async () => {
    // Across the parts the text is written in
    const { points, weights } = line(2500);
    const heat = heatColumns(points, weights);
    const drawn = drawHeat(heat);

    expect(await drawn.source.text()).toBe(
      JSON.stringify(features(points, exposedHeat(heat).weights)),
    );
    expect(await drawHeat(new Float64Array(0)).source.text()).toBe(
      '{"type":"FeatureCollection","features":[]}',
    );
  });

  it("merges the fixes of one pixel of the heatmap's last zoom into one point of their heat, where they weigh", async () => {
    // A pixel at 12.75 is about 7 m at 51.5 degrees north; the first three
    // lie within a metre of each other, the last 20 m away
    const points: [number, number][] = [
      [51.500001, 12.000001],
      [51.500003, 12.000005],
      [51.500005, 12.000002],
      [51.5002, 12.0001],
    ];
    const weights = [1, 2, 5, 3];
    const heat = heatColumns(points, weights);

    const { features: drawn } = JSON.parse(
      await drawHeat(heat).source.text(),
    ) as GeoJSON.FeatureCollection<GeoJSON.Point, { w: number; n?: number }>;

    const exposed = exposedHeat(heat).weights;
    expect(drawn).toHaveLength(2);
    const [merged, lone] = drawn as [(typeof drawn)[0], (typeof drawn)[0]];
    const sum = exposed[0]! + exposed[1]! + exposed[2]!;
    expect(merged.properties.w).toBeCloseTo(sum, 12);
    expect(merged.properties.n).toBe(3);
    const mean = (axis: 0 | 1): number =>
      (points[0]![axis] * exposed[0]! +
        points[1]![axis] * exposed[1]! +
        points[2]![axis] * exposed[2]!) /
      sum;
    expect(merged.geometry.coordinates[0]).toBeCloseTo(mean(1), 9);
    expect(merged.geometry.coordinates[1]).toBeCloseTo(mean(0), 9);
    // A point of one fix is written as it was, without a count
    expect(lone).toEqual(features([points[3]!], [exposed[3]!]).features[0]);
  });

  it("merges in the pixels of the last zoom the heatmap is drawn at", () => {
    expect(HEAT_MERGE_ZOOM).toBe(HEAT_LINES.fullZoom);
  });
});

describe("linesSource", () => {
  it("writes the heat lines JSON.stringify writes, from their columns", async () => {
    const segments = Array.from({ length: 6 }, (_, i) =>
      createSegment({
        path_id: 1 + Math.floor(i / 3),
        time: i * 5,
        coords: [
          [50 + i / 100, 8 + i / 90],
          [50 + (i + 1) / 100, 8 + (i + 1) / 90],
        ],
      }),
    );
    const lines = heatLineFeatures(segments, () => true);
    expect(lines.features.length).toBeGreaterThan(1);

    expect(await linesSource(flatLines(lines)).text()).toBe(
      JSON.stringify(lines),
    );
  });

  it("writes a number that is not finite as JSON does, and no lines as none", async () => {
    const lines: HeatLines = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { heat: 2 },
          geometry: {
            type: "LineString",
            coordinates: [
              [NaN, 50],
              [8.1, Infinity],
            ],
          },
        },
      ],
    };

    expect(await linesSource(flatLines(lines)).text()).toBe(
      JSON.stringify(lines),
    );
    expect(
      await linesSource(
        flatLines({ type: "FeatureCollection", features: [] }),
      ).text(),
    ).toBe('{"type":"FeatureCollection","features":[]}');
  });
});

describe("flatLines", () => {
  it("packs the positions of every line one after the other, with where each ends and its heat", () => {
    const lines: HeatLines = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { heat: 1 },
          geometry: {
            type: "LineString",
            coordinates: [
              [8, 50],
              [8.1, 50.1],
            ],
          },
        },
        {
          type: "Feature",
          properties: { heat: 4 },
          geometry: {
            type: "LineString",
            coordinates: [
              [9, 51],
              [9.1, 51.1],
              [9.2, 51.2],
            ],
          },
        },
      ],
    };

    const flat = flatLines(lines);

    expect([...flat.coordinates]).toEqual([
      8, 50, 8.1, 50.1, 9, 51, 9.1, 51.1, 9.2, 51.2,
    ]);
    expect([...flat.ends]).toEqual([2, 5]);
    expect([...flat.heats]).toEqual([1, 4]);
  });
});
