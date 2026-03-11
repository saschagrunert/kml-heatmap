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
      expect(result.wrappedManager.closeWrapped).toHaveBeenCalledWith(
        undefined
      );

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
