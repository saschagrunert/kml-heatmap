/**
 * Main Map Application
 * This is the main entry point that initializes all managers and handles the application lifecycle
 */

import * as L from "leaflet";
import { DataManager } from "./ui/dataManager";
import { StateManager } from "./ui/stateManager";
import { LayerManager } from "./ui/layerManager";
import { FilterManager } from "./ui/filterManager";
import { StatsManager } from "./ui/statsManager";
import { PathSelection } from "./ui/pathSelection";
import { AirportManager } from "./ui/airportManager";

import { UIToggles } from "./ui/uiToggles";
import { MobileBar } from "./ui/mobileBar";
import { bindActions } from "./ui/actions";
import { loadInitialData } from "./appInitializer";
import { logError } from "./utils/logger";
import { showToast } from "./utils/toast";
import { domCache } from "./utils/domCache";
import { syncLegend, syncToggleButton } from "./utils/buttonState";
import { applyGradientTokens } from "./utils/colors";
import { renderControlIcons } from "./utils/icons";
import { invalidateMapAfterTransition } from "./utils/mapHelpers";
import { prefersReducedMotion } from "./utils/motion";
import { MAX_ZOOM, MIN_ZOOM } from "./utils/constants";
import { AppStore, defineStoreAccessors } from "./state/store";
import { ReplayState } from "./ui/replayState";
import { loadFeatures } from "./services/featureLoader";
import type { FeatureModule } from "./features";
import { updateReplayButtonState } from "./ui/replayButton";
// Publishes the modules the feature bundle resolves against; imported for
// that side effect, before any feature can be loaded
import "./shared";
import {
  datasetIndex,
  type PathIdsByAirport,
} from "./calculations/datasetIndex";
import type { StoreAccessors } from "./state/store";
import type { ReplayManager } from "./ui/replayManager";
import type { WrappedManager } from "./ui/wrappedManager";
import type { HeatmapLayer } from "./globals";
import type { PathInfo, PathSegment, Airport, AppState } from "./types";

/**
 * Map configuration passed to constructor
 */
export interface MapConfig {
  center: [number, number];
  bounds: [[number, number], [number, number]];
  cartoApiKey?: string | undefined;
  openaipApiKey?: string | undefined;
  dataDir: string;
}

/**
 * Airport to paths mapping
 */
export type AirportToPathsMap = PathIdsByAirport;

/**
 * Airport markers mapping
 */
export interface AirportMarkersMap {
  [airportName: string]: L.Marker;
}

/**
 * OpenAIP layers mapping
 */
export interface OpenAIPLayersMap {
  [layerName: string]: L.TileLayer;
}

/** Delay before a Wrapped panel restored from state opens again */
const WRAPPED_RESTORE_DELAY_MS = 500;

/**
 * Said when the feature bundle cannot be fetched. Without it a click on
 * Replay or Wrapped would do nothing at all and look like a dead control;
 * the export button says the same kind of thing when dom-to-image is
 * missing.
 */
export const FEATURES_UNAVAILABLE_MESSAGE =
  "Replay and Wrapped are unavailable: their code could not be loaded";

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
  declare currentData: StoreAccessors["currentData"];
  declare aircraftModels: StoreAccessors["aircraftModels"];
  declare hasTimingData: StoreAccessors["hasTimingData"];
  declare altitudeRange: StoreAccessors["altitudeRange"];
  declare airspeedRange: StoreAccessors["airspeedRange"];

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

  // Map and layers
  map: L.Map | null;
  /** The base map. Wrapped waits on its `load` before showing the map. */
  baseLayer: L.TileLayer | null = null;
  heatmapLayer: HeatmapLayer | null;
  readonly altitudeLayer: L.LayerGroup;
  readonly airspeedLayer: L.LayerGroup;
  readonly airportLayer: L.LayerGroup;
  /** Shared canvas renderer for altitude/airspeed polylines */
  readonly pathRenderer: L.Canvas;

  // Airport markers (non-store)
  readonly airportMarkers: AirportMarkersMap;

  // OpenAIP layer
  readonly openaipLayers: OpenAIPLayersMap;

  /**
   * Replay state. It lives here rather than in the replay manager because
   * the app reads it on every map click and layer redraw, which must not
   * depend on whether the feature bundle has been fetched.
   */
  readonly replayState: ReplayState;

  // Saved state
  savedState: AppState | null;
  restoredYearFromState: boolean;

  // Managers (initialized in initialize(), always available after construction)
  stateManager!: StateManager;
  dataManager!: DataManager;
  layerManager!: LayerManager;
  filterManager!: FilterManager;
  statsManager!: StatsManager;
  pathSelection!: PathSelection;
  airportManager!: AirportManager;
  /**
   * Replay and Wrapped live in the lazily loaded feature bundle, so these
   * are undefined until the user first opens one. Reach them through
   * `loadReplay()` / `loadWrapped()`; read them directly only where the
   * feature must already be open for the code to run at all.
   */
  replayManager?: ReplayManager | undefined;
  wrappedManager?: WrappedManager | undefined;
  uiToggles!: UIToggles;
  mobileBar!: MobileBar | null;

  /** Pending reopening of a Wrapped panel that was open when state was saved */
  private wrappedRestoreTimer: ReturnType<typeof setTimeout> | null = null;

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
    if (!data) return {};
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
    this.heatmapLayer = null;
    this.altitudeLayer = L.layerGroup();
    this.airspeedLayer = L.layerGroup();
    this.airportLayer = L.layerGroup();
    this.pathRenderer = L.canvas({ padding: 0.5 });

    // Airport markers (non-store)
    this.airportMarkers = {};

    // OpenAIP layer
    this.openaipLayers = {};

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

    // Load airports and metadata
    await loadInitialData(this);

    // Setup map event handlers
    this.setupEventHandlers();

    // Mark initialization as complete
    this.isInitializing = false;

    // Restore wrapped panel state if it was open
    if (this.savedState && this.savedState.wrappedVisible) {
      this.wrappedRestoreTimer = setTimeout(() => {
        this.wrappedRestoreTimer = null;
        void this.loadWrapped().then((manager) => {
          // The bundle may arrive after the app was torn down
          if (!this.destroyed) manager?.showWrapped();
        });
      }, WRAPPED_RESTORE_DELAY_MS);
    }

    // Apply filter changes made through the selects while loading
    await this.applyPendingFilterChanges();
  }

  /** Cancel pending work and detach the chrome built at runtime */
  destroy(): void {
    this.destroyed = true;
    if (this.wrappedRestoreTimer !== null) {
      clearTimeout(this.wrappedRestoreTimer);
      this.wrappedRestoreTimer = null;
    }
    this.replayManager?.destroy();
    this.wrappedManager?.destroy();
    this.mobileBar?.destroy();
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
    const pendingYear =
      yearSelect && yearSelect.value !== this.selectedYear
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
    await this.filterManager.filterByAircraft();
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

      // Restore layer visibility
      if (state.heatmapVisible !== undefined) {
        this.heatmapVisible = state.heatmapVisible;
      }
      if (state.altitudeVisible !== undefined) {
        this.altitudeVisible = state.altitudeVisible;
      }
      if (state.airspeedVisible !== undefined) {
        this.airspeedVisible = state.airspeedVisible;
      }
      if (state.airportsVisible !== undefined) {
        this.airportsVisible = state.airportsVisible;
      }
      if (state.aviationVisible !== undefined) {
        this.aviationVisible = state.aviationVisible;
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
    // The app passes `animate: false` to its own moves, which leaves the
    // ones Leaflet runs itself: double click, wheel and pinch zooms, tile
    // and marker fades and the glide after a drag
    const animate = !prefersReducedMotion();
    this.map = L.map("map", {
      center: this.config.center,
      zoom: 10,
      minZoom: MIN_ZOOM,
      maxZoom: MAX_ZOOM,
      zoomSnap: 0.25,
      zoomDelta: 0.25,
      wheelPxPerZoomLevel: 120,
      preferCanvas: true,
      // Pinch, scroll and double tap already zoom; the control only costs
      // the bottom-right corner of the map
      zoomControl: false,
      attributionControl: false,
      zoomAnimation: animate,
      fadeAnimation: animate,
      markerZoomAnimation: animate,
      inertia: animate,
    });

    L.control
      .attribution({ prefix: false, position: "bottomright" })
      .addTo(this.map);

    const cartoUrl = this.config.cartoApiKey
      ? `https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png?key=${this.config.cartoApiKey}`
      : "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png";
    this.baseLayer = L.tileLayer(cartoUrl, {
      attribution: "&copy; OpenStreetMap contributors, &copy; CARTO",
      maxZoom: MAX_ZOOM,
    })
      .on("tileerror", (e: L.TileErrorEvent) => {
        logError(`Tile load error: ${e.coords.x}/${e.coords.y}/${e.coords.z}`);
      })
      .addTo(this.map);

    // A saved zoom of 0 is a view like any other, not a missing one
    if (
      this.savedState &&
      this.savedState.center &&
      this.savedState.zoom !== undefined
    ) {
      this.map.setView(
        [this.savedState.center.lat, this.savedState.center.lng],
        this.savedState.zoom,
      );
    } else {
      this.map.fitBounds(this.config.bounds, { padding: [30, 30] });
    }

    if (this.config.openaipApiKey) {
      this.openaipLayers["Aviation Data"] = L.tileLayer(
        "https://{s}.api.tiles.openaip.net/api/data/openaip/{z}/{x}/{y}.png?apiKey=" +
          this.config.openaipApiKey,
        {
          attribution: '&copy; <a href="https://www.openaip.net">OpenAIP</a>',
          maxNativeZoom: 18,
          maxZoom: MAX_ZOOM,
          minZoom: 7,
          subdomains: ["a", "b", "c"],
        },
      );
    }

    if (this.airportsVisible) {
      this.airportLayer.addTo(this.map);
    }

    if (this.config.openaipApiKey) {
      const aviationBtn = domCache.get("aviation-btn");
      if (aviationBtn) {
        aviationBtn.classList.remove("initially-hidden");
        aviationBtn
          .closest(".control-row")
          ?.classList.remove("initially-hidden");
      }
    }
  }

  /**
   * The store drives the toggle buttons and the colour legends: initial
   * state and every change are reflected in aria-pressed, the active class,
   * the opacity and the legend visibility. Replay is the one other writer
   * while it runs: it shows the heatmap as off, clears the opacity of the
   * toggles it disables and shows the altitude scale for its trail, and
   * puts all three back in step with the store when it closes.
   */
  private setupButtonSync(): void {
    syncToggleButton(this.store, "heatmapVisible", "heatmap-btn");
    syncToggleButton(this.store, "altitudeVisible", "altitude-btn");
    syncToggleButton(this.store, "airspeedVisible", "airspeed-btn");
    syncToggleButton(this.store, "airportsVisible", "airports-btn");
    syncToggleButton(this.store, "aviationVisible", "aviation-btn");
    syncLegend(this.store, "altitudeVisible", "altitude-legend");
    syncLegend(this.store, "airspeedVisible", "airspeed-legend");
    // The isolate button depends on two keys, so PathSelection owns it
  }

  /**
   * Open and close the statistics rail. The rail turns the left column into
   * a single row of icon-only buttons and takes the space beside the map,
   * so Leaflet is told to remeasure once the layout has changed.
   */
  private setupStatsRail(): void {
    const apply = (visible: boolean): void => {
      const rail = domCache.get("stats-rail");
      if (rail) {
        // The collapse button hides itself, so focus has to leave the rail
        // before it does; otherwise it falls back to <body>
        if (!visible) restoreFocusFromRail(rail);
        rail.hidden = !visible;
      }

      // Both triggers are a disclosure for the rail, not a pressed toggle;
      // only the one that stays on screen carries the active treatment
      for (const id of ["stats-btn", "stats-collapse-btn"]) {
        domCache.get(id)?.setAttribute("aria-expanded", String(visible));
      }
      domCache.get("stats-btn")?.classList.toggle("active", visible);

      document.body.classList.toggle("stats-open", visible);
      invalidateMapAfterTransition(this.map, document.getElementById("map"));
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
    this.uiToggles = new UIToggles(this);
    this.mobileBar = MobileBar.mountFor(this);
    this.followReplayAvailability();
    this.followHeatmapEmphasis();
  }

  togglePathSelection(pathId: string): void {
    this.pathSelection.togglePathSelection(Number(pathId));
  }

  seekReplay(value: string): void {
    // Only reachable from the replay panel, which exists once replay is on
    this.replayManager?.seekReplay(value);
  }

  /** Whether the current selection can be replayed */
  canReplay(): boolean {
    return this.selectedPathIds.size === 1 && this.hasTimingData;
  }

  /**
   * Keep the replay control showing whether replay is available. It has to
   * say so from the first paint, so the app owns it rather than the replay
   * manager, which is only fetched once someone opens replay.
   */
  private followReplayAvailability(): void {
    const refresh = (): void => updateReplayButtonState(this.canReplay());
    this.store.subscribe("selectedPathIds", refresh);
    this.store.subscribe("hasTimingData", refresh);
    refresh();
  }

  /**
   * Keep the heatmap stepped back while a colour layer is drawn over it.
   *
   * Which of the two reads first follows from the layer flags alone, so it
   * follows the store rather than every place that writes them: a toggle, a
   * restored link and the start and end of a replay all set the same keys.
   * DataManager applies it once more when it builds the heat layer, which is
   * the one moment the canvas this styles does not exist yet.
   */
  private followHeatmapEmphasis(): void {
    const apply = (): void => this.dataManager.applyHeatmapEmphasis();
    this.store.subscribeKeys(["altitudeVisible", "airspeedVisible"], apply);
    // State restored from a link is written before this runs, so the current
    // value gets the same treatment as every later one
    apply();
  }

  /**
   * The feature bundle, or null when it could not be fetched. A failure is
   * reported here rather than at each call site, so every way into Replay
   * or Wrapped says the same thing instead of doing nothing.
   */
  private async loadFeatureBundle(): Promise<FeatureModule | null> {
    const features = await loadFeatures();
    if (!features) showToast(FEATURES_UNAVAILABLE_MESSAGE, "error");
    return features;
  }

  /**
   * The replay manager, fetching the feature bundle on first use. Resolves
   * with undefined when the bundle cannot be loaded.
   */
  async loadReplay(): Promise<ReplayManager | undefined> {
    if (!this.replayManager) {
      const features = await this.loadFeatureBundle();
      // Another caller may have finished the same load in the meantime
      this.replayManager ??= features
        ? new features.ReplayManager(this)
        : undefined;
    }
    return this.replayManager;
  }

  /** The Wrapped manager, fetching the feature bundle on first use */
  async loadWrapped(): Promise<WrappedManager | undefined> {
    if (!this.wrappedManager) {
      const features = await this.loadFeatureBundle();
      this.wrappedManager ??= features
        ? new features.WrappedManager(this)
        : undefined;
    }
    return this.wrappedManager;
  }

  private setupEventHandlers(): void {
    if (!this.map) return;

    this.map.on("moveend", () => this.stateManager.scheduleSave());
    this.map.on("zoomend", () => {
      this.stateManager.scheduleSave();
      this.airportManager.updateAirportMarkerSizes();
    });

    this.map.on("click", (_e: L.LeafletMouseEvent) => {
      if (
        this.replayState.active &&
        this.replayState.airplaneMarker &&
        this.replayState.airplaneMarker.isPopupOpen()
      ) {
        this.replayState.airplaneMarker.closePopup();
      }
      if (!this.replayState.active && this.selectedPathIds.size > 0) {
        this.pathSelection.clearSelection();
      }
    });
  }
}

defineStoreAccessors(MapApp.prototype);

/**
 * Hand focus to the first reachable statistics trigger when the rail that
 * holds it is about to be hidden. Without this the browser drops focus to
 * `<body>` and the next Tab restarts at the top of the document, ahead of
 * every focusable marker on the map.
 */
function restoreFocusFromRail(rail: HTMLElement): void {
  if (!rail.contains(document.activeElement)) return;
  // The mobile tab replaces the desktop button on small viewports, and the
  // map is the last resort: focusable, and next to the controls in order
  for (const id of ["stats-btn", "mobile-tab-stats", "map"]) {
    const trigger = domCache.get(id);
    if (!trigger || rail.contains(trigger)) continue;
    trigger.focus();
    if (document.activeElement === trigger) return;
  }
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
