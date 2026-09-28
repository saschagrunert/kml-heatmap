/**
 * The grid of about a square kilometre that tells the places new in a year
 * from those flown before
 */
import { describe, it, expect } from "vitest";
import {
  CELL_KM2,
  cellOf,
  datasetCells,
  newAreaKm2,
  visitedBefore,
  visitedCells,
} from "../../../../kml_heatmap/frontend/calculations/newAreas";
import {
  DEGREES_TO_RADIANS,
  METRES_PER_DEGREE,
} from "../../../../kml_heatmap/frontend/utils/geometry";
import { createDataset, createSegment } from "../../testHelpers";

/** Degrees of latitude, and of longitude at `lat`, per metre */
const latPerM = 1 / METRES_PER_DEGREE;
const lngPerM = (lat: number): number =>
  latPerM / Math.cos(lat * DEGREES_TO_RADIANS);

describe("cellOf", () => {
  it("is a square kilometre", () => {
    expect(CELL_KM2).toBe(1);
  });

  it("puts places a few hundred metres apart into one cell, and a few kilometres apart into others", () => {
    // In the middle of a cell at 51 degrees north
    const lat = (Math.floor(51 / (1000 * latPerM)) + 0.5) * 1000 * latPerM;
    const lng = 12;
    const here = cellOf([lat, lng]);

    expect(cellOf([lat + 300 * latPerM, lng])).toBe(here);
    expect(cellOf([lat + 2000 * latPerM, lng])).not.toBe(here);
    expect(cellOf([lat, lng + 2000 * lngPerM(lat)])).not.toBe(here);
  });

  it("keeps the cells about square from the south to the north", () => {
    for (const lat of [0.5, 45.5, 69.5]) {
      const cells = new Set<number>();
      // Ten kilometres to the east cross about ten cells
      for (let m = 0; m <= 10000; m += 50) {
        cells.add(cellOf([lat, 10 + m * lngPerM(lat)]));
      }
      expect(cells.size).toBeGreaterThanOrEqual(10);
      expect(cells.size).toBeLessThanOrEqual(11);
    }
  });
});

describe("visitedCells", () => {
  it("marks the cells between fixes far apart, not only those of the fixes", () => {
    const lat = 51;
    const segment = createSegment({
      coords: [
        [lat, 12],
        [lat, 12 + 10000 * lngPerM(lat)],
      ],
    });

    const cells = visitedCells([segment]);

    expect(cells.size).toBeGreaterThanOrEqual(10);
    expect(cells.has(cellOf([lat, 12 + 5000 * lngPerM(lat)]))).toBe(true);
  });

  it("has no cells without segments", () => {
    expect(visitedCells([]).size).toBe(0);
  });
});

describe("datasetCells", () => {
  it("works the cells of a dataset out once", () => {
    const data = createDataset(
      [],
      [
        createSegment({
          path_id: 1,
          coords: [
            [51, 12],
            [51, 12.1],
          ],
        }),
      ],
    );

    const cells = datasetCells(data);

    expect(cells).toEqual(visitedCells(data.path_segments));
    expect(datasetCells(data)).toBe(cells);
  });
});

describe("newAreaKm2", () => {
  /** Ten kilometres to the east from `lng` along the latitude 51 */
  const eastFrom = (lng: number) =>
    createSegment({
      path_id: 1,
      coords: [
        [51, lng],
        [51, lng + 10000 * lngPerM(51)],
      ],
    });

  it("counts the cells none of the earlier sets hold", () => {
    const flown = visitedCells([eastFrom(12)]);
    const segments = [eastFrom(12), eastFrom(13)];

    expect(newAreaKm2(segments, [flown])).toBe(
      visitedCells([eastFrom(13)]).size * CELL_KM2,
    );
    expect(newAreaKm2(segments, [])).toBe(
      visitedCells(segments).size * CELL_KM2,
    );
    expect(newAreaKm2([eastFrom(12)], [new Set(), flown])).toBe(0);
  });

  it("finds a cell in any of the earlier sets", () => {
    expect(visitedBefore([new Set([1]), new Set([2])], 2)).toBe(true);
    expect(visitedBefore([new Set([1])], 2)).toBe(false);
    expect(visitedBefore([], 2)).toBe(false);
  });
});
