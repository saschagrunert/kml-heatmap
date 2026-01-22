import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import {
  combineYearData,
  getGlobalVarName,
  getCacheKey,
  DataLoader,
} from "../../../../kml_heatmap/frontend/services/dataLoader";

describe("dataLoader service", () => {
  describe("combineYearData", () => {
    it("combines multiple year datasets", () => {
      const datasets = [
        {
          coordinates: [
            [50.0, 8.0],
            [51.0, 9.0],
          ],
          path_segments: [{ path_id: 1 }],
          path_info: [{ id: 1, year: 2024 }],
          original_points: 1000,
          downsampled_points: 100,
        },
        {
          coordinates: [[52.0, 10.0]],
          path_segments: [{ path_id: 2 }],
          path_info: [{ id: 2, year: 2025 }],
          original_points: 2000,
          downsampled_points: 200,
        },
      ];

      const result = combineYearData(datasets, "z14_plus");

      expect(result.coordinates).toHaveLength(3);
      expect(result.path_segments).toHaveLength(2);
      expect(result.path_info).toHaveLength(2);
      expect(result.original_points).toBe(3000);
      expect(result.downsampled_points).toBe(300);
      expect(result.resolution).toBe("z14_plus");
    });

    it("calculates compression ratio", () => {
      const datasets = [
        {
          coordinates: [],
          path_segments: [],
          path_info: [],
          original_points: 1000,
          downsampled_points: 100,
        },
      ];

      const result = combineYearData(datasets, "z14_plus");
      expect(result.compression_ratio).toBe(10); // 100/1000 * 100
    });

    it("handles zero original points", () => {
      const datasets = [
        {
          coordinates: [],
          path_segments: [],
          path_info: [],
          original_points: 0,
          downsampled_points: 0,
        },
      ];

      const result = combineYearData(datasets, "z14_plus");
      expect(result.compression_ratio).toBe(100);
    });

    it("skips null or undefined datasets", () => {
      const datasets = [
        {
          coordinates: [[50.0, 8.0]],
          path_segments: [],
          path_info: [],
          original_points: 100,
          downsampled_points: 10,
        },
        null,
        undefined,
      ];

      const result = combineYearData(datasets, "z14_plus");
      expect(result.coordinates).toHaveLength(1);
      expect(result.original_points).toBe(100);
    });

    it("handles missing original_points and downsampled_points", () => {
      const datasets = [
        {
          coordinates: [],
          path_segments: [],
          path_info: [],
        },
      ];

      const result = combineYearData(datasets, "z14_plus");
      expect(result.original_points).toBe(0);
      expect(result.downsampled_points).toBe(0);
    });
  });

  describe("getGlobalVarName", () => {
    it("generates correct global variable name", () => {
      expect(getGlobalVarName("2025", "z14_plus")).toBe(
        "KML_DATA_2025_Z14_PLUS"
      );
    });

    it("replaces hyphens with underscores", () => {
      expect(getGlobalVarName("2025", "z0-4")).toBe("KML_DATA_2025_Z0_4");
    });

    it("handles resolution with multiple hyphens", () => {
      expect(getGlobalVarName("2025", "z-11-13")).toBe("KML_DATA_2025_Z_11_13");
    });
  });

  describe("getCacheKey", () => {
    it("generates cache key", () => {
      expect(getCacheKey("z14_plus", "2025")).toBe("z14_plus_2025");
    });

    it('handles "all" year', () => {
      expect(getCacheKey("z14_plus", "all")).toBe("z14_plus_all");
    });
  });

  describe("DataLoader", () => {
    let loader: DataLoader;
    let mockWindow: Window & typeof globalThis;
    let mockScriptLoader: Mock<[string], Promise<void>>;
    let mockShowLoading: Mock<[], void>;
    let mockHideLoading: Mock<[], void>;

    beforeEach(() => {
      mockWindow = {} as Window & typeof globalThis;
      mockScriptLoader = vi
        .fn<[string], Promise<void>>()
        .mockResolvedValue(undefined);
      mockShowLoading = vi.fn<[], void>();
      mockHideLoading = vi.fn<[], void>();

      loader = new DataLoader({
        dataDir: "test-data",
        scriptLoader: mockScriptLoader,
        showLoading: mockShowLoading,
        hideLoading: mockHideLoading,
        getWindow: () => mockWindow,
      });
    });

    describe("loadData", () => {
      it("loads data for a specific year", async () => {
        const mockData = {
          coordinates: [[50.0, 8.0]],
          downsampled_points: 100,
        };

        // Set after scriptLoader is called
        mockScriptLoader.mockImplementationOnce(() => {
          mockWindow.KML_DATA_2025_Z14_PLUS = mockData;
          return Promise.resolve();
        });

        const result = await loader.loadData("z14_plus", "2025");

        expect(mockScriptLoader).toHaveBeenCalledWith(
          "test-data/2025/z14_plus.js"
        );
        expect(result).toBe(mockData);
        expect(mockShowLoading).toHaveBeenCalled();
        expect(mockHideLoading).toHaveBeenCalled();
      });

      it("uses cached data on second call", async () => {
        const mockData = { downsampled_points: 100 };

        // First call loads the script
        mockScriptLoader.mockImplementationOnce(() => {
          mockWindow.KML_DATA_2025_Z14_PLUS = mockData;
          return Promise.resolve();
        });

        await loader.loadData("z14_plus", "2025");
        const result = await loader.loadData("z14_plus", "2025");

        expect(mockScriptLoader).toHaveBeenCalledTimes(1);
        expect(result).toBe(mockData);
      });

      it("skips loading if global variable already exists", async () => {
        const mockData = { downsampled_points: 100 };
        mockWindow.KML_DATA_2025_Z14_PLUS = mockData;

        // Pre-set the global variable
        const result = await loader.loadData("z14_plus", "2025");

        expect(mockScriptLoader).not.toHaveBeenCalled();
        expect(result).toBe(mockData);
      });

      it("returns null on error", async () => {
        mockScriptLoader.mockRejectedValueOnce(new Error("Failed to load"));

        const result = await loader.loadData("z14_plus", "2025");

        expect(result).toBeNull();
        expect(mockHideLoading).toHaveBeenCalled();
      });

      it('defaults to "all" if year not specified', async () => {
        mockWindow.KML_METADATA = {
          available_years: [2025],
        };
        mockWindow.KML_DATA_2025_Z14_PLUS = { downsampled_points: 100 };

        const result = await loader.loadData("z14_plus");

        expect(result).toBeDefined();
      });
    });

    describe("loadAndCombineAllYears", () => {
      it("loads and combines all years", async () => {
        const mockMetadata = {
          available_years: [2024, 2025],
        };
        const mockData2024 = {
          coordinates: [[50.0, 8.0]],
          path_segments: [],
          path_info: [],
          original_points: 1000,
          downsampled_points: 100,
        };
        const mockData2025 = {
          coordinates: [[51.0, 9.0]],
          path_segments: [],
          path_info: [],
          original_points: 2000,
          downsampled_points: 200,
        };

        // Mock loadMetadata call
        mockScriptLoader.mockImplementationOnce(() => {
          mockWindow.KML_METADATA = mockMetadata;
          return Promise.resolve();
        });

        // Mock loading 2024 data
        mockScriptLoader.mockImplementationOnce(() => {
          mockWindow.KML_DATA_2024_Z14_PLUS = mockData2024;
          return Promise.resolve();
        });

        // Mock loading 2025 data
        mockScriptLoader.mockImplementationOnce(() => {
          mockWindow.KML_DATA_2025_Z14_PLUS = mockData2025;
          return Promise.resolve();
        });

        const result = await loader.loadAndCombineAllYears("z14_plus");

        expect(result.coordinates).toHaveLength(2);
        expect(result.original_points).toBe(3000);
        expect(result.downsampled_points).toBe(300);
      });

      it("uses cached combined data", async () => {
        const mockMetadata = { available_years: [2025] };
        const mockData = {
          coordinates: [],
          path_segments: [],
          path_info: [],
          downsampled_points: 100,
        };

        // First call: load metadata
        mockScriptLoader.mockImplementationOnce(() => {
          mockWindow.KML_METADATA = mockMetadata;
          return Promise.resolve();
        });

        // First call: load 2025 data
        mockScriptLoader.mockImplementationOnce(() => {
          mockWindow.KML_DATA_2025_Z14_PLUS = mockData;
          return Promise.resolve();
        });

        await loader.loadAndCombineAllYears("z14_plus");
        const result = await loader.loadAndCombineAllYears("z14_plus");

        expect(result).toBeDefined();
        // Should only call scriptLoader twice (once for metadata, once for data)
        expect(mockScriptLoader).toHaveBeenCalledTimes(2);
      });

      it("returns null if metadata missing", async () => {
        const result = await loader.loadAndCombineAllYears("z14_plus");

        expect(result).toBeNull();
        expect(mockHideLoading).toHaveBeenCalled();
      });

      it("returns null if available_years missing", async () => {
        mockWindow.KML_METADATA = {};

        const result = await loader.loadAndCombineAllYears("z14_plus");

        expect(result).toBeNull();
      });

      it("handles errors gracefully", async () => {
        mockScriptLoader.mockRejectedValueOnce(new Error("Network error"));

        const result = await loader.loadAndCombineAllYears("z14_plus");

        expect(result).toBeNull();
        expect(mockHideLoading).toHaveBeenCalled();
      });
    });

    describe("loadAirports", () => {
      it("loads airports data", async () => {
        const mockAirports = [
          { name: "EDDF", lat: 50.0, lon: 8.0 },
          { name: "EDDM", lat: 48.3, lon: 11.7 },
        ];

        // Set after scriptLoader is called
        mockScriptLoader.mockImplementationOnce(() => {
          mockWindow.KML_AIRPORTS = { airports: mockAirports };
          return Promise.resolve();
        });

        const result = await loader.loadAirports();

        expect(mockScriptLoader).toHaveBeenCalledWith("test-data/airports.js");
        expect(result).toBe(mockAirports);
      });

      it("skips loading if already loaded", async () => {
        const mockAirports = [{ name: "EDDF" }];
        mockWindow.KML_AIRPORTS = { airports: mockAirports };

        const result = await loader.loadAirports();

        expect(mockScriptLoader).not.toHaveBeenCalled();
        expect(result).toBe(mockAirports);
      });

      it("returns empty array on error", async () => {
        mockScriptLoader.mockRejectedValueOnce(new Error("Failed"));

        const result = await loader.loadAirports();

        expect(result).toEqual([]);
      });
    });

    describe("loadMetadata", () => {
      it("loads metadata", async () => {
        const mockMetadata = {
          available_years: [2024, 2025],
          total_flights: 100,
        };

        // Set after scriptLoader is called
        mockScriptLoader.mockImplementationOnce(() => {
          mockWindow.KML_METADATA = mockMetadata;
          return Promise.resolve();
        });

        const result = await loader.loadMetadata();

        expect(mockScriptLoader).toHaveBeenCalledWith("test-data/metadata.js");
        expect(result).toBe(mockMetadata);
      });

      it("skips loading if already loaded", async () => {
        const mockMetadata = { available_years: [2025] };
        mockWindow.KML_METADATA = mockMetadata;

        const result = await loader.loadMetadata();

        expect(mockScriptLoader).not.toHaveBeenCalled();
        expect(result).toBe(mockMetadata);
      });

      it("returns null on error", async () => {
        mockScriptLoader.mockRejectedValueOnce(new Error("Failed"));

        const result = await loader.loadMetadata();

        expect(result).toBeNull();
      });
    });

    describe("cache management", () => {
      it("clearCache removes all cached data", async () => {
        const mockData = { downsampled_points: 100 };
        mockWindow.KML_DATA_2025_Z14_PLUS = mockData;

        await loader.loadData("z14_plus", "2025");
        expect(loader.isCached("z14_plus", "2025")).toBe(true);

        loader.clearCache();
        expect(loader.isCached("z14_plus", "2025")).toBe(false);
      });

      it("isCached returns true for cached data", async () => {
        const mockData = { downsampled_points: 100 };
        mockWindow.KML_DATA_2025_Z14_PLUS = mockData;

        expect(loader.isCached("z14_plus", "2025")).toBe(false);

        await loader.loadData("z14_plus", "2025");

        expect(loader.isCached("z14_plus", "2025")).toBe(true);
      });

      it("isCached returns false for non-cached data", () => {
        expect(loader.isCached("z14_plus", "2025")).toBe(false);
      });
    });

    describe("default options", () => {
      it("uses default dataDir", () => {
        const defaultLoader = new DataLoader();
        expect(defaultLoader.dataDir).toBe("data");
      });

      it("uses default show/hide loading functions", () => {
        const defaultLoader = new DataLoader();
        expect(() => defaultLoader.showLoading()).not.toThrow();
        expect(() => defaultLoader.hideLoading()).not.toThrow();
      });
    });
  });
});
