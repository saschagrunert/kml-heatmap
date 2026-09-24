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
  DEFAULT_AIRSPEED_RANGE,
  DEFAULT_ALTITUDE_RANGE,
  defineStoreAccessors,
  STORE_ACCESSOR_KEYS,
  type StoreState,
} from "../../kml_heatmap/frontend/state/store";
import { segmentsForPathIds } from "../../kml_heatmap/frontend/calculations/statistics";
import { followLayerVisibility } from "../../kml_heatmap/frontend/ui/layerVisibility";
import {
  syncLegend,
  syncToggleButton,
} from "../../kml_heatmap/frontend/utils/buttonState";
import { Map as MockMapLibreMap, mockControl } from "../mocks/maplibre-gl";
import {
  addDataLayers,
  AirportLayerHandle,
  MapLayerHandle,
} from "../../kml_heatmap/frontend/mapLayers";
import {
  HEATMAP_LAYER_IDS,
  MAP_LAYERS,
} from "../../kml_heatmap/frontend/utils/constants";
import type { Map as MapLibreMap } from "maplibre-gl";

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
    destroy: Mock;
    applyHeatmapEmphasis: Mock;
    showHeatmap: Mock;
  };
  layerManager: {
    redrawAltitudePaths: Mock;
    redrawAirspeedPaths: Mock;
    clearLayer: Mock;
    updateSelectionStyles: Mock;
    syncModes: Mock;
    updateAltitudeLegend: Mock;
    updateAirspeedLegend: Mock;
    hitTest: Mock;
    onPathClick: Mock;
    closeSegmentPopup: Mock;
    restyle: Mock;
    ribbonsShown: number;
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
    updateAirportPopups: Mock;
    updateAirportOpacity: Mock;
    updateAirportMarkerSizes: Mock;
    activateAirport: Mock;
    airportLabelAt: Mock;
    openPopup: Mock;
    closePopup: Mock;
    isPopupOpen: Mock;
  };
  stateManager: {
    saveMapState: Mock;
    scheduleSave: Mock;
    flush: Mock;
    loadState: Mock;
    loadMapState: Mock;
    updateUrl: Mock;
    cancelSave: Mock;
  };
  /**
   * The replay state the app owns. `replayManager.state` is the very same
   * object, the way it is in the app, so a test may set either. A real
   * ReplayState, because the real ReplayManager works on it.
   */
  replayState: ReplayState;
  canReplay: Mock;
  toggleReplay: Mock;
  resetView: Mock;
  isReset: Mock;
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
  mapOrientation: {
    toggleGlobe: Mock;
    resetNorth: Mock;
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

/** A layer handle whose methods are spies over the real behaviour */
type SpiedHandle<T> = T & { isVisible: Mock; setVisible: Mock };

/**
 * Fully mocked MapApp: a real AppStore behind the store-backed accessors,
 * the mock map with its style loaded and every source and layer of MAP_SOURCES and
 * MAP_LAYERS on it, the real layer handles attached to that map (spied, so
 * a test may assert on the call or on `map.layer(id).layout`), a resolved
 * `mapReady` and vi.fn() stubs for every manager.
 */
export type MockApp = Omit<
  MapApp,
  | keyof MockManagers
  | "map"
  | "heatmapLayer"
  | "aviationLayer"
  | "altitudeLayer"
  | "airspeedLayer"
  | "airportLayer"
  | "selectionHighlightLayer"
> &
  MockManagers & {
    map: MockMapLibreMap | null;
    heatmapLayer: SpiedHandle<MapLayerHandle>;
    aviationLayer: SpiedHandle<MapLayerHandle>;
    altitudeLayer: SpiedHandle<MapLayerHandle>;
    airspeedLayer: SpiedHandle<MapLayerHandle>;
    airportLayer: SpiedHandle<AirportLayerHandle>;
    selectionHighlightLayer: SpiedHandle<MapLayerHandle>;
  };

export interface MockAppOverrides extends Partial<StoreState> {
  /** The app's lifetime signal; a test that aborts it passes its own */
  signal?: AbortSignal;
  aircraftModels?: MapApp["aircraftModels"];
  altitudeRange?: MapApp["altitudeRange"];
  airspeedRange?: MapApp["airspeedRange"];
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
  /** A map of the test's own, or null for an app without one */
  map?: MockMapLibreMap | null;
  /** In place of the one that has resolved with the map already */
  mapReady?: Promise<unknown>;
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
      updateLayers: vi.fn(),
      showLoading: vi.fn(),
      hideLoading: vi.fn(),
      destroy: vi.fn(),
      applyHeatmapEmphasis: vi.fn(),
      showHeatmap: vi.fn(),
    },
    layerManager: {
      redrawAltitudePaths: vi.fn(),
      redrawAirspeedPaths: vi.fn(),
      clearLayer: vi.fn(),
      updateSelectionStyles: vi.fn(),
      syncModes: vi.fn(),
      updateAltitudeLegend: vi.fn(),
      updateAirspeedLegend: vi.fn(),
      hitTest: vi.fn(() => null),
      onPathClick: vi.fn(),
      closeSegmentPopup: vi.fn(),
      restyle: vi.fn(),
      ribbonsShown: 1,
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
      updateAirportPopups: vi.fn(),
      updateAirportOpacity: vi.fn(),
      updateAirportMarkerSizes: vi.fn(),
      activateAirport: vi.fn(),
      airportLabelAt: vi.fn(() => null),
      openPopup: vi.fn(),
      closePopup: vi.fn(),
      isPopupOpen: vi.fn(() => false),
    },
    stateManager: {
      saveMapState: vi.fn(),
      scheduleSave: vi.fn(),
      flush: vi.fn(),
      loadState: vi.fn(() => null),
      loadMapState: vi.fn(() => null),
      updateUrl: vi.fn(),
      cancelSave: vi.fn(),
    },
    replayState,
    // The real predicate, the way MapApp.canReplay puts it
    canReplay: vi.fn(function (this: MockApp) {
      const segments = this.fullPathSegments;
      return (
        this.selectedPathIds.size === 1 &&
        this.hasTimingData &&
        !!segments &&
        segmentsForPathIds(segments, this.selectedPathIds).some(
          (segment) => (segment.time ?? 0) > 0,
        )
      );
    }),
    // Like the app's once the manager is there: straight to it
    toggleReplay: vi.fn(() => {
      replayManager.toggleReplay();
    }),
    resetView: vi.fn(() => Promise.resolve()),
    // Something to reset unless a test says otherwise
    isReset: vi.fn(() => false),
    // Replay and Wrapped are fetched on demand in the app; the stubs are
    // already there, so the loaders hand them straight back
    loadReplay: vi.fn(() => Promise.resolve(replayManager)),
    loadWrapped: vi.fn(() => Promise.resolve(wrappedManager)),
    replayManager,
    wrappedManager,
    mapOrientation: {
      toggleGlobe: vi.fn(),
      resetNorth: vi.fn(),
    },
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
 * A mock MapLibre map the way the app leaves it once `mapReady` resolves:
 * style loaded, every source and layer created and empty. Built at once, so
 * a test does not have to wait for the style first.
 */
export function createMapLibreMock(
  options: Record<string, unknown> = {},
): MockMapLibreMap {
  const autoLoadStyle = mockControl.autoLoadStyle;
  mockControl.autoLoadStyle = false;
  let map: MockMapLibreMap;
  try {
    map = new MockMapLibreMap({
      container:
        document.getElementById("map") ?? document.createElement("div"),
      style: "https://example.test/style.json",
      ...options,
    });
  } finally {
    mockControl.autoLoadStyle = autoLoadStyle;
  }
  map.finishStyleLoad();
  addDataLayers(map as unknown as MapLibreMap);
  return map;
}

/** The map and layer fields; everything else is built here */
type MapFields = Record<string, unknown> & { map: unknown };

function buildMockApp(
  overrides: Omit<MockAppOverrides, "map">,
  mapFields: MapFields,
): unknown {
  const { config, managers, ...rest } = overrides;
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
    ...mapFields,
    // Like the app's after initialize(): the map, with its layers on it
    mapReady: Promise.resolve(mapFields.map),
    // Derived like MapApp's getter; an override replaces it with fixed data
    get airportToPaths(): MapApp["airportToPaths"] {
      const data = store.get("currentData");
      if (!data) return {};
      return datasetIndex(data)
        .filter(store.get("selectedYear"), store.get("selectedAircraft"))
        .pathIdsByAirport();
    },
    airportMarkers: {},
    aircraftModels: {},
    altitudeRange: { ...DEFAULT_ALTITUDE_RANGE },
    airspeedRange: { ...DEFAULT_AIRSPEED_RANGE },
    signal: new AbortController().signal,
    savedState: null,
    restoredYearFromState: false,
    defaultYear: "all",
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

/** Wrap the methods tests assert on in spies that keep the real behaviour */
function spied<T extends MapLayerHandle>(handle: T): SpiedHandle<T> {
  const base: MapLayerHandle = handle;
  vi.spyOn(base, "isVisible");
  vi.spyOn(base, "setVisible");
  return handle as SpiedHandle<T>;
}

/**
 * Create a mock MapApp, see `MockApp`. Store keys can be seeded through
 * `overrides`. The handles start out like the app's own (everything hidden
 * but the airports) and are attached to the map, so `setVisible` shows on the
 * mock's layers.
 *
 * The accessors come from the same `defineStoreAccessors` the real MapApp
 * uses, so the double cannot drift from it.
 */
export function createMockApp(overrides: MockAppOverrides = {}): MockApp {
  const { map: mapOverride, ...rest } = overrides;
  const map = mapOverride === undefined ? createMapLibreMock() : mapOverride;
  const handles = {
    heatmapLayer: spied(new MapLayerHandle(HEATMAP_LAYER_IDS)),
    aviationLayer: spied(new MapLayerHandle([MAP_LAYERS.aviation])),
    altitudeLayer: spied(
      new MapLayerHandle([
        MAP_LAYERS.pathsAltitude,
        MAP_LAYERS.pathsAltitudeSelected,
        MAP_LAYERS.pathsAltitudeRibbons,
        MAP_LAYERS.pathsAltitudeSelectedRibbons,
      ]),
    ),
    airspeedLayer: spied(
      new MapLayerHandle([
        MAP_LAYERS.pathsAirspeed,
        MAP_LAYERS.pathsAirspeedSelected,
        MAP_LAYERS.pathsAirspeedRibbons,
        MAP_LAYERS.pathsAirspeedSelectedRibbons,
      ]),
    ),
    airportLayer: spied(new AirportLayerHandle()),
    selectionHighlightLayer: spied(
      new MapLayerHandle([MAP_LAYERS.selectionHighlight]),
    ),
  };
  if (map) {
    for (const handle of Object.values(handles)) {
      handle.attach(map as unknown as MapLibreMap);
      // Attaching is setup, not something the code under test did
      handle.setVisible.mockClear();
    }
  }
  return buildMockApp(rest, { map, ...handles }) as MockApp;
}

/**
 * Cast a mock app to MapApp for constructor calls
 */
export function asMapApp(app: MockApp): MapApp {
  return app as unknown as MapApp;
}

/**
 * Wire the store-driven toggle buttons, legends and layers the way MapApp
 * does (setupButtonSync, followLayerVisibility), for tests that assert on
 * the state a manager causes through the store. The colour layers are the
 * layer manager's, a stub here unless the test gives it a real one.
 */
export function syncControlsWithStore(app: MockApp): void {
  const store = app.store;
  syncToggleButton(store, "altitudeVisible", "altitude-btn");
  syncToggleButton(store, "airspeedVisible", "airspeed-btn");
  syncToggleButton(store, "airportsVisible", "airports-btn");
  syncToggleButton(store, "aviationVisible", "aviation-btn");
  syncLegend(store, "airspeedVisible", "airspeed-legend");
  followLayerVisibility(asMapApp(app));
}

/**
 * Give the window a device pixel ratio. jsdom's own value (1) is a property
 * of the window, so a test sets it back with `setDevicePixelRatio(1)` rather
 * than deleting it: a deleted one reads as undefined, and every comparison
 * against it then quietly takes the other branch in whatever test runs next.
 */
export function setDevicePixelRatio(ratio: number): void {
  Object.defineProperty(window, "devicePixelRatio", {
    value: ratio,
    configurable: true,
  });
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

/** The animation frames a test has stubbed, run by hand */
export interface StubbedAnimationFrames {
  /** Run the frames asked for so far; ones they ask for wait for the next run */
  run(): void;
  /** How many frames are waiting */
  pending(): number;
}

/**
 * Replace requestAnimationFrame and cancelAnimationFrame with a queue the
 * test runs itself. Undone by `vi.unstubAllGlobals()`.
 */
export function stubAnimationFrames(): StubbedAnimationFrames {
  const frames = new Map<number, FrameRequestCallback>();
  let handle = 0;
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((callback: FrameRequestCallback) => {
      frames.set(++handle, callback);
      return handle;
    }),
  );
  vi.stubGlobal(
    "cancelAnimationFrame",
    vi.fn((id: number) => frames.delete(id)),
  );
  return {
    run() {
      const due = [...frames.values()];
      frames.clear();
      for (const frame of due) frame(0);
    },
    pending: () => frames.size,
  };
}
