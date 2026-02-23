import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { MapApp } from "../../../../kml_heatmap/frontend/mapApp";
import type {
  Airport,
  FilteredStatistics,
} from "../../../../kml_heatmap/frontend/types";

// Mock logger
vi.mock("../../../../kml_heatmap/frontend/utils/logger", () => ({
  logError: vi.fn(),
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  initLogger: vi.fn(),
  isDebugEnabled: vi.fn(() => false),
}));

// Mock domCache
vi.mock("../../../../kml_heatmap/frontend/utils/domCache", () => ({
  domCache: {
    cacheElements: vi.fn(),
    get: vi.fn((id: string) => document.getElementById(id)),
    clear: vi.fn(),
  },
}));

// Mock DOMPurify
vi.mock("dompurify", () => ({
  default: {
    sanitize: (html: string) => html,
  },
}));

// Mock mapHelpers
vi.mock("../../../../kml_heatmap/frontend/utils/mapHelpers", () => ({
  invalidateMapWithDelay: vi.fn(),
}));

// ---- Manager mocks ----
const mockDataManagerInstance = {
  loadAirports: vi.fn(),
  loadMetadata: vi.fn(),
  loadData: vi.fn(),
  updateLayers: vi.fn(),
  loadedData: {},
  currentData: null,
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
  replayActive: false,
  updateReplayButtonState: vi.fn(),
  toggleReplay: vi.fn(),
  playReplay: vi.fn(),
  pauseReplay: vi.fn(),
  stopReplay: vi.fn(),
  seekReplay: vi.fn(),
  changeReplaySpeed: vi.fn(),
  toggleAutoZoom: vi.fn(),
  replayAirplaneMarker: null,
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
};

vi.mock("../../../../kml_heatmap/frontend/ui/layerManager", () => ({
  LayerManager: vi.fn(function () {
    return mockLayerManagerInstance;
  }),
}));

const mockStateManagerInstance = {
  loadState: vi.fn(() => null),
  saveMapState: vi.fn(),
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
  toggleButtonsVisibility: vi.fn(),
};

vi.mock("../../../../kml_heatmap/frontend/ui/uiToggles", () => ({
  UIToggles: vi.fn(function () {
    return mockUITogglesInstance;
  }),
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
    <button id="heatmap-btn"></button>
    <button id="altitude-btn"></button>
    <button id="airspeed-btn"></button>
    <button id="airports-btn"></button>
    <button id="aviation-btn" style="display:none"></button>
    <div id="altitude-legend" style="display:none"></div>
    <div id="airspeed-legend" style="display:none"></div>
    <div id="stats-panel" style="display:none"></div>
    <div id="loading" style="display:none"></div>
  `;
}

function createApp(): MapApp {
  return new MapApp({
    center: [51, 9] as [number, number],
    bounds: [
      [50, 8],
      [52, 10],
    ] as [[number, number], [number, number]],
    dataDir: "/data",
  });
}

function setupMockKMLHeatmap(): void {
  window.KMLHeatmap = {
    calculateFilteredStatistics: vi.fn(() => ({
      total_points: 100,
      num_paths: 5,
      num_airports: 3,
      airport_names: ["EDDF", "EDDM"],
      num_aircraft: 2,
      aircraft_list: [],
      total_distance_km: 500,
      total_distance_nm: 270,
    })),
    ddToDms: vi.fn((coord: number, isLat: boolean) =>
      isLat ? `${coord.toFixed(2)}N` : `${coord.toFixed(2)}E`
    ),
    formatTime: vi.fn(() => "02:30"),
    findMinMax: vi.fn(() => ({ min: 0, max: 100 })),
    DataLoader: vi.fn(),
  } as unknown as typeof window.KMLHeatmap;
}

const defaultAirports: Airport[] = [
  {
    icao: "EDDF",
    name: "Frankfurt EDDF",
    lat: 50.1,
    lon: 8.67,
    flight_count: 20,
  } as Airport & { flight_count: number },
  {
    icao: "EDDM",
    name: "Munich EDDM",
    lat: 48.35,
    lon: 11.78,
    flight_count: 10,
  } as Airport & { flight_count: number },
];

const defaultMetadata = {
  available_years: [2024, 2025],
  available_aircraft: ["D-ABCD"],
  total_paths: 100,
  total_points: 10000,
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
  } as FilteredStatistics,
  min_groundspeed_knots: 0,
  max_groundspeed_knots: 150,
};

const defaultFullResData = {
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
  resolution: "data",
  original_points: 1000,
};

/**
 * Initialize the app through its initialize() method, which sets up all managers
 * and calls loadInitialData(). We use this helper to avoid repeating the setup
 * in every test.
 */
async function initializeApp(
  app: MapApp,
  airports = defaultAirports,
  metadata = defaultMetadata as typeof defaultMetadata | null,
  fullResData = defaultFullResData as typeof defaultFullResData | null
): Promise<void> {
  mockDataManagerInstance.loadAirports.mockResolvedValue(airports);
  mockDataManagerInstance.loadMetadata.mockResolvedValue(metadata);
  mockDataManagerInstance.loadData.mockResolvedValue(fullResData);
  mockDataManagerInstance.updateLayers.mockResolvedValue(undefined);

  await app.initialize();
}

describe("MapApp - loadInitialData", () => {
  let app: MapApp;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    // Reset shared mock instances to default state
    mockStateManagerInstance.loadState.mockReturnValue(null);
    mockReplayManagerInstance.replayActive = false;
    setupDOM();
    setupMockKMLHeatmap();
    app = createApp();
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("loads airports via dataManager and stores in app.allAirportsData", async () => {
    await initializeApp(app);

    expect(mockDataManagerInstance.loadAirports).toHaveBeenCalled();
    expect(app.allAirportsData).toEqual(defaultAirports);
  });

  it("loads metadata via dataManager", async () => {
    await initializeApp(app);

    expect(mockDataManagerInstance.loadMetadata).toHaveBeenCalled();
  });

  it("populates year filter dropdown from metadata.available_years", async () => {
    await initializeApp(app);

    const yearSelect = document.getElementById(
      "year-select"
    ) as HTMLSelectElement;
    // Should have "All Years" + one option per year
    expect(yearSelect.options.length).toBe(3); // "all" + 2024 + 2025
    expect(yearSelect.options[1].value).toBe("2024");
    expect(yearSelect.options[2].value).toBe("2025");
  });

  it("defaults to latest year when no saved state", async () => {
    // No saved state means restoredYearFromState = false, selectedYear starts as "all"
    await initializeApp(app);

    // Should default to the latest year (2025)
    expect(app.selectedYear).toBe("2025");
  });

  it("syncs dropdown to selectedYear when restored from state", async () => {
    // Simulate saved state that restores year to "2024"
    mockStateManagerInstance.loadState.mockReturnValue({
      selectedYear: "2024",
    });

    await initializeApp(app);

    const yearSelect = document.getElementById(
      "year-select"
    ) as HTMLSelectElement;
    expect(yearSelect.value).toBe("2024");
    expect(app.selectedYear).toBe("2024");
  });

  it('keeps "all" when restoredYearFromState is true and selectedYear is "all"', async () => {
    mockStateManagerInstance.loadState.mockReturnValue({
      selectedYear: "all",
    });

    await initializeApp(app);

    // When restoredYearFromState is true and selectedYear is "all",
    // it should NOT default to latest year
    expect(app.selectedYear).toBe("all");
  });

  it("creates airport markers from loaded airports", async () => {
    await initializeApp(app);

    // loadInitialData calls the standalone createAirportMarkers(app, airports)
    // Verify side effects: markers should be stored in app.airportMarkers
    expect(Object.keys(app.airportMarkers)).toHaveLength(
      defaultAirports.length
    );
    expect(app.airportMarkers["Frankfurt EDDF"]).toBeDefined();
    expect(app.airportMarkers["Munich EDDM"]).toBeDefined();
  });

  it("stores fullStats from metadata.stats", async () => {
    await initializeApp(app);

    expect(app.fullStats).toEqual(defaultMetadata.stats);
  });

  it("loads full resolution path data (path_info and path_segments)", async () => {
    await initializeApp(app);

    expect(mockDataManagerInstance.loadData).toHaveBeenCalledWith(
      "data",
      app.selectedYear
    );
    expect(app.fullPathInfo).toEqual(defaultFullResData.path_info);
    expect(app.fullPathSegments).toEqual(defaultFullResData.path_segments);
  });

  it("handles loadData error gracefully (try/catch)", async () => {
    const { logError } =
      await import("../../../../kml_heatmap/frontend/utils/logger");

    mockDataManagerInstance.loadAirports.mockResolvedValue(defaultAirports);
    mockDataManagerInstance.loadMetadata.mockResolvedValue(defaultMetadata);
    mockDataManagerInstance.loadData.mockRejectedValue(
      new Error("Network error")
    );
    mockDataManagerInstance.updateLayers.mockResolvedValue(undefined);

    await app.initialize();

    expect(logError).toHaveBeenCalledWith(
      "Failed to load full path data:",
      expect.any(Error)
    );
    // App should still continue
    expect(mockFilterManagerInstance.updateAircraftDropdown).toHaveBeenCalled();
  });

  it("populates aircraft dropdown via filterManager", async () => {
    await initializeApp(app);

    expect(mockFilterManagerInstance.updateAircraftDropdown).toHaveBeenCalled();
  });

  it("updates airport popups", async () => {
    await initializeApp(app);

    expect(mockAirportManagerInstance.updateAirportPopups).toHaveBeenCalled();
  });

  it("calculates and sets initial stats panel when fullStats exists", async () => {
    await initializeApp(app);

    expect(window.KMLHeatmap.calculateFilteredStatistics).toHaveBeenCalledWith({
      pathInfo: defaultFullResData.path_info,
      segments: defaultFullResData.path_segments,
      year: app.selectedYear,
      aircraft: app.selectedAircraft,
      coordinateCount: undefined,
    });
    expect(mockStatsManagerInstance.updateStatsPanel).toHaveBeenCalled();
  });

  it("does not calculate stats when fullStats is null", async () => {
    const metadataNoStats = {
      ...defaultMetadata,
      stats: undefined,
    };

    await initializeApp(app, defaultAirports, metadataNoStats as any);

    expect(
      window.KMLHeatmap.calculateFilteredStatistics
    ).not.toHaveBeenCalled();
  });

  it("updates airport opacity", async () => {
    await initializeApp(app);

    expect(mockAirportManagerInstance.updateAirportOpacity).toHaveBeenCalled();
  });

  it("sets airspeed range from metadata with timing data", async () => {
    await initializeApp(app);

    expect(app.airspeedRange.min).toBe(0);
    expect(app.airspeedRange.max).toBe(150);
  });

  it("updates airspeed legend when timing data available", async () => {
    await initializeApp(app);

    expect(mockLayerManagerInstance.updateAirspeedLegend).toHaveBeenCalledWith(
      0,
      150
    );
  });

  it("disables airspeed button when no timing data", async () => {
    const metadataNoTiming = {
      ...defaultMetadata,
      max_groundspeed_knots: 0,
      min_groundspeed_knots: 0,
    };

    await initializeApp(app, defaultAirports, metadataNoTiming);

    const airspeedBtn = document.getElementById(
      "airspeed-btn"
    ) as HTMLButtonElement;
    expect(airspeedBtn.disabled).toBe(true);
    expect(airspeedBtn.style.opacity).toBe("0.3");
  });

  it("enables airspeed button when timing data available", async () => {
    await initializeApp(app);

    const airspeedBtn = document.getElementById(
      "airspeed-btn"
    ) as HTMLButtonElement;
    expect(airspeedBtn.disabled).toBe(false);
  });

  it("sets airspeed button opacity based on airspeedVisible state", async () => {
    // Restore airspeed visible from saved state
    mockStateManagerInstance.loadState.mockReturnValue({
      airspeedVisible: true,
    });

    await initializeApp(app);

    const airspeedBtn = document.getElementById(
      "airspeed-btn"
    ) as HTMLButtonElement;
    // jsdom normalizes "1.0" to "1"
    expect(Number(airspeedBtn.style.opacity)).toBe(1.0);
  });

  it("sets airspeed button opacity to 0.5 when not visible", async () => {
    // No saved state, airspeedVisible defaults to false
    await initializeApp(app);

    const airspeedBtn = document.getElementById(
      "airspeed-btn"
    ) as HTMLButtonElement;
    expect(Number(airspeedBtn.style.opacity)).toBe(0.5);
  });

  it("calls updateLayers on dataManager", async () => {
    await initializeApp(app);

    expect(mockDataManagerInstance.updateLayers).toHaveBeenCalled();
  });

  it("updates airport marker sizes", async () => {
    await initializeApp(app);

    expect(
      mockAirportManagerInstance.updateAirportMarkerSizes
    ).toHaveBeenCalled();
  });

  it("adds altitude layer to map when altitudeVisible is true", async () => {
    mockStateManagerInstance.loadState.mockReturnValue({
      altitudeVisible: true,
    });

    await initializeApp(app);

    expect(app.altitudeVisible).toBe(true);
    // The altitude legend should be shown
    const altLegend = document.getElementById("altitude-legend")!;
    expect(altLegend.style.display).toBe("block");
  });

  it("shows altitude legend when altitudeVisible is true", async () => {
    mockStateManagerInstance.loadState.mockReturnValue({
      altitudeVisible: true,
    });

    await initializeApp(app);

    const altLegend = document.getElementById("altitude-legend")!;
    expect(altLegend.style.display).toBe("block");
  });

  it("adds airspeed layer to map when airspeedVisible is true", async () => {
    mockStateManagerInstance.loadState.mockReturnValue({
      airspeedVisible: true,
    });

    await initializeApp(app);

    expect(app.airspeedVisible).toBe(true);
    const airspeedLegend = document.getElementById("airspeed-legend")!;
    expect(airspeedLegend.style.display).toBe("block");
  });

  it("shows airspeed legend when airspeedVisible is true", async () => {
    mockStateManagerInstance.loadState.mockReturnValue({
      airspeedVisible: true,
    });

    await initializeApp(app);

    const airspeedLegend = document.getElementById("airspeed-legend")!;
    expect(airspeedLegend.style.display).toBe("block");
  });

  it("adds aviation layer when aviationVisible and openaipApiKey set", async () => {
    mockStateManagerInstance.loadState.mockReturnValue({
      aviationVisible: true,
    });

    const appWithApiKey = new MapApp({
      center: [51, 9],
      bounds: [
        [50, 8],
        [52, 10],
      ],
      dataDir: "/data",
      openaipApiKey: "test-key",
    });

    await initializeApp(appWithApiKey);

    expect(appWithApiKey.aviationVisible).toBe(true);
    // The aviation layer should have been created and added
    expect(appWithApiKey.openaipLayers["Aviation Data"]).toBeDefined();
  });

  it("updates replay button state when paths were restored", async () => {
    mockStateManagerInstance.loadState.mockReturnValue({
      selectedPathIds: [1, 2],
    });

    await initializeApp(app);

    expect(
      mockReplayManagerInstance.updateReplayButtonState
    ).toHaveBeenCalled();
  });

  it("does not update replay button state when no paths restored", async () => {
    await initializeApp(app);

    expect(
      mockReplayManagerInstance.updateReplayButtonState
    ).not.toHaveBeenCalled();
  });

  it("restores stats panel visibility from saved state", async () => {
    mockStateManagerInstance.loadState.mockReturnValue({
      statsPanelVisible: true,
    });

    await initializeApp(app);

    const panel = document.getElementById("stats-panel")!;
    expect(panel.style.display).toBe("block");
    expect(panel.classList.contains("visible")).toBe(true);
  });

  it("does not show stats panel when not in saved state", async () => {
    await initializeApp(app);

    const panel = document.getElementById("stats-panel")!;
    expect(panel.style.display).toBe("none");
  });

  it("handles null metadata gracefully", async () => {
    await initializeApp(app, defaultAirports, null);

    // Should not crash, year dropdown should only have default option
    const yearSelect = document.getElementById(
      "year-select"
    ) as HTMLSelectElement;
    expect(yearSelect.options.length).toBe(1);
    expect(app.fullStats).toBeNull();
  });

  it("handles metadata without available_years", async () => {
    const metadataNoYears = {
      available_aircraft: ["D-ABCD"],
      total_paths: 100,
      total_points: 10000,
    };

    await initializeApp(app, defaultAirports, metadataNoYears as any);

    const yearSelect = document.getElementById(
      "year-select"
    ) as HTMLSelectElement;
    expect(yearSelect.options.length).toBe(1);
  });
});

describe("MapApp - createAirportMarkers", () => {
  let app: MapApp;

  beforeEach(() => {
    vi.clearAllMocks();
    setupDOM();
    setupMockKMLHeatmap();
    app = createApp();

    // Initialize minimal app state needed for createAirportMarkers
    // We call initialize() to set up managers but we'll test createAirportMarkers separately
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  async function setupAppForMarkerTests(): Promise<void> {
    await initializeApp(app, []);
    // Clear markers created by initialize
    app.airportMarkers = {};
    vi.clearAllMocks();
    setupMockKMLHeatmap();
  }

  it("creates markers for each airport", async () => {
    await setupAppForMarkerTests();
    const L = await import("leaflet");

    app.createAirportMarkers(defaultAirports);

    // marker() should be called once per airport
    expect(L.marker).toHaveBeenCalledTimes(2);
  });

  it("detects home base (airport with highest flight_count)", async () => {
    await setupAppForMarkerTests();
    const L = await import("leaflet");

    app.createAirportMarkers(defaultAirports);

    // First call should be for EDDF (flight_count: 20 - home base)
    const firstCall = (L.marker as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(firstCall[0]).toEqual([50.1, 8.67]);
  });

  it("adds home class to home base marker HTML", async () => {
    await setupAppForMarkerTests();
    const L = await import("leaflet");

    app.createAirportMarkers(defaultAirports);

    // Check divIcon calls for home base class
    const divIconCalls = (L.divIcon as ReturnType<typeof vi.fn>).mock.calls;
    // First call is for EDDF (home base)
    expect(divIconCalls[0][0].html).toContain("airport-marker-home");
    // Second call is for EDDM (not home base)
    expect(divIconCalls[1][0].html).not.toContain("airport-marker-home");
  });

  it("extracts ICAO from airport name", async () => {
    await setupAppForMarkerTests();
    const L = await import("leaflet");

    app.createAirportMarkers(defaultAirports);

    const divIconCalls = (L.divIcon as ReturnType<typeof vi.fn>).mock.calls;
    // "Frankfurt EDDF" should extract "EDDF"
    expect(divIconCalls[0][0].html).toContain("EDDF");
  });

  it('falls back to "APT" when no ICAO match', async () => {
    await setupAppForMarkerTests();
    const L = await import("leaflet");

    const airportsNoIcao: Airport[] = [
      { icao: "", name: "Small Airfield 123", lat: 50.0, lon: 8.0 } as Airport,
    ];

    app.createAirportMarkers(airportsNoIcao);

    const divIconCalls = (L.divIcon as ReturnType<typeof vi.fn>).mock.calls;
    expect(divIconCalls[0][0].html).toContain("APT");
  });

  it("creates popup with coordinates, flight count, and Google Maps link", async () => {
    await setupAppForMarkerTests();
    const L = await import("leaflet");

    app.createAirportMarkers(defaultAirports);

    // Get the bindPopup call for first marker
    const markerInstance = (L.marker as ReturnType<typeof vi.fn>).mock
      .results[0].value;
    const bindPopupCall = markerInstance.bindPopup.mock.calls[0];
    const popup = bindPopupCall[0];

    expect(popup).toContain("Frankfurt EDDF");
    expect(popup).toContain("https://www.google.com/maps?q=50.1,8.67");
    expect(popup).toContain("Total Flights");
    expect(popup).toContain("20"); // flight_count
  });

  it("shows HOME badge for home base airport", async () => {
    await setupAppForMarkerTests();
    const L = await import("leaflet");

    app.createAirportMarkers(defaultAirports);

    // First airport (EDDF) is home base
    const markerInstance = (L.marker as ReturnType<typeof vi.fn>).mock
      .results[0].value;
    const popup = markerInstance.bindPopup.mock.calls[0][0];
    expect(popup).toContain("HOME");

    // Second airport (EDDM) is not home base
    const markerInstance2 = (L.marker as ReturnType<typeof vi.fn>).mock
      .results[1].value;
    const popup2 = markerInstance2.bindPopup.mock.calls[0][0];
    expect(popup2).not.toContain("HOME");
  });

  it("adds click handler that calls pathSelection.selectPathsByAirport", async () => {
    await setupAppForMarkerTests();
    const L = await import("leaflet");

    // Set up pathSelection mock
    app.pathSelection = {
      selectPathsByAirport: vi.fn(),
    } as any;

    app.createAirportMarkers(defaultAirports);

    const markerInstance = (L.marker as ReturnType<typeof vi.fn>).mock
      .results[0].value;

    // Verify click handler was registered
    expect(markerInstance.on).toHaveBeenCalledWith(
      "click",
      expect.any(Function)
    );

    // Invoke the click handler
    const clickHandler = markerInstance.on.mock.calls[0][1];
    clickHandler({});

    expect(
      (app.pathSelection as any).selectPathsByAirport
    ).toHaveBeenCalledWith("Frankfurt EDDF");
  });

  it("click handler does nothing during replay", async () => {
    await setupAppForMarkerTests();
    const L = await import("leaflet");

    app.pathSelection = {
      selectPathsByAirport: vi.fn(),
    } as any;

    app.createAirportMarkers(defaultAirports);

    const markerInstance = (L.marker as ReturnType<typeof vi.fn>).mock
      .results[0].value;
    const clickHandler = markerInstance.on.mock.calls[0][1];

    // Set replay active
    app.replayManager!.replayActive = true;

    clickHandler({});

    expect(
      (app.pathSelection as any).selectPathsByAirport
    ).not.toHaveBeenCalled();
  });

  it("adds marker to app.airportLayer", async () => {
    await setupAppForMarkerTests();
    const L = await import("leaflet");

    app.createAirportMarkers(defaultAirports);

    const markerInstance = (L.marker as ReturnType<typeof vi.fn>).mock
      .results[0].value;
    expect(markerInstance.addTo).toHaveBeenCalledWith(app.airportLayer);
  });

  it("stores marker in app.airportMarkers", async () => {
    await setupAppForMarkerTests();

    app.createAirportMarkers(defaultAirports);

    expect(app.airportMarkers["Frankfurt EDDF"]).toBeDefined();
    expect(app.airportMarkers["Munich EDDM"]).toBeDefined();
  });

  it("handles empty airports array", async () => {
    await setupAppForMarkerTests();
    const L = await import("leaflet");

    app.createAirportMarkers([]);

    expect(L.marker).not.toHaveBeenCalled();
    expect(Object.keys(app.airportMarkers)).toHaveLength(0);
  });

  it('shows "Unknown" when airport has no name', async () => {
    await setupAppForMarkerTests();
    const L = await import("leaflet");

    const airportsNoName: Airport[] = [
      {
        icao: "",
        name: "",
        lat: 50.0,
        lon: 8.0,
        flight_count: 1,
      } as Airport & { flight_count: number },
    ];

    app.createAirportMarkers(airportsNoName);

    const markerInstance = (L.marker as ReturnType<typeof vi.fn>).mock
      .results[0].value;
    const popup = markerInstance.bindPopup.mock.calls[0][0];
    expect(popup).toContain("Unknown");
  });
});
