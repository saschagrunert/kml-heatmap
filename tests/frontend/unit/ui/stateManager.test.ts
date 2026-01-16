import { describe, it, expect, beforeEach, vi } from "vitest";
import { StateManager } from "../../../../kml_heatmap/frontend/ui/stateManager";

describe("StateManager", () => {
  let stateManager: StateManager;
  let mockApp: any;
  let mockLocalStorage: { [key: string]: string };

  beforeEach(() => {
    // Mock localStorage
    mockLocalStorage = {};
    global.localStorage = {
      getItem: vi.fn((key: string) => mockLocalStorage[key] || null),
      setItem: vi.fn((key: string, value: string) => {
        mockLocalStorage[key] = value;
      }),
      removeItem: vi.fn((key: string) => {
        delete mockLocalStorage[key];
      }),
      clear: vi.fn(() => {
        mockLocalStorage = {};
      }),
      length: 0,
      key: vi.fn(),
    } as any;

    // Mock history API
    global.history = {
      replaceState: vi.fn(),
    } as any;

    // Mock window.location
    Object.defineProperty(window, "location", {
      value: {
        pathname: "/",
        search: "",
      },
      writable: true,
    });

    // Mock KMLHeatmap library
    (global.window as any).KMLHeatmap = {
      encodeStateToUrl: vi.fn((state) => {
        return `year=${state.selectedYear}&aircraft=${state.selectedAircraft}`;
      }),
      parseUrlParams: vi.fn((params) => {
        const year = params.get("year");
        const aircraft = params.get("aircraft");
        if (year || aircraft) {
          return {
            selectedYear: year || "all",
            selectedAircraft: aircraft || "all",
          };
        }
        return null;
      }),
    };

    // Create mock app
    mockApp = {
      map: {
        getCenter: vi.fn(() => ({ lat: 50.0, lng: 8.0 })),
        getZoom: vi.fn(() => 10),
      },
      heatmapVisible: true,
      altitudeVisible: false,
      airspeedVisible: false,
      airportsVisible: false,
      aviationVisible: false,
      selectedYear: "all",
      selectedAircraft: "all",
      selectedPathIds: new Set<string>(),
    };

    // Mock stats panel element
    const mockStatsPanel = document.createElement("div");
    mockStatsPanel.id = "stats-panel";
    mockStatsPanel.classList.add("visible");
    document.body.appendChild(mockStatsPanel);

    stateManager = new StateManager(mockApp);
  });

  afterEach(() => {
    // Clean up DOM
    const statsPanel = document.getElementById("stats-panel");
    if (statsPanel) {
      document.body.removeChild(statsPanel);
    }
  });

  describe("saveMapState", () => {
    it("saves current state to localStorage", () => {
      stateManager.saveMapState();

      expect(localStorage.setItem).toHaveBeenCalledWith(
        "kml-heatmap-state",
        expect.any(String)
      );

      const savedData = mockLocalStorage["kml-heatmap-state"];
      const state = JSON.parse(savedData);

      expect(state.center).toEqual({ lat: 50.0, lng: 8.0 });
      expect(state.zoom).toBe(10);
      expect(state.heatmapVisible).toBe(true);
      expect(state.selectedYear).toBe("all");
      expect(state.selectedAircraft).toBe("all");
    });

    it("saves selected path IDs as array", () => {
      mockApp.selectedPathIds.add("path1");
      mockApp.selectedPathIds.add("path2");

      stateManager.saveMapState();

      const savedData = mockLocalStorage["kml-heatmap-state"];
      const state = JSON.parse(savedData);

      expect(state.selectedPathIds).toEqual(
        expect.arrayContaining(["path1", "path2"])
      );
      expect(state.selectedPathIds).toHaveLength(2);
    });

    it("saves stats panel visibility state", () => {
      stateManager.saveMapState();

      const savedData = mockLocalStorage["kml-heatmap-state"];
      const state = JSON.parse(savedData);

      expect(state.statsPanelVisible).toBe(true);
    });

    it("handles missing stats panel element", () => {
      const statsPanel = document.getElementById("stats-panel");
      if (statsPanel) {
        document.body.removeChild(statsPanel);
      }

      stateManager.saveMapState();

      const savedData = mockLocalStorage["kml-heatmap-state"];
      const state = JSON.parse(savedData);

      expect(state.statsPanelVisible).toBe(false);
    });

    it("updates URL with current state", () => {
      stateManager.saveMapState();

      expect((window as any).KMLHeatmap.encodeStateToUrl).toHaveBeenCalled();
      expect(history.replaceState).toHaveBeenCalledWith(
        null,
        "",
        expect.stringContaining("year=")
      );
    });

    it("does nothing if map is not initialized", () => {
      mockApp.map = null;

      stateManager.saveMapState();

      expect(localStorage.setItem).not.toHaveBeenCalled();
    });

    it("handles localStorage errors gracefully", () => {
      vi.spyOn(localStorage, "setItem").mockImplementationOnce(() => {
        throw new Error("localStorage is full");
      });

      expect(() => stateManager.saveMapState()).not.toThrow();
    });
  });

  describe("loadMapState", () => {
    it("loads saved state from localStorage", () => {
      const savedState = {
        center: { lat: 48.0, lng: 11.0 },
        zoom: 12,
        heatmapVisible: false,
        altitudeVisible: true,
        airspeedVisible: false,
        airportsVisible: true,
        aviationVisible: false,
        selectedYear: "2025",
        selectedAircraft: "D-ABCD",
        selectedPathIds: ["path1", "path2"],
        statsPanelVisible: true,
      };

      mockLocalStorage["kml-heatmap-state"] = JSON.stringify(savedState);

      const loaded = stateManager.loadMapState();

      expect(loaded).toEqual(savedState);
    });

    it("returns null if no saved state exists", () => {
      const loaded = stateManager.loadMapState();

      expect(loaded).toBeNull();
    });

    it("returns null if saved state is corrupted", () => {
      mockLocalStorage["kml-heatmap-state"] = "invalid json {";

      const loaded = stateManager.loadMapState();

      expect(loaded).toBeNull();
    });

    it("handles localStorage errors gracefully", () => {
      vi.spyOn(localStorage, "getItem").mockImplementationOnce(() => {
        throw new Error("localStorage not available");
      });

      const loaded = stateManager.loadMapState();

      expect(loaded).toBeNull();
    });
  });

  describe("updateUrl", () => {
    it("updates browser URL with state", () => {
      const state = {
        center: { lat: 50.0, lng: 8.0 },
        zoom: 10,
        heatmapVisible: true,
        altitudeVisible: false,
        airspeedVisible: false,
        airportsVisible: false,
        aviationVisible: false,
        selectedYear: "2025",
        selectedAircraft: "D-ABCD",
        selectedPathIds: [],
        statsPanelVisible: false,
      };

      stateManager.updateUrl(state);

      expect((window as any).KMLHeatmap.encodeStateToUrl).toHaveBeenCalledWith(
        state
      );
      expect(history.replaceState).toHaveBeenCalled();
    });

    it("handles empty URL params", () => {
      (window as any).KMLHeatmap.encodeStateToUrl.mockReturnValueOnce("");

      const state = {
        center: { lat: 50.0, lng: 8.0 },
        zoom: 10,
        heatmapVisible: true,
        altitudeVisible: false,
        airspeedVisible: false,
        airportsVisible: false,
        aviationVisible: false,
        selectedYear: "all",
        selectedAircraft: "all",
        selectedPathIds: [],
        statsPanelVisible: false,
      };

      stateManager.updateUrl(state);

      expect(history.replaceState).toHaveBeenCalledWith(null, "", "/");
    });

    it("handles history API errors gracefully", () => {
      vi.spyOn(history, "replaceState").mockImplementationOnce(() => {
        throw new Error("history not available");
      });

      const state = {
        center: { lat: 50.0, lng: 8.0 },
        zoom: 10,
        heatmapVisible: true,
        altitudeVisible: false,
        airspeedVisible: false,
        airportsVisible: false,
        aviationVisible: false,
        selectedYear: "all",
        selectedAircraft: "all",
        selectedPathIds: [],
        statsPanelVisible: false,
      };

      expect(() => stateManager.updateUrl(state)).not.toThrow();
    });
  });

  describe("loadState", () => {
    it("prioritizes URL parameters over localStorage", () => {
      // Set up localStorage with one state
      const localStorageState = {
        center: { lat: 48.0, lng: 11.0 },
        zoom: 12,
        heatmapVisible: false,
        altitudeVisible: true,
        airspeedVisible: false,
        airportsVisible: true,
        aviationVisible: false,
        selectedYear: "2024",
        selectedAircraft: "D-EFGH",
        selectedPathIds: [],
        statsPanelVisible: false,
      };
      mockLocalStorage["kml-heatmap-state"] = JSON.stringify(localStorageState);

      // Set up URL with different state
      Object.defineProperty(window, "location", {
        value: {
          pathname: "/",
          search: "?year=2025&aircraft=D-ABCD",
        },
        writable: true,
      });

      const loaded = stateManager.loadState();

      expect(loaded).toEqual({
        selectedYear: "2025",
        selectedAircraft: "D-ABCD",
      });
    });

    it("falls back to localStorage if no URL params", () => {
      const localStorageState = {
        center: { lat: 48.0, lng: 11.0 },
        zoom: 12,
        heatmapVisible: false,
        altitudeVisible: true,
        airspeedVisible: false,
        airportsVisible: true,
        aviationVisible: false,
        selectedYear: "2024",
        selectedAircraft: "D-EFGH",
        selectedPathIds: [],
        statsPanelVisible: false,
      };
      mockLocalStorage["kml-heatmap-state"] = JSON.stringify(localStorageState);

      Object.defineProperty(window, "location", {
        value: {
          pathname: "/",
          search: "",
        },
        writable: true,
      });

      const loaded = stateManager.loadState();

      expect(loaded).toEqual(localStorageState);
    });

    it("returns null if no state available", () => {
      Object.defineProperty(window, "location", {
        value: {
          pathname: "/",
          search: "",
        },
        writable: true,
      });

      const loaded = stateManager.loadState();

      expect(loaded).toBeNull();
    });
  });
});
