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
import { datasetIndex } from "../../kml_heatmap/frontend/calculations/datasetIndex";
import { ReplayState } from "../../kml_heatmap/frontend/ui/replayState";
import {
  AppStore,
  defineStoreAccessors,
  STORE_ACCESSOR_KEYS,
  type StoreState,
} from "../../kml_heatmap/frontend/state/store";
import {
  syncLegend,
  syncToggleButton,
} from "../../kml_heatmap/frontend/utils/buttonState";
import {
  layerGroup,
  map as createMockMap,
  canvas,
  type MockLayerGroup,
  type MockMap as LeafletMockMap,
} from "../mocks/leaflet";

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
interface MockManagers {
  dataManager: {
    loadData: Mock;
    loadAirports: Mock;
    loadMetadata: Mock;
    updateLayers: Mock;
    showLoading: Mock;
    hideLoading: Mock;
    applyHeatmapEmphasis: Mock;
    showHeatmap: Mock;
  };
  layerManager: {
    redrawAltitudePaths: Mock;
    redrawAirspeedPaths: Mock;
    clearLayer: Mock;
    updateSelectionStyles: Mock;
    updateAltitudeLegend: Mock;
    updateAirspeedLegend: Mock;
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
    flush: Mock;
    loadState: Mock;
    loadMapState: Mock;
    updateUrl: Mock;
  };
  /**
   * The replay state the app owns. `replayManager.state` is the very same
   * object, the way it is in the app, so a test may set either. A real
   * ReplayState, because the real ReplayManager works on it.
   */
  replayState: ReplayState;
  canReplay: Mock;
  loadReplay: Mock;
  loadWrapped: Mock;
  replayManager: {
    state: ReplayState;
    canReplay: Mock;
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
    destroy: Mock;
  };
  wrappedManager: {
    showWrapped: Mock;
    closeWrapped: Mock;
    userMapView: Mock;
    destroy: Mock;
  };
  uiToggles: {
    toggleHeatmap: Mock;
    toggleAltitude: Mock;
    toggleAirspeed: Mock;
    toggleAirports: Mock;
    toggleAviation: Mock;
    exportMap: Mock;
    shareLink: Mock;
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
  // The app owns the replay state and the manager works on the same object
  const replayState = new ReplayState();
  const replayManager = {
    state: replayState,
    canReplay: vi.fn(() => false), // replaced below once the app exists
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
    destroy: vi.fn(),
  };
  const wrappedManager = {
    showWrapped: vi.fn(),
    closeWrapped: vi.fn(),
    userMapView: vi.fn(() => null),
    destroy: vi.fn(),
  };
  return {
    dataManager: {
      loadData: vi.fn().mockResolvedValue(null),
      loadAirports: vi.fn().mockResolvedValue([]),
      loadMetadata: vi.fn().mockResolvedValue(null),
      updateLayers: vi.fn().mockResolvedValue(undefined),
      showLoading: vi.fn(),
      hideLoading: vi.fn(),
      applyHeatmapEmphasis: vi.fn(),
      showHeatmap: vi.fn(),
    },
    layerManager: {
      redrawAltitudePaths: vi.fn(),
      redrawAirspeedPaths: vi.fn(),
      clearLayer: vi.fn(),
      updateSelectionStyles: vi.fn(),
      updateAltitudeLegend: vi.fn(),
      updateAirspeedLegend: vi.fn(),
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
      flush: vi.fn(),
      loadState: vi.fn(() => null),
      loadMapState: vi.fn(() => null),
      updateUrl: vi.fn(),
    },
    replayState,
    // The real predicate: MapApp.canReplay reads exactly these two
    canReplay: vi.fn(function (this: MockApp) {
      return this.selectedPathIds.size === 1 && this.hasTimingData;
    }),
    // Replay and Wrapped are fetched on demand in the app; the stubs are
    // already there, so the loaders hand them straight back
    loadReplay: vi.fn(() => Promise.resolve(replayManager)),
    loadWrapped: vi.fn(() => Promise.resolve(wrappedManager)),
    replayManager,
    wrappedManager,
    uiToggles: {
      toggleHeatmap: vi.fn(),
      toggleAltitude: vi.fn(),
      toggleAirspeed: vi.fn(),
      toggleAirports: vi.fn(),
      toggleAviation: vi.fn(),
      exportMap: vi.fn(),
      shareLink: vi.fn().mockResolvedValue(undefined),
    },
  };
}

/** Every store key: the accessor keys plus the two panel flags */
const STORE_KEYS: readonly (keyof StoreState)[] = [
  ...STORE_ACCESSOR_KEYS,
  "statsPanelVisible",
  "wrappedVisible",
];

/**
 * Create a mock MapApp with store-backed accessors, mocked Leaflet objects
 * and mocked managers. Store keys can be seeded through `overrides`.
 *
 * The accessors come from the same `defineStoreAccessors` the real MapApp
 * uses, so the double cannot drift from it.
 */
export function createMockApp(overrides: MockAppOverrides = {}): MockApp {
  const { map: mapOverride, config, managers, ...rest } = overrides;
  const initial: Partial<StoreState> = {};
  const other: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rest)) {
    if ((STORE_KEYS as string[]).includes(key)) {
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
    // Derived like MapApp's getter; an override replaces it with fixed data
    get airportToPaths(): MapApp["airportToPaths"] {
      const data = store.get("currentData");
      if (!data) return {};
      return datasetIndex(data)
        .filter(store.get("selectedYear"), store.get("selectedAircraft"))
        .pathIdsByAirport();
    },
    airportMarkers: {},
    openaipLayers: {},
    savedState: null,
    restoredYearFromState: false,
    mobileBar: null,
    ...mockManagers,
    ...other,
    get fullPathInfo() {
      return store.get("currentData")?.path_info ?? null;
    },
    get fullPathSegments() {
      return store.get("currentData")?.path_segments ?? null;
    },
    togglePathSelection: vi.fn(),
    seekReplay: vi.fn(),
    initialize: vi.fn(),
    destroy: vi.fn(),
  };
  defineStoreAccessors(app);

  const mockApp = app as unknown as MockApp;
  // The stub manager answers the way the real one does: by asking the app
  mockApp.replayManager.canReplay.mockImplementation((): boolean =>
    Boolean(mockApp.canReplay()),
  );

  return mockApp;
}

/**
 * Cast a mock app to MapApp for constructor calls
 */
export function asMapApp(app: MockApp): MapApp {
  return app as unknown as MapApp;
}

/**
 * Wire the store-driven toggle buttons and legends the way MapApp does in
 * setupButtonSync, for tests that assert on the button or legend state a
 * manager causes through the store.
 */
export function syncControlsWithStore(store: AppStore): void {
  syncToggleButton(store, "heatmapVisible", "heatmap-btn");
  syncToggleButton(store, "altitudeVisible", "altitude-btn");
  syncToggleButton(store, "airspeedVisible", "airspeed-btn");
  syncToggleButton(store, "airportsVisible", "airports-btn");
  syncToggleButton(store, "aviationVisible", "aviation-btn");
  syncLegend(store, "altitudeVisible", "altitude-legend");
  syncLegend(store, "airspeedVisible", "airspeed-legend");
}

/**
 * Mount `id: tag` elements on the body. The returned function removes them
 * again.
 */
export function mountElements(spec: Record<string, string>): () => void {
  const created: HTMLElement[] = [];
  for (const [id, tag] of Object.entries(spec)) {
    const element = document.createElement(tag);
    element.id = id;
    document.body.appendChild(element);
    created.push(element);
  }
  return () => {
    for (const element of created) element.remove();
  };
}

/** Get an element that must exist */
export function el(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing test element #${id}`);
  return element;
}
