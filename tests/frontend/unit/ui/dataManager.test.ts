import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  DataManager,
  heatmapCoordinates,
  heatmapFeatures,
  heatmapPaint,
  HEATMAP_LEAST_CONTRIBUTION,
} from "../../../../kml_heatmap/frontend/ui/dataManager";
import {
  HEATMAP_CLUSTER,
  MAP_LAYERS,
  MAP_MAX_ZOOM,
  MAP_MIN_ZOOM,
  MAP_SOURCES,
} from "../../../../kml_heatmap/frontend/utils/constants";
import type {
  DataLoaderOptions,
  KMLDataset,
  LoadingState,
} from "../../../../kml_heatmap/frontend/types";
import {
  createMockApp,
  createDataset,
  createSegment,
  asMapApp,
  stubAnimationFrames,
  type MockApp,
  type StubbedAnimationFrames,
} from "../../testHelpers";
import type { MockLayer, MockSource } from "../../../mocks/maplibre-gl";

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

/** A state of the loader, one year of unknown size unless said otherwise */
function loading(overrides: Partial<LoadingState> = {}): LoadingState {
  return {
    all: false,
    years: ["2026"],
    fileBytes: undefined,
    loadedBytes: 0,
    totalBytes: undefined,
    ...overrides,
  };
}

describe("DataManager", () => {
  let dataManager: DataManager;
  let mockApp: MockApp;

  const heatSource = (): MockSource => mockApp.map!.source(MAP_SOURCES.heat);
  const heatLayer = (): MockLayer => mockApp.map!.layer(MAP_LAYERS.heat);
  /** The `[lng, lat]` points the heat source holds, in full detail */
  const heatPoints = (): [number, number][] => {
    const data = heatSource().data as GeoJSON.FeatureCollection<GeoJSON.Point>;
    expect(data.type).toBe("FeatureCollection");
    return data.features.map((feature) => {
      expect(feature.geometry.type).toBe("Point");
      return feature.geometry.coordinates as [number, number];
    });
  };
  /** How often a paint property of a heat layer was set */
  const paintCalls = (name: string, layer: string): unknown[][] =>
    mockApp.map!.setPaintProperty.mock.calls.filter(
      (call) => call[0] === layer && call[1] === name,
    );

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

    // The stylesheet's token; jsdom loads no stylesheet
    document.documentElement.style.setProperty(
      "--heatmap-dimmed-opacity",
      "0.35",
    );

    mockApp = createMockApp();
    dataManager = new DataManager(asMapApp(mockApp));
  });

  afterEach(() => {
    document.getElementById("loading")?.remove();
    document.documentElement.style.removeProperty("--heatmap-dimmed-opacity");
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
      loaderMocks.options!.showLoading!(loading({ years: ["2025"] }));
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
    let loadingEl: HTMLElement;
    let textEl: HTMLElement;
    let bar: HTMLElement;
    let frames: StubbedAnimationFrames;

    beforeEach(() => {
      loadingEl = document.getElementById("loading")!;
      textEl = document.createElement("span");
      textEl.id = "loading-text";
      textEl.textContent = "Loading data…";
      bar = document.createElement("div");
      bar.id = "loading-progress";
      bar.hidden = true;
      loadingEl.append(textEl, bar);
      frames = stubAnimationFrames();
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    /** Show a state and let the frame that draws it run */
    const draw = (state: LoadingState): void => {
      dataManager.showLoading(state);
      frames.run();
    };

    /** Every text the label is given from here on */
    const watchLabel = (): string[] => {
      const written: string[] = [];
      const descriptor = Object.getOwnPropertyDescriptor(
        Node.prototype,
        "textContent",
      )!;
      Object.defineProperty(textEl, "textContent", {
        configurable: true,
        get(this: Node) {
          return descriptor.get!.call(this) as string | null;
        },
        set(this: Node, value: string | null) {
          written.push(`${loadingEl.style.display}: ${value}`);
          descriptor.set!.call(this, value);
        },
      });
      return written;
    };

    const share = (): string =>
      bar.style.getPropertyValue("--loading-progress");

    it("toggles the loading element", () => {
      dataManager.showLoading(loading());
      expect(loadingEl.style.display).toBe("block");
      dataManager.hideLoading();
      expect(loadingEl.style.display).toBe("none");
    });

    it.each([
      [
        { years: ["2026"], fileBytes: 1.1 * 1024 * 1024 },
        "2026 flights (1.1 MB)",
      ],
      [{ all: true, fileBytes: 24 * 1024 * 1024 }, "all flights (24 MB)"],
      [{ years: ["2025"] }, "2025 flights"],
      [
        { years: ["2025", "2024"], fileBytes: 2048 },
        "2025, 2024 flights (2.0 KB)",
      ],
      [{ all: true, years: [] }, "all flights"],
    ])("describes what is loading: %j", (state, label) => {
      dataManager.showLoading(loading(state));
      expect(textEl.textContent).toBe(`Loading ${label}…`);
    });

    it("writes the label with the indicator, displayed first so the live region announces it", () => {
      const written = watchLabel();

      dataManager.showLoading(loading({ years: ["2026"] }));

      // No frame has run: they are held back while the page is busy
      expect(frames.pending()).toBe(1);
      expect(written).toEqual(["block: Loading 2026 flights…"]);
    });

    it("does not show the label of the last load", () => {
      draw(loading({ years: ["2025"] }));
      dataManager.hideLoading();

      dataManager.showLoading(loading({ years: ["2024"] }));

      expect(textEl.textContent).toBe("Loading 2024 flights…");
    });

    it("leaves the label alone while only the numbers behind the bar change", () => {
      const written = watchLabel();
      const state = { years: ["2025", "2024"], fileBytes: 4096 };

      draw(loading({ ...state, loadedBytes: 0, totalBytes: 4096 }));
      draw(loading({ ...state, loadedBytes: 2048, totalBytes: 4096 }));
      // A new operation: the bar starts over, the files are the same
      draw(loading({ ...state, loadedBytes: 0, totalBytes: 1000 }));
      // One of them failed, which its own toast reports
      draw(loading({ years: ["2024"], fileBytes: 2048, totalBytes: 500 }));

      expect(written).toEqual(["block: Loading 2025, 2024 flights (4.0 KB)…"]);
    });

    it("writes the label again for a year it does not name, and for all of them", () => {
      const written = watchLabel();

      draw(loading({ years: ["2025"] }));
      draw(loading({ years: ["2025", "2024"] }));
      draw(loading({ all: true, years: ["2025", "2024", "2023"] }));
      draw(loading({ all: true, years: ["2023"] }));

      expect(written).toEqual([
        "block: Loading 2025 flights…",
        "block: Loading 2025, 2024 flights…",
        "block: Loading all flights…",
      ]);
    });

    describe("download progress", () => {
      it("draws the bar once per frame, from the latest state", () => {
        const setProperty = vi.spyOn(bar.style, "setProperty");

        for (const loadedBytes of [100, 250, 370]) {
          dataManager.showLoading(loading({ loadedBytes, totalBytes: 1000 }));
        }

        expect(frames.pending()).toBe(1);
        expect(bar.hidden).toBe(true);
        frames.run();
        expect(setProperty).toHaveBeenCalledExactlyOnceWith(
          "--loading-progress",
          "0.37",
        );
        expect(bar.hidden).toBe(false);
      });

      it("looks the indicator up once per load, not once per chunk", () => {
        const getElementById = vi.spyOn(document, "getElementById");

        dataManager.showLoading(loading({ loadedBytes: 1, totalBytes: 1000 }));
        const lookups = getElementById.mock.calls.length;
        dataManager.showLoading(loading({ loadedBytes: 2, totalBytes: 1000 }));
        dataManager.showLoading(loading({ loadedBytes: 3, totalBytes: 1000 }));

        expect(getElementById.mock.calls.length).toBe(lookups);
      });

      it("moves the accessible value in steps of ten", () => {
        const setAttribute = vi.spyOn(bar, "setAttribute");

        // 300 of 1000 is the one that 0.3 * 10 would get wrong as a float
        for (const loadedBytes of [10, 99, 100, 199, 299, 300, 305, 1000]) {
          draw(loading({ loadedBytes, totalBytes: 1000 }));
        }

        expect(
          setAttribute.mock.calls
            .filter(([name]) => name === "aria-valuenow")
            .map(([, value]) => value),
        ).toEqual(["0", "10", "20", "30", "100"]);
      });

      it("displays the bar anew for a new operation, so its delay runs again", () => {
        draw(loading({ loadedBytes: 900, totalBytes: 1000 }));
        const hidden = vi.spyOn(bar, "hidden", "set");

        draw(loading({ loadedBytes: 950, totalBytes: 1000 }));
        expect(hidden.mock.calls).toEqual([[false]]);
        hidden.mockClear();

        draw(loading({ loadedBytes: 0, totalBytes: 400 }));
        expect(hidden.mock.calls).toEqual([[true], [false]]);
        expect(share()).toBe("0");
      });

      it("keeps the bar up, full, when nothing is left to download", () => {
        draw(loading({ loadedBytes: 900, totalBytes: 1000 }));
        const hidden = vi.spyOn(bar, "hidden", "set");

        draw(loading({ loadedBytes: 3000, totalBytes: 3000 }));

        expect(hidden.mock.calls).toEqual([[false]]);
        expect(share()).toBe("1");
        expect(bar.getAttribute("aria-valuenow")).toBe("100");
      });

      it("hides the bar without a total, and touches it only once", () => {
        draw(loading({ loadedBytes: 400, totalBytes: 1000 }));
        const removeAttribute = vi.spyOn(bar, "removeAttribute");

        draw(loading());
        draw(loading());

        expect(bar.hidden).toBe(true);
        expect(bar.hasAttribute("aria-valuenow")).toBe(false);
        expect(share()).toBe("");
        expect(removeAttribute).toHaveBeenCalledOnce();
      });

      it("hiding the indicator drops the bar and the frame it was waiting for", () => {
        draw(loading({ loadedBytes: 500, totalBytes: 1000 }));
        dataManager.showLoading(
          loading({ loadedBytes: 1000, totalBytes: 1000 }),
        );

        dataManager.hideLoading();

        expect(frames.pending()).toBe(0);
        expect(bar.hidden).toBe(true);
        expect(bar.hasAttribute("aria-valuenow")).toBe(false);
        expect(share()).toBe("");
      });

      it("draws nothing once the app is destroyed", () => {
        draw(loading({ loadedBytes: 0, totalBytes: 1000 }));
        dataManager.showLoading(
          loading({ loadedBytes: 500, totalBytes: 1000 }),
        );

        dataManager.destroy();
        frames.run();
        dataManager.showLoading(
          loading({ loadedBytes: 700, totalBytes: 1000 }),
        );

        expect(frames.pending()).toBe(0);
        expect(share()).toBe("0");
      });

      it("works without the bar in the template", () => {
        bar.remove();

        expect(() => {
          draw(loading({ loadedBytes: 1, totalBytes: 2 }));
          dataManager.hideLoading();
        }).not.toThrow();
      });
    });

    it("works without #loading-text", () => {
      textEl.remove();
      expect(() => draw(loading({ totalBytes: 10 }))).not.toThrow();
      expect(loadingEl.style.display).toBe("block");
    });

    it("handles a missing loading element", () => {
      loadingEl.remove();
      expect(() => draw(loading())).not.toThrow();
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
      expect(heatSource().setData).not.toHaveBeenCalled();
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

    it("hands the heat source every coordinate, longitude first, when unfiltered", async () => {
      const data = baseData();
      loaderMocks.loadData.mockResolvedValue(data);

      await dataManager.updateLayers();

      expect(heatSource().setData).toHaveBeenCalledTimes(1);
      expect(heatSource().data).toEqual(
        heatmapFeatures(data.coordinates.map(([lat, lon]) => [lon, lat])),
      );
      expect(heatPoints()).toHaveLength(data.coordinates.length);
      expect(heatPoints()[0]).toEqual([8.0, 50.0]);
    });

    it("gives the heat layer its paint on first use", async () => {
      expect(heatLayer().paint).toEqual({});

      await dataManager.updateLayers(baseData());

      expect(heatLayer().paint).toEqual(heatmapPaint());
      expect(heatLayer().paint["heatmap-radius"]).toBe(22);
    });

    it("sets the paint once, not with every new set of points", async () => {
      mockApp.heatmapVisible = false;
      await dataManager.updateLayers(baseData());
      await dataManager.updateLayers(baseData());
      dataManager.showHeatmap();

      expect(heatSource().setData).toHaveBeenCalledTimes(2);
      for (const name of [
        "heatmap-radius",
        "heatmap-weight",
        "heatmap-intensity",
        "heatmap-color",
      ]) {
        expect(paintCalls(name, MAP_LAYERS.heat)).toHaveLength(1);
      }
    });

    it("feeds the one heat source new points and adds nothing to the map", async () => {
      const data = baseData();
      loaderMocks.loadData.mockResolvedValue(data);
      const sources = mockApp.map!.addSource.mock.calls.length;
      const layers = mockApp.map!.addLayer.mock.calls.length;

      await dataManager.updateLayers();
      mockApp.selectedAircraft = "D-EFGH";
      await dataManager.updateLayers();

      expect(heatSource().setData).toHaveBeenCalledTimes(2);
      expect(mockApp.map!.addSource).toHaveBeenCalledTimes(sources);
      expect(mockApp.map!.addLayer).toHaveBeenCalledTimes(layers);
    });

    it("shows the heatmap if visible and not in replay mode", async () => {
      mockApp.heatmapVisible = true;
      loaderMocks.loadData.mockResolvedValue(baseData());

      await dataManager.updateLayers();

      expect(mockApp.heatmapLayer.setVisible).toHaveBeenCalledWith(true);
      expect(heatLayer().layout["visibility"]).toBe("visible");
    });

    it("does not show the heatmap if not visible", async () => {
      mockApp.heatmapVisible = false;
      loaderMocks.loadData.mockResolvedValue(baseData());

      await dataManager.updateLayers();

      expect(mockApp.heatmapLayer.setVisible).not.toHaveBeenCalled();
      expect(heatLayer().layout["visibility"]).toBe("none");
    });

    it("does not show the heatmap if in replay mode", async () => {
      mockApp.replayManager.state.active = true;
      loaderMocks.loadData.mockResolvedValue(baseData());

      await dataManager.updateLayers();

      expect(mockApp.heatmapLayer.setVisible).not.toHaveBeenCalled();
      expect(heatLayer().layout["visibility"]).toBe("none");
    });

    it("calculates altitude range from segments", async () => {
      loaderMocks.loadData.mockResolvedValue(baseData());

      await dataManager.updateLayers();

      expect(mockApp.altitudeRange).toEqual({ min: 1000, max: 5000 });
    });

    it("takes the exact altitude of a path over its rounded segments", async () => {
      const data = baseData();
      data.path_info[0]!.max_altitude_ft = 4960.4;
      data.path_info[0]!.min_altitude_ft = 1012.5;

      await dataManager.updateLayers(data);

      expect(mockApp.altitudeRange).toEqual({ min: 1012.5, max: 4960.4 });
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

      expect(heatPoints()).toEqual([
        [8.0, 50.0],
        [8.1, 50.1],
        [8.2, 50.2],
      ]);
    });

    it("filters heatmap coordinates by selected aircraft", async () => {
      mockApp.selectedAircraft = "D-EFGH";
      loaderMocks.loadData.mockResolvedValue(baseData());

      await dataManager.updateLayers();

      expect(heatPoints()).toEqual([
        [10.0, 52.0],
        [11.0, 53.0],
      ]);
    });

    it("filters heatmap coordinates by selection in isolate mode", async () => {
      mockApp.isolateSelection = true;
      mockApp.selectedPathIds.add(2);
      loaderMocks.loadData.mockResolvedValue(baseData());

      await dataManager.updateLayers();

      expect(heatPoints()).toEqual([
        [10.0, 52.0],
        [11.0, 53.0],
      ]);
    });

    it("isolates only the selected paths the aircraft filter keeps (regression)", async () => {
      // Path 1 is D-ABCD, path 2 is D-EFGH: the colour layers draw only
      // path 2, so the heatmap must not draw path 1 beside it
      mockApp.selectedAircraft = "D-EFGH";
      mockApp.isolateSelection = true;
      mockApp.selectedPathIds.add(1);
      mockApp.selectedPathIds.add(2);
      loaderMocks.loadData.mockResolvedValue(baseData());

      await dataManager.updateLayers();

      expect(heatPoints()).toEqual([
        [10.0, 52.0],
        [11.0, 53.0],
      ]);
    });

    it("redraws the dataset on the map instead of loading it again", async () => {
      const data = baseData();
      mockApp.selectedYear = "2025";
      await dataManager.updateLayers(data);

      await dataManager.updateLayers();

      expect(loaderMocks.loadData).not.toHaveBeenCalled();
      expect(mockApp.currentData).toBe(data);
    });

    it("does not send the heat source the points it already holds", async () => {
      // A feature per fix is costly to hand to the worker
      const data = baseData();
      await dataManager.updateLayers(data);
      const held = heatPoints();

      // The whole dataset again, and a selection that isolates nothing
      await dataManager.updateLayers();
      mockApp.selectedPathIds = new Set([1]);
      await dataManager.updateLayers();
      expect(heatSource().setData).toHaveBeenCalledTimes(1);

      // Filtered points are a new array each time, of the same coordinates
      mockApp.selectedYear = "2025";
      await dataManager.updateLayers();
      await dataManager.updateLayers();
      expect(heatSource().setData).toHaveBeenCalledTimes(2);
      expect(heatPoints()).not.toEqual(held);
    });

    it("sends the points again once a filter or the isolation changes them", async () => {
      const data = baseData();
      await dataManager.updateLayers(data);

      mockApp.selectedPathIds = new Set([2]);
      mockApp.isolateSelection = true;
      await dataManager.updateLayers();
      expect(heatSource().setData).toHaveBeenCalledTimes(2);
      expect(heatPoints()).toEqual([
        [10.0, 52.0],
        [11.0, 53.0],
      ]);

      mockApp.isolateSelection = false;
      await dataManager.updateLayers();
      expect(heatSource().setData).toHaveBeenCalledTimes(3);
      expect(heatPoints()).toHaveLength(data.coordinates.length);

      // The same points of another dataset are other points
      await dataManager.updateLayers(baseData());
      expect(heatSource().setData).toHaveBeenCalledTimes(4);
    });

    it("does not retry and report a partial load on every redraw (regression)", async () => {
      // "all" combined from the years that loaded; the loader does not cache
      // a partial combination and reports the missing year on each call
      const partial = baseData();
      loaderMocks.loadData.mockImplementationOnce(() => {
        loaderMocks.options!.onLoadError!(["2024"]);
        return Promise.resolve(partial);
      });
      await dataManager.updateLayers();
      const listener = vi.fn();
      mockApp.store.subscribe("currentData", listener);

      // The isolate toggle, a selection in isolate mode, the aircraft filter
      await dataManager.updateLayers();
      await dataManager.updateLayers();

      expect(loaderMocks.loadData).toHaveBeenCalledTimes(1);
      expect(toastMock.showToast).toHaveBeenCalledTimes(1);
      expect(mockApp.currentData).toBe(partial);
      expect(listener).not.toHaveBeenCalled();
    });

    it("loads again once the year differs from the dataset on the map", async () => {
      mockApp.selectedYear = "2025";
      await dataManager.updateLayers(baseData());
      const next = createDataset([{ id: 3, year: 2024 }]);
      loaderMocks.loadData.mockResolvedValue(next);

      mockApp.selectedYear = "2024";
      await dataManager.updateLayers();

      expect(loaderMocks.loadData).toHaveBeenCalledWith("2024");
      expect(mockApp.currentData).toBe(next);
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

    it("publishes the dataset through the store once and calls no manager for it", async () => {
      const data = baseData();
      loaderMocks.loadData.mockResolvedValue(data);
      const listener = vi.fn();
      mockApp.store.subscribe("currentData", listener);

      await dataManager.updateLayers();

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(data, null);
      // Statistics and airport markers follow the store on their own
      expect(
        mockApp.statsManager.updateStatsForSelection,
      ).not.toHaveBeenCalled();
      expect(
        mockApp.airportManager.updateAirportOpacity,
      ).not.toHaveBeenCalled();
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
      expect(heatSource().setData).toHaveBeenCalledTimes(1);
    });
  });

  describe("hidden heat layer", () => {
    it("takes new points while it is hidden and redraws the colour layers", async () => {
      mockApp.heatmapVisible = false;
      mockApp.altitudeVisible = true;
      const data = baseData();
      loaderMocks.loadData.mockResolvedValue(data);

      await expect(dataManager.updateLayers()).resolves.toBeUndefined();

      expect(heatPoints()).toHaveLength(data.coordinates.length);
      expect(heatLayer().layout["visibility"]).toBe("none");
      expect(mockApp.layerManager.redrawAltitudePaths).toHaveBeenCalledTimes(1);
    });

    it("shows the layer through its handle without feeding it again", async () => {
      mockApp.heatmapVisible = false;
      await dataManager.updateLayers(baseData());

      mockApp.heatmapVisible = true;
      dataManager.showHeatmap();

      expect(mockApp.heatmapLayer.setVisible).toHaveBeenCalledWith(true);
      expect(mockApp.heatmapLayer.isVisible()).toBe(true);
      expect(heatLayer().layout["visibility"]).toBe("visible");
      expect(heatSource().setData).toHaveBeenCalledTimes(1);
    });

    it("paints a layer that is shown before it got any points", () => {
      dataManager.showHeatmap();

      expect(heatLayer().paint).toEqual(heatmapPaint());
    });

    it("does nothing without a map", () => {
      mockApp.map = null;

      expect(() => dataManager.showHeatmap()).not.toThrow();
      expect(mockApp.heatmapLayer.setVisible).not.toHaveBeenCalled();
    });

    it("leaves a map alone whose style has no heat source yet", async () => {
      mockApp.map!.removeLayer(MAP_LAYERS.heat);
      mockApp.map!.removeSource(MAP_SOURCES.heat);
      mockApp.altitudeVisible = true;

      await expect(
        dataManager.updateLayers(baseData()),
      ).resolves.toBeUndefined();

      expect(mockApp.map!.setPaintProperty).not.toHaveBeenCalled();
      expect(mockApp.layerManager.redrawAltitudePaths).toHaveBeenCalledTimes(1);
    });
  });

  describe("heatmapPaint", () => {
    const paint = heatmapPaint();

    it("halves the intensity per zoom level out, up to where fixes turn into dots", () => {
      const intensity = paint["heatmap-intensity"] as unknown[];
      expect(intensity.slice(0, 3)).toEqual([
        "interpolate",
        ["exponential", 2],
        ["zoom"],
      ]);
      const stops = intensity.slice(3) as number[];
      expect(stops).toHaveLength(6);
      const [z0, i0, z1, i1, z2, i2] = stops as [
        number,
        number,
        number,
        number,
        number,
        number,
      ];
      // A power of two per level makes the base 2 curve exactly 2^zoom
      expect(i1 / i0).toBe(2 ** (z1 - z0));
      expect(z2).toBeGreaterThan(z1);
      expect(i2).toBe(i1);
    });

    /** What the intensity comes to at `zoom`, by the rule of the expression */
    const intensityAt = (zoom: number): number => {
      const [z0, i0, z1, i1] = (paint["heatmap-intensity"] as unknown[]).slice(
        3,
      ) as [number, number, number, number];
      return zoom >= z1 ? i1 : i0 * 2 ** (zoom - z0);
    };

    /**
     * What the weight comes to for a feature with these properties. Only the
     * shape heatmapWeight builds is understood: an interpolation over the
     * zoom whose outputs are the count or `["max", count, floor]`.
     */
    const weightAt = (
      zoom: number,
      properties: { point_count?: number },
    ): number => {
      const weight = paint["heatmap-weight"] as unknown[];
      expect(weight.slice(0, 3)).toEqual([
        "interpolate",
        ["exponential", 0.5],
        ["zoom"],
      ]);
      const count = properties.point_count ?? 1;
      const output = (value: unknown): number => {
        const countExpression = ["coalesce", ["get", "point_count"], 1];
        if (JSON.stringify(value) === JSON.stringify(countExpression)) {
          return count;
        }
        const [operator, first, floor] = value as [string, unknown, number];
        expect(operator).toBe("max");
        expect(first).toEqual(countExpression);
        return Math.max(count, floor);
      };
      const stops = weight.slice(3);
      const zooms = stops.filter((_, i) => i % 2 === 0) as number[];
      const outputs = stops.filter((_, i) => i % 2 === 1).map(output);
      if (zoom <= zooms[0]!) return outputs[0]!;
      const last = zooms.length - 1;
      if (zoom >= zooms[last]!) return outputs[last]!;
      const upper = zooms.findIndex((z) => z > zoom);
      const [from, to] = [zooms[upper - 1]!, zooms[upper]!];
      // MapLibre's exponential interpolation
      const t = (0.5 ** (zoom - from) - 1) / (0.5 ** (to - from) - 1);
      return outputs[upper - 1]! + (outputs[upper]! - outputs[upper - 1]!) * t;
    };

    it("never lets a lone fix contribute less than at the first zoom without clusters", () => {
      // No spacing of the fixes assumed: a feature without `point_count` is
      // a fix that found no cluster, however far out the map is
      expect(HEATMAP_LEAST_CONTRIBUTION).toBeGreaterThanOrEqual(0.004);
      expect(HEATMAP_LEAST_CONTRIBUTION).toBe(
        intensityAt(HEATMAP_CLUSTER.maxZoom + 1),
      );
      for (let zoom = 0; zoom <= MAP_MAX_ZOOM; zoom += 0.5) {
        const contribution = weightAt(zoom, {}) * intensityAt(zoom);
        expect(contribution).toBeGreaterThanOrEqual(
          HEATMAP_LEAST_CONTRIBUTION * (1 - 1e-9),
        );
      }
      expect(MAP_MIN_ZOOM).toBeGreaterThanOrEqual(0);
    });

    it("holds a lone fix at exactly the floor while clusters are drawn", () => {
      for (let zoom = 0; zoom <= HEATMAP_CLUSTER.maxZoom + 1; zoom += 0.25) {
        expect(weightAt(zoom, {}) * intensityAt(zoom)).toBeCloseTo(
          HEATMAP_LEAST_CONTRIBUTION,
          12,
        );
      }
    });

    it("weighs a fix as one where fixes are drawn, and a big cluster as its fixes", () => {
      for (
        let zoom = HEATMAP_CLUSTER.maxZoom + 1;
        zoom <= MAP_MAX_ZOOM;
        zoom++
      ) {
        expect(weightAt(zoom, {})).toBe(1);
      }
      for (let zoom = 0; zoom <= HEATMAP_CLUSTER.maxZoom; zoom += 0.5) {
        expect(weightAt(zoom, { point_count: 100000 })).toBe(100000);
        // The floor only ever adds
        expect(weightAt(zoom, { point_count: 3 })).toBeGreaterThanOrEqual(3);
      }
    });

    /** The stops of the colour ramp as `[density, r, g, b, alpha]` */
    const colorStops = (): number[][] => {
      const stops = (paint["heatmap-color"] as unknown[]).slice(3);
      expect(stops.length % 2).toBe(0);
      const parsed: number[][] = [];
      for (let i = 0; i < stops.length; i += 2) {
        const match = /^rgba\((\d+), (\d+), (\d+), ([\d.]+)\)$/.exec(
          stops[i + 1] as string,
        );
        expect(match).not.toBeNull();
        parsed.push([stops[i] as number, ...match!.slice(1).map(Number)]);
      }
      return parsed;
    };

    it("colours by density, from nothing at 0 up to 1", () => {
      const color = paint["heatmap-color"] as unknown[];
      expect(color.slice(0, 3)).toEqual([
        "interpolate",
        ["linear"],
        ["heatmap-density"],
      ]);
      const densities = colorStops().map((stop) => stop[0]!);
      expect(densities).toEqual([...densities].sort((a, b) => a - b));
      expect(new Set(densities).size).toBe(densities.length);
      expect(densities[0]).toBe(0);
      expect(densities[densities.length - 1]).toBe(1);
      for (const [, r, g, b] of colorStops()) {
        for (const channel of [r!, g!, b!]) {
          expect(channel).toBeGreaterThanOrEqual(0);
          expect(channel).toBeLessThanOrEqual(255);
        }
      }
    });

    it("gets more opaque with the density, from fully transparent to opaque", () => {
      const alphas = colorStops().map((stop) => stop[4]!);
      for (let i = 1; i < alphas.length; i++) {
        expect(alphas[i]).toBeGreaterThanOrEqual(alphas[i - 1]!);
      }
      // Nothing where there is no flight, or the whole map is tinted
      expect(alphas[0]).toBe(0);
      expect(alphas[alphas.length - 1]).toBe(1);
    });

    it("never draws fainter than leaflet.heat's minOpacity", () => {
      const visible = colorStops()
        .map((stop) => stop[4]!)
        .filter((alpha) => alpha > 0);
      expect(Math.min(...visible)).toBe(0.25);
      expect(visible[0]).toBe(0.25);
    });

    it("starts at full opacity", () => {
      expect(paint["heatmap-opacity"]).toBe(1);
    });
  });

  describe("heatmapCoordinates", () => {
    const start: [number, number] = [50, 8];
    const mid: [number, number] = [50.1, 8.1];
    const end: [number, number] = [50.2, 8.2];
    const other: [number, number] = [52, 10];
    const otherEnd: [number, number] = [53, 11];
    const segments = [
      createSegment({ path_id: 1, coords: [start, mid] }),
      createSegment({ path_id: 1, coords: [mid, end] }),
      createSegment({ path_id: 2, coords: [other, otherEnd] }),
    ];

    it("lists every start point once and each path's end point", () => {
      expect(heatmapCoordinates(segments, () => true)).toEqual([
        start,
        mid,
        end,
        other,
        otherEnd,
      ]);
    });

    it("keeps only the paths the filter accepts", () => {
      expect(heatmapCoordinates(segments, (id) => id === 2)).toEqual([
        other,
        otherEnd,
      ]);
      expect(heatmapCoordinates(segments, () => false)).toEqual([]);
    });

    it("skips segments without coordinates", () => {
      expect(
        heatmapCoordinates(
          [{ path_id: 1 }, createSegment({ path_id: 1, coords: [start, mid] })],
          () => true,
        ),
      ).toEqual([start, mid]);
    });
  });

  describe("heatmapFeatures", () => {
    /** `count` points along a line, `[lng, lat]`, each telling its index */
    const line = (count: number): [number, number][] =>
      Array.from({ length: count }, (_, i): [number, number] => [8 + i, 50]);

    it("makes one Point per fix, which is what the source can cluster", () => {
      const points = line(3);

      expect(heatmapFeatures(points)).toEqual({
        type: "FeatureCollection",
        features: points.map((coordinates) => ({
          type: "Feature",
          properties: null,
          geometry: { type: "Point", coordinates },
        })),
      });
    });

    it("has no features without any point", () => {
      expect(heatmapFeatures([])).toEqual({
        type: "FeatureCollection",
        features: [],
      });
    });
  });

  describe("applyHeatmapEmphasis", () => {
    const opacity = (): unknown => heatLayer().paint["heatmap-opacity"];

    it("steps the heatmap back while a colour layer is over it", async () => {
      mockApp.altitudeVisible = true;
      await dataManager.updateLayers(baseData());

      expect(opacity()).toBe(0.35);
    });

    it("brings it back to full strength on its own", async () => {
      mockApp.altitudeVisible = false;
      mockApp.airspeedVisible = false;
      await dataManager.updateLayers(baseData());

      expect(opacity()).toBe(1);
    });

    it("follows the speed layer too", async () => {
      await dataManager.updateLayers(baseData());
      expect(opacity()).toBe(1);

      mockApp.airspeedVisible = true;
      dataManager.applyHeatmapEmphasis();

      expect(opacity()).toBe(0.35);

      mockApp.airspeedVisible = false;
      dataManager.applyHeatmapEmphasis();

      expect(opacity()).toBe(1);
    });

    it("takes how far from the stylesheet's token", () => {
      document.documentElement.style.setProperty(
        "--heatmap-dimmed-opacity",
        " 0.5 ",
      );
      mockApp.altitudeVisible = true;

      dataManager.applyHeatmapEmphasis();

      expect(opacity()).toBe(0.5);
    });

    it.each(["", "none", "7", "-1"])(
      "falls back to 0.35 for a token of '%s'",
      (value) => {
        document.documentElement.style.setProperty(
          "--heatmap-dimmed-opacity",
          value,
        );
        mockApp.altitudeVisible = true;

        dataManager.applyHeatmapEmphasis();

        expect(opacity()).toBe(0.35);
      },
    );

    it("dims a hidden heatmap too, so it is right when it is shown", () => {
      mockApp.heatmapVisible = false;
      mockApp.altitudeVisible = true;

      dataManager.applyHeatmapEmphasis();

      expect(opacity()).toBe(0.35);
      expect(heatLayer().layout["visibility"]).toBe("none");
    });

    it("does nothing without a map or before the layers exist", () => {
      mockApp.map!.removeLayer(MAP_LAYERS.heat);
      expect(() => dataManager.applyHeatmapEmphasis()).not.toThrow();
      expect(mockApp.map!.setPaintProperty).not.toHaveBeenCalled();

      mockApp.map = null;
      expect(() => dataManager.applyHeatmapEmphasis()).not.toThrow();
    });
  });
});
