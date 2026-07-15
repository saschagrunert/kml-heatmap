import { describe, it, expect, beforeEach, vi } from "vitest";
import { MapApp } from "../../../../kml_heatmap/frontend/mapApp";
import type {
  KMLDataset,
  PathInfo,
  PathSegment,
  FilteredStatistics,
} from "../../../../kml_heatmap/frontend/types";

// Mock domCache
vi.mock("../../../../kml_heatmap/frontend/utils/domCache", () => ({
  domCache: {
    get: vi.fn((id: string) => document.getElementById(id)),
    cacheElements: vi.fn(),
  },
}));

// Mock logger
vi.mock("../../../../kml_heatmap/frontend/utils/logger", () => ({
  logDebug: vi.fn(),
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

describe("MapApp", () => {
  describe("constructor", () => {
    it("initializes with default state", () => {
      const config = {
        center: [48.0, 16.0] as [number, number],
        bounds: [
          [47.0, 15.0],
          [49.0, 17.0],
        ] as [[number, number], [number, number]],
        dataDir: "data",
      };

      const app = new MapApp(config);

      expect(app.config).toBe(config);
      expect(app.selectedYear).toBe("all");
      expect(app.selectedAircraft).toBe("all");
      expect(app.map).toBeNull();
      expect(app.heatmapLayer).toBeNull();
      expect(app.heatmapVisible).toBe(true);
      expect(app.altitudeVisible).toBe(false);
      expect(app.airspeedVisible).toBe(false);
      expect(app.airportsVisible).toBe(true);
      expect(app.aviationVisible).toBe(false);
      expect(app.buttonsHidden).toBe(false);
      expect(app.selectedPathIds).toEqual(new Set());
      expect(app.stateManager).toBeUndefined();
      expect(app.dataManager).toBeUndefined();
      expect(app.layerManager).toBeUndefined();
      expect(app.replayManager).toBeUndefined();
      expect(app.uiToggles).toBeUndefined();
    });
  });

  describe("store-backed properties", () => {
    let app: MapApp;

    beforeEach(() => {
      app = new MapApp({
        center: [48.0, 16.0],
        bounds: [
          [47.0, 15.0],
          [49.0, 17.0],
        ],
        dataDir: "data",
      });
    });

    it("selectedYear getter/setter delegates to store", () => {
      app.selectedYear = "2025";
      expect(app.selectedYear).toBe("2025");
    });

    it("selectedAircraft getter/setter delegates to store", () => {
      app.selectedAircraft = "D-EAGJ";
      expect(app.selectedAircraft).toBe("D-EAGJ");
    });

    it("selectedPathIds getter/setter delegates to store", () => {
      const ids = new Set([1, 2, 3]);
      app.selectedPathIds = ids;
      expect(app.selectedPathIds).toBe(ids);
    });

    it("isolateSelection getter/setter delegates to store", () => {
      app.isolateSelection = true;
      expect(app.isolateSelection).toBe(true);
    });

    it("heatmapVisible getter/setter delegates to store", () => {
      app.heatmapVisible = false;
      expect(app.heatmapVisible).toBe(false);
    });

    it("altitudeVisible getter/setter delegates to store", () => {
      app.altitudeVisible = true;
      expect(app.altitudeVisible).toBe(true);
    });

    it("airspeedVisible getter/setter delegates to store", () => {
      app.airspeedVisible = true;
      expect(app.airspeedVisible).toBe(true);
    });

    it("airportsVisible getter/setter delegates to store", () => {
      app.airportsVisible = false;
      expect(app.airportsVisible).toBe(false);
    });

    it("aviationVisible getter/setter delegates to store", () => {
      app.aviationVisible = true;
      expect(app.aviationVisible).toBe(true);
    });

    it("buttonsHidden getter/setter delegates to store", () => {
      app.buttonsHidden = true;
      expect(app.buttonsHidden).toBe(true);
    });

    it("currentData getter/setter delegates to store", () => {
      const data: KMLDataset = {
        coordinates: [],
        path_segments: [],
        path_info: [],
        resolution: "full",
        original_points: 0,
      };
      app.currentData = data;
      expect(app.currentData).toBe(data);
    });

    it("fullPathInfo getter/setter delegates to store", () => {
      const info: PathInfo[] = [{ id: 1 }];
      app.fullPathInfo = info;
      expect(app.fullPathInfo).toBe(info);
    });

    it("fullPathSegments getter/setter delegates to store", () => {
      const segments: PathSegment[] = [{ path_id: 1 }];
      app.fullPathSegments = segments;
      expect(app.fullPathSegments).toBe(segments);
    });

    it("fullStats getter/setter delegates to store", () => {
      const stats: FilteredStatistics = {
        total_points: 100,
        num_paths: 5,
        num_airports: 2,
        airport_names: [],
        num_aircraft: 1,
        aircraft_list: [],
        total_distance_km: 50,
        total_distance_nm: 27,
      };
      app.fullStats = stats;
      expect(app.fullStats).toBe(stats);
    });

    it("altitudeRange getter/setter delegates to store", () => {
      const range = { min: 100, max: 5000 };
      app.altitudeRange = range;
      expect(app.altitudeRange).toEqual({ min: 100, max: 5000 });
    });

    it("airspeedRange getter/setter delegates to store", () => {
      const range = { min: 50, max: 150 };
      app.airspeedRange = range;
      expect(app.airspeedRange).toEqual({ min: 50, max: 150 });
    });
  });

  describe("bindActions wiring", () => {
    it("managers are accessible after construction", () => {
      const app = new MapApp({
        center: [48.0, 16.0],
        bounds: [
          [47.0, 15.0],
          [49.0, 17.0],
        ],
        dataDir: "data",
      });

      expect(app.store).toBeDefined();
      expect(app.config).toBeDefined();
    });
  });

  describe("window bindings", () => {
    it("defines window.initMapApp", () => {
      expect(window.initMapApp).toBeDefined();
      expect(typeof window.initMapApp).toBe("function");
    });

    it("initMapApp creates app, initializes, and binds data-action listeners", async () => {
      // Create DOM elements with data-action attributes
      const actionElements: Record<string, HTMLElement> = {};
      const buttonActions = [
        "toggleHeatmap",
        "toggleStats",
        "toggleAltitude",
        "toggleAirspeed",
        "toggleAirports",
        "toggleAviation",
        "toggleReplay",
        "exportMap",
        "showWrapped",
        "closeWrapped",
        "closeWrappedBackdrop",
        "toggleIsolateSelection",
        "toggleButtonsVisibility",
        "playReplay",
        "pauseReplay",
        "stopReplay",
        "toggleAutoZoom",
      ];

      buttonActions.forEach((action) => {
        const btn = document.createElement("button");
        btn.dataset["action"] = action;
        document.body.appendChild(btn);
        actionElements[action] = btn;
      });

      // Selects use "change" event
      const yearSelect = document.createElement("select");
      yearSelect.id = "year-select";
      yearSelect.dataset["action"] = "filterByYear";
      document.body.appendChild(yearSelect);
      actionElements["filterByYear"] = yearSelect;

      const aircraftSelect = document.createElement("select");
      aircraftSelect.id = "aircraft-select";
      aircraftSelect.dataset["action"] = "filterByAircraft";
      document.body.appendChild(aircraftSelect);
      actionElements["filterByAircraft"] = aircraftSelect;

      // Slider uses "input" event
      const slider = document.createElement("input");
      slider.type = "range";
      slider.dataset["action"] = "seekReplay";
      slider.value = "50";
      document.body.appendChild(slider);
      actionElements["seekReplay"] = slider;

      // Speed select uses "change" event
      const speedSelect = document.createElement("select");
      speedSelect.dataset["action"] = "changeReplaySpeed";
      document.body.appendChild(speedSelect);
      actionElements["changeReplaySpeed"] = speedSelect;

      // Mock initialize to avoid full setup
      const initSpy = vi
        .spyOn(MapApp.prototype, "initialize")
        .mockResolvedValue();

      const config = {
        center: [48.0, 16.0] as [number, number],
        bounds: [
          [47.0, 15.0],
          [49.0, 17.0],
        ] as [[number, number], [number, number]],
        dataDir: "data",
      };

      const result = await window.initMapApp!(config);

      expect(initSpy).toHaveBeenCalled();
      expect(result).toBeInstanceOf(MapApp);
      expect(window.mapApp).toBe(result);

      // Set up mock managers so bound listeners can delegate
      result.uiToggles = {
        toggleHeatmap: vi.fn(),
        toggleAltitude: vi.fn(),
        toggleAirspeed: vi.fn(),
        toggleAirports: vi.fn(),
        toggleAviation: vi.fn(),
        toggleButtonsVisibility: vi.fn(),
        exportMap: vi.fn(),
      } as any;
      result.statsManager = { toggleStats: vi.fn() } as any;
      result.replayManager = {
        toggleReplay: vi.fn(),
        playReplay: vi.fn(),
        pauseReplay: vi.fn(),
        stopReplay: vi.fn(),
        seekReplay: vi.fn(),
        changeReplaySpeed: vi.fn(),
        toggleAutoZoom: vi.fn(),
      } as any;
      result.filterManager = {
        filterByYear: vi.fn().mockResolvedValue(undefined),
        filterByAircraft: vi.fn().mockResolvedValue(undefined),
      } as any;
      result.pathSelection = {
        togglePathSelection: vi.fn().mockResolvedValue(undefined),
        toggleIsolateSelection: vi.fn(),
      } as any;
      result.wrappedManager = {
        showWrapped: vi.fn().mockResolvedValue(undefined),
        closeWrapped: vi.fn(),
      } as any;

      // Click buttons and verify delegation
      actionElements["toggleHeatmap"]!.click();
      expect(result.uiToggles.toggleHeatmap).toHaveBeenCalled();

      actionElements["toggleStats"]!.click();
      expect(result.statsManager.toggleStats).toHaveBeenCalled();

      actionElements["toggleAltitude"]!.click();
      expect(result.uiToggles.toggleAltitude).toHaveBeenCalled();

      actionElements["toggleAirspeed"]!.click();
      expect(result.uiToggles.toggleAirspeed).toHaveBeenCalled();

      actionElements["toggleAirports"]!.click();
      expect(result.uiToggles.toggleAirports).toHaveBeenCalled();

      actionElements["toggleAviation"]!.click();
      expect(result.uiToggles.toggleAviation).toHaveBeenCalled();

      actionElements["toggleReplay"]!.click();
      expect(result.replayManager.toggleReplay).toHaveBeenCalled();

      actionElements["filterByYear"].dispatchEvent(new Event("change"));
      expect(result.filterManager.filterByYear).toHaveBeenCalled();

      actionElements["filterByAircraft"].dispatchEvent(new Event("change"));
      expect(result.filterManager.filterByAircraft).toHaveBeenCalled();

      actionElements["exportMap"]!.click();
      expect(result.uiToggles.exportMap).toHaveBeenCalled();

      actionElements["showWrapped"]!.click();
      expect(result.wrappedManager.showWrapped).toHaveBeenCalled();

      actionElements["closeWrapped"]!.click();
      expect(result.wrappedManager.closeWrapped).toHaveBeenCalled();

      // Backdrop click passes event for target check
      actionElements["closeWrappedBackdrop"]!.click();
      expect(result.wrappedManager.closeWrapped).toHaveBeenCalledTimes(2);

      actionElements["toggleIsolateSelection"]!.click();
      expect(result.pathSelection.toggleIsolateSelection).toHaveBeenCalled();

      actionElements["toggleButtonsVisibility"]!.click();
      expect(result.uiToggles.toggleButtonsVisibility).toHaveBeenCalled();

      actionElements["playReplay"]!.click();
      expect(result.replayManager.playReplay).toHaveBeenCalled();

      actionElements["pauseReplay"]!.click();
      expect(result.replayManager.pauseReplay).toHaveBeenCalled();

      actionElements["stopReplay"]!.click();
      expect(result.replayManager.stopReplay).toHaveBeenCalled();

      actionElements["seekReplay"].dispatchEvent(new Event("input"));
      expect(result.replayManager.seekReplay).toHaveBeenCalledWith("50");

      actionElements["changeReplaySpeed"].dispatchEvent(new Event("change"));
      expect(result.replayManager.changeReplaySpeed).toHaveBeenCalled();

      actionElements["toggleAutoZoom"]!.click();
      expect(result.replayManager.toggleAutoZoom).toHaveBeenCalled();

      // Cleanup
      Object.values(actionElements).forEach((el) => el.remove());
      initSpy.mockRestore();
    });
  });
});
