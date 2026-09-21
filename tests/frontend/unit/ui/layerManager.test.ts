import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as L from "leaflet";
import {
  LayerManager,
  isTouchDevice,
} from "../../../../kml_heatmap/frontend/ui/layerManager";
import {
  getColorForAirspeed,
  getColorForAltitude,
} from "../../../../kml_heatmap/frontend/utils/colors";
import type { PathSegment } from "../../../../kml_heatmap/frontend/types";
import {
  createMockApp,
  createDataset,
  createSegment,
  asMapApp,
  type MockApp,
} from "../../testHelpers";
import type { MockPolyline } from "../../../mocks/leaflet";

// Mock domCache
vi.mock("../../../../kml_heatmap/frontend/utils/domCache", () => ({
  domCache: {
    get: vi.fn((id: string) => document.getElementById(id)),
  },
}));

function polylines(): MockPolyline[] {
  return vi.mocked(L.polyline).mock.results.map((r) => r.value as MockPolyline);
}

/**
 * The middle of the one of 32 equal steps of the range `value` falls in,
 * clamped to the range: what a polyline of `value` is coloured with
 */
function middle(value: number, min: number, max: number): number {
  const span = Math.max(max - min, 1);
  const step = Math.min(
    Math.max(Math.floor(((value - min) / span) * 32), 0),
    31,
  );
  return min + ((step + 0.5) / 32) * span;
}

/** The colour of a polyline of `value`, cut at and shown on one range */
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

function clickHandler(pl: MockPolyline): (e: unknown) => void {
  const call = pl.on.mock.calls.find((c) => c[0] === "click");
  return call![1] as (e: unknown) => void;
}

describe("LayerManager", () => {
  let layerManager: LayerManager;
  let mockApp: MockApp;

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

  beforeEach(() => {
    vi.mocked(L.polyline).mockClear();
    vi.mocked(L.popup).mockClear();

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

    layerManager = new LayerManager(asMapApp(mockApp));
  });

  afterEach(() => {
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

      expect(mockApp.altitudeLayer.clearLayers).not.toHaveBeenCalled();
      expect(L.polyline).not.toHaveBeenCalled();
    });

    it("clears the layer and draws one polyline per run on the canvas renderer", () => {
      layerManager.redrawAltitudePaths();

      expect(mockApp.altitudeLayer.clearLayers).toHaveBeenCalled();
      expect(L.polyline).toHaveBeenCalledTimes(1);
      const pl = polylines()[0]!;
      expect(pl.latlngs).toEqual([
        [48, 16],
        [49, 17],
      ]);
      expect(pl.options["renderer"]).toBe(mockApp.pathRenderer);
      expect(pl.options["bubblingMouseEvents"]).toBe(false);
      expect(pl.options["color"]).toBe(
        stepColor(getColorForAltitude, 3000, 0, 5000),
      );
      expect(pl.options["weight"]).toBe(4);
      expect(pl.options["opacity"]).toBe(0.85);
      expect(pl.addTo).toHaveBeenCalledWith(mockApp.altitudeLayer);
      expect(mockApp.altitudeLayer.layers.size).toBe(1);
    });

    it("merges contiguous segments in the same colour step into one polyline", () => {
      mockApp.map!.getZoom.mockReturnValue(13);
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

      expect(L.polyline).toHaveBeenCalledTimes(3);
      expect(polylines()[0]!.latlngs).toEqual([
        [48, 16],
        [48.1, 16.1],
        [48.2, 16.2],
      ]);
      expect(polylines()[1]!.latlngs).toEqual([
        [48.2, 16.2],
        [48.3, 16.3],
      ]);
      expect(polylines()[2]!.latlngs).toEqual([
        [49, 17],
        [49.1, 17.1],
      ]);
      expect(mockApp.altitudeLayer.layers.size).toBe(3);
    });

    it("draws a groundspeed that wanders within a colour step as one polyline", () => {
      mockApp.map!.getZoom.mockReturnValue(13);
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

      expect(L.polyline).toHaveBeenCalledTimes(1);
      expect(polylines()[0]!.latlngs).toEqual(points);
    });

    it("colours no polyline further than half a step from its values", () => {
      mockApp.map!.getZoom.mockReturnValue(13);
      mockApp.currentData = createDataset(
        [{ id: 1, year: 2025 }],
        segmentsAlong(zigZag(3, 0.01), 5000),
      );

      layerManager.redrawAltitudePaths();

      // The top of the range falls in the last step, not past it
      expect(polylines()[0]!.options["color"]).toBe(
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

      expect(L.polyline).toHaveBeenCalledTimes(2);
    });

    it("uses selected paths' range for colours and legend when paths are selected", () => {
      mockApp.selectedPathIds.add(1);

      layerManager.redrawAltitudePaths();

      const pl = polylines()[0]!;
      expect(pl.options["color"]).toBe(
        stepColor(getColorForAltitude, 3000, 3000, 3000),
      );
      expect(pl.options["weight"]).toBe(6);
      expect(pl.options["opacity"]).toBe(1);
      expect(document.getElementById("legend-min")!.textContent).toBe(
        "3,000 ft (914 m)",
      );
    });

    it("dims unselected paths when a selection exists", () => {
      mockApp.currentData!.path_info.push({ id: 2, year: 2025 });
      mockApp.currentData!.path_segments.push(
        createSegment({ path_id: 2, altitude_ft: 2000 }),
      );
      mockApp.selectedPathIds.add(1);

      layerManager.redrawAltitudePaths();

      const [selected, unselected] = polylines();
      expect(selected!.options["opacity"]).toBe(1);
      expect(unselected!.options["opacity"]).toBe(0.1);
      expect(unselected!.options["weight"]).toBe(4);
    });

    it("filters segments by year and aircraft", () => {
      mockApp.selectedYear = "2024";
      layerManager.redrawAltitudePaths();
      expect(L.polyline).not.toHaveBeenCalled();

      mockApp.selectedYear = "all";
      mockApp.selectedAircraft = "D-EFGH";
      layerManager.redrawAltitudePaths();
      expect(L.polyline).not.toHaveBeenCalled();

      mockApp.selectedAircraft = "D-ABCD";
      layerManager.redrawAltitudePaths();
      expect(L.polyline).toHaveBeenCalledTimes(1);
    });

    it("skips segments without path info when a filter is active", () => {
      mockApp.currentData = createDataset([], [segA()]);
      mockApp.selectedYear = "2025";

      layerManager.redrawAltitudePaths();

      expect(L.polyline).not.toHaveBeenCalled();
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

    it("hides unselected paths completely in isolate mode", () => {
      mockApp.currentData!.path_segments.push(
        createSegment({
          path_id: 2,
          altitude_ft: 2000,
          coords: [
            [47, 15],
            [47.5, 15.5],
          ],
        }),
      );
      mockApp.currentData!.path_info.push({
        id: 2,
        year: 2025,
        aircraft_registration: "D-ABCD",
      });
      mockApp.selectedPathIds.add(1);
      mockApp.isolateSelection = true;

      layerManager.redrawAltitudePaths();

      expect(L.polyline).toHaveBeenCalledTimes(1);
      const pl = polylines()[0]!;
      expect(pl.options["weight"]).toBe(4);
      expect(pl.options["opacity"]).toBe(0.85);
    });

    it("falls back to the full range when selected segments are empty", () => {
      mockApp.selectedPathIds.add(999);

      layerManager.redrawAltitudePaths();

      expect(polylines()[0]!.options["color"]).toBe(
        stepColor(getColorForAltitude, 3000, 0, 5000),
      );
    });
  });

  describe("redrawAirspeedPaths", () => {
    it("returns early if no currentData", () => {
      mockApp.currentData = null;

      layerManager.redrawAirspeedPaths();

      expect(mockApp.airspeedLayer.clearLayers).not.toHaveBeenCalled();
    });

    it("draws with airspeed colours and updates the airspeed legend", () => {
      layerManager.redrawAirspeedPaths();

      expect(mockApp.airspeedLayer.clearLayers).toHaveBeenCalled();
      expect(polylines()[0]!.options["color"]).toBe(
        stepColor(getColorForAirspeed, 100, 0, 200),
      );
      expect(document.getElementById("airspeed-legend-max")!.textContent).toBe(
        "200 kt (370 km/h)",
      );
    });

    it("uses selected paths' airspeed range when paths are selected", () => {
      mockApp.selectedPathIds.add(1);

      layerManager.redrawAirspeedPaths();

      expect(polylines()[0]!.options["color"]).toBe(
        stepColor(getColorForAirspeed, 100, 100, 100),
      );
    });

    it("skips segments with zero groundspeed", () => {
      mockApp.currentData!.path_segments[0]!.groundspeed_knots = 0;

      layerManager.redrawAirspeedPaths();

      expect(L.polyline).not.toHaveBeenCalled();
    });

    it("falls back to the full airspeed range when selection has no speed data", () => {
      mockApp.selectedPathIds.add(999);

      layerManager.redrawAirspeedPaths();

      expect(polylines()[0]!.options["color"]).toBe(
        stepColor(getColorForAirspeed, 100, 0, 200),
      );
    });
  });

  describe("simplification", () => {
    beforeEach(() => {
      mockApp.currentData = createDataset(
        [{ id: 1, year: 2025, aircraft_registration: "D-ABCD" }],
        // Kinks of about 5 m: well below a pixel at zoom 10, visible at 16
        segmentsAlong(zigZag(40, 0.00005)),
      );
    });

    /** What the manager does when Leaflet fires "zoom" */
    function onZoom(): () => void {
      const call = mockApp.map!.on.mock.calls.find((c) => c[0] === "zoom");
      return call![1] as () => void;
    }

    it("simplifies the geometry at overview zooms, keeping the ends", () => {
      layerManager.redrawAltitudePaths();

      const pl = polylines()[0]!;
      expect(pl.latlngs.length).toBeLessThan(40);
      expect(pl.latlngs[0]).toEqual([48, 16]);
      expect(pl.latlngs.at(-1)).toEqual([48.00005, 16.39]);
      // The segments behind the tooltip are all still there
      expect(L.polyline).toHaveBeenCalledTimes(1);
    });

    it("keeps every point from zoom 13 on", () => {
      mockApp.map!.getZoom.mockReturnValue(13.5);

      layerManager.redrawAltitudePaths();

      expect(polylines()[0]!.latlngs).toHaveLength(40);
    });

    it("keeps a kink that is visible at the zoom", () => {
      mockApp.currentData = createDataset(
        [{ id: 1, year: 2025, aircraft_registration: "D-ABCD" }],
        // About 1 km, several pixels at zoom 10
        segmentsAlong(zigZag(5, 0.01)),
      );

      layerManager.redrawAltitudePaths();

      expect(polylines()[0]!.latlngs).toHaveLength(5);
    });

    it("swaps the geometry only when a zoom crosses a whole level", () => {
      layerManager.redrawAltitudePaths();
      const pl = polylines()[0]!;

      // 10.75 simplifies like 10
      mockApp.map!.getZoom.mockReturnValue(10.75);
      onZoom()();
      expect(pl.setLatLngs).not.toHaveBeenCalled();

      mockApp.map!.getZoom.mockReturnValue(16);
      onZoom()();
      expect(pl.setLatLngs).toHaveBeenCalledExactlyOnceWith(
        zigZag(40, 0.00005),
      );

      // Past zoom 13 nothing changes any more
      mockApp.map!.getZoom.mockReturnValue(14);
      onZoom()();
      expect(pl.setLatLngs).toHaveBeenCalledOnce();
      // The polylines, their tooltips and their styles stay
      expect(L.polyline).toHaveBeenCalledOnce();
    });

    it("leaves a cleared layer alone", () => {
      layerManager.redrawAltitudePaths();
      layerManager.clearLayer("altitude");

      mockApp.map!.getZoom.mockReturnValue(16);
      onZoom()();
      layerManager.redrawAltitudePaths();

      // Built for the zoom it is drawn at, not swapped afterwards
      expect(polylines()[1]!.latlngs).toHaveLength(40);
      expect(polylines()[0]!.setLatLngs).not.toHaveBeenCalled();
    });

    it("listens for zoom changes once", () => {
      layerManager.redrawAltitudePaths();
      layerManager.redrawAirspeedPaths();

      const hooks = mockApp.map!.on.mock.calls.filter((c) => c[0] === "zoom");
      expect(hooks).toHaveLength(1);
    });

    it("stops listening when destroyed", () => {
      const handler: unknown = onZoom();

      layerManager.destroy();

      expect(mockApp.map!.off).toHaveBeenCalledWith("zoom", handler);
    });
  });

  describe("clearLayer", () => {
    it("removes polylines and resets the tracking map", () => {
      layerManager.redrawAltitudePaths();
      expect(mockApp.altitudeLayer.layers.size).toBe(1);

      layerManager.clearLayer("altitude");

      expect(mockApp.altitudeLayer.clearLayers).toHaveBeenCalledTimes(2);
      expect(mockApp.altitudeLayer.layers.size).toBe(0);
    });
  });

  describe("updateSelectionStyles", () => {
    beforeEach(() => {
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
    });

    it("rebuilds only the paths that are selected, restyling the others", () => {
      mockApp.altitudeVisible = true;
      layerManager.redrawAltitudePaths();
      const [old1, pl2] = polylines();
      vi.mocked(L.polyline).mockClear();

      mockApp.selectedPathIds.add(1);
      layerManager.updateSelectionStyles();

      // Path 1 is cut at the colour steps of the selection's range now
      expect(L.polyline).toHaveBeenCalledOnce();
      expect(mockApp.altitudeLayer.layers.has(old1!)).toBe(false);
      expect(polylines()[0]!.options).toMatchObject({
        color: stepColor(getColorForAltitude, 3000, 3000, 3000),
        weight: 6,
        opacity: 1,
      });
      // Path 2 keeps its runs, dimmed on the selection's range
      expect(pl2!.setStyle).toHaveBeenCalledWith(
        expect.objectContaining({
          color: getColorForAltitude(middle(2000, 0, 5000), 3000, 3000),
          weight: 4,
          opacity: 0.1,
        }),
      );
      expect(mockApp.altitudeLayer.layers.size).toBe(2);
      expect(document.getElementById("legend-min")!.textContent).toBe(
        "3,000 ft (914 m)",
      );
    });

    it("cuts a selected path at the colour steps of its own range", () => {
      mockApp.map!.getZoom.mockReturnValue(13);
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
      expect(L.polyline).toHaveBeenCalledOnce();
      vi.mocked(L.polyline).mockClear();

      mockApp.selectedPathIds.add(1);
      layerManager.updateSelectionStyles();

      expect(polylines().map((pl) => pl.options["color"])).toEqual([
        stepColor(getColorForAltitude, 3000, 3000, 3100),
        stepColor(getColorForAltitude, 3100, 3000, 3100),
      ]);
    });

    it("cuts a path at the full range again when it is deselected", () => {
      mockApp.altitudeVisible = true;
      mockApp.selectedPathIds.add(1);
      layerManager.redrawAltitudePaths();
      vi.mocked(L.polyline).mockClear();

      mockApp.selectedPathIds.clear();
      layerManager.updateSelectionStyles();

      expect(L.polyline).toHaveBeenCalledOnce();
      expect(polylines()[0]!.options).toMatchObject({
        color: stepColor(getColorForAltitude, 3000, 0, 5000),
        weight: 4,
        opacity: 0.85,
      });
      expect(document.getElementById("legend-max")!.textContent).toBe(
        "5,000 ft (1,524 m)",
      );
    });

    it("skips hidden layers", () => {
      mockApp.altitudeVisible = false;
      layerManager.redrawAltitudePaths();
      const [pl1] = polylines();

      mockApp.selectedPathIds.add(1);
      layerManager.updateSelectionStyles();

      expect(pl1!.setStyle).not.toHaveBeenCalled();
    });

    it("does nothing for a visible layer that was never drawn", () => {
      mockApp.altitudeVisible = true;
      mockApp.selectedPathIds.add(1);

      layerManager.updateSelectionStyles();

      expect(L.polyline).not.toHaveBeenCalled();
    });

    it("updates the airspeed layer when visible", () => {
      mockApp.airspeedVisible = true;
      layerManager.redrawAirspeedPaths();
      const [pl1] = polylines();

      mockApp.selectedPathIds.add(2);
      layerManager.updateSelectionStyles();

      expect(pl1!.setStyle).toHaveBeenCalledWith(
        expect.objectContaining({
          color: getColorForAirspeed(middle(100, 0, 200), 80, 80),
          weight: 4,
          opacity: 0.1,
        }),
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

  describe("segment interactions", () => {
    it("binds a lazy tooltip function on non-touch devices", () => {
      layerManager.redrawAltitudePaths();

      const pl = polylines()[0]!;
      expect(pl.bindTooltip).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({ sticky: true, className: "segment-tooltip" }),
      );
      const contentFn = pl.bindTooltip.mock.calls[0]![0] as () => string;
      expect(contentFn()).toContain("3,000 ft");
    });

    it("colours the tooltip chips on the range the polylines use", () => {
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

      const html = (
        polylines()[0]!.bindTooltip.mock.calls[0]![0] as () => string
      )();

      expect(html).toContain(getColorForAltitude(3000, 1000, 1000));
      expect(html).toContain(getColorForAirspeed(100, 50, 50));
      expect(html).not.toContain(getColorForAltitude(3000, 0, 5000));
    });

    it("registers the mouseover handler before the tooltip", () => {
      layerManager.redrawAltitudePaths();

      const pl = polylines()[0]!;
      const mouseoverOrder = pl.on.mock.invocationCallOrder[0]!;
      const tooltipOrder = pl.bindTooltip.mock.invocationCallOrder[0]!;
      expect(pl.on.mock.calls[0]![0]).toBe("mouseover");
      expect(mouseoverOrder).toBeLessThan(tooltipOrder);
    });

    it("updates tooltip content to the nearest segment on mousemove for merged polylines", () => {
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

      layerManager.redrawAltitudePaths();

      expect(L.polyline).toHaveBeenCalledTimes(1);
      const pl = polylines()[0]!;
      const mousemove = pl.on.mock.calls.find(
        (c) => c[0] === "mousemove",
      )![1] as (e: unknown) => void;

      mousemove({ latlng: { lat: 48.19, lng: 16.19 } });
      expect(pl.setTooltipContent).toHaveBeenCalledTimes(1);
      expect(String(pl.setTooltipContent.mock.calls[0]![0])).toContain(
        "120 kt",
      );

      // Same nearest segment: no content update
      mousemove({ latlng: { lat: 48.18, lng: 16.18 } });
      expect(pl.setTooltipContent).toHaveBeenCalledTimes(1);
    });

    it("skips bindTooltip on touch devices", () => {
      (window as { ontouchstart?: unknown }).ontouchstart = null;

      layerManager.redrawAltitudePaths();

      expect(polylines()[0]!.bindTooltip).not.toHaveBeenCalled();
    });

    it("opens a standalone popup on touch device click and toggles selection", () => {
      (window as { ontouchstart?: unknown }).ontouchstart = null;

      layerManager.redrawAltitudePaths();

      const pl = polylines()[0]!;
      const event = {
        latlng: { lat: 48, lng: 16 },
        originalEvent: { stopPropagation: vi.fn() },
      };
      clickHandler(pl)(event);

      expect(event.originalEvent.stopPropagation).toHaveBeenCalled();
      expect(L.DomEvent.stopPropagation).toHaveBeenCalledWith(event);
      expect(L.popup).toHaveBeenCalled();
      const popupInstance = vi.mocked(L.popup).mock.results[0]!.value as {
        setLatLng: ReturnType<typeof vi.fn>;
        setContent: ReturnType<typeof vi.fn>;
        openOn: ReturnType<typeof vi.fn>;
      };
      expect(popupInstance.setLatLng).toHaveBeenCalledWith(event.latlng);
      expect(String(popupInstance.setContent.mock.calls[0]![0])).toContain(
        "3,000 ft",
      );
      expect(popupInstance.openOn).toHaveBeenCalledWith(mockApp.map);
      expect(mockApp.pathSelection.togglePathSelection).toHaveBeenCalledWith(1);
    });

    it("does not open a popup on non-touch click but toggles selection", () => {
      layerManager.redrawAltitudePaths();

      const pl = polylines()[0]!;
      clickHandler(pl)({
        latlng: { lat: 48, lng: 16 },
        originalEvent: { stopPropagation: vi.fn() },
      });

      expect(L.popup).not.toHaveBeenCalled();
      expect(mockApp.pathSelection.togglePathSelection).toHaveBeenCalledWith(1);
    });

    it("hands the hover to the polyline that replaces the clicked one", () => {
      // Selecting rebuilds the path's polylines, and the tooltip of the one
      // under the pointer went with it until the pointer moved
      mockApp.altitudeVisible = true;
      mockApp.pathSelection.togglePathSelection.mockImplementation(
        (id: number) => {
          mockApp.selectedPathIds.add(id);
          layerManager.updateSelectionStyles();
        },
      );
      layerManager.redrawAltitudePaths();
      const old = polylines()[0]!;

      const latlng = { lat: 48.5, lng: 16.5 };
      clickHandler(old)({
        latlng,
        originalEvent: { stopPropagation: vi.fn() },
      });

      const replacement = polylines()[1]!;
      expect(mockApp.altitudeLayer.layers.has(old)).toBe(false);
      expect(replacement.fire).toHaveBeenCalledWith("mouseover", { latlng });
    });
  });
});
