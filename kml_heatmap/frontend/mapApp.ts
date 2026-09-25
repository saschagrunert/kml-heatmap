/**
 * Main Map Application
 * This is the main entry point that initializes all managers and handles the application lifecycle
 */

import {
  AttributionControl,
  Map as MapLibreMap,
  type LngLat,
  type LngLatBoundsLike,
  type MapMouseEvent,
  type RequestTransformFunction,
  type StyleSpecification,
} from "maplibre-gl";
import { DataManager } from "./ui/dataManager";
import { BOOLEAN_KEYS, StateManager } from "./ui/stateManager";
import { LayerManager } from "./ui/layerManager";
import { FilterManager } from "./ui/filterManager";
import { StatsManager } from "./ui/statsManager";
import { PathSelection } from "./ui/pathSelection";
import { AirportManager } from "./ui/airportManager";
import { MapOrientation } from "./ui/mapOrientation";

import { UIToggles } from "./ui/uiToggles";
import {
  followLayerVisibility,
  followSatelliteSwitch,
} from "./ui/layerVisibility";
import { followSelectionHighlight } from "./ui/selectionHighlight";
import { MobileBar } from "./ui/mobileBar";
import { bindActions } from "./ui/actions";
import { loadInitialData } from "./appInitializer";
import { logError } from "./utils/logger";
import { dismissToast, showToast } from "./utils/toast";
import { domCache } from "./utils/domCache";
import { syncLegend, syncToggleButton } from "./utils/buttonState";
import { applyGradientTokens } from "./utils/colors";
import { renderControlIcons } from "./utils/icons";
import {
  createActivationFilter,
  isOnMarker,
  isReplayCameraMove,
  keepMarkerTapsFromZoom,
  resizeMapAfterTransition,
  stateZoomToMap,
  toBounds,
  toLngLat,
  whenStyleReady,
} from "./utils/mapHelpers";
import { prefersReducedMotion } from "./utils/motion";
import {
  DEFAULT_ZOOM,
  HEATMAP_LAYER_IDS,
  MAP_LAYERS,
  MAP_MAX_PITCH,
  MAP_SKY,
  MAP_MAX_ZOOM,
  MAP_MIN_ZOOM,
} from "./utils/constants";
import {
  addDataLayers,
  setBaseStyle,
  AirportLayerHandle,
  MapLayerHandle,
} from "./mapLayers";
import {
  AppStore,
  createDefaultState,
  DEFAULT_AIRSPEED_RANGE,
  DEFAULT_ALTITUDE_RANGE,
  defineStoreAccessors,
  type Range,
} from "./state/store";
import { ReplayState } from "./ui/replayState";
import { watchScrollEnd, type ScrollEndWatcher } from "./utils/scrollFade";
import { loadFeatures, loadWrapped } from "./services/featureLoader";
import { updateReplayButtonState } from "./ui/replayButton";
import { segmentsForPathIds } from "./calculations/statistics";
import {
  datasetIndex,
  type PathIdsByAirport,
} from "./calculations/datasetIndex";
import type { StoreAccessors } from "./state/store";
import type { ReplayManager } from "./ui/replayManager";
import type { WrappedManager } from "./ui/wrappedManager";
import type {
  AircraftModels,
  AirportMarker,
  LayerHandle,
  PathInfo,
  PathSegment,
  Airport,
  AppState,
} from "./types";

/**
 * Map configuration passed to constructor
 */
export interface MapConfig {
  center: [number, number];
  bounds: [[number, number], [number, number]];
  cartoApiKey?: string | undefined;
  dataDir: string;
  /** When the site was built, "YYYY-MM-DDTHH:MMZ" in UTC */
  builtAt?: string | undefined;
  /** Short hash of the commit the site was built from, "" when unknown */
  commit?: string | undefined;
  /** The commit's page, "" when the repository it is in is unknown */
  commitUrl?: string | undefined;
}

/**
 * Airport to paths mapping
 */
export type AirportToPathsMap = PathIdsByAirport;

/**
 * Airport markers mapping
 */
export interface AirportMarkersMap {
  [airportName: string]: AirportMarker;
}

/**
 * The CARTO vector style that replaces the raster `dark_all` tiles. The
 * style, its tiles, glyphs and sprite all come from hosts under
 * basemaps.cartocdn.com.
 */
const CARTO_STYLE_URL =
  "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";
const CARTO_HOST = /(^|\.)basemaps\.cartocdn\.com$/;

/** The base style, with the API key when the site was built with one */
function cartoStyleUrl(apiKey?: string): string {
  return apiKey
    ? `${CARTO_STYLE_URL}?key=${encodeURIComponent(apiKey)}`
    : CARTO_STYLE_URL;
}

/**
 * Put the API key on every request to CARTO, not only on the style. CARTO
 * documents the key for the style URL, but the requests that count against
 * the quota are the tiles, and the style names those without it.
 */
export function cartoTransformRequest(
  apiKey?: string,
): RequestTransformFunction | null {
  if (!apiKey) return null;
  return (url) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      // Relative, so one of the site's own files
      return undefined;
    }
    if (!CARTO_HOST.test(parsed.hostname) || parsed.searchParams.has("key")) {
      return undefined;
    }
    // Appended by hand, so the rest of the URL stays byte for byte what
    // MapLibre asked for
    const separator = url.includes("?") ? "&" : "?";
    return { url: `${url}${separator}key=${encodeURIComponent(apiKey)}` };
  };
}

/**
 * What the map starts on, and stays on when the base style cannot be
 * fetched: the page background and nothing else. It needs no network, so
 * the flights are drawn without waiting for CARTO, whose style is swapped
 * in under them when it arrives (see `loadBaseStyle`). The colour is the
 * one of that style's background layer and of `#map` (--color-map-bg).
 */
export const FALLBACK_STYLE: StyleSpecification = {
  version: 8,
  sky: MAP_SKY,
  sources: {},
  layers: [
    {
      id: "background",
      type: "background",
      paint: { "background-color": "#0e0e0e" },
    },
  ],
};

/** The flags of a saved state that `restoreState` leaves to others */
const RESTORED_LATER: readonly string[] = [
  "isolateSelection",
  "statsPanelVisible",
  "wrappedVisible",
];

/** Padding around the flights when the view is fitted to all of them */
const START_VIEW_PADDING = 30;

/** Delay before a Wrapped panel restored from state opens again */
const WRAPPED_RESTORE_DELAY_MS = 500;

/**
 * How long after a failed request the base style is asked for once more. A
 * connection that was reset or a CDN node that answered 5xx is usually fine
 * a moment later; whatever still fails then is not cured by asking again,
 * except by the network coming back, which `online` reports.
 */
export const BASE_STYLE_RETRY_MS = 5_000;

/**
 * Said when the feature bundle or the Wrapped bundle cannot be fetched.
 * Without it a click on Replay or Wrapped would do nothing at all and look
 * like a dead control; the export button says the same kind of thing when
 * html-to-image is missing.
 */
export const REPLAY_UNAVAILABLE_MESSAGE =
  "Replay is unavailable: its code could not be loaded";
export const WRAPPED_UNAVAILABLE_MESSAGE =
  "Wrapped is unavailable: its code could not be loaded";

/**
 * How long the map may take to draw once the data is in. The map draws
 * through its worker; a worker that failed to start only says so in the
 * console, and the page would otherwise show an empty map and nothing else.
 */
export const MAP_STALL_MS = 20_000;

/** Said when the map has not finished drawing after MAP_STALL_MS */
export const MAP_STALL_MESSAGE =
  "The map is taking long to draw. If it stays empty, reload the page.";

/** A failure whose message is for the user, shown in place of the map */
export class UnsupportedBrowserError extends Error {}

export class MapApp {
  // Observable state store
  readonly store: AppStore;

  // Store-backed properties. The accessors are defined once on the
  // prototype by `defineStoreAccessors` below; these declarations only
  // give them their types (see STORE_ACCESSOR_KEYS for the list).
  declare selectedYear: StoreAccessors["selectedYear"];
  declare selectedAircraft: StoreAccessors["selectedAircraft"];
  declare selectedPathIds: StoreAccessors["selectedPathIds"];
  declare isolateSelection: StoreAccessors["isolateSelection"];
  declare heatmapVisible: StoreAccessors["heatmapVisible"];
  declare altitudeVisible: StoreAccessors["altitudeVisible"];
  declare airspeedVisible: StoreAccessors["airspeedVisible"];
  declare airportsVisible: StoreAccessors["airportsVisible"];
  declare aviationVisible: StoreAccessors["aviationVisible"];
  declare globeVisible: StoreAccessors["globeVisible"];
  declare threeDVisible: StoreAccessors["threeDVisible"];
  declare satelliteVisible: StoreAccessors["satelliteVisible"];
  declare terrainActive: StoreAccessors["terrainActive"];
  declare reliefShaded: StoreAccessors["reliefShaded"];
  declare reliefLevel: StoreAccessors["reliefLevel"];
  declare replayActive: StoreAccessors["replayActive"];
  declare currentData: StoreAccessors["currentData"];
  declare hasTimingData: StoreAccessors["hasTimingData"];

  // Plain values nothing has to follow: they are read where they are used,
  // so the store would only announce changes nobody listens to
  /** Model names from metadata.json; empty until it has loaded */
  aircraftModels: AircraftModels = {};
  /** Colour range of the altitude layer, replaced by every layer build */
  altitudeRange: Range = { ...DEFAULT_ALTITUDE_RANGE };
  /** Colour range of the speed layer, from metadata.json */
  airspeedRange: Range = { ...DEFAULT_AIRSPEED_RANGE };

  // Every manager is handed the whole app, so whatever stays writable below
  // is writable from all of them. The fields that nothing reassigns after
  // the constructor say so, which leaves the compiler enforcing a mutable
  // surface of the map, the two fields the managers do write, and the
  // managers themselves.

  // Configuration
  readonly config: MapConfig;

  // Non-store state
  allAirportsData: Airport[];
  isInitializing: boolean;
  /** Set by destroy(), so work that was already in flight can stand down */
  private destroyed = false;
  /**
   * Aborted by destroy(). DOM listeners the app and its managers add for
   * as long as the app lives pass its signal, so one call removes them all.
   */
  private readonly lifetime = new AbortController();
  /** Set while a click on Replay waits for the feature bundle */
  private pendingReplayToggle: Promise<void> | null = null;
  /**
   * Where the last fit to the start view takes the camera: the one of a
   * first visit, measured as the map opens, then that of every Reset view.
   * Undefined for a map that has no room to fit anything into.
   */
  private startCamera: ReturnType<MapLibreMap["cameraForBounds"]>;
  /** The map events setupEventHandlers() listens to, kept to remove them */
  private mapHandlers: {
    moveend?: (e: object) => void;
    zoomend?: (e: object) => void;
    click?: (e: MapMouseEvent) => void;
  } = {};

  // Map and layers
  map: MapLibreMap | null;
  /**
   * Resolves with the map once its style has loaded and every source and
   * layer of MAP_SOURCES and MAP_LAYERS exists, empty. That style is
   * FALLBACK_STYLE, which needs no network, so the base style of CARTO
   * neither delays it nor can fail it. It rejects when the layers
   * themselves cannot be added, which fails `initialize()` and is reported
   * like any other failure of the start-up, and when the app is destroyed
   * first, so nothing waits on it for good.
   * `initialize()` waits for it before the first data is loaded, so code
   * that runs from there on may use the sources directly; anything that can
   * run earlier (a constructor, a click during the load) goes through this.
   */
  readonly mapReady: Promise<MapLibreMap>;
  /** What `destroy()` rejects `mapReady` with, to be told from a failure */
  private readonly destroyedReason = new Error(
    "the app was destroyed before the map was ready",
  );
  private resolveMapReady!: (map: MapLibreMap) => void;
  private rejectMapReady!: (reason: unknown) => void;
  /** Where the request for the base style stands; "idle" before and between */
  private baseStyle: "idle" | "loading" | "loaded" = "idle";
  /** Whether the one timed retry of the base style has been spent */
  private baseStyleRetried = false;
  /** Takes back `keepMarkerTapsFromZoom`, set with the map */
  private releaseMarkerTaps: (() => void) | null = null;
  /**
   * The clicks on airport labels that activate them: the second click of a
   * double click or tap would close the popup the first one opened, as it
   * would on a marker (see createActivationFilter)
   */
  private readonly isLabelActivation = createActivationFilter();

  // Handles of the layers the map is created with. The layers are never
  // added or removed; the handles switch their visibility.
  readonly heatmapLayer: LayerHandle;
  readonly aviationLayer: LayerHandle;
  readonly altitudeLayer: LayerHandle;
  readonly airspeedLayer: LayerHandle;
  readonly airportLayer: LayerHandle;
  readonly selectionHighlightLayer: LayerHandle;
  /** The same six, for attaching them to the map in one go */
  private readonly layerHandles: MapLayerHandle[];

  // Airport markers (non-store)
  readonly airportMarkers: AirportMarkersMap;

  /**
   * Replay state. It lives here rather than in the replay manager because
   * the app reads it on every map click and layer redraw, which must not
   * depend on whether the feature bundle has been fetched.
   */
  readonly replayState: ReplayState;

  // Saved state
  savedState: AppState | null;
  restoredYearFromState: boolean;
  /** The year a first visit opens on: the newest one, see resolveYearSelection */
  defaultYear = "all";

  // Managers (initialized in initialize(), always available after construction)
  stateManager!: StateManager;
  dataManager!: DataManager;
  layerManager!: LayerManager;
  filterManager!: FilterManager;
  statsManager!: StatsManager;
  pathSelection!: PathSelection;
  airportManager!: AirportManager;
  mapOrientation!: MapOrientation;
  /**
   * Replay and Wrapped live in lazily loaded bundles, so these are
   * undefined until the user first opens one. Reach them through
   * `loadReplay()` / `loadWrapped()`; read them directly only where the
   * feature must already be open for the code to run at all.
   */
  replayManager?: ReplayManager | undefined;
  wrappedManager?: WrappedManager | undefined;
  uiToggles!: UIToggles;
  mobileBar!: MobileBar | null;

  /** Pending reopening of a Wrapped panel that was open when state was saved */
  private wrappedRestoreTimer: ReturnType<typeof setTimeout> | null = null;

  /** Scroll-end watchers of the two control columns */
  private columnScrollWatchers: ScrollEndWatcher[] = [];

  /** Aborts once the app is destroyed; for listeners that live as long */
  get signal(): AbortSignal {
    return this.lifetime.signal;
  }

  /** Path info of the loaded dataset (single source of truth: currentData) */
  get fullPathInfo(): PathInfo[] | null {
    return this.currentData?.path_info ?? null;
  }

  /** Segments of the loaded dataset (single source of truth: currentData) */
  get fullPathSegments(): PathSegment[] | null {
    return this.currentData?.path_segments ?? null;
  }

  /**
   * Paths per airport among the flights the year/aircraft filter keeps. A
   * click on an airport selects these, so it never picks a flight the map
   * does not show.
   */
  get airportToPaths(): AirportToPathsMap {
    const data = this.currentData;
    // No prototype, like the index's own: an airport name is data
    if (!data) return Object.create(null) as AirportToPathsMap;
    return datasetIndex(data)
      .filter(this.selectedYear, this.selectedAircraft)
      .pathIdsByAirport();
  }

  constructor(config: MapConfig) {
    this.store = new AppStore();
    this.config = config;

    // Non-store state
    this.allAirportsData = [];
    this.isInitializing = true;

    // Map and layers
    this.map = null;
    this.mapReady = new Promise((resolve, reject) => {
      this.resolveMapReady = resolve;
      this.rejectMapReady = reject;
    });
    // Whoever waits for the map handles its failure. Destroyed before anyone
    // does, the rejection would otherwise count as unhandled.
    this.mapReady.catch(() => {});
    const heatmap = new MapLayerHandle(HEATMAP_LAYER_IDS);
    const aviation = new MapLayerHandle([MAP_LAYERS.aviation]);
    // The lines first: the e2e driver reads a mode's layer off the front
    const altitude = new MapLayerHandle([
      MAP_LAYERS.pathsAltitude,
      MAP_LAYERS.pathsAltitudeSelected,
      MAP_LAYERS.pathsAltitudeRibbons,
      MAP_LAYERS.pathsAltitudeSelectedRibbons,
    ]);
    const airspeed = new MapLayerHandle([
      MAP_LAYERS.pathsAirspeed,
      MAP_LAYERS.pathsAirspeedSelected,
      MAP_LAYERS.pathsAirspeedRibbons,
      MAP_LAYERS.pathsAirspeedSelectedRibbons,
    ]);
    const airports = new AirportLayerHandle();
    const highlight = new MapLayerHandle([MAP_LAYERS.selectionHighlight]);
    this.heatmapLayer = heatmap;
    this.aviationLayer = aviation;
    this.altitudeLayer = altitude;
    this.airspeedLayer = airspeed;
    this.airportLayer = airports;
    this.selectionHighlightLayer = highlight;
    this.layerHandles = [
      heatmap,
      aviation,
      altitude,
      airspeed,
      airports,
      highlight,
    ];

    // Airport markers (non-store)
    this.airportMarkers = {};

    this.replayState = new ReplayState();

    // Saved state
    this.savedState = null;
    this.restoredYearFromState = false;
  }

  async initialize(): Promise<void> {
    this.restoreState();
    this.setupMap();
    this.initializeManagers();
    this.setupButtonSync();
    this.setupStatsRail();

    // The data goes into sources that only exist once the style has loaded.
    // The files are preloaded by the template, so waiting here does not hold
    // their download back.
    try {
      await this.mapReady;
    } catch (error) {
      // Destroyed while waiting: `destroy()` settled the wait, and nothing
      // failed. Asked of the state, so a layer failure that races a destroy
      // does not tear down a second time; but such a failure is one all
      // the same, and with nobody left to show it to it is at least logged.
      if (this.destroyed) {
        if (error !== this.destroyedReason) logError(error);
        return;
      }
      // The controls are bound by now and the managers listen to the store.
      // None of them may go on acting on a map that has no layers, and the
      // failure notice takes the map's place, so the map goes as well.
      this.destroy();
      this.map?.remove();
      this.map = null;
      throw error;
    }
    if (this.destroyed) return;

    // Load airports and metadata
    await loadInitialData(this);
    if (this.map) this.watchMapStall(this.map);

    // Setup map event handlers
    this.setupEventHandlers();

    // Mark initialization as complete. Reset view waited for it.
    this.isInitializing = false;
    this.syncResetButton();

    // Restore wrapped panel state if it was open
    const state = this.savedState;
    if (state && state.wrappedVisible) {
      this.wrappedRestoreTimer = setTimeout(() => {
        this.wrappedRestoreTimer = null;
        void this.loadWrapped()
          .then((manager) => {
            // The bundle may arrive after the app was torn down
            if (this.destroyed) return;
            manager?.showWrapped();
            // Opened or not, the restore is done: saves stop writing the
            // flag it had (see StateManager.panelVisible)
            delete state.wrappedVisible;
          })
          .catch(logError);
      }, WRAPPED_RESTORE_DELAY_MS);
    }

    // Apply filter changes made through the selects while loading
    await this.applyPendingFilterChanges();
  }

  /** Say so when the map has not drawn MAP_STALL_MS after the data came */
  private watchMapStall(map: MapLibreMap): void {
    const timer = setTimeout(() => {
      // A hidden tab draws nothing, and is no sign of a failure. Nor is a
      // map that has all it needs without having drawn since: no data came
      if (!this.destroyed && !document.hidden && !map.loaded()) {
        showToast(MAP_STALL_MESSAGE, "error");
      }
    }, MAP_STALL_MS);
    map.once("idle", () => {
      clearTimeout(timer);
      // An error stays until dismissed; this one is over once the map drew
      dismissToast(MAP_STALL_MESSAGE);
    });
  }

  /**
   * Cancel pending work and take down everything the app set up: the DOM
   * listeners (through the lifetime signal), the map events, every store
   * subscription and the chrome built at runtime. The map itself and the
   * layers on it stay as they are.
   */
  destroy(): void {
    this.destroyed = true;
    // `initialize()` may still be waiting for it. Nothing happens when the
    // map was ready already.
    this.rejectMapReady(this.destroyedReason);
    if (this.wrappedRestoreTimer !== null) {
      clearTimeout(this.wrappedRestoreTimer);
      this.wrappedRestoreTimer = null;
    }
    this.lifetime.abort();
    if (this.map) {
      const { moveend, zoomend, click } = this.mapHandlers;
      if (moveend) this.map.off("moveend", moveend);
      if (zoomend) this.map.off("zoomend", zoomend);
      if (click) this.map.off("click", click);
      this.map.off("moveend", this.syncResetButton);
      this.map.off("error", this.handleMapError);
    }
    this.releaseMarkerTaps?.();
    this.releaseMarkerTaps = null;
    this.mapHandlers = {};
    this.layerManager?.destroy();
    this.airportManager?.destroy();
    this.mapOrientation?.destroy();
    this.dataManager?.destroy();
    this.stateManager?.cancelSave();
    this.replayManager?.destroy();
    this.wrappedManager?.destroy();
    this.mobileBar?.destroy();
    for (const watcher of this.columnScrollWatchers) watcher.stop();
    this.columnScrollWatchers = [];
    this.store.unsubscribeAll();
  }

  /**
   * Year/aircraft select changes during initialization are ignored by the
   * bound handlers; apply them once the initial data is loaded.
   */
  private async applyPendingFilterChanges(): Promise<void> {
    const yearSelect = domCache.get("year-select", HTMLSelectElement);
    const aircraftSelect = domCache.get("aircraft-select", HTMLSelectElement);
    // Capture both before filtering: switching the year rebuilds the aircraft
    // dropdown and would otherwise overwrite a pending aircraft selection.
    // A dropdown that shows no year is one whose first load failed (see
    // loadInitialData), not one someone changed
    const pendingYear =
      yearSelect && yearSelect.value && yearSelect.value !== this.selectedYear
        ? yearSelect.value
        : null;
    const pendingAircraft =
      aircraftSelect && aircraftSelect.value !== this.selectedAircraft
        ? aircraftSelect.value
        : null;

    if (pendingYear !== null) {
      await this.filterManager.filterByYear();
    }

    if (pendingAircraft === null || !aircraftSelect) {
      return;
    }
    // The aircraft may not exist in the newly selected year
    const stillAvailable = Array.from(aircraftSelect.options).some(
      (option) => option.value === pendingAircraft,
    );
    if (!stillAvailable || pendingAircraft === this.selectedAircraft) {
      return;
    }
    aircraftSelect.value = pendingAircraft;
    this.filterManager.filterByAircraft();
  }

  private restoreState(): void {
    this.stateManager = new StateManager(this);
    this.savedState = this.stateManager.loadState();

    if (!this.savedState) return;

    const state = this.savedState;
    this.store.batch(() => {
      if (state.selectedYear !== undefined) {
        this.selectedYear = state.selectedYear;
        this.restoredYearFromState = true;
      }
      if (state.selectedAircraft) {
        this.selectedAircraft = state.selectedAircraft;
      }

      // Restore selected paths BEFORE updateLayers() so paths are drawn with correct selection
      if (state.selectedPathIds && state.selectedPathIds.length > 0) {
        state.selectedPathIds.forEach((pathId) => {
          this.selectedPathIds.add(pathId);
        });
        this.store.notifyMutation("selectedPathIds");
      }

      // Restore the layers and how the map is drawn. The panels reopen
      // once there is data for them (see initialize), and isolating needs
      // a selection (below).
      for (const key of BOOLEAN_KEYS) {
        const value = state[key];
        if (value !== undefined && !RESTORED_LATER.includes(key)) {
          this.store.set(key, value);
        }
      }
      // Altitude and speed colour the same paths, and the toggles never
      // leave both on (setColorLayer); a link written by hand, or with every
      // flag of `v` set, can. Altitude is the one kept, as it needs no
      // timing data.
      if (this.altitudeVisible && this.airspeedVisible) {
        this.airspeedVisible = false;
      }
      // Isolating nothing is not a state the controls can leave: a link
      // written before path ids were versioned drops its selection but still
      // carries the isolate flag
      if (state.isolateSelection !== undefined) {
        this.isolateSelection =
          state.isolateSelection && this.selectedPathIds.size > 0;
      }
    });
  }

  private setupMap(): void {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2");
    if (!gl) {
      throw new UnsupportedBrowserError(
        "WebGL 2 is not available. The map requires a browser with WebGL 2 support.",
      );
    }
    // Free the test context immediately
    gl.getExtension("WEBGL_lose_context")?.loseContext();

    // MapLibre runs every camera move through easeTo or flyTo and shortens
    // those to nothing under reduced motion, the app's own included; the
    // glide after a drag goes with them. It asks the media query itself on
    // every move as long as it is not given `reduceMotion`, so a change of
    // the setting takes effect without a reload. The tile and label fades
    // are the one animation it would still run, and are set here once.
    const animate = !prefersReducedMotion();

    // A saved zoom of 0 is a view like any other, not a missing one. A
    // link may carry a centre alone (written by hand, or cut short); it is
    // still where the reader was sent, so it gets the default zoom.
    const center = this.savedState?.center;
    const bearing = this.savedState?.bearing ?? 0;
    const savedZoom = this.savedState?.zoom;
    const view = center
      ? {
          center: toLngLat([center.lat, center.lng]),
          // Saved state counts zoom the way Leaflet did, one level above
          // the map's. A level below the map's range is a view from before
          // the switch that the map can no longer show.
          zoom:
            savedZoom === undefined
              ? DEFAULT_ZOOM
              : Math.max(MAP_MIN_ZOOM, stateZoomToMap(savedZoom)),
        }
      : {
          bounds: toBounds(this.config.bounds),
          // A fit turns the map north up unless it is told the bearing
          fitBoundsOptions: { padding: START_VIEW_PADDING, bearing },
        };

    // A style given as an object is taken in on the next animation frame,
    // so a tab opened in the background starts up once it is first shown
    const map = new MapLibreMap({
      container: "map",
      style: FALLBACK_STYLE,
      transformRequest: cartoTransformRequest(this.config.cartoApiKey),
      ...view,
      minZoom: MAP_MIN_ZOOM,
      maxZoom: MAP_MAX_ZOOM,
      // Pinch, scroll and double tap already zoom; a navigation control
      // only costs a corner of the map. The attribution is added below,
      // expanded: the default one collapses on a narrow map.
      attributionControl: false,
      // The map turns and tilts by MapLibre's own gestures (right or ctrl
      // drag, two fingers, shift with the arrow keys); the compass of
      // MapOrientation brings it back. A view opens north up and flat
      // unless the link or the saved state says otherwise.
      bearing,
      pitch: this.savedState?.pitch ?? 0,
      maxPitch: MAP_MAX_PITCH,
      fadeDuration: animate ? 300 : 0,
    });
    map.addControl(new AttributionControl({ compact: false }), "bottom-right");
    followAttributionHeight(map);
    this.map = map;
    // A first visit has just been fitted to it, and a saved view or a link
    // may show the very same (see isReset)
    this.measureStartView(map);
    // An airport's label opens its popup like the marker does, so a double
    // click or tap on it does not zoom either
    this.releaseMarkerTaps = keepMarkerTapsFromZoom(
      map,
      (point) => this.airportManager?.airportLabelAt(point) != null,
    );

    // Registered before anything can fail. Without a listener MapLibre
    // writes every error to the console itself.
    map.on("error", this.handleMapError);

    // For as long as the app lives, like its other DOM listeners
    const mapCanvas = map.getCanvas();
    const lifetime = { signal: this.signal };
    const interrupted = "Map rendering interrupted, restoring…";
    mapCanvas.addEventListener(
      "webglcontextlost",
      (e) => {
        e.preventDefault();
        logError("WebGL context lost");
        showToast(interrupted, "error");
      },
      lifetime,
    );
    mapCanvas.addEventListener(
      "webglcontextrestored",
      () => {
        // An error stays until dismissed, and this one has put itself right
        dismissToast(interrupted);
        showToast("Map rendering restored", "info");
      },
      lifetime,
    );

    whenStyleReady(map)
      .then(() => {
        // Destroyed within the frame the style takes: `mapReady` is settled
        // and there is nobody to add the layers for
        if (this.destroyed) return;
        addDataLayers(map);
        for (const handle of this.layerHandles) handle.attach(map);
        this.resolveMapReady(map);
        // Only now: the swap carries over the layers that were just added
        void this.loadBaseStyle();
        window.addEventListener(
          "online",
          () => {
            // A new network is worth a full round, timed retry included
            this.baseStyleRetried = false;
            void this.loadBaseStyle();
          },
          { signal: this.signal },
        );
      })
      // A layer the style refuses throws in here. `initialize` waits for
      // `mapReady`, so without this it would wait forever and the page would
      // show an empty map with no word of why.
      .catch((error: unknown) => this.rejectMapReady(error));
  }

  /**
   * Fetch CARTO's style and put it under the flights, however late it
   * answers: nothing waits for it, so there is no time limit to give up at.
   * The app fetches it rather than the map, so that `destroy()` can abort
   * the request and a failure is known to be this one. It is asked for a
   * second time after BASE_STYLE_RETRY_MS and whenever the browser comes
   * back online; until then the map stays on FALLBACK_STYLE.
   *
   * `setStyle` compares the new style with the one on the map and applies
   * the difference. `withDataLayers` puts the app's sources and layers into
   * the new style as they are, their data left out, so for them there is
   * none: the sources keep their data and their tiles, the layers their
   * filters, visibility and paint, and a `setData` that is on its way lands
   * as if nothing happened (see setBaseStyle).
   */
  private async loadBaseStyle(): Promise<void> {
    const map = this.map;
    if (this.baseStyle !== "idle" || this.destroyed || !map) return;
    this.baseStyle = "loading";
    try {
      const response = await fetch(cartoStyleUrl(this.config.cartoApiKey), {
        signal: this.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const style = (await response.json()) as StyleSpecification;
      // `destroy()` leaves the map as it is, also for an answer that was
      // already being read when the request was aborted
      if (this.destroyed) return;
      this.baseStyle = "loaded";
      setBaseStyle(map, style);
    } catch (error) {
      if (this.destroyed) return;
      this.baseStyle = "idle";
      const message = error instanceof Error ? error.message : String(error);
      logError(`Base map style failed to load: ${message}`);
      if (this.baseStyleRetried) return;
      this.baseStyleRetried = true;
      setTimeout(() => void this.loadBaseStyle(), BASE_STYLE_RETRY_MS);
    }
  }

  /**
   * Report what the map could not load. A tile or a glyph that fails leaves
   * a hole and nothing more, and the base style is not the map's to load.
   */
  private readonly handleMapError = (e: { error?: unknown }): void => {
    const error = e.error;
    const message = error instanceof Error ? error.message : String(error);
    logError(`Map error: ${message}`);
  };

  /**
   * The store drives the toggle buttons and the colour legends: initial
   * state and every change are reflected in aria-pressed, the active class
   * and the legend visibility. The heatmap's toggle and the altitude scale
   * also depend on whether a replay runs, so they follow the layers (see
   * ui/layerVisibility.ts).
   */
  private setupButtonSync(): void {
    syncToggleButton(this.store, "altitudeVisible", "altitude-btn");
    syncToggleButton(this.store, "airspeedVisible", "airspeed-btn");
    syncToggleButton(this.store, "airportsVisible", "airports-btn");
    syncToggleButton(this.store, "aviationVisible", "aviation-btn");
    syncToggleButton(this.store, "globeVisible", "globe-btn");
    syncToggleButton(this.store, "threeDVisible", "three-d-btn");
    syncToggleButton(this.store, "satelliteVisible", "satellite-btn");
    syncLegend(this.store, "airspeedVisible", "airspeed-legend");
    // The isolate button depends on two keys, so PathSelection owns it
  }

  /**
   * Open and close the statistics rail. The rail turns the left column into
   * a single row of icon-only buttons and takes the space beside the map,
   * so the map is told to remeasure once the layout has changed.
   */
  private setupStatsRail(): void {
    const apply = (visible: boolean): void => {
      const rail = domCache.get("stats-rail");
      if (rail) {
        // The collapse button hides itself, so focus has to leave the rail
        // before it does; otherwise it falls back to <body>
        if (!visible) restoreFocusFromRail(rail, this.map);
        rail.hidden = !visible;
      }

      // Both triggers are a disclosure for the rail, not a pressed toggle;
      // only the one that stays on screen carries the active treatment
      for (const id of ["stats-btn", "stats-collapse-btn"]) {
        domCache.get(id)?.setAttribute("aria-expanded", String(visible));
      }
      domCache.get("stats-btn")?.classList.toggle("active", visible);

      document.body.classList.toggle("stats-open", visible);
      resizeMapAfterTransition(this.map, document.getElementById("map"));
    };

    apply(this.store.get("statsPanelVisible"));
    this.store.subscribe("statsPanelVisible", apply);
  }

  private initializeManagers(): void {
    this.dataManager = new DataManager(this);
    this.layerManager = new LayerManager(this);
    this.filterManager = new FilterManager(this);
    this.statsManager = new StatsManager(this);
    this.pathSelection = new PathSelection(this);
    this.airportManager = new AirportManager(this);
    this.mapOrientation = new MapOrientation(this);
    this.uiToggles = new UIToggles(this);
    this.mobileBar = MobileBar.mountFor(this);
    followLayerVisibility(this);
    followSatelliteSwitch(this);
    followSelectionHighlight(this);
    this.followReplayAvailability();
    this.store.subscribeKeys(
      [
        ...BOOLEAN_KEYS,
        "selectedYear",
        "selectedAircraft",
        "selectedPathIds",
        "currentData",
        "replayActive",
      ],
      this.syncResetButton,
    );
    this.map?.on("moveend", this.syncResetButton);
    this.syncResetButton();
    this.followColumnScrollEnd();
  }

  /**
   * Go back to what a first visit shows: the newest year, every aircraft,
   * the heatmap and the airports, nothing selected or isolated, flat and
   * north up over all the flights. It goes through the year filter, so the
   * dropdowns, the loaded data and the store change together in one batch;
   * the saved state and the link follow the store and the camera as ever.
   * Out of reach during a replay, like the filters: the button is disabled
   * (REPLAY_DISABLED_CONTROL_IDS) and the phone's bar steps aside.
   */
  async resetView(): Promise<void> {
    // Like Isolate with nothing selected: unavailable, and a press does
    // nothing (see syncResetButton)
    if (!this.canResetView()) return;
    const defaults = createDefaultState();
    const applied = await this.filterManager.filterByYear(
      this.defaultYear,
      () => {
        // The selection goes with the year switch, as with every filter
        for (const key of [...BOOLEAN_KEYS, "selectedAircraft"] as const) {
          this.store.set(key, defaults[key]);
        }
      },
    );
    // A reset happens whole or not at all. Replaced by a newer filter
    // change, the view is that change's now, camera included. Failed to
    // load, the loader has said so and the store is untouched; resetting
    // the rest over the old year would leave neither the view the visitor
    // had nor the one asked for, while leaving it all as it was keeps the
    // button available to try again.
    if (!applied) return;
    // Measured first, as the fit itself does, and compared once it is over:
    // the moves of its animation end in the camera it aims at.
    const map = this.map;
    map?.fitBounds(this.measureStartView(map), {
      padding: START_VIEW_PADDING,
      pitch: 0,
    });
  }

  /** The bounds of the start view, and where a fit to them will end */
  private measureStartView(map: MapLibreMap): LngLatBoundsLike {
    const bounds = toBounds(this.config.bounds);
    this.startCamera = map.cameraForBounds(bounds, {
      padding: START_VIEW_PADDING,
    });
    return bounds;
  }

  /**
   * Whether Reset view can be pressed: once the first load is over, and
   * while it would change something
   */
  canResetView(): boolean {
    return !this.isInitializing && !this.isReset();
  }

  /**
   * Whether Reset view would change nothing: every key it sets has the
   * value it sets, and the camera is where the last fit to the start view
   * took it, north up and flat. The camera is compared within what a link
   * rounds it to (state/urlState.ts), so a link to the start view, or a
   * reload of it, still opens on it; a pan, a zoom, a turn or a tilt
   * leaves it, and a resize or Wrapped's round trip does not. A page whose
   * year failed to load is not what a first visit shows, so Reset view is
   * the way to try again there.
   */
  isReset(): boolean {
    const map = this.map;
    const start = this.startCamera;
    if (!map || !start || !this.currentData) return false;
    const defaults = createDefaultState();
    const center = map.getCenter();
    const target = start.center as LngLat;
    return (
      this.selectedYear === this.defaultYear &&
      this.selectedAircraft === "all" &&
      this.selectedPathIds.size === 0 &&
      BOOLEAN_KEYS.every((key) => this.store.get(key) === defaults[key]) &&
      Math.abs(center.lng - target.lng) + Math.abs(center.lat - target.lat) <
        2e-6 &&
      Math.abs(map.getZoom() - start.zoom!) < 0.01 &&
      Math.abs(map.getBearing()) + Math.abs(map.getPitch()) < 0.2
    );
  }

  togglePathSelection(pathId: string): void {
    this.pathSelection.togglePathSelection(Number(pathId));
  }

  seekReplay(value: string): void {
    // Only reachable from the replay panel, which exists once replay is on
    this.replayManager?.seekReplay(value);
  }

  /**
   * Whether the current selection can be replayed: one flight with a
   * segment timed after its start. Replay runs from 0 to the latest segment
   * time, so a flight whose times are all 0 (a single timed segment, or
   * points logged at the same second) finished the moment it started and
   * drew nothing.
   */
  canReplay(): boolean {
    const segments = this.fullPathSegments;
    return (
      this.selectedPathIds.size === 1 &&
      this.hasTimingData &&
      !!segments &&
      segmentsForPathIds(segments, this.selectedPathIds).some(
        (segment) => (segment.time ?? 0) > 0,
      )
    );
  }

  /**
   * Open or close replay, fetching the feature bundle on first use. Clicks
   * that land while the bundle is still on its way are dropped: each one
   * queued a toggle of its own, and two quick ones opened replay and closed
   * it again the moment the bundle arrived.
   */
  toggleReplay(): void {
    if (this.replayManager) {
      this.replayManager.toggleReplay();
      return;
    }
    this.pendingReplayToggle ??= this.loadReplay()
      .then((manager) => {
        this.pendingReplayToggle = null;
        if (!this.destroyed) manager?.toggleReplay();
      })
      .catch((error) => {
        this.pendingReplayToggle = null;
        logError(error);
      });
  }

  /**
   * Keep the replay control showing whether replay is available. It has to
   * say so from the first paint, so the app owns it rather than the replay
   * manager, which is only fetched once someone opens replay.
   */
  private followReplayAvailability(): void {
    // A running replay owns the button (it is pressed); it is back in step
    // with the selection as the replay closes
    const refresh = (): void => {
      if (!this.replayActive) updateReplayButtonState(this.canReplay());
    };
    this.store.subscribeKeys(
      ["selectedPathIds", "hasTimingData", "currentData", "replayActive"],
      refresh,
    );
    refresh();
  }

  /**
   * Show Reset view unavailable while the page is what it would make of it,
   * or still loading, the way Isolate and Replay are: aria-disabled, which
   * the stylesheet dims, but still in the tab order. It runs for the keys
   * Reset view sets, the data (a first visit's year is only known with it),
   * the end of the first load and the end of every camera move, the fit's
   * own included (see initializeManagers). A replay disables the button
   * outright, and closing it runs this again.
   */
  private readonly syncResetButton = (): void => {
    const button = domCache.get("reset-view-btn");
    if (!button || this.replayActive) return;
    button.setAttribute("aria-disabled", String(!this.canResetView()));
  };

  /**
   * Fade the bottom of a control column that has more below the fold.
   *
   * The columns are fixed, so in a window shorter than they are they scroll
   * themselves rather than with the page. The same treatment the statistics
   * panel gets: without it the column simply stops at the bottom of the
   * screen, as often as not through the middle of a row, and nothing says
   * the last control is still down there.
   */
  private followColumnScrollEnd(): void {
    for (const id of ["left-buttons", "right-buttons"]) {
      const column = domCache.get(id);
      if (column) this.columnScrollWatchers.push(watchScrollEnd(column));
    }
  }

  /**
   * A lazy bundle, or null when it could not be fetched. A failure is
   * reported here rather than at each call site, so every way into Replay
   * or Wrapped says the same thing instead of doing nothing.
   */
  private async loadLazyBundle<T>(
    load: () => Promise<T | null>,
    unavailable: string,
  ): Promise<T | null> {
    const bundle = await load();
    // The failure of an earlier try stays until dismissed, and would say
    // the code is unavailable over the panel it has just opened
    if (bundle) dismissToast(unavailable);
    else showToast(unavailable, "error");
    return bundle;
  }

  /**
   * The replay manager, fetching the feature bundle on first use. Resolves
   * with undefined when the bundle cannot be loaded.
   */
  async loadReplay(): Promise<ReplayManager | undefined> {
    if (!this.replayManager) {
      const features = await this.loadLazyBundle(
        loadFeatures,
        REPLAY_UNAVAILABLE_MESSAGE,
      );
      // Another caller may have finished the same load in the meantime
      this.replayManager ??= features
        ? new features.ReplayManager(this)
        : undefined;
    }
    return this.replayManager;
  }

  /**
   * The Wrapped manager, fetching the Wrapped bundle (not the feature
   * bundle) on first use
   */
  async loadWrapped(): Promise<WrappedManager | undefined> {
    if (!this.wrappedManager) {
      const wrapped = await this.loadLazyBundle(
        loadWrapped,
        WRAPPED_UNAVAILABLE_MESSAGE,
      );
      this.wrappedManager ??= wrapped
        ? new wrapped.WrappedManager(this)
        : undefined;
    }
    return this.wrappedManager;
  }

  private setupEventHandlers(): void {
    if (!this.map) return;

    // Not for every frame of the replay's camera, which rests of its own
    // (see isReplayCameraMove)
    this.mapHandlers = {
      moveend: (e) => {
        if (!isReplayCameraMove(e)) this.stateManager.scheduleSave();
      },
      zoomend: (e) => {
        if (isReplayCameraMove(e)) return;
        this.stateManager.scheduleSave();
        this.airportManager.updateAirportMarkerSizes();
      },
      click: (e) => this.handleMapClick(e),
    };
    this.map.on("moveend", this.mapHandlers.moveend!);
    this.map.on("zoomend", this.mapHandlers.zoomend!);
    this.map.on("click", this.mapHandlers.click!);
  }

  /**
   * The one click handler of the map. Paths are pixels of a layer, not
   * objects with listeners of their own, so what a click means is decided
   * here: a flight under the pointer, or the map beside every flight.
   * Markers are DOM on top of the map, and MapLibre reports a click on one
   * as a click on the map: told by its target, it is none, and no marker
   * has to keep its clicks to itself. For the same reason no popup of the
   * app closes on a click by itself (`closeOnClick`), which would include
   * the click on the marker that has just opened it; they are closed from
   * here.
   */
  private handleMapClick(e: MapMouseEvent): void {
    if (isOnMarker(e)) return;
    // The overview of the Wrapped dialog is this map, and it takes gestures
    // so it can be moved. A click there is none on the main map: it must
    // not change the selection behind the dialog, nor open the values of a
    // flight, whose popup would be a tab stop outside the dialog.
    if (this.store.get("wrappedVisible")) return;

    // An airport's label is drawn by the map, and a click on it is one on
    // its marker (see ui/airportLabels.ts), replay or not
    const airport = this.airportManager.airportLabelAt(e.point);
    if (airport !== null) {
      if (this.isLabelActivation(e.originalEvent)) {
        this.airportManager.activateAirport(airport);
      }
      return;
    }

    const replay = this.replayState;
    if (this.replayActive) {
      // The colour layers are hidden during a replay; the only thing a
      // click on the map does is put the popups away
      this.airportManager.closePopup();
      if (replay.airplaneMarker?.isPopupOpen()) {
        replay.airplaneMarker.closePopup();
      }
      return;
    }

    const hit = this.layerManager.hitTest(e.point);
    // The tiles still show the data of before, so this may well be a click
    // on a flight. Clearing the selection would throw away the user's work
    // on a guess; doing nothing costs a second click at worst.
    if (hit === "stale") return;
    // From here on the click is acted on, and only then does it close what
    // a click on the map closes: an ignored click changes nothing at all
    this.airportManager.closePopup();
    if (hit) {
      this.layerManager.onPathClick(hit, e.lngLat);
      return;
    }
    // A click on the empty map: the values a tap left go with the selection
    this.layerManager.closeSegmentPopup();
    if (this.selectedPathIds.size > 0) {
      this.pathSelection.clearSelection();
    }
  }
}

defineStoreAccessors(MapApp.prototype);

/**
 * Hand focus to the first reachable statistics trigger when the rail that
 * holds it is about to be hidden. Without this the browser drops focus to
 * `<body>` and the next Tab restarts at the top of the document, ahead of
 * every focusable marker on the map.
 */
function restoreFocusFromRail(
  rail: HTMLElement,
  map: MapLibreMap | null,
): void {
  if (!rail.contains(document.activeElement)) return;
  // The mobile tab replaces the desktop button on small viewports
  for (const id of ["stats-btn", "mobile-tab-stats"]) {
    const trigger = domCache.get(id);
    if (!trigger || rail.contains(trigger)) continue;
    trigger.focus();
    if (document.activeElement === trigger) return;
  }
  // The map is the last resort: next to the controls in order. It is the
  // canvas that takes focus, the container around it does not.
  map?.getCanvas().focus();
}

/**
 * Keep --attribution-h at the height of the map's credit. The credit wraps
 * once a layer adds one of its own (see styles.css), and the legends, the
 * toasts and the phone's replay panel stand on top of it. A phone shows two
 * of its lines, and a tap on it beside its links all of them.
 */
function followAttributionHeight(map: MapLibreMap): void {
  const credit = map
    .getContainer()
    .querySelector<HTMLElement>(".maplibregl-ctrl-attrib");
  if (!credit) return;
  credit.addEventListener("click", (event) => {
    if (!(event.target as Element).closest("a")) {
      credit.classList.toggle("is-expanded");
    }
  });
  if (typeof ResizeObserver === "undefined") return;
  new ResizeObserver(() => {
    const height = credit.getBoundingClientRect().height;
    // Hidden while a sheet covers its corner: the chrome keeps its place
    if (height > 0) {
      document.documentElement.style.setProperty(
        "--attribution-h",
        `${height}px`,
      );
    }
  }).observe(credit);
}

/** Markup shown in place of the map when initialization fails */
export const INIT_ERROR_HTML =
  '<div class="kh-init-error" role="alert">Failed to initialize map. Please reload the page.</div>';

/**
 * Create the app, bind the controls and run the initial load. Exported so
 * the failure path can be exercised without a page load.
 */
export async function initMapApp(config: MapConfig): Promise<MapApp> {
  const app = new MapApp(config);
  window.mapApp = app;
  // The legend bar and the row chips paint --gradient-*, so publish the
  // ramps before anything that carries one is shown
  applyGradientTokens(document.documentElement);
  renderControlIcons();
  // Bind before the (long) initial load so early interactions are not lost
  bindActions(app);
  await app.initialize();
  return app;
}

/** Log the failure and tell the user, in place of a map that never came */
export function reportInitFailure(error: unknown): void {
  logError(error);
  const mapEl = document.getElementById("map");
  if (mapEl) {
    mapEl.innerHTML = INIT_ERROR_HTML;
    // Set as text: only a message of the app's own replaces the generic one
    if (error instanceof UnsupportedBrowserError) {
      mapEl.firstElementChild!.textContent = error.message;
    }
  }
}

// Initialize app and bind DOM event listeners
if (typeof window !== "undefined") {
  window.initMapApp = initMapApp;
}

// Auto-initialize when module loads
if (typeof window !== "undefined" && window.MAP_CONFIG && window.initMapApp) {
  window.initMapApp(window.MAP_CONFIG).catch(reportInitFailure);
}
