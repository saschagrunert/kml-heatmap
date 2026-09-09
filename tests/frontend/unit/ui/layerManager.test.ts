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
    cacheElements: vi.fn(),
    get: vi.fn((id: string) => document.getElementById(id)),
  },
}));

function polylines(): MockPolyline[] {
  return vi.mocked(L.polyline).mock.results.map((r) => r.value as MockPolyline);
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
        "1000 ft (305 m)",
      );
      expect(document.getElementById("legend-max")!.textContent).toBe(
        "5000 ft (1524 m)",
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
        "1235 ft (376 m)",
      );
      expect(document.getElementById("legend-max")!.textContent).toBe(
        "5678 ft (1731 m)",
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
      expect(pl.options["color"]).toBe(getColorForAltitude(3000, 0, 5000));
      expect(pl.options["weight"]).toBe(4);
      expect(pl.options["opacity"]).toBe(0.85);
      expect(pl.addTo).toHaveBeenCalledWith(mockApp.altitudeLayer);
      expect(layerManager.getPolylineCount("altitude")).toBe(1);
    });

    it("merges contiguous segments with the same rounded value into one polyline", () => {
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
          createSegment({
            path_id: 1,
            altitude_ft: 3000.2,
            coords: [
              [48.1, 16.1],
              [48.2, 16.2],
            ],
          }),
          // different altitude: new run
          createSegment({
            path_id: 1,
            altitude_ft: 3500,
            coords: [
              [48.2, 16.2],
              [48.3, 16.3],
            ],
          }),
          // same altitude but not contiguous: new run
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
      expect(layerManager.getPolylineCount("altitude")).toBe(3);
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
      expect(pl.options["color"]).toBe(getColorForAltitude(3000, 3000, 3000));
      expect(pl.options["weight"]).toBe(6);
      expect(pl.options["opacity"]).toBe(1);
      expect(document.getElementById("legend-min")!.textContent).toBe(
        "3000 ft (914 m)",
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
        "5000 ft (1524 m)",
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
        getColorForAltitude(3000, 0, 5000),
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
        getColorForAirspeed(100, 0, 200),
      );
      expect(document.getElementById("airspeed-legend-max")!.textContent).toBe(
        "200 kt (370 km/h)",
      );
    });

    it("uses selected paths' airspeed range when paths are selected", () => {
      mockApp.selectedPathIds.add(1);

      layerManager.redrawAirspeedPaths();

      expect(polylines()[0]!.options["color"]).toBe(
        getColorForAirspeed(100, 100, 100),
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
        getColorForAirspeed(100, 0, 200),
      );
    });
  });

  describe("clearLayer", () => {
    it("removes polylines and resets the tracking map", () => {
      layerManager.redrawAltitudePaths();
      expect(layerManager.getPolylineCount("altitude")).toBe(1);

      layerManager.clearLayer("altitude");

      expect(mockApp.altitudeLayer.clearLayers).toHaveBeenCalledTimes(2);
      expect(layerManager.getPolylineCount("altitude")).toBe(0);
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

    it("restyles polylines in place instead of rebuilding", () => {
      mockApp.altitudeVisible = true;
      layerManager.redrawAltitudePaths();
      const [pl1, pl2] = polylines();
      vi.mocked(L.polyline).mockClear();

      mockApp.selectedPathIds.add(1);
      layerManager.updateSelectionStyles();

      expect(L.polyline).not.toHaveBeenCalled();
      expect(mockApp.altitudeLayer.clearLayers).toHaveBeenCalledTimes(1);
      expect(pl1!.setStyle).toHaveBeenCalledWith({
        color: getColorForAltitude(3000, 3000, 3000),
        weight: 6,
        opacity: 1,
      });
      expect(pl2!.setStyle).toHaveBeenCalledWith({
        color: getColorForAltitude(2000, 3000, 3000),
        weight: 4,
        opacity: 0.1,
      });
      expect(document.getElementById("legend-min")!.textContent).toBe(
        "3000 ft (914 m)",
      );
    });

    it("restores normal styles when the selection is cleared", () => {
      mockApp.altitudeVisible = true;
      mockApp.selectedPathIds.add(1);
      layerManager.redrawAltitudePaths();
      const [pl1] = polylines();

      mockApp.selectedPathIds.clear();
      layerManager.updateSelectionStyles();

      expect(pl1!.setStyle).toHaveBeenLastCalledWith({
        color: getColorForAltitude(3000, 0, 5000),
        weight: 4,
        opacity: 0.85,
      });
      expect(document.getElementById("legend-max")!.textContent).toBe(
        "5000 ft (1524 m)",
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

    it("restyles the airspeed layer when visible", () => {
      mockApp.airspeedVisible = true;
      layerManager.redrawAirspeedPaths();
      const [pl1] = polylines();

      mockApp.selectedPathIds.add(2);
      layerManager.updateSelectionStyles();

      expect(pl1!.setStyle).toHaveBeenCalledWith({
        color: getColorForAirspeed(100, 80, 80),
        weight: 4,
        opacity: 0.1,
      });
    });
  });

  describe("getPathInfoMap", () => {
    it("indexes path info by id and caches per data instance", () => {
      const first = layerManager.getPathInfoMap();
      expect(first.get(1)?.aircraft_registration).toBe("D-ABCD");
      expect(layerManager.getPathInfoMap()).toBe(first);

      mockApp.currentData = createDataset([{ id: 5 }]);
      const second = layerManager.getPathInfoMap();
      expect(second).not.toBe(first);
      expect(second.has(5)).toBe(true);
    });

    it("returns an empty map without data", () => {
      mockApp.currentData = null;
      expect(layerManager.getPathInfoMap().size).toBe(0);
    });
  });

  describe("isTouchDevice", () => {
    it("returns false when no touch support", () => {
      expect(isTouchDevice()).toBe(false);
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
      expect(contentFn()).toContain("3000 ft");
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
        "3000 ft",
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
  });
});
