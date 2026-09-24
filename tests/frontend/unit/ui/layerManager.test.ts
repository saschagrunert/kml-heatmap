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
import {
  liftExaggeration,
  liftOffsetPx,
} from "../../../../kml_heatmap/frontend/calculations/lift";
import { findNearestSegment } from "../../../../kml_heatmap/frontend/features/layers";
import { HILLSHADE_LAYER } from "../../../../kml_heatmap/frontend/ui/terrain";
import { MAP_LAYERS } from "../../../../kml_heatmap/frontend/utils/constants";

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

// The feature bundle, as far as the relief of the 3D view takes it
const featureBundle = vi.hoisted(() => ({ available: true }));
vi.mock("../../../../kml_heatmap/frontend/services/featureLoader", async () => {
  const { followTerrain } =
    await import("../../../../kml_heatmap/frontend/ui/terrain");
  return {
    loadFeatures: vi.fn(() =>
      Promise.resolve(featureBundle.available ? { followTerrain } : null),
    ),
  };
});

interface RunFeature {
  type: "Feature";
  properties: PathRunProperties;
  geometry:
    | { type: "LineString"; coordinates: [number, number][] }
    | { type: "MultiPolygon"; coordinates: number[][][][] };
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

/**
 * Points of a turn: `count` of them round a circle of a kilometre, `step`
 * degrees of turn apart
 */
function turn(count: number, step: number): [number, number][] {
  return Array.from({ length: count }, (_, i) => {
    const angle = (i * step * Math.PI) / 180;
    return [
      48 + 0.01 * Math.sin(angle),
      16 + (0.01 * Math.cos(angle)) / Math.cos((48 * Math.PI) / 180),
    ];
  });
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

  /** Whether a feature passes a filter of the shapes the manager writes */
  function passes(filter: unknown, properties: PathRunProperties): boolean {
    const evaluate = (expression: unknown): unknown => {
      if (!Array.isArray(expression)) return expression;
      const [op, ...args] = expression as [string, ...unknown[]];
      if (op === "literal") return args[0];
      if (op === "get") return properties[args[0] as keyof PathRunProperties];
      if (op === "!") return !evaluate(args[0]);
      if (op === "all") return args.every((arg) => evaluate(arg) === true);
      if (op === "has") return (args[0] as string) in properties;
      if (op === "in") {
        return (evaluate(args[1]) as unknown[]).includes(evaluate(args[0]));
      }
      throw new Error(`unknown expression "${op}"`);
    };
    return filter == null || evaluate(filter) === true;
  }

  /**
   * What the map is told to draw of a mode, in drawing order: every feature
   * of the two sources that its layer's filter lets through, with the width
   * and opacity of that layer's paint
   */
  function drawn(mode: "altitude" | "airspeed"): {
    pathId: number;
    options: { color: string; weight: number; opacity: number };
  }[] {
    const layers =
      mode === "altitude"
        ? [ALTITUDE, ALTITUDE_SELECTED]
        : [AIRSPEED, AIRSPEED_SELECTED];
    return layers.flatMap((id) => {
      const layer = mockApp.map!.layer(id);
      return features(id)
        .filter((feature) => passes(layer.filter, feature.properties))
        .map(({ properties }) => ({
          pathId: properties.pathId,
          options: {
            color: properties.color,
            weight: layer.paint["line-width"] as number,
            opacity: layer.paint["line-opacity"] as number,
          },
        }));
    });
  }

  /** A main layer's filter, which follows the selection; null for none */
  function selectionFilter(layerId: string): unknown {
    return mockApp.map!.layer(layerId).filter ?? null;
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

  /**
   * Let the data of the last draw land: the fake's `setData` settles at
   * once, and the manager hears of it a microtask later
   */
  function landed(): Promise<void> {
    return Promise.resolve();
  }

  /** A `setData` that stays with the worker until the test lets it go */
  function holdSetData(sourceId: string): () => Promise<void> {
    let release!: () => void;
    mockApp
      .map!.source(sourceId)
      .setData.mockReturnValueOnce(
        new Promise<void>((resolve) => (release = resolve)),
      );
    return async () => {
      release();
      await landed();
    };
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
      expect(drawn("altitude")).toEqual([]);
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
      expect(selectionFilter(ALTITUDE)).toBeNull();
      expect(drawn("altitude")).toEqual([
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
      expect(drawn("altitude")).toHaveLength(3);
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
      // Along the curve through the fixes (see calculations/curves.ts): the
      // fixes are points of the line, in order, with the curve's between
      const line = features(AIRSPEED)[0]!.geometry.coordinates;
      expect(line.length).toBeGreaterThan(points.length);
      let at = 0;
      for (const [lat, lng] of points) {
        at = line.findIndex((p, i) => i >= at && p[0] === lng && p[1] === lat);
        expect(at).toBeGreaterThanOrEqual(0);
      }
    });

    it("draws the runs of a turn along one curve, cut at the fixes", () => {
      const points = turn(7, 30);
      const draw = (altitudes: number[]): [number, number][][] => {
        mockApp.currentData = createDataset(
          [{ id: 1, year: 2025 }],
          points.slice(1).map((end, i) =>
            createSegment({
              path_id: 1,
              altitude_ft: altitudes[i]!,
              coords: [points[i]!, end],
            }),
          ),
        );
        layerManager.redrawAltitudePaths();
        return features(ALTITUDE).map(
          (feature) => feature.geometry.coordinates as [number, number][],
        );
      };
      const [whole] = draw([3000, 3000, 3000, 3000, 3000, 3000]);
      // A point every 4 degrees of the turn at most, 8 to a segment
      expect(whole).toHaveLength(6 * 8 + 1);

      const runs = draw([3000, 5000, 3000, 5000, 3000, 5000]);
      expect(runs).toHaveLength(6);
      runs.forEach((run, i) => {
        // A colour changes at a fix, where one run ends and the next starts
        expect(run[0]).toEqual([points[i]![1], points[i]![0]]);
        expect(run[run.length - 1]).toEqual([
          points[i + 1]![1],
          points[i + 1]![0],
        ]);
      });
      // End to end they are the line of the whole flight, point for point
      expect(runs.flatMap((run, i) => (i === 0 ? run : run.slice(1)))).toEqual(
        whole,
      );
    });

    it("carries a flight on across the antimeridian instead of round the world", () => {
      mockApp.currentData = createDataset(
        [{ id: 1, year: 2025 }],
        segmentsAlong([
          [60, 179.98],
          [60, 179.99],
          [60, -179.99],
          [60, -179.98],
        ]),
      );

      layerManager.redrawAltitudePaths();

      expect(
        features(ALTITUDE)[0]!.geometry.coordinates.map(([lng]) => lng),
      ).toEqual([
        179.98,
        179.99,
        expect.closeTo(180.01, 9),
        expect.closeTo(180.02, 9),
      ]);
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
      expect(selectionFilter(ALTITUDE)).toEqual([
        "!",
        ["in", ["get", "pathId"], ["literal", [1]]],
      ]);
      expect(drawn("altitude")).toEqual([
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
        drawn("altitude").map(({ pathId, options }) => [
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
      expect(selectionFilter(ALTITUDE)).toEqual(["literal", false]);
      expect(mockApp.map!.setLayoutProperty).not.toHaveBeenCalled();
      expect(features(ALTITUDE_SELECTED)).toHaveLength(1);
      expect(paint(ALTITUDE_SELECTED)).toMatchObject({
        "line-width": 4,
        "line-opacity": 0.85,
      });
      expect(drawn("altitude")).toEqual([
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
      expect(selectionFilter(ALTITUDE)).toEqual([
        "!",
        ["in", ["get", "pathId"], ["literal", [1]]],
      ]);
      expect(paint(ALTITUDE)["line-opacity"]).toBe(0.1);
      expect(paint(ALTITUDE_SELECTED)["line-width"]).toBe(6);
      expect(drawn("altitude").map((entry) => entry.pathId)).toEqual([2, 1]);

      mockApp.selectedPathIds.clear();
      layerManager.redrawAltitudePaths();

      expect(selectionFilter(ALTITUDE)).toBeNull();
      expect(paint(ALTITUDE)["line-opacity"]).toBe(0.85);
    });

    it("sets the filter of the main layer only when it changes", () => {
      layerManager.redrawAltitudePaths();
      layerManager.redrawAltitudePaths();
      expect(mockApp.map!.setFilter).not.toHaveBeenCalled();

      mockApp.selectedPathIds.add(1);
      layerManager.redrawAltitudePaths();
      layerManager.redrawAltitudePaths();
      // Once for the lines and once for the ribbons of the same source
      expect(mockApp.map!.setFilter).toHaveBeenCalledTimes(2);
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

    it("cuts its runs without throwing in an app without a map", async () => {
      layerManager.destroy();
      mockApp = createMockApp({
        map: null,
        currentData: mockApp.currentData,
      });
      layerManager = new LayerManager(asMapApp(mockApp));

      expect(() => layerManager.redrawAltitudePaths()).not.toThrow();
      await Promise.resolve();
    });
  });

  describe("clearLayer", () => {
    it("empties both sources of the mode", () => {
      mockApp.selectedPathIds.add(1);
      layerManager.redrawAltitudePaths();
      layerManager.redrawAirspeedPaths();
      expect(features(ALTITUDE_SELECTED)).toHaveLength(1);

      layerManager.clearLayer("altitude");

      expect(features(ALTITUDE)).toEqual([]);
      expect(features(ALTITUDE_SELECTED)).toEqual([]);
      expect(drawn("altitude")).toEqual([]);
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
      expect(selectionFilter(ALTITUDE)).toEqual([
        "!",
        ["in", ["get", "pathId"], ["literal", [1]]],
      ]);
      expect(drawn("altitude")).toEqual([
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
      expect(selectionFilter(ALTITUDE)).toBeNull();
      expect(drawn("altitude").map((entry) => entry.options)).toEqual([
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

    it("asks for the visible path layers in a box of 5 px around the pointer", async () => {
      drawMergedRun();
      await landed();

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

    it("gives a point of the curve to the segment it lies on", () => {
      const points = turn(7, 30);
      const segments = segmentsAlong(points);
      mockApp.currentData = createDataset([{ id: 1, year: 2025 }], segments);
      mockApp.altitudeLayer.setVisible(true);
      layerManager.redrawAltitudePaths();
      mockApp.map!.renderedFeatures = [rendered(ALTITUDE, { r: 0, g: 1 })];
      const line = features(ALTITUDE)[0]!.geometry.coordinates;

      // The points of the line between fix i and fix i + 1 are segment i's
      let segment = 0;
      for (let k = 0; k + 1 < line.length; k++) {
        const [lng0, lat0] = line[k] as [number, number];
        const [lng1, lat1] = line[k + 1] as [number, number];
        const fix = points[segment + 1]!;
        if (k > 0 && lat0 === fix[0] && lng0 === fix[1]) segment++;
        const lat = (lat0 + lat1) / 2;
        const lng = (lng0 + lng1) / 2;
        expect(layerManager.hitTest(pointAt(lat, lng))).toEqual({
          pathId: 1,
          segment: segments[segment],
        });
      }
      expect(segment).toBe(segments.length - 1);
    });

    it("ranks the runs by the curve they are drawn along, not their fixes", () => {
      // A point on the curve of a turn, between two of its fixes, which
      // bulges out of the straight line between them
      const points = turn(7, 30);
      const turning = segmentsAlong(points);
      const line = (): [number, number][] =>
        features(ALTITUDE)[0]!.geometry.coordinates as [number, number][];
      mockApp.currentData = createDataset([{ id: 1, year: 2025 }], turning);
      layerManager.redrawAltitudePaths();
      const [a, b] = [line()[20]!, line()[21]!];
      const on: [number, number] = [(a[1] + b[1]) / 2, (a[0] + b[0]) / 2];
      // How far it is from that line, and which way (the map's pixels are
      // degrees here)
      const [from, to] = turning[2]!.coords!;
      const along = [to[0] - from[0], to[1] - from[1]];
      const length = Math.hypot(along[0]!, along[1]!);
      const unit = [along[0]! / length, along[1]! / length];
      const t = (on[0] - from[0]) * unit[0]! + (on[1] - from[1]) * unit[1]!;
      const off = [
        on[0] - from[0] - t * unit[0]!,
        on[1] - from[1] - t * unit[1]!,
      ];
      // A second flight, straight, half as far out on the other side
      const passing: [number, number] = [
        on[0] + off[0]! / 2,
        on[1] + off[1]! / 2,
      ];
      const straight = createSegment({
        path_id: 2,
        altitude_ft: 3000,
        coords: [
          [passing[0] - unit[0]! * 0.01, passing[1] - unit[1]! * 0.01],
          [passing[0] + unit[0]! * 0.01, passing[1] + unit[1]! * 0.01],
        ],
      });
      mockApp.currentData = createDataset(
        [
          { id: 1, year: 2025 },
          { id: 2, year: 2025 },
        ],
        [...turning, straight],
      );
      mockApp.altitudeLayer.setVisible(true);
      layerManager.redrawAltitudePaths();
      mockApp.map!.renderedFeatures = [
        rendered(ALTITUDE, { r: 1, g: 2 }),
        rendered(ALTITUDE, { r: 0, g: 2 }),
      ];

      // Its fixes' straight line is further than the other flight
      expect(findNearestSegment([...turning, straight], ...on)).toBe(straight);
      expect(layerManager.hitTest(pointAt(...on))).toEqual({
        pathId: 1,
        segment: turning[2],
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

    it("cannot tell until the last data has landed, worker and tiles", async () => {
      // The tiles of before have nothing here, where the new data may well
      // have a flight: a filter change that adds flights
      drawMergedRun();
      await landed();
      const workerAnswers = holdSetData(ALTITUDE);
      layerManager.redrawAltitudePaths();
      const point = pointAt(48.1, 16.1);

      expect(layerManager.hitTest(point)).toBe("stale");
      // Nor when all the tiles had were features nobody can place
      mockApp.map!.renderedFeatures = [rendered(ALTITUDE, { r: 7, g: 2 })];
      expect(layerManager.hitTest(point)).toBe("stale");

      // The worker has the data; the tiles in view are still being cut
      mockApp.map!.isSourceLoaded.mockReturnValue(false);
      await workerAnswers();
      expect(layerManager.hitTest(point)).toBe("stale");

      mockApp.map!.isSourceLoaded.mockReturnValue(true);
      expect(layerManager.hitTest(point)).toBeNull();
    });

    it("takes a camera move for none of that", async () => {
      // Tiles load during every pan and zoom, and the source is not loaded
      // then either: a click on the empty map is still one
      drawMergedRun();
      await landed();
      mockApp.map!.isSourceLoaded.mockReturnValue(false);

      expect(layerManager.hitTest(pointAt(48.1, 16.1))).toBeNull();
    });

    it("leaves an earlier draw that lands late to the later one", async () => {
      drawMergedRun();
      await landed();
      const first = holdSetData(ALTITUDE);
      layerManager.redrawAltitudePaths();
      const second = holdSetData(ALTITUDE);
      layerManager.redrawAltitudePaths();

      await first();
      expect(layerManager.hitTest(pointAt(48.1, 16.1))).toBe("stale");

      await second();
      expect(layerManager.hitTest(pointAt(48.1, 16.1))).toBeNull();
    });

    it("finds the segment under the pointer in a run that crosses the antimeridian", async () => {
      // One run of one colour step: two segments east of 180 degrees as
      // the data has it, one west of it
      const points: [number, number][] = [
        [10, 178],
        [10, 179],
        [10, 179.9],
        [10, -179.9],
        [10, -179],
      ];
      const segments = points.slice(1).map((to, i) =>
        createSegment({
          path_id: 1,
          altitude_ft: 3000,
          coords: [points[i]!, to],
        }),
      );
      mockApp.currentData = createDataset([{ id: 1, year: 2025 }], segments);
      mockApp.map!.setCenter([180, 10]);
      mockApp.altitudeLayer.setVisible(true);
      layerManager.redrawAltitudePaths();
      await landed();
      expect(features(ALTITUDE)).toHaveLength(1);
      mockApp.map!.renderedFeatures = [rendered(ALTITUDE, { r: 0, g: 1 })];

      // The map reports the pointer unwrapped, east of 180 here. Searched
      // with the wrapped longitude, every eastern segment was 358 degrees
      // away, and searched with the unwrapped one every western one.
      expect(layerManager.hitTest(pointAt(10, 180.5))).toMatchObject({
        segment: segments[3],
      });
      expect(layerManager.hitTest(pointAt(10, 178.4))).toMatchObject({
        segment: segments[0],
      });
      expect(layerManager.hitTest(pointAt(10, 179.5))).toMatchObject({
        segment: segments[1],
      });
    });

    it("drops features whose run is not in the table", async () => {
      drawMergedRun();
      await landed();
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

    it("ignores the main runs of other paths in isolate mode", async () => {
      addSecondPath();
      mockApp.altitudeLayer.setVisible(true);
      mockApp.selectedPathIds.add(1);
      mockApp.isolateSelection = true;
      layerManager.redrawAltitudePaths();
      await landed();
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

    it("closes the popup of a tap once the globe has turned its place away", () => {
      (window as { ontouchstart?: unknown }).ontouchstart = null;
      mockApp.map!.setProjection({ type: "globe" });
      const lngLat = mockApp.map!.unproject([10, 10]) as LngLat;
      layerManager.onPathClick(
        hitOf(mockApp.currentData!.path_segments[0]!),
        lngLat,
      );
      const popup = tooltips()[0]!;

      mockApp.map!.emit("move");
      expect(popup.isOpen()).toBe(true);

      // MapLibre would leave it open over whatever is drawn there now
      mockApp.map!.jumpTo({ center: [lngLat.lng + 170, lngLat.lat] });
      mockApp.map!.emit("move");
      expect(popup.isOpen()).toBe(false);
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

    describe("once the map has moved under a pointer that rests", () => {
      /** What the document finds under the pointer from now on */
      function under(element: Element | null): void {
        (
          document as { elementFromPoint?: (x: number, y: number) => unknown }
        ).elementFromPoint = vi.fn(() => element);
      }

      afterEach(() => {
        // jsdom has none of its own
        delete (document as { elementFromPoint?: unknown }).elementFromPoint;
      });

      it("shows the flight a zoom has brought out from under the marker", () => {
        const originalEvent = onMarker();
        mockApp.map!.emit("mousemove", {
          point: pointAt(48.5, 16.5),
          originalEvent,
        });
        runFrames();
        expect(tooltips()).toHaveLength(0);

        // The marker has moved away; the event still names it
        under(mockApp.map!.getCanvas());
        layerManager.redrawAltitudePaths();
        mockApp.map!.renderedFeatures = [rendered(ALTITUDE, { r: 0, g: 2 })];
        mockApp.map!.emit("idle");

        expect(tooltips().filter((popup) => popup.isOpen())).toHaveLength(1);
      });

      it("closes the tooltip a zoom has slid a marker under", () => {
        const onCanvas = new MouseEvent("mousemove", { bubbles: true });
        mockApp.map!.getCanvas().dispatchEvent(onCanvas);
        mockApp.map!.emit("mousemove", {
          point: pointAt(48.5, 16.5),
          originalEvent: onCanvas,
        });
        runFrames();
        expect(tooltips()[0]!.isOpen()).toBe(true);

        under((onMarker().target as Element).closest(".maplibregl-marker"));
        layerManager.redrawAltitudePaths();
        mockApp.map!.renderedFeatures = [rendered(ALTITUDE, { r: 0, g: 2 })];
        mockApp.map!.emit("idle");

        expect(tooltips()[0]!.isOpen()).toBe(false);
      });
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
    beforeEach(async () => {
      mockApp.altitudeLayer.setVisible(true);
      layerManager.redrawAltitudePaths();
      await landed();
    });

    it("looks again on idle, also when the pointer came after the redraw", async () => {
      // The pointer is off the map, so the redraw asks for no look on idle
      const workerAnswers = holdSetData(ALTITUDE);
      layerManager.redrawAltitudePaths();
      expect(mockApp.map!.listenerCount("idle")).toBe(0);

      moveTo(pointAt(48.5, 16.5));
      expect(tooltips()).toHaveLength(0);
      expect(mockApp.map!.listenerCount("idle")).toBe(1);

      await workerAnswers();
      mockApp.map!.renderedFeatures = [rendered(ALTITUDE, { r: 0, g: 2 })];
      mockApp.map!.emit("idle");

      expect(tooltips().filter((popup) => popup.isOpen())).toHaveLength(1);
    });

    it("keeps the tooltip over a flight of the tiles of before, and only there", () => {
      mockApp.map!.renderedFeatures = [rendered(ALTITUDE, { r: 0, g: 1 })];
      moveTo(pointAt(48.5, 16.5));
      expect(tooltips()[0]!.isOpen()).toBe(true);
      holdSetData(ALTITUDE);
      layerManager.redrawAltitudePaths();

      // The flight may well still be there
      moveTo(pointAt(48.51, 16.51));
      expect(tooltips()[0]!.isOpen()).toBe(true);

      // Over nothing at all there is nothing to go on showing
      mockApp.map!.renderedFeatures = [];
      moveTo(pointAt(40, 10));
      expect(tooltips()[0]!.isOpen()).toBe(false);
      expect(mockApp.map!.getCanvas().style.cursor).toBe("");
    });

    it("does not take a zoom for one: the tooltip closes beside the flight at once", () => {
      mockApp.map!.renderedFeatures = [rendered(ALTITUDE, { r: 0, g: 1 })];
      moveTo(pointAt(48.5, 16.5));
      // Tiles are loading, as during every wheel zoom
      mockApp.map!.isSourceLoaded.mockReturnValue(false);
      mockApp.map!.renderedFeatures = [];

      moveTo(pointAt(40, 10));

      expect(tooltips()[0]!.isOpen()).toBe(false);
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

  /**
   * Until the relief's code has arrived with the feature bundle: from
   * any zoom, the 3D view cuts the flights once it has
   */
  const terrainCode = (): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve));

  describe("the 3D view", () => {
    const RIBBONS = "paths-altitude-3d";
    const RIBBONS_SELECTED = "paths-altitude-selected-3d";

    /** A climb from the ground at 1000 ft to 1100 ft, then level */
    function drawClimb(): void {
      mockApp.currentData = createDataset(
        [{ id: 1, year: 2025 }],
        [
          createSegment({
            path_id: 1,
            altitude_ft: 1000,
            coords: [
              [48, 16],
              [48, 16.01],
            ],
          }),
          createSegment({
            path_id: 1,
            altitude_ft: 1100,
            coords: [
              [48, 16.01],
              [48, 16.02],
            ],
          }),
          createSegment({
            path_id: 1,
            altitude_ft: 1100,
            coords: [
              [48, 16.02],
              [48, 16.03],
            ],
          }),
        ],
      );
      mockApp.altitudeRange = { min: 0, max: 32000 };
      mockApp.store.set("threeDVisible", true);
      mockApp.altitudeLayer.setVisible(true);
      layerManager.redrawAltitudePaths();
    }

    const ribbons = (): RunFeature[] => features(RIBBONS);

    /** How far apart the two edges of a ribbon's first quad are, in metres */
    const ribbonWidthM = (): number => {
      const geometry = ribbons()[0]!.geometry as GeoJSON.MultiPolygon;
      const [a, , , d] = geometry.coordinates[0]![0]! as [number, number][];
      const metresPerDegree = 111320;
      const dLng =
        (d![0] - a![0]) * metresPerDegree * Math.cos((48 * Math.PI) / 180);
      const dLat = (d![1] - a![1]) * metresPerDegree;
      return Math.hypot(dLng, dLat);
    };

    it("writes each run as ribbon pieces of the same run in place of its line", () => {
      drawClimb();

      // To a source of their own, which is not simplified
      expect(features(ALTITUDE)).toEqual([]);
      expect(ribbons().length).toBeGreaterThan(1);
      for (const ribbon of ribbons()) {
        expect(ribbon.geometry.type).toBe("MultiPolygon");
        // One run: the table answers for all of its pieces
        expect(ribbon.properties).toMatchObject({ r: 0, g: 1, pathId: 1 });
      }
    });

    it("stands the ribbon on the flight's ground and slopes it with the climb", () => {
      drawClimb();

      // The ground of this flight is where it spent the lowest of its time,
      // 1000 ft: level on it, then 100 ft of climb cut into pieces of 20 ft,
      // each at the height of its middle, then level at the top
      expect(ribbons().map((ribbon) => ribbon.properties.h)).toEqual([
        0, 10, 30, 50, 70, 90, 100,
      ]);
    });

    it("writes no ribbon outside the 3D view", () => {
      drawClimb();
      mockApp.store.set("threeDVisible", false);

      expect(ribbons()).toEqual([]);
      expect(features(ALTITUDE)).toHaveLength(1);
    });

    it("draws the ribbons a few pixels wide, cut again for another zoom level", async () => {
      mockApp.map!.jumpTo({ zoom: 7.2 });
      drawClimb();
      await terrainCode();
      const at7 = ribbonWidthM();
      const writes = setDataCalls(RIBBONS);

      // Within the level nothing is cut again
      mockApp.map!.jumpTo({ zoom: 7.9 });
      mockApp.map!.emit("zoomend");
      expect(setDataCalls(RIBBONS)).toBe(writes);

      // A level further in, half as wide on the ground: as wide on screen.
      // Let go of first, as the relief and its ground change with it.
      mockApp.map!.jumpTo({ zoom: 8.1 });
      mockApp.map!.emit("zoomend");
      expect(setDataCalls(RIBBONS)).toBe(writes + 2);
      expect(ribbonWidthM()).toBeCloseTo(at7 / 2, 3);
      // About 3 pixels at zoom 8.5, 512 px tiles, at 48 degrees
      const metresPerPixel =
        (40075016.686 * Math.cos((48 * Math.PI) / 180)) / (512 * 2 ** 8.5);
      expect(ribbonWidthM() / metresPerPixel).toBeCloseTo(3, 1);
    });

    it("still answers for the flights while the ribbons are cut for another zoom", async () => {
      // Beyond the level of the deepest elevation tiles, where only the
      // width of the ribbons changes
      mockApp.map!.jumpTo({ zoom: 12.2 });
      drawClimb();
      await terrainCode();
      await landed();
      const g = ribbons()[0]!.properties.g;
      const workerAnswers = holdSetData(RIBBONS);

      mockApp.map!.jumpTo({ zoom: 13.1 });
      mockApp.map!.emit("zoomend");

      // The same runs, so the tiles of before still stand for them: no
      // click or pointer is kept waiting for the new ones
      expect(ribbons()[0]!.properties.g).toBe(g);
      mockApp.map!.renderedFeatures = [
        rendered(RIBBONS, { r: 0, g, pathId: 1, h: 0 }),
      ];
      expect(layerManager.hitTest(pointAt(48, 16.005))).toMatchObject({
        pathId: 1,
      });
      await workerAnswers();
    });

    it("draws the flights as lines zoomed in close, and lifts them again further out", async () => {
      mockApp.map!.jumpTo({ zoom: 16.5 });
      drawClimb();
      await terrainCode();
      expect(ribbons().length).toBeGreaterThan(0);

      // The camera is lower than a circuit there
      mockApp.map!.jumpTo({ zoom: 17.2 });
      mockApp.map!.emit("zoomend");
      expect(ribbons()).toEqual([]);
      expect(features(ALTITUDE)).toHaveLength(1);

      mockApp.map!.jumpTo({ zoom: 16.8 });
      mockApp.map!.emit("zoomend");
      expect(features(ALTITUDE)).toEqual([]);
      expect(ribbons().length).toBeGreaterThan(0);
    });

    it("leaves the ribbons be as the map zooms while the flights are flat", () => {
      drawClimb();
      mockApp.store.set("threeDVisible", false);
      const writes = setDataCalls(RIBBONS);

      mockApp.map!.jumpTo({ zoom: 3 });
      mockApp.map!.emit("zoomend");

      expect(setDataCalls(RIBBONS)).toBe(writes);
    });

    it("draws the ribbons as strong as the lines, dimmed like them", () => {
      drawClimb();

      expect(paint(RIBBONS)["fill-extrusion-opacity"]).toBe(0.85);
      expect(paint(ALTITUDE)["line-opacity"]).toBe(0.85);
    });

    it("keeps the ribbons of the selected flights off the main layer, like the lines", () => {
      drawClimb();
      mockApp.altitudeVisible = true;
      mockApp.selectedPathIds.add(1);
      layerManager.updateSelectionStyles();

      expect(mockApp.map!.layer(RIBBONS).filter).toEqual([
        "!",
        ["in", ["get", "pathId"], ["literal", [1]]],
      ]);
      // The selection's own ribbons, at full strength
      expect(features(ALTITUDE_SELECTED)).toEqual([]);
      expect(features(RIBBONS_SELECTED).length).toBeGreaterThan(0);
      expect(paint(RIBBONS_SELECTED)["fill-extrusion-opacity"]).toBe(1);
    });

    it("looks for the ribbons under the pointer only in the 3D view", () => {
      drawClimb();

      layerManager.hitTest(new Point(100, 50));
      expect(mockApp.map!.queryRenderedFeatures).toHaveBeenLastCalledWith(
        expect.anything(),
        { layers: [ALTITUDE, ALTITUDE_SELECTED, RIBBONS, RIBBONS_SELECTED] },
      );

      mockApp.store.set("threeDVisible", false);
      layerManager.hitTest(new Point(100, 50));
      expect(mockApp.map!.queryRenderedFeatures).toHaveBeenLastCalledWith(
        expect.anything(),
        { layers: [ALTITUDE, ALTITUDE_SELECTED] },
      );
    });

    it("finds the flight of a ribbon under the pointer", async () => {
      drawClimb();
      await terrainCode();
      await landed();
      mockApp.map!.renderedFeatures = [
        rendered(RIBBONS, { r: 0, g: ribbons()[0]!.properties.g, h: 100 }),
      ];

      expect(layerManager.hitTest(pointAt(48, 16.025))).toMatchObject({
        pathId: 1,
      });
    });

    it("writes nothing again as the map zooms on among the flat lines", async () => {
      mockApp.map!.jumpTo({ zoom: 17.2 });
      drawClimb();
      await terrainCode();
      const writes = setDataCalls(ALTITUDE);

      // A line is the same at every zoom
      mockApp.map!.jumpTo({ zoom: 18.1 });
      mockApp.map!.emit("zoomend");
      mockApp.map!.jumpTo({ zoom: 19.1 });
      mockApp.map!.emit("zoomend");
      expect(setDataCalls(ALTITUDE)).toBe(writes);

      // Out to where they are lifted again, as ribbons
      mockApp.map!.jumpTo({ zoom: 16.5 });
      mockApp.map!.emit("zoomend");
      expect(ribbons().length).toBeGreaterThan(0);
      expect(features(ALTITUDE)).toEqual([]);
    });

    it("cuts each source again for the zoom level it was written at", async () => {
      mockApp.map!.jumpTo({ zoom: 7.2 });
      drawClimb();
      await terrainCode();
      const at7 = ribbonWidthM();

      // The selection is written at the next level before the zoom ends;
      // the main ribbons are still those of the level before
      mockApp.map!.jumpTo({ zoom: 8.1 });
      mockApp.altitudeVisible = true;
      mockApp.selectedPathIds.add(1);
      layerManager.updateSelectionStyles();
      mockApp.map!.emit("zoomend");

      expect(ribbonWidthM()).toBeCloseTo(at7 / 2, 3);
    });

    it("leaves a mode the replay hides as it is, and draws it again as it shows", () => {
      mockApp.map!.jumpTo({ zoom: 8.2 });
      drawClimb();
      const writes = setDataCalls(RIBBONS);

      // Hidden, not cleared, as the replay does it
      mockApp.altitudeLayer.setVisible(false);
      mockApp.map!.jumpTo({ zoom: 9.1 });
      mockApp.map!.emit("zoomend");
      mockApp.store.set("threeDVisible", false);
      expect(setDataCalls(RIBBONS)).toBe(writes);
      expect(setDataCalls(ALTITUDE)).toBe(0);

      // Shown again, a change of the selection draws it as a whole, flat
      mockApp.altitudeLayer.setVisible(true);
      mockApp.altitudeVisible = true;
      layerManager.updateSelectionStyles();
      expect(ribbons()).toEqual([]);
      expect(features(ALTITUDE)).toHaveLength(1);
    });

    it("lets the smoothed flights go once nothing lifted needs them", async () => {
      const smoothed = (): unknown =>
        (layerManager as unknown as { smoothed: unknown }).smoothed;
      drawClimb();
      expect(smoothed()).not.toBeNull();

      mockApp.store.set("threeDVisible", false);
      expect(smoothed()).toBeNull();

      mockApp.store.set("threeDVisible", true);
      await terrainCode();
      expect(smoothed()).not.toBeNull();
      // Another dataset, drawn flat zoomed in
      mockApp.map!.jumpTo({ zoom: 17.5 });
      mockApp.currentData = createDataset(
        [{ id: 1, year: 2025 }],
        [...mockApp.currentData!.path_segments],
      );
      layerManager.redrawAltitudePaths();
      expect(smoothed()).toBeNull();

      mockApp.map!.jumpTo({ zoom: 12 });
      mockApp.map!.emit("zoomend");
      await terrainCode();
      expect(smoothed()).not.toBeNull();
      layerManager.clearLayer("altitude");
      expect(smoothed()).toBeNull();
    });

    it("takes a ribbon down by the lift at the map's centre, as MapLibre raises it", async () => {
      // Due north at 60 degrees, a segment every 0.005 degrees, while the
      // middle of the map is at the equator
      const points = Array.from({ length: 40 }, (_, i): [number, number] => [
        60 + i * 0.005,
        16,
      ]);
      mockApp.currentData = createDataset(
        [{ id: 1, year: 2025 }],
        segmentsAlong(points),
      );
      mockApp.store.set("threeDVisible", true);
      mockApp.altitudeLayer.setVisible(true);
      mockApp.map!.jumpTo({ center: [16, 0], zoom: 12, pitch: 60 });
      layerManager.redrawAltitudePaths();
      await terrainCode();
      await landed();
      mockApp.map!.renderedFeatures = [
        rendered(RIBBONS, {
          r: 0,
          g: ribbons()[0]!.properties.g,
          h: 1000,
          e: 2,
        }),
      ];

      // Drawn up by the lift of the centre's latitude, half of that at 60
      const ground = pointAt(60 + 20.5 * 0.005, 16);
      const lift = liftOffsetPx(
        mockApp.map! as unknown as MapLibreMap,
        0,
        1000,
        2,
      );
      const hit = layerManager.hitTest(new Point(ground.x, ground.y - lift));

      expect(hit).toMatchObject({
        segment: mockApp.currentData.path_segments[20],
      });
    });

    it("cuts and writes the flights again as the 3D view comes and goes", async () => {
      drawClimb();
      await terrainCode();
      const writes = setDataCalls(ALTITUDE);

      mockApp.store.set("threeDVisible", false);
      expect(setDataCalls(ALTITUDE)).toBe(writes + 1);
      mockApp.store.set("threeDVisible", true);
      expect(setDataCalls(ALTITUDE)).toBe(writes + 2);
    });
  });

  describe("the relief of the 3D view", () => {
    const RIBBONS = "paths-altitude-3d";

    beforeEach(() => {
      featureBundle.available = true;
      // The relief's code hides and shows the ribbons through the manager
      (mockApp as unknown as { layerManager: LayerManager }).layerManager =
        layerManager;
    });

    /**
     * A level flight at 3,000 ft over ground the build sampled at 1,000 ft,
     * between fields it taxied at at 400 ft, lifted at map zoom `zoom`, or
     * without `threeD` drawn flat there
     */
    async function drawOverHills(zoom: number, threeD = true): Promise<void> {
      const taxi = (from: number, lng: number): PathSegment =>
        createSegment({
          path_id: 1,
          altitude_ft: 400,
          groundspeed_knots: 10,
          ground_ft: 1000,
          coords: [
            [48, from],
            [48, lng],
          ],
        });
      mockApp.currentData = createDataset(
        [{ id: 1, year: 2025 }],
        [
          taxi(16, 16.001),
          taxi(16.001, 16.002),
          taxi(16.002, 16.003),
          ...[0, 1, 2].map((i) =>
            createSegment({
              path_id: 1,
              altitude_ft: 3000,
              groundspeed_knots: 100,
              ground_ft: 1000,
              coords: [
                [48, 16.003 + i * 0.01],
                [48, 16.013 + i * 0.01],
              ],
            }),
          ),
          taxi(16.033, 16.034),
          taxi(16.034, 16.035),
          taxi(16.035, 16.036),
        ],
      );
      mockApp.map!.jumpTo({ zoom, pitch: 60 });
      mockApp.altitudeVisible = true;
      mockApp.altitudeLayer.setVisible(true);
      mockApp.store.set("threeDVisible", threeD);
      layerManager.redrawAltitudePaths();
      // The relief's code arrives with the feature bundle
      await new Promise((resolve) => setTimeout(resolve));
    }

    const heights = (): number[] =>
      features(RIBBONS).map((ribbon) => ribbon.properties.h ?? NaN);
    const opacity = (): unknown =>
      mockApp.map!.layer(RIBBONS).paint["fill-extrusion-opacity"];

    it("draws the relief for a 3D view the page opened with (regression)", async () => {
      // A link or a restored session: 3D and the zoom are set before the
      // manager exists, and the map fires no zoomend for them
      layerManager.destroy();
      mockApp.map!.jumpTo({ zoom: 11, pitch: 60 });
      mockApp.store.set("threeDVisible", true);

      layerManager = new LayerManager(asMapApp(mockApp));
      (mockApp as unknown as { layerManager: LayerManager }).layerManager =
        layerManager;
      await new Promise((resolve) => setTimeout(resolve));

      expect(mockApp.terrainActive).toBe(true);
      expect(mockApp.map!.getTerrain()).not.toBeNull();
    });

    /** The exaggerations the ribbons were cut for */
    const exaggerations = (): Set<number | undefined> =>
      new Set(features(RIBBONS).map((ribbon) => ribbon.properties.e));

    it("draws the relief at every zoom, exaggerated as the flights, and stands them on the sampled ground", async () => {
      await drawOverHills(11);
      for (const zoom of [11, 4.5]) {
        mockApp.map!.jumpTo({ zoom });
        mockApp.map!.emit("zoomend");

        expect(mockApp.terrainActive).toBe(true);
        expect(mockApp.map!.getTerrain()).toEqual({
          source: "terrain",
          exaggeration: liftExaggeration(Math.floor(zoom)),
        });
        expect(exaggerations()).toEqual(
          new Set([liftExaggeration(Math.floor(zoom))]),
        );
        // 2,000 ft over the relief, which the map adds itself
        expect(Math.max(...heights())).toBeCloseTo(2000, 6);
      }
      expect(mockApp.map!.source("terrain").spec).toMatchObject({
        type: "raster-dem",
        encoding: "terrarium",
      });
    });

    it("has the markers follow the ground a move ends on, while the relief is drawn", async () => {
      await drawOverHills(11);
      const fired = vi.fn();
      mockApp.map!.on("terrain", fired);
      mockApp.map!.emit("moveend");
      expect(fired).toHaveBeenCalledTimes(1);

      mockApp.globeVisible = true;
      mockApp.map!.emit("moveend");
      expect(fired).toHaveBeenCalledTimes(1);
    });

    /** How many features each write to the ribbons had, in order */
    const writes = (): number[] =>
      mockApp
        .map!.source(RIBBONS)
        .setData.mock.calls.map(
          ([data]) => (data as GeoJSON.FeatureCollection).features.length,
        );

    it("switches the exaggeration and the ground at the level they are cut for, once", async () => {
      await drawOverHills(11);
      mockApp.map!.setTerrain.mockClear();
      const before = writes().length;

      mockApp.map!.jumpTo({ zoom: 7.2 });
      mockApp.map!.emit("zoomend");

      // The relief and the flights exaggerated alike, for the new level
      expect(mockApp.reliefLevel).toBe(7);
      expect(mockApp.map!.setTerrain.mock.calls).toEqual([
        [{ source: "terrain", exaggeration: liftExaggeration(7) }],
      ]);
      expect(exaggerations()).toEqual(new Set([liftExaggeration(7)]));
      expect(Math.max(...heights())).toBe(2000);
      // Cut once, on the new ground and for the new level at the same time,
      // after the cut of before has been let go of: the map's worker holds
      // one of them at a time
      expect(writes().slice(before)).toEqual([0, heights().length]);
    });

    it("leaves the relief and the flights as they are while a zoom goes on", async () => {
      await drawOverHills(7.2);
      mockApp.map!.setTerrain.mockClear();
      const before = writes().length;

      // Mid-gesture, a level on: nothing follows before the zoom ends
      mockApp.map!.jumpTo({ zoom: 8.6 });
      mockApp.map!.emit("zoom");
      expect(mockApp.reliefLevel).toBe(7);
      expect(mockApp.map!.setTerrain).not.toHaveBeenCalled();
      expect(writes()).toHaveLength(before);

      // Within the level it ends in, nothing is cut again either
      mockApp.map!.jumpTo({ zoom: 7.8 });
      mockApp.map!.emit("zoomend");
      expect(mockApp.map!.setTerrain).not.toHaveBeenCalled();
      expect(writes()).toHaveLength(before);
    });

    it("cuts the ribbons only for their width beyond the level of the deepest tiles", async () => {
      await drawOverHills(12.2);
      mockApp.map!.setTerrain.mockClear();
      const before = writes().length;
      const opacityBefore = opacity();

      mockApp.map!.jumpTo({ zoom: 13.1 });
      mockApp.map!.emit("zoomend");

      expect(mockApp.map!.setTerrain).not.toHaveBeenCalled();
      expect(writes().slice(before)).toEqual([heights().length]);
      expect(opacity()).toBe(opacityBefore);
    });

    it("cuts the flights once as the 3D view is switched on over the relief", async () => {
      await drawOverHills(11, false);
      const before = writes().length;

      mockApp.store.set("threeDVisible", true);
      expect(writes()).toHaveLength(before);
      await new Promise((resolve) => setTimeout(resolve));
      expect(writes().slice(before)).toEqual([heights().length]);
      expect(Math.max(...heights())).toBe(2000);
    });

    it("cuts the flights for the new level on the flat map without the relief's code", async () => {
      featureBundle.available = false;
      await drawOverHills(7.2);
      const before = writes().length;

      mockApp.map!.jumpTo({ zoom: 8.2 });
      mockApp.map!.emit("zoomend");
      await new Promise((resolve) => setTimeout(resolve));

      expect(mockApp.terrainActive).toBe(false);
      expect(writes().slice(before)).toEqual([heights().length]);
      expect(exaggerations()).toEqual(new Set([liftExaggeration(8)]));
      expect(Math.max(...heights())).toBe(2600);
    });

    it("hides the ribbons until the map has drawn them on their new ground", async () => {
      await drawOverHills(11);
      mockApp.map!.emit("render");
      expect(opacity()).toBeGreaterThan(0);

      mockApp.map!.isSourceLoaded.mockImplementation((id) => id !== "terrain");
      mockApp.map!.jumpTo({ zoom: 7.2 });
      mockApp.map!.emit("zoomend");
      expect(opacity()).toBe(0);
      expect(
        mockApp.map!.layer("replay-trail-3d").paint["fill-extrusion-opacity"],
      ).toBe(0);
      // A selection meanwhile does not show them early
      layerManager.updateSelectionStyles();
      mockApp.map!.emit("render");
      expect(opacity()).toBe(0);

      mockApp.map!.isSourceLoaded.mockReturnValue(true);
      mockApp.map!.emit("render");
      expect(opacity()).toBeGreaterThan(0);
      expect(
        mockApp.map!.layer("replay-trail-3d").paint["fill-extrusion-opacity"],
      ).toBe(0.8);
      expect(mockApp.map!.listenerCount("render")).toBe(0);
    });

    it("shows the ribbons after SETTLE_MAX_MS even when the relief is still loading", async () => {
      await drawOverHills(11);
      mockApp.map!.emit("render");
      vi.useFakeTimers();
      try {
        mockApp.map!.isSourceLoaded.mockImplementation(
          (id) => id !== "terrain",
        );
        mockApp.map!.jumpTo({ zoom: 7.2 });
        mockApp.map!.emit("zoomend");
        expect(opacity()).toBe(0);

        // A slow device: the elevation tiles are still coming in
        vi.advanceTimersByTime(2999);
        mockApp.map!.emit("render");
        expect(opacity()).toBe(0);
        vi.advanceTimersByTime(1);
        expect(opacity()).toBeGreaterThan(0);
        expect(mockApp.map!.listenerCount("render")).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("shades the relief above the base map's fills and below everything of the app's", async () => {
      await drawOverHills(11);

      const order = mockApp.map!.getLayersOrder();
      const shading = order.indexOf(HILLSHADE_LAYER);
      expect(shading).toBeGreaterThan(0);
      expect(mockApp.map!.layer(HILLSHADE_LAYER)).toMatchObject({
        type: "hillshade",
        source: "terrain",
      });
      // Right above the background of the stub style, below the first
      // layer of the app
      expect(order[shading - 1]).toBe("background");
      expect(order[shading + 1]).toBe(MAP_LAYERS.aviation);
      expect(
        mockApp.map!.getLayoutProperty(HILLSHADE_LAYER, "visibility"),
      ).not.toBe("none");

      mockApp.store.set("threeDVisible", false);
      expect(
        mockApp.map!.getLayoutProperty(HILLSHADE_LAYER, "visibility"),
      ).toBe("none");
      expect(mockApp.map!.getTerrain()).toBeNull();
      mockApp.store.set("threeDVisible", true);
      expect(
        mockApp.map!.getLayoutProperty(HILLSHADE_LAYER, "visibility"),
      ).toBe("visible");
    });

    it("puts the shading back into a new base style", async () => {
      await drawOverHills(11);
      mockApp.map!.removeLayer(HILLSHADE_LAYER);

      mockApp.map!.emit("styledata");

      expect(mockApp.map!.getLayer(HILLSHADE_LAYER)).toBeDefined();
    });

    const shading = (): unknown =>
      mockApp.map!.getLayer(HILLSHADE_LAYER)
        ? mockApp.map!.getLayoutProperty(HILLSHADE_LAYER, "visibility")
        : "absent";

    it("shades the relief on the globe without drawing it, and switches with the globe", async () => {
      await drawOverHills(11);
      mockApp.map!.setTerrain.mockClear();

      mockApp.globeVisible = true;
      expect(mockApp.terrainActive).toBe(false);
      expect(mockApp.reliefShaded).toBe(true);
      expect(mockApp.map!.getTerrain()).toBeNull();
      expect(shading()).toBe("visible");
      // The flights stand on the line between their fields there
      expect(Math.max(...heights())).toBe(2600);

      // Another level on the globe lifts them as much as off it
      mockApp.map!.jumpTo({ zoom: 6.5 });
      mockApp.map!.emit("zoomend");
      expect(exaggerations()).toEqual(new Set([liftExaggeration(6)]));
      expect(mockApp.map!.getTerrain()).toBeNull();

      mockApp.globeVisible = false;
      expect(mockApp.terrainActive).toBe(true);
      expect(mockApp.map!.getTerrain()).not.toBeNull();
      expect(shading()).toBe("visible");
      expect(Math.max(...heights())).toBeCloseTo(2000, 6);
      // Once off and once on: never the relief on the globe
      expect(mockApp.map!.setTerrain.mock.calls).toEqual([
        [null],
        [{ source: "terrain", exaggeration: liftExaggeration(6) }],
      ]);
    });

    it("loads the relief's code for the shading alone on the globe", async () => {
      mockApp.globeVisible = true;
      await drawOverHills(11);

      expect(mockApp.reliefShaded).toBe(true);
      expect(mockApp.terrainActive).toBe(false);
      expect(mockApp.map!.getTerrain()).toBeNull();
      expect(mockApp.map!.source("terrain").spec).toMatchObject({
        type: "raster-dem",
      });
      // Created shown, with no visibility of its own
      expect(shading()).toBeUndefined();
      // The ground does not change, so the ribbons stay shown
      expect(opacity()).toBeGreaterThan(0);
      expect(Math.max(...heights())).toBe(2600);

      mockApp.store.set("threeDVisible", false);
      expect(mockApp.reliefShaded).toBe(false);
      expect(shading()).toBe("none");
    });

    it("leaves the flights on the flat map without the feature bundle", async () => {
      featureBundle.available = false;
      await drawOverHills(11);

      expect(mockApp.terrainActive).toBe(false);
      expect(Math.max(...heights())).toBe(2600);
    });

    it("builds the relief anew after a lost WebGL context", async () => {
      await drawOverHills(11);
      mockApp.map!.setTerrain.mockClear();

      mockApp.map!.emit("webglcontextrestored");
      mockApp.map!.emit("style.load");

      expect(mockApp.map!.setTerrain.mock.calls).toEqual([
        [null],
        [{ source: "terrain", exaggeration: liftExaggeration(11) }],
      ]);
    });
  });

  describe("a lost WebGL context", () => {
    /**
     * The map as MapLibre leaves it until the style is back: no style, so
     * no source. Restored, the sources hold the data of before the loss.
     */
    function loseContext(): () => void {
      const map = mockApp.map!;
      const getSource = map.getSource.getMockImplementation()!;
      map.getSource.mockImplementation(() => undefined);
      return () => {
        map.getSource.mockImplementation(getSource);
        map.emit("webglcontextrestored");
        map.emit("style.load");
      };
    }

    it("does not let the features of before answer for the runs of a redraw", async () => {
      mockApp.altitudeLayer.setVisible(true);
      layerManager.redrawAltitudePaths();
      await landed();
      const restore = loseContext();

      addSecondPath();
      layerManager.redrawAltitudePaths();
      restore();
      // Features the restored tiles hold, from the data of before
      mockApp.map!.renderedFeatures = [rendered(ALTITUDE, { r: 0, g: 1 })];

      // Written again, as a new generation
      expect(features(ALTITUDE).map((f) => f.properties.pathId)).toEqual([
        1, 2,
      ]);
      expect(features(ALTITUDE)[0]!.properties.g).toBeGreaterThan(1);
      expect(layerManager.hitTest(pointAt(48.5, 16.5))).toBe("stale");
    });

    it("empties a mode cleared during the loss, and leaves a hidden one for later", () => {
      mockApp.altitudeLayer.setVisible(true);
      layerManager.redrawAltitudePaths();
      layerManager.redrawAirspeedPaths();
      const restore = loseContext();

      layerManager.clearLayer("altitude");
      restore();

      expect(features(ALTITUDE)).toEqual([]);
      // Hidden: drawn once it shows
      expect(setDataCalls(AIRSPEED)).toBe(1);
    });

    it("writes nothing once the manager is gone", () => {
      mockApp.altitudeLayer.setVisible(true);
      layerManager.redrawAltitudePaths();
      const restore = loseContext();
      layerManager.destroy();

      restore();

      expect(setDataCalls(ALTITUDE)).toBe(1);
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
