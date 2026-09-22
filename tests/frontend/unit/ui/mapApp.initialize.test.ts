/**
 * MapApp.initialize: data loading, year selection and restored state.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { MapApp } from "../../../../kml_heatmap/frontend/mapApp";
import {
  Marker as MockMarker,
  resetMapLibreMock,
  type Map as MockMap,
} from "../../../mocks/maplibre-gl";

// The instances the mocked manager constructors hand out live in the setup
// module, which is loaded before the mocks are registered
const m = await vi.hoisted(() => import("./mapAppTestSetup"));

vi.mock("../../../../kml_heatmap/frontend/utils/logger", () => ({
  logError: vi.fn(),
  logDebug: vi.fn(),
  initLogger: vi.fn(),
}));
vi.mock("../../../../kml_heatmap/frontend/utils/domCache", () => ({
  domCache: {
    get: vi.fn((id: string, ctor?: new () => HTMLElement) => {
      const element = document.getElementById(id);
      if (!element || !ctor) return element;
      return element instanceof ctor ? element : null;
    }),
    clear: vi.fn(),
  },
}));
vi.mock(
  "../../../../kml_heatmap/frontend/utils/mapHelpers",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../../../kml_heatmap/frontend/utils/mapHelpers")
    >()),
    resizeMapAfterTransition: vi.fn(),
  }),
);
const toastMock = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock("../../../../kml_heatmap/frontend/utils/toast", () => toastMock);
// The real bar registers a window resize listener it never removes, so every
// test would leak one along with the MapApp it pins
const mobileBarMock = vi.hoisted(() => ({ mountFor: vi.fn() }));
vi.mock("../../../../kml_heatmap/frontend/ui/mobileBar", () => ({
  MobileBar: mobileBarMock,
}));
vi.mock("../../../../kml_heatmap/frontend/ui/dataManager", () => ({
  DataManager: vi.fn(function () {
    return m.mockDataManagerInstance;
  }),
}));
vi.mock("../../../../kml_heatmap/frontend/ui/filterManager", () => ({
  FilterManager: vi.fn(function () {
    return m.mockFilterManagerInstance;
  }),
}));
vi.mock("../../../../kml_heatmap/frontend/ui/statsManager", () => ({
  StatsManager: vi.fn(function () {
    return m.mockStatsManagerInstance;
  }),
}));
vi.mock("../../../../kml_heatmap/frontend/ui/airportManager", () => ({
  AirportManager: vi.fn(function () {
    return m.mockAirportManagerInstance;
  }),
}));
vi.mock("../../../../kml_heatmap/frontend/ui/replayManager", () => ({
  ReplayManager: vi.fn(function () {
    return m.mockReplayManagerInstance;
  }),
}));
vi.mock("../../../../kml_heatmap/frontend/ui/layerManager", () => ({
  LayerManager: vi.fn(function () {
    return m.mockLayerManagerInstance;
  }),
}));
vi.mock("../../../../kml_heatmap/frontend/ui/stateManager", () => ({
  StateManager: vi.fn(function () {
    return m.mockStateManagerInstance;
  }),
}));
vi.mock("../../../../kml_heatmap/frontend/ui/wrappedManager", () => ({
  WrappedManager: vi.fn(function () {
    return m.mockWrappedManagerInstance;
  }),
}));
vi.mock("../../../../kml_heatmap/frontend/services/featureLoader", () => ({
  // Replay and Wrapped come from the lazily loaded feature bundle; here they
  // are the doubles the module mocks above return
  loadFeatures: vi.fn(() =>
    Promise.resolve({
      ReplayManager: vi.fn(function () {
        return m.mockReplayManagerInstance;
      }),
      WrappedManager: vi.fn(function () {
        return m.mockWrappedManagerInstance;
      }),
    }),
  ),
}));
vi.mock("../../../../kml_heatmap/frontend/ui/uiToggles", () => ({
  UIToggles: vi.fn(function () {
    return m.mockUITogglesInstance;
  }),
}));
vi.mock("../../../../kml_heatmap/frontend/ui/pathSelection", () => ({
  PathSelection: vi.fn(function () {
    return m.mockPathSelectionInstance;
  }),
}));

const {
  defaultAirports,
  defaultData,
  defaultMetadata,
  initializeApp,
  mockAirportManagerInstance,
  mockDataManagerInstance,
  mockFilterManagerInstance,
  mockLayerManagerInstance,
  mockReplayManagerInstance,
  mockStateManagerInstance,
  mockStatsManagerInstance,
  mockWrappedManagerInstance,
  resetManagerMocks,
  setupDOM,
  yearSelect,
} = m;

function createApp(): MapApp {
  return new MapApp({ ...m.APP_CONFIG });
}

/** The mock behind `app.map`, for what the real type does not have */
function mockMap(app: MapApp): MockMap {
  return app.map as unknown as MockMap;
}

function visibility(app: MapApp, id: string): unknown {
  return mockMap(app).layer(id).layout["visibility"];
}

describe("MapApp.initialize", () => {
  let app: MapApp;

  beforeEach(() => {
    resetManagerMocks();
    mobileBarMock.mountFor.mockReturnValue(null);
    setupDOM();
    app = createApp();
  });

  afterEach(() => {
    app.destroy();
    document.body.innerHTML = "";
    vi.useRealTimers();
    resetMapLibreMock();
  });

  describe("data loading", () => {
    it("loads airports, metadata and the selected year's data in order", async () => {
      await initializeApp(app);

      expect(mockDataManagerInstance.loadAirports).toHaveBeenCalledTimes(1);
      expect(mockDataManagerInstance.loadMetadata).toHaveBeenCalledTimes(1);
      expect(mockDataManagerInstance.loadData).toHaveBeenCalledWith("2025");
      expect(app.allAirportsData).toEqual(defaultAirports);
      expect(app.aircraftModels).toBe(defaultMetadata.aircraft_models);
      expect(app.hasTimingData).toBe(true);
      expect(app.currentData).toBe(defaultData);
      expect(app.fullPathInfo).toBe(defaultData.path_info);
      expect(app.fullPathSegments).toBe(defaultData.path_segments);
      expect(app.isInitializing).toBe(false);
    });

    it("leaves persistence to the store subscription and the map events", async () => {
      await initializeApp(app);

      // No direct save: the state manager subscribes to the store and the
      // map's moveend, so an extra call here would only be a second write
      expect(mockStateManagerInstance.saveMapState).not.toHaveBeenCalled();
    });

    it("keeps currentData null and continues when data fails to load", async () => {
      await initializeApp(app, defaultAirports, defaultMetadata, null);

      expect(app.currentData).toBeNull();
      expect(
        mockFilterManagerInstance.updateAircraftDropdown,
      ).toHaveBeenCalled();
      expect(mockDataManagerInstance.updateLayers).toHaveBeenCalled();
    });

    it("populates the aircraft dropdown before building layers", async () => {
      const order: string[] = [];
      mockFilterManagerInstance.updateAircraftDropdown.mockImplementation(() =>
        order.push("dropdown"),
      );
      mockDataManagerInstance.updateLayers.mockImplementation(() => {
        order.push("updateLayers");
        return Promise.resolve();
      });

      await initializeApp(app);

      expect(order).toEqual(["dropdown", "updateLayers"]);
      expect(
        mockAirportManagerInstance.updateAirportMarkerSizes,
      ).toHaveBeenCalled();
    });

    it("publishes the dataset through the store, where the managers listen", async () => {
      const fn = vi.fn();
      app.store.subscribe("currentData", fn);

      await initializeApp(app);

      expect(fn).toHaveBeenCalledWith(defaultData, null);
    });

    it("creates airport markers", async () => {
      await initializeApp(app);

      expect(Object.keys(app.airportMarkers)).toEqual([
        "Frankfurt EDDF",
        "Munich EDDM",
      ]);
      const markers = Object.values(app.airportMarkers).map(
        (entry) => entry.marker as unknown as MockMarker,
      );
      expect(markers).toHaveLength(2);
      for (const marker of markers) {
        expect(marker).toBeInstanceOf(MockMarker);
        expect(marker.addTo).toHaveBeenCalledWith(app.map);
      }
    });

    it("handles null metadata gracefully", async () => {
      await initializeApp(app, defaultAirports, null);

      expect(yearSelect().options).toHaveLength(1);
      expect(app.aircraftModels).toEqual({});
      expect(app.hasTimingData).toBe(false);
      expect(app.selectedYear).toBe("all");
      expect(mockDataManagerInstance.loadData).toHaveBeenCalledWith("all");
    });
  });

  describe("without a data index", () => {
    it("falls back to all years, says so and keeps the dropdown in step", async () => {
      mockStateManagerInstance.loadState.mockReturnValue({
        selectedYear: "2024",
      });

      await initializeApp(app, defaultAirports, null);

      // The dropdown had only "All years" to show while the map loaded 2024
      expect(app.selectedYear).toBe("all");
      expect(yearSelect().value).toBe("all");
      expect(toastMock.showToast).toHaveBeenCalledWith(
        "The list of years is unavailable, showing all years",
        "error",
      );
      expect(mockDataManagerInstance.loadData).toHaveBeenCalledWith("all");
    });
  });

  describe("year selection", () => {
    it("populates the year dropdown and defaults to the latest year", async () => {
      await initializeApp(app);

      expect([...yearSelect().options].map((o) => o.value)).toEqual([
        "all",
        "2024",
        "2025",
      ]);
      expect(yearSelect().options[2]!.textContent).toBe("2025");
      expect(app.selectedYear).toBe("2025");
      expect(yearSelect().value).toBe("2025");
      expect(toastMock.showToast).not.toHaveBeenCalled();
    });

    it("keeps a restored year and syncs the dropdown", async () => {
      mockStateManagerInstance.loadState.mockReturnValue({
        selectedYear: "2024",
      });

      await initializeApp(app);

      expect(app.selectedYear).toBe("2024");
      expect(yearSelect().value).toBe("2024");
      expect(app.restoredYearFromState).toBe(true);
    });

    it('keeps "all" when it was restored from state', async () => {
      mockStateManagerInstance.loadState.mockReturnValue({
        selectedYear: "all",
      });

      await initializeApp(app);

      expect(app.selectedYear).toBe("all");
      expect(yearSelect().value).toBe("all");
    });

    it("falls back to the latest year with a toast when the restored year is unavailable", async () => {
      mockStateManagerInstance.loadState.mockReturnValue({
        selectedYear: "2019",
      });

      await initializeApp(app);

      expect(app.selectedYear).toBe("2025");
      expect(yearSelect().value).toBe("2025");
      expect(toastMock.showToast).toHaveBeenCalledWith(
        "Year 2019 is not available, showing 2025",
        "info",
      );
      expect(mockDataManagerInstance.loadData).toHaveBeenCalledWith("2025");
    });

    it('falls back to "all" when no years are available', async () => {
      mockStateManagerInstance.loadState.mockReturnValue({
        selectedYear: "2019",
      });

      await initializeApp(app, defaultAirports, {
        ...defaultMetadata,
        available_years: [],
      });

      expect(app.selectedYear).toBe("all");
      expect(yearSelect().value).toBe("all");
      expect(toastMock.showToast).toHaveBeenCalledWith(
        "Year 2019 is not available, showing all years",
        "info",
      );
    });

    it("applies a year change made through the select during initialization", async () => {
      mockDataManagerInstance.updateLayers.mockImplementation(() => {
        // user picks another year while data is loading
        yearSelect().value = "2024";
        return Promise.resolve();
      });

      await initializeApp(app);

      expect(mockFilterManagerInstance.filterByYear).toHaveBeenCalledTimes(1);
      expect(mockFilterManagerInstance.filterByAircraft).not.toHaveBeenCalled();
    });

    it("applies an aircraft change made through the select during initialization", async () => {
      const aircraftSelect = document.getElementById(
        "aircraft-select",
      ) as HTMLSelectElement;
      const option = document.createElement("option");
      option.value = "D-ABCD";
      aircraftSelect.appendChild(option);
      mockDataManagerInstance.updateLayers.mockImplementation(() => {
        aircraftSelect.value = "D-ABCD";
        return Promise.resolve();
      });

      await initializeApp(app);

      expect(mockFilterManagerInstance.filterByAircraft).toHaveBeenCalledTimes(
        1,
      );
      expect(mockFilterManagerInstance.filterByYear).not.toHaveBeenCalled();
    });
  });

  describe("airspeed availability", () => {
    it("sets the airspeed range and legend when timing data is available", async () => {
      await initializeApp(app);

      expect(app.airspeedRange).toEqual({ min: 0, max: 150 });
      expect(
        mockLayerManagerInstance.updateAirspeedLegend,
      ).toHaveBeenCalledWith(0, 150);
      const btn = document.getElementById("airspeed-btn") as HTMLButtonElement;
      expect(btn.disabled).toBe(false);
      // The button state itself follows the store
      expect(btn.style.opacity).toBe("0.5");
      expect(btn.getAttribute("aria-pressed")).toBe("false");
    });

    it("disables the airspeed button without timing data", async () => {
      await initializeApp(app, defaultAirports, {
        ...defaultMetadata,
        max_groundspeed_knots: 0,
      });

      const btn = document.getElementById("airspeed-btn") as HTMLButtonElement;
      expect(btn.disabled).toBe(true);
      expect(
        mockLayerManagerInstance.updateAirspeedLegend,
      ).not.toHaveBeenCalled();
    });

    it("releases a restored speed layer without timing data (regression)", async () => {
      mockStateManagerInstance.loadState.mockReturnValue({
        airspeedVisible: true,
      });

      await initializeApp(app, defaultAirports, {
        ...defaultMetadata,
        max_groundspeed_knots: 0,
      });

      // The button is disabled, so a pressed state could never have been
      // released, and the empty layer showed a legend with placeholders
      expect(app.airspeedVisible).toBe(false);
      expect(app.airspeedLayer.isVisible()).toBe(false);
      expect(visibility(app, "paths-airspeed")).toBe("none");
      const btn = document.getElementById("airspeed-btn") as HTMLButtonElement;
      expect(btn.disabled).toBe(true);
      expect(btn.getAttribute("aria-pressed")).toBe("false");
      expect(document.getElementById("airspeed-legend")!.hidden).toBe(true);
    });

    it("keeps the airspeed button lit when airspeed is visible", async () => {
      mockStateManagerInstance.loadState.mockReturnValue({
        airspeedVisible: true,
      });

      await initializeApp(app);

      const btn = document.getElementById("airspeed-btn") as HTMLButtonElement;
      expect(btn.style.opacity).toBe("1");
      expect(btn.getAttribute("aria-pressed")).toBe("true");
    });
  });

  describe("restored layer state", () => {
    it("adds the altitude layer and shows its legend", async () => {
      mockStateManagerInstance.loadState.mockReturnValue({
        altitudeVisible: true,
      });

      await initializeApp(app);

      expect(app.altitudeVisible).toBe(true);
      expect(app.altitudeLayer.isVisible()).toBe(true);
      expect(visibility(app, "paths-altitude")).toBe("visible");
      expect(visibility(app, "paths-altitude-selected")).toBe("visible");
      expect(visibility(app, "paths-airspeed")).toBe("none");
      expect(document.getElementById("altitude-legend")!.hidden).toBe(false);
      expect(document.getElementById("airspeed-legend")!.hidden).toBe(true);
    });

    it("steps the heatmap back for a restored colour layer", async () => {
      // Nothing toggled anything here: the emphasis follows the store keys,
      // not the control that usually writes them
      mockStateManagerInstance.loadState.mockReturnValue({
        altitudeVisible: true,
      });

      await initializeApp(app);

      expect(mockDataManagerInstance.applyHeatmapEmphasis).toHaveBeenCalled();
    });

    it("steps it back again when a colour layer is switched off", async () => {
      await initializeApp(app);
      mockDataManagerInstance.applyHeatmapEmphasis.mockClear();

      app.altitudeVisible = true;
      app.altitudeVisible = false;

      expect(
        mockDataManagerInstance.applyHeatmapEmphasis,
      ).toHaveBeenCalledTimes(2);
    });

    it("adds the airspeed layer and shows its legend", async () => {
      mockStateManagerInstance.loadState.mockReturnValue({
        airspeedVisible: true,
      });

      await initializeApp(app);

      expect(visibility(app, "paths-airspeed")).toBe("visible");
      expect(visibility(app, "paths-airspeed-selected")).toBe("visible");
      expect(document.getElementById("airspeed-legend")!.hidden).toBe(false);
    });

    it("keeps the legends in step with the store after initialization", async () => {
      await initializeApp(app);
      const legend = document.getElementById("altitude-legend")!;
      expect(legend.hidden).toBe(true);

      app.altitudeVisible = true;
      expect(legend.hidden).toBe(false);

      app.altitudeVisible = false;
      expect(legend.hidden).toBe(true);
    });

    it("shows the aviation layer when visible", async () => {
      mockStateManagerInstance.loadState.mockReturnValue({
        aviationVisible: true,
      });

      await initializeApp(app);

      expect(visibility(app, "aviation")).toBe("visible");
    });

    it("creates the aviation layer hidden otherwise", async () => {
      await initializeApp(app);

      expect(app.aviationLayer.isVisible()).toBe(false);
      expect(visibility(app, "aviation")).toBe("none");
    });

    it("hides the airport markers when airports are not visible", async () => {
      mockStateManagerInstance.loadState.mockReturnValue({
        airportsVisible: false,
      });

      await initializeApp(app);

      expect(app.airportLayer.isVisible()).toBe(false);
      expect(
        mockMap(app).getContainer().classList.contains("airports-hidden"),
      ).toBe(true);
    });

    it("shows the airport markers by default", async () => {
      await initializeApp(app);

      expect(
        mockMap(app).getContainer().classList.contains("airports-hidden"),
      ).toBe(false);
    });

    it("restores selected paths and isolate mode into the store", async () => {
      mockStateManagerInstance.loadState.mockReturnValue({
        selectedPathIds: [1, 2],
        isolateSelection: true,
      });

      await initializeApp(app, defaultAirports, defaultMetadata, {
        ...defaultData,
        path_info: [...defaultData.path_info, { id: 2, year: 2025 }],
      });

      expect([...app.selectedPathIds]).toEqual([1, 2]);
      expect(app.isolateSelection).toBe(true);
      // The replay button follows the store inside the replay manager
      expect(
        mockReplayManagerInstance.updateReplayButtonState,
      ).not.toHaveBeenCalled();
    });

    it("drops restored paths the loaded data does not have", async () => {
      // Ids are content hashes: a link can outlive the flight it names
      mockStateManagerInstance.loadState.mockReturnValue({
        selectedPathIds: [1, 840108108563],
        isolateSelection: true,
      });

      await initializeApp(app);

      expect([...app.selectedPathIds]).toEqual([1]);
      expect(app.isolateSelection).toBe(true);
    });

    it("drops the isolate flag with the last restored path that is gone", async () => {
      mockStateManagerInstance.loadState.mockReturnValue({
        selectedPathIds: [840108108563],
        isolateSelection: true,
      });

      await initializeApp(app);

      expect(app.selectedPathIds.size).toBe(0);
      expect(app.isolateSelection).toBe(false);
    });

    it("drops a restored isolate flag without a selection (regression)", async () => {
      // A link written before path ids were versioned loses its paths but
      // still carries the isolate flag
      mockStateManagerInstance.loadState.mockReturnValue({
        isolateSelection: true,
      });

      await initializeApp(app);

      expect(app.isolateSelection).toBe(false);
    });

    it("restores the stats panel through the stats manager", async () => {
      mockStateManagerInstance.loadState.mockReturnValue({
        statsPanelVisible: true,
      });

      await initializeApp(app);

      expect(
        mockStatsManagerInstance.setStatsPanelVisible,
      ).toHaveBeenCalledWith(true);
    });

    it("leaves the stats panel closed when not saved", async () => {
      await initializeApp(app);

      expect(
        mockStatsManagerInstance.setStatsPanelVisible,
      ).not.toHaveBeenCalled();
    });

    it("reopens the wrapped modal after a delay when it was open", async () => {
      vi.useFakeTimers();
      mockStateManagerInstance.loadState.mockReturnValue({
        wrappedVisible: true,
      });

      await initializeApp(app);

      expect(mockWrappedManagerInstance.showWrapped).not.toHaveBeenCalled();
      // The timer fetches the feature bundle first, so let the promise settle
      await vi.advanceTimersByTimeAsync(500);
      expect(mockWrappedManagerInstance.showWrapped).toHaveBeenCalledTimes(1);
      // From then on the saves write what the store says
      expect(app.savedState).not.toHaveProperty("wrappedVisible");
    });

    it("does not reopen the wrapped modal once the app is destroyed", async () => {
      vi.useFakeTimers();
      mockStateManagerInstance.loadState.mockReturnValue({
        wrappedVisible: true,
      });

      await initializeApp(app);
      app.destroy();
      await vi.advanceTimersByTimeAsync(500);

      expect(mockWrappedManagerInstance.showWrapped).not.toHaveBeenCalled();
      // Neither feature was ever opened, so neither manager exists; destroy
      // has to cope with that rather than reach through an undefined
      expect(mockReplayManagerInstance.destroy).not.toHaveBeenCalled();
      expect(mockWrappedManagerInstance.destroy).not.toHaveBeenCalled();
    });

    it("restores the map view from saved center and zoom", async () => {
      mockStateManagerInstance.loadState.mockReturnValue({
        center: { lat: 50.5, lng: 8.5 },
        zoom: 12,
      });

      await initializeApp(app);

      // Longitude first, and one level below the zoom the state carries
      expect(mockMap(app).options).toMatchObject({
        center: [8.5, 50.5],
        zoom: 11,
      });
      expect(mockMap(app).options).not.toHaveProperty("bounds");
    });

    it("treats a saved zoom of 0 as a view, not as a missing one", async () => {
      mockStateManagerInstance.loadState.mockReturnValue({
        center: { lat: 50.5, lng: 8.5 },
        zoom: 0,
      });

      await initializeApp(app);

      // State zoom 0 is below what the map can show, so it opens as far
      // out as the map goes rather than at the default zoom
      expect(mockMap(app).options).toMatchObject({
        center: [8.5, 50.5],
        zoom: 0,
      });
      expect(mockMap(app).options).not.toHaveProperty("bounds");
    });

    it("centres a link that carries no zoom at the default zoom", async () => {
      // A hand-written or cut-short link: lat and lng, no z
      mockStateManagerInstance.loadState.mockReturnValue({
        center: { lat: 50.5, lng: 8.5 },
      });

      await initializeApp(app);

      expect(mockMap(app).options).toMatchObject({
        center: [8.5, 50.5],
        zoom: 9,
      });
      expect(mockMap(app).options).not.toHaveProperty("bounds");
    });

    it("fits the configured bounds without a saved view", async () => {
      await initializeApp(app);

      expect(mockMap(app).options).toMatchObject({
        bounds: [
          [8, 50],
          [10, 52],
        ],
        fitBoundsOptions: { padding: 30 },
      });
      expect(mockMap(app).options).not.toHaveProperty("center");
      expect(mockMap(app).options).not.toHaveProperty("zoom");
    });
  });
});
