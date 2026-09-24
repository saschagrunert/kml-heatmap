import { describe, it, expect } from "vitest";
import {
  appendCurve,
  flatCurves,
} from "../../../../kml_heatmap/frontend/calculations/curves";
import { createSegment } from "../../testHelpers";

describe("flatCurves", () => {
  it("works a segment array out once, and another one anew", () => {
    const segments = [createSegment({ path_id: 1 })];

    expect(flatCurves(segments)).toBe(flatCurves(segments));
    expect(flatCurves([...segments])).not.toBe(flatCurves(segments));
  });
});

describe("appendCurve", () => {
  it("carries a line on along a segment's curve, past the antimeridian", () => {
    const segments = [
      createSegment({
        path_id: 1,
        coords: [
          [60, 179.99],
          [60.01, 179.99],
        ],
      }),
      createSegment({
        path_id: 1,
        coords: [
          [60.01, 179.99],
          [60.01, -179.98],
        ],
      }),
    ];
    const curves = flatCurves(segments);
    const line: [number, number][] = [[179.99, 60]];

    appendCurve(line, curves, 0);
    appendCurve(line, curves, 1);

    // A point per 4 degrees of the right angle, never back round the world
    expect(line.length).toBeGreaterThan(3);
    for (const [lng] of line) {
      expect(lng).toBeGreaterThanOrEqual(179.99 - 0.01);
      expect(lng).toBeLessThanOrEqual(180.02 + 1e-9);
    }
    expect(line[line.length - 1]![0]).toBeCloseTo(180.02, 9);
  });

  it("adds nothing for a segment without coordinates", () => {
    const segments = [createSegment({ path_id: 1, coords: undefined })];
    const line: [number, number][] = [[8, 50]];

    appendCurve(line, flatCurves(segments), 0);

    expect(line).toEqual([[8, 50]]);
  });
});
