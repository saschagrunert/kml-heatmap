import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  DataManager,
  heatmapCoordinates,
  heatmapFeatures,
} from "../../../../kml_heatmap/frontend/ui/dataManager";
import {
  heatLinesPaint,
  heatmapPaint,
  HEATMAP_LEAST_CONTRIBUTION,
} from "../../../../kml_heatmap/frontend/ui/heatmapPaint";
import {
  HEAT_LINES,
  HEATMAP_CLUSTER,
  MAP_LAYERS,
  MAP_MAX_ZOOM,
  MAP_MIN_ZOOM,
  MAP_SOURCES,
} from "../../../../kml_heatmap/frontend/utils/constants";
import { domCache } from "../../../../kml_heatmap/frontend/utils/domCache";
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
  destroy: vi.fn(),
  options: null as DataLoaderOptions | null,
}));

vi.mock("../../../../kml_heatmap/frontend/services/dataLoader", () => ({
  DataLoader: vi.fn(function (options: DataLoaderOptions) {
    loaderMocks.options = options;
    return {
      loadData: loaderMocks.loadData,
      loadAirports: loaderMocks.loadAirports,
      loadMetadata: loaderMocks.loadMetadata,
      destroy: loaderMocks.destroy,
    };
  }),
}));

const toastMock = vi.hoisted(() => ({
  showToast: vi.fn(),
  dismissToast: vi.fn(),
}));
vi.mock("../../../../kml_heatmap/frontend/utils/toast", () => toastMock);

/** A state of the loader, one year of unknown size unless said otherwise */
function loading(overrides: Partial<LoadingState> = {}): LoadingState {
  return {
    operation: 1,
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
  /** Every fix of baseData's segments, `[lng, lat]` */
  const ALL_FIXES = [
    [8.0, 50.0],
    [8.1, 50.1],
    [8.2, 50.2],
    [10.0, 52.0],
    [11.0, 53.0],
  ];
  /** The `[lng, lat]` points the heat line source draws, each once */
  const heatLinePoints = (): [number, number][] => {
    const data = mockApp.map!.source(MAP_SOURCES.heatLines)
      .data as GeoJSON.FeatureCollection<GeoJSON.LineString>;
    const points = new Map<string, [number, number]>();
    for (const feature of data.features) {
      for (const point of feature.geometry.coordinates) {
        points.set(point.join(), point as [number, number]);
      }
    }
    return [...points.values()];
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
        undefined,
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
      draw(loading(state));
      expect(textEl.textContent).toBe(`Loading ${label}…`);
    });

    it("comes up without a label and writes it a frame later, so the live region announces it", () => {
      draw(loading({ years: ["2025"] }));
      dataManager.hideLoading();
      const written = watchLabel();

      dataManager.showLoading(loading({ years: ["2024"] }));

      // No frame has run, and they are held back while the page is busy:
      // the label of the last load is gone all the same
      expect(frames.pending()).toBe(1);
      expect(written).toEqual(["block: "]);
      frames.run();
      expect(written).toEqual(["block: ", "block: Loading 2024 flights…"]);
    });

    it("leaves the label alone while only the numbers behind the bar change", () => {
      const state = { years: ["2025", "2024"], fileBytes: 4096 };
      draw(loading({ ...state, loadedBytes: 0, totalBytes: 4096 }));
      const written = watchLabel();

      draw(loading({ ...state, loadedBytes: 2048, totalBytes: 4096 }));
      // A new operation: the bar starts over, the files are the same
      draw(loading({ ...state, operation: 2, totalBytes: 1000 }));

      expect(written).toEqual([]);
    });

    it("writes the label again whenever what it says has changed", () => {
      const written = watchLabel();

      draw(loading({ years: ["2025"], fileBytes: 1024 }));
      draw(loading({ years: ["2025", "2024"], fileBytes: 3072 }));
      // "all" is asked for before its years are known
      draw(loading({ all: true, years: ["2025", "2024"], fileBytes: 3072 }));
      draw(loading({ all: true, years: ["2025", "2024", "2023"] }));
      // "all" gave up while a year is still loading, and 2025 failed
      draw(loading({ years: ["2024"], fileBytes: 2048 }));

      expect(written.slice(1)).toEqual([
        "block: Loading 2025 flights (1.0 KB)…",
        "block: Loading 2025, 2024 flights (3.0 KB)…",
        "block: Loading all flights (3.0 KB)…",
        "block: Loading all flights…",
        "block: Loading 2024 flights (2.0 KB)…",
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
        const lookup = vi.spyOn(domCache, "get");

        dataManager.showLoading(loading({ loadedBytes: 1, totalBytes: 1000 }));
        expect(lookup).toHaveBeenCalledWith("loading");
        lookup.mockClear();
        dataManager.showLoading(loading({ loadedBytes: 2, totalBytes: 1000 }));
        dataManager.showLoading(loading({ loadedBytes: 3, totalBytes: 1000 }));

        expect(lookup).not.toHaveBeenCalled();
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
        draw(loading({ loadedBytes: 50, totalBytes: 100 }));
        const hidden = vi.spyOn(bar, "hidden", "set");

        draw(loading({ loadedBytes: 60, totalBytes: 100 }));
        expect(hidden.mock.calls).toEqual([[false]]);
        hidden.mockClear();

        // The same total as before: told apart by the operation alone
        draw(loading({ operation: 2, loadedBytes: 0, totalBytes: 100 }));
        expect(hidden.mock.calls).toEqual([[true], [false]]);
        expect(share()).toBe("0");
        hidden.mockClear();

        draw(loading({ operation: 2, loadedBytes: 10, totalBytes: 100 }));
        expect(hidden.mock.calls).toEqual([[false]]);
      });

      it("brings up no bar for a load whose bytes are all in", () => {
        draw(loading({ loadedBytes: 1000, totalBytes: 1000 }));
        draw(loading({ operation: 2, loadedBytes: 0, totalBytes: 0 }));

        expect(bar.hidden).toBe(true);
        expect(share()).toBe("");
      });

      it("keeps a bar that is up, full, when nothing is left to download", () => {
        draw(loading({ loadedBytes: 900, totalBytes: 1000 }));
        const hidden = vi.spyOn(bar, "hidden", "set");

        draw(loading({ loadedBytes: 1000, totalBytes: 1000 }));
        draw(loading({ operation: 2, loadedBytes: 0, totalBytes: 0 }));

        expect(hidden.mock.calls).toEqual([[false], [false]]);
        expect(share()).toBe("1");
        expect(bar.getAttribute("aria-valuenow")).toBe("100");
      });

      it("takes down a bar that another instance left behind", () => {
        bar.hidden = false;
        bar.setAttribute("aria-valuenow", "60");
        bar.style.setProperty("--loading-progress", "0.6");

        draw(loading());

        expect(bar.hidden).toBe(true);
        expect(bar.hasAttribute("aria-valuenow")).toBe(false);
        expect(share()).toBe("");
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

      it("takes the indicator down with the app, and draws nothing after", () => {
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
        expect(loadingEl.style.display).toBe("none");
        expect(bar.hidden).toBe(true);
        expect(share()).toBe("");
      });

      it("ends the loader, and with it the year worker, with the app", () => {
        dataManager.destroy();

        expect(loaderMocks.destroy).toHaveBeenCalledTimes(1);
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
      expect(loaderMocks.loadData).toHaveBeenCalledWith("2025", undefined);
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

  describe("loadData", () => {
    const signalOf = (call: number): AbortSignal =>
      loaderMocks.loadData.mock.calls[call]![1] as AbortSignal;

    it("keeps a load under way when another year joins (regression)", async () => {
      // The first load's caller is still waiting: the indicator carries
      // both years instead of dropping the first
      loaderMocks.loadData.mockResolvedValue(null);
      const first = dataManager.loadData("2024");
      const second = dataManager.loadData("2025");

      expect(signalOf(0)).toBeUndefined();
      expect(signalOf(1)).toBeUndefined();
      await Promise.all([first, second]);
    });

    it("hands the caller's signal to the loader, and toasts no aborted load", async () => {
      loaderMocks.loadData.mockResolvedValue(null);
      const controller = new AbortController();
      const load = dataManager.loadData("2024", controller.signal);
      controller.abort();
      await load;

      expect(signalOf(0)).toBe(controller.signal);
      expect(toastMock.showToast).not.toHaveBeenCalled();
    });

    it("toasts a dataset that is not there", async () => {
      loaderMocks.loadData.mockResolvedValue(null);

      await dataManager.loadData("2025");

      expect(toastMock.showToast).toHaveBeenCalledWith(
        "No flight data available for 2025",
        "error",
        undefined,
      );
    });

    it("mentions all years in the toast for 'all'", async () => {
      loaderMocks.loadData.mockResolvedValue(null);

      await dataManager.loadData("all");

      expect(toastMock.showToast).toHaveBeenCalledWith(
        "No flight data available for all years",
        "error",
        undefined,
      );
    });

    it("does not double-toast when the loader already reported the failure", async () => {
      loaderMocks.loadData.mockImplementation(() => {
        loaderMocks.options!.onLoadError!(["2025"]);
        return Promise.resolve(null);
      });

      await dataManager.loadData("2025");

      expect(toastMock.showToast).toHaveBeenCalledTimes(1);
      expect(toastMock.showToast).toHaveBeenCalledWith(
        "Failed to load flight data for 2025",
        "error",
        undefined,
      );
    });

    it("offers the caller's retry on the toast of a failed load", async () => {
      const retry = { label: "Retry", run: vi.fn() };
      loaderMocks.loadData.mockImplementation(() => {
        loaderMocks.options!.onLoadError!(["2025"]);
        return Promise.resolve(null);
      });

      await dataManager.loadData("2025", undefined, retry);
      expect(toastMock.showToast).toHaveBeenLastCalledWith(
        "Failed to load flight data for 2025",
        "error",
        retry,
      );

      loaderMocks.loadData.mockResolvedValue(null);
      await dataManager.loadData("2024", undefined, retry);
      expect(toastMock.showToast).toHaveBeenLastCalledWith(
        "No flight data available for 2024",
        "error",
        retry,
      );
    });

    it("keeps a switch's Retry off the years of a load of all it replaced", async () => {
      // The load of all years goes on after a switch replaced it, and its
      // failure used to carry the Retry of the switch, for another year
      const retry = { label: "Retry", run: vi.fn() };
      let finishAll: () => void = () => {};
      loaderMocks.loadData.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishAll = () => {
              loaderMocks.options!.onLoadError!(["2023"]);
              resolve(null);
            };
          }),
      );
      const all = dataManager.loadData("all", undefined, retry);
      loaderMocks.loadData.mockReturnValueOnce(new Promise(() => {}));
      void dataManager.loadData("2025", undefined, retry);

      finishAll();
      await all;

      expect(toastMock.showToast).toHaveBeenCalledWith(
        "Failed to load flight data for 2023",
        "error",
        undefined,
      );
    });

    it("takes the failures on screen away once a dataset has loaded", async () => {
      loaderMocks.loadData.mockImplementationOnce(() => {
        loaderMocks.options!.onLoadError!(["2025"]);
        return Promise.resolve(null);
      });
      await dataManager.loadData("2025");
      loaderMocks.loadData.mockResolvedValueOnce({
        ...baseData(),
        incomplete: true,
      });
      await dataManager.loadData("all");
      // Some years of all are missing: that failure is still true
      expect(toastMock.dismissToast).not.toHaveBeenCalled();

      // An error stays until dismissed; once the page has a whole dataset
      // again, it no longer says anything about what is on screen
      loaderMocks.loadData.mockResolvedValueOnce(baseData());
      await dataManager.loadData("2025");

      expect(toastMock.dismissToast).toHaveBeenCalledWith(
        "Failed to load flight data for 2025",
      );
    });

    it("asks for a reload when the site changed since the page loaded", () => {
      loaderMocks.options!.onLoadError!(["2024", "2025"], true);

      expect(toastMock.showToast).toHaveBeenCalledWith(
        "Failed to load flight data for 2024, 2025. Reload the page to update it.",
        "error",
        undefined,
      );
    });
  });

  describe("drawing what the store holds", () => {
    const publish = (data: KMLDataset): void => {
      mockApp.currentData = data;
    };

    it("draws nothing without a map or before the first dataset", () => {
      mockApp.selectedYear = "2025";
      dataManager.updateLayers();
      expect(heatSource().setData).not.toHaveBeenCalled();

      mockApp.map = null;
      publish(baseData());
      expect(mockApp.layerManager.syncModes).not.toHaveBeenCalled();
    });

    it("hands the heat source every coordinate, longitude first, when unfiltered", () => {
      const data = baseData();

      publish(data);

      expect(heatSource().setData).toHaveBeenCalledTimes(1);
      expect(heatSource().data).toEqual(
        heatmapFeatures(data.coordinates.map(([lat, lon]) => [lon, lat])),
      );
      expect(heatPoints()).toHaveLength(data.coordinates.length);
      expect(heatPoints()[0]).toEqual([8.0, 50.0]);
    });

    it("loads nothing: the dataset is published by whoever loaded it", () => {
      publish(baseData());
      mockApp.selectedAircraft = "D-EFGH";

      expect(loaderMocks.loadData).not.toHaveBeenCalled();
    });

    it("gives the heat layer its paint on first use", () => {
      expect(heatLayer().paint).toEqual({});

      publish(baseData());

      expect(heatLayer().paint).toEqual(heatmapPaint());
      expect(heatLayer().paint["heatmap-radius"]).toBe(22);
      for (const [id, paint] of Object.entries(heatLinesPaint())) {
        expect(mockApp.map!.layer(id).paint).toEqual(paint);
      }
    });

    it("sets the paint once, not with every new set of points", () => {
      mockApp.heatmapVisible = false;
      publish(baseData());
      publish(baseData());
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

    it("feeds the one heat source new points and adds nothing to the map", () => {
      const sources = mockApp.map!.addSource.mock.calls.length;
      const layers = mockApp.map!.addLayer.mock.calls.length;

      publish(baseData());
      mockApp.selectedAircraft = "D-EFGH";

      expect(heatSource().setData).toHaveBeenCalledTimes(2);
      expect(mockApp.map!.addSource).toHaveBeenCalledTimes(sources);
      expect(mockApp.map!.addLayer).toHaveBeenCalledTimes(layers);
    });

    it("leaves the visibility of the heatmap to the store", () => {
      mockApp.heatmapVisible = true;

      publish(baseData());

      expect(mockApp.heatmapLayer.setVisible).not.toHaveBeenCalled();
    });

    it("calculates altitude range from segments", () => {
      publish(baseData());

      expect(mockApp.altitudeRange).toEqual({ min: 1000, max: 5000 });
    });

    it("takes the exact altitude of a path over its rounded segments", () => {
      const data = baseData();
      data.path_info[0]!.max_altitude_ft = 4960.4;
      data.path_info[0]!.min_altitude_ft = 1012.5;

      publish(data);

      expect(mockApp.altitudeRange).toEqual({ min: 1012.5, max: 4960.4 });
    });

    it("keeps the previous altitude range when there are no segments", () => {
      mockApp.altitudeRange = { min: 5, max: 6 };

      publish(createDataset());

      expect(mockApp.altitudeRange).toEqual({ min: 5, max: 6 });
    });

    it("filters heatmap coordinates by selected year", () => {
      mockApp.map!.jumpTo({ zoom: HEAT_LINES.fromZoom });
      mockApp.heatmapLayer.setVisible(true);
      mockApp.selectedYear = "2025";

      publish(baseData());

      expect(heatPoints()).toEqual([
        [8.0, 50.0],
        [8.1, 50.1],
        [8.2, 50.2],
      ]);
      // The heat lines draw the same flights
      expect(heatLinePoints()).toEqual(heatPoints());
    });

    it("hands the heat lines every flight when unfiltered", () => {
      mockApp.map!.jumpTo({ zoom: HEAT_LINES.fromZoom });
      mockApp.heatmapLayer.setVisible(true);

      publish(baseData());

      expect(heatLinePoints()).toEqual(ALL_FIXES);
    });

    it("filters heatmap coordinates by selected aircraft", () => {
      publish(baseData());

      mockApp.selectedAircraft = "D-EFGH";

      expect(heatPoints()).toEqual([
        [10.0, 52.0],
        [11.0, 53.0],
      ]);
    });

    it("filters heatmap coordinates by selection in isolate mode", () => {
      publish(baseData());

      mockApp.store.batch(() => {
        mockApp.selectedPathIds.add(2);
        mockApp.store.notifyMutation("selectedPathIds");
        mockApp.isolateSelection = true;
      });

      expect(heatPoints()).toEqual([
        [10.0, 52.0],
        [11.0, 53.0],
      ]);
    });

    it("isolates only the selected paths the aircraft filter keeps (regression)", () => {
      // Path 1 is D-ABCD, path 2 is D-EFGH: the colour layers draw only
      // path 2, so the heatmap must not draw path 1 beside it
      mockApp.selectedAircraft = "D-EFGH";
      mockApp.isolateSelection = true;
      mockApp.selectedPathIds.add(1);
      mockApp.selectedPathIds.add(2);

      publish(baseData());

      expect(heatPoints()).toEqual([
        [10.0, 52.0],
        [11.0, 53.0],
      ]);
    });

    it("only restyles the paths for a selection outside isolate mode", () => {
      publish(baseData());
      vi.mocked(mockApp.layerManager.syncModes).mockClear();

      mockApp.selectedPathIds.add(1);
      mockApp.store.notifyMutation("selectedPathIds");

      expect(mockApp.layerManager.updateSelectionStyles).toHaveBeenCalledTimes(
        1,
      );
      expect(mockApp.layerManager.syncModes).not.toHaveBeenCalled();
      expect(heatSource().setData).toHaveBeenCalledTimes(1);
    });

    it("gives the heatmap its points for a selection in isolate mode, and restyles the paths", () => {
      mockApp.selectedPathIds.add(1);
      mockApp.isolateSelection = true;
      publish(baseData());
      vi.mocked(mockApp.layerManager.syncModes).mockClear();

      // The colour layers keep their runs: isolation is a filter on them
      mockApp.selectedPathIds.add(2);
      mockApp.store.notifyMutation("selectedPathIds");

      expect(heatPoints()).toEqual(ALL_FIXES);
      expect(mockApp.layerManager.updateSelectionStyles).toHaveBeenCalledTimes(
        1,
      );

      // Leaving it, and coming back
      mockApp.selectedPathIds.delete(1);
      mockApp.store.notifyMutation("selectedPathIds");
      mockApp.isolateSelection = false;
      // Back to the dataset's own points
      expect(heatPoints()).toEqual(
        baseData().coordinates.map(([lat, lng]) => [lng, lat]),
      );
      mockApp.isolateSelection = true;
      expect(heatPoints()).toEqual([
        [10.0, 52.0],
        [11.0, 53.0],
      ]);

      expect(mockApp.layerManager.updateSelectionStyles).toHaveBeenCalledTimes(
        4,
      );
      expect(mockApp.layerManager.syncModes).not.toHaveBeenCalled();
    });

    it("draws a filter change that lands in one update once", () => {
      publish(baseData());
      vi.mocked(mockApp.layerManager.syncModes).mockClear();

      mockApp.store.batch(() => {
        mockApp.selectedYear = "2025";
        mockApp.currentData = baseData();
        mockApp.selectedAircraft = "D-ABCD";
        mockApp.selectedPathIds.clear();
        mockApp.store.notifyMutation("selectedPathIds");
      });

      expect(mockApp.layerManager.syncModes).toHaveBeenCalledTimes(1);
    });

    it("does not send the heat source the points it already holds", () => {
      // A feature per fix is costly to hand to the worker
      publish(baseData());
      const held = heatPoints();

      // The whole dataset again, and a selection that isolates nothing
      dataManager.updateLayers();
      mockApp.selectedPathIds = new Set([1]);
      dataManager.updateLayers();
      expect(heatSource().setData).toHaveBeenCalledTimes(1);

      // Filtered points are a new array each time, of the same coordinates
      mockApp.selectedYear = "2025";
      dataManager.updateLayers();
      expect(heatSource().setData).toHaveBeenCalledTimes(2);
      expect(heatPoints()).not.toEqual(held);
    });

    it("sends the points again once a filter or the isolation changes them", () => {
      mockApp.map!.jumpTo({ zoom: HEAT_LINES.fromZoom });
      mockApp.heatmapLayer.setVisible(true);
      const data = baseData();
      publish(data);

      mockApp.store.batch(() => {
        mockApp.selectedPathIds = new Set([2]);
        mockApp.isolateSelection = true;
      });
      expect(heatSource().setData).toHaveBeenCalledTimes(2);
      expect(heatPoints()).toEqual([
        [10.0, 52.0],
        [11.0, 53.0],
      ]);
      expect(heatLinePoints()).toEqual(heatPoints());

      mockApp.isolateSelection = false;
      expect(heatSource().setData).toHaveBeenCalledTimes(3);
      expect(heatPoints()).toHaveLength(data.coordinates.length);
      expect(heatLinePoints()).toEqual(ALL_FIXES);

      // The same points of another dataset are other points
      publish(baseData());
      expect(heatSource().setData).toHaveBeenCalledTimes(4);
    });

    it("brings the colour layers along, as a rebuild", () => {
      publish(baseData());

      expect(mockApp.layerManager.syncModes).toHaveBeenCalledWith(true);
    });

    it("publishes nothing itself and calls no manager for the dataset", () => {
      const listener = vi.fn();
      mockApp.store.subscribe("currentData", listener);

      publish(baseData());

      expect(listener).toHaveBeenCalledTimes(1);
      // Statistics and airport markers follow the store on their own
      expect(
        mockApp.statsManager.updateStatsForSelection,
      ).not.toHaveBeenCalled();
      expect(
        mockApp.airportManager.updateAirportOpacity,
      ).not.toHaveBeenCalled();
    });
  });

  describe("heat lines", () => {
    const heatLinesSource = (): MockSource =>
      mockApp.map!.source(MAP_SOURCES.heatLines);

    // Shown, the way the app shows it for heatmapVisible
    beforeEach(() => mockApp.heatmapLayer.setVisible(true));

    it("are not worked out while the heatmap is zoomed out", () => {
      mockApp.map!.jumpTo({ zoom: HEAT_LINES.fromZoom - 1.5 });

      mockApp.currentData = baseData();

      expect(heatSource().setData).toHaveBeenCalledTimes(1);
      expect(heatLinesSource().setData).not.toHaveBeenCalled();
    });

    it("are worked out once a zoom ends near the hand-over, once per set of points", () => {
      mockApp.map!.jumpTo({ zoom: HEAT_LINES.fromZoom - 1.5 });
      mockApp.currentData = baseData();

      // Not in a frame of the zoom, which they would hold up
      mockApp.map!.jumpTo({ zoom: HEAT_LINES.fromZoom - 0.5 });
      mockApp.map!.emit("zoom");
      expect(heatLinesSource().setData).not.toHaveBeenCalled();
      // A level short of it, so a zoom on in finds them ready
      mockApp.map!.emit("zoomend");
      expect(heatLinesSource().setData).toHaveBeenCalledTimes(1);
      expect(heatLinePoints()).toEqual(ALL_FIXES);

      // Zooming on, and a redraw with the same points, work out nothing
      mockApp.map!.jumpTo({ zoom: HEAT_LINES.fullZoom });
      mockApp.map!.emit("zoomend");
      dataManager.updateLayers();
      expect(heatLinesSource().setData).toHaveBeenCalledTimes(1);
    });

    it("are not worked out for a hidden heatmap, and are once it shows", () => {
      mockApp.heatmapLayer.setVisible(false);
      mockApp.map!.jumpTo({ zoom: HEAT_LINES.fullZoom });

      mockApp.currentData = baseData();
      mockApp.map!.emit("zoomend");
      expect(heatLinesSource().setData).not.toHaveBeenCalled();

      mockApp.heatmapVisible = true;
      dataManager.showHeatmap();
      expect(heatLinesSource().setData).toHaveBeenCalledTimes(1);
      expect(heatLinePoints()).toEqual(ALL_FIXES);
    });

    it("of other points are taken off while they are not worked out, so a zoom in from further out shows none of them (regression)", () => {
      mockApp.map!.jumpTo({ zoom: HEAT_LINES.fullZoom });
      mockApp.currentData = baseData();
      expect(heatLinePoints()).toEqual(ALL_FIXES);
      mockApp.map!.jumpTo({ zoom: HEAT_LINES.fromZoom - 1.5 });
      mockApp.map!.emit("zoomend");

      // Other points, with the map zoomed out: the lines of the old ones
      // would show from HEAT_LINES.fromZoom on until a zoom in ends
      mockApp.selectedYear = "2025";
      expect(heatLinePoints()).toEqual([]);
      // And once off, they are not taken off again
      mockApp.selectedYear = "all";
      expect(heatLinesSource().setData).toHaveBeenCalledTimes(2);

      mockApp.selectedYear = "2025";
      mockApp.map!.jumpTo({ zoom: HEAT_LINES.fullZoom });
      mockApp.map!.emit("zoomend");
      expect(heatLinePoints()).toEqual([
        [8.0, 50.0],
        [8.1, 50.1],
        [8.2, 50.2],
      ]);
    });

    it("of other points are taken off for a hidden heatmap as well", () => {
      mockApp.map!.jumpTo({ zoom: HEAT_LINES.fullZoom });
      mockApp.currentData = baseData();
      mockApp.heatmapLayer.setVisible(false);

      mockApp.selectedYear = "2025";

      expect(heatLinePoints()).toEqual([]);
    });

    it("stops following the map with the app", () => {
      mockApp.currentData = baseData();
      dataManager.destroy();

      mockApp.map!.jumpTo({ zoom: HEAT_LINES.fullZoom });
      mockApp.map!.emit("zoomend");
      mockApp.map!.emit("webglcontextrestored");
      mockApp.map!.emit("style.load");

      expect(heatLinesSource().setData).not.toHaveBeenCalled();
      expect(mockApp.map!.listenerCount("zoomend")).toBe(0);
    });
  });

  describe("a lost WebGL context", () => {
    /**
     * The map as MapLibre leaves it between the loss and the restored
     * style: no style, so no source to write to
     */
    function loseContext(): () => void {
      const getSource = mockApp.map!.getSource.getMockImplementation()!;
      mockApp.map!.getSource.mockImplementation(() => undefined);
      return () => {
        mockApp.map!.getSource.mockImplementation(getSource);
        mockApp.map!.emit("webglcontextrestored");
        mockApp.map!.emit("style.load");
      };
    }

    it("writes the points of a redraw during the loss once the style is back", () => {
      mockApp.map!.jumpTo({ zoom: HEAT_LINES.fullZoom });
      mockApp.heatmapLayer.setVisible(true);
      mockApp.currentData = baseData();
      const restore = loseContext();

      mockApp.selectedYear = "2025";
      expect(heatSource().setData).toHaveBeenCalledTimes(1);

      restore();

      const kept = [
        [8.0, 50.0],
        [8.1, 50.1],
        [8.2, 50.2],
      ];
      expect(heatSource().setData).toHaveBeenCalledTimes(2);
      expect(heatPoints()).toEqual(kept);
      expect(heatLinePoints()).toEqual(kept);
    });

    it("leaves the heat and its lines the restored sources hold as they are, the last written", () => {
      mockApp.map!.jumpTo({ zoom: HEAT_LINES.fullZoom });
      mockApp.heatmapLayer.setVisible(true);
      mockApp.currentData = baseData();
      const restore = loseContext();

      restore();

      // MapLibre builds the style anew from the one at the loss, which
      // holds the data last handed to each source
      expect(heatSource().setData).toHaveBeenCalledTimes(1);
      expect(
        mockApp.map!.source(MAP_SOURCES.heatLines).setData,
      ).toHaveBeenCalledTimes(1);
      expect(heatLinePoints()).toEqual(ALL_FIXES);
    });
  });

  describe("hidden heat layer", () => {
    it("takes new points while it is hidden and redraws the colour layers", () => {
      mockApp.heatmapVisible = false;
      const data = baseData();

      mockApp.currentData = data;

      expect(heatPoints()).toHaveLength(data.coordinates.length);
      expect(heatLayer().layout["visibility"]).toBe("none");
      expect(mockApp.layerManager.syncModes).toHaveBeenCalledTimes(1);
    });

    it("shows the layer through its handle without feeding it again", () => {
      mockApp.heatmapVisible = false;
      mockApp.currentData = baseData();

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

    it("leaves a map alone whose style has no heat source yet", () => {
      mockApp.map!.removeLayer(MAP_LAYERS.heat);
      mockApp.map!.removeSource(MAP_SOURCES.heat);

      expect(() => {
        mockApp.currentData = baseData();
      }).not.toThrow();

      expect(mockApp.map!.setPaintProperty).not.toHaveBeenCalled();
      expect(mockApp.layerManager.syncModes).toHaveBeenCalledTimes(1);
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

    it("starts at full opacity and fades out for the heat lines", () => {
      expect(paint["heatmap-opacity"]).toEqual([
        "interpolate",
        ["linear"],
        ["zoom"],
        HEAT_LINES.midZoom,
        1,
        HEAT_LINES.fullZoom,
        0,
      ]);
    });

    it("fades the heatmap out only once the heat lines are all there", () => {
      // Both half faded at once lay a grey haze beside lines too faint yet
      expect(HEAT_LINES.fromZoom).toBeLessThan(HEAT_LINES.midZoom);
      expect(HEAT_LINES.midZoom).toBeLessThan(HEAT_LINES.fullZoom);
    });

    it("fades the heat lines in as the heatmap fades out", () => {
      for (const linePaint of Object.values(heatLinesPaint())) {
        const opacity = linePaint["line-opacity"] as unknown[];
        expect(opacity.slice(0, 5)).toEqual([
          "interpolate",
          ["linear"],
          ["zoom"],
          HEAT_LINES.fromZoom,
          0,
        ]);
        expect(opacity[5]).toBe(HEAT_LINES.midZoom);
      }
      // The glow is even, the core fainter where less time was spent
      const glow = heatLinesPaint()[MAP_LAYERS.heatLinesGlow]["line-opacity"];
      expect((glow as unknown[])[6]).toBeGreaterThan(0);
      expect((glow as unknown[])[6]).toBeLessThan(1);
      const core = (
        heatLinesPaint()[MAP_LAYERS.heatLinesCore]["line-opacity"] as unknown[]
      )[6] as unknown[];
      expect(core.slice(0, 3)).toEqual([
        "interpolate",
        ["linear"],
        ["get", "heat"],
      ]);
      const byHeat = core.slice(3).filter((_, i) => i % 2 === 1) as number[];
      expect(byHeat).toEqual([...byHeat].sort((a, b) => a - b));
      expect(byHeat[byHeat.length - 1]).toBe(1);
    });

    it("colours the heat lines with the heatmap's colours, by the seconds spent", () => {
      const heatColors = colorStops()
        .slice(1)
        .map(([, r, g, b]) => `rgb(${r}, ${g}, ${b})`);
      for (const linePaint of Object.values(heatLinesPaint())) {
        const color = linePaint["line-color"] as unknown[];
        expect(color.slice(0, 3)).toEqual([
          "interpolate",
          ["linear"],
          ["get", "heat"],
        ]);
        const stops = color.slice(3);
        const seconds = stops.filter((_, i) => i % 2 === 0) as number[];
        expect(stops.filter((_, i) => i % 2 === 1)).toEqual(heatColors);
        expect(seconds).toEqual([...seconds].sort((a, b) => a - b));
        expect(new Set(seconds).size).toBe(seconds.length);
      }
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
    /** The opacity of the heatmap before it fades out for the heat lines */
    const opacity = (): unknown =>
      (heatLayer().paint["heatmap-opacity"] as unknown[])[4];
    /**
     * The opacities of a heat line layer once faded in: one, or one per
     * heat where it depends on the heat
     */
    const strengths = (value: unknown): number[] => {
      const faded = (value as unknown[])[6];
      if (typeof faded === "number") return [faded];
      return (faded as unknown[])
        .slice(3)
        .filter((_, i) => i % 2 === 1) as number[];
    };
    const lineOpacity = (id: string): number[] =>
      strengths(mockApp.map!.layer(id).paint["line-opacity"]);
    const fullLineOpacity = (id: string): number[] =>
      strengths(
        heatLinesPaint()[id as keyof ReturnType<typeof heatLinesPaint>][
          "line-opacity"
        ],
      );

    it("steps the heatmap back while a colour layer is over it", () => {
      mockApp.altitudeVisible = true;
      mockApp.currentData = baseData();

      expect(opacity()).toBe(0.35);
      // And the heat lines it hands over to, as far
      for (const id of [MAP_LAYERS.heatLinesGlow, MAP_LAYERS.heatLinesCore]) {
        const full = fullLineOpacity(id);
        lineOpacity(id).forEach((value, i) => {
          expect(value).toBeCloseTo(full[i]! * 0.35);
        });
      }
    });

    it("brings it back to full strength on its own", () => {
      mockApp.altitudeVisible = false;
      mockApp.airspeedVisible = false;
      mockApp.currentData = baseData();

      expect(opacity()).toBe(1);
      for (const id of [MAP_LAYERS.heatLinesGlow, MAP_LAYERS.heatLinesCore]) {
        expect(lineOpacity(id)).toEqual(fullLineOpacity(id));
      }
    });

    it("follows the speed layer too", () => {
      mockApp.currentData = baseData();
      expect(opacity()).toBe(1);

      mockApp.airspeedVisible = true;
      dataManager.applyHeatmapEmphasis();

      expect(opacity()).toBe(0.35);

      mockApp.airspeedVisible = false;
      dataManager.applyHeatmapEmphasis();

      expect(opacity()).toBe(1);
    });

    it("steps back under the lines of a selection, and only while they show", () => {
      mockApp.currentData = baseData();
      mockApp.selectedPathIds.add(1);
      dataManager.applyHeatmapEmphasis();
      expect(opacity()).toBe(0.35);

      // A replay hides the lines (and the heatmap): no dimming for them
      mockApp.replayActive = true;
      dataManager.applyHeatmapEmphasis();
      expect(opacity()).toBe(1);

      mockApp.replayActive = false;
      mockApp.selectedPathIds.clear();
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
