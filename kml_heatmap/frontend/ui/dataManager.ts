/**
 * Data Manager - Handles data loading and layer refresh
 */
import type { GeoJSONSource } from "maplibre-gl";
import type { MapApp } from "../mapApp";
import type { StoreState } from "../state/store";
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
import { heatLineFeatures } from "../calculations/heatLines";
import { HEAT_LINES, MAP_LAYERS, MAP_SOURCES } from "../utils/constants";
import { domCache } from "../utils/domCache";
import { formatFileSize } from "../utils/formatters";
import { frameCoalescer } from "../utils/frameCoalescer";
import { cssVar, toLngLat, whenContextRestored } from "../utils/mapHelpers";
import { showToast } from "../utils/toast";
import {
  HEATMAP_OPACITY,
  fadeOutToLines,
  heatLineOpacities,
  heatLinesPaint,
  heatmapPaint,
} from "./heatmapPaint";

/** Stand-in for `--heatmap-dimmed-opacity` when the stylesheet has none */
const HEATMAP_DIMMED_OPACITY_FALLBACK = 0.35;

/** The keys that decide what the heatmap and the colour layers draw */
const DRAWN_KEYS: readonly (keyof StoreState)[] = [
  "currentData",
  "selectedYear",
  "selectedAircraft",
  "selectedPathIds",
  "isolateSelection",
];

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
  /** Set when the loader already reported a failure via toast */
  private loadErrorReported = false;
  /** What the layers were last drawn for, to tell a restyle from a rebuild */
  private drawn: {
    data: KMLDataset;
    year: string;
    aircraft: string;
    isolate: boolean;
  } | null = null;
  /** The heat layer has its paint; it is created without one */
  private heatmapPainted = false;
  /**
   * What the heat source is to show: its points, and the flights its heat
   * lines are drawn from. Kept for a map that cannot take it yet (no
   * source, or a lost WebGL context), and for the heat lines, which are
   * worked out only once they can show (see writeHeatLines).
   */
  private heat: {
    points: readonly Coordinate[];
    segments: PathSegment[];
    keep: (pathId: number) => boolean;
  } | null = null;
  /** The points the heat source holds, to not send them a second time */
  private heatmapPoints: readonly Coordinate[] | null = null;
  /** The points the heat lines source was last worked out for */
  private heatLinesPoints: readonly Coordinate[] | null = null;
  /** Zoomed in to the hand-over, the heat lines are worked out */
  private readonly handleZoom = (): void => this.writeHeatLines();
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
      onLoadError: (failedYears, stale) => {
        this.loadErrorReported = true;
        showToast(
          "Failed to load flight data for " +
            failedYears.join(", ") +
            // The site was published again since the page was loaded
            (stale ? ". Reload the page to update it." : ""),
          "error",
        );
      },
    });

    // The layers follow the dataset, the filter and the selection, whoever
    // changes them. Before the first dataset there is nothing to draw.
    app.store.subscribeKeys(DRAWN_KEYS, () => this.followStore());

    void app.mapReady.then(
      (map) => {
        map.on("zoom", this.handleZoom);
        whenContextRestored(map, () => this.writeHeat());
      },
      () => {},
    );
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
   * Stop drawing, end the year worker, and take the indicator down: a load
   * that is still under way would otherwise leave it up with nobody to hide it
   */
  destroy(): void {
    this.destroyed = true;
    this.app.map?.off("zoom", this.handleZoom);
    this.dataLoader.destroy();
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
    map.setPaintProperty(
      MAP_LAYERS.heat,
      "heatmap-opacity",
      fadeOutToLines(opacity),
    );
    // The lines it hands over to step back as far
    const lines = heatLineOpacities(opacity / HEATMAP_OPACITY);
    for (const [id, lineOpacity] of [
      [MAP_LAYERS.heatLinesGlow, lines.glow],
      [MAP_LAYERS.heatLinesCore, lines.core],
    ] as const) {
      if (map.getLayer(id))
        map.setPaintProperty(id, "line-opacity", lineOpacity);
    }
  }

  /**
   * Give the heat layer and its lines their look, once. They are created
   * bare (see addDataLayers), and what they look like is this module's
   * business.
   */
  private paintHeatmap(): void {
    const map = this.app.map;
    if (this.heatmapPainted || !map?.getLayer(MAP_LAYERS.heat)) return;
    const paint = heatmapPaint();
    for (const name of Object.keys(paint) as (keyof typeof paint)[]) {
      map.setPaintProperty(MAP_LAYERS.heat, name, paint[name]);
    }
    for (const [id, linePaint] of Object.entries(heatLinesPaint())) {
      if (!map.getLayer(id)) continue;
      for (const name of Object.keys(linePaint) as (keyof typeof linePaint)[]) {
        map.setPaintProperty(id, name, linePaint[name]);
      }
    }
    this.heatmapPainted = true;
    // The paint above is the undimmed one
    this.applyHeatmapEmphasis();
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
  private setHeatmapPoints(
    points: readonly Coordinate[],
    segments: PathSegment[],
    keep: (pathId: number) => boolean,
  ): void {
    const held = this.heat?.points;
    if (
      held?.length !== points.length ||
      !held.every((point, index) => point === points[index])
    ) {
      this.heat = { points, segments, keep };
    }
    this.writeHeat();
  }

  /** Write what the heat source is to show and does not hold yet */
  private writeHeat(): void {
    const heat = this.heat;
    const source = this.app.map?.getSource<GeoJSONSource>(MAP_SOURCES.heat);
    if (!heat || !source || this.destroyed) return;
    this.paintHeatmap();
    if (this.heatmapPoints !== heat.points) {
      this.heatmapPoints = heat.points;
      // The promise is for the worker having taken the data. It does not
      // reject: a failure arrives as an `error` event of the map
      void source.setData(heatmapFeatures(heat.points.map(toLngLat)));
    }
    this.writeHeatLines();
  }

  /**
   * The heat lines of the points the heatmap shows, worked out once they
   * can show: with the heatmap shown and zoomed in to where it hands over
   * to them (see HEAT_LINES), once per set of points. They are the same
   * flights as the points, and 150000 segments take 80 to 95 ms, which a
   * hidden or zoomed out heatmap has no use for.
   */
  private writeHeatLines(): void {
    const map = this.app.map;
    const heat = this.heat;
    if (
      !map ||
      !heat ||
      this.heatLinesPoints === heat.points ||
      !this.app.heatmapLayer.isVisible() ||
      map.getZoom() < HEAT_LINES.fromZoom
    ) {
      return;
    }
    const source = map.getSource<GeoJSONSource>(MAP_SOURCES.heatLines);
    if (!source) return;
    this.heatLinesPoints = heat.points;
    void source.setData(heatLineFeatures(heat.segments, heat.keep));
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
    this.writeHeatLines();
  }

  /**
   * Load a year's dataset. `signal` is aborted by a caller that no longer
   * waits for it (a year switch that another one replaced), so that the
   * indicator stops waiting for its year; another caller of the same year
   * still gets it.
   */
  async loadData(
    year: string,
    signal?: AbortSignal,
  ): Promise<KMLDataset | null> {
    this.loadErrorReported = false;
    const data = await this.dataLoader.loadData(year, signal);
    if (
      !data &&
      !this.loadErrorReported &&
      !signal?.aborted &&
      !this.destroyed
    ) {
      showToast(
        "No flight data available for " + (year === "all" ? "all years" : year),
        "error",
      );
    }
    return data;
  }

  async loadAirports(): Promise<Airport[]> {
    return await this.dataLoader.loadAirports();
  }

  async loadMetadata(): Promise<Metadata | null> {
    return await this.dataLoader.loadMetadata();
  }

  /**
   * Rebuild what a change of the dataset, the filter or isolation changes,
   * and only restyle the paths for a change of the selection alone
   */
  private followStore(): void {
    const { currentData, selectedYear, selectedAircraft, isolateSelection } =
      this.app;
    const drawn = this.drawn;
    if (
      drawn?.data === currentData &&
      drawn.year === selectedYear &&
      drawn.aircraft === selectedAircraft &&
      !drawn.isolate &&
      !isolateSelection
    ) {
      this.app.layerManager.updateSelectionStyles();
    } else {
      this.updateLayers();
    }
  }

  /**
   * Rebuild the heatmap and the colour layers for the dataset on the map.
   * The statistics panel and the airport markers follow the store on their
   * own, the visibility of the layers as well (see ui/layerVisibility.ts).
   */
  updateLayers(): void {
    const data = this.app.currentData;
    if (!this.app.map || !data) return;

    this.drawn = {
      data,
      year: this.app.selectedYear,
      aircraft: this.app.selectedAircraft,
      isolate: this.app.isolateSelection,
    };

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

    // Isolation shows the selected paths the filter keeps, exactly what
    // the colour layers draw
    const keep = (pathId: number): boolean =>
      hasIsolation
        ? selected.has(pathId) && view.pathIds.has(pathId)
        : view.pathIds.has(pathId);
    if (hasIsolation || !view.keepsAll) {
      filteredCoordinates = heatmapCoordinates(data.path_segments, keep);
    }

    this.setHeatmapPoints(
      filteredCoordinates,
      data.path_segments,
      hasIsolation || !view.keepsAll ? keep : () => true,
    );

    // Calculate altitude range from all segments
    if (data.path_segments.length > 0) {
      this.app.altitudeRange = calculateAltitudeRange(
        data.path_segments,
        this.app.altitudeRange,
        data.path_info,
      );
    }

    // Only the colour layers that show are drawn; the others are drawn as
    // they show, and hold no stale data meanwhile
    this.app.layerManager.syncModes(true);
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
