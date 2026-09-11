/**
 * Data Manager - Handles data loading and layer refresh
 */
import * as L from "leaflet";
import type { MapApp } from "../mapApp";
import type {
  KMLDataset,
  Airport,
  LoadingInfo,
  Metadata,
  PathSegment,
} from "../types";
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
   *
   * The indicator is a live region, and a live region only announces text
   * that changes while it is displayed, so it is shown before it is written.
   */
  showLoading(info?: LoadingInfo): void {
    const loadingEl = domCache.get("loading");
    if (!loadingEl) return;

    loadingEl.style.display = "block";

    const textEl = domCache.get("loading-text");
    if (textEl && info) {
      const what = info.year === "all" ? "all flights" : info.year + " flights";
      const size =
        info.bytes !== undefined && info.bytes > 0
          ? " (" + formatFileSize(info.bytes) + ")"
          : "";
      textEl.textContent = "Loading " + what + size + "…";
    }
  }

  hideLoading(): void {
    const loadingEl = domCache.get("loading");
    if (loadingEl) loadingEl.style.display = "none";
  }

  /**
   * Fade the heatmap back while a colour layer is drawn over it.
   *
   * Both are on by default, and the heatmap's cyan bloom under the altitude
   * or speed gradient washes out exactly the scale the user just switched on.
   * The layer stays visible and its toggle still owns whether it is there at
   * all; this only settles which of the two reads first.
   */
  applyHeatmapEmphasis(): void {
    const canvas = this.app.heatmapLayer?._canvas;
    if (!canvas) return;
    const colorLayerOn = this.app.altitudeVisible || this.app.airspeedVisible;
    // How far it steps back is a design decision, so it lives in the
    // stylesheet with the rest of them rather than as a number in here
    canvas.classList.toggle("heatmap-dimmed", colorLayerOn);
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
   * Reload the dataset for the current year, then rebuild the heatmap and
   * the visible colour layers. The statistics panel and the airport markers
   * follow the store on their own.
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
      return;
    }

    this.app.currentData = data;

    // Filter coordinates based on active filters and isolate mode
    let filteredCoordinates = data.coordinates;
    const hasIsolation =
      this.app.isolateSelection && this.app.selectedPathIds.size > 0;

    // Path ids the year/aircraft filter keeps. Checking the path info (about a
    // hundred entries) is what says whether the filter changes anything at
    // all: a year filter over that year's own file keeps every path, and then
    // data.coordinates already is the answer. Walking every segment to
    // rediscover that costs two string keys per segment for nothing.
    const filteredPathIds = new Set<number>();
    let allPathsMatch = true;
    for (const pathInfo of data.path_info) {
      const matchesYear =
        this.app.selectedYear === "all" ||
        (pathInfo.year !== undefined &&
          pathInfo.year.toString() === this.app.selectedYear);
      const matchesAircraft =
        this.app.selectedAircraft === "all" ||
        pathInfo.aircraft_registration === this.app.selectedAircraft;
      if (matchesYear && matchesAircraft) {
        filteredPathIds.add(pathInfo.id);
      } else {
        allPathsMatch = false;
      }
    }

    if (hasIsolation || !allPathsMatch) {
      filteredCoordinates = heatmapCoordinates(data.path_segments, (pathId) =>
        hasIsolation
          ? this.app.selectedPathIds.has(pathId)
          : filteredPathIds.has(pathId),
      );
    }

    // The heat layer is created once and fed new points from then on; a
    // fresh layer per filter change meant a new canvas every time
    let heatLayer = this.app.heatmapLayer;
    if (heatLayer) {
      heatLayer.setLatLngs(filteredCoordinates);
    } else {
      heatLayer = L.heatLayer(filteredCoordinates, {
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
      this.app.heatmapLayer = heatLayer;
    }

    // Only add to map if heatmap is visible AND not in replay mode
    if (this.app.heatmapVisible && !this.app.replayManager.state.active) {
      if (!this.app.map.hasLayer(heatLayer)) {
        heatLayer.addTo(this.app.map);
      }
      if (heatLayer._canvas) {
        heatLayer._canvas.style.pointerEvents = "none";
      }
      this.applyHeatmapEmphasis();
    }

    // Build airport-to-paths relationships from path_info
    this.app.airportToPaths = {};
    for (const pathInfo of data.path_info) {
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
    }

    // Calculate altitude range from all segments
    if (data.path_segments.length > 0) {
      this.app.altitudeRange = calculateAltitudeRange(
        data.path_segments,
        null,
        this.app.altitudeRange,
        data.path_info,
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
  }
}

/**
 * The heatmap points of the paths `keep` accepts: every kept segment's start
 * point plus the end point of each path, the same set the loader builds for
 * the whole dataset. Neighbouring segments share their coordinate array, so
 * no key has to be built to avoid listing a point twice.
 */
export function heatmapCoordinates(
  segments: PathSegment[],
  keep: (pathId: number) => boolean,
): Coordinate[] {
  const coordinates: Coordinate[] = [];
  let lastKept: [Coordinate, Coordinate] | null = null;
  let lastPathId = -1;

  for (const segment of segments) {
    if (!keep(segment.path_id)) continue;
    const coords = segment.coords;
    if (!coords) continue;

    if (lastKept && segment.path_id !== lastPathId) {
      coordinates.push(lastKept[1]);
    }
    coordinates.push(coords[0]);
    lastKept = coords;
    lastPathId = segment.path_id;
  }
  if (lastKept) coordinates.push(lastKept[1]);

  return coordinates;
}
