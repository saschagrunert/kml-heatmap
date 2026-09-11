/**
 * Shared fixtures for the MapApp initialization test files.
 *
 * Every manager is replaced by a mock instance so the tests see exactly
 * what MapApp itself does with them; the store, the Leaflet mock and the
 * DOM are real. This module imports nothing from the application, so a
 * test file can load it through `vi.hoisted` before it registers the
 * module mocks whose factories hand out these instances.
 */
import { vi } from "vitest";
import type { MapApp } from "../../../../kml_heatmap/frontend/mapApp";
import type {
  Airport,
  KMLDataset,
  Metadata,
  SavedState,
} from "../../../../kml_heatmap/frontend/types";

export const mockDataManagerInstance = {
  loadAirports: vi.fn(),
  loadMetadata: vi.fn(),
  loadData: vi.fn(),
  updateLayers: vi.fn(),
  showLoading: vi.fn(),
  hideLoading: vi.fn(),
};

export const mockFilterManagerInstance = {
  updateAircraftDropdown: vi.fn(),
  filterByYear: vi.fn(),
  filterByAircraft: vi.fn(),
};

export const mockStatsManagerInstance = {
  updateStatsPanel: vi.fn(),
  toggleStats: vi.fn(),
  updateStatsForSelection: vi.fn(),
  setStatsPanelVisible: vi.fn(),
};

export const mockAirportManagerInstance = {
  updateAirportPopups: vi.fn(),
  updateAirportOpacity: vi.fn(),
  updateAirportMarkerSizes: vi.fn(),
  calculateAirportFlightCounts: vi.fn(),
};

export const mockReplayManagerInstance = {
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
  destroy: vi.fn(),
};

export const mockLayerManagerInstance = {
  updateAirspeedLegend: vi.fn(),
  redrawAltitudePaths: vi.fn(),
  redrawAirspeedPaths: vi.fn(),
  clearLayer: vi.fn(),
  getPathInfoMap: vi.fn(() => new Map()),
};

export const mockStateManagerInstance = {
  loadState: vi.fn((): SavedState | null => null),
  saveMapState: vi.fn(),
  scheduleSave: vi.fn(),
  flush: vi.fn(),
};

export const mockWrappedManagerInstance = {
  showWrapped: vi.fn(),
  closeWrapped: vi.fn(),
  destroy: vi.fn(),
};

export const mockUITogglesInstance = {
  toggleHeatmap: vi.fn(),
  toggleAltitude: vi.fn(),
  toggleAirspeed: vi.fn(),
  toggleAirports: vi.fn(),
  toggleAviation: vi.fn(),
  exportMap: vi.fn(),
  shareLink: vi.fn(),
};

export const mockPathSelectionInstance = {
  updateIsolateButton: vi.fn(),
  clearSelection: vi.fn(),
  selectPathsByAirport: vi.fn(),
  togglePathSelection: vi.fn(),
  toggleIsolateSelection: vi.fn(),
};

/** The map configuration every MapApp in these tests is built with */
export const APP_CONFIG = {
  center: [51, 9] as [number, number],
  bounds: [
    [50, 8],
    [52, 10],
  ] as [[number, number], [number, number]],
  dataDir: "/data",
};

export function setupDOM(): void {
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
    <div id="altitude-legend"></div>
    <div id="airspeed-legend"></div>
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

export const defaultAirports: Airport[] = [
  { name: "Frankfurt EDDF", lat: 50.1, lon: 8.67 },
  { name: "Munich EDDM", lat: 48.35, lon: 11.78 },
];

export const defaultMetadata: Metadata = {
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
  min_groundspeed_knots: 0,
  max_groundspeed_knots: 150,
};

export const defaultData: KMLDataset = {
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

export async function initializeApp(
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

/** Reset every mock to a clean, resolved state before a test */
export function resetManagerMocks(): void {
  vi.resetAllMocks();
  mockStateManagerInstance.loadState.mockReturnValue(null);
  mockReplayManagerInstance.state.active = false;
  mockReplayManagerInstance.state.airplaneMarker = null;
}

export function yearSelect(): HTMLSelectElement {
  return document.getElementById("year-select") as HTMLSelectElement;
}
