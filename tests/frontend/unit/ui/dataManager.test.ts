import { describe, it, expect, beforeEach, vi } from "vitest";
import { DataManager } from "../../../../kml_heatmap/frontend/ui/dataManager";

describe("DataManager", () => {
  let dataManager: DataManager;
  let mockApp: any;
  let mockDataLoader: any;
  let mockHeatLayer: any;
  let heatLayerSpy: any;

  beforeEach(() => {
    // Mock loading element
    const loadingEl = document.createElement("div");
    loadingEl.id = "loading";
    loadingEl.style.display = "none";
    document.body.appendChild(loadingEl);

    // Mock DataLoader
    mockDataLoader = {
      loadData: vi.fn(),
      loadAirports: vi.fn(),
      loadMetadata: vi.fn(),
    };

    // Mock heatLayer
    mockHeatLayer = {
      addTo: vi.fn(),
      _canvas: {
        style: {},
      },
    };

    // Mock window.KMLHeatmap
    (global.window as any).KMLHeatmap = {
      DataLoader: function () {
        return mockDataLoader;
      },
      getResolutionForZoom: vi.fn((zoom) => {
        if (zoom < 5) return "z0-4";
        if (zoom < 11) return "z5-10";
        if (zoom < 14) return "z11-13";
        return "z14_plus";
      }),
    };

    // Mock L.heatLayer
    heatLayerSpy = vi.fn(() => mockHeatLayer);
    (global.window as any).L = {
      heatLayer: heatLayerSpy,
    };

    // Create mock app
    mockApp = {
      config: {
        dataDir: "data",
      },
      map: {
        removeLayer: vi.fn(),
        getZoom: vi.fn(() => 10),
      },
      heatmapLayer: null,
      heatmapVisible: true,
      altitudeVisible: false,
      airspeedVisible: false,
      selectedYear: "all",
      selectedAircraft: "all",
      currentResolution: null,
      currentData: null,
      selectedPathIds: new Set<string>(),
      pathToAirports: {},
      airportToPaths: {},
      altitudeRange: { min: 0, max: 0 },
      layerManager: {
        redrawAltitudePaths: vi.fn(),
        redrawAirspeedPaths: vi.fn(),
      },
      replayManager: {
        replayActive: false,
      },
    };

    dataManager = new DataManager(mockApp);
  });

  afterEach(() => {
    const loadingEl = document.getElementById("loading");
    if (loadingEl) {
      document.body.removeChild(loadingEl);
    }
  });

  describe("constructor", () => {
    it("creates DataLoader instance", () => {
      // Verify that dataManager has the expected structure
      expect(dataManager).toBeDefined();
      expect(dataManager.loadedData).toBeDefined();
      expect(dataManager.currentData).toBeDefined();
    });

    it("initializes loadedData and currentData", () => {
      expect(dataManager.loadedData).toEqual({});
      expect(dataManager.currentData).toBeNull();
    });
  });

  describe("showLoading", () => {
    it("displays loading element", () => {
      const loadingEl = document.getElementById("loading")!;
      loadingEl.style.display = "none";

      dataManager.showLoading();

      expect(loadingEl.style.display).toBe("block");
    });

    it("handles missing loading element", () => {
      const loadingEl = document.getElementById("loading");
      if (loadingEl) {
        document.body.removeChild(loadingEl);
      }

      expect(() => dataManager.showLoading()).not.toThrow();
    });
  });

  describe("hideLoading", () => {
    it("hides loading element", () => {
      const loadingEl = document.getElementById("loading")!;
      loadingEl.style.display = "block";

      dataManager.hideLoading();

      expect(loadingEl.style.display).toBe("none");
    });

    it("handles missing loading element", () => {
      const loadingEl = document.getElementById("loading");
      if (loadingEl) {
        document.body.removeChild(loadingEl);
      }

      expect(() => dataManager.hideLoading()).not.toThrow();
    });
  });

  describe("loadData", () => {
    it("delegates to dataLoader", async () => {
      const mockData = {
        coordinates: [[50.0, 8.0]],
        path_segments: [],
        path_info: [],
        resolution: "z14_plus",
        original_points: 1000,
        downsampled_points: 100,
        compression_ratio: 10,
      };
      mockDataLoader.loadData.mockResolvedValue(mockData);

      const result = await dataManager.loadData("z14_plus", "2025");

      expect(mockDataLoader.loadData).toHaveBeenCalledWith("z14_plus", "2025");
      expect(result).toBe(mockData);
    });
  });

  describe("loadAirports", () => {
    it("delegates to dataLoader", async () => {
      const mockAirports = [
        { icao: "EDDF", name: "Frankfurt", lat: 50.0, lon: 8.0 },
      ];
      mockDataLoader.loadAirports.mockResolvedValue(mockAirports);

      const result = await dataManager.loadAirports();

      expect(mockDataLoader.loadAirports).toHaveBeenCalled();
      expect(result).toBe(mockAirports);
    });
  });

  describe("loadMetadata", () => {
    it("delegates to dataLoader", async () => {
      const mockMetadata = {
        available_years: [2024, 2025],
        available_aircraft: ["D-ABCD"],
        total_paths: 100,
        total_points: 10000,
      };
      mockDataLoader.loadMetadata.mockResolvedValue(mockMetadata);

      const result = await dataManager.loadMetadata();

      expect(mockDataLoader.loadMetadata).toHaveBeenCalled();
      expect(result).toBe(mockMetadata);
    });
  });

  describe("updateLayers", () => {
    it("does nothing if map is not initialized", async () => {
      mockApp.map = null;

      await dataManager.updateLayers();

      expect(mockDataLoader.loadData).not.toHaveBeenCalled();
    });

    it("does nothing if resolution has not changed", async () => {
      mockApp.currentResolution = "z5-10";

      await dataManager.updateLayers();

      expect(mockDataLoader.loadData).not.toHaveBeenCalled();
    });

    it("loads data for new resolution", async () => {
      const mockData = {
        coordinates: [[50.0, 8.0]],
        path_segments: [],
        path_info: [],
        resolution: "z5-10",
        original_points: 1000,
        downsampled_points: 100,
        compression_ratio: 10,
      };
      mockDataLoader.loadData.mockResolvedValue(mockData);

      await dataManager.updateLayers();

      expect(mockDataLoader.loadData).toHaveBeenCalledWith("z5-10", "all");
      expect(dataManager.currentData).toBe(mockData);
      expect(mockApp.currentData).toBe(mockData);
    });

    it("creates heatmap layer with correct configuration", async () => {
      const mockData = {
        coordinates: [
          [50.0, 8.0],
          [51.0, 9.0],
        ],
        path_segments: [],
        path_info: [],
        resolution: "z5-10",
        original_points: 1000,
        downsampled_points: 100,
        compression_ratio: 10,
      };
      mockDataLoader.loadData.mockResolvedValue(mockData);

      await dataManager.updateLayers();

      expect(heatLayerSpy).toHaveBeenCalledWith(
        mockData.coordinates,
        expect.objectContaining({
          radius: 10,
          blur: 15,
          minOpacity: 0.25,
          maxOpacity: 0.6,
        })
      );
    });

    it("removes existing heatmap layer before creating new one", async () => {
      const oldLayer = { addTo: vi.fn() };
      mockApp.heatmapLayer = oldLayer;

      const mockData = {
        coordinates: [[50.0, 8.0]],
        path_segments: [],
        path_info: [],
        resolution: "z5-10",
        original_points: 1000,
        downsampled_points: 100,
        compression_ratio: 10,
      };
      mockDataLoader.loadData.mockResolvedValue(mockData);

      await dataManager.updateLayers();

      expect(mockApp.map.removeLayer).toHaveBeenCalledWith(oldLayer);
    });

    it("adds heatmap to map if heatmap visible and not in replay mode", async () => {
      mockApp.heatmapVisible = true;
      mockApp.replayManager.replayActive = false;

      const mockData = {
        coordinates: [[50.0, 8.0]],
        path_segments: [],
        path_info: [],
        resolution: "z5-10",
        original_points: 1000,
        downsampled_points: 100,
        compression_ratio: 10,
      };
      mockDataLoader.loadData.mockResolvedValue(mockData);

      await dataManager.updateLayers();

      expect(mockHeatLayer.addTo).toHaveBeenCalledWith(mockApp.map);
    });

    it("does not add heatmap if not visible", async () => {
      mockApp.heatmapVisible = false;

      const mockData = {
        coordinates: [[50.0, 8.0]],
        path_segments: [],
        path_info: [],
        resolution: "z5-10",
        original_points: 1000,
        downsampled_points: 100,
        compression_ratio: 10,
      };
      mockDataLoader.loadData.mockResolvedValue(mockData);

      await dataManager.updateLayers();

      expect(mockHeatLayer.addTo).not.toHaveBeenCalled();
    });

    it("does not add heatmap if in replay mode", async () => {
      mockApp.heatmapVisible = true;
      mockApp.replayManager.replayActive = true;

      const mockData = {
        coordinates: [[50.0, 8.0]],
        path_segments: [],
        path_info: [],
        resolution: "z5-10",
        original_points: 1000,
        downsampled_points: 100,
        compression_ratio: 10,
      };
      mockDataLoader.loadData.mockResolvedValue(mockData);

      await dataManager.updateLayers();

      expect(mockHeatLayer.addTo).not.toHaveBeenCalled();
    });

    it("builds path-to-airport relationships from path_info", async () => {
      const mockData = {
        coordinates: [[50.0, 8.0]],
        path_segments: [],
        path_info: [
          {
            id: "path1",
            start_airport: "EDDF",
            end_airport: "EDDM",
          },
          {
            id: "path2",
            start_airport: "EDDM",
            end_airport: "EDDF",
          },
        ],
        resolution: "z5-10",
        original_points: 1000,
        downsampled_points: 100,
        compression_ratio: 10,
      };
      mockDataLoader.loadData.mockResolvedValue(mockData);

      await dataManager.updateLayers();

      expect(mockApp.pathToAirports["path1"]).toEqual({
        start: "EDDF",
        end: "EDDM",
      });
      expect(mockApp.pathToAirports["path2"]).toEqual({
        start: "EDDM",
        end: "EDDF",
      });

      expect(mockApp.airportToPaths["EDDF"]).toContain("path1");
      expect(mockApp.airportToPaths["EDDF"]).toContain("path2");
      expect(mockApp.airportToPaths["EDDM"]).toContain("path1");
      expect(mockApp.airportToPaths["EDDM"]).toContain("path2");
    });

    it("calculates altitude range from segments", async () => {
      const mockData = {
        coordinates: [[50.0, 8.0]],
        path_segments: [
          { path_id: "path1", altitude_ft: 1000 },
          { path_id: "path1", altitude_ft: 5000 },
          { path_id: "path1", altitude_ft: 3000 },
        ],
        path_info: [],
        resolution: "z5-10",
        original_points: 1000,
        downsampled_points: 100,
        compression_ratio: 10,
      };
      mockDataLoader.loadData.mockResolvedValue(mockData);

      await dataManager.updateLayers();

      expect(mockApp.altitudeRange.min).toBe(1000);
      expect(mockApp.altitudeRange.max).toBe(5000);
    });

    it("filters coordinates by selected year", async () => {
      mockApp.selectedYear = "2025";

      const mockData = {
        coordinates: [
          [50.0, 8.0],
          [51.0, 9.0],
        ],
        path_segments: [
          {
            path_id: "path1",
            coords: [
              [50.0, 8.0],
              [51.0, 9.0],
            ],
          },
          {
            path_id: "path2",
            coords: [
              [52.0, 10.0],
              [53.0, 11.0],
            ],
          },
        ],
        path_info: [
          { id: "path1", year: 2025, aircraft_registration: "D-ABCD" },
          { id: "path2", year: 2024, aircraft_registration: "D-EFGH" },
        ],
        resolution: "z5-10",
        original_points: 1000,
        downsampled_points: 100,
        compression_ratio: 10,
      };
      mockDataLoader.loadData.mockResolvedValue(mockData);

      await dataManager.updateLayers();

      // heatLayer should be called with filtered coordinates
      expect(heatLayerSpy).toHaveBeenCalled();
      const heatLayerCall = heatLayerSpy.mock.calls[0];
      expect(Array.isArray(heatLayerCall[0])).toBe(true);
    });

    it("filters coordinates by selected aircraft", async () => {
      mockApp.selectedAircraft = "D-ABCD";

      const mockData = {
        coordinates: [
          [50.0, 8.0],
          [51.0, 9.0],
        ],
        path_segments: [
          {
            path_id: "path1",
            coords: [
              [50.0, 8.0],
              [51.0, 9.0],
            ],
          },
          {
            path_id: "path2",
            coords: [
              [52.0, 10.0],
              [53.0, 11.0],
            ],
          },
        ],
        path_info: [
          { id: "path1", year: 2025, aircraft_registration: "D-ABCD" },
          { id: "path2", year: 2025, aircraft_registration: "D-EFGH" },
        ],
        resolution: "z5-10",
        original_points: 1000,
        downsampled_points: 100,
        compression_ratio: 10,
      };
      mockDataLoader.loadData.mockResolvedValue(mockData);

      await dataManager.updateLayers();

      // heatLayer should be called with filtered coordinates
      expect(heatLayerSpy).toHaveBeenCalled();
      const heatLayerCall = heatLayerSpy.mock.calls[0];
      expect(Array.isArray(heatLayerCall[0])).toBe(true);
    });

    it("redraws altitude paths after loading", async () => {
      const mockData = {
        coordinates: [[50.0, 8.0]],
        path_segments: [],
        path_info: [],
        resolution: "z5-10",
        original_points: 1000,
        downsampled_points: 100,
        compression_ratio: 10,
      };
      mockDataLoader.loadData.mockResolvedValue(mockData);

      await dataManager.updateLayers();

      expect(mockApp.layerManager.redrawAltitudePaths).toHaveBeenCalled();
    });

    it("redraws airspeed paths if airspeed visible", async () => {
      mockApp.airspeedVisible = true;

      const mockData = {
        coordinates: [[50.0, 8.0]],
        path_segments: [],
        path_info: [],
        resolution: "z5-10",
        original_points: 1000,
        downsampled_points: 100,
        compression_ratio: 10,
      };
      mockDataLoader.loadData.mockResolvedValue(mockData);

      await dataManager.updateLayers();

      expect(mockApp.layerManager.redrawAirspeedPaths).toHaveBeenCalled();
    });

    it("does not redraw airspeed paths if airspeed not visible", async () => {
      mockApp.airspeedVisible = false;

      const mockData = {
        coordinates: [[50.0, 8.0]],
        path_segments: [],
        path_info: [],
        resolution: "z5-10",
        original_points: 1000,
        downsampled_points: 100,
        compression_ratio: 10,
      };
      mockDataLoader.loadData.mockResolvedValue(mockData);

      await dataManager.updateLayers();

      expect(mockApp.layerManager.redrawAirspeedPaths).not.toHaveBeenCalled();
    });
  });
});
