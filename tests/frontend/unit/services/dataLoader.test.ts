import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import {
  combineYearData,
  expandYearData,
  getGlobalVarName,
  isValidYear,
  loadScript,
  DataLoader,
} from "../../../../kml_heatmap/frontend/services/dataLoader";
import type {
  KMLDataset,
  LoadingInfo,
  RawSegment,
  RawYearData,
} from "../../../../kml_heatmap/frontend/types";

// Mock logger
vi.mock("../../../../kml_heatmap/frontend/utils/logger", () => ({
  logDebug: vi.fn(),
  logError: vi.fn(),
}));

type MockWindow = Window & typeof globalThis & Record<string, unknown>;

/** One path's exported segments: a start point and its end-point rows */
function path(
  start: [number, number],
  rows: RawSegment[],
): RawYearData["segments"][string] {
  return { start, rows };
}

function rawYear(
  year: number,
  segments: RawYearData["segments"],
  pathInfo: RawYearData["path_info"] = [],
  originalPoints = 0,
): RawYearData {
  return {
    year,
    original_points: originalPoints,
    path_info: pathInfo,
    segments,
  };
}

function dataset(
  segmentsCount: number,
  pathIdStart = 1,
  originalPoints = segmentsCount,
): KMLDataset {
  const path_segments = Array.from({ length: segmentsCount }, (_, i) => ({
    path_id: pathIdStart + i,
    coords: [
      [50, 8],
      [50.1, 8.1],
    ] as [[number, number], [number, number]],
    altitude_ft: 1000,
    groundspeed_knots: 100,
  }));
  return {
    coordinates: path_segments.map((s) => s.coords[0]),
    path_segments,
    path_info: path_segments.map((s) => ({ id: s.path_id })),
    original_points: originalPoints,
  };
}

describe("loadScript", () => {
  it("appends script to document.head and resolves on load", async () => {
    const appendChildSpy = vi
      .spyOn(document.head, "appendChild")
      .mockImplementation((node: Node) => {
        (node as HTMLScriptElement).onload?.(new Event("load"));
        return node;
      });

    await loadScript("test.js");

    expect(appendChildSpy).toHaveBeenCalled();
    const script = appendChildSpy.mock.calls[0]![0] as HTMLScriptElement;
    expect(script.src).toContain("test.js");
    expect(script.tagName).toBe("SCRIPT");

    appendChildSpy.mockRestore();
  });

  it("rejects on script load error", async () => {
    const appendChildSpy = vi
      .spyOn(document.head, "appendChild")
      .mockImplementation((node: Node) => {
        (node as HTMLScriptElement).onerror?.(new Event("error"));
        return node;
      });

    await expect(loadScript("bad.js")).rejects.toThrow(
      "Failed to load script: bad.js",
    );

    appendChildSpy.mockRestore();
  });
});

describe("isValidYear", () => {
  it("accepts 'all' and 4-digit years in range", () => {
    expect(isValidYear("all")).toBe(true);
    expect(isValidYear("2000")).toBe(true);
    expect(isValidYear("2099")).toBe(true);
  });

  it("accepts any four-digit year", () => {
    expect(isValidYear("1999")).toBe(true);
    expect(isValidYear("2100")).toBe(true);
  });

  it("rejects anything that is not four digits", () => {
    expect(isValidYear("abc")).toBe(false);
    expect(isValidYear("../etc")).toBe(false);
    expect(isValidYear("20255")).toBe(false);
    expect(isValidYear("2025/..")).toBe(false);
  });
});

describe("getGlobalVarName", () => {
  it("generates the KML_DATA_<YEAR> variable name", () => {
    expect(getGlobalVarName("2025")).toBe("KML_DATA_2025");
  });
});

describe("expandYearData", () => {
  it("expands segment rows into path segments and heatmap coordinates", () => {
    const raw = rawYear(
      2025,
      {
        "4": path(
          [50, 8],
          [
            [50.1, 8.1, 1000, 90, 0],
            [50.2, 8.2, 1100, 95, 10],
          ],
        ),
        "7": path([51, 9], [[51.1, 9.1, 500, 80]]),
      },
      [
        { id: 4, year: 2025 },
        { id: 7, year: 2025 },
      ],
      42,
    );

    const data = expandYearData(raw);

    expect(data.original_points).toBe(42);
    expect(data.path_info).toBe(raw.path_info);
    expect(data.path_segments).toEqual([
      {
        path_id: 4,
        coords: [
          [50, 8],
          [50.1, 8.1],
        ],
        altitude_ft: 1000,
        groundspeed_knots: 90,
        time: 0,
      },
      {
        path_id: 4,
        coords: [
          [50.1, 8.1],
          [50.2, 8.2],
        ],
        altitude_ft: 1100,
        groundspeed_knots: 95,
        time: 10,
      },
      {
        path_id: 7,
        coords: [
          [51, 9],
          [51.1, 9.1],
        ],
        altitude_ft: 500,
        groundspeed_knots: 80,
      },
    ]);
    // start of every segment + end of the last segment per path
    expect(data.coordinates).toEqual([
      [50, 8],
      [50.1, 8.1],
      [50.2, 8.2],
      [51, 9],
      [51.1, 9.1],
    ]);
  });

  it("omits time when the row has four entries", () => {
    const data = expandYearData(
      rawYear(2025, { "1": path([50, 8], [[50.1, 8.1, 1000, 90]]) }),
    );
    expect("time" in data.path_segments[0]!).toBe(false);
  });

  it("orders paths by numeric path id", () => {
    const data = expandYearData(
      rawYear(2025, {
        "10": path([50, 8], [[50.1, 8.1, 1, 1]]),
        "2": path([50, 8], [[50.1, 8.1, 1, 1]]),
      }),
    );
    expect(data.path_segments.map((s) => s.path_id)).toEqual([2, 10]);
  });

  it("skips paths without segments and has no holes in the arrays", () => {
    const data = expandYearData(
      rawYear(2025, {
        "1": path([50, 8], []),
        "2": path([50, 8], [[50.1, 8.1, 1, 1]]),
      }),
    );
    expect(data.path_segments).toHaveLength(1);
    expect(data.coordinates).toHaveLength(2);
    expect(data.coordinates.every((c) => Array.isArray(c))).toBe(true);
  });

  it("shares the start coordinate array between segment and heatmap point", () => {
    const data = expandYearData(
      rawYear(2025, { "1": path([50, 8], [[50.1, 8.1, 1, 1]]) }),
    );
    expect(data.coordinates[0]).toBe(data.path_segments[0]!.coords![0]);
  });

  it("shares one coordinate array between neighbouring segments", () => {
    const data = expandYearData(
      rawYear(2025, {
        "1": path(
          [50, 8],
          [
            [50.1, 8.1, 1, 1],
            [50.2, 8.2, 1, 1],
          ],
        ),
      }),
    );
    // The end of a segment is the very same array as the next one's start
    expect(data.path_segments[0]!.coords![1]).toBe(
      data.path_segments[1]!.coords![0],
    );
  });

  it("throws when a path with rows carries no start point", () => {
    expect(() =>
      expandYearData(
        rawYear(2025, {
          "1": { start: [], rows: [[50.1, 8.1, 1, 1]] },
        }),
      ),
    ).toThrow("start point");
  });

  it("defaults missing path_info and original_points", () => {
    const data = expandYearData({ year: 2025, segments: {} } as RawYearData);
    expect(data.path_info).toEqual([]);
    expect(data.original_points).toBe(0);
    expect(data.path_segments).toEqual([]);
  });

  it("throws for invalid input (e.g. legacy file format)", () => {
    expect(() => expandYearData(null as unknown as RawYearData)).toThrow();
    expect(() =>
      expandYearData({ path_segments: [] } as unknown as RawYearData),
    ).toThrow("segments");
  });
});

describe("combineYearData", () => {
  it("concatenates datasets without remapping or copying objects", () => {
    const a = dataset(2, 1, 100);
    const b = dataset(1, 3, 200);

    const result = combineYearData([a, b]);

    expect(result.coordinates).toHaveLength(3);
    expect(result.path_segments).toHaveLength(3);
    expect(result.path_info).toHaveLength(3);
    expect(result.original_points).toBe(300);
    expect(result.path_segments.map((s) => s.path_id)).toEqual([1, 2, 3]);
    // Same object references (no copies)
    expect(result.path_segments[0]).toBe(a.path_segments[0]);
    expect(result.path_segments[2]).toBe(b.path_segments[0]);
    expect(result.path_info[2]).toBe(b.path_info[0]);
    expect(result.coordinates[0]).toBe(a.coordinates[0]);
  });

  it("skips null or undefined datasets", () => {
    const result = combineYearData([dataset(1), null, undefined]);
    expect(result.coordinates).toHaveLength(1);
    expect(result.original_points).toBe(1);
  });

  it("returns an empty dataset for no input", () => {
    expect(combineYearData([])).toEqual({
      coordinates: [],
      path_segments: [],
      path_info: [],
      original_points: 0,
    });
  });
});

describe("DataLoader", () => {
  let loader: DataLoader;
  let mockWindow: MockWindow;
  let mockScriptLoader: Mock<(url: string) => Promise<void>>;
  let mockShowLoading: Mock<(info: LoadingInfo) => void>;
  let mockHideLoading: Mock<() => void>;
  let onLoadError: Mock<(years: string[]) => void>;

  function defineYear(
    year: number,
    segments: RawYearData["segments"] = {
      "1": path([50, 8], [[50.1, 8.1, 1000, 100, 0]]),
    },
  ): void {
    mockWindow[`KML_DATA_${year}`] = rawYear(
      year,
      segments,
      [{ id: 1, year }],
      1,
    );
  }

  beforeEach(() => {
    mockWindow = {} as MockWindow;
    mockScriptLoader = vi.fn<(url: string) => Promise<void>>();
    mockScriptLoader.mockResolvedValue(undefined);
    mockShowLoading = vi.fn();
    mockHideLoading = vi.fn();
    onLoadError = vi.fn();

    loader = new DataLoader({
      dataDir: "test-data",
      scriptLoader: mockScriptLoader,
      showLoading: mockShowLoading,
      hideLoading: mockHideLoading,
      getWindow: () => mockWindow,
      onLoadError,
    });
  });

  describe("input validation", () => {
    it("rejects invalid years without loading", async () => {
      expect(await loader.loadData("abc")).toBeNull();
      expect(await loader.loadData("../data")).toBeNull();
      expect(await loader.loadData("20255")).toBeNull();
      expect(mockScriptLoader).not.toHaveBeenCalled();
      expect(onLoadError).not.toHaveBeenCalled();
    });
  });

  describe("loadData", () => {
    it("loads and expands data for a specific year", async () => {
      mockScriptLoader.mockImplementationOnce(() => {
        defineYear(2025);
        return Promise.resolve();
      });

      const result = await loader.loadData("2025");

      expect(mockScriptLoader).toHaveBeenCalledWith("test-data/2025/data.js");
      expect(result).not.toBeNull();
      expect(result!.path_segments).toHaveLength(1);
      expect(result!.path_segments[0]!.path_id).toBe(1);
      expect(result!.coordinates).toHaveLength(2);
      expect(mockShowLoading).toHaveBeenCalledTimes(1);
      expect(mockHideLoading).toHaveBeenCalledTimes(1);
    });

    it("reports year and file size to the loading indicator", async () => {
      mockWindow.KML_METADATA = {
        available_years: [2024, 2025],
        year_file_bytes: { "2024": 100, "2025": 2048 },
      } as never;
      defineYear(2025);

      await loader.loadData("2025");

      expect(mockShowLoading).toHaveBeenCalledWith({
        year: "2025",
        bytes: 2048,
      });
    });

    it("reports the year without size when metadata is unavailable", async () => {
      defineYear(2025);

      await loader.loadData("2025");

      expect(mockShowLoading).toHaveBeenCalledWith({
        year: "2025",
        bytes: undefined,
      });
    });

    it("drops the raw global after reading it", async () => {
      defineYear(2025);

      await loader.loadData("2025");

      expect(mockWindow["KML_DATA_2025"]).toBeUndefined();
    });

    it("uses cached data on second call", async () => {
      mockScriptLoader.mockImplementationOnce(() => {
        defineYear(2025);
        return Promise.resolve();
      });

      const first = await loader.loadData("2025");
      const second = await loader.loadData("2025");

      expect(mockScriptLoader).toHaveBeenCalledTimes(1);
      expect(second).toBe(first);
    });

    it("skips script loading if the global already exists", async () => {
      defineYear(2025);

      const result = await loader.loadData("2025");

      expect(mockScriptLoader).not.toHaveBeenCalled();
      expect(result).not.toBeNull();
    });

    it("dedupes concurrent loads of the same year", async () => {
      let resolveScript: () => void = () => {};
      mockScriptLoader.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveScript = () => {
              defineYear(2025);
              resolve();
            };
          }),
      );

      const p1 = loader.loadData("2025");
      const p2 = loader.loadData("2025");
      resolveScript();
      const [r1, r2] = await Promise.all([p1, p2]);

      expect(mockScriptLoader).toHaveBeenCalledTimes(1);
      expect(r1).toBe(r2);
    });

    it("returns null and reports the year on script error", async () => {
      mockScriptLoader.mockRejectedValueOnce(new Error("Failed to load"));

      const result = await loader.loadData("2025");

      expect(result).toBeNull();
      expect(onLoadError).toHaveBeenCalledWith(["2025"]);
      expect(mockHideLoading).toHaveBeenCalled();
    });

    it("returns null when the global is missing after loading", async () => {
      const result = await loader.loadData("2025");
      expect(result).toBeNull();
      expect(onLoadError).toHaveBeenCalledWith(["2025"]);
    });

    it('defaults to "all" if year not specified', async () => {
      mockWindow.KML_METADATA = { available_years: [2025] } as never;
      defineYear(2025);

      const result = await loader.loadData();

      expect(result).not.toBeNull();
      expect(result!.path_segments).toHaveLength(1);
    });

    it("does not cache failed loads", async () => {
      mockScriptLoader.mockRejectedValueOnce(new Error("boom"));
      expect(await loader.loadData("2025")).toBeNull();
      expect(loader.isCached("2025")).toBe(false);

      mockScriptLoader.mockImplementationOnce(() => {
        defineYear(2025);
        return Promise.resolve();
      });
      expect(await loader.loadData("2025")).not.toBeNull();
    });
  });

  describe("loadAndCombineAllYears", () => {
    it("loads and combines all years in parallel", async () => {
      mockWindow.KML_METADATA = { available_years: [2024, 2025] } as never;
      mockScriptLoader.mockImplementation((url: string) => {
        if (url.includes("2024")) defineYear(2024);
        if (url.includes("2025")) defineYear(2025);
        return Promise.resolve();
      });

      const result = await loader.loadAndCombineAllYears();

      expect(result).not.toBeNull();
      expect(result!.path_segments).toHaveLength(2);
      expect(result!.original_points).toBe(2);
      expect(mockScriptLoader).toHaveBeenCalledTimes(2);
      expect(onLoadError).not.toHaveBeenCalled();
    });

    it("loads metadata first when not present", async () => {
      mockScriptLoader.mockImplementation((url: string) => {
        if (url.endsWith("metadata.js")) {
          mockWindow.KML_METADATA = { available_years: [2025] } as never;
        }
        if (url.includes("2025")) defineYear(2025);
        return Promise.resolve();
      });

      const result = await loader.loadAndCombineAllYears();

      expect(result).not.toBeNull();
      expect(mockScriptLoader).toHaveBeenCalledWith("test-data/metadata.js");
    });

    it("reports the total size of all year files", async () => {
      mockWindow.KML_METADATA = {
        available_years: [2024, 2025],
        year_file_bytes: { "2024": 100, "2025": 2048 },
      } as never;
      mockScriptLoader.mockImplementation((url: string) => {
        defineYear(url.includes("2024") ? 2024 : 2025);
        return Promise.resolve();
      });

      await loader.loadAndCombineAllYears();

      expect(mockShowLoading).toHaveBeenCalledTimes(1);
      expect(mockShowLoading).toHaveBeenCalledWith({
        year: "all",
        bytes: 2148,
      });
    });

    it("keeps the loading indicator visible until all years are loaded", async () => {
      mockWindow.KML_METADATA = { available_years: [2024, 2025] } as never;
      const resolvers: (() => void)[] = [];
      mockScriptLoader.mockImplementation(
        (url: string) =>
          new Promise<void>((resolve) => {
            resolvers.push(() => {
              defineYear(url.includes("2024") ? 2024 : 2025);
              resolve();
            });
          }),
      );

      const promise = loader.loadAndCombineAllYears();
      await Promise.resolve();
      expect(resolvers).toHaveLength(2);

      resolvers[0]!();
      await Promise.resolve();
      await Promise.resolve();
      expect(mockHideLoading).not.toHaveBeenCalled();

      resolvers[1]!();
      await promise;

      expect(mockShowLoading).toHaveBeenCalledTimes(1);
      expect(mockHideLoading).toHaveBeenCalledTimes(1);
    });

    it("uses cached combined data", async () => {
      mockWindow.KML_METADATA = { available_years: [2025] } as never;
      mockScriptLoader.mockImplementationOnce(() => {
        defineYear(2025);
        return Promise.resolve();
      });

      const first = await loader.loadAndCombineAllYears();
      const second = await loader.loadAndCombineAllYears();

      expect(second).toBe(first);
      expect(mockScriptLoader).toHaveBeenCalledTimes(1);
    });

    it("dedupes concurrent 'all' loads", async () => {
      mockWindow.KML_METADATA = { available_years: [2025] } as never;
      mockScriptLoader.mockImplementation(() => {
        defineYear(2025);
        return Promise.resolve();
      });

      const [a, b] = await Promise.all([
        loader.loadData("all"),
        loader.loadData("all"),
      ]);

      expect(a).toBe(b);
      expect(mockScriptLoader).toHaveBeenCalledTimes(1);
    });

    it("returns null if metadata is missing", async () => {
      const result = await loader.loadAndCombineAllYears();

      expect(result).toBeNull();
      expect(mockHideLoading).toHaveBeenCalled();
    });

    it("returns null if available_years is missing", async () => {
      mockWindow.KML_METADATA = {} as never;

      const result = await loader.loadAndCombineAllYears();

      expect(result).toBeNull();
    });

    it("returns partial data and reports the failed years", async () => {
      mockWindow.KML_METADATA = { available_years: [2024, 2025] } as never;
      mockScriptLoader.mockImplementation((url: string) => {
        if (url.includes("2024")) return Promise.reject(new Error("404"));
        defineYear(2025);
        return Promise.resolve();
      });

      const result = await loader.loadAndCombineAllYears();

      expect(result).not.toBeNull();
      expect(result!.path_segments).toHaveLength(1);
      expect(onLoadError).toHaveBeenCalledTimes(1);
      expect(onLoadError).toHaveBeenCalledWith(["2024"]);
    });

    it("returns null and lists every year when all fail", async () => {
      mockWindow.KML_METADATA = { available_years: [2024, 2025] } as never;
      mockScriptLoader.mockRejectedValue(new Error("Network error"));

      const result = await loader.loadAndCombineAllYears();

      expect(result).toBeNull();
      expect(onLoadError).toHaveBeenCalledWith(["2024", "2025"]);
      expect(loader.isCached("all")).toBe(false);
      expect(mockHideLoading).toHaveBeenCalled();
    });
  });

  describe("loadAirports", () => {
    it("loads airports data", async () => {
      const mockAirports = [
        { name: "EDDF", lat: 50.0, lon: 8.0 },
        { name: "EDDM", lat: 48.3, lon: 11.7 },
      ];

      mockScriptLoader.mockImplementationOnce(() => {
        mockWindow.KML_AIRPORTS = { airports: mockAirports };
        return Promise.resolve();
      });

      const result = await loader.loadAirports();

      expect(mockScriptLoader).toHaveBeenCalledWith("test-data/airports.js");
      expect(result).toBe(mockAirports);
    });

    it("skips loading if already loaded", async () => {
      const mockAirports = [{ name: "EDDF", lat: 50, lon: 8 }];
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
      const mockMetadata = { available_years: [2024, 2025] };

      mockScriptLoader.mockImplementationOnce(() => {
        mockWindow.KML_METADATA = mockMetadata as never;
        return Promise.resolve();
      });

      const result = await loader.loadMetadata();

      expect(mockScriptLoader).toHaveBeenCalledWith("test-data/metadata.js");
      expect(result).toBe(mockMetadata);
    });

    it("skips loading if already loaded", async () => {
      const mockMetadata = { available_years: [2025] };
      mockWindow.KML_METADATA = mockMetadata as never;

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
      defineYear(2025);

      await loader.loadData("2025");
      expect(loader.isCached("2025")).toBe(true);

      loader.clearCache();
      expect(loader.isCached("2025")).toBe(false);
    });

    it("isCached reflects loaded years only", async () => {
      defineYear(2025);
      expect(loader.isCached("2025")).toBe(false);

      await loader.loadData("2025");

      expect(loader.isCached("2025")).toBe(true);
      expect(loader.isCached("2024")).toBe(false);
    });
  });

  describe("default options", () => {
    it("reads globals from window by default", async () => {
      const defaultLoader = new DataLoader();
      expect(defaultLoader.isCached("2025")).toBe(false);
      window["KML_DATA_2025"] = rawYear(2025, {
        "1": path([50, 8], [[50.1, 8.1, 1000, 100]]),
      });

      const result = await defaultLoader.loadData("2025");

      expect(result!.path_segments).toHaveLength(1);
      expect(window["KML_DATA_2025"]).toBeUndefined();
    });
  });
});
