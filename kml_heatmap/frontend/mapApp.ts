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

  // Managers (initialized in initialize())
  stateManager: StateManager | null;
  dataManager: DataManager | null;
  layerManager: LayerManager | null;
  filterManager: FilterManager | null;
  statsManager: StatsManager | null;
  pathSelection: PathSelection | null;
  airportManager: AirportManager | null;
  replayManager: ReplayManager | null;
  wrappedManager: WrappedManager | null;
  uiToggles: UIToggles | null;

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

    // Managers (initialized in initialize())
    this.stateManager = null;
    this.dataManager = null;
    this.layerManager = null;
    this.filterManager = null;
    this.statsManager = null;
    this.pathSelection = null;
    this.airportManager = null;
    this.replayManager = null;
    this.wrappedManager = null;
    this.uiToggles = null;
  }

  async initialize(): Promise<void> {
    // Initialize state manager first
    this.stateManager = new StateManager(this);

    // Load saved state
    this.savedState = this.stateManager.loadState();

    // Restore filter state immediately to prevent it being overwritten
    if (this.savedState) {
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
          // Parse as number since URL params are strings
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
    }

    // Initialize Leaflet map
    this.map = L.map("map", {
      center: this.config.center,
      zoom: 10,
      zoomSnap: 0.25,
      zoomDelta: 0.25,
      wheelPxPerZoomLevel: 120,
      preferCanvas: true,
    });

    // Add tile layer
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

    // Restore map view or fit bounds
    if (this.savedState && this.savedState.center && this.savedState.zoom) {
      this.map.setView(
        [this.savedState.center.lat, this.savedState.center.lng],
        this.savedState.zoom
      );
    } else {
      this.map.fitBounds(this.config.bounds, { padding: [30, 30] });
    }

    // Setup OpenAIP layer if API key is provided
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

    // Add airports layer based on saved state
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

    // Show aviation button if API key is available
    if (this.config.openaipApiKey) {
      (document.getElementById("aviation-btn") as HTMLElement).style.display =
        "block";
    }

    // Initialize all managers
    this.dataManager = new DataManager(this);
    this.layerManager = new LayerManager(this);
    this.filterManager = new FilterManager(this);
    this.statsManager = new StatsManager(this);
    this.pathSelection = new PathSelection(this);
    this.airportManager = new AirportManager(this);
    this.replayManager = new ReplayManager(this);
    this.wrappedManager = new WrappedManager(this);
    this.uiToggles = new UIToggles(this);

    // Load airports and metadata
    await this.loadInitialData();

    // Setup map event handlers
    this.setupEventHandlers();

    // Mark initialization as complete
    this.isInitializing = false;

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
      // Show wrapped panel after a delay to ensure everything is loaded
      void setTimeout(() => {
        if (this.wrappedManager) {
          void this.wrappedManager.showWrapped();
        }
      }, 500);
    }

    // Save state after initialization
    this.stateManager.saveMapState();
  }

  async loadInitialData(): Promise<void> {
    await loadInitialData(this);
  }

  createAirportMarkers(airports: Airport[]): void {
    createAirportMarkers(this, airports);
  }

  setupEventHandlers(): void {
    // Register map event handlers for state persistence
    this.map!.on("moveend", () => this.stateManager!.saveMapState());
    this.map!.on("zoomend", () => {
      this.stateManager!.saveMapState();
      // No need to reload data on zoom - we always use full resolution
      this.airportManager!.updateAirportMarkerSizes();
    });

    // Clear selection when clicking on map background
    this.map!.on("click", (_e: L.LeafletMouseEvent) => {
      // Close replay airplane popup if open
      if (
        this.replayManager!.replayActive &&
        this.replayManager!.replayAirplaneMarker &&
        this.replayManager!.replayAirplaneMarker.isPopupOpen()
      ) {
        this.replayManager!.replayAirplaneMarker.closePopup();
      }
      // Don't clear selection during replay mode
      if (!this.replayManager!.replayActive && this.selectedPathIds.size > 0) {
        this.pathSelection!.clearSelection();
      }
    });
  }

  // Expose methods for onclick handlers
  toggleHeatmap(): void {
    this.uiToggles!.toggleHeatmap();
  }
  toggleStats(): void {
    this.statsManager!.toggleStats();
  }
  toggleAltitude(): void {
    this.uiToggles!.toggleAltitude();
  }
  toggleAirspeed(): void {
    this.uiToggles!.toggleAirspeed();
  }
  toggleAirports(): void {
    this.uiToggles!.toggleAirports();
  }
  toggleAviation(): void {
    this.uiToggles!.toggleAviation();
  }
  toggleReplay(): void {
    this.replayManager!.toggleReplay();
  }
  filterByYear(): void {
    void this.filterManager!.filterByYear();
  }
  filterByAircraft(): void {
    void this.filterManager!.filterByAircraft();
  }
  togglePathSelection(id: string): void {
    void this.pathSelection!.togglePathSelection(Number(id));
  }
  exportMap(): void {
    this.uiToggles!.exportMap();
  }
  showWrapped(): void {
    void this.wrappedManager!.showWrapped();
  }
  closeWrapped(e?: MouseEvent): void {
    this.wrappedManager!.closeWrapped(e);
  }
  toggleButtonsVisibility(): void {
    this.uiToggles!.toggleButtonsVisibility();
  }
  playReplay(): void {
    this.replayManager!.playReplay();
  }
  pauseReplay(): void {
    this.replayManager!.pauseReplay();
  }
  stopReplay(): void {
    this.replayManager!.stopReplay();
  }
  seekReplay(v: string): void {
    this.replayManager!.seekReplay(v);
  }
  changeReplaySpeed(): void {
    this.replayManager!.changeReplaySpeed();
  }
  toggleAutoZoom(): void {
    this.replayManager!.toggleAutoZoom();
  }
}

// Make globally available for onclick handlers
if (typeof window !== "undefined") {
  window.initMapApp = async (config: MapConfig): Promise<MapApp> => {
    const app = new MapApp(config);
    window.mapApp = app;
    await app.initialize();

    // Expose functions for onclick handlers
    window.toggleHeatmap = (): void => app.toggleHeatmap();
    window.toggleStats = (): void => app.toggleStats();
    window.toggleAltitude = (): void => app.toggleAltitude();
    window.toggleAirspeed = (): void => app.toggleAirspeed();
    window.toggleAirports = (): void => app.toggleAirports();
    window.toggleAviation = (): void => app.toggleAviation();
    window.toggleReplay = (): void => app.toggleReplay();
    window.filterByYear = (): void => app.filterByYear();
    window.filterByAircraft = (): void => app.filterByAircraft();
    window.togglePathSelection = (id: string): void =>
      app.togglePathSelection(id);
    window.exportMap = (): void => app.exportMap();
    window.showWrapped = (): void => app.showWrapped();
    window.closeWrapped = (e?: MouseEvent): void => app.closeWrapped(e);
    window.toggleButtonsVisibility = (): void => app.toggleButtonsVisibility();
    window.playReplay = (): void => app.playReplay();
    window.pauseReplay = (): void => app.pauseReplay();
    window.stopReplay = (): void => app.stopReplay();
    window.seekReplay = (value: string): void => app.seekReplay(value);
    window.changeReplaySpeed = (): void => app.changeReplaySpeed();
    window.toggleAutoZoom = (): void => app.toggleAutoZoom();

    return app;
  };
}

// Auto-initialize when module loads
if (typeof window !== "undefined" && window.MAP_CONFIG && window.initMapApp) {
  void window.initMapApp(window.MAP_CONFIG);
}
