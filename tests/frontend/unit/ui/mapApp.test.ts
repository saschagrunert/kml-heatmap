import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  INIT_ERROR_HTML,
  MapApp,
  initMapApp,
  reportInitFailure,
} from "../../../../kml_heatmap/frontend/mapApp";
import { STORE_ACCESSOR_KEYS } from "../../../../kml_heatmap/frontend/state/store";
import type {
  KMLDataset,
  FilteredStatistics,
} from "../../../../kml_heatmap/frontend/types";

const loggerMock = vi.hoisted(() => ({ logDebug: vi.fn(), logError: vi.fn() }));
vi.mock("../../../../kml_heatmap/frontend/utils/logger", () => loggerMock);

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
      expect(app.isInitializing).toBe(true);
      expect(app.selectedPathIds).toEqual(new Set());
      expect(app.pathRenderer).toBeDefined();
      expect(app.airportToPaths).toEqual({});
      expect(app.airportMarkers).toEqual({});
    });
  });

  describe("store-backed properties", () => {
    let app: MapApp;

    beforeEach(() => {
      app = new MapApp(config);
    });

    it("exposes every accessor key as a property that reads the store", () => {
      for (const key of STORE_ACCESSOR_KEYS) {
        expect(app[key]).toBe(app.store.get(key));
      }
    });

    it("selectedYear getter/setter delegates to store", () => {
      app.selectedYear = "2025";
      expect(app.store.get("selectedYear")).toBe("2025");
      expect(app.selectedYear).toBe("2025");
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
    ] as const)("%s getter/setter delegates to store", (key) => {
      const initial = app[key];
      app[key] = !initial;
      expect(app.store.get(key)).toBe(!initial);
      expect(app[key]).toBe(!initial);
    });

    it("notifies store subscribers through the setter", () => {
      const fn = vi.fn();
      app.store.subscribe("selectedAircraft", fn);

      app.selectedAircraft = "D-EAGJ";

      expect(fn).toHaveBeenCalledWith("D-EAGJ", "all");
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

      expect(app.store.get("currentData")).toBe(data);
      expect(app.fullPathInfo).toBe(data.path_info);
      expect(app.fullPathSegments).toBe(data.path_segments);
    });

    it("fullStats and the ranges delegate to store", () => {
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
      app.altitudeRange = { min: 100, max: 5000 };
      app.airspeedRange = { min: 50, max: 150 };

      expect(app.store.get("fullStats")).toBe(stats);
      expect(app.store.get("altitudeRange")).toEqual({ min: 100, max: 5000 });
      expect(app.store.get("airspeedRange")).toEqual({ min: 50, max: 150 });
    });
  });

  describe("initMapApp", () => {
    let initSpy: ReturnType<typeof vi.spyOn>;
    let bindOrder: string[];
    let btn: HTMLButtonElement;

    beforeEach(() => {
      bindOrder = [];
      btn = document.createElement("button");
      btn.dataset["action"] = "toggleStats";
      btn.dataset["icon"] = "stats";
      document.body.appendChild(btn);

      const addSpy = vi.spyOn(HTMLElement.prototype, "addEventListener");
      addSpy.mockImplementation(function (
        this: HTMLElement,
        ...args: Parameters<HTMLElement["addEventListener"]>
      ) {
        if (!bindOrder.includes("bind")) bindOrder.push("bind");
        return EventTarget.prototype.addEventListener.apply(this, args);
      });
      initSpy = vi
        .spyOn(MapApp.prototype, "initialize")
        .mockImplementation(function (this: MapApp) {
          bindOrder.push("initialize");
          this.isInitializing = false;
          return Promise.resolve();
        });
    });

    afterEach(() => {
      btn.remove();
      vi.restoreAllMocks();
      delete window.mapApp;
    });

    it("is exposed on window", () => {
      expect(window.initMapApp).toBe(initMapApp);
    });

    it("creates the app, draws the icons, binds actions and then initializes", async () => {
      const app = await initMapApp(config);

      expect(app).toBeInstanceOf(MapApp);
      expect(window.mapApp).toBe(app);
      expect(bindOrder).toEqual(["bind", "initialize"]);
      expect(initSpy).toHaveBeenCalledTimes(1);
      expect(btn.querySelector("svg.icon")).not.toBeNull();

      app.statsManager = { toggleStats: vi.fn() } as never;
      btn.click();
      expect(
        (
          app.statsManager as unknown as {
            toggleStats: ReturnType<typeof vi.fn>;
          }
        ).toggleStats,
      ).toHaveBeenCalledTimes(1);
    });
  });

  describe("reportInitFailure", () => {
    let mapEl: HTMLElement;

    beforeEach(() => {
      mapEl = document.createElement("div");
      mapEl.id = "map";
      mapEl.innerHTML = "<canvas></canvas>";
      document.body.appendChild(mapEl);
    });

    afterEach(() => {
      mapEl.remove();
    });

    it("logs the error and replaces the map with a message", () => {
      const error = new Error("no data");

      reportInitFailure(error);

      expect(loggerMock.logError).toHaveBeenCalledWith(error);
      expect(mapEl.innerHTML).toBe(INIT_ERROR_HTML);
      expect(mapEl.querySelector(".kh-init-error")!.textContent).toBe(
        "Failed to initialize map. Please reload the page.",
      );
    });

    it("still logs when there is no map element", () => {
      mapEl.remove();

      expect(() => reportInitFailure(new Error("boom"))).not.toThrow();
      expect(loggerMock.logError).toHaveBeenCalled();
    });

    it("is what a failed initialization ends in", async () => {
      const error = new Error("init failed");
      vi.spyOn(MapApp.prototype, "initialize").mockRejectedValue(error);

      await initMapApp(config).catch(reportInitFailure);

      expect(loggerMock.logError).toHaveBeenCalledWith(error);
      expect(mapEl.querySelector(".kh-init-error")).not.toBeNull();
      delete window.mapApp;
    });
  });

  describe("destroy", () => {
    it("cancels the deferred Wrapped reopening", () => {
      vi.useFakeTimers();
      const app = new MapApp(config);
      const showWrapped = vi.fn();
      app.wrappedManager = { showWrapped, destroy: vi.fn() } as never;
      app.replayManager = { destroy: vi.fn() } as never;
      app.mobileBar = null;
      app.savedState = { wrappedVisible: true };

      // The reopening is scheduled at the end of initialize(); reproduce
      // only that step so no manager has to be built
      (
        app as unknown as {
          wrappedRestoreTimer: ReturnType<typeof setTimeout> | null;
        }
      ).wrappedRestoreTimer = setTimeout(() => showWrapped(), 500);

      app.destroy();
      vi.advanceTimersByTime(1000);

      expect(showWrapped).not.toHaveBeenCalled();
      expect(
        (app.replayManager as unknown as { destroy: ReturnType<typeof vi.fn> })
          .destroy,
      ).toHaveBeenCalled();
      vi.useRealTimers();
    });
  });
});
