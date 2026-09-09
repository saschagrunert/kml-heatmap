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
import { loadInitialData, createAirportMarkers } from "./appInitializer";
import { logError } from "./utils/logger";
import { domCache } from "./utils/domCache";
import { syncToggleButton } from "./utils/buttonState";
import {
  HIDE_BUTTONS_LABEL,
  MAX_ZOOM,
  SHOW_BUTTONS_LABEL,
} from "./utils/constants";
import { AppStore } from "./state/store";
import type { Range } from "./state/store";
import type { HeatmapLayer } from "./globals";
import type {
  PathInfo,
  PathSegment,
  Airport,
  FilteredStatistics,
  AppState,
  KMLDataset,
} from "./types";

/**
 * Map configuration passed to constructor
 */
export interface MapConfig {
  center: [number, number];
  bounds: [[number, number], [number, number]];
  cartoApiKey?: string;
  openaipApiKey?: string;
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

/**
 * data-action handlers that need loaded data and are ignored while the app
 * is still initializing (pending filter changes are applied afterwards).
 */
const DEFERRED_WHILE_INITIALIZING = new Set([
  "filterByYear",
  "filterByAircraft",
  "toggleReplay",
  "playReplay",
  "pauseReplay",
  "stopReplay",
  "seekReplay",
  "changeReplaySpeed",
  "toggleAutoZoom",
  "showWrapped",
  "exportMap",
  "toggleIsolateSelection",
]);

export class MapApp {
  // Observable state store
  readonly store: AppStore;

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

  // Store-backed getters/setters for filters
  get selectedYear(): string {
    return this.store.get("selectedYear");
  }
  set selectedYear(v: string) {
    this.store.set("selectedYear", v);
  }

  get selectedAircraft(): string {
    return this.store.get("selectedAircraft");
  }
  set selectedAircraft(v: string) {
    this.store.set("selectedAircraft", v);
  }

  // Store-backed getters/setters for selection
  get selectedPathIds(): Set<number> {
    return this.store.get("selectedPathIds");
  }
  set selectedPathIds(v: Set<number>) {
    this.store.set("selectedPathIds", v);
  }

  get isolateSelection(): boolean {
    return this.store.get("isolateSelection");
  }
  set isolateSelection(v: boolean) {
    this.store.set("isolateSelection", v);
  }

  // Store-backed getters/setters for layer visibility
  get heatmapVisible(): boolean {
    return this.store.get("heatmapVisible");
  }
  set heatmapVisible(v: boolean) {
    this.store.set("heatmapVisible", v);
  }

  get altitudeVisible(): boolean {
    return this.store.get("altitudeVisible");
  }
  set altitudeVisible(v: boolean) {
    this.store.set("altitudeVisible", v);
  }

  get airspeedVisible(): boolean {
    return this.store.get("airspeedVisible");
  }
  set airspeedVisible(v: boolean) {
    this.store.set("airspeedVisible", v);
  }

  get airportsVisible(): boolean {
    return this.store.get("airportsVisible");
  }
  set airportsVisible(v: boolean) {
    this.store.set("airportsVisible", v);
  }

  get aviationVisible(): boolean {
    return this.store.get("aviationVisible");
  }
  set aviationVisible(v: boolean) {
    this.store.set("aviationVisible", v);
  }

  // Store-backed getters/setters for UI state
  get buttonsHidden(): boolean {
    return this.store.get("buttonsHidden");
  }
  set buttonsHidden(v: boolean) {
    this.store.set("buttonsHidden", v);
  }

  // Store-backed getters/setters for data
  get currentData(): KMLDataset | null {
    return this.store.get("currentData");
  }
  set currentData(v: KMLDataset | null) {
    this.store.set("currentData", v);
  }

  /** Path info of the loaded dataset (single source of truth: currentData) */
  get fullPathInfo(): PathInfo[] | null {
    return this.currentData?.path_info ?? null;
  }

  /** Segments of the loaded dataset (single source of truth: currentData) */
  get fullPathSegments(): PathSegment[] | null {
    return this.currentData?.path_segments ?? null;
  }

  get fullStats(): FilteredStatistics | null {
    return this.store.get("fullStats");
  }
  set fullStats(v: FilteredStatistics | null) {
    this.store.set("fullStats", v);
  }

  // Store-backed getters/setters for computed ranges
  get altitudeRange(): Range {
    return this.store.get("altitudeRange");
  }
  set altitudeRange(v: Range) {
    this.store.set("altitudeRange", v);
  }

  get airspeedRange(): Range {
    return this.store.get("airspeedRange");
  }
  set airspeedRange(v: Range) {
    this.store.set("airspeedRange", v);
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

    // Load airports and metadata
    await this.loadInitialData();

    // Setup map event handlers
    this.setupEventHandlers();

    // Mark initialization as complete
    this.isInitializing = false;

    // Restore isolate selection button state
    this.pathSelection.updateIsolateButton();

    // Restore wrapped panel state if it was open
    if (this.savedState && this.savedState.wrappedVisible) {
      setTimeout(() => {
        this.wrappedManager.showWrapped();
      }, 500);
    }

    // Save state after initialization
    this.stateManager.saveMapState();

    // Apply filter changes made through the selects while loading
    await this.applyPendingFilterChanges();
  }

  /**
   * Year/aircraft select changes during initialization are ignored by the
   * bound handlers; apply them once the initial data is loaded.
   */
  private async applyPendingFilterChanges(): Promise<void> {
    const yearSelect = domCache.get("year-select");
    const aircraftSelect = domCache.get("aircraft-select");
    // Capture both before filtering: switching the year rebuilds the aircraft
    // dropdown and would otherwise overwrite a pending aircraft selection.
    const pendingYear =
      yearSelect instanceof HTMLSelectElement &&
      yearSelect.value !== this.selectedYear
        ? yearSelect.value
        : null;
    const pendingAircraft =
      aircraftSelect instanceof HTMLSelectElement &&
      aircraftSelect.value !== this.selectedAircraft
        ? aircraftSelect.value
        : null;

    if (pendingYear !== null) {
      await this.filterManager.filterByYear();
    }

    if (
      pendingAircraft === null ||
      !(aircraftSelect instanceof HTMLSelectElement)
    ) {
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
      if (state.buttonsHidden !== undefined) {
        this.buttonsHidden = state.buttonsHidden;
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
      maxZoom: MAX_ZOOM,
      zoomSnap: 0.25,
      zoomDelta: 0.25,
      wheelPxPerZoomLevel: 120,
      preferCanvas: true,
    });

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

    if (this.savedState && this.savedState.center && this.savedState.zoom) {
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
      if (aviationBtn) aviationBtn.style.display = "block";
    }
  }

  /**
   * The store drives the toggle buttons: initial state and every change
   * are reflected in aria-pressed, the active class and the opacity.
   */
  private setupButtonSync(): void {
    syncToggleButton(this.store, "heatmapVisible", "heatmap-btn");
    syncToggleButton(this.store, "altitudeVisible", "altitude-btn");
    syncToggleButton(this.store, "airspeedVisible", "airspeed-btn");
    syncToggleButton(this.store, "airportsVisible", "airports-btn");
    syncToggleButton(this.store, "aviationVisible", "aviation-btn");
    syncToggleButton(this.store, "isolateSelection", "isolate-btn");
    // The isolate button additionally depends on whether paths are selected
    this.store.subscribe("selectedPathIds", () =>
      this.pathSelection.updateIsolateButton(),
    );

    const applyButtonsHidden = (hidden: boolean): void => {
      document.querySelectorAll(".toggleable-btn").forEach((btn) => {
        btn.classList.toggle("buttons-hidden", hidden);
      });
      const hideButton = domCache.get("hide-buttons-btn");
      if (hideButton) {
        const label = hidden ? SHOW_BUTTONS_LABEL : HIDE_BUTTONS_LABEL;
        hideButton.textContent = hidden ? "🔽" : "🔼";
        hideButton.setAttribute("aria-pressed", String(hidden));
        hideButton.setAttribute("aria-label", label);
        hideButton.title = label;
      }
    };
    applyButtonsHidden(this.buttonsHidden);
    this.store.subscribe("buttonsHidden", applyButtonsHidden);
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
  }

  async loadInitialData(): Promise<void> {
    await loadInitialData(this);
  }

  createAirportMarkers(airports: Airport[]): void {
    createAirportMarkers(this, airports);
  }

  togglePathSelection(id: string): void {
    this.pathSelection.togglePathSelection(Number(id));
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

/**
 * Bind data-action attributes to app methods via addEventListener.
 * Buttons get "click", selects get "change", inputs get "input".
 * Handlers are bound before initialization completes; data-dependent
 * actions are ignored while `app.isInitializing` is true.
 */
export function bindActions(app: MapApp): void {
  const actions: Record<string, (e: Event) => void> = {
    toggleHeatmap: () => app.uiToggles.toggleHeatmap(),
    toggleStats: () => app.statsManager.toggleStats(),
    toggleAltitude: () => app.uiToggles.toggleAltitude(),
    toggleAirspeed: () => app.uiToggles.toggleAirspeed(),
    toggleAirports: () => app.uiToggles.toggleAirports(),
    toggleAviation: () => app.uiToggles.toggleAviation(),
    toggleReplay: () => app.replayManager.toggleReplay(),
    filterByYear: () => {
      app.filterManager.filterByYear().catch(logError);
    },
    filterByAircraft: () => {
      app.filterManager.filterByAircraft().catch(logError);
    },
    exportMap: () => app.uiToggles.exportMap(),
    showWrapped: () => app.wrappedManager.showWrapped(),
    closeWrapped: () => app.wrappedManager.closeWrapped(),
    closeWrappedBackdrop: (e) =>
      app.wrappedManager.closeWrapped(e as MouseEvent),
    toggleIsolateSelection: () => app.pathSelection.toggleIsolateSelection(),
    toggleButtonsVisibility: () => app.uiToggles.toggleButtonsVisibility(),
    playReplay: () => app.replayManager.playReplay(),
    pauseReplay: () => app.replayManager.pauseReplay(),
    stopReplay: () => app.replayManager.stopReplay(),
    seekReplay: (e) =>
      app.replayManager.seekReplay((e.target as HTMLInputElement).value),
    changeReplaySpeed: () => app.replayManager.changeReplaySpeed(),
    toggleAutoZoom: () => app.replayManager.toggleAutoZoom(),
    stopPropagation: (e) => e.stopPropagation(),
  };

  document.querySelectorAll<HTMLElement>("[data-action]").forEach((el) => {
    const action = el.dataset["action"];
    if (!action) return;
    const fn = actions[action];
    if (!fn) return;

    const handler = (e: Event): void => {
      if (app.isInitializing && DEFERRED_WHILE_INITIALIZING.has(action)) {
        return;
      }
      fn(e);
    };
    if (el.tagName === "SELECT") {
      el.addEventListener("change", handler);
    } else if (el.tagName === "INPUT") {
      el.addEventListener("input", handler);
    } else {
      el.addEventListener("click", handler);
    }
  });
}

// Initialize app and bind DOM event listeners
if (typeof window !== "undefined") {
  window.initMapApp = async (config: MapConfig): Promise<MapApp> => {
    const app = new MapApp(config);
    window.mapApp = app;
    // Bind before the (long) initial load so early interactions are not lost
    bindActions(app);
    await app.initialize();
    return app;
  };
}

// Auto-initialize when module loads
if (typeof window !== "undefined" && window.MAP_CONFIG && window.initMapApp) {
  window.initMapApp(window.MAP_CONFIG).catch((err) => {
    logError(err);
    const mapEl = document.getElementById("map");
    if (mapEl) {
      mapEl.innerHTML =
        '<div class="kh-init-error">Failed to initialize map. Please reload the page.</div>';
    }
  });
}
