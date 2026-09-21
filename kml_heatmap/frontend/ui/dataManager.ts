/**
 * Data Manager - Handles data loading and layer refresh
 */
import type {
  ExpressionSpecification,
  GeoJSONSource,
  HeatmapLayerSpecification,
} from "maplibre-gl";
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
import { datasetIndex } from "../calculations/datasetIndex";
import { calculateAltitudeRange } from "../features/layers";
import {
  HEATMAP_BANDS,
  MAP_LAYERS,
  MAP_MAX_ZOOM,
  MAP_SOURCES,
} from "../utils/constants";
import { domCache } from "../utils/domCache";
import { formatFileSize } from "../utils/formatters";
import { cssVar, toLngLat } from "../utils/mapHelpers";
import { showToast } from "../utils/toast";

/*
 * The look of the heatmap, tuned side by side against what leaflet.heat drew
 * for the same flights (radius 10, blur 15, minOpacity 0.25 and a gradient
 * from blue over cyan, lime and yellow to red). The numbers live here so
 * that a later visual pass has one place to turn.
 */

/** Reach of one point in pixels; leaflet.heat's radius plus its blur was 25 */
const HEATMAP_RADIUS_PX = 22;
/** Every point counts the same; a track has no heavier and lighter fixes */
const HEATMAP_WEIGHT = 1;
/**
 * The zoom at which the fixes of a track (a few hundred metres apart) are
 * about one radius apart on screen, and the intensity a point has there.
 * With the radius above it puts the ridge of a single track at a density
 * of about 0.015, which the gradient below draws in teal.
 */
const HEATMAP_REFERENCE_ZOOM = 12;
const HEATMAP_REFERENCE_INTENSITY = 0.0375;
/** Opacity of the layer when no colour layer is drawn over it */
const HEATMAP_OPACITY = 1;
/** Stand-in for `--heatmap-dimmed-opacity` when the stylesheet has none */
const HEATMAP_DIMMED_OPACITY_FALLBACK = 0.35;
/**
 * Colour and opacity by density: `[density, "r, g, b", alpha]`.
 *
 * The colours are leaflet.heat's, the spacing is not. leaflet.heat drew
 * every point as a translucent disc, and discs painted over one another
 * saturate: fifty flights over the home airfield came out a little warmer
 * than one, not fifty times as hot. The map adds densities up instead, so
 * on an even scale one track is nearly invisible next to the places flown
 * over every week, which turn into a red blob. The stops therefore sit
 * closer together the lower they are: each is about four times the one
 * before, so a single track is teal, a busy route green, and only the
 * airfields themselves reach yellow and beyond. The faintest stop keeps
 * leaflet.heat's least opacity, below which a lone track is lost on the map.
 */
const HEATMAP_GRADIENT: readonly (readonly [number, string, number])[] = [
  [0, "0, 0, 255", 0],
  [0.004, "0, 90, 255", 0.25],
  [0.015, "0, 200, 190", 0.5],
  [0.06, "0, 235, 110", 0.6],
  [0.25, "170, 255, 0", 0.7],
  [0.6, "255, 230, 0", 0.85],
  [1, "255, 90, 0", 1],
];

/**
 * Intensity of a point by zoom. The fixes of a track are a fixed distance
 * apart on the ground, so every level zoomed out puts twice as many of them
 * under one pixel of the track and the density there doubles. Halving the
 * intensity per level (an exponential interpolation of base 2 between two
 * stops that are themselves a power of two apart is exactly 2^zoom) cancels
 * that, and a single track keeps about the same colour at every zoom.
 *
 * Above the reference zoom the fixes no longer overlap: they are dots, and
 * the density of a dot does not depend on the zoom. The intensity stays
 * where it is from there on, or every dot would end up red.
 *
 * A layer that draws only every `stride`-th fix (see HEATMAP_BANDS) makes
 * each of them that many times as heavy, so the density comes out the same.
 * The stops are scaled rather than the expression wrapped in a product,
 * because `zoom` may only be the input of a top-level interpolation.
 */
function heatmapIntensity(stride: number): ExpressionSpecification {
  const reference = HEATMAP_REFERENCE_INTENSITY * stride;
  return [
    "interpolate",
    ["exponential", 2],
    ["zoom"],
    0,
    reference / 2 ** HEATMAP_REFERENCE_ZOOM,
    HEATMAP_REFERENCE_ZOOM,
    reference,
    Math.max(MAP_MAX_ZOOM, HEATMAP_REFERENCE_ZOOM + 1),
    reference,
  ];
}

/** Colour and opacity by density, see HEATMAP_GRADIENT */
function heatmapColor(): ExpressionSpecification {
  return [
    "interpolate",
    ["linear"],
    ["heatmap-density"],
    ...HEATMAP_GRADIENT.flatMap(([density, rgb, alpha]) => [
      density,
      `rgba(${rgb}, ${alpha})`,
    ]),
  ] as ExpressionSpecification;
}

/**
 * The paint of a heat layer, which the map creates without any. All heat
 * layers look the same; `stride` is how many fixes one drawn point of the
 * layer stands for (1 for the layer that draws them all).
 */
export function heatmapPaint(
  stride = 1,
): NonNullable<HeatmapLayerSpecification["paint"]> {
  return {
    "heatmap-radius": HEATMAP_RADIUS_PX,
    "heatmap-weight": HEATMAP_WEIGHT,
    "heatmap-intensity": heatmapIntensity(stride),
    "heatmap-color": heatmapColor(),
    "heatmap-opacity": HEATMAP_OPACITY,
  };
}

export class DataManager {
  private app: MapApp;
  private dataLoader: DataLoader;
  /** Monotonic id of the latest updateLayers() call; stale loads are dropped */
  private updateRequestId = 0;
  /** Set when the loader already reported a failure via toast */
  private loadErrorReported = false;
  /** Year the published dataset was loaded for */
  private dataYear: string | null = null;
  /** The heat layers have their paint; they are created without one */
  private heatmapPainted = false;

  constructor(app: MapApp) {
    this.app = app;

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
    const map = this.app.map;
    // The store may change before the style, and with it the layer, is there
    if (!map?.getLayer(MAP_LAYERS.heat)) return;
    const dimmed = this.app.altitudeVisible || this.app.airspeedVisible;
    const opacity = dimmed ? dimmedHeatmapOpacity() : HEATMAP_OPACITY;
    // All of them, or the heatmap would change strength with the zoom
    for (const band of HEATMAP_BANDS) {
      if (map.getLayer(band.layer)) {
        map.setPaintProperty(band.layer, "heatmap-opacity", opacity);
      }
    }
  }

  /**
   * Give the heat layers their look, once. They are created bare (see
   * addDataLayers), and what they look like is this module's business.
   */
  private paintHeatmap(): void {
    const map = this.app.map;
    if (this.heatmapPainted || !map?.getLayer(MAP_LAYERS.heat)) return;
    for (const band of HEATMAP_BANDS) {
      if (!map.getLayer(band.layer)) continue;
      const paint = heatmapPaint(band.stride);
      for (const name of Object.keys(paint) as (keyof typeof paint)[]) {
        map.setPaintProperty(band.layer, name, paint[name]);
      }
    }
    this.heatmapPainted = true;
  }

  /**
   * Hand the heat source its points: one MultiPoint per level of detail,
   * each for the heat layer that filters on its `detail`. A hidden layer takes
   * them as well as a visible one, so nothing has to wait for the layer to
   * be shown.
   */
  private setHeatmapPoints(points: Coordinate[]): void {
    const source = this.app.map?.getSource<GeoJSONSource>(MAP_SOURCES.heat);
    if (!source) return;
    this.paintHeatmap();
    // The promise is for the worker having taken the data. It does not
    // reject: a failure arrives as an `error` event of the map
    void source.setData(heatmapFeatures(points.map(toLngLat)));
  }

  /**
   * Show the heat layer, with the dimming it gets under a colour layer.
   * Every place that shows the layer goes through here, so none is left
   * without it.
   */
  showHeatmap(): void {
    if (!this.app.map) return;
    this.paintHeatmap();
    this.app.heatmapLayer.setVisible(true);
    this.applyHeatmapEmphasis();
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
   * Rebuild the heatmap and the visible colour layers for the current year,
   * loading its dataset first when it is not the one on the map. The
   * statistics panel and the airport markers follow the store on their own.
   *
   * @param preloaded - The current year's dataset, from a caller that has
   *   already loaded it, so a failed load is not retried (and reported) twice
   */
  async updateLayers(preloaded?: KMLDataset | null): Promise<void> {
    if (!this.app.map) return;

    const year = this.app.selectedYear;
    const requestId = ++this.updateRequestId;
    // A redraw for the selection or the aircraft keeps the dataset on the
    // map. Loading it again would retry a year that failed to load, report
    // it once more and publish a new dataset that every consumer recomputes;
    // only a year switch retries.
    const current = this.app.currentData;
    const data =
      preloaded !== undefined
        ? preloaded
        : current !== null && this.dataYear === year
          ? current
          : await this.loadData(year);

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
    this.dataYear = year;

    // Filter coordinates based on active filters and isolate mode
    let filteredCoordinates = data.coordinates;
    const selected = this.app.selectedPathIds;
    const hasIsolation = this.app.isolateSelection && selected.size > 0;

    // What the year/aircraft filter keeps. A year filter over that year's own
    // file keeps every path, and then data.coordinates already is the answer.
    const view = datasetIndex(data).filter(
      this.app.selectedYear,
      this.app.selectedAircraft,
    );

    if (hasIsolation || !view.keepsAll) {
      // Isolation shows the selected paths the filter keeps, exactly what
      // the colour layers draw
      filteredCoordinates = heatmapCoordinates(data.path_segments, (pathId) =>
        hasIsolation
          ? selected.has(pathId) && view.pathIds.has(pathId)
          : view.pathIds.has(pathId),
      );
    }

    this.setHeatmapPoints(filteredCoordinates);

    // Only shown if the heatmap is on AND no replay is running
    if (this.app.heatmapVisible && !this.app.replayState.active) {
      this.showHeatmap();
    }

    // Calculate altitude range from all segments
    if (data.path_segments.length > 0) {
      this.app.altitudeRange = calculateAltitudeRange(
        data.path_segments,
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
 * The content of the heat source: for every level of detail a MultiPoint of
 * every `stride`-th point, marked with its `detail` (see HEATMAP_BANDS).
 *
 * The points are in the order they were flown, so taking them at a stride
 * thins a track out evenly and keeps its shape. Counting from the first
 * point means every level has at least that one, however few points there
 * are: a MultiPoint without coordinates is not valid GeoJSON. With no points
 * at all there are no features either.
 */
export function heatmapFeatures(
  points: [number, number][],
): GeoJSON.FeatureCollection<GeoJSON.MultiPoint> {
  if (points.length === 0) return { type: "FeatureCollection", features: [] };
  return {
    type: "FeatureCollection",
    features: HEATMAP_BANDS.map(({ detail, stride }) => ({
      type: "Feature",
      properties: { detail },
      geometry: {
        type: "MultiPoint",
        coordinates:
          stride === 1
            ? points
            : points.filter((_, index) => index % stride === 0),
      },
    })),
  };
}

/**
 * How far the heatmap steps back under a colour layer. That is a design
 * decision, so it lives in the stylesheet with the rest of them; a paint
 * property cannot read `var()`, so the token is read here.
 */
function dimmedHeatmapOpacity(): number {
  const value = Number.parseFloat(cssVar("--heatmap-dimmed-opacity"));
  return Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : HEATMAP_DIMMED_OPACITY_FALLBACK;
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
