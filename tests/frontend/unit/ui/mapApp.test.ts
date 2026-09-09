import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { MapApp, bindActions } from "../../../../kml_heatmap/frontend/mapApp";
import type {
  KMLDataset,
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
}));

const config = {
  center: [48.0, 16.0] as [number, number],
  bounds: [
    [47.0, 15.0],
    [49.0, 17.0],
  ] as [[number, number], [number, number]],
  dataDir: "data",
};

describe("MapApp", () => {
  describe("constructor", () => {
    it("initializes with default state", () => {
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
      expect(app.isInitializing).toBe(true);
      expect(app.selectedPathIds).toEqual(new Set());
      expect(app.pathRenderer).toBeDefined();
      expect(app.airportToPaths).toEqual({});
      expect(app.airportMarkers).toEqual({});
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
      app = new MapApp(config);
    });

    it("selectedYear getter/setter delegates to store", () => {
      app.selectedYear = "2025";
      expect(app.store.get("selectedYear")).toBe("2025");
      expect(app.selectedYear).toBe("2025");
    });

    it("selectedAircraft getter/setter delegates to store", () => {
      app.selectedAircraft = "D-EAGJ";
      expect(app.store.get("selectedAircraft")).toBe("D-EAGJ");
    });

    it("selectedPathIds getter/setter delegates to store", () => {
      const ids = new Set([1, 2, 3]);
      app.selectedPathIds = ids;
      expect(app.store.get("selectedPathIds")).toBe(ids);
    });

    it.each([
      "isolateSelection",
      "heatmapVisible",
      "altitudeVisible",
      "airspeedVisible",
      "airportsVisible",
      "aviationVisible",
      "buttonsHidden",
    ] as const)("%s getter/setter delegates to store", (key) => {
      const initial = app[key];
      app[key] = !initial;
      expect(app.store.get(key)).toBe(!initial);
      expect(app[key]).toBe(!initial);
    });

    it("currentData getter/setter delegates to store", () => {
      const data: KMLDataset = {
        coordinates: [],
        path_segments: [],
        path_info: [],
        original_points: 0,
      };
      app.currentData = data;
      expect(app.store.get("currentData")).toBe(data);
    });

    it("fullPathInfo and fullPathSegments derive from currentData", () => {
      expect(app.fullPathInfo).toBeNull();
      expect(app.fullPathSegments).toBeNull();

      const data: KMLDataset = {
        coordinates: [],
        path_segments: [{ path_id: 1 }],
        path_info: [{ id: 1 }],
        original_points: 0,
      };
      app.currentData = data;

      expect(app.fullPathInfo).toBe(data.path_info);
      expect(app.fullPathSegments).toBe(data.path_segments);
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
      expect(app.store.get("fullStats")).toBe(stats);
    });

    it("altitudeRange and airspeedRange delegate to store", () => {
      app.altitudeRange = { min: 100, max: 5000 };
      app.airspeedRange = { min: 50, max: 150 };
      expect(app.store.get("altitudeRange")).toEqual({ min: 100, max: 5000 });
      expect(app.store.get("airspeedRange")).toEqual({ min: 50, max: 150 });
    });
  });

  describe("delegating methods", () => {
    it("forward to the responsible managers", () => {
      const app = new MapApp(config);
      app.pathSelection = { togglePathSelection: vi.fn() } as never;
      app.replayManager = {
        seekReplay: vi.fn(),
        changeReplaySpeed: vi.fn(),
      } as never;

      app.togglePathSelection("7");
      app.seekReplay("42");
      app.changeReplaySpeed();

      expect(
        (
          app.pathSelection as unknown as {
            togglePathSelection: ReturnType<typeof vi.fn>;
          }
        ).togglePathSelection,
      ).toHaveBeenCalledWith(7);
      expect(
        (
          app.replayManager as unknown as {
            seekReplay: ReturnType<typeof vi.fn>;
          }
        ).seekReplay,
      ).toHaveBeenCalledWith("42");
      expect(
        (
          app.replayManager as unknown as {
            changeReplaySpeed: ReturnType<typeof vi.fn>;
          }
        ).changeReplaySpeed,
      ).toHaveBeenCalled();
    });
  });

  describe("window bindings", () => {
    it("defines window.initMapApp", () => {
      expect(typeof window.initMapApp).toBe("function");
    });

    // Shared setup for data-action binding tests
    let actionElements: Record<string, HTMLElement>;
    let result: MapApp;
    let initSpy: ReturnType<typeof vi.spyOn>;
    let bindOrder: string[];

    beforeEach(async () => {
      actionElements = {};
      bindOrder = [];
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
        "stopPropagation",
        "unknownAction",
      ];

      buttonActions.forEach((action) => {
        const btn = document.createElement("button");
        btn.dataset["action"] = action;
        document.body.appendChild(btn);
        actionElements[action] = btn;
      });

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

      const slider = document.createElement("input");
      slider.type = "range";
      slider.dataset["action"] = "seekReplay";
      slider.value = "50";
      document.body.appendChild(slider);
      actionElements["seekReplay"] = slider;

      const speedSelect = document.createElement("select");
      speedSelect.dataset["action"] = "changeReplaySpeed";
      document.body.appendChild(speedSelect);
      actionElements["changeReplaySpeed"] = speedSelect;

      const addSpy = vi.spyOn(HTMLElement.prototype, "addEventListener");
      initSpy = vi
        .spyOn(MapApp.prototype, "initialize")
        .mockImplementation(function (this: MapApp) {
          bindOrder.push("initialize");
          this.isInitializing = false;
          return Promise.resolve();
        });
      addSpy.mockImplementation(function (
        this: HTMLElement,
        ...args: Parameters<HTMLElement["addEventListener"]>
      ) {
        if (!bindOrder.includes("bind")) bindOrder.push("bind");
        return EventTarget.prototype.addEventListener.apply(this, args);
      });

      result = await window.initMapApp!(config);
      addSpy.mockRestore();

      result.uiToggles = {
        toggleHeatmap: vi.fn(),
        toggleAltitude: vi.fn(),
        toggleAirspeed: vi.fn(),
        toggleAirports: vi.fn(),
        toggleAviation: vi.fn(),
        toggleButtonsVisibility: vi.fn(),
        exportMap: vi.fn(),
      } as never;
      result.statsManager = { toggleStats: vi.fn() } as never;
      result.replayManager = {
        toggleReplay: vi.fn(),
        playReplay: vi.fn(),
        pauseReplay: vi.fn(),
        stopReplay: vi.fn(),
        seekReplay: vi.fn(),
        changeReplaySpeed: vi.fn(),
        toggleAutoZoom: vi.fn(),
      } as never;
      result.filterManager = {
        filterByYear: vi.fn().mockResolvedValue(undefined),
        filterByAircraft: vi.fn().mockResolvedValue(undefined),
      } as never;
      result.pathSelection = {
        togglePathSelection: vi.fn(),
        toggleIsolateSelection: vi.fn(),
      } as never;
      result.wrappedManager = {
        showWrapped: vi.fn(),
        closeWrapped: vi.fn(),
      } as never;
    });

    afterEach(() => {
      Object.values(actionElements).forEach((el) => el.remove());
      initSpy.mockRestore();
    });

    const mocks = (): Record<
      string,
      Record<string, ReturnType<typeof vi.fn>>
    > =>
      result as unknown as Record<
        string,
        Record<string, ReturnType<typeof vi.fn>>
      >;

    it("initMapApp creates the app, binds actions before initializing, then initializes", () => {
      expect(result).toBeInstanceOf(MapApp);
      expect(window.mapApp).toBe(result);
      expect(bindOrder).toEqual(["bind", "initialize"]);
      expect(initSpy).toHaveBeenCalledTimes(1);
    });

    it("binds UI toggle actions", () => {
      actionElements["toggleHeatmap"]!.click();
      actionElements["toggleAltitude"]!.click();
      actionElements["toggleAirspeed"]!.click();
      actionElements["toggleAirports"]!.click();
      actionElements["toggleAviation"]!.click();
      actionElements["toggleButtonsVisibility"]!.click();
      actionElements["exportMap"]!.click();

      const ui = mocks()["uiToggles"]!;
      expect(ui["toggleHeatmap"]).toHaveBeenCalledTimes(1);
      expect(ui["toggleAltitude"]).toHaveBeenCalledTimes(1);
      expect(ui["toggleAirspeed"]).toHaveBeenCalledTimes(1);
      expect(ui["toggleAirports"]).toHaveBeenCalledTimes(1);
      expect(ui["toggleAviation"]).toHaveBeenCalledTimes(1);
      expect(ui["toggleButtonsVisibility"]).toHaveBeenCalledTimes(1);
      expect(ui["exportMap"]).toHaveBeenCalledTimes(1);
    });

    it("binds stats action", () => {
      actionElements["toggleStats"]!.click();
      expect(mocks()["statsManager"]!["toggleStats"]).toHaveBeenCalledTimes(1);
    });

    it("binds replay actions", () => {
      actionElements["toggleReplay"]!.click();
      actionElements["playReplay"]!.click();
      actionElements["pauseReplay"]!.click();
      actionElements["stopReplay"]!.click();
      actionElements["seekReplay"]!.dispatchEvent(new Event("input"));
      actionElements["changeReplaySpeed"]!.dispatchEvent(new Event("change"));
      actionElements["toggleAutoZoom"]!.click();

      const replay = mocks()["replayManager"]!;
      expect(replay["toggleReplay"]).toHaveBeenCalledTimes(1);
      expect(replay["playReplay"]).toHaveBeenCalledTimes(1);
      expect(replay["pauseReplay"]).toHaveBeenCalledTimes(1);
      expect(replay["stopReplay"]).toHaveBeenCalledTimes(1);
      expect(replay["seekReplay"]).toHaveBeenCalledWith("50");
      expect(replay["changeReplaySpeed"]).toHaveBeenCalledTimes(1);
      expect(replay["toggleAutoZoom"]).toHaveBeenCalledTimes(1);
    });

    it("binds filter actions", () => {
      actionElements["filterByYear"]!.dispatchEvent(new Event("change"));
      actionElements["filterByAircraft"]!.dispatchEvent(new Event("change"));

      const filter = mocks()["filterManager"]!;
      expect(filter["filterByYear"]).toHaveBeenCalledTimes(1);
      expect(filter["filterByAircraft"]).toHaveBeenCalledTimes(1);
    });

    it("binds wrapped modal actions", () => {
      actionElements["showWrapped"]!.click();
      actionElements["closeWrapped"]!.click();
      actionElements["closeWrappedBackdrop"]!.click();

      const wrapped = mocks()["wrappedManager"]!;
      expect(wrapped["showWrapped"]).toHaveBeenCalledTimes(1);
      expect(wrapped["closeWrapped"]).toHaveBeenCalledTimes(2);
      expect(wrapped["closeWrapped"]).toHaveBeenLastCalledWith(
        expect.any(MouseEvent),
      );
    });

    it("binds path selection actions", () => {
      actionElements["toggleIsolateSelection"]!.click();
      expect(
        mocks()["pathSelection"]!["toggleIsolateSelection"],
      ).toHaveBeenCalledTimes(1);
    });

    it("stops propagation for stopPropagation actions", () => {
      const event = new MouseEvent("click", { bubbles: true });
      const stop = vi.spyOn(event, "stopPropagation");

      actionElements["stopPropagation"]!.dispatchEvent(event);

      expect(stop).toHaveBeenCalled();
    });

    it("ignores unknown actions", () => {
      expect(() => actionElements["unknownAction"]!.click()).not.toThrow();
    });

    it("ignores data-dependent actions while initializing but keeps UI toggles", () => {
      result.isInitializing = true;

      actionElements["filterByYear"]!.dispatchEvent(new Event("change"));
      actionElements["filterByAircraft"]!.dispatchEvent(new Event("change"));
      actionElements["toggleReplay"]!.click();
      actionElements["showWrapped"]!.click();
      actionElements["exportMap"]!.click();
      actionElements["toggleIsolateSelection"]!.click();
      actionElements["toggleHeatmap"]!.click();
      actionElements["toggleAltitude"]!.click();
      actionElements["toggleStats"]!.click();
      actionElements["toggleButtonsVisibility"]!.click();

      expect(mocks()["filterManager"]!["filterByYear"]).not.toHaveBeenCalled();
      expect(
        mocks()["filterManager"]!["filterByAircraft"],
      ).not.toHaveBeenCalled();
      expect(mocks()["replayManager"]!["toggleReplay"]).not.toHaveBeenCalled();
      expect(mocks()["wrappedManager"]!["showWrapped"]).not.toHaveBeenCalled();
      expect(mocks()["uiToggles"]!["exportMap"]).not.toHaveBeenCalled();
      expect(
        mocks()["pathSelection"]!["toggleIsolateSelection"],
      ).not.toHaveBeenCalled();
      expect(mocks()["uiToggles"]!["toggleHeatmap"]).toHaveBeenCalledTimes(1);
      expect(mocks()["uiToggles"]!["toggleAltitude"]).toHaveBeenCalledTimes(1);
      expect(mocks()["statsManager"]!["toggleStats"]).toHaveBeenCalledTimes(1);
      expect(
        mocks()["uiToggles"]!["toggleButtonsVisibility"],
      ).toHaveBeenCalledTimes(1);
    });

    it("logs rejected filter promises instead of throwing", async () => {
      const { logError } =
        await import("../../../../kml_heatmap/frontend/utils/logger");
      const error = new Error("filter failed");
      mocks()["filterManager"]!["filterByYear"]!.mockRejectedValueOnce(error);

      actionElements["filterByYear"]!.dispatchEvent(new Event("change"));
      await Promise.resolve();
      await Promise.resolve();

      expect(logError).toHaveBeenCalledWith(error);
    });
  });

  describe("bindActions", () => {
    it("can be called directly for an app instance", () => {
      const app = new MapApp(config);
      app.isInitializing = false;
      app.statsManager = { toggleStats: vi.fn() } as never;
      const btn = document.createElement("button");
      btn.dataset["action"] = "toggleStats";
      document.body.appendChild(btn);

      bindActions(app);
      btn.click();

      expect(
        (
          app.statsManager as unknown as {
            toggleStats: ReturnType<typeof vi.fn>;
          }
        ).toggleStats,
      ).toHaveBeenCalledTimes(1);
      btn.remove();
    });
  });
});
