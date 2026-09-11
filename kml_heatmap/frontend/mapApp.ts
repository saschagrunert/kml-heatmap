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
import { ReplayManager } from "./ui/replayManager";
import { WrappedManager } from "./ui/wrappedManager";
import { UIToggles } from "./ui/uiToggles";
import { MobileBar } from "./ui/mobileBar";
import { bindActions } from "./ui/actions";
import { loadInitialData } from "./appInitializer";
import { logError } from "./utils/logger";
import { domCache } from "./utils/domCache";
import { syncLegend, syncToggleButton } from "./utils/buttonState";
import { applyGradientTokens } from "./utils/colors";
import { renderControlIcons } from "./utils/icons";
import { invalidateMapAfterTransition } from "./utils/mapHelpers";
import { MAX_ZOOM, MIN_ZOOM } from "./utils/constants";
import { AppStore, defineStoreAccessors } from "./state/store";
import type { StoreAccessors } from "./state/store";
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
export interface AirportToPathsMap {
  [airportName: string]: Set<number>;
}

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
  declare fullStats: StoreAccessors["fullStats"];
  declare altitudeRange: StoreAccessors["altitudeRange"];
  declare airspeedRange: StoreAccessors["airspeedRange"];

  // Configuration
  config: MapConfig;

  // Non-store state
  allAirportsData: Airport[];
  isInitializing: boolean;

  // Map and layers
  map: L.Map | null;
  heatmapLayer: HeatmapLayer | null;
  altitudeLayer: L.LayerGroup;
  airspeedLayer: L.LayerGroup;
  airportLayer: L.LayerGroup;
  /** Shared canvas renderer for altitude/airspeed polylines */
  pathRenderer: L.Canvas;

  // Selection state (non-store)
  airportToPaths: AirportToPathsMap;
  airportMarkers: AirportMarkersMap;

  // OpenAIP layer
  openaipLayers: OpenAIPLayersMap;

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
  replayManager!: ReplayManager;
  wrappedManager!: WrappedManager;
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

    // Selection state (non-store)
    this.airportToPaths = {};
    this.airportMarkers = {};

    // OpenAIP layer
    this.openaipLayers = {};

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
    await this.loadInitialData();

    // Setup map event handlers
    this.setupEventHandlers();

    // Mark initialization as complete
    this.isInitializing = false;

    // Restore wrapped panel state if it was open
    if (this.savedState && this.savedState.wrappedVisible) {
      this.wrappedRestoreTimer = setTimeout(() => {
        this.wrappedRestoreTimer = null;
        this.wrappedManager.showWrapped();
      }, WRAPPED_RESTORE_DELAY_MS);
    }

    // Apply filter changes made through the selects while loading
    await this.applyPendingFilterChanges();
  }

  /** Cancel pending work and detach the chrome built at runtime */
  destroy(): void {
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
      if (state.isolateSelection !== undefined) {
        this.isolateSelection = state.isolateSelection;
      }
    });
  }

  private setupMap(): void {
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
    });

    L.control
      .attribution({ prefix: false, position: "bottomright" })
      .addTo(this.map);

    const cartoUrl = this.config.cartoApiKey
      ? `https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png?key=${this.config.cartoApiKey}`
      : "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png";
    L.tileLayer(cartoUrl, {
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
   * the opacity and the legend visibility. Nothing else writes them.
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
    this.replayManager = new ReplayManager(this);
    this.wrappedManager = new WrappedManager(this);
    this.uiToggles = new UIToggles(this);
    this.mobileBar = MobileBar.mountFor(this);
  }

  async loadInitialData(): Promise<void> {
    await loadInitialData(this);
  }

  togglePathSelection(pathId: string): void {
    this.pathSelection.togglePathSelection(Number(pathId));
  }

  seekReplay(value: string): void {
    this.replayManager.seekReplay(value);
  }

  changeReplaySpeed(): void {
    this.replayManager.changeReplaySpeed();
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
        this.replayManager.state.active &&
        this.replayManager.state.airplaneMarker &&
        this.replayManager.state.airplaneMarker.isPopupOpen()
      ) {
        this.replayManager.state.airplaneMarker.closePopup();
      }
      if (!this.replayManager.state.active && this.selectedPathIds.size > 0) {
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
  '<div class="kh-init-error">Failed to initialize map. Please reload the page.</div>';

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
