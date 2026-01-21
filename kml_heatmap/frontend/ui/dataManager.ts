/**
 * Data Manager - Handles data loading and management using KMLHeatmap.DataLoader
 */
import type { MapApp } from "../mapApp";
import type { KMLDataset, Airport, Metadata } from "../types";

export class DataManager {
  private app: MapApp;
  private dataLoader: any; // KMLHeatmap.DataLoader type from library
  loadedData: { [key: string]: KMLDataset };
  currentData: KMLDataset | null;

  constructor(app: MapApp) {
    this.app = app;

    // Create DataLoader instance
    this.dataLoader = new (window as any).KMLHeatmap.DataLoader({
      dataDir: app.config.dataDir,
      showLoading: () => this.showLoading(),
      hideLoading: () => this.hideLoading(),
    });

    this.loadedData = {};
    this.currentData = null;
  }

  showLoading(): void {
    const loadingEl = document.getElementById("loading");
    if (loadingEl) loadingEl.style.display = "block";
  }

  hideLoading(): void {
    const loadingEl = document.getElementById("loading");
    if (loadingEl) loadingEl.style.display = "none";
  }

  async loadData(resolution: string, year: string): Promise<KMLDataset | null> {
    return await this.dataLoader.loadData(resolution, year);
  }

  async loadAirports(): Promise<Airport[]> {
    return await this.dataLoader.loadAirports();
  }

  async loadMetadata(): Promise<Metadata> {
    return await this.dataLoader.loadMetadata();
  }

  async updateLayers(): Promise<void> {
    if (!this.app.map) return;

    const zoom = this.app.map.getZoom();
    const resolution = (window as any).KMLHeatmap.getResolutionForZoom(zoom);

    if (resolution === this.app.currentResolution) {
      return;
    }

    this.app.currentResolution = resolution;
    const data = await this.loadData(resolution, this.app.selectedYear);

    if (!data) return;

    this.currentData = data;
    this.app.currentData = data; // Store for redrawing

    // Filter coordinates based on active filters
    let filteredCoordinates = data.coordinates;
    if (
      (this.app.selectedYear !== "all" ||
        this.app.selectedAircraft !== "all") &&
      data.path_segments
    ) {
      // Get filtered path IDs
      const filteredPathIds = new Set<number>();
      if (data.path_info) {
        data.path_info.forEach((pathInfo) => {
          const matchesYear =
            this.app.selectedYear === "all" ||
            (pathInfo.year &&
              pathInfo.year.toString() === this.app.selectedYear);
          const matchesAircraft =
            this.app.selectedAircraft === "all" ||
            pathInfo.aircraft_registration === this.app.selectedAircraft;
          if (matchesYear && matchesAircraft) {
            filteredPathIds.add(pathInfo.id);
          }
        });
      }

      // Extract coordinates from filtered segments
      const coordSet = new Set<string>();
      data.path_segments.forEach((segment) => {
        if (filteredPathIds.has(segment.path_id)) {
          const coords = segment.coords;
          if (coords && coords.length === 2) {
            coordSet.add(JSON.stringify(coords[0]));
            coordSet.add(JSON.stringify(coords[1]));
          }
        }
      });

      filteredCoordinates = Array.from(coordSet).map((str) => {
        return JSON.parse(str);
      });
    }

    // Update heatmap - only add if visible
    if (this.app.heatmapLayer) {
      this.app.map.removeLayer(this.app.heatmapLayer);
    }

    // Performance optimization: limit heatmap points for very large datasets
    const MAX_HEATMAP_POINTS = 20000;
    let heatmapCoords = filteredCoordinates;
    if (filteredCoordinates.length > MAX_HEATMAP_POINTS) {
      // Sample every Nth point to stay under limit
      const step = Math.ceil(filteredCoordinates.length / MAX_HEATMAP_POINTS);
      heatmapCoords = filteredCoordinates.filter((_, i) => i % step === 0);
      console.log(
        `Heatmap: Downsampled ${filteredCoordinates.length} points to ${heatmapCoords.length} for better performance`
      );
    }

    this.app.heatmapLayer = (window as any).L.heatLayer(heatmapCoords, {
      radius: 10,
      blur: 15,
      minOpacity: 0.25,
      maxOpacity: 0.6,
      max: 1.0, // Maximum point intensity for better performance
      gradient: {
        0.0: "blue",
        0.3: "cyan",
        0.5: "lime",
        0.7: "yellow",
        1.0: "red",
      },
    });

    // Make heatmap non-interactive so clicks pass through to paths
    if (this.app.heatmapLayer._canvas) {
      this.app.heatmapLayer._canvas.style.pointerEvents = "none";
    }

    // Only add to map if heatmap is visible AND not in replay mode
    if (this.app.heatmapVisible && !this.app.replayManager!.replayActive) {
      this.app.heatmapLayer.addTo(this.app.map);
    }

    // Build path-to-airport relationships from path_info
    this.app.pathToAirports = {};
    this.app.airportToPaths = {};

    if (data.path_info) {
      data.path_info.forEach((pathInfo) => {
        const pathId = pathInfo.id;

        // Store path-to-airport mapping
        this.app.pathToAirports[pathId] = {
          start: pathInfo.start_airport,
          end: pathInfo.end_airport,
        };

        // Build reverse mapping: airport to paths
        if (pathInfo.start_airport) {
          if (!this.app.airportToPaths[pathInfo.start_airport]) {
            this.app.airportToPaths[pathInfo.start_airport] = new Set<number>();
          }
          this.app.airportToPaths[pathInfo.start_airport]!.add(pathId);
        }
        if (pathInfo.end_airport) {
          if (!this.app.airportToPaths[pathInfo.end_airport]) {
            this.app.airportToPaths[pathInfo.end_airport] = new Set<number>();
          }
          this.app.airportToPaths[pathInfo.end_airport]!.add(pathId);
        }
      });
    }

    // Calculate altitude range from all segments
    if (data.path_segments && data.path_segments.length > 0) {
      const altitudes = data.path_segments.map((s) => s.altitude_ft || 0);
      // Use iterative approach to avoid stack overflow with large arrays
      let min = altitudes[0];
      let max = altitudes[0];
      for (let i = 1; i < altitudes.length; i++) {
        if (altitudes[i] < min) min = altitudes[i];
        if (altitudes[i] > max) max = altitudes[i];
      }
      this.app.altitudeRange.min = min;
      this.app.altitudeRange.max = max;
    }

    // Create altitude layer paths (this will also update the legend)
    this.app.layerManager!.redrawAltitudePaths();

    // Redraw airspeed paths if airspeed is visible
    if (this.app.airspeedVisible) {
      this.app.layerManager!.redrawAirspeedPaths();
    }

    console.log("Updated to " + resolution + " resolution");
  }
}
