import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  StateManager,
  sanitizeSavedState,
  storageKey,
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
        schemaVersion: 3,
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

  it("drops path ids saved with an older id scheme", () => {
    // Version 2 ids were positions in the export, not content hashes
    expect(
      sanitizeSavedState({ schemaVersion: 2, selectedPathIds: [1, 2] }),
    ).toEqual({});
    expect(sanitizeSavedState({ selectedPathIds: [1, 2] })).toEqual({});
  });

  it("rejects non-finite numbers", () => {
    expect(
      sanitizeSavedState({ zoom: Infinity, center: { lat: NaN, lng: 8 } }),
    ).toEqual({});
  });
});

describe("storageKey", () => {
  it("keys the state by the directory of the page", () => {
    expect(storageKey("/a/")).toBe("kml-heatmap-state:/a/");
    // The page itself and its folder are the same map
    expect(storageKey("/a/index.html")).toBe("kml-heatmap-state:/a/");
    expect(storageKey("/b/")).not.toBe(storageKey("/a/"));
  });

  it("keeps the original key for a map at the root of its origin", () => {
    expect(storageKey("/")).toBe("kml-heatmap-state");
    expect(storageKey("/index.html")).toBe("kml-heatmap-state");
  });
});

describe("StateManager", () => {
  let stateManager: StateManager;
  let mockApp: MockApp;
  let mockLocalStorage: { [key: string]: string };

  // Redefining window.location makes the property non-configurable for the
  // rest of the worker, which rules out sharing one jsdom between files. The
  // real history API moves the location instead; the tests below stub
  // history.replaceState to observe what the manager writes, so the original
  // is captured here before that happens.
  const navigate = window.history.replaceState.bind(window.history);
  function setLocation(search: string, pathname = "/"): void {
    navigate(null, "", pathname + search);
  }

  /** Storage key of the map the tests run at, the root of the origin */
  const KEY = "kml-heatmap-state";

  beforeEach(() => {
    mockLocalStorage = {};
    vi.stubGlobal("localStorage", {
      getItem: vi.fn((key: string) => mockLocalStorage[key] || null),
      setItem: vi.fn((key: string, value: string) => {
        mockLocalStorage[key] = value;
      }),
      removeItem: vi.fn((key: string) => {
        delete mockLocalStorage[key];
      }),
      clear: vi.fn(),
      length: 0,
      key: vi.fn(),
    });
    vi.stubGlobal("history", { replaceState: vi.fn() });
    setLocation("");

    mockApp = createMockApp();
    mockApp.map!.getCenter.mockReturnValue({ lat: 50.0, lng: 8.0 });
    mockApp.map!.getZoom.mockReturnValue(10);

    stateManager = new StateManager(asMapApp(mockApp));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    setLocation("");
  });

  function savedState(): Record<string, unknown> {
    return JSON.parse(mockLocalStorage[KEY]!) as Record<string, unknown>;
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

  describe("flush", () => {
    it("saves at once and drops the pending debounced save", () => {
      vi.useFakeTimers();
      stateManager.scheduleSave();
      expect(mockLocalStorage[KEY]).toBeUndefined();

      stateManager.flush();

      expect(mockLocalStorage[KEY]).toBeDefined();
      const saveSpy = vi.spyOn(stateManager, "saveMapState");
      vi.advanceTimersByTime(1000);
      expect(saveSpy).not.toHaveBeenCalled();
    });

    it("saves even when nothing was scheduled", () => {
      stateManager.flush();

      expect(mockLocalStorage[KEY]).toBeDefined();
    });

    it("saves a change still waiting for the debounce when the page goes away", () => {
      vi.useFakeTimers();
      mockApp.selectedYear = "2025";
      expect(mockLocalStorage[KEY]).toBeUndefined();

      window.dispatchEvent(new Event("pagehide"));

      expect(JSON.parse(mockLocalStorage[KEY]!)).toMatchObject({
        selectedYear: "2025",
      });
    });

    it("does not save on pagehide when nothing is pending", () => {
      const saveSpy = vi.spyOn(stateManager, "saveMapState");

      window.dispatchEvent(new Event("pagehide"));

      expect(saveSpy).not.toHaveBeenCalled();
    });
  });

  describe("teardown", () => {
    it("stops listening for pagehide once the app is gone", () => {
      const lifetime = new AbortController();
      const app = createMockApp({ signal: lifetime.signal });
      const manager = new StateManager(asMapApp(app));
      manager.scheduleSave();
      const flush = vi.spyOn(manager, "flush");

      lifetime.abort();
      window.dispatchEvent(new Event("pagehide"));

      expect(flush).not.toHaveBeenCalled();
      manager.cancelSave();
    });

    it("drops a pending save on cancelSave", () => {
      vi.useFakeTimers();
      const saveSpy = vi.spyOn(stateManager, "saveMapState");
      mockApp.selectedYear = "2025";

      stateManager.cancelSave();
      vi.advanceTimersByTime(1000);

      expect(saveSpy).not.toHaveBeenCalled();
    });
  });

  describe("panels a restored state reopens later", () => {
    beforeEach(() => {
      // Statistics and Wrapped open in the link: v flags 6 and 7
      setLocation("?y=2024&v=100101100&lat=50&lng=8&z=10");
      mockApp.savedState = stateManager.loadState();
    });

    it("saves them as open while the app has not reopened them yet", () => {
      // The restore batch schedules a save long before the data is in
      mockApp.selectedYear = "2024";

      stateManager.flush();

      expect(savedState()).toMatchObject({
        statsPanelVisible: true,
        wrappedVisible: true,
      });
    });

    it("hands over to the store once the panel has been reopened", () => {
      mockApp.store.set("statsPanelVisible", true);
      // The user closes it again right away
      mockApp.store.set("statsPanelVisible", false);

      stateManager.flush();

      expect(savedState()["statsPanelVisible"]).toBe(false);
      expect(savedState()["wrappedVisible"]).toBe(true);
    });

    it("hands over to the store once the app gave up reopening one", () => {
      delete mockApp.savedState!.wrappedVisible;

      stateManager.flush();

      expect(savedState()["wrappedVisible"]).toBe(false);
    });

    it("writes the store without a restored state", () => {
      mockApp.savedState = null;

      stateManager.flush();

      expect(savedState()).toMatchObject({
        statsPanelVisible: false,
        wrappedVisible: false,
      });
    });
  });

  describe("saveMapState", () => {
    it("wraps a centre panned past the antimeridian into the link", () => {
      // Leaflet reports the unwrapped longitude after a pan across 180
      mockApp.map!.getCenter.mockReturnValue({ lat: -17, lng: 190 });

      stateManager.saveMapState();

      expect(savedState()["center"]).toEqual({ lat: -17, lng: -170 });
      const url = String(vi.mocked(history.replaceState).mock.calls[0]![2]);
      expect(url).toContain("lng=-170.000000");
    });

    it("saves the user's own view while Wrapped has the map fitted", () => {
      // With the fitted overview saved, a reload or a shared link landed on
      // the overview once the dialog was closed
      mockApp.wrappedManager.userMapView.mockReturnValue({
        center: { lat: 48.1, lng: 11.6 },
        zoom: 13,
      });

      stateManager.saveMapState();

      expect(savedState()).toMatchObject({
        center: { lat: 48.1, lng: 11.6 },
        zoom: 13,
      });
      expect(mockApp.map!.getCenter).not.toHaveBeenCalled();
    });

    it("saves current state to localStorage and the URL", () => {
      mockApp.selectedYear = "2025";
      mockApp.selectedPathIds.add(1);
      mockApp.selectedPathIds.add(2);

      stateManager.saveMapState();

      expect(savedState()).toEqual({
        schemaVersion: 4,
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
        isolateSelection: false,
      });
      expect(history.replaceState).toHaveBeenCalledWith(
        null,
        "",
        "?y=2025&p=1%2C2&sv=4&lat=50.000000&lng=8.000000&z=10.00",
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

    it("saves Wrapped as closed before the Wrapped manager published it", () => {
      expect(mockApp.store.get("wrappedVisible")).toBe(false);

      stateManager.saveMapState();

      expect(savedState()["wrappedVisible"]).toBe(false);
    });

    it("saves under the key of the page's directory", () => {
      setLocation("", "/b/index.html");

      stateManager.saveMapState();

      expect(Object.keys(mockLocalStorage)).toEqual(["kml-heatmap-state:/b/"]);
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
      mockLocalStorage[KEY] = JSON.stringify({
        schemaVersion: 3,
        ...state,
      });

      expect(stateManager.loadMapState()).toEqual(state);
    });

    it("drops unknown or invalid fields", () => {
      mockLocalStorage[KEY] = JSON.stringify({
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
      mockLocalStorage[KEY] = "{not json";
      expect(stateManager.loadMapState()).toBeNull();
    });

    it("returns null if saved state lacks a map view", () => {
      mockLocalStorage[KEY] = JSON.stringify({
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
      mockLocalStorage[KEY] = JSON.stringify({
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
      mockLocalStorage[KEY] = JSON.stringify({
        schemaVersion: 3,
        ...state,
      });

      expect(stateManager.loadState()).toEqual(state);
    });

    it("returns null if no state is available", () => {
      expect(stateManager.loadState()).toBeNull();
    });

    it("does not restore the state of another map on the same origin (regression)", () => {
      mockLocalStorage["kml-heatmap-state:/a/"] = JSON.stringify({
        schemaVersion: 3,
        center: { lat: 48.0, lng: 11.0 },
        zoom: 12,
        selectedYear: "2024",
        selectedPathIds: [3],
      });
      setLocation("", "/b/");

      expect(stateManager.loadState()).toBeNull();

      setLocation("", "/a/index.html");
      expect(stateManager.loadState()).toMatchObject({ selectedYear: "2024" });
    });

    it("adopts the state saved under the key of earlier releases once", () => {
      mockLocalStorage[KEY] = JSON.stringify({
        schemaVersion: 3,
        center: { lat: 48.0, lng: 11.0 },
        zoom: 12,
        selectedYear: "2024",
      });
      setLocation("", "/kml-heatmap/");

      expect(stateManager.loadState()).toMatchObject({ selectedYear: "2024" });
      expect(Object.keys(mockLocalStorage)).toEqual([
        "kml-heatmap-state:/kml-heatmap/",
      ]);

      // A second map on the origin finds nothing left to adopt
      setLocation("", "/other/");
      expect(stateManager.loadState()).toBeNull();
    });

    it("parses the full URL state including visibility flags", () => {
      setLocation("?y=2025&p=1,2&sv=3&v=011010111&lat=50.5&lng=8.5&z=12.25");

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
        // The legacy control-visibility flag is parsed and then dropped
        isolateSelection: true,
        center: { lat: 50.5, lng: 8.5 },
        zoom: 12.25,
      });
    });

    it("falls back to localStorage when URL params contain no state", () => {
      setLocation("?debug=true");
      mockLocalStorage[KEY] = JSON.stringify({
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
