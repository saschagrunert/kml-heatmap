/**
 * Test helper types and utilities
 */
import { vi, type Mock } from "vitest";
import type { MapApp } from "../../kml_heatmap/frontend/mapApp";
import type {
  PathInfo,
  PathSegment,
  Airport,
  KMLDataset,
} from "../../kml_heatmap/frontend/types";
import {
  AppStore,
  type StoreState,
} from "../../kml_heatmap/frontend/state/store";
import {
  layerGroup,
  map as createMockMap,
  canvas,
  type MockLayerGroup,
  type MockMap as LeafletMockMap,
} from "../mocks/leaflet";

/**
 * Mock Leaflet marker for testing
 */
export interface MockMarker {
  setPopupContent: Mock;
  setOpacity: Mock;
  addTo: Mock;
  setIcon?: Mock;
  on?: Mock;
  off?: Mock;
  bindPopup?: Mock;
  openPopup?: Mock;
  closePopup?: Mock;
}

/**
 * Mock Leaflet layer for testing
 */
export interface MockLayer {
  hasLayer: Mock;
  removeLayer: Mock;
  addLayer?: Mock;
  clearLayers?: Mock;
  eachLayer?: Mock;
}

/**
 * Mock Leaflet map for testing
 */
export interface MockMap {
  addLayer?: Mock;
  removeLayer?: Mock;
  setView?: Mock;
  fitBounds?: Mock;
  getZoom?: Mock;
  getCenter?: Mock;
  invalidateSize?: Mock;
}

/**
 * Mock manager with common methods
 */
export interface MockManager {
  updateStatsPanel?: Mock;
  updateStatsForSelection?: Mock;
  updateAirportOpacity?: Mock;
  updateAirportPopups?: Mock;
  saveMapState?: Mock;
  updateLayers?: Mock;
  loadData?: Mock;
  clearLayers?: Mock;
  redrawAltitudePaths?: Mock;
  redrawAirspeedPaths?: Mock;
  updateSelectionStyles?: Mock;
  updateReplayButtonState?: Mock;
  state?: { active: boolean };
}

/**
 * Loosely typed partial MapApp for hand-written mocks (legacy tests).
 * Prefer `createMockApp()` for new tests.
 */
export type MockMapApp = Partial<MapApp> & {
  store?: Pick<AppStore, "notifyMutation">;
  selectedYear: string;
  selectedAircraft: string;
  selectedPathIds: Set<number>;
  fullPathInfo: PathInfo[];
  allAirportsData?: Airport[];
  airportMarkers?: Record<string, MockMarker>;
  airportLayer?: MockLayer;
  airportToPaths?: Record<string, Set<number>>;
  fullPathSegments?: unknown[];
  isInitializing?: boolean;
  dataManager?: MockManager;
  statsManager?: MockManager;
  airportManager?: MockManager;
  stateManager?: MockManager;
  replayManager?: MockManager;
  layerManager?: MockManager;
  altitudeLayer?: MockLayer;
  altitudeVisible?: boolean;
  airspeedVisible?: boolean;
  map?: MockMap;
};

/**
 * Build a dataset from path info and segments
 */
export function createDataset(
  pathInfo: PathInfo[] = [],
  segments: PathSegment[] = [],
  originalPoints = 0,
): KMLDataset {
  const coordinates = segments.flatMap((s) => (s.coords ? [s.coords[0]] : []));
  return {
    coordinates,
    path_segments: segments,
    path_info: pathInfo,
    original_points: originalPoints,
  };
}

/**
 * Create a segment with sensible defaults
 */
export function createSegment(
  overrides: Partial<PathSegment> = {},
): PathSegment {
  return {
    path_id: 1,
    coords: [
      [50.0, 8.0],
      [50.1, 8.1],
    ],
    altitude_ft: 3000,
    groundspeed_knots: 100,
    ...overrides,
  };
}

/** Mocked manager set attached to a mock app */
export interface MockManagers {
  dataManager: {
    loadData: Mock;
    loadAirports: Mock;
    loadMetadata: Mock;
    updateLayers: Mock;
    showLoading: Mock;
    hideLoading: Mock;
    applyHeatmapEmphasis: Mock;
  };
  layerManager: {
    redrawAltitudePaths: Mock;
    redrawAirspeedPaths: Mock;
    clearLayer: Mock;
    updateSelectionStyles: Mock;
    updateAltitudeLegend: Mock;
    updateAirspeedLegend: Mock;
    getPathInfoMap: Mock;
    getPolylineCount: Mock;
  };
  filterManager: {
    updateAircraftDropdown: Mock;
    filterByYear: Mock;
    filterByAircraft: Mock;
  };
  statsManager: {
    updateStatsPanel: Mock;
    updateStatsForSelection: Mock;
    toggleStats: Mock;
    setStatsPanelVisible: Mock;
  };
  pathSelection: {
    togglePathSelection: Mock;
    selectPathsByAirport: Mock;
    clearSelection: Mock;
    toggleIsolateSelection: Mock;
    updateIsolateButton: Mock;
  };
  airportManager: {
    calculateAirportFlightCounts: Mock;
    updateAirportPopups: Mock;
    updateAirportOpacity: Mock;
    updateAirportMarkerSizes: Mock;
  };
  stateManager: {
    saveMapState: Mock;
    scheduleSave: Mock;
    loadState: Mock;
    loadMapState: Mock;
    updateUrl: Mock;
  };
  replayManager: {
    state: { active: boolean; airplaneMarker: null };
    updateReplayButtonState: Mock;
    toggleReplay: Mock;
    playReplay: Mock;
    pauseReplay: Mock;
    stopReplay: Mock;
    seekReplay: Mock;
    changeReplaySpeed: Mock;
    toggleAutoZoom: Mock;
    redrawReplayPath: Mock;
    updateReplayAirplanePopup: Mock;
  };
  wrappedManager: {
    showWrapped: Mock;
    closeWrapped: Mock;
  };
  uiToggles: {
    toggleHeatmap: Mock;
    toggleAltitude: Mock;
    toggleAirspeed: Mock;
    toggleAirports: Mock;
    toggleAviation: Mock;
    exportMap: Mock;
  };
}

/**
 * Fully mocked MapApp: a real AppStore behind the store-backed accessors,
 * Leaflet mock objects for map/layers and vi.fn() stubs for every manager.
 */
export type MockApp = Omit<
  MapApp,
  | keyof MockManagers
  | "map"
  | "altitudeLayer"
  | "airspeedLayer"
  | "airportLayer"
  | "pathRenderer"
> &
  MockManagers & {
    map: LeafletMockMap | null;
    altitudeLayer: MockLayerGroup;
    airspeedLayer: MockLayerGroup;
    airportLayer: MockLayerGroup;
    pathRenderer: ReturnType<typeof canvas>;
  };

export interface MockAppOverrides extends Partial<StoreState> {
  map?: LeafletMockMap | null;
  config?: Partial<MapApp["config"]>;
  isInitializing?: boolean;
  allAirportsData?: Airport[];
  airportMarkers?: MapApp["airportMarkers"];
  airportToPaths?: MapApp["airportToPaths"];
  savedState?: MapApp["savedState"];
  restoredYearFromState?: boolean;
  managers?: {
    [K in keyof MockManagers]?: Partial<MockManagers[K]>;
  };
}

function createMockManagers(): MockManagers {
  return {
    dataManager: {
      loadData: vi.fn().mockResolvedValue(null),
      loadAirports: vi.fn().mockResolvedValue([]),
      loadMetadata: vi.fn().mockResolvedValue(null),
      updateLayers: vi.fn().mockResolvedValue(undefined),
      showLoading: vi.fn(),
      hideLoading: vi.fn(),
      applyHeatmapEmphasis: vi.fn(),
    },
    layerManager: {
      redrawAltitudePaths: vi.fn(),
      redrawAirspeedPaths: vi.fn(),
      clearLayer: vi.fn(),
      updateSelectionStyles: vi.fn(),
      updateAltitudeLegend: vi.fn(),
      updateAirspeedLegend: vi.fn(),
      getPathInfoMap: vi.fn(() => new Map<number, PathInfo>()),
      getPolylineCount: vi.fn(() => 0),
    },
    filterManager: {
      updateAircraftDropdown: vi.fn(),
      filterByYear: vi.fn().mockResolvedValue(undefined),
      filterByAircraft: vi.fn().mockResolvedValue(undefined),
    },
    statsManager: {
      updateStatsPanel: vi.fn(),
      updateStatsForSelection: vi.fn(),
      toggleStats: vi.fn(),
      setStatsPanelVisible: vi.fn(),
    },
    pathSelection: {
      togglePathSelection: vi.fn(),
      selectPathsByAirport: vi.fn(),
      clearSelection: vi.fn(),
      toggleIsolateSelection: vi.fn(),
      updateIsolateButton: vi.fn(),
    },
    airportManager: {
      calculateAirportFlightCounts: vi.fn(() => ({})),
      updateAirportPopups: vi.fn(),
      updateAirportOpacity: vi.fn(),
      updateAirportMarkerSizes: vi.fn(),
    },
    stateManager: {
      saveMapState: vi.fn(),
      scheduleSave: vi.fn(),
      loadState: vi.fn(() => null),
      loadMapState: vi.fn(() => null),
      updateUrl: vi.fn(),
    },
    replayManager: {
      state: { active: false, airplaneMarker: null },
      updateReplayButtonState: vi.fn(),
      toggleReplay: vi.fn(),
      playReplay: vi.fn(),
      pauseReplay: vi.fn(),
      stopReplay: vi.fn(),
      seekReplay: vi.fn(),
      changeReplaySpeed: vi.fn(),
      toggleAutoZoom: vi.fn(),
      redrawReplayPath: vi.fn(),
      updateReplayAirplanePopup: vi.fn(),
    },
    wrappedManager: {
      showWrapped: vi.fn(),
      closeWrapped: vi.fn(),
    },
    uiToggles: {
      toggleHeatmap: vi.fn(),
      toggleAltitude: vi.fn(),
      toggleAirspeed: vi.fn(),
      toggleAirports: vi.fn(),
      toggleAviation: vi.fn(),
      exportMap: vi.fn(),
    },
  };
}

/**
 * Create a mock MapApp with store-backed accessors, mocked Leaflet objects
 * and mocked managers. Store keys can be seeded through `overrides`.
 */
export function createMockApp(overrides: MockAppOverrides = {}): MockApp {
  const { map: mapOverride, config, managers, ...rest } = overrides;
  const storeKeys: (keyof StoreState)[] = [
    "selectedYear",
    "selectedAircraft",
    "selectedPathIds",
    "isolateSelection",
    "heatmapVisible",
    "altitudeVisible",
    "airspeedVisible",
    "airportsVisible",
    "aviationVisible",
    "statsPanelVisible",
    "wrappedVisible",
    "currentData",
    "fullStats",
    "altitudeRange",
    "airspeedRange",
  ];
  const initial: Partial<StoreState> = {};
  const other: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rest)) {
    if ((storeKeys as string[]).includes(key)) {
      (initial as Record<string, unknown>)[key] = value;
    } else {
      other[key] = value;
    }
  }

  const store = new AppStore(initial);
  const mockManagers = createMockManagers();
  if (managers) {
    for (const [name, partial] of Object.entries(managers)) {
      Object.assign(
        mockManagers[name as keyof MockManagers] as object,
        partial,
      );
    }
  }

  const app = {
    store,
    config: {
      center: [50, 8] as [number, number],
      bounds: [
        [49, 7],
        [51, 9],
      ] as [[number, number], [number, number]],
      dataDir: "data",
      ...config,
    },
    allAirportsData: [],
    isInitializing: false,
    map: mapOverride === undefined ? createMockMap() : mapOverride,
    heatmapLayer: null,
    altitudeLayer: layerGroup(),
    airspeedLayer: layerGroup(),
    airportLayer: layerGroup(),
    pathRenderer: canvas(),
    airportToPaths: {},
    airportMarkers: {},
    openaipLayers: {},
    savedState: null,
    restoredYearFromState: false,
    mobileBar: null,
    ...mockManagers,
    ...other,
    get selectedYear() {
      return store.get("selectedYear");
    },
    set selectedYear(v: string) {
      store.set("selectedYear", v);
    },
    get selectedAircraft() {
      return store.get("selectedAircraft");
    },
    set selectedAircraft(v: string) {
      store.set("selectedAircraft", v);
    },
    get selectedPathIds() {
      return store.get("selectedPathIds");
    },
    set selectedPathIds(v: Set<number>) {
      store.set("selectedPathIds", v);
    },
    get isolateSelection() {
      return store.get("isolateSelection");
    },
    set isolateSelection(v: boolean) {
      store.set("isolateSelection", v);
    },
    get heatmapVisible() {
      return store.get("heatmapVisible");
    },
    set heatmapVisible(v: boolean) {
      store.set("heatmapVisible", v);
    },
    get altitudeVisible() {
      return store.get("altitudeVisible");
    },
    set altitudeVisible(v: boolean) {
      store.set("altitudeVisible", v);
    },
    get airspeedVisible() {
      return store.get("airspeedVisible");
    },
    set airspeedVisible(v: boolean) {
      store.set("airspeedVisible", v);
    },
    get airportsVisible() {
      return store.get("airportsVisible");
    },
    set airportsVisible(v: boolean) {
      store.set("airportsVisible", v);
    },
    get aviationVisible() {
      return store.get("aviationVisible");
    },
    set aviationVisible(v: boolean) {
      store.set("aviationVisible", v);
    },
    get currentData() {
      return store.get("currentData");
    },
    set currentData(v: KMLDataset | null) {
      store.set("currentData", v);
    },
    get fullPathInfo() {
      return store.get("currentData")?.path_info ?? null;
    },
    get fullPathSegments() {
      return store.get("currentData")?.path_segments ?? null;
    },
    get fullStats() {
      return store.get("fullStats");
    },
    set fullStats(v) {
      store.set("fullStats", v);
    },
    get altitudeRange() {
      return store.get("altitudeRange");
    },
    set altitudeRange(v) {
      store.set("altitudeRange", v);
    },
    get airspeedRange() {
      return store.get("airspeedRange");
    },
    set airspeedRange(v) {
      store.set("airspeedRange", v);
    },
    loadInitialData: vi.fn(),
    togglePathSelection: vi.fn(),
    seekReplay: vi.fn(),
    changeReplaySpeed: vi.fn(),
    initialize: vi.fn(),
  };

  return app;
}

/**
 * Cast a mock app to MapApp for constructor calls
 */
export function asMapApp(app: MockApp): MapApp {
  return app as unknown as MapApp;
}
