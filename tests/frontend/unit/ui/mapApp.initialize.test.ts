import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import * as L from "leaflet";
import { MapApp } from "../../../../kml_heatmap/frontend/mapApp";
import { invalidateMapAfterTransition } from "../../../../kml_heatmap/frontend/utils/mapHelpers";
import type {
  Airport,
  KMLDataset,
  Metadata,
  SavedState,
} from "../../../../kml_heatmap/frontend/types";

// Mock logger
vi.mock("../../../../kml_heatmap/frontend/utils/logger", () => ({
  logError: vi.fn(),
  logDebug: vi.fn(),
  initLogger: vi.fn(),
}));

// Mock domCache
vi.mock("../../../../kml_heatmap/frontend/utils/domCache", () => ({
  domCache: {
    cacheElements: vi.fn(),
    get: vi.fn((id: string) => document.getElementById(id)),
    clear: vi.fn(),
  },
}));

// Mock mapHelpers
vi.mock("../../../../kml_heatmap/frontend/utils/mapHelpers", () => ({
  invalidateMapAfterTransition: vi.fn(),
}));

const toastMock = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock("../../../../kml_heatmap/frontend/utils/toast", () => toastMock);

// ---- Manager mocks ----
const mockDataManagerInstance = {
  loadAirports: vi.fn(),
  loadMetadata: vi.fn(),
  loadData: vi.fn(),
  updateLayers: vi.fn(),
  showLoading: vi.fn(),
  hideLoading: vi.fn(),
};

vi.mock("../../../../kml_heatmap/frontend/ui/dataManager", () => ({
  DataManager: vi.fn(function () {
    return mockDataManagerInstance;
  }),
}));

const mockFilterManagerInstance = {
  updateAircraftDropdown: vi.fn(),
  filterByYear: vi.fn(),
  filterByAircraft: vi.fn(),
};

vi.mock("../../../../kml_heatmap/frontend/ui/filterManager", () => ({
  FilterManager: vi.fn(function () {
    return mockFilterManagerInstance;
  }),
}));

const mockStatsManagerInstance = {
  updateStatsPanel: vi.fn(),
  toggleStats: vi.fn(),
  updateStatsForSelection: vi.fn(),
  setStatsPanelVisible: vi.fn(),
};

vi.mock("../../../../kml_heatmap/frontend/ui/statsManager", () => ({
  StatsManager: vi.fn(function () {
    return mockStatsManagerInstance;
  }),
}));

const mockAirportManagerInstance = {
  updateAirportPopups: vi.fn(),
  updateAirportOpacity: vi.fn(),
  updateAirportMarkerSizes: vi.fn(),
  calculateAirportFlightCounts: vi.fn(),
};

vi.mock("../../../../kml_heatmap/frontend/ui/airportManager", () => ({
  AirportManager: vi.fn(function () {
    return mockAirportManagerInstance;
  }),
}));

const mockReplayManagerInstance = {
  state: {
    active: false,
    airplaneMarker: null as null | {
      isPopupOpen: () => boolean;
      closePopup: ReturnType<typeof vi.fn>;
    },
  },
  updateReplayButtonState: vi.fn(),
  toggleReplay: vi.fn(),
  playReplay: vi.fn(),
  pauseReplay: vi.fn(),
  stopReplay: vi.fn(),
  seekReplay: vi.fn(),
  changeReplaySpeed: vi.fn(),
  toggleAutoZoom: vi.fn(),
};

vi.mock("../../../../kml_heatmap/frontend/ui/replayManager", () => ({
  ReplayManager: vi.fn(function () {
    return mockReplayManagerInstance;
  }),
}));

const mockLayerManagerInstance = {
  updateAirspeedLegend: vi.fn(),
  redrawAltitudePaths: vi.fn(),
  redrawAirspeedPaths: vi.fn(),
  clearLayer: vi.fn(),
  getPathInfoMap: vi.fn(() => new Map()),
};

vi.mock("../../../../kml_heatmap/frontend/ui/layerManager", () => ({
  LayerManager: vi.fn(function () {
    return mockLayerManagerInstance;
  }),
}));

const mockStateManagerInstance = {
  loadState: vi.fn((): SavedState | null => null),
  saveMapState: vi.fn(),
  scheduleSave: vi.fn(),
};

vi.mock("../../../../kml_heatmap/frontend/ui/stateManager", () => ({
  StateManager: vi.fn(function () {
    return mockStateManagerInstance;
  }),
}));

const mockWrappedManagerInstance = {
  showWrapped: vi.fn(),
  closeWrapped: vi.fn(),
};

vi.mock("../../../../kml_heatmap/frontend/ui/wrappedManager", () => ({
  WrappedManager: vi.fn(function () {
    return mockWrappedManagerInstance;
  }),
}));

const mockUITogglesInstance = {
  toggleHeatmap: vi.fn(),
  toggleAltitude: vi.fn(),
  toggleAirspeed: vi.fn(),
  toggleAirports: vi.fn(),
  toggleAviation: vi.fn(),
  exportMap: vi.fn(),
};

vi.mock("../../../../kml_heatmap/frontend/ui/uiToggles", () => ({
  UIToggles: vi.fn(function () {
    return mockUITogglesInstance;
  }),
}));

const mockPathSelectionInstance = {
  updateIsolateButton: vi.fn(),
  clearSelection: vi.fn(),
  selectPathsByAirport: vi.fn(),
  togglePathSelection: vi.fn(),
  toggleIsolateSelection: vi.fn(),
};

vi.mock("../../../../kml_heatmap/frontend/ui/pathSelection", () => ({
  PathSelection: vi.fn(function () {
    return mockPathSelectionInstance;
  }),
}));

// The real bar registers a window resize listener it never removes, so every
// test would leak one along with the MapApp it pins
const mobileBarMock = vi.hoisted(() => ({ mountFor: vi.fn() }));

vi.mock("../../../../kml_heatmap/frontend/ui/mobileBar", () => ({
  MobileBar: mobileBarMock,
}));

// ---- Setup helpers ----

function setupDOM(): void {
  document.body.innerHTML = `
    <div id="map"></div>
    <select id="year-select">
      <option value="all">All Years</option>
    </select>
    <select id="aircraft-select">
      <option value="all">All Aircraft</option>
    </select>
    <div id="left-buttons" class="control-column">
      <div class="control-row">
        <button id="stats-btn" data-icon="stats">
          <span class="control-label">Statistics</span>
        </button>
      </div>
      <div class="control-row">
        <button id="isolate-btn" data-icon="isolate">
          <span class="control-label">Isolate</span>
        </button>
      </div>
    </div>
    <button id="heatmap-btn"></button>
    <button id="altitude-btn"></button>
    <button id="airspeed-btn"></button>
    <button id="airports-btn"></button>
    <div class="control-row initially-hidden">
      <button id="aviation-btn" class="initially-hidden"></button>
    </div>
    <div id="altitude-legend" style="display:none"></div>
    <div id="airspeed-legend" style="display:none"></div>
    <div id="stats-rail" hidden>
      <div id="stats-rail-header">
        <button
          id="stats-collapse-btn"
          data-icon="collapse"
          data-icon-size="20"
          aria-expanded="false"
        ></button>
      </div>
      <div id="stats-panel" tabindex="0"></div>
    </div>
    <div id="loading" style="display:none"></div>
  `;
}

function createApp(openaipApiKey?: string): MapApp {
  return new MapApp({
    center: [51, 9],
    bounds: [
      [50, 8],
      [52, 10],
    ],
    dataDir: "/data",
    openaipApiKey,
  });
}

const defaultAirports: Airport[] = [
  { name: "Frankfurt EDDF", lat: 50.1, lon: 8.67, flight_count: 20 },
  { name: "Munich EDDM", lat: 48.35, lon: 11.78, flight_count: 10 },
];

const defaultMetadata: Metadata = {
  available_years: [2024, 2025],
  year_file_bytes: { "2024": 10, "2025": 20 },
  stats: {
    total_points: 10000,
    num_paths: 100,
    num_airports: 5,
    airport_names: [],
    num_aircraft: 3,
    aircraft_list: [],
    total_distance_km: 5000,
    total_distance_nm: 2700,
    max_groundspeed_knots: 150,
  },
  min_alt_m: 0,
  max_alt_m: 3000,
  min_groundspeed_knots: 0,
  max_groundspeed_knots: 150,
};

const defaultData: KMLDataset = {
  coordinates: [[50, 8]],
  path_segments: [{ path_id: 1, altitude_ft: 5000 }],
  path_info: [
    {
      id: 1,
      year: 2025,
      aircraft_registration: "D-ABCD",
      start_airport: "EDDF",
      end_airport: "EDDM",
    },
  ],
  original_points: 1000,
};

async function initializeApp(
  app: MapApp,
  airports = defaultAirports,
  metadata: Metadata | null = defaultMetadata,
  data: KMLDataset | null = defaultData,
): Promise<void> {
  mockDataManagerInstance.loadAirports.mockResolvedValue(airports);
  mockDataManagerInstance.loadMetadata.mockResolvedValue(metadata);
  mockDataManagerInstance.loadData.mockResolvedValue(data);
  // Keep implementations that a test installed before initializing
  for (const fn of [
    mockDataManagerInstance.updateLayers,
    mockFilterManagerInstance.filterByYear,
    mockFilterManagerInstance.filterByAircraft,
  ]) {
    if (!fn.getMockImplementation()) fn.mockResolvedValue(undefined);
  }

  await app.initialize();
}

function yearSelect(): HTMLSelectElement {
  return document.getElementById("year-select") as HTMLSelectElement;
}

describe("MapApp.initialize", () => {
  let app: MapApp;

  beforeEach(() => {
    // Reset implementations too, so per-test mockImplementation() calls do
    // not leak into the next test
    vi.resetAllMocks();
    mobileBarMock.mountFor.mockReturnValue(null);
    mockStateManagerInstance.loadState.mockReturnValue(null);
    mockReplayManagerInstance.state.active = false;
    mockReplayManagerInstance.state.airplaneMarker = null;
    setupDOM();
    app = createApp();
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  describe("data loading", () => {
    it("loads airports, metadata and the selected year's data in order", async () => {
      await initializeApp(app);

      expect(mockDataManagerInstance.loadAirports).toHaveBeenCalledTimes(1);
      expect(mockDataManagerInstance.loadMetadata).toHaveBeenCalledTimes(1);
      expect(mockDataManagerInstance.loadData).toHaveBeenCalledWith("2025");
      expect(app.allAirportsData).toEqual(defaultAirports);
      expect(app.fullStats).toEqual(defaultMetadata.stats);
      expect(app.currentData).toBe(defaultData);
      expect(app.fullPathInfo).toBe(defaultData.path_info);
      expect(app.fullPathSegments).toBe(defaultData.path_segments);
      expect(app.isInitializing).toBe(false);
      expect(mockStateManagerInstance.saveMapState).toHaveBeenCalled();
    });

    it("keeps currentData null and continues when data fails to load", async () => {
      await initializeApp(app, defaultAirports, defaultMetadata, null);

      expect(app.currentData).toBeNull();
      expect(
        mockFilterManagerInstance.updateAircraftDropdown,
      ).toHaveBeenCalled();
      expect(mockDataManagerInstance.updateLayers).toHaveBeenCalled();
    });

    it("populates the aircraft dropdown and airport popups before building layers", async () => {
      const order: string[] = [];
      mockFilterManagerInstance.updateAircraftDropdown.mockImplementation(() =>
        order.push("dropdown"),
      );
      mockAirportManagerInstance.updateAirportPopups.mockImplementation(() =>
        order.push("popups"),
      );
      mockDataManagerInstance.updateLayers.mockImplementation(() => {
        order.push("updateLayers");
        return Promise.resolve();
      });

      await initializeApp(app);

      expect(order).toEqual(["dropdown", "popups", "updateLayers"]);
      expect(
        mockAirportManagerInstance.updateAirportMarkerSizes,
      ).toHaveBeenCalled();
    });

    it("creates airport markers", async () => {
      await initializeApp(app);

      expect(Object.keys(app.airportMarkers)).toEqual([
        "Frankfurt EDDF",
        "Munich EDDM",
      ]);
      expect(L.marker).toHaveBeenCalledTimes(2);
    });

    it("handles null metadata gracefully", async () => {
      await initializeApp(app, defaultAirports, null);

      expect(yearSelect().options).toHaveLength(1);
      expect(app.fullStats).toBeNull();
      expect(app.selectedYear).toBe("all");
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
      expect(btn.style.opacity).toBe("0.5");
    });

    it("disables the airspeed button without timing data", async () => {
      await initializeApp(app, defaultAirports, {
        ...defaultMetadata,
        max_groundspeed_knots: 0,
      });

      const btn = document.getElementById("airspeed-btn") as HTMLButtonElement;
      expect(btn.disabled).toBe(true);
      expect(btn.style.opacity).toBe("0.3");
      expect(
        mockLayerManagerInstance.updateAirspeedLegend,
      ).not.toHaveBeenCalled();
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
      expect(app.map!.addLayer).toHaveBeenCalledWith(app.altitudeLayer);
      expect(document.getElementById("altitude-legend")!.style.display).toBe(
        "block",
      );
      expect(document.getElementById("airspeed-legend")!.style.display).toBe(
        "none",
      );
    });

    it("adds the airspeed layer and shows its legend", async () => {
      mockStateManagerInstance.loadState.mockReturnValue({
        airspeedVisible: true,
      });

      await initializeApp(app);

      expect(app.map!.addLayer).toHaveBeenCalledWith(app.airspeedLayer);
      expect(document.getElementById("airspeed-legend")!.style.display).toBe(
        "block",
      );
    });

    it("adds the aviation layer when visible and an API key is configured", async () => {
      mockStateManagerInstance.loadState.mockReturnValue({
        aviationVisible: true,
      });
      const appWithKey = createApp("test-key");

      await initializeApp(appWithKey);

      expect(appWithKey.openaipLayers["Aviation Data"]).toBeDefined();
      expect(appWithKey.map!.addLayer).toHaveBeenCalledWith(
        appWithKey.openaipLayers["Aviation Data"],
      );
      // Both the button and its row leave the initially hidden state
      expect(
        document
          .getElementById("aviation-btn")!
          .classList.contains("initially-hidden"),
      ).toBe(false);
      expect(
        document
          .getElementById("aviation-btn")!
          .closest(".control-row")!
          .classList.contains("initially-hidden"),
      ).toBe(false);
    });

    it("does not create the aviation layer without an API key", async () => {
      mockStateManagerInstance.loadState.mockReturnValue({
        aviationVisible: true,
      });

      await initializeApp(app);

      expect(app.openaipLayers["Aviation Data"]).toBeUndefined();
      expect(
        document
          .getElementById("aviation-btn")!
          .classList.contains("initially-hidden"),
      ).toBe(true);
    });

    it("hides the airport layer when airports are not visible", async () => {
      mockStateManagerInstance.loadState.mockReturnValue({
        airportsVisible: false,
      });

      await initializeApp(app);

      expect(app.airportLayer.addTo).not.toHaveBeenCalled();
    });

    it("restores selected paths and updates the replay button", async () => {
      mockStateManagerInstance.loadState.mockReturnValue({
        selectedPathIds: [1, 2],
        isolateSelection: true,
      });

      await initializeApp(app);

      expect([...app.selectedPathIds]).toEqual([1, 2]);
      expect(app.isolateSelection).toBe(true);
      expect(
        mockReplayManagerInstance.updateReplayButtonState,
      ).toHaveBeenCalled();
    });

    it("does not update the replay button without restored paths", async () => {
      await initializeApp(app);

      expect(
        mockReplayManagerInstance.updateReplayButtonState,
      ).not.toHaveBeenCalled();
    });

    it("restores the stats panel through the stats manager without saving", async () => {
      mockStateManagerInstance.loadState.mockReturnValue({
        statsPanelVisible: true,
      });

      await initializeApp(app);

      expect(
        mockStatsManagerInstance.setStatsPanelVisible,
      ).toHaveBeenCalledWith(true, false);
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
      vi.advanceTimersByTime(500);
      expect(mockWrappedManagerInstance.showWrapped).toHaveBeenCalledTimes(1);
    });

    it("restores the map view from saved center and zoom", async () => {
      mockStateManagerInstance.loadState.mockReturnValue({
        center: { lat: 50.5, lng: 8.5 },
        zoom: 12,
      });

      await initializeApp(app);

      expect(app.map!.setView).toHaveBeenCalledWith([50.5, 8.5], 12);
      expect(app.map!.fitBounds).not.toHaveBeenCalled();
    });

    it("fits the configured bounds without a saved view", async () => {
      await initializeApp(app);

      expect(app.map!.fitBounds).toHaveBeenCalledWith(app.config.bounds, {
        padding: [30, 30],
      });
    });
  });

  describe("store-driven buttons", () => {
    it("reflects the restored visibility state in the toggle buttons", async () => {
      mockStateManagerInstance.loadState.mockReturnValue({
        heatmapVisible: false,
        altitudeVisible: true,
        airportsVisible: false,
        aviationVisible: true,
        isolateSelection: true,
      });

      await initializeApp(app);

      const state = (id: string): [string | null, boolean, string] => {
        const el = document.getElementById(id)!;
        return [
          el.getAttribute("aria-pressed"),
          el.classList.contains("active"),
          el.style.opacity,
        ];
      };
      expect(state("heatmap-btn")).toEqual(["false", false, "0.5"]);
      expect(state("altitude-btn")).toEqual(["true", true, "1"]);
      expect(state("airports-btn")).toEqual(["false", false, "0.5"]);
      expect(state("aviation-btn")).toEqual(["true", true, "1"]);
      expect(state("isolate-btn")).toEqual(["true", true, "1"]);
    });

    it("updates buttons when the store changes after initialization", async () => {
      await initializeApp(app);

      app.heatmapVisible = false;
      app.altitudeVisible = true;

      expect(
        document.getElementById("heatmap-btn")!.getAttribute("aria-pressed"),
      ).toBe("false");
      expect(
        document.getElementById("altitude-btn")!.getAttribute("aria-pressed"),
      ).toBe("true");
    });

    it("refreshes the isolate button when the selection changes", async () => {
      await initializeApp(app);
      mockPathSelectionInstance.updateIsolateButton.mockClear();

      app.selectedPathIds.add(5);
      app.store.notifyMutation("selectedPathIds");

      expect(
        mockPathSelectionInstance.updateIsolateButton,
      ).toHaveBeenCalledTimes(1);
    });
  });

  describe("statistics rail", () => {
    it("stays closed while the statistics are hidden", async () => {
      await initializeApp(app);

      expect(document.getElementById("stats-rail")!.hidden).toBe(true);
      expect(document.body.classList.contains("stats-open")).toBe(false);
    });

    it("opens the rail and remeasures the map", async () => {
      await initializeApp(app);
      vi.mocked(invalidateMapAfterTransition).mockClear();

      const column = document.getElementById("left-buttons")!;
      // The column's own layout and its labels, not the per-button state
      // that the Statistics trigger legitimately gains when the rail opens
      const shape = () => ({
        className: column.className,
        labels: [...column.querySelectorAll(".control-label")].map(
          (el) => el.textContent,
        ),
        iconWidths: [...column.querySelectorAll("svg.icon")].map((el) =>
          el.getAttribute("width"),
        ),
      });
      const before = shape();

      app.store.set("statsPanelVisible", true);

      expect(document.getElementById("stats-rail")!.hidden).toBe(false);
      expect(document.body.classList.contains("stats-open")).toBe(true);
      expect(invalidateMapAfterTransition).toHaveBeenCalledWith(
        app.map,
        document.getElementById("map"),
      );
      // The column is left alone; the stylesheet slides it past the rail
      expect(shape()).toEqual(before);

      app.store.set("statsPanelVisible", false);

      expect(document.getElementById("stats-rail")!.hidden).toBe(true);
      expect(document.body.classList.contains("stats-open")).toBe(false);
      expect(shape()).toEqual(before);
    });

    it("marks both triggers expanded and accents the statistics row", async () => {
      await initializeApp(app);
      const statsBtn = document.getElementById("stats-btn")!;
      const collapseBtn = document.getElementById("stats-collapse-btn")!;

      expect(statsBtn.getAttribute("aria-expanded")).toBe("false");
      expect(statsBtn.classList.contains("active")).toBe(false);

      app.store.set("statsPanelVisible", true);

      expect(statsBtn.getAttribute("aria-expanded")).toBe("true");
      expect(collapseBtn.getAttribute("aria-expanded")).toBe("true");
      expect(statsBtn.classList.contains("active")).toBe(true);

      app.store.set("statsPanelVisible", false);

      expect(statsBtn.getAttribute("aria-expanded")).toBe("false");
      expect(collapseBtn.getAttribute("aria-expanded")).toBe("false");
      expect(statsBtn.classList.contains("active")).toBe(false);
    });

    it("hands focus back to the trigger when the collapse button hides", async () => {
      await initializeApp(app);
      app.store.set("statsPanelVisible", true);
      document.getElementById("stats-collapse-btn")!.focus();

      app.store.set("statsPanelVisible", false);

      expect(document.activeElement).toBe(document.getElementById("stats-btn"));
    });

    it("hands focus back from the panel too", async () => {
      await initializeApp(app);
      app.store.set("statsPanelVisible", true);
      document.getElementById("stats-panel")!.focus();

      app.store.set("statsPanelVisible", false);

      expect(document.activeElement).toBe(document.getElementById("stats-btn"));
    });

    it("leaves focus alone when it is outside the rail", async () => {
      await initializeApp(app);
      app.store.set("statsPanelVisible", true);
      const heatmapBtn = document.getElementById("heatmap-btn")!;
      heatmapBtn.focus();

      app.store.set("statsPanelVisible", false);

      expect(document.activeElement).toBe(heatmapBtn);
    });

    it("restores an open rail from the saved state", async () => {
      mockStatsManagerInstance.setStatsPanelVisible.mockImplementation(
        (visible: boolean) => app.store.set("statsPanelVisible", visible),
      );
      mockStateManagerInstance.loadState.mockReturnValue({
        statsPanelVisible: true,
      });

      await initializeApp(app);

      expect(document.getElementById("stats-rail")!.hidden).toBe(false);
      expect(document.body.classList.contains("stats-open")).toBe(true);
      mockStatsManagerInstance.setStatsPanelVisible.mockReset();
    });
  });

  describe("map event handlers", () => {
    function handler(event: string): (e?: unknown) => void {
      const on = vi.mocked(app.map!.on) as unknown as {
        mock: { calls: unknown[][] };
      };
      const call = on.mock.calls.find((c) => c[0] === event);
      return call![1] as (e?: unknown) => void;
    }

    it("schedules a state save on move and zoom", async () => {
      await initializeApp(app);

      handler("moveend")();
      handler("zoomend")();

      expect(mockStateManagerInstance.scheduleSave).toHaveBeenCalledTimes(2);
      expect(
        mockAirportManagerInstance.updateAirportMarkerSizes,
      ).toHaveBeenCalledTimes(2);
    });

    it("clears the selection on map click outside replay", async () => {
      await initializeApp(app);
      app.selectedPathIds.add(1);

      handler("click")({});

      expect(mockPathSelectionInstance.clearSelection).toHaveBeenCalledTimes(1);
    });

    it("does not clear an empty selection", async () => {
      await initializeApp(app);

      handler("click")({});

      expect(mockPathSelectionInstance.clearSelection).not.toHaveBeenCalled();
    });

    it("closes the airplane popup during replay instead of clearing", async () => {
      await initializeApp(app);
      app.selectedPathIds.add(1);
      const closePopup = vi.fn();
      mockReplayManagerInstance.state.active = true;
      mockReplayManagerInstance.state.airplaneMarker = {
        isPopupOpen: () => true,
        closePopup,
      };

      handler("click")({});

      expect(closePopup).toHaveBeenCalledTimes(1);
      expect(mockPathSelectionInstance.clearSelection).not.toHaveBeenCalled();
    });
  });

  describe("map setup", () => {
    it("creates the map with the shared zoom limit and tile layers", async () => {
      const appWithKey = createApp("key");
      await initializeApp(appWithKey);

      expect(L.map).toHaveBeenCalledWith(
        "map",
        expect.objectContaining({
          maxZoom: 20,
          preferCanvas: true,
          // Pinch, scroll and double tap cover zooming
          zoomControl: false,
        }),
      );
      expect(L.tileLayer).toHaveBeenCalledWith(
        expect.stringContaining("basemaps.cartocdn.com"),
        expect.objectContaining({ maxZoom: 20 }),
      );
      expect(L.tileLayer).toHaveBeenCalledWith(
        expect.stringContaining("openaip.net"),
        expect.objectContaining({ maxZoom: 20, maxNativeZoom: 18 }),
      );
    });

    it("appends the CARTO API key to the tile URL when configured", async () => {
      const appWithCarto = new MapApp({
        center: [51, 9],
        bounds: [
          [50, 8],
          [52, 10],
        ],
        dataDir: "/data",
        cartoApiKey: "carto-key",
      });

      await initializeApp(appWithCarto);

      expect(L.tileLayer).toHaveBeenCalledWith(
        expect.stringContaining("?key=carto-key"),
        expect.anything(),
      );
    });
  });
});
