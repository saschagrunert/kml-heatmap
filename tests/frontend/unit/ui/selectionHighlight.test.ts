/**
 * The lines of the selected flights over the heatmap: their data follows
 * the selection and the dataset (whether they show is layerVisibility's
 * business, see its tests).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  followSelectionHighlight,
  selectionLines,
} from "../../../../kml_heatmap/frontend/ui/selectionHighlight";
import { MAP_SOURCES } from "../../../../kml_heatmap/frontend/utils/constants";
import {
  asMapApp,
  createDataset,
  createMockApp,
  createSegment,
  type MockApp,
} from "../../testHelpers";
import { resetMapLibreMock } from "../../../mocks/maplibre-gl";

/** Two flights of two segments each that meet, and a third one */
function dataset(): ReturnType<typeof createDataset> {
  return createDataset(
    [
      { id: 1, year: 2025 },
      { id: 2, year: 2025 },
      { id: 3, year: 2024 },
    ],
    [
      createSegment({
        path_id: 1,
        coords: [
          [50, 8],
          [50.1, 8.1],
        ],
      }),
      createSegment({
        path_id: 1,
        coords: [
          [50.1, 8.1],
          [50.2, 8.2],
        ],
      }),
      createSegment({
        path_id: 2,
        coords: [
          [51, 9],
          [51.1, 9.1],
        ],
      }),
      createSegment({
        path_id: 2,
        coords: [
          [51.1, 9.1],
          [51.2, 9.2],
        ],
      }),
      createSegment({
        path_id: 3,
        coords: [
          [52, 10],
          [52.1, 10.1],
        ],
      }),
    ],
  );
}

describe("selection highlight", () => {
  let app: MockApp;

  const lines = (): number[][][] =>
    (
      app.map!.source(MAP_SOURCES.selectionHighlight)
        .data as GeoJSON.FeatureCollection<GeoJSON.LineString>
    ).features.map((feature) => feature.geometry.coordinates);
  const select = (...ids: number[]): void => {
    app.selectedPathIds.clear();
    for (const id of ids) app.selectedPathIds.add(id);
    app.store.notifyMutation("selectedPathIds");
  };

  beforeEach(() => {
    app = createMockApp({ currentData: dataset() });
    followSelectionHighlight(asMapApp(app));
  });

  afterEach(() => {
    resetMapLibreMock();
  });

  it("draws one line per selected flight, and none without a selection", () => {
    expect(lines()).toEqual([]);

    select(2);
    expect(lines()).toEqual([
      [
        [9, 51],
        [9.1, 51.1],
        [9.2, 51.2],
      ],
    ]);

    select(1, 2);
    expect(lines()).toHaveLength(2);

    select();
    expect(lines()).toEqual([]);
  });

  it("follows another dataset with the same selection", () => {
    select(1);
    const source = app.map!.source(MAP_SOURCES.selectionHighlight);
    source.setData.mockClear();

    app.currentData = createDataset(
      [{ id: 1, year: 2025 }],
      [
        createSegment({
          path_id: 1,
          coords: [
            [40, 1],
            [40.1, 1.1],
          ],
        }),
      ],
    );

    expect(source.setData).toHaveBeenCalledOnce();
    expect(lines()).toEqual([
      [
        [1, 40],
        [1.1, 40.1],
      ],
    ]);
  });

  it("writes nothing while nothing is or was selected", () => {
    const source = app.map!.source(MAP_SOURCES.selectionHighlight);
    source.setData.mockClear();

    app.currentData = dataset();

    expect(source.setData).not.toHaveBeenCalled();
  });

  it("writes the lines again once the map has its WebGL context back", () => {
    select(1);
    const map = app.map!;
    const source = map.source(MAP_SOURCES.selectionHighlight);
    source.setData.mockClear();

    map.emit("webglcontextrestored");
    map.emit("style.load");

    expect(source.setData).toHaveBeenCalledOnce();
    expect(lines()).toHaveLength(1);
  });

  describe("selectionLines", () => {
    it("draws a line per flight, and skips a segment without a position", () => {
      const collection = selectionLines([
        createSegment({ path_id: 1 }),
        createSegment({ path_id: 1, coords: undefined }),
        createSegment({ path_id: 2 }),
      ]);

      expect(collection.features).toHaveLength(2);
    });

    it("starts the segment after a gap where it starts", () => {
      const collection = selectionLines([
        createSegment({
          path_id: 1,
          coords: [
            [50, 10],
            [50, 11],
          ],
        }),
        createSegment({ path_id: 1, coords: undefined }),
        createSegment({
          path_id: 1,
          coords: [
            [50, 12],
            [50, 13],
          ],
        }),
      ]);

      expect(collection.features[0]!.geometry.coordinates).toEqual([
        [10, 50],
        [11, 50],
        [12, 50],
        [13, 50],
      ]);
    });

    it("goes on past the antimeridian instead of round the world", () => {
      const collection = selectionLines([
        createSegment({
          path_id: 1,
          coords: [
            [60, 179.9],
            [60, -179.9],
          ],
        }),
        createSegment({
          path_id: 1,
          coords: [
            [60, -179.9],
            [60, -179.7],
          ],
        }),
      ]);

      const [line] = collection.features;
      expect(line!.geometry.coordinates.map(([lng]) => lng)).toEqual([
        179.9, 180.1, 180.3,
      ]);
    });
  });
});
