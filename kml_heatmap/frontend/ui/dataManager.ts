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
  LoadingState,
  Metadata,
  PathSegment,
} from "../types";
import type { Coordinate } from "../utils/geometry";
import { DataLoader } from "../services/dataLoader";
import { datasetIndex } from "../calculations/datasetIndex";
import { calculateAltitudeRange } from "../features/layers";
import {
  HEATMAP_CLUSTER,
  MAP_LAYERS,
  MAP_MAX_ZOOM,
  MAP_SOURCES,
} from "../utils/constants";
import { domCache } from "../utils/domCache";
import { formatFileSize } from "../utils/formatters";
import { frameCoalescer } from "../utils/frameCoalescer";
import { cssVar, toLngLat } from "../utils/mapHelpers";
import { showToast } from "../utils/toast";

/*
 * The look of the heatmap, tuned side by side against what leaflet.heat drew
 * for the same flights (radius 10, blur 15, minOpacity 0.25 and a gradient
 * from blue over cyan, lime and yellow to red). The numbers live here so
 * that a later visual pass has one place to turn.
 */

/** Reach of one point in pixels; leaflet.heat's radius plus its blur was 25 */
export const HEATMAP_RADIUS_PX = 22;
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
 * Clusters (see HEATMAP_CLUSTER) leave the curve as it is. The density at
 * a pixel is the sum of weight times kernel over the points around it, and
 * a cluster carries the weight of its fixes, only moved to their centre. No
 * fix moves further than twice the cluster radius, about half the kernel's,
 * and most far less, so the sum along a track is the one the fixes
 * themselves would give.
 */
function heatmapIntensity(): ExpressionSpecification {
  return [
    "interpolate",
    ["exponential", 2],
    ["zoom"],
    0,
    intensityAt(0),
    HEATMAP_REFERENCE_ZOOM,
    intensityAt(HEATMAP_REFERENCE_ZOOM),
    Math.max(MAP_MAX_ZOOM, HEATMAP_REFERENCE_ZOOM + 1),
    intensityAt(HEATMAP_REFERENCE_ZOOM),
  ];
}

/** What heatmapIntensity comes to at `zoom` */
function intensityAt(zoom: number): number {
  return (
    HEATMAP_REFERENCE_INTENSITY /
    2 ** Math.max(HEATMAP_REFERENCE_ZOOM - zoom, 0)
  );
}

/**
 * The first zoom at which the fixes are drawn as they are, and what one of
 * them contributes there, weight times intensity. That is the least a drawn
 * point may contribute: see heatmapWeight.
 */
const HEATMAP_FIXES_FROM_ZOOM = HEATMAP_CLUSTER.maxZoom + 1;
export const HEATMAP_LEAST_CONTRIBUTION = intensityAt(HEATMAP_FIXES_FROM_ZOOM);

/**
 * Weight of a drawn point by zoom. Every fix counts the same, a track has no
 * heavier and lighter ones, and a cluster (see HEATMAP_CLUSTER) counts as the
 * fixes it stands for.
 *
 * But not every fix finds a cluster. The exporter keeps the vertices a KML
 * has, and those of a planned route or a slow logger are kilometres apart,
 * further than the cluster radius reaches. Such a fix stays a point of
 * weight 1 at every zoom while the intensity keeps halving. MapLibre sizes
 * the kernel of a point from weight times intensity: under about 0.004 the
 * kernel shrinks, and under 0.0006 its size is not a number at all. So the
 * weight never lets a point contribute less than a fix does at the first
 * zoom without clusters, where it is a faint dot: at zoom z that takes a
 * weight of intensity(first) / intensity(z), one more power of two per
 * level out. Tried and dropped: a floor four times as high shows a sparse
 * track as a line at every zoom, but it also lifts the clusters of a lone
 * normal track, which then changes colour at the first zoom without them.
 *
 * A cluster of a normal track holds more fixes than that at every zoom (see
 * HEATMAP_CLUSTER), so the floor leaves it alone. `zoom` may only be the
 * input of a top-level interpolation, hence a stop per level with the floor
 * inside. Between two levels the floor halves, which the base 1/2 follows
 * exactly; a count above both floors is the same at both stops and stays.
 */
function heatmapWeight(): ExpressionSpecification {
  const count: ExpressionSpecification = [
    "coalesce",
    ["get", "point_count"],
    1,
  ];
  const stops: (number | ExpressionSpecification)[] = [];
  for (let zoom = 0; zoom < HEATMAP_FIXES_FROM_ZOOM; zoom++) {
    stops.push(zoom, [
      "max",
      count,
      HEATMAP_LEAST_CONTRIBUTION / intensityAt(zoom),
    ]);
  }
  stops.push(HEATMAP_FIXES_FROM_ZOOM, count);
  return [
    "interpolate",
    ["exponential", 0.5],
    ["zoom"],
    ...stops,
  ] as ExpressionSpecification;
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

/** The paint of the heat layer, which the map creates without any */
export function heatmapPaint(): NonNullable<
  HeatmapLayerSpecification["paint"]
> {
  return {
    "heatmap-radius": HEATMAP_RADIUS_PX,
    "heatmap-weight": heatmapWeight(),
    "heatmap-intensity": heatmapIntensity(),
    "heatmap-color": heatmapColor(),
    "heatmap-opacity": HEATMAP_OPACITY,
  };
}

/** What the indicator says: "Loading 2026 flights (1.1 MB)…" */
function loadingLabel(state: LoadingState): string {
  const what = state.all ? "all" : state.years.join(", ");
  const size =
    state.fileBytes !== undefined
      ? " (" + formatFileSize(state.fileBytes) + ")"
      : "";
  return "Loading " + (what ? what + " " : "") + "flights" + size + "…";
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
  /** The heat layer has its paint; it is created without one */
  private heatmapPainted = false;
  /** The points the heat source holds, to not send them a second time */
  private heatmapPoints: readonly Coordinate[] | null = null;
  /** The indicator is up; asked on every chunk, so not asked of the DOM */
  private loadingShown = false;
  /** The operation the bar on screen belongs to, see LoadingState */
  private drawnOperation: number | null = null;
  /**
   * Chunks arrive far more often than the screen repaints, so the indicator
   * is brought up to date once per frame, from the latest state
   */
  private readonly loadingFrame = frameCoalescer<LoadingState>((state) =>
    this.drawLoading(state),
  );
  private destroyed = false;

  constructor(app: MapApp) {
    this.app = app;

    this.dataLoader = new DataLoader({
      dataDir: app.config.dataDir,
      showLoading: (state) => this.showLoading(state),
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
   * Show the loading indicator, or bring it up to date: the loader calls
   * this on every change of what it is loading, down to every chunk.
   *
   * The label is announced by a live region. One that appears with its text
   * in place is passed over by many screen readers; what they announce is
   * text that changes while the region is displayed. So the indicator comes
   * up without a label, which also keeps the one of the last load from
   * showing while frames are held back, and is written a frame later.
   */
  showLoading(state: LoadingState): void {
    // A request that outlives the app still reports
    if (this.destroyed) return;
    if (!this.loadingShown) {
      const loadingEl = domCache.get("loading");
      if (!loadingEl) return;
      this.loadingShown = true;
      loadingEl.style.display = "block";
      const textEl = domCache.get("loading-text");
      if (textEl) textEl.textContent = "";
    }
    this.loadingFrame.schedule(state);
  }

  hideLoading(): void {
    this.loadingFrame.cancel();
    this.loadingShown = false;
    const loadingEl = domCache.get("loading");
    if (loadingEl) loadingEl.style.display = "none";
    const bar = domCache.get("loading-progress");
    if (bar) hideProgressBar(bar);
  }

  /**
   * Stop drawing, and take the indicator down: a load that is still under
   * way would otherwise leave it up with nobody to hide it
   */
  destroy(): void {
    this.destroyed = true;
    this.hideLoading();
  }

  private drawLoading(state: LoadingState): void {
    // Whatever changes what the label says is worth saying: another year,
    // all of them, or one that failed and is no longer waited for
    const textEl = domCache.get("loading-text");
    const label = loadingLabel(state);
    if (textEl && textEl.textContent !== label) textEl.textContent = label;

    const bar = domCache.get("loading-progress");
    if (!bar) return;
    const { operation, loadedBytes, totalBytes } = state;
    // Without a total there is no share to draw: the spinner already says
    // that something is loading, which is all that is known then
    if (totalBytes === undefined) {
      hideProgressBar(bar);
      return;
    }
    const incomplete = loadedBytes < totalBytes;
    // The stylesheet lets the bar appear a moment after it is displayed, so
    // that a load that is over at once shows none. A new operation gets
    // that moment again, or a year that joins from the HTTP cache would
    // flash past on the bar of a slow one; that takes the bar being taken
    // out and the style being worked out without it.
    if (operation !== this.drawnOperation && incomplete && !bar.hidden) {
      bar.hidden = true;
      void bar.offsetWidth;
    }
    this.drawnOperation = operation;
    // A bar that is up is kept, full; none is brought up for bytes that
    // are all in, since the delay would only put off its flash
    if (bar.hidden && !incomplete) return;

    bar.hidden = false;
    // The CSP allows no style attribute in the markup; the CSSOM is fine
    bar.style.setProperty(
      "--loading-progress",
      String(incomplete ? loadedBytes / totalBytes : 1),
    );
    // In steps of ten: a screen reader that follows the value would
    // otherwise have something new to say on every frame. Worked out on the
    // byte counts, which are whole numbers and land on a step exactly.
    const step = String(
      incomplete ? Math.floor((loadedBytes * 10) / totalBytes) * 10 : 100,
    );
    if (bar.getAttribute("aria-valuenow") !== step) {
      bar.setAttribute("aria-valuenow", step);
    }
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
    map.setPaintProperty(MAP_LAYERS.heat, "heatmap-opacity", opacity);
  }

  /**
   * Give the heat layer its look, once. It is created bare (see
   * addDataLayers), and what it looks like is this module's business.
   */
  private paintHeatmap(): void {
    const map = this.app.map;
    if (this.heatmapPainted || !map?.getLayer(MAP_LAYERS.heat)) return;
    const paint = heatmapPaint();
    for (const name of Object.keys(paint) as (keyof typeof paint)[]) {
      map.setPaintProperty(MAP_LAYERS.heat, name, paint[name]);
    }
    this.heatmapPainted = true;
  }

  /**
   * Hand the heat source its points. A hidden layer takes them as well as a
   * visible one, so nothing has to wait for the layer to be shown.
   *
   * Not every redraw changes them: a selection without isolation, or an
   * aircraft that flew every path of the year, leaves the same points. A
   * feature per fix is costly to hand to the worker (about 60 ms of main
   * thread for 135000 of them), so the same points are not sent again. The
   * coordinates are the dataset's own arrays, never copies, so comparing
   * them one by one by identity is both exact and cheap.
   */
  private setHeatmapPoints(points: readonly Coordinate[]): void {
    const source = this.app.map?.getSource<GeoJSONSource>(MAP_SOURCES.heat);
    if (!source) return;
    this.paintHeatmap();
    const held = this.heatmapPoints;
    if (
      held?.length === points.length &&
      held.every((point, index) => point === points[index])
    ) {
      return;
    }
    this.heatmapPoints = points;
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
 * The content of the heat source: one Point per fix. A MultiPoint of all of
 * them would be cheaper to hand to the worker, but the source can only
 * merge features into clusters, not the points of one feature (see
 * HEATMAP_CLUSTER).
 */
export function heatmapFeatures(
  points: [number, number][],
): GeoJSON.FeatureCollection<GeoJSON.Point> {
  return {
    type: "FeatureCollection",
    features: points.map((coordinates) => ({
      type: "Feature",
      properties: null,
      geometry: { type: "Point", coordinates },
    })),
  };
}

/**
 * Back to the state without a known share: no bar, no value. Asked of the
 * bar itself, so that it holds for one that another instance left behind;
 * cheap when it is hidden already, which is every frame of a load without
 * sizes.
 */
function hideProgressBar(bar: HTMLElement): void {
  if (bar.hidden) return;
  bar.hidden = true;
  bar.removeAttribute("aria-valuenow");
  bar.style.removeProperty("--loading-progress");
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
