import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type Mock,
} from "vitest";
import * as L from "leaflet";
import { DataManager } from "../../../../kml_heatmap/frontend/ui/dataManager";
import type { HeatmapLayer } from "../../../../kml_heatmap/frontend/globals";
import type {
  DataLoaderOptions,
  KMLDataset,
} from "../../../../kml_heatmap/frontend/types";
import {
  createMockApp,
  createDataset,
  createSegment,
  asMapApp,
  type MockApp,
} from "../../testHelpers";

const loaderMocks = vi.hoisted(() => ({
  loadData: vi.fn(),
  loadAirports: vi.fn(),
  loadMetadata: vi.fn(),
  options: null as DataLoaderOptions | null,
}));

vi.mock("../../../../kml_heatmap/frontend/services/dataLoader", () => ({
  DataLoader: vi.fn(function (options: DataLoaderOptions) {
    loaderMocks.options = options;
    return {
      loadData: loaderMocks.loadData,
      loadAirports: loaderMocks.loadAirports,
      loadMetadata: loaderMocks.loadMetadata,
    };
  }),
}));

const toastMock = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock("../../../../kml_heatmap/frontend/utils/toast", () => toastMock);

describe("DataManager", () => {
  let dataManager: DataManager;
  let mockApp: MockApp;
  let mockHeatLayer: Partial<HeatmapLayer>;
  let heatLayerSpy: Mock;

  const baseData = (): KMLDataset =>
    createDataset(
      [
        { id: 1, year: 2025, aircraft_registration: "D-ABCD" },
        { id: 2, year: 2024, aircraft_registration: "D-EFGH" },
      ],
      [
        createSegment({ path_id: 1, altitude_ft: 1000 }),
        createSegment({
          path_id: 1,
          altitude_ft: 5000,
          coords: [
            [50.1, 8.1],
            [50.2, 8.2],
          ],
        }),
        createSegment({
          path_id: 2,
          altitude_ft: 3000,
          coords: [
            [52.0, 10.0],
            [53.0, 11.0],
          ],
        }),
      ],
      1000,
    );

  beforeEach(() => {
    vi.clearAllMocks();
    const loadingEl = document.createElement("div");
    loadingEl.id = "loading";
    loadingEl.style.display = "none";
    document.body.appendChild(loadingEl);

    mockHeatLayer = {
      addTo: vi.fn(),
      remove: vi.fn(),
      _canvas: { style: {} } as HTMLCanvasElement,
    };
    // DataManager imports leaflet, which vitest aliases to the mock module
    heatLayerSpy = vi.mocked(L.heatLayer);
    heatLayerSpy.mockReturnValue(mockHeatLayer);

    mockApp = createMockApp();
    dataManager = new DataManager(asMapApp(mockApp));
  });

  afterEach(() => {
    document.getElementById("loading")?.remove();
  });

  describe("constructor", () => {
    it("creates the DataLoader with the app data dir and callbacks", () => {
      expect(loaderMocks.options?.dataDir).toBe("data");
      expect(typeof loaderMocks.options?.showLoading).toBe("function");
      expect(typeof loaderMocks.options?.hideLoading).toBe("function");
      expect(typeof loaderMocks.options?.onLoadError).toBe("function");
    });

    it("wires show/hide loading callbacks to the loading element", () => {
      const loadingEl = document.getElementById("loading")!;
      loaderMocks.options!.showLoading!({ year: "2025" });
      expect(loadingEl.style.display).toBe("block");
      loaderMocks.options!.hideLoading!();
      expect(loadingEl.style.display).toBe("none");
    });

    it("shows an error toast listing failed years", () => {
      loaderMocks.options!.onLoadError!(["2024", "2025"]);
      expect(toastMock.showToast).toHaveBeenCalledWith(
        "Failed to load flight data for 2024, 2025",
        "error",
      );
    });
  });

  describe("showLoading/hideLoading", () => {
    it("toggles the loading element", () => {
      const loadingEl = document.getElementById("loading")!;
      dataManager.showLoading();
      expect(loadingEl.style.display).toBe("block");
      dataManager.hideLoading();
      expect(loadingEl.style.display).toBe("none");
    });

    it("describes what is loading when #loading-text exists", () => {
      const loadingEl = document.getElementById("loading")!;
      const textEl = document.createElement("span");
      textEl.id = "loading-text";
      textEl.textContent = "Loading data…";
      loadingEl.appendChild(textEl);

      dataManager.showLoading({ year: "2026", bytes: 1.1 * 1024 * 1024 });
      expect(textEl.textContent).toBe("Loading 2026 flights (1.1 MB)…");

      dataManager.showLoading({ year: "all", bytes: 24 * 1024 * 1024 });
      expect(textEl.textContent).toBe("Loading all flights (24 MB)…");

      dataManager.showLoading({ year: "2025" });
      expect(textEl.textContent).toBe("Loading 2025 flights…");

      dataManager.showLoading();
      expect(textEl.textContent).toBe("Loading 2025 flights…");
      expect(loadingEl.style.display).toBe("block");
    });

    it("works without #loading-text", () => {
      const loadingEl = document.getElementById("loading")!;
      expect(() =>
        dataManager.showLoading({ year: "2026", bytes: 10 }),
      ).not.toThrow();
      expect(loadingEl.style.display).toBe("block");
    });

    it("handles a missing loading element", () => {
      document.getElementById("loading")?.remove();
      expect(() => dataManager.showLoading()).not.toThrow();
      expect(() => dataManager.hideLoading()).not.toThrow();
    });
  });

  describe("delegation", () => {
    it("loadData delegates to the loader", async () => {
      const data = baseData();
      loaderMocks.loadData.mockResolvedValue(data);
      expect(await dataManager.loadData("2025")).toBe(data);
      expect(loaderMocks.loadData).toHaveBeenCalledWith("2025");
    });

    it("loadAirports delegates to the loader", async () => {
      const airports = [{ name: "EDDF", lat: 50, lon: 8 }];
      loaderMocks.loadAirports.mockResolvedValue(airports);
      expect(await dataManager.loadAirports()).toBe(airports);
    });

    it("loadMetadata delegates to the loader", async () => {
      const metadata = { available_years: [2025] };
      loaderMocks.loadMetadata.mockResolvedValue(metadata);
      expect(await dataManager.loadMetadata()).toBe(metadata);
    });
  });

  describe("updateLayers", () => {
    it("does nothing if map is not initialized", async () => {
      mockApp.map = null;

      await dataManager.updateLayers();

      expect(loaderMocks.loadData).not.toHaveBeenCalled();
    });

    it("loads data for the selected year and stores it", async () => {
      const data = baseData();
      mockApp.selectedYear = "2025";
      loaderMocks.loadData.mockResolvedValue(data);

      await dataManager.updateLayers();

      expect(loaderMocks.loadData).toHaveBeenCalledWith("2025");
      expect(mockApp.currentData).toBe(data);
    });

    it("toasts and returns when the dataset is null", async () => {
      mockApp.selectedYear = "2025";
      loaderMocks.loadData.mockResolvedValue(null);

      await dataManager.updateLayers();

      expect(toastMock.showToast).toHaveBeenCalledWith(
        "No flight data available for 2025",
        "error",
      );
      expect(heatLayerSpy).not.toHaveBeenCalled();
      expect(mockApp.currentData).toBeNull();
    });

    it("mentions all years in the null toast for 'all'", async () => {
      loaderMocks.loadData.mockResolvedValue(null);

      await dataManager.updateLayers();

      expect(toastMock.showToast).toHaveBeenCalledWith(
        "No flight data available for all years",
        "error",
      );
    });

    it("does not double-toast when the loader already reported the failure", async () => {
      loaderMocks.loadData.mockImplementation(() => {
        loaderMocks.options!.onLoadError!(["2025"]);
        return Promise.resolve(null);
      });

      await dataManager.updateLayers();

      expect(toastMock.showToast).toHaveBeenCalledTimes(1);
      expect(toastMock.showToast).toHaveBeenCalledWith(
        "Failed to load flight data for 2025",
        "error",
      );
    });

    it("creates the heatmap with all coordinates when unfiltered", async () => {
      const data = baseData();
      loaderMocks.loadData.mockResolvedValue(data);

      await dataManager.updateLayers();

      expect(heatLayerSpy).toHaveBeenCalledWith(
        data.coordinates,
        expect.objectContaining({
          radius: 10,
          blur: 15,
          minOpacity: 0.25,
          maxOpacity: 0.6,
        }),
      );
      expect(mockHeatLayer._canvas!.style.pointerEvents).toBe("none");
    });

    it("removes the existing heatmap layer before creating a new one", async () => {
      const oldLayer = { addTo: vi.fn(), remove: vi.fn() };
      mockApp.heatmapLayer = oldLayer as unknown as HeatmapLayer;
      loaderMocks.loadData.mockResolvedValue(baseData());

      await dataManager.updateLayers();

      expect(oldLayer.remove).toHaveBeenCalled();
      expect(mockApp.heatmapLayer).toBe(mockHeatLayer);
    });

    it("adds heatmap to map if visible and not in replay mode", async () => {
      mockApp.heatmapVisible = true;
      loaderMocks.loadData.mockResolvedValue(baseData());

      await dataManager.updateLayers();

      expect(mockHeatLayer.addTo).toHaveBeenCalledWith(mockApp.map);
    });

    it("does not add heatmap if not visible", async () => {
      mockApp.heatmapVisible = false;
      loaderMocks.loadData.mockResolvedValue(baseData());

      await dataManager.updateLayers();

      expect(mockHeatLayer.addTo).not.toHaveBeenCalled();
    });

    it("does not add heatmap if in replay mode", async () => {
      mockApp.replayManager.state.active = true;
      loaderMocks.loadData.mockResolvedValue(baseData());

      await dataManager.updateLayers();

      expect(mockHeatLayer.addTo).not.toHaveBeenCalled();
    });

    it("builds airport-to-paths relationships from path_info", async () => {
      loaderMocks.loadData.mockResolvedValue(
        createDataset([
          { id: 1, start_airport: "EDDF", end_airport: "EDDM" },
          { id: 2, start_airport: "EDDM", end_airport: "EDDF" },
        ]),
      );

      await dataManager.updateLayers();

      expect([...mockApp.airportToPaths["EDDF"]!]).toEqual([1, 2]);
      expect([...mockApp.airportToPaths["EDDM"]!]).toEqual([1, 2]);
    });

    it("calculates altitude range from segments", async () => {
      loaderMocks.loadData.mockResolvedValue(baseData());

      await dataManager.updateLayers();

      expect(mockApp.altitudeRange).toEqual({ min: 1000, max: 5000 });
    });

    it("keeps the previous altitude range when there are no segments", async () => {
      mockApp.altitudeRange = { min: 5, max: 6 };
      loaderMocks.loadData.mockResolvedValue(createDataset());

      await dataManager.updateLayers();

      expect(mockApp.altitudeRange).toEqual({ min: 5, max: 6 });
    });

    it("filters heatmap coordinates by selected year", async () => {
      mockApp.selectedYear = "2025";
      loaderMocks.loadData.mockResolvedValue(baseData());

      await dataManager.updateLayers();

      const coords = heatLayerSpy.mock.calls[0]![0] as [number, number][];
      expect(coords).toEqual([
        [50.0, 8.0],
        [50.1, 8.1],
        [50.2, 8.2],
      ]);
    });

    it("filters heatmap coordinates by selected aircraft", async () => {
      mockApp.selectedAircraft = "D-EFGH";
      loaderMocks.loadData.mockResolvedValue(baseData());

      await dataManager.updateLayers();

      const coords = heatLayerSpy.mock.calls[0]![0] as [number, number][];
      expect(coords).toEqual([
        [52.0, 10.0],
        [53.0, 11.0],
      ]);
    });

    it("filters heatmap coordinates by selection in isolate mode", async () => {
      mockApp.isolateSelection = true;
      mockApp.selectedPathIds.add(2);
      loaderMocks.loadData.mockResolvedValue(baseData());

      await dataManager.updateLayers();

      const coords = heatLayerSpy.mock.calls[0]![0] as [number, number][];
      expect(coords).toEqual([
        [52.0, 10.0],
        [53.0, 11.0],
      ]);
    });

    it("redraws only the visible colour layers and clears hidden ones", async () => {
      mockApp.altitudeVisible = false;
      mockApp.airspeedVisible = true;
      loaderMocks.loadData.mockResolvedValue(baseData());

      await dataManager.updateLayers();

      expect(mockApp.layerManager.redrawAltitudePaths).not.toHaveBeenCalled();
      expect(mockApp.layerManager.clearLayer).toHaveBeenCalledWith("altitude");
      expect(mockApp.layerManager.redrawAirspeedPaths).toHaveBeenCalled();
      expect(mockApp.layerManager.clearLayer).not.toHaveBeenCalledWith(
        "airspeed",
      );
    });

    it("redraws altitude paths when the altitude layer is visible", async () => {
      mockApp.altitudeVisible = true;
      loaderMocks.loadData.mockResolvedValue(baseData());

      await dataManager.updateLayers();

      expect(mockApp.layerManager.redrawAltitudePaths).toHaveBeenCalled();
      expect(mockApp.layerManager.clearLayer).toHaveBeenCalledWith("airspeed");
    });

    it("refreshes statistics and airport visibility once", async () => {
      loaderMocks.loadData.mockResolvedValue(baseData());

      await dataManager.updateLayers();

      expect(
        mockApp.statsManager.updateStatsForSelection,
      ).toHaveBeenCalledTimes(1);
      expect(mockApp.airportManager.updateAirportOpacity).toHaveBeenCalledTimes(
        1,
      );
    });

    it("discards stale results when a newer updateLayers call supersedes it", async () => {
      const older = createDataset([{ id: 1, year: 2024 }], [], 1);
      const newer = createDataset([{ id: 2, year: 2025 }], [], 2);
      let resolveOlder: (d: KMLDataset) => void = () => {};
      loaderMocks.loadData
        .mockImplementationOnce(
          () =>
            new Promise<KMLDataset>((resolve) => {
              resolveOlder = resolve;
            }),
        )
        .mockResolvedValueOnce(newer);

      mockApp.selectedYear = "2024";
      const first = dataManager.updateLayers();
      mockApp.selectedYear = "2025";
      const second = dataManager.updateLayers();

      await second;
      resolveOlder(older);
      await first;

      expect(mockApp.currentData).toBe(newer);
      expect(heatLayerSpy).toHaveBeenCalledTimes(1);
      expect(
        mockApp.statsManager.updateStatsForSelection,
      ).toHaveBeenCalledTimes(1);
    });
  });
});
