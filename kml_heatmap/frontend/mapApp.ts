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

/**
 * Range with min/max values
 */
export interface Range {
  min: number;
  max: number;
}

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
  // Configuration
  config: MapConfig;

  // Shared state variables
  selectedYear: string;
  selectedAircraft: string;
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

  // Data
  currentData: KMLDataset | null;
  fullStats: FilteredStatistics | null;
  fullPathInfo: PathInfo[] | null;
  fullPathSegments: PathSegment[] | null;
  altitudeRange: Range;
  airspeedRange: Range;

  // Layer visibility state
  heatmapVisible: boolean;
  altitudeVisible: boolean;
  airspeedVisible: boolean;
  airportsVisible: boolean;
  aviationVisible: boolean;
  buttonsHidden: boolean;
  isolateSelection: boolean;

  // Selection state
  selectedPathIds: Set<number>;
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

  constructor(config: MapConfig) {
    this.config = config;

    // Shared state variables
    this.selectedYear = "all";
    this.selectedAircraft = "all";
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

    // Data
    this.currentData = null;
    this.fullStats = null;
    this.fullPathInfo = null;
    this.fullPathSegments = null;
    this.altitudeRange = { min: 0, max: 10000 };
    this.airspeedRange = { min: 0, max: 200 };

    // Layer visibility state
    this.heatmapVisible = true;
    this.altitudeVisible = false;
    this.airspeedVisible = false;
    this.airportsVisible = true;
    this.aviationVisible = false;
    this.buttonsHidden = false;
    this.isolateSelection = false;

    // Selection state
    this.selectedPathIds = new Set();
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

    if (this.savedState.selectedYear !== undefined) {
      this.selectedYear = this.savedState.selectedYear;
      this.restoredYearFromState = true;
    }
    if (this.savedState.selectedAircraft) {
      this.selectedAircraft = this.savedState.selectedAircraft;
    }

    // Restore selected paths BEFORE updateLayers() so paths are drawn with correct selection
    if (
      this.savedState.selectedPathIds &&
      this.savedState.selectedPathIds.length > 0
    ) {
      this.savedState.selectedPathIds.forEach((pathId) => {
        const pathIdNum =
          typeof pathId === "string" ? parseInt(pathId, 10) : pathId;
        this.selectedPathIds.add(pathIdNum);
      });
    }

    // Restore layer visibility
    if (this.savedState.heatmapVisible !== undefined) {
      this.heatmapVisible = this.savedState.heatmapVisible;
    }
    if (this.savedState.altitudeVisible !== undefined) {
      this.altitudeVisible = this.savedState.altitudeVisible;
    }
    if (this.savedState.airspeedVisible !== undefined) {
      this.airspeedVisible = this.savedState.airspeedVisible;
    }
    if (this.savedState.airportsVisible !== undefined) {
      this.airportsVisible = this.savedState.airportsVisible;
    }
    if (this.savedState.aviationVisible !== undefined) {
      this.aviationVisible = this.savedState.aviationVisible;
    }
    if (this.savedState.buttonsHidden !== undefined) {
      this.buttonsHidden = this.savedState.buttonsHidden;
    }
    if (this.savedState.isolateSelection !== undefined) {
      this.isolateSelection = this.savedState.isolateSelection;
    }
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
    (document.getElementById("heatmap-btn") as HTMLElement).style.opacity = this
      .heatmapVisible
      ? "1.0"
      : "0.5";
    (document.getElementById("altitude-btn") as HTMLElement).style.opacity =
      this.altitudeVisible ? "1.0" : "0.5";
    (document.getElementById("airspeed-btn") as HTMLElement).style.opacity =
      this.airspeedVisible ? "1.0" : "0.5";
    (document.getElementById("airports-btn") as HTMLElement).style.opacity =
      this.airportsVisible ? "1.0" : "0.5";
    (document.getElementById("aviation-btn") as HTMLElement).style.opacity =
      this.aviationVisible ? "1.0" : "0.5";

    if (this.config.openaipApiKey) {
      (document.getElementById("aviation-btn") as HTMLElement).style.display =
        "block";
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
    this.map!.on("moveend", () => this.stateManager.saveMapState());
    this.map!.on("zoomend", () => {
      this.stateManager.saveMapState();
      this.airportManager.updateAirportMarkerSizes();
    });

    this.map!.on("click", (_e: L.LeafletMouseEvent) => {
      if (
        this.replayManager.replayActive &&
        this.replayManager.replayAirplaneMarker &&
        this.replayManager.replayAirplaneMarker.isPopupOpen()
      ) {
        this.replayManager.replayAirplaneMarker.closePopup();
      }
      if (!this.replayManager.replayActive && this.selectedPathIds.size > 0) {
        this.pathSelection.clearSelection();
      }
    });
  }

  // Expose methods for onclick handlers
  toggleHeatmap(): void {
    this.uiToggles.toggleHeatmap();
  }
  toggleStats(): void {
    this.statsManager.toggleStats();
  }
  toggleAltitude(): void {
    this.uiToggles.toggleAltitude();
  }
  toggleAirspeed(): void {
    this.uiToggles.toggleAirspeed();
  }
  toggleAirports(): void {
    this.uiToggles.toggleAirports();
  }
  toggleAviation(): void {
    this.uiToggles.toggleAviation();
  }
  toggleReplay(): void {
    this.replayManager.toggleReplay();
  }
  filterByYear(): void {
    this.filterManager.filterByYear().catch(logError);
  }
  filterByAircraft(): void {
    this.filterManager.filterByAircraft().catch(logError);
  }
  togglePathSelection(id: string): void {
    this.pathSelection.togglePathSelection(Number(id));
  }
  exportMap(): void {
    this.uiToggles.exportMap();
  }
  showWrapped(): void {
    this.wrappedManager.showWrapped();
  }
  closeWrapped(e?: MouseEvent): void {
    this.wrappedManager.closeWrapped(e);
  }
  toggleIsolateSelection(): void {
    this.pathSelection.toggleIsolateSelection();
  }
  toggleButtonsVisibility(): void {
    this.uiToggles.toggleButtonsVisibility();
  }
  playReplay(): void {
    this.replayManager.playReplay();
  }
  pauseReplay(): void {
    this.replayManager.pauseReplay();
  }
  stopReplay(): void {
    this.replayManager.stopReplay();
  }
  seekReplay(v: string): void {
    this.replayManager.seekReplay(v);
  }
  changeReplaySpeed(): void {
    this.replayManager.changeReplaySpeed();
  }
  toggleAutoZoom(): void {
    this.replayManager.toggleAutoZoom();
  }
}

/**
 * Bind data-action attributes to app methods via addEventListener.
 * Buttons get "click", selects get "change", inputs get "input".
 */
function bindActions(app: MapApp): void {
  const actions: Record<string, (e: Event) => void> = {
    toggleHeatmap: () => app.toggleHeatmap(),
    toggleStats: () => app.toggleStats(),
    toggleAltitude: () => app.toggleAltitude(),
    toggleAirspeed: () => app.toggleAirspeed(),
    toggleAirports: () => app.toggleAirports(),
    toggleAviation: () => app.toggleAviation(),
    toggleReplay: () => app.toggleReplay(),
    filterByYear: () => app.filterByYear(),
    filterByAircraft: () => app.filterByAircraft(),
    exportMap: () => app.exportMap(),
    showWrapped: () => app.showWrapped(),
    closeWrapped: () => app.closeWrapped(),
    closeWrappedBackdrop: (e) => app.closeWrapped(e as MouseEvent),
    toggleIsolateSelection: () => app.toggleIsolateSelection(),
    toggleButtonsVisibility: () => app.toggleButtonsVisibility(),
    playReplay: () => app.playReplay(),
    pauseReplay: () => app.pauseReplay(),
    stopReplay: () => app.stopReplay(),
    seekReplay: (e) => app.seekReplay((e.target as HTMLInputElement).value),
    changeReplaySpeed: () => app.changeReplaySpeed(),
    toggleAutoZoom: () => app.toggleAutoZoom(),
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
