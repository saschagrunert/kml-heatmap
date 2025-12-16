/**
 * KML Heatmap - Complete Main Application Entry Point
 *
 * This file wires together all the TypeScript modules to create
 * the complete interactive flight tracking application.
 */

import L from "leaflet";
import "leaflet.heat";
import type {
  AppConfig,
  FlightData,
  PathInfo,
  PathSegment,
  Statistics,
} from "./types";
import { StateManager } from "./state/StateManager";
import { DataLoader } from "./services/DataLoader";
import { LayerManager } from "./services/LayerManager";
import { AirportManager } from "./services/AirportManager";
import { MAP_CONFIG } from "./constants";
import { StatisticsCalculator } from "./services/StatisticsCalculator";
import { MapExporter } from "./services/MapExporter";
import { UIController } from "./ui/UIController";
import { WrappedView } from "./ui/WrappedView";
import { ReplayController } from "./replay/ReplayController";
import { getResolutionForZoom } from "./utils/resolution";
import { formatTime } from "./utils/formatting";
import { FilterController } from "./controllers/FilterController";

// Declare global configuration injected by Python template
declare global {
  interface Window {
    kmlHeatmapConfig: AppConfig;
  }
}

/**
 * Main Application Class
 */
class KMLHeatmapApp {
  private config: AppConfig;
  private map!: any; // L.Map - using any to avoid Leaflet type resolution issues
  private stateManager: StateManager;
  private dataLoader: DataLoader;
  private layerManager!: LayerManager;
  private airportManager!: AirportManager;
  private statisticsCalculator: StatisticsCalculator;
  private mapExporter!: MapExporter;
  private uiController: UIController;
  private wrappedView: WrappedView;
  private filterController: FilterController;
  private replayController: ReplayController | null = null;
  private currentResolution: string | null = null;
  private fullPathInfo: PathInfo[] | null = null;
  private fullPathSegments: PathSegment[] | null = null;

  constructor(config: AppConfig) {
    this.config = config;
    this.stateManager = new StateManager();
    this.dataLoader = new DataLoader(config.dataDir);
    this.statisticsCalculator = new StatisticsCalculator();
    this.uiController = new UIController();
    this.wrappedView = new WrappedView();
    this.filterController = new FilterController();
  }

  /**
   * Initialize the application
   */
  async init(): Promise<void> {
    this.initializeMap();
    this.layerManager = new LayerManager(this.map);

    const airportLayer = this.layerManager.getLayer("airport") as any; // L.LayerGroup - using any to avoid Leaflet type resolution issues
    this.airportManager = new AirportManager(this.map, airportLayer);
    this.mapExporter = new MapExporter(this.map);

    const savedState = this.stateManager.loadState();
    this.stateManager.restoreState(savedState);

    if (savedState?.center && savedState?.zoom) {
      this.map.setView(
        [savedState.center.lat, savedState.center.lng],
        savedState.zoom,
      );
    } else {
      this.map.fitBounds(this.config.bounds, {
        padding: MAP_CONFIG.BOUNDS_PADDING,
      });
    }

    this.setupEventHandlers();
    this.initializeUI();
    await this.updateLayers();
    await this.loadAndDisplayAirports();

    const metadata = await this.dataLoader.loadMetadata();
    if (metadata) {
      this.displayStats(metadata, false);
    }

    await this.loadFullResolutionData();
  }

  private initializeMap(): void {
    this.map = L.map("map", {
      center: this.config.center,
      zoom: MAP_CONFIG.DEFAULT_ZOOM,
      zoomSnap: MAP_CONFIG.ZOOM_SNAP,
      zoomDelta: MAP_CONFIG.ZOOM_DELTA,
      wheelPxPerZoomLevel: MAP_CONFIG.WHEEL_PX_PER_ZOOM_LEVEL,
      preferCanvas: true,
    });

    if (this.config.stadiaApiKey) {
      L.tileLayer(
        `https://tiles.stadiamaps.com/tiles/alidade_smooth_dark/{z}/{x}/{y}{r}.png?api_key=${this.config.stadiaApiKey}`,
        {
          attribution:
            '&copy; <a href="https://stadiamaps.com/">Stadia Maps</a>',
        },
      ).addTo(this.map);
    } else {
      L.tileLayer(
        "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
        {
          attribution: "&copy; OpenStreetMap contributors, &copy; CARTO",
        },
      ).addTo(this.map);
    }

    if (this.config.openaipApiKey) {
      const openaipLayer = L.tileLayer(
        `https://{s}.api.tiles.openaip.net/api/data/openaip/{z}/{x}/{y}.png?apiKey=${this.config.openaipApiKey}`,
        {
          attribution: '&copy; <a href="https://www.openaip.net">OpenAIP</a>',
          maxZoom: 18,
          minZoom: 7,
          subdomains: ["a", "b", "c"],
        },
      );

      const visibility = this.stateManager.getLayerVisibility();
      if (visibility.aviation) {
        openaipLayer.addTo(this.map);
      }

      (this.map as any).openaipLayer = openaipLayer;
    }
  }

  private setupEventHandlers(): void {
    this.map.on("moveend", () => this.stateManager.saveState(this.map));
    this.map.on("zoomend", () => {
      this.stateManager.saveState(this.map);
      this.updateLayers();
    });

    this.setupButtonHandlers();
    this.setupFilterHandlers();
  }

  private setupButtonHandlers(): void {
    const handlers: Record<string, () => void> = {
      "heatmap-btn": () => this.toggleHeatmap(),
      "altitude-btn": () => this.toggleAltitude(),
      "airspeed-btn": () => this.toggleAirspeed(),
      "airports-btn": () => this.toggleAirports(),
      "aviation-btn": () => this.toggleAviation(),
      "stats-btn": () => this.toggleStats(),
      "export-btn": () => this.exportMap(),
      "wrapped-btn": () => this.showWrapped(),
    };

    Object.entries(handlers).forEach(([id, handler]) => {
      const button = document.getElementById(id);
      if (button) {
        button.addEventListener("click", handler);
      }
    });
  }

  private setupFilterHandlers(): void {
    const yearFilter = document.getElementById(
      "year-filter",
    ) as HTMLSelectElement;
    if (yearFilter) {
      yearFilter.addEventListener("change", () => {
        this.stateManager.setSelectedYear(yearFilter.value);
        this.applyFilters();
      });
    }

    const aircraftFilter = document.getElementById(
      "aircraft-filter",
    ) as HTMLSelectElement;
    if (aircraftFilter) {
      aircraftFilter.addEventListener("change", () => {
        this.stateManager.setSelectedAircraft(aircraftFilter.value);
        this.applyFilters();
      });
    }
  }

  private initializeUI(): void {
    const visibility = this.stateManager.getLayerVisibility();

    this.uiController.updateButtonState("heatmap-btn", visibility.heatmap);
    this.uiController.updateButtonState("altitude-btn", visibility.altitude);
    this.uiController.updateButtonState("airspeed-btn", visibility.airspeed);
    this.uiController.updateButtonState("airports-btn", visibility.airports);
    this.uiController.updateButtonState("aviation-btn", visibility.aviation);

    this.uiController.showAviationButton(!!this.config.openaipApiKey);

    if (visibility.airports) {
      const airportLayer = this.layerManager.getLayer("airport");
      if (airportLayer) {
        airportLayer.addTo(this.map);
      }
    }
  }

  private async loadFullResolutionData(): Promise<void> {
    const fullData = await this.dataLoader.loadData("z14_plus");
    if (fullData?.path_info && fullData?.path_segments) {
      this.fullPathInfo = fullData.path_info;
      this.fullPathSegments = fullData.path_segments;

      this.airportManager.buildAirportRelationships(this.fullPathInfo);

      const years = this.statisticsCalculator.getUniqueYears(this.fullPathInfo);
      this.uiController.updateYearFilter(years);

      const aircraft = this.statisticsCalculator.getUniqueAircraft(
        this.fullPathInfo,
      );
      this.uiController.updateAircraftFilter(aircraft);
    }
  }

  private async updateLayers(): Promise<void> {
    const zoom = this.map.getZoom();
    const resolution = getResolutionForZoom(zoom);

    if (resolution === this.currentResolution) {
      return;
    }

    this.currentResolution = resolution;
    const data = await this.dataLoader.loadData(resolution);

    if (!data) return;

    const filteredData = this.getFilteredData(data);
    const visibility = this.stateManager.getLayerVisibility();

    this.layerManager.updateHeatmap(
      filteredData.coordinates,
      visibility.heatmap,
    );

    if (visibility.altitude && filteredData.path_segments) {
      const range = data.altitude_range ?? { min: 0, max: 10000 };
      this.layerManager.updateAltitudePaths(
        filteredData.path_segments,
        range.min,
        range.max,
        (pathId) => this.handlePathClick(pathId),
      );
      this.uiController.updateAltitudeLegend(range.min, range.max);
    }

    if (visibility.airspeed && filteredData.path_segments) {
      const range = data.airspeed_range ?? { min: 0, max: 200 };
      this.layerManager.updateAirspeedPaths(
        filteredData.path_segments,
        range.min,
        range.max,
        (pathId) => this.handlePathClick(pathId),
      );
      this.uiController.updateAirspeedLegend(range.min, range.max);
    }
  }

  private getFilteredData(data: FlightData): FlightData {
    const filters = {
      year: this.stateManager.getSelectedYear(),
      aircraft: this.stateManager.getSelectedAircraft(),
      selectedPathIds: this.stateManager.getSelectedPathIds(),
    };

    return this.filterController.applyFilters(data, filters);
  }

  private async loadAndDisplayAirports(): Promise<void> {
    const airports = await this.dataLoader.loadAirports();
    this.airportManager.createAirportMarkers(airports, (airportName) => {
      this.handleAirportClick(airportName);
    });
  }

  private handlePathClick(pathId: string): void {
    this.stateManager.togglePathSelection(pathId);
    this.applyFilters();
  }

  private handleAirportClick(airportName: string): void {
    const pathIds = Array.from(
      this.airportManager.getPathsForAirport(airportName),
    );
    this.stateManager.clearPathSelection();
    this.stateManager.addPathsToSelection(pathIds);
    this.applyFilters();
  }

  private applyFilters(): void {
    this.updateLayers();

    if (this.fullPathInfo) {
      const year = this.stateManager.getSelectedYear();
      const aircraft = this.stateManager.getSelectedAircraft();
      const selectedPathIds = this.stateManager.getSelectedPathIds();

      const visibleAirports = this.statisticsCalculator.getVisibleAirports(
        this.fullPathInfo,
        { year, aircraft, selectedPathIds },
      );

      const hasFilters =
        year !== "all" || aircraft !== "all" || selectedPathIds.size > 0;
      this.airportManager.updateAirportOpacity(visibleAirports, hasFilters);
    }

    this.updateFilteredStats();
    this.stateManager.saveState(this.map);
  }

  private async updateFilteredStats(): Promise<void> {
    const fullStats = await this.dataLoader.loadMetadata();
    if (!fullStats || !this.fullPathInfo || !this.fullPathSegments) {
      return;
    }

    const year = this.stateManager.getSelectedYear();
    const aircraft = this.stateManager.getSelectedAircraft();
    const selectedPathIds = this.stateManager.getSelectedPathIds();

    const filteredStats = this.statisticsCalculator.calculateFilteredStats(
      fullStats,
      this.fullPathInfo,
      this.fullPathSegments,
      { year, aircraft, selectedPathIds },
    );

    this.displayStats(filteredStats, selectedPathIds.size > 0);
  }

  private displayStats(stats: Statistics, isSelection: boolean): void {
    const html = `
      <h3>${isSelection ? "Selection" : "Total"} Statistics</h3>
      <div><strong>Distance:</strong> ${stats.total_distance_nm.toFixed(0)} nm (${stats.total_distance_km.toFixed(0)} km)</div>
      <div><strong>Altitude:</strong> ${Math.round(stats.min_altitude_ft).toLocaleString()} - ${Math.round(stats.max_altitude_ft).toLocaleString()} ft</div>
      <div><strong>Airports:</strong> ${stats.airports_visited}</div>
      <div><strong>Flight Time:</strong> ${formatTime(stats.total_flight_time_seconds)}</div>
    `;
    this.uiController.updateStatsPanel(html);
  }

  // Toggle methods
  private toggleHeatmap(): void {
    const visibility = this.stateManager.getLayerVisibility();
    const newState = !visibility.heatmap;
    this.stateManager.setLayerVisibility("heatmap", newState);
    this.layerManager.toggleLayer("heatmap", newState);
    this.uiController.updateButtonState("heatmap-btn", newState);
    this.stateManager.saveState(this.map);
  }

  private toggleAltitude(): void {
    const visibility = this.stateManager.getLayerVisibility();
    const newState = !visibility.altitude;
    this.stateManager.setLayerVisibility("altitude", newState);
    this.layerManager.toggleLayer("altitude", newState);
    this.uiController.updateButtonState("altitude-btn", newState);
    this.uiController.toggleLegend("altitude-legend", newState);
    this.stateManager.saveState(this.map);
    if (newState) this.updateLayers();
  }

  private toggleAirspeed(): void {
    const visibility = this.stateManager.getLayerVisibility();
    const newState = !visibility.airspeed;
    this.stateManager.setLayerVisibility("airspeed", newState);
    this.layerManager.toggleLayer("airspeed", newState);
    this.uiController.updateButtonState("airspeed-btn", newState);
    this.uiController.toggleLegend("airspeed-legend", newState);
    this.stateManager.saveState(this.map);
    if (newState) this.updateLayers();
  }

  private toggleAirports(): void {
    const visibility = this.stateManager.getLayerVisibility();
    const newState = !visibility.airports;
    this.stateManager.setLayerVisibility("airports", newState);
    this.layerManager.toggleLayer("airport", newState);
    this.uiController.updateButtonState("airports-btn", newState);
    this.stateManager.saveState(this.map);
  }

  private toggleAviation(): void {
    const visibility = this.stateManager.getLayerVisibility();
    const newState = !visibility.aviation;
    this.stateManager.setLayerVisibility("aviation", newState);

    const openaipLayer = (this.map as any).openaipLayer;
    if (openaipLayer) {
      if (newState) {
        openaipLayer.addTo(this.map);
      } else {
        this.map.removeLayer(openaipLayer);
      }
    }

    this.uiController.updateButtonState("aviation-btn", newState);
    this.stateManager.saveState(this.map);
  }

  private toggleStats(): void {
    this.uiController.toggleStatsPanel();
    this.stateManager.saveState(this.map);
  }

  private async exportMap(): Promise<void> {
    await this.mapExporter.exportAsImage();
  }

  private async showWrapped(): Promise<void> {
    const fullStats = await this.dataLoader.loadMetadata();
    if (!fullStats || !this.fullPathInfo) {
      alert("No data available for wrapped view");
      return;
    }

    const currentYear = new Date().getFullYear();
    const yearStats = this.statisticsCalculator.calculateFilteredStats(
      fullStats,
      this.fullPathInfo,
      this.fullPathSegments || [],
      { year: currentYear.toString() },
    );

    this.wrappedView.show(currentYear, yearStats, fullStats, this.map);
  }
}

// Initialize app when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    const app = new KMLHeatmapApp(window.kmlHeatmapConfig);
    app.init();
  });
} else {
  const app = new KMLHeatmapApp(window.kmlHeatmapConfig);
  app.init();
}
