/**
 * Data Manager - Handles data loading and layer refresh
 */
import type { MapApp } from "../mapApp";
import type { KMLDataset, Airport, LoadingInfo, Metadata } from "../types";
import type { Coordinate } from "../utils/geometry";
import { DataLoader } from "../services/dataLoader";
import { calculateAltitudeRange } from "../features/layers";
import { domCache } from "../utils/domCache";
import { formatFileSize } from "../utils/formatters";
import { showToast } from "../utils/toast";

export class DataManager {
  private app: MapApp;
  private dataLoader: DataLoader;
  /** Monotonic id of the latest updateLayers() call; stale loads are dropped */
  private updateRequestId = 0;
  /** Set when the loader already reported a failure via toast */
  private loadErrorReported = false;

  constructor(app: MapApp) {
    this.app = app;

    // Pre-cache loading element
    domCache.cacheElements(["loading"]);

    this.dataLoader = new DataLoader({
      dataDir: app.config.dataDir,
      showLoading: (info) => this.showLoading(info),
      hideLoading: () => this.hideLoading(),
      onLoadError: (failedYears) => {
        this.loadErrorReported = true;
        showToast(
          "Failed to load flight data for " + failedYears.join(", "),
          "error",
        );
      },
    });
  }

  /**
   * Show the loading indicator. When the template provides `#loading-text`
   * it describes what is loading, e.g. "Loading 2026 flights (1.1 MB)…".
   */
  showLoading(info?: LoadingInfo): void {
    const loadingEl = domCache.get("loading");
    if (!loadingEl) return;

    const textEl = domCache.get("loading-text");
    if (textEl && info) {
      const what = info.year === "all" ? "all flights" : info.year + " flights";
      const size =
        info.bytes !== undefined && info.bytes > 0
          ? " (" + formatFileSize(info.bytes) + ")"
          : "";
      textEl.textContent = "Loading " + what + size + "…";
    }

    loadingEl.style.display = "block";
  }

  hideLoading(): void {
    const loadingEl = domCache.get("loading");
    if (loadingEl) loadingEl.style.display = "none";
  }

  async loadData(year: string): Promise<KMLDataset | null> {
    this.loadErrorReported = false;
    return await this.dataLoader.loadData(year);
  }

  async loadAirports(): Promise<Airport[]> {
    return await this.dataLoader.loadAirports();
  }

  async loadMetadata(): Promise<Metadata | null> {
    return await this.dataLoader.loadMetadata();
  }

  /**
   * Reload the dataset for the current year, rebuild the heatmap and the
   * visible colour layers, then refresh statistics and airport visibility.
   */
  async updateLayers(preloaded?: KMLDataset | null): Promise<void> {
    if (!this.app.map) return;

    const year = this.app.selectedYear;
    const requestId = ++this.updateRequestId;
    // Callers that already loaded this year pass the dataset in so that a
    // failed load is not retried (and re-reported) a second time here
    const data =
      preloaded !== undefined ? preloaded : await this.loadData(year);

    // A newer updateLayers() call superseded this one: drop the stale result
    if (requestId !== this.updateRequestId) return;

    if (!data) {
      if (!this.loadErrorReported) {
        showToast(
          "No flight data available for " +
            (year === "all" ? "all years" : year),
          "error",
        );
      }
      // The selection may have been cleared by the caller, so the panel and
      // the airport markers still have to follow it
      this.app.statsManager.updateStatsForSelection();
      this.app.airportManager.updateAirportOpacity();
      return;
    }

    this.app.currentData = data;

    // Filter coordinates based on active filters and isolate mode
    let filteredCoordinates = data.coordinates;
    const hasFilters =
      this.app.selectedYear !== "all" || this.app.selectedAircraft !== "all";
    const hasIsolation =
      this.app.isolateSelection && this.app.selectedPathIds.size > 0;

    if (hasFilters || hasIsolation) {
      // Get filtered path IDs based on year/aircraft
      const filteredPathIds = new Set<number>();
      data.path_info.forEach((pathInfo) => {
        const matchesYear =
          this.app.selectedYear === "all" ||
          (pathInfo.year !== undefined &&
            pathInfo.year.toString() === this.app.selectedYear);
        const matchesAircraft =
          this.app.selectedAircraft === "all" ||
          pathInfo.aircraft_registration === this.app.selectedAircraft;
        if (matchesYear && matchesAircraft) {
          filteredPathIds.add(pathInfo.id);
        }
      });

      // Extract coordinates from filtered segments
      const coordMap = new Map<string, Coordinate>();
      data.path_segments.forEach((segment) => {
        // Must match year/aircraft filter
        if (!filteredPathIds.has(segment.path_id)) return;

        // In isolate mode, also must match selected paths
        if (hasIsolation && !this.app.selectedPathIds.has(segment.path_id))
          return;

        const coords = segment.coords;
        if (coords && coords.length === 2) {
          const k0 = coords[0][0] + "," + coords[0][1];
          const k1 = coords[1][0] + "," + coords[1][1];
          if (!coordMap.has(k0)) coordMap.set(k0, coords[0]);
          if (!coordMap.has(k1)) coordMap.set(k1, coords[1]);
        }
      });

      filteredCoordinates = Array.from(coordMap.values());
    }

    // Update heatmap - only add if visible
    if (this.app.heatmapLayer) {
      this.app.heatmapLayer.remove();
    }

    // Create heatmap using leaflet.heat directly
    this.app.heatmapLayer = L.heatLayer(filteredCoordinates, {
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
    if (this.app.heatmapVisible && !this.app.replayManager.state.active) {
      this.app.heatmapLayer.addTo(this.app.map);
    }

    // Build airport-to-paths relationships from path_info
    this.app.airportToPaths = {};
    data.path_info.forEach((pathInfo) => {
      const pathId = pathInfo.id;
      if (pathInfo.start_airport) {
        const startSet =
          this.app.airportToPaths[pathInfo.start_airport] ?? new Set<number>();
        startSet.add(pathId);
        this.app.airportToPaths[pathInfo.start_airport] = startSet;
      }
      if (pathInfo.end_airport) {
        const endSet =
          this.app.airportToPaths[pathInfo.end_airport] ?? new Set<number>();
        endSet.add(pathId);
        this.app.airportToPaths[pathInfo.end_airport] = endSet;
      }
    });

    // Calculate altitude range from all segments
    if (data.path_segments.length > 0) {
      this.app.altitudeRange = calculateAltitudeRange(
        data.path_segments,
        null,
        this.app.altitudeRange,
      );
    }

    // Rebuild only the visible colour layers; hidden layers are rendered
    // when they get toggled on (and cleared here so they hold no stale data)
    if (this.app.altitudeVisible) {
      this.app.layerManager.redrawAltitudePaths();
    } else {
      this.app.layerManager.clearLayer("altitude");
    }
    if (this.app.airspeedVisible) {
      this.app.layerManager.redrawAirspeedPaths();
    } else {
      this.app.layerManager.clearLayer("airspeed");
    }

    // Statistics and airport visibility follow the new data/filter state
    this.app.statsManager.updateStatsForSelection();
    this.app.airportManager.updateAirportOpacity();
  }
}
