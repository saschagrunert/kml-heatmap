import { describe, it, expect, beforeEach, vi } from "vitest";
import { MapApp } from "../../../../kml_heatmap/frontend/mapApp";

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

  describe("delegating methods", () => {
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

      // Set up mock managers
      app.uiToggles = {
        toggleHeatmap: vi.fn(),
        toggleAltitude: vi.fn(),
        toggleAirspeed: vi.fn(),
        toggleAirports: vi.fn(),
        toggleAviation: vi.fn(),
        toggleButtonsVisibility: vi.fn(),
        exportMap: vi.fn(),
      } as any;

      app.statsManager = {
        toggleStats: vi.fn(),
      } as any;

      app.replayManager = {
        toggleReplay: vi.fn(),
        playReplay: vi.fn(),
        pauseReplay: vi.fn(),
        stopReplay: vi.fn(),
        seekReplay: vi.fn(),
        changeReplaySpeed: vi.fn(),
        toggleAutoZoom: vi.fn(),
      } as any;

      app.filterManager = {
        filterByYear: vi.fn().mockResolvedValue(undefined),
        filterByAircraft: vi.fn().mockResolvedValue(undefined),
      } as any;

      app.pathSelection = {
        togglePathSelection: vi.fn().mockResolvedValue(undefined),
      } as any;

      app.wrappedManager = {
        showWrapped: vi.fn().mockResolvedValue(undefined),
        closeWrapped: vi.fn(),
      } as any;
    });

    it("toggleHeatmap delegates to uiToggles", () => {
      app.toggleHeatmap();
      expect(app.uiToggles.toggleHeatmap).toHaveBeenCalled();
    });

    it("toggleAltitude delegates to uiToggles", () => {
      app.toggleAltitude();
      expect(app.uiToggles.toggleAltitude).toHaveBeenCalled();
    });

    it("toggleAirspeed delegates to uiToggles", () => {
      app.toggleAirspeed();
      expect(app.uiToggles.toggleAirspeed).toHaveBeenCalled();
    });

    it("toggleAirports delegates to uiToggles", () => {
      app.toggleAirports();
      expect(app.uiToggles.toggleAirports).toHaveBeenCalled();
    });

    it("toggleAviation delegates to uiToggles", () => {
      app.toggleAviation();
      expect(app.uiToggles.toggleAviation).toHaveBeenCalled();
    });

    it("toggleButtonsVisibility delegates to uiToggles", () => {
      app.toggleButtonsVisibility();
      expect(app.uiToggles.toggleButtonsVisibility).toHaveBeenCalled();
    });

    it("exportMap delegates to uiToggles", () => {
      app.exportMap();
      expect(app.uiToggles.exportMap).toHaveBeenCalled();
    });

    it("toggleStats delegates to statsManager", () => {
      app.toggleStats();
      expect(app.statsManager.toggleStats).toHaveBeenCalled();
    });

    it("toggleReplay delegates to replayManager", () => {
      app.toggleReplay();
      expect(app.replayManager.toggleReplay).toHaveBeenCalled();
    });

    it("playReplay delegates to replayManager", () => {
      app.playReplay();
      expect(app.replayManager.playReplay).toHaveBeenCalled();
    });

    it("pauseReplay delegates to replayManager", () => {
      app.pauseReplay();
      expect(app.replayManager.pauseReplay).toHaveBeenCalled();
    });

    it("stopReplay delegates to replayManager", () => {
      app.stopReplay();
      expect(app.replayManager.stopReplay).toHaveBeenCalled();
    });

    it("seekReplay delegates to replayManager with string value", () => {
      app.seekReplay("42");
      expect(app.replayManager.seekReplay).toHaveBeenCalledWith("42");
    });

    it("changeReplaySpeed delegates to replayManager", () => {
      app.changeReplaySpeed();
      expect(app.replayManager.changeReplaySpeed).toHaveBeenCalled();
    });

    it("toggleAutoZoom delegates to replayManager", () => {
      app.toggleAutoZoom();
      expect(app.replayManager.toggleAutoZoom).toHaveBeenCalled();
    });

    it("filterByYear delegates to filterManager", () => {
      app.filterByYear();
      expect(app.filterManager.filterByYear).toHaveBeenCalled();
    });

    it("filterByAircraft delegates to filterManager", () => {
      app.filterByAircraft();
      expect(app.filterManager.filterByAircraft).toHaveBeenCalled();
    });

    it("togglePathSelection delegates to pathSelection with numeric id", () => {
      app.togglePathSelection("42");
      expect(app.pathSelection.togglePathSelection).toHaveBeenCalledWith(42);
    });

    it("showWrapped delegates to wrappedManager", () => {
      app.showWrapped();
      expect(app.wrappedManager.showWrapped).toHaveBeenCalled();
    });

    it("closeWrapped delegates to wrappedManager", () => {
      const event = new MouseEvent("click");
      app.closeWrapped(event);
      expect(app.wrappedManager.closeWrapped).toHaveBeenCalledWith(event);
    });
  });

  describe("window bindings", () => {
    it("defines window.initMapApp", () => {
      expect(window.initMapApp).toBeDefined();
      expect(typeof window.initMapApp).toBe("function");
    });

    it("initMapApp creates app, initializes, and sets up window functions", async () => {
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

      // Set up mock managers so window functions can delegate
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
      } as any;
      result.wrappedManager = {
        showWrapped: vi.fn().mockResolvedValue(undefined),
        closeWrapped: vi.fn(),
      } as any;

      // Call each window function to cover the arrow function bodies
      window.toggleHeatmap!();
      expect(result.uiToggles.toggleHeatmap).toHaveBeenCalled();

      window.toggleStats!();
      expect(result.statsManager.toggleStats).toHaveBeenCalled();

      window.toggleAltitude!();
      expect(result.uiToggles.toggleAltitude).toHaveBeenCalled();

      window.toggleAirspeed!();
      expect(result.uiToggles.toggleAirspeed).toHaveBeenCalled();

      window.toggleAirports!();
      expect(result.uiToggles.toggleAirports).toHaveBeenCalled();

      window.toggleAviation!();
      expect(result.uiToggles.toggleAviation).toHaveBeenCalled();

      window.toggleReplay!();
      expect(result.replayManager.toggleReplay).toHaveBeenCalled();

      window.filterByYear!();
      expect(result.filterManager.filterByYear).toHaveBeenCalled();

      window.filterByAircraft!();
      expect(result.filterManager.filterByAircraft).toHaveBeenCalled();

      window.togglePathSelection!("42");
      expect(result.pathSelection.togglePathSelection).toHaveBeenCalledWith(42);

      window.exportMap!();
      expect(result.uiToggles.exportMap).toHaveBeenCalled();

      window.showWrapped!();
      expect(result.wrappedManager.showWrapped).toHaveBeenCalled();

      window.closeWrapped!();
      expect(result.wrappedManager.closeWrapped).toHaveBeenCalled();

      window.toggleButtonsVisibility!();
      expect(result.uiToggles.toggleButtonsVisibility).toHaveBeenCalled();

      window.playReplay!();
      expect(result.replayManager.playReplay).toHaveBeenCalled();

      window.pauseReplay!();
      expect(result.replayManager.pauseReplay).toHaveBeenCalled();

      window.stopReplay!();
      expect(result.replayManager.stopReplay).toHaveBeenCalled();

      window.seekReplay!("50");
      expect(result.replayManager.seekReplay).toHaveBeenCalledWith("50");

      window.changeReplaySpeed!();
      expect(result.replayManager.changeReplaySpeed).toHaveBeenCalled();

      window.toggleAutoZoom!();
      expect(result.replayManager.toggleAutoZoom).toHaveBeenCalled();

      initSpy.mockRestore();
    });
  });
});
