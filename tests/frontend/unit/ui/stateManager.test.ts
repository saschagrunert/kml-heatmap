import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  StateManager,
  sanitizeSavedState,
} from "../../../../kml_heatmap/frontend/ui/stateManager";
import { createMockApp, asMapApp, type MockApp } from "../../testHelpers";

describe("sanitizeSavedState", () => {
  it("returns an empty object for non-objects", () => {
    expect(sanitizeSavedState(null)).toEqual({});
    expect(sanitizeSavedState("x")).toEqual({});
    expect(sanitizeSavedState(42)).toEqual({});
  });

  it("keeps only known, well-typed fields", () => {
    expect(
      sanitizeSavedState({
        selectedYear: "2025",
        selectedAircraft: 5,
        zoom: "12",
        center: { lat: 50, lng: 8 },
        heatmapVisible: "yes",
        altitudeVisible: true,
        wrappedVisible: false,
        schemaVersion: 2,
        selectedPathIds: [1, "2", NaN, 3],
        unknown: true,
      }),
    ).toEqual({
      selectedYear: "2025",
      center: { lat: 50, lng: 8 },
      altitudeVisible: true,
      wrappedVisible: false,
      selectedPathIds: [1, 3],
    });
  });

  it("rejects non-finite numbers", () => {
    expect(
      sanitizeSavedState({ zoom: Infinity, center: { lat: NaN, lng: 8 } }),
    ).toEqual({});
  });
});

describe("StateManager", () => {
  let stateManager: StateManager;
  let mockApp: MockApp;
  let mockLocalStorage: { [key: string]: string };

  function setLocation(search: string): void {
    Object.defineProperty(window, "location", {
      value: { pathname: "/", search },
      writable: true,
    });
  }

  beforeEach(() => {
    mockLocalStorage = {};
    vi.stubGlobal("localStorage", {
      getItem: vi.fn((key: string) => mockLocalStorage[key] || null),
      setItem: vi.fn((key: string, value: string) => {
        mockLocalStorage[key] = value;
      }),
      removeItem: vi.fn(),
      clear: vi.fn(),
      length: 0,
      key: vi.fn(),
    });
    vi.stubGlobal("history", { replaceState: vi.fn() });
    setLocation("");

    mockApp = createMockApp();
    mockApp.map!.getCenter.mockReturnValue({ lat: 50.0, lng: 8.0 });
    mockApp.map!.getZoom.mockReturnValue(10);

    const wrappedModal = document.createElement("div");
    wrappedModal.id = "wrapped-modal";
    wrappedModal.style.display = "none";
    document.body.appendChild(wrappedModal);

    stateManager = new StateManager(asMapApp(mockApp));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    document.getElementById("wrapped-modal")?.remove();
  });

  function savedState(): Record<string, unknown> {
    return JSON.parse(mockLocalStorage["kml-heatmap-state"]!) as Record<
      string,
      unknown
    >;
  }

  describe("store subscriptions", () => {
    it("subscribes to all persisted store keys on construction", () => {
      const subscribe = vi.fn(() => () => {});
      const app = createMockApp();
      vi.spyOn(app.store, "subscribe").mockImplementation(subscribe);

      new StateManager(asMapApp(app));

      const keys = subscribe.mock.calls.map((c) => (c as unknown[])[0]);
      expect(keys).toEqual([
        "selectedYear",
        "selectedAircraft",
        "selectedPathIds",
        "isolateSelection",
        "heatmapVisible",
        "altitudeVisible",
        "airspeedVisible",
        "airportsVisible",
        "aviationVisible",
        "buttonsHidden",
        "statsPanelVisible",
        "wrappedVisible",
      ]);
    });

    it("auto-saves (debounced) when a subscribed key changes", () => {
      vi.useFakeTimers();
      const saveSpy = vi.spyOn(stateManager, "saveMapState");

      mockApp.selectedYear = "2025";

      expect(saveSpy).not.toHaveBeenCalled();
      vi.advanceTimersByTime(300);
      expect(saveSpy).toHaveBeenCalledTimes(1);
    });

    it("coalesces multiple key changes into one save", () => {
      vi.useFakeTimers();
      const saveSpy = vi.spyOn(stateManager, "saveMapState");

      mockApp.selectedYear = "2025";
      mockApp.heatmapVisible = false;
      mockApp.store.set("wrappedVisible", true);
      vi.advanceTimersByTime(300);

      expect(saveSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("saveMapState", () => {
    it("saves current state to localStorage and the URL", () => {
      mockApp.selectedYear = "2025";
      mockApp.selectedPathIds.add(1);
      mockApp.selectedPathIds.add(2);

      stateManager.saveMapState();

      expect(savedState()).toEqual({
        schemaVersion: 2,
        center: { lat: 50, lng: 8 },
        zoom: 10,
        heatmapVisible: true,
        altitudeVisible: false,
        airspeedVisible: false,
        airportsVisible: true,
        aviationVisible: false,
        selectedYear: "2025",
        selectedAircraft: "all",
        selectedPathIds: [1, 2],
        statsPanelVisible: false,
        wrappedVisible: false,
        buttonsHidden: false,
        isolateSelection: false,
      });
      expect(history.replaceState).toHaveBeenCalledWith(
        null,
        "",
        "?y=2025&p=1%2C2&sv=2&lat=50.000000&lng=8.000000&z=10.00",
      );
    });

    it("reads stats panel visibility from the store", () => {
      mockApp.store.set("statsPanelVisible", true);

      stateManager.saveMapState();

      expect(savedState()["statsPanelVisible"]).toBe(true);
    });

    it("reads wrapped visibility from the store when set", () => {
      mockApp.store.set("wrappedVisible", true);

      stateManager.saveMapState();

      expect(savedState()["wrappedVisible"]).toBe(true);
    });

    it("falls back to the DOM for wrapped visibility when the store key is undefined", () => {
      document.getElementById("wrapped-modal")!.style.display = "flex";

      stateManager.saveMapState();

      expect(savedState()["wrappedVisible"]).toBe(true);
    });

    it("treats a missing wrapped modal as hidden", () => {
      document.getElementById("wrapped-modal")?.remove();

      stateManager.saveMapState();

      expect(savedState()["wrappedVisible"]).toBe(false);
    });

    it("does nothing if map is not initialized", () => {
      mockApp.map = null;

      stateManager.saveMapState();

      expect(localStorage.setItem).not.toHaveBeenCalled();
      expect(history.replaceState).not.toHaveBeenCalled();
    });

    it("handles localStorage errors gracefully", () => {
      vi.spyOn(localStorage, "setItem").mockImplementationOnce(() => {
        throw new Error("localStorage is full");
      });

      expect(() => stateManager.saveMapState()).not.toThrow();
      expect(history.replaceState).toHaveBeenCalled();
    });
  });

  describe("loadMapState", () => {
    it("loads saved state from localStorage", () => {
      const state = {
        center: { lat: 48.0, lng: 11.0 },
        zoom: 12,
        heatmapVisible: false,
        selectedYear: "2024",
        selectedPathIds: [1, 2],
      };
      // schemaVersion is a storage detail and is not returned
      mockLocalStorage["kml-heatmap-state"] = JSON.stringify({
        schemaVersion: 2,
        ...state,
      });

      expect(stateManager.loadMapState()).toEqual(state);
    });

    it("drops unknown or invalid fields", () => {
      mockLocalStorage["kml-heatmap-state"] = JSON.stringify({
        center: { lat: 48.0, lng: 11.0 },
        zoom: 12,
        heatmapVisible: "true",
        evil: "<script>",
      });

      expect(stateManager.loadMapState()).toEqual({
        center: { lat: 48.0, lng: 11.0 },
        zoom: 12,
      });
    });

    it("returns null if no saved state exists", () => {
      expect(stateManager.loadMapState()).toBeNull();
    });

    it("returns null if saved state is corrupted", () => {
      mockLocalStorage["kml-heatmap-state"] = "{not json";
      expect(stateManager.loadMapState()).toBeNull();
    });

    it("returns null if saved state lacks a map view", () => {
      mockLocalStorage["kml-heatmap-state"] = JSON.stringify({
        selectedYear: "2024",
      });
      expect(stateManager.loadMapState()).toBeNull();
    });

    it("handles localStorage errors gracefully", () => {
      vi.spyOn(localStorage, "getItem").mockImplementationOnce(() => {
        throw new Error("denied");
      });
      expect(stateManager.loadMapState()).toBeNull();
    });
  });

  describe("updateUrl", () => {
    it("updates browser URL with encoded state", () => {
      stateManager.updateUrl({ selectedYear: "2025", zoom: 9 });

      expect(history.replaceState).toHaveBeenCalledWith(
        null,
        "",
        "?y=2025&z=9.00",
      );
    });

    it("falls back to the pathname when no params are produced", () => {
      stateManager.updateUrl({});

      expect(history.replaceState).toHaveBeenCalledWith(null, "", "/");
    });

    it("handles history API errors gracefully", () => {
      vi.mocked(history.replaceState).mockImplementationOnce(() => {
        throw new Error("nope");
      });

      expect(() =>
        stateManager.updateUrl({ selectedYear: "2025" }),
      ).not.toThrow();
    });
  });

  describe("loadState", () => {
    it("prioritizes URL parameters over localStorage", () => {
      mockLocalStorage["kml-heatmap-state"] = JSON.stringify({
        center: { lat: 48.0, lng: 11.0 },
        zoom: 12,
        selectedYear: "2024",
      });
      setLocation("?y=2025&a=D-ABCD");

      expect(stateManager.loadState()).toEqual({
        selectedYear: "2025",
        selectedAircraft: "D-ABCD",
      });
    });

    it("falls back to localStorage if no URL params", () => {
      const state = {
        center: { lat: 48.0, lng: 11.0 },
        zoom: 12,
        selectedYear: "2024",
        selectedAircraft: "D-EFGH",
        selectedPathIds: [],
        statsPanelVisible: false,
      };
      mockLocalStorage["kml-heatmap-state"] = JSON.stringify({
        schemaVersion: 2,
        ...state,
      });

      expect(stateManager.loadState()).toEqual(state);
    });

    it("returns null if no state is available", () => {
      expect(stateManager.loadState()).toBeNull();
    });

    it("parses the full URL state including visibility flags", () => {
      setLocation("?y=2025&p=1,2&sv=2&v=011010111&lat=50.5&lng=8.5&z=12.25");

      expect(stateManager.loadState()).toEqual({
        selectedYear: "2025",
        selectedPathIds: [1, 2],
        heatmapVisible: false,
        altitudeVisible: true,
        airspeedVisible: true,
        airportsVisible: false,
        aviationVisible: true,
        statsPanelVisible: false,
        wrappedVisible: true,
        buttonsHidden: true,
        isolateSelection: true,
        center: { lat: 50.5, lng: 8.5 },
        zoom: 12.25,
      });
    });

    it("falls back to localStorage when URL params contain no state", () => {
      setLocation("?debug=true");
      mockLocalStorage["kml-heatmap-state"] = JSON.stringify({
        center: { lat: 1, lng: 2 },
        zoom: 3,
      });

      expect(stateManager.loadState()).toEqual({
        center: { lat: 1, lng: 2 },
        zoom: 3,
      });
    });
  });
});
