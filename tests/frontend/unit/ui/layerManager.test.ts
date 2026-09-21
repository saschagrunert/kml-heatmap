import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Point, type LngLat, type Map as MapLibreMap } from "maplibre-gl";
import {
  LayerManager,
  isTouchDevice,
} from "../../../../kml_heatmap/frontend/ui/layerManager";
import { addDataLayers } from "../../../../kml_heatmap/frontend/mapLayers";
import {
  getColorForAirspeed,
  getColorForAltitude,
} from "../../../../kml_heatmap/frontend/utils/colors";
import type {
  PathHit,
  PathRunProperties,
  PathSegment,
} from "../../../../kml_heatmap/frontend/types";
import {
  createMockApp,
  createDataset,
  createSegment,
  asMapApp,
  type MockApp,
} from "../../testHelpers";
import {
  Map as MockMap,
  mockControl,
  type Popup as MockPopup,
} from "../../../mocks/maplibre-gl";

// Mock domCache
vi.mock("../../../../kml_heatmap/frontend/utils/domCache", () => ({
  domCache: {
    get: vi.fn((id: string) => document.getElementById(id)),
  },
}));

// The shared fake with one addition: the popups the code under test made
const popups = vi.hoisted((): unknown[] => []);
vi.mock("maplibre-gl", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../mocks/maplibre-gl")>();
  class Popup extends actual.Popup {
    constructor(options: Record<string, unknown> = {}) {
      super(options);
      popups.push(this);
    }
  }
  return { ...actual, Popup, default: { ...actual.default, Popup } };
});

interface RunFeature {
  type: "Feature";
  properties: PathRunProperties;
  geometry: { type: "LineString"; coordinates: [number, number][] };
}

const ALTITUDE = "paths-altitude";
const ALTITUDE_SELECTED = "paths-altitude-selected";
const AIRSPEED = "paths-airspeed";
const AIRSPEED_SELECTED = "paths-airspeed-selected";

/**
 * The middle of the one of 32 equal steps of the range `value` falls in,
 * clamped to the range: what a run of `value` is coloured with
 */
function middle(value: number, min: number, max: number): number {
  const span = Math.max(max - min, 1);
  const step = Math.min(
    Math.max(Math.floor(((value - min) / span) * 32), 0),
    31,
  );
  return min + ((step + 0.5) / 32) * span;
}

/** The colour of a run of `value`, cut at and shown on one range */
function stepColor(
  color: (value: number, min: number, max: number) => string,
  value: number,
  min: number,
  max: number,
): string {
  return color(middle(value, min, max), min, max);
}

/** A zig-zag with a kink of `offset` degrees at every other point */
function zigZag(count: number, offset: number): [number, number][] {
  return Array.from({ length: count }, (_, i) => [
    48 + (i % 2) * offset,
    16 + i * 0.01,
  ]);
}

/** Consecutive segments of one path along `points`, all at `altitude` */
function segmentsAlong(
  points: [number, number][],
  altitude = 3000,
): PathSegment[] {
  return points.slice(1).map((end, i) =>
    createSegment({
      path_id: 1,
      altitude_ft: altitude,
      coords: [points[i]!, end],
    }),
  );
}

describe("LayerManager", () => {
  let layerManager: LayerManager;
  let mockApp: MockApp;
  /** Callbacks waiting for the next animation frame, by their handle */
  let frames: Map<number, FrameRequestCallback>;

  const segA = (): PathSegment =>
    createSegment({
      path_id: 1,
      altitude_ft: 3000,
      groundspeed_knots: 100,
      coords: [
        [48, 16],
        [49, 17],
      ],
    });

  /** A second flight, lower and slower than the first */
  function addSecondPath(): void {
    mockApp.currentData!.path_info.push({
      id: 2,
      year: 2025,
      aircraft_registration: "D-ABCD",
    });
    mockApp.currentData!.path_segments.push(
      createSegment({
        path_id: 2,
        altitude_ft: 2000,
        groundspeed_knots: 80,
        coords: [
          [47, 15],
          [47.5, 15.5],
        ],
      }),
    );
  }

  function features(sourceId: string): RunFeature[] {
    const data = mockApp.map!.source(sourceId).data as {
      type: string;
      features: RunFeature[];
    };
    expect(data.type).toBe("FeatureCollection");
    return data.features;
  }

  function setDataCalls(sourceId: string): number {
    return mockApp.map!.source(sourceId).setData.mock.calls.length;
  }

  function paint(layerId: string): Record<string, unknown> {
    return mockApp.map!.layer(layerId).paint;
  }

  function runFrames(): void {
    const due = [...frames.values()];
    frames.clear();
    for (const callback of due) callback(0);
  }

  /** What the map answers a query with: a feature of a drawn run */
  function rendered(layerId: string, properties: Partial<PathRunProperties>) {
    return { layer: { id: layerId }, properties };
  }

  /** Where the map draws a position of the data */
  function pointAt(lat: number, lng: number): Point {
    return mockApp.map!.project([lng, lat]) as unknown as Point;
  }

  function moveTo(point: Point): void {
    mockApp.map!.emit("mousemove", { point });
    runFrames();
  }

  function tooltips(): MockPopup[] {
    return popups as MockPopup[];
  }

  beforeEach(() => {
    popups.length = 0;
    frames = new Map();
    let handle = 0;
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        frames.set(++handle, callback);
        return handle;
      }),
    );
    vi.stubGlobal(
      "cancelAnimationFrame",
      vi.fn((id: number) => frames.delete(id)),
    );

    for (const id of [
      "legend-min",
      "legend-max",
      "airspeed-legend-min",
      "airspeed-legend-max",
    ]) {
      const el = document.createElement("span");
      el.id = id;
      document.body.appendChild(el);
    }

    mockApp = createMockApp({
      currentData: createDataset(
        [{ id: 1, year: 2025, aircraft_registration: "D-ABCD" }],
        [segA()],
      ),
      altitudeRange: { min: 0, max: 5000 },
      airspeedRange: { min: 0, max: 200 },
    });

    // Attaching the handles is setup, not something the manager did
    mockApp.map!.setLayoutProperty.mockClear();

    layerManager = new LayerManager(asMapApp(mockApp));
  });

  afterEach(() => {
    layerManager.destroy();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
    delete (window as { ontouchstart?: unknown }).ontouchstart;
  });

  describe("legend updates", () => {
    it("formats altitude legend with ft and m", () => {
      layerManager.updateAltitudeLegend(1000, 5000);

      expect(document.getElementById("legend-min")!.textContent).toBe(
        "1,000 ft (305 m)",
      );
      expect(document.getElementById("legend-max")!.textContent).toBe(
        "5,000 ft (1,524 m)",
      );
    });

    it("formats airspeed legend with kt and km/h", () => {
      layerManager.updateAirspeedLegend(100, 200);

      expect(document.getElementById("airspeed-legend-min")!.textContent).toBe(
        "100 kt (185 km/h)",
      );
      expect(document.getElementById("airspeed-legend-max")!.textContent).toBe(
        "200 kt (370 km/h)",
      );
    });

    it("rounds legend values", () => {
      layerManager.updateAltitudeLegend(1234.6, 5678.4);
      expect(document.getElementById("legend-min")!.textContent).toBe(
        "1,235 ft (376 m)",
      );
      expect(document.getElementById("legend-max")!.textContent).toBe(
        "5,678 ft (1,731 m)",
      );
    });

    it("tolerates missing legend elements", () => {
      document.getElementById("legend-min")?.remove();
      expect(() => layerManager.updateAltitudeLegend(0, 1)).not.toThrow();
    });
  });

  describe("redrawAltitudePaths", () => {
    it("returns early if no currentData", () => {
      mockApp.currentData = null;

      layerManager.redrawAltitudePaths();

      expect(setDataCalls(ALTITUDE)).toBe(0);
      expect(setDataCalls(ALTITUDE_SELECTED)).toBe(0);
      expect(mockApp.altitudeLayer.getLayers()).toEqual([]);
    });

    it("hands the main source one LineString per run, longitude first", () => {
      layerManager.redrawAltitudePaths();

      const color = stepColor(getColorForAltitude, 3000, 0, 5000);
      expect(features(ALTITUDE)).toEqual([
        {
          type: "Feature",
          properties: { r: 0, g: 1, pathId: 1, color },
          geometry: {
            type: "LineString",
            coordinates: [
              [16, 48],
              [17, 49],
            ],
          },
        },
      ]);
      // Nothing is selected: the selection's source stays as it was created
      expect(setDataCalls(ALTITUDE_SELECTED)).toBe(0);
      expect(setDataCalls(AIRSPEED)).toBe(0);
      expect(paint(ALTITUDE)["line-opacity"]).toBe(0.85);
      expect(mockApp.map!.layer(ALTITUDE).filter).toBeUndefined();
      expect(mockApp.altitudeLayer.getLayers()).toEqual([
        { pathId: 1, options: { color, weight: 4, opacity: 0.85 } },
      ]);
    });

    it("leaves the visibility of the layers to their handle", () => {
      layerManager.redrawAltitudePaths();

      expect(mockApp.map!.setLayoutProperty).not.toHaveBeenCalled();
      expect(mockApp.altitudeLayer.setVisible).not.toHaveBeenCalled();
    });

    it("counts the generation of a source up with every setData", () => {
      layerManager.redrawAltitudePaths();
      layerManager.redrawAltitudePaths();

      expect(features(ALTITUDE)[0]!.properties.g).toBe(2);
    });

    it("merges contiguous segments in the same colour step into one run", () => {
      mockApp.currentData = createDataset(
        [{ id: 1, year: 2025 }],
        [
          createSegment({
            path_id: 1,
            altitude_ft: 3000,
            coords: [
              [48, 16],
              [48.1, 16.1],
            ],
          }),
          // 5000 / 32 ft to a step: 3100 ft is still in the one of 3000
          createSegment({
            path_id: 1,
            altitude_ft: 3100,
            coords: [
              [48.1, 16.1],
              [48.2, 16.2],
            ],
          }),
          // another colour step: new run
          createSegment({
            path_id: 1,
            altitude_ft: 3500,
            coords: [
              [48.2, 16.2],
              [48.3, 16.3],
            ],
          }),
          // same step but not contiguous: new run
          createSegment({
            path_id: 1,
            altitude_ft: 3500,
            coords: [
              [49, 17],
              [49.1, 17.1],
            ],
          }),
        ],
      );

      layerManager.redrawAltitudePaths();

      const runs = features(ALTITUDE);
      expect(runs.map((f) => f.geometry.coordinates)).toEqual([
        [
          [16, 48],
          [16.1, 48.1],
          [16.2, 48.2],
        ],
        [
          [16.2, 48.2],
          [16.3, 48.3],
        ],
        [
          [17, 49],
          [17.1, 49.1],
        ],
      ]);
      expect(runs.map((f) => f.properties.r)).toEqual([0, 1, 2]);
      expect(mockApp.altitudeLayer.getLayers()).toHaveLength(3);
    });

    it("draws a groundspeed that wanders within a colour step as one run", () => {
      // A step of 0..200 kt is 6.25 kt: 100.1 to 101.9 kt used to be two
      // runs per whole knot crossed
      const points = zigZag(6, 0.01);
      mockApp.currentData = createDataset(
        [{ id: 1, year: 2025 }],
        points.slice(1).map((end, i) =>
          createSegment({
            path_id: 1,
            groundspeed_knots: 100.1 + i * 0.4,
            coords: [points[i]!, end],
          }),
        ),
      );

      layerManager.redrawAirspeedPaths();

      expect(features(AIRSPEED)).toHaveLength(1);
      expect(features(AIRSPEED)[0]!.geometry.coordinates).toEqual(
        points.map(([lat, lng]) => [lng, lat]),
      );
    });

    it("keeps every exported point, leaving simplification to the map", () => {
      mockApp.currentData = createDataset(
        [{ id: 1, year: 2025 }],
        // Kinks of about 5 m, well below a pixel at an overview zoom
        segmentsAlong(zigZag(40, 0.00005)),
      );

      layerManager.redrawAltitudePaths();

      expect(features(ALTITUDE)[0]!.geometry.coordinates).toHaveLength(40);
      expect(mockApp.map!.listenerCount("zoom")).toBe(0);
    });

    it("colours no run further than half a step from its values", () => {
      mockApp.currentData = createDataset(
        [{ id: 1, year: 2025 }],
        segmentsAlong(zigZag(3, 0.01), 5000),
      );

      layerManager.redrawAltitudePaths();

      // The top of the range falls in the last step, not past it
      expect(features(ALTITUDE)[0]!.properties.color).toBe(
        getColorForAltitude(5000 - 5000 / 64, 0, 5000),
      );
    });

    it("never merges segments of different paths", () => {
      mockApp.currentData = createDataset(
        [
          { id: 1, year: 2025 },
          { id: 2, year: 2025 },
        ],
        [
          createSegment({
            path_id: 1,
            coords: [
              [48, 16],
              [48.1, 16.1],
            ],
          }),
          createSegment({
            path_id: 2,
            coords: [
              [48.1, 16.1],
              [48.2, 16.2],
            ],
          }),
        ],
      );

      layerManager.redrawAltitudePaths();

      expect(features(ALTITUDE).map((f) => f.properties.pathId)).toEqual([
        1, 2,
      ]);
    });

    it("draws a selected path on the selection's layer, on its own range", () => {
      mockApp.selectedPathIds.add(1);

      layerManager.redrawAltitudePaths();

      // The main source keeps the path, cut on the full range
      expect(features(ALTITUDE)[0]!.properties.color).toBe(
        stepColor(getColorForAltitude, 3000, 0, 5000),
      );
      const color = stepColor(getColorForAltitude, 3000, 3000, 3000);
      expect(features(ALTITUDE_SELECTED)).toEqual([
        {
          type: "Feature",
          properties: { r: 0, g: 1, pathId: 1, color },
          geometry: {
            type: "LineString",
            coordinates: [
              [16, 48],
              [17, 49],
            ],
          },
        },
      ]);
      expect(paint(ALTITUDE_SELECTED)).toMatchObject({
        "line-width": 6,
        "line-opacity": 1,
      });
      // Drawn once, not a second time dimmed below itself
      expect(mockApp.map!.layer(ALTITUDE).filter).toEqual([
        "!",
        ["in", ["get", "pathId"], ["literal", [1]]],
      ]);
      expect(mockApp.altitudeLayer.getLayers()).toEqual([
        { pathId: 1, options: { color, weight: 6, opacity: 1 } },
      ]);
      expect(document.getElementById("legend-min")!.textContent).toBe(
        "3,000 ft (914 m)",
      );
    });

    it("dims unselected paths when a selection exists", () => {
      addSecondPath();
      mockApp.selectedPathIds.add(1);

      layerManager.redrawAltitudePaths();

      expect(paint(ALTITUDE)["line-opacity"]).toBe(0.1);
      expect(paint(ALTITUDE)["line-width"]).toBe(4);
      expect(
        mockApp.altitudeLayer
          .getLayers()
          .map(({ pathId, options }) => [
            pathId,
            options.weight,
            options.opacity,
          ]),
      ).toEqual([
        [2, 4, 0.1],
        [1, 6, 1],
      ]);
    });

    it("filters segments by year and aircraft", () => {
      mockApp.selectedYear = "2024";
      layerManager.redrawAltitudePaths();
      expect(features(ALTITUDE)).toEqual([]);

      mockApp.selectedYear = "all";
      mockApp.selectedAircraft = "D-EFGH";
      layerManager.redrawAltitudePaths();
      expect(features(ALTITUDE)).toEqual([]);

      mockApp.selectedAircraft = "D-ABCD";
      layerManager.redrawAltitudePaths();
      expect(features(ALTITUDE)).toHaveLength(1);
    });

    it("keeps a selected path the filter hides off the selection's layer", () => {
      addSecondPath();
      mockApp.currentData!.path_info[1]!.year = 2024;
      mockApp.selectedPathIds.add(2);
      mockApp.selectedYear = "2025";

      layerManager.redrawAltitudePaths();

      expect(features(ALTITUDE).map((f) => f.properties.pathId)).toEqual([1]);
      expect(features(ALTITUDE_SELECTED)).toEqual([]);
    });

    it("skips segments without path info when a filter is active", () => {
      mockApp.currentData = createDataset([], [segA()]);
      mockApp.selectedYear = "2025";

      layerManager.redrawAltitudePaths();

      expect(features(ALTITUDE)).toEqual([]);
    });

    it("skips segments without coordinates", () => {
      mockApp.currentData!.path_segments[0]!.coords = undefined;

      layerManager.redrawAltitudePaths();

      expect(features(ALTITUDE)).toEqual([]);
    });

    it("does not compute statistics or airport visibility (callers do)", () => {
      layerManager.redrawAltitudePaths();

      expect(
        mockApp.statsManager.updateStatsForSelection,
      ).not.toHaveBeenCalled();
      expect(
        mockApp.airportManager.updateAirportOpacity,
      ).not.toHaveBeenCalled();
    });

    it("updates the altitude legend with the full range", () => {
      layerManager.redrawAltitudePaths();

      expect(document.getElementById("legend-min")!.textContent).toBe(
        "0 ft (0 m)",
      );
      expect(document.getElementById("legend-max")!.textContent).toBe(
        "5,000 ft (1,524 m)",
      );
    });

    it("shows only the selected runs in isolate mode, at normal weight", () => {
      addSecondPath();
      mockApp.selectedPathIds.add(1);
      mockApp.isolateSelection = true;

      layerManager.redrawAltitudePaths();

      // The main layer shows nothing; its visibility is the handle's
      expect(mockApp.map!.layer(ALTITUDE).filter).toEqual(["literal", false]);
      expect(mockApp.map!.setLayoutProperty).not.toHaveBeenCalled();
      expect(features(ALTITUDE_SELECTED)).toHaveLength(1);
      expect(paint(ALTITUDE_SELECTED)).toMatchObject({
        "line-width": 4,
        "line-opacity": 0.85,
      });
      expect(mockApp.altitudeLayer.getLayers()).toEqual([
        {
          pathId: 1,
          options: {
            color: stepColor(getColorForAltitude, 3000, 3000, 3000),
            weight: 4,
            opacity: 0.85,
          },
        },
      ]);
    });

    it("brings the other paths back when isolate mode ends", () => {
      addSecondPath();
      mockApp.selectedPathIds.add(1);
      mockApp.isolateSelection = true;
      layerManager.redrawAltitudePaths();

      mockApp.isolateSelection = false;
      layerManager.redrawAltitudePaths();

      expect(features(ALTITUDE).map((f) => f.properties.pathId)).toEqual([
        1, 2,
      ]);
      expect(mockApp.map!.layer(ALTITUDE).filter).toEqual([
        "!",
        ["in", ["get", "pathId"], ["literal", [1]]],
      ]);
      expect(paint(ALTITUDE)["line-opacity"]).toBe(0.1);
      expect(paint(ALTITUDE_SELECTED)["line-width"]).toBe(6);
      expect(
        mockApp.altitudeLayer.getLayers().map((entry) => entry.pathId),
      ).toEqual([2, 1]);

      mockApp.selectedPathIds.clear();
      layerManager.redrawAltitudePaths();

      expect(mockApp.map!.layer(ALTITUDE).filter).toBeNull();
      expect(paint(ALTITUDE)["line-opacity"]).toBe(0.85);
    });

    it("sets the filter of the main layer only when it changes", () => {
      layerManager.redrawAltitudePaths();
      layerManager.redrawAltitudePaths();
      expect(mockApp.map!.setFilter).not.toHaveBeenCalled();

      mockApp.selectedPathIds.add(1);
      layerManager.redrawAltitudePaths();
      layerManager.redrawAltitudePaths();
      expect(mockApp.map!.setFilter).toHaveBeenCalledOnce();
    });

    it("falls back to the full range when selected segments are empty", () => {
      mockApp.selectedPathIds.add(999);

      layerManager.redrawAltitudePaths();

      expect(features(ALTITUDE)[0]!.properties.color).toBe(
        stepColor(getColorForAltitude, 3000, 0, 5000),
      );
      expect(features(ALTITUDE_SELECTED)).toEqual([]);
      expect(document.getElementById("legend-max")!.textContent).toBe(
        "5,000 ft (1,524 m)",
      );
    });

    it("finds the selected paths in a dataset that is not grouped by path", () => {
      addSecondPath();
      mockApp.currentData!.path_segments.push(
        createSegment({
          path_id: 1,
          altitude_ft: 4000,
          coords: [
            [49, 17],
            [49.5, 17.5],
          ],
        }),
      );
      mockApp.selectedPathIds.add(1);

      layerManager.redrawAltitudePaths();

      expect(
        features(ALTITUDE_SELECTED).map((f) => f.properties.pathId),
      ).toEqual([1, 1]);
    });
  });

  describe("redrawAirspeedPaths", () => {
    it("returns early if no currentData", () => {
      mockApp.currentData = null;

      layerManager.redrawAirspeedPaths();

      expect(setDataCalls(AIRSPEED)).toBe(0);
    });

    it("draws with airspeed colours and updates the airspeed legend", () => {
      layerManager.redrawAirspeedPaths();

      expect(setDataCalls(ALTITUDE)).toBe(0);
      expect(features(AIRSPEED)[0]!.properties.color).toBe(
        stepColor(getColorForAirspeed, 100, 0, 200),
      );
      expect(document.getElementById("airspeed-legend-max")!.textContent).toBe(
        "200 kt (370 km/h)",
      );
    });

    it("uses selected paths' airspeed range when paths are selected", () => {
      mockApp.selectedPathIds.add(1);

      layerManager.redrawAirspeedPaths();

      expect(features(AIRSPEED_SELECTED)[0]!.properties.color).toBe(
        stepColor(getColorForAirspeed, 100, 100, 100),
      );
    });

    it("skips segments with zero groundspeed", () => {
      mockApp.currentData!.path_segments[0]!.groundspeed_knots = 0;
      mockApp.selectedPathIds.add(1);

      layerManager.redrawAirspeedPaths();

      expect(features(AIRSPEED)).toEqual([]);
      expect(features(AIRSPEED_SELECTED)).toEqual([]);
    });

    it("falls back to the full airspeed range when selection has no speed data", () => {
      mockApp.selectedPathIds.add(999);

      layerManager.redrawAirspeedPaths();

      expect(features(AIRSPEED)[0]!.properties.color).toBe(
        stepColor(getColorForAirspeed, 100, 0, 200),
      );
    });
  });

  describe("before the style has loaded", () => {
    it("draws once the sources exist", async () => {
      layerManager.destroy();
      mockControl.autoLoadStyle = false;
      const map = new MockMap({ container: document.createElement("div") });
      mockControl.autoLoadStyle = true;
      let ready!: (map: MapLibreMap) => void;
      mockApp = createMockApp({
        map,
        currentData: mockApp.currentData,
        altitudeRange: { min: 0, max: 5000 },
      });
      (mockApp as { mapReady: Promise<MapLibreMap> }).mapReady = new Promise(
        (resolve) => (ready = resolve),
      );
      layerManager = new LayerManager(asMapApp(mockApp));

      expect(() => {
        layerManager.redrawAltitudePaths();
        layerManager.redrawAirspeedPaths();
        layerManager.clearLayer("airspeed");
        layerManager.updateSelectionStyles();
      }).not.toThrow();
      expect(layerManager.hitTest(new Point(0, 0))).toBeNull();

      map.finishStyleLoad();
      addDataLayers(map as unknown as MapLibreMap);
      ready(map as unknown as MapLibreMap);
      await Promise.resolve();

      expect(features(ALTITUDE)).toHaveLength(1);
      // Cleared last, so it stays empty
      expect(features(AIRSPEED)).toEqual([]);
    });

    it("logs what goes wrong once the map is ready, and rejects nothing", async () => {
      layerManager.destroy();
      mockControl.autoLoadStyle = false;
      const map = new MockMap({ container: document.createElement("div") });
      mockControl.autoLoadStyle = true;
      let ready!: (map: MapLibreMap) => void;
      mockApp = createMockApp({
        map,
        currentData: mockApp.currentData,
        altitudeRange: { min: 0, max: 5000 },
      });
      (mockApp as { mapReady: Promise<MapLibreMap> }).mapReady = new Promise(
        (resolve) => (ready = resolve),
      );
      layerManager = new LayerManager(asMapApp(mockApp));
      layerManager.redrawAltitudePaths();
      const error = vi.spyOn(console, "error").mockImplementation(() => {});

      // The sources are there, and one of them refuses its data: a source
      // that went missing in a style swap throws the same way
      map.finishStyleLoad();
      addDataLayers(map as unknown as MapLibreMap);
      map.source(ALTITUDE).setData.mockImplementation(() => {
        throw new Error("source is gone");
      });
      ready(map as unknown as MapLibreMap);
      await Promise.resolve();
      await Promise.resolve();

      expect(error).toHaveBeenCalledWith(
        expect.stringContaining("Path layers"),
        expect.objectContaining({ message: "source is gone" }),
      );
      error.mockRestore();
    });

    it("works on the run tables alone in an app without a map", async () => {
      layerManager.destroy();
      mockApp = createMockApp({
        map: null,
        currentData: mockApp.currentData,
      });
      layerManager = new LayerManager(asMapApp(mockApp));

      expect(() => layerManager.redrawAltitudePaths()).not.toThrow();
      await Promise.resolve();

      expect(mockApp.altitudeLayer.getLayers()).toHaveLength(1);
    });
  });

  describe("clearLayer", () => {
    it("empties both sources of the mode and the list of layers", () => {
      mockApp.selectedPathIds.add(1);
      layerManager.redrawAltitudePaths();
      layerManager.redrawAirspeedPaths();
      expect(features(ALTITUDE_SELECTED)).toHaveLength(1);

      layerManager.clearLayer("altitude");

      expect(features(ALTITUDE)).toEqual([]);
      expect(features(ALTITUDE_SELECTED)).toEqual([]);
      expect(mockApp.altitudeLayer.getLayers()).toEqual([]);
      // The other mode is not touched
      expect(features(AIRSPEED)).toHaveLength(1);
    });

    it("leaves a source alone that is empty already", () => {
      layerManager.clearLayer("altitude");

      expect(setDataCalls(ALTITUDE)).toBe(0);
      expect(setDataCalls(ALTITUDE_SELECTED)).toBe(0);
    });
  });

  describe("updateSelectionStyles", () => {
    beforeEach(() => {
      addSecondPath();
    });

    it("rebuilds only the selection's source and dims the main layer", () => {
      mockApp.altitudeVisible = true;
      layerManager.redrawAltitudePaths();
      const before = features(ALTITUDE);

      mockApp.selectedPathIds.add(1);
      layerManager.updateSelectionStyles();

      // The main source keeps the data and the generation it had
      expect(setDataCalls(ALTITUDE)).toBe(1);
      expect(features(ALTITUDE)).toBe(before);
      expect(setDataCalls(ALTITUDE_SELECTED)).toBe(1);
      // Path 1 is cut at the colour steps of the selection's range now
      expect(features(ALTITUDE_SELECTED).map((f) => f.properties)).toEqual([
        {
          r: 0,
          g: 1,
          pathId: 1,
          color: stepColor(getColorForAltitude, 3000, 3000, 3000),
        },
      ]);
      expect(mockApp.map!.setPaintProperty).toHaveBeenCalledWith(
        ALTITUDE,
        "line-opacity",
        0.1,
      );
      expect(mockApp.map!.layer(ALTITUDE).filter).toEqual([
        "!",
        ["in", ["get", "pathId"], ["literal", [1]]],
      ]);
      expect(mockApp.altitudeLayer.getLayers()).toEqual([
        {
          pathId: 2,
          options: {
            color: stepColor(getColorForAltitude, 2000, 0, 5000),
            weight: 4,
            opacity: 0.1,
          },
        },
        {
          pathId: 1,
          options: {
            color: stepColor(getColorForAltitude, 3000, 3000, 3000),
            weight: 6,
            opacity: 1,
          },
        },
      ]);
      expect(document.getElementById("legend-min")!.textContent).toBe(
        "3,000 ft (914 m)",
      );
    });

    it("cuts a selected path at the colour steps of its own range", () => {
      // 3000 and 3100 ft share one of 32 steps of 0..5000 ft, but are the
      // two ends of the selected path's range
      const points = zigZag(3, 0.01);
      mockApp.currentData = createDataset(
        [{ id: 1, year: 2025 }],
        [
          createSegment({
            path_id: 1,
            altitude_ft: 3000,
            coords: [points[0]!, points[1]!],
          }),
          createSegment({
            path_id: 1,
            altitude_ft: 3100,
            coords: [points[1]!, points[2]!],
          }),
        ],
      );
      mockApp.altitudeVisible = true;
      layerManager.redrawAltitudePaths();
      expect(features(ALTITUDE)).toHaveLength(1);

      mockApp.selectedPathIds.add(1);
      layerManager.updateSelectionStyles();

      expect(
        features(ALTITUDE_SELECTED).map((f) => f.properties.color),
      ).toEqual([
        stepColor(getColorForAltitude, 3000, 3000, 3100),
        stepColor(getColorForAltitude, 3100, 3000, 3100),
      ]);
    });

    it("returns a path to the main layer when it is deselected", () => {
      mockApp.altitudeVisible = true;
      mockApp.selectedPathIds.add(1);
      layerManager.redrawAltitudePaths();

      mockApp.selectedPathIds.clear();
      layerManager.updateSelectionStyles();

      expect(setDataCalls(ALTITUDE)).toBe(1);
      expect(features(ALTITUDE_SELECTED)).toEqual([]);
      expect(paint(ALTITUDE)["line-opacity"]).toBe(0.85);
      expect(mockApp.map!.layer(ALTITUDE).filter).toBeNull();
      expect(
        mockApp.altitudeLayer.getLayers().map((entry) => entry.options),
      ).toEqual([
        {
          color: stepColor(getColorForAltitude, 3000, 0, 5000),
          weight: 4,
          opacity: 0.85,
        },
        {
          color: stepColor(getColorForAltitude, 2000, 0, 5000),
          weight: 4,
          opacity: 0.85,
        },
      ]);
      expect(document.getElementById("legend-max")!.textContent).toBe(
        "5,000 ft (1,524 m)",
      );
    });

    it("counts the selection's generation up, leaving stale features behind", () => {
      mockApp.altitudeVisible = true;
      layerManager.redrawAltitudePaths();

      mockApp.selectedPathIds.add(1);
      layerManager.updateSelectionStyles();
      mockApp.selectedPathIds.add(2);
      layerManager.updateSelectionStyles();

      expect(features(ALTITUDE_SELECTED).map((f) => f.properties.g)).toEqual([
        2, 2,
      ]);
      expect(features(ALTITUDE)[0]!.properties.g).toBe(1);
    });

    it("skips hidden layers", () => {
      mockApp.altitudeVisible = false;
      layerManager.redrawAltitudePaths();

      mockApp.selectedPathIds.add(1);
      layerManager.updateSelectionStyles();

      expect(setDataCalls(ALTITUDE_SELECTED)).toBe(0);
      expect(paint(ALTITUDE)["line-opacity"]).toBe(0.85);
    });

    it("does nothing for a visible layer that was never drawn", () => {
      mockApp.altitudeVisible = true;
      mockApp.selectedPathIds.add(1);

      layerManager.updateSelectionStyles();

      expect(setDataCalls(ALTITUDE)).toBe(0);
      expect(setDataCalls(ALTITUDE_SELECTED)).toBe(0);
    });

    it("does nothing for a layer that was cleared", () => {
      mockApp.altitudeVisible = true;
      layerManager.redrawAltitudePaths();
      layerManager.clearLayer("altitude");

      mockApp.selectedPathIds.add(1);
      layerManager.updateSelectionStyles();

      expect(features(ALTITUDE_SELECTED)).toEqual([]);
    });

    it("updates the airspeed layer when visible", () => {
      mockApp.airspeedVisible = true;
      layerManager.redrawAirspeedPaths();

      mockApp.selectedPathIds.add(2);
      layerManager.updateSelectionStyles();

      expect(setDataCalls(ALTITUDE_SELECTED)).toBe(0);
      expect(features(AIRSPEED_SELECTED).map((f) => f.properties)).toEqual([
        {
          r: 0,
          g: 1,
          pathId: 2,
          color: stepColor(getColorForAirspeed, 80, 80, 80),
        },
      ]);
      expect(paint(AIRSPEED)["line-opacity"]).toBe(0.1);
      expect(document.getElementById("airspeed-legend-min")!.textContent).toBe(
        "80 kt (148 km/h)",
      );
    });
  });

  describe("isTouchDevice", () => {
    it("returns false when no touch support", () => {
      expect(isTouchDevice()).toBe(false);
    });

    it("asks the hover media query when the browser has one", () => {
      // A laptop with a touchscreen is driven by its mouse most of the
      // time; touch support alone lost it the hover tooltips
      let hoverless = false;
      Object.defineProperty(window, "matchMedia", {
        value: vi.fn((query: string) => ({
          matches: query === "(hover: none)" && hoverless,
        })),
        configurable: true,
        writable: true,
      });
      (window as { ontouchstart?: unknown }).ontouchstart = null;
      try {
        expect(isTouchDevice()).toBe(false);
        hoverless = true;
        expect(isTouchDevice()).toBe(true);
      } finally {
        delete (window as { matchMedia?: unknown }).matchMedia;
      }
    });

    it("returns true when ontouchstart exists", () => {
      (window as { ontouchstart?: unknown }).ontouchstart = null;
      expect(isTouchDevice()).toBe(true);
    });

    it("returns true when maxTouchPoints > 0", () => {
      const original = navigator.maxTouchPoints;
      Object.defineProperty(navigator, "maxTouchPoints", {
        value: 1,
        configurable: true,
      });
      try {
        expect(isTouchDevice()).toBe(true);
      } finally {
        Object.defineProperty(navigator, "maxTouchPoints", {
          value: original,
          configurable: true,
        });
      }
    });
  });

  describe("hitTest", () => {
    /** One path of two segments that merge into one run, slow then fast */
    function drawMergedRun(): PathSegment[] {
      const segments = [
        createSegment({
          path_id: 1,
          altitude_ft: 3000,
          groundspeed_knots: 90,
          coords: [
            [48, 16],
            [48.1, 16.1],
          ],
        }),
        createSegment({
          path_id: 1,
          altitude_ft: 3000,
          groundspeed_knots: 120,
          coords: [
            [48.1, 16.1],
            [48.2, 16.2],
          ],
        }),
      ];
      mockApp.currentData = createDataset([{ id: 1, year: 2025 }], segments);
      mockApp.altitudeLayer.setVisible(true);
      layerManager.redrawAltitudePaths();
      expect(features(ALTITUDE)).toHaveLength(1);
      return segments;
    }

    it("finds nothing while no colour layer is shown", () => {
      layerManager.redrawAltitudePaths();
      mockApp.map!.renderedFeatures = [rendered(ALTITUDE, { r: 0, g: 1 })];

      expect(layerManager.hitTest(new Point(10, 10))).toBeNull();
      expect(mockApp.map!.queryRenderedFeatures).not.toHaveBeenCalled();
    });

    it("finds nothing on a layer that is shown but was cleared", () => {
      mockApp.altitudeLayer.setVisible(true);

      expect(layerManager.hitTest(new Point(10, 10))).toBeNull();
      expect(mockApp.map!.queryRenderedFeatures).not.toHaveBeenCalled();
    });

    it("asks for the visible path layers in a box of 5 px around the pointer", () => {
      drawMergedRun();

      expect(layerManager.hitTest(new Point(100, 50))).toBeNull();

      expect(mockApp.map!.queryRenderedFeatures).toHaveBeenCalledWith(
        [
          [95, 45],
          [105, 55],
        ],
        { layers: [ALTITUDE, ALTITUDE_SELECTED] },
      );
    });

    it("widens the box to 12 px for a finger", () => {
      drawMergedRun();
      (window as { ontouchstart?: unknown }).ontouchstart = null;

      layerManager.hitTest(new Point(100, 50));

      expect(mockApp.map!.queryRenderedFeatures).toHaveBeenCalledWith(
        [
          [88, 38],
          [112, 62],
        ],
        expect.anything(),
      );
    });

    it("returns the path and the segment of the run nearest to the point", () => {
      const [slow, fast] = drawMergedRun();
      mockApp.map!.renderedFeatures = [rendered(ALTITUDE, { r: 0, g: 1 })];

      expect(layerManager.hitTest(pointAt(48.19, 16.19))).toEqual({
        pathId: 1,
        segment: fast,
      });
      expect(layerManager.hitTest(pointAt(48.01, 16.01))).toEqual({
        pathId: 1,
        segment: slow,
      });
    });

    it("drops features of a generation before the last setData", () => {
      drawMergedRun();
      layerManager.redrawAltitudePaths();
      mockApp.map!.renderedFeatures = [rendered(ALTITUDE, { r: 0, g: 1 })];

      // Not null: a flight may well be there, the tiles cannot tell yet
      expect(layerManager.hitTest(pointAt(48.1, 16.1))).toBe("stale");

      mockApp.map!.renderedFeatures = [rendered(ALTITUDE, { r: 0, g: 2 })];
      expect(layerManager.hitTest(pointAt(48.1, 16.1))).toMatchObject({
        pathId: 1,
      });
    });

    it("prefers a current feature over the stale ones beside it", () => {
      drawMergedRun();
      layerManager.redrawAltitudePaths();
      mockApp.map!.renderedFeatures = [
        rendered(ALTITUDE, { r: 0, g: 1 }),
        rendered(ALTITUDE, { r: 0, g: 2 }),
      ];

      expect(layerManager.hitTest(pointAt(48.1, 16.1))).toMatchObject({
        pathId: 1,
      });
    });

    it("finds the segment under a point in a copy of the world", () => {
      const [slow] = drawMergedRun();
      mockApp.map!.renderedFeatures = [rendered(ALTITUDE, { r: 0, g: 1 })];
      // One world to the east: 360 degrees further. Taken as it is, every
      // segment is far away and the eastern one the nearest.
      const point = pointAt(48.01, 16.01 + 360);

      expect(layerManager.hitTest(point)).toEqual({ pathId: 1, segment: slow });
    });

    it("ranks the runs by their distance in the copy of the world hit", () => {
      addSecondPath();
      mockApp.altitudeLayer.setVisible(true);
      layerManager.redrawAltitudePaths();
      mockApp.map!.renderedFeatures = [
        rendered(ALTITUDE, { r: 0, g: 1 }),
        rendered(ALTITUDE, { r: 1, g: 1 }),
      ];

      // Measured against the primary world, both runs are a world's width
      // away and the one further east, path 1, is the nearer by as much as
      // it lies east. The pointer is on path 2.
      for (const worlds of [1, -1, 2]) {
        expect(
          layerManager.hitTest(pointAt(47.25, 15.25 + 360 * worlds)),
        ).toMatchObject({ pathId: 2 });
        expect(
          layerManager.hitTest(pointAt(48.5, 16.5 + 360 * worlds)),
        ).toMatchObject({ pathId: 1 });
      }
    });

    it("takes a flight across the antimeridian from the copy drawn under the pointer", () => {
      // Two flights either side of 180 degrees, drawn next to each other:
      // the eastern one in the pointer's copy of the world, the western one
      // in the next. One offset for both put the second a world away.
      const east = createSegment({
        path_id: 1,
        altitude_ft: 3000,
        coords: [
          [10, 179.9],
          [10.1, 179.95],
        ],
      });
      const west = createSegment({
        path_id: 2,
        altitude_ft: 1000,
        coords: [
          [10, -179.98],
          [10.1, -179.9],
        ],
      });
      mockApp.currentData = createDataset(
        [
          { id: 1, year: 2025 },
          { id: 2, year: 2025 },
        ],
        [east, west],
      );
      mockApp.map!.setCenter([179.97, 10]);
      mockApp.altitudeLayer.setVisible(true);
      layerManager.redrawAltitudePaths();
      mockApp.map!.renderedFeatures = [
        rendered(ALTITUDE, { r: 0, g: 1 }),
        rendered(ALTITUDE, { r: 1, g: 1 }),
      ];

      // The pointer stands at 179.97, in the primary world, 0.01 degrees
      // from where the western flight is drawn (180.02) and 0.02 from the
      // eastern one
      expect(layerManager.hitTest(pointAt(10, 179.99))).toMatchObject({
        pathId: 2,
      });
      expect(layerManager.hitTest(pointAt(10, 179.92))).toMatchObject({
        pathId: 1,
      });
    });

    it("cannot tell while a source has not taken in its last data", () => {
      // The tiles of before have nothing here, where the new data may well
      // have a flight: a filter change that adds flights
      drawMergedRun();
      mockApp.map!.isSourceLoaded.mockImplementation(
        (id: string) => id !== ALTITUDE,
      );

      expect(layerManager.hitTest(pointAt(48.1, 16.1))).toBe("stale");

      // Nor when all the tiles had were features nobody can place
      mockApp.map!.renderedFeatures = [rendered(ALTITUDE, { r: 7, g: 1 })];
      expect(layerManager.hitTest(pointAt(48.1, 16.1))).toBe("stale");

      mockApp.map!.isSourceLoaded.mockImplementation(() => true);
      expect(layerManager.hitTest(pointAt(48.1, 16.1))).toBeNull();
    });

    it("drops features whose run is not in the table", () => {
      drawMergedRun();
      mockApp.map!.renderedFeatures = [
        rendered(ALTITUDE, { r: 7, g: 1 }),
        rendered(ALTITUDE, { g: 1 }),
        rendered("replay-trail", { r: 0, g: 1 }),
      ];

      expect(layerManager.hitTest(pointAt(48.1, 16.1))).toBeNull();
    });

    it("measures a run once however many tiles return it", () => {
      drawMergedRun();
      mockApp.map!.renderedFeatures = [rendered(ALTITUDE, { r: 0, g: 1 })];
      layerManager.hitTest(pointAt(48.1, 16.1));
      const once = mockApp.map!.project.mock.calls.length;
      mockApp.map!.project.mockClear();

      mockApp.map!.renderedFeatures = [
        rendered(ALTITUDE, { r: 0, g: 1 }),
        rendered(ALTITUDE, { r: 0, g: 1 }),
        rendered(ALTITUDE, { r: 0, g: 1 }),
      ];
      layerManager.hitTest(pointAt(48.1, 16.1));

      expect(mockApp.map!.project.mock.calls.length).toBe(once);
    });

    it("prefers the run that is closest in pixels", () => {
      addSecondPath();
      mockApp.altitudeLayer.setVisible(true);
      layerManager.redrawAltitudePaths();
      mockApp.map!.renderedFeatures = [
        rendered(ALTITUDE, { r: 0, g: 1 }),
        rendered(ALTITUDE, { r: 1, g: 1 }),
      ];

      expect(layerManager.hitTest(pointAt(47.25, 15.25))).toMatchObject({
        pathId: 2,
      });
      expect(layerManager.hitTest(pointAt(48.5, 16.5))).toMatchObject({
        pathId: 1,
      });
    });

    it("lets a selected run win a tie", () => {
      const [, fast] = drawMergedRun();
      mockApp.selectedPathIds.add(1);
      mockApp.altitudeVisible = true;
      layerManager.updateSelectionStyles();
      // The selection's runs are cut on its own range, like the main ones
      // here; the segment objects tell which table answered
      const project = mockApp.map!.project;
      project.mockClear();
      mockApp.map!.renderedFeatures = [
        rendered(ALTITUDE, { r: 0, g: 1 }),
        rendered(ALTITUDE_SELECTED, { r: 0, g: 1 }),
      ];

      const hit = layerManager.hitTest(pointAt(48.19, 16.19));

      expect(hit).toEqual({ pathId: 1, segment: fast });
      // Both runs were measured: two ends each, after `pointAt`
      expect(project).toHaveBeenCalledTimes(5);
    });

    it("ignores the main runs of other paths in isolate mode", () => {
      addSecondPath();
      mockApp.altitudeLayer.setVisible(true);
      mockApp.selectedPathIds.add(1);
      mockApp.isolateSelection = true;
      layerManager.redrawAltitudePaths();
      // Tiles cut before the filter still show path 2
      mockApp.map!.renderedFeatures = [rendered(ALTITUDE, { r: 1, g: 1 })];

      expect(layerManager.hitTest(pointAt(47.25, 15.25))).toBeNull();

      mockApp.map!.renderedFeatures = [
        rendered(ALTITUDE_SELECTED, { r: 0, g: 1 }),
      ];
      expect(layerManager.hitTest(pointAt(48.5, 16.5))).toMatchObject({
        pathId: 1,
      });
    });

    it("queries both modes when both are shown", () => {
      mockApp.altitudeLayer.setVisible(true);
      mockApp.airspeedLayer.setVisible(true);
      layerManager.redrawAltitudePaths();
      layerManager.redrawAirspeedPaths();
      mockApp.map!.renderedFeatures = [rendered(AIRSPEED, { r: 0, g: 1 })];

      expect(layerManager.hitTest(pointAt(48.5, 16.5))).toMatchObject({
        pathId: 1,
      });
      expect(mockApp.map!.queryRenderedFeatures).toHaveBeenCalledWith(
        expect.anything(),
        {
          layers: [ALTITUDE, ALTITUDE_SELECTED, AIRSPEED, AIRSPEED_SELECTED],
        },
      );
    });
  });

  describe("hover tooltip", () => {
    beforeEach(() => {
      mockApp.currentData = createDataset(
        [{ id: 1, year: 2025 }],
        [
          createSegment({
            path_id: 1,
            altitude_ft: 3000,
            groundspeed_knots: 90,
            coords: [
              [48, 16],
              [48.1, 16.1],
            ],
          }),
          createSegment({
            path_id: 1,
            altitude_ft: 3000,
            groundspeed_knots: 120,
            coords: [
              [48.1, 16.1],
              [48.2, 16.2],
            ],
          }),
        ],
      );
      mockApp.altitudeLayer.setVisible(true);
      mockApp.altitudeVisible = true;
      layerManager.redrawAltitudePaths();
      mockApp.map!.renderedFeatures = [rendered(ALTITUDE, { r: 0, g: 1 })];
    });

    function content(popup: MockPopup): string {
      return popup.getElement().querySelector(".maplibregl-popup-content")!
        .innerHTML;
    }

    it("keeps the tooltip while the tiles only answer with stale features", () => {
      moveTo(pointAt(48.19, 16.19));
      const tooltip = tooltips()[0]!;
      // Drawn again: generation 2, and the tiles still hold generation 1
      layerManager.redrawAltitudePaths();

      moveTo(pointAt(48.18, 16.18));

      expect(tooltip.isOpen()).toBe(true);
      expect(content(tooltip)).toContain("120 kt");
    });

    it("opens one popup that tracks the pointer, with the segment's values", () => {
      const point = pointAt(48.19, 16.19);
      moveTo(point);

      expect(tooltips()).toHaveLength(1);
      const tooltip = tooltips()[0]!;
      expect(tooltip.options).toMatchObject({
        closeButton: false,
        closeOnClick: false,
        className: "segment-details segment-tooltip",
        maxWidth: "none",
        offset: 10,
      });
      expect(tooltip.isOpen()).toBe(true);
      expect(tooltip.map).toBe(mockApp.map);
      // Placed under the pointer first: a tracking popup has no position
      // of its own until the pointer moves again
      expect(tooltip.getLngLat()).toEqual(mockApp.map!.unproject(point));
      expect(tooltip.tracksPointer).toBe(true);
      expect(content(tooltip)).toContain("120 kt");
      expect(mockApp.map!.getCanvas().style.cursor).toBe("pointer");
    });

    it("looks under the pointer once per frame", () => {
      mockApp.map!.emit("mousemove", { point: pointAt(48.19, 16.19) });
      mockApp.map!.emit("mousemove", { point: pointAt(48.18, 16.18) });
      mockApp.map!.emit("mousemove", { point: pointAt(48.01, 16.01) });

      expect(requestAnimationFrame).toHaveBeenCalledOnce();
      expect(mockApp.map!.queryRenderedFeatures).not.toHaveBeenCalled();

      runFrames();

      expect(mockApp.map!.queryRenderedFeatures).toHaveBeenCalledOnce();
      // The last position counts
      expect(content(tooltips()[0]!)).toContain("90 kt");
    });

    it("sets the content only when the nearest segment changes", () => {
      moveTo(pointAt(48.19, 16.19));
      const tooltip = tooltips()[0]!;
      expect(tooltip.setHTML).toHaveBeenCalledOnce();

      // Same nearest segment: no content update
      moveTo(pointAt(48.18, 16.18));
      expect(tooltip.setHTML).toHaveBeenCalledOnce();
      expect(tooltip.addTo).toHaveBeenCalledOnce();

      moveTo(pointAt(48.01, 16.01));
      expect(tooltip.setHTML).toHaveBeenCalledTimes(2);
      expect(content(tooltip)).toContain("90 kt");
      expect(tooltips()).toHaveLength(1);
    });

    it("closes beside every flight and reuses the popup on the next one", () => {
      moveTo(pointAt(48.19, 16.19));
      const tooltip = tooltips()[0]!;

      mockApp.map!.renderedFeatures = [];
      moveTo(pointAt(40, 10));

      expect(tooltip.isOpen()).toBe(false);
      expect(mockApp.map!.getCanvas().style.cursor).toBe("");

      mockApp.map!.renderedFeatures = [rendered(ALTITUDE, { r: 0, g: 1 })];
      moveTo(pointAt(48.19, 16.19));

      expect(tooltips()).toHaveLength(1);
      expect(tooltip.isOpen()).toBe(true);
      expect(tooltip.tracksPointer).toBe(true);
      expect(content(tooltip)).toContain("120 kt");
    });

    it("closes when the pointer leaves the map", () => {
      moveTo(pointAt(48.19, 16.19));

      mockApp.map!.emit("mouseout");

      expect(tooltips()[0]!.isOpen()).toBe(false);
    });

    it("colours the tooltip chips on the range the runs use", () => {
      // Path 2 is selected: its range, not the full one, colours the map
      mockApp.currentData!.path_info.push({ id: 2, year: 2025 });
      mockApp.currentData!.path_segments.push(
        createSegment({
          path_id: 2,
          altitude_ft: 1000,
          groundspeed_knots: 50,
          coords: [
            [47, 15],
            [47.5, 15.5],
          ],
        }),
      );
      mockApp.selectedPathIds.add(2);
      layerManager.redrawAltitudePaths();
      mockApp.map!.renderedFeatures = [rendered(ALTITUDE, { r: 0, g: 2 })];

      moveTo(pointAt(48.19, 16.19));

      const html = content(tooltips()[0]!);
      const chip = (color: string): string => {
        const probe = document.createElement("span");
        probe.style.color = color;
        return probe.style.color;
      };
      expect(html).toContain("3,000 ft");
      expect(
        [
          getColorForAltitude(3000, 1000, 1000),
          chip(getColorForAltitude(3000, 1000, 1000)),
        ].some((color) => html.includes(color)),
      ).toBe(true);
      expect(html).not.toContain(getColorForAltitude(3000, 0, 5000));
    });

    it("shows no hover tooltip on touch devices", () => {
      (window as { ontouchstart?: unknown }).ontouchstart = null;

      moveTo(pointAt(48.19, 16.19));

      expect(tooltips()).toHaveLength(0);
    });

    it("follows the run that replaces the hovered one after a selection", () => {
      // Selecting rebuilds the runs of the path, and the tiles answer with
      // the old ones until the map has drawn the new data
      mockApp.pathSelection.togglePathSelection.mockImplementation(
        (id: number) => {
          mockApp.selectedPathIds.add(id);
          layerManager.updateSelectionStyles();
        },
      );
      const point = pointAt(48.19, 16.19);
      moveTo(point);
      const tooltip = tooltips()[0]!;
      const hit = layerManager.hitTest(point) as PathHit;
      mockApp.map!.queryRenderedFeatures.mockClear();

      layerManager.onPathClick(hit, mockApp.map!.unproject(point) as LngLat);

      expect(mockApp.map!.listenerCount("idle")).toBe(1);
      expect(mockApp.map!.queryRenderedFeatures).not.toHaveBeenCalled();

      mockApp.map!.renderedFeatures = [
        rendered(ALTITUDE_SELECTED, { r: 0, g: 1 }),
      ];
      mockApp.map!.emit("idle");

      expect(mockApp.map!.queryRenderedFeatures).toHaveBeenCalledOnce();
      expect(tooltip.isOpen()).toBe(true);
      // Written again: the range the chips are coloured on has changed
      expect(tooltip.setHTML).toHaveBeenCalledTimes(2);
      expect(mockApp.map!.listenerCount("idle")).toBe(0);
    });

    it("does not wait for idle without a pointer on the map", () => {
      mockApp.selectedPathIds.add(1);
      layerManager.updateSelectionStyles();

      expect(mockApp.map!.listenerCount("idle")).toBe(0);
    });
  });

  describe("onPathClick", () => {
    function hitOf(segment: PathSegment) {
      return { pathId: segment.path_id, segment };
    }

    it("opens a popup with the segment's values on touch and toggles the selection", () => {
      (window as { ontouchstart?: unknown }).ontouchstart = null;
      const lngLat = mockApp.map!.unproject([10, 10]) as LngLat;

      layerManager.onPathClick(
        hitOf(mockApp.currentData!.path_segments[0]!),
        lngLat,
      );

      expect(tooltips()).toHaveLength(1);
      const popup = tooltips()[0]!;
      // Not the tooltip's class, which takes no pointer events: this one
      // has a close button, and a tap through it would hit the flight below
      expect(popup.options).toMatchObject({
        className: "segment-details segment-popup",
        // MapLibre would close it on a click the dispatcher ignores as well
        closeOnClick: false,
      });
      expect(String(popup.options["className"])).not.toContain(
        "segment-tooltip",
      );
      expect(popup.trackPointer).not.toHaveBeenCalled();
      expect(popup.getLngLat()).toEqual(lngLat);
      expect(popup.isOpen()).toBe(true);
      expect(popup.getElement().innerHTML).toContain("3,000 ft");
      expect(mockApp.pathSelection.togglePathSelection).toHaveBeenCalledWith(1);
    });

    it("replaces the popup of the tap before", () => {
      (window as { ontouchstart?: unknown }).ontouchstart = null;
      const lngLat = mockApp.map!.unproject([10, 10]) as LngLat;
      const hit = hitOf(mockApp.currentData!.path_segments[0]!);

      layerManager.onPathClick(hit, lngLat);
      layerManager.onPathClick(hit, lngLat);

      expect(tooltips().map((popup) => popup.isOpen())).toEqual([false, true]);
    });

    it("opens no popup on a click with a mouse but toggles the selection", () => {
      layerManager.onPathClick(
        hitOf(mockApp.currentData!.path_segments[0]!),
        mockApp.map!.unproject([10, 10]) as LngLat,
      );

      expect(tooltips()).toHaveLength(0);
      expect(mockApp.pathSelection.togglePathSelection).toHaveBeenCalledWith(1);
    });
  });

  describe("a pointer over a marker", () => {
    function onMarker(): Event {
      const marker = document.createElement("button");
      marker.className = "maplibregl-marker";
      const label = document.createElement("span");
      marker.append(label);
      mockApp.map!.getCanvasContainer().append(marker);
      const event = new MouseEvent("mousemove", { bubbles: true });
      // What the map reports is aimed at whatever is inside the marker
      label.dispatchEvent(event);
      return event;
    }

    beforeEach(() => {
      mockApp.altitudeLayer.setVisible(true);
      layerManager.redrawAltitudePaths();
      mockApp.map!.renderedFeatures = [rendered(ALTITUDE, { r: 0, g: 1 })];
    });

    it("closes the hover's tooltip and leaves the values of a tap open", () => {
      moveTo(pointAt(48.5, 16.5));
      (window as { ontouchstart?: unknown }).ontouchstart = null;
      layerManager.onPathClick(
        { pathId: 1, segment: mockApp.currentData!.path_segments[0]! },
        mockApp.map!.unproject([10, 10]) as LngLat,
      );
      delete (window as { ontouchstart?: unknown }).ontouchstart;
      expect(tooltips().map((popup) => popup.isOpen())).toEqual([true, true]);

      // The flight runs on below the marker, so the same point would hit
      mockApp.map!.emit("mousemove", {
        point: pointAt(48.5, 16.5),
        originalEvent: onMarker(),
      });
      runFrames();

      expect(tooltips().map((popup) => popup.isOpen())).toEqual([false, true]);
      expect(mockApp.map!.getCanvas().style.cursor).toBe("");
    });

    it("stands down a hover that was already waiting for its frame", () => {
      mockApp.map!.emit("mousemove", { point: pointAt(48.5, 16.5) });

      mockApp.map!.emit("mousemove", {
        point: pointAt(48.5, 16.5),
        originalEvent: onMarker(),
      });
      runFrames();

      expect(tooltips().filter((popup) => popup.isOpen())).toHaveLength(0);
    });
  });

  describe("a hover the tiles cannot answer yet", () => {
    it("looks again on idle, also when the pointer came after the redraw", () => {
      mockApp.altitudeLayer.setVisible(true);
      // The pointer is off the map, so the redraw asks for no look on idle
      layerManager.redrawAltitudePaths();
      expect(mockApp.map!.listenerCount("idle")).toBe(0);
      mockApp.map!.isSourceLoaded.mockReturnValue(false);

      moveTo(pointAt(48.5, 16.5));
      expect(tooltips()).toHaveLength(0);
      expect(mockApp.map!.listenerCount("idle")).toBe(1);

      mockApp.map!.isSourceLoaded.mockReturnValue(true);
      mockApp.map!.renderedFeatures = [rendered(ALTITUDE, { r: 0, g: 1 })];
      mockApp.map!.emit("idle");

      expect(tooltips().filter((popup) => popup.isOpen())).toHaveLength(1);
    });
  });

  describe("while the Wrapped dialog shows the map as its overview", () => {
    beforeEach(() => {
      mockApp.altitudeLayer.setVisible(true);
      layerManager.redrawAltitudePaths();
      mockApp.map!.renderedFeatures = [rendered(ALTITUDE, { r: 0, g: 1 })];
    });

    it("shows no tooltip for a flight under the pointer", () => {
      mockApp.store.set("wrappedVisible", true);

      mockApp.map!.emit("mousemove", { point: pointAt(48.5, 16.5) });
      // Not even a frame that would find nothing to do
      expect(frames.size).toBe(0);
      moveTo(pointAt(48.5, 16.5));

      expect(tooltips()).toHaveLength(0);
      expect(mockApp.map!.queryRenderedFeatures).not.toHaveBeenCalled();

      mockApp.store.set("wrappedVisible", false);
      moveTo(pointAt(48.5, 16.5));
      expect(tooltips().filter((popup) => popup.isOpen())).toHaveLength(1);
    });

    it("does not bring the tooltip back when the data is drawn again", () => {
      // The pointer rests where it was when the dialog opened
      moveTo(pointAt(48.5, 16.5));
      mockApp.store.set("wrappedVisible", true);
      layerManager.closeSegmentPopup();

      layerManager.redrawAltitudePaths();
      mockApp.map!.renderedFeatures = [rendered(ALTITUDE, { r: 0, g: 2 })];
      mockApp.map!.emit("idle");

      expect(tooltips().filter((popup) => popup.isOpen())).toHaveLength(0);
    });
  });

  describe("destroy", () => {
    it("listens to the pointer once per map", () => {
      expect(mockApp.map!.listenerCount("mousemove")).toBe(1);
      expect(mockApp.map!.listenerCount("mouseout")).toBe(1);
    });

    it("removes the listeners, the popups and the pending frame", () => {
      mockApp.altitudeLayer.setVisible(true);
      layerManager.redrawAltitudePaths();
      mockApp.map!.renderedFeatures = [rendered(ALTITUDE, { r: 0, g: 1 })];
      moveTo(pointAt(48.5, 16.5));
      (window as { ontouchstart?: unknown }).ontouchstart = null;
      layerManager.onPathClick(
        { pathId: 1, segment: mockApp.currentData!.path_segments[0]! },
        mockApp.map!.unproject([10, 10]) as LngLat,
      );
      delete (window as { ontouchstart?: unknown }).ontouchstart;
      mockApp.map!.emit("mousemove", { point: pointAt(48.5, 16.5) });
      expect(frames.size).toBe(1);
      expect(tooltips().map((popup) => popup.isOpen())).toEqual([true, true]);

      layerManager.destroy();

      expect(mockApp.map!.listenerCount("mousemove")).toBe(0);
      expect(mockApp.map!.listenerCount("mouseout")).toBe(0);
      expect(cancelAnimationFrame).toHaveBeenCalledOnce();
      expect(frames.size).toBe(0);
      expect(tooltips().map((popup) => popup.isOpen())).toEqual([false, false]);
      expect(mockApp.map!.getCanvas().style.cursor).toBe("");
      expect(mockApp.altitudeLayer.getLayers()).toEqual([]);
    });

    it("ignores an idle that arrives afterwards", () => {
      mockApp.altitudeLayer.setVisible(true);
      mockApp.altitudeVisible = true;
      layerManager.redrawAltitudePaths();
      mockApp.map!.emit("mousemove", { point: pointAt(48.5, 16.5) });
      layerManager.updateSelectionStyles();
      mockApp.map!.queryRenderedFeatures.mockClear();

      layerManager.destroy();
      mockApp.map!.emit("idle");

      expect(mockApp.map!.queryRenderedFeatures).not.toHaveBeenCalled();
    });
  });
});
