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
  stadiaApiKey?: string;
  openaipApiKey?: string;
  dataDir: string;
}

/**
 * Extended Airport interface with flight count
 */
export interface AirportWithFlightCount extends Airport {
  flight_count: number;
}

// Re-export Range from store for consumers that import it from mapApp
export type { Range } from "./state/store";

/**
 * Airport to paths mapping
 */
export interface AirportToPathsMap {
  [airportName: string]: Set<number>;
}

/**
 * Path to airports mapping
 */
export interface PathToAirportsMap {
  [pathId: number]: {
    start?: string;
    end?: string;
  };
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
  altitudeRenderer: L.SVG;
  airspeedRenderer: L.SVG;

  // Selection state (non-store)
  pathSegments: { [pathId: number]: PathSegment[] };
  pathToAirports: PathToAirportsMap;
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

  get fullPathInfo(): PathInfo[] | null {
    return this.store.get("fullPathInfo");
  }
  set fullPathInfo(v: PathInfo[] | null) {
    this.store.set("fullPathInfo", v);
  }

  get fullPathSegments(): PathSegment[] | null {
    return this.store.get("fullPathSegments");
  }
  set fullPathSegments(v: PathSegment[] | null) {
    this.store.set("fullPathSegments", v);
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
    this.altitudeRenderer = L.svg();
    this.airspeedRenderer = L.svg();

    // Selection state (non-store)
    this.pathSegments = {};
    this.pathToAirports = {};
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

    // Load airports and metadata
    await this.loadInitialData();

    // Setup map event handlers
    this.setupEventHandlers();

    // Mark initialization as complete
    this.isInitializing = false;

    // Restore isolate selection button state
    this.pathSelection.updateIsolateButton();

    // Restore buttonsHidden state if it was saved
    if (this.savedState && this.savedState.buttonsHidden) {
      const toggleableButtons = document.querySelectorAll(".toggleable-btn");
      const hideButton = document.getElementById("hide-buttons-btn");

      toggleableButtons.forEach((btn) => {
        btn.classList.add("buttons-hidden");
      });
      if (hideButton) hideButton.textContent = "🔽";
    }

    // Restore wrapped panel state if it was open
    if (this.savedState && this.savedState.wrappedVisible) {
      setTimeout(() => {
        this.wrappedManager.showWrapped();
      }, 500);
    }

    // Save state after initialization
    this.stateManager.saveMapState();
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
          const pathIdNum =
            typeof pathId === "string" ? parseInt(pathId, 10) : pathId;
          this.selectedPathIds.add(pathIdNum);
        });
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
      zoomSnap: 0.25,
      zoomDelta: 0.25,
      wheelPxPerZoomLevel: 120,
      preferCanvas: true,
    });

    if (this.config.stadiaApiKey) {
      L.tileLayer(
        "https://tiles.stadiamaps.com/tiles/alidade_smooth_dark/{z}/{x}/{y}{r}.png?api_key=" +
          this.config.stadiaApiKey,
        {
          attribution:
            '&copy; <a href="https://stadiamaps.com/">Stadia Maps</a>',
        }
      ).addTo(this.map);
    } else {
      L.tileLayer(
        "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
        {
          attribution: "&copy; OpenStreetMap contributors, &copy; CARTO",
        }
      ).addTo(this.map);
    }

    if (this.savedState && this.savedState.center && this.savedState.zoom) {
      this.map.setView(
        [this.savedState.center.lat, this.savedState.center.lng],
        this.savedState.zoom
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
          maxZoom: 18,
          minZoom: 7,
          subdomains: ["a", "b", "c"],
        }
      );
    }

    if (this.airportsVisible) {
      this.airportLayer.addTo(this.map);
    }

    // Set initial button states
    const btnStates: [string, boolean][] = [
      ["heatmap-btn", this.heatmapVisible],
      ["altitude-btn", this.altitudeVisible],
      ["airspeed-btn", this.airspeedVisible],
      ["airports-btn", this.airportsVisible],
      ["aviation-btn", this.aviationVisible],
    ];
    for (const [id, visible] of btnStates) {
      const btn = domCache.get(id);
      if (btn) btn.style.opacity = visible ? "1.0" : "0.5";
    }

    if (this.config.openaipApiKey) {
      const aviationBtn = domCache.get("aviation-btn");
      if (aviationBtn) aviationBtn.style.display = "block";
    }
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

  private setupEventHandlers(): void {
    this.map!.on("moveend", () => this.stateManager.scheduleSave());
    this.map!.on("zoomend", () => {
      this.stateManager.scheduleSave();
      this.airportManager.updateAirportMarkerSizes();
    });

    this.map!.on("click", (_e: L.LeafletMouseEvent) => {
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
 */
function bindActions(app: MapApp): void {
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
    if (!action || !actions[action]) return;

    const handler = actions[action];
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
    await app.initialize();
    bindActions(app);
    return app;
  };
}

// Auto-initialize when module loads
if (typeof window !== "undefined" && window.MAP_CONFIG && window.initMapApp) {
  window.initMapApp(window.MAP_CONFIG).catch(logError);
}
