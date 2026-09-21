/**
 * Layer Manager - Handles altitude/airspeed path rendering and legend updates
 *
 * Rendering strategy:
 * - Paths are drawn on the shared canvas renderer (`app.pathRenderer`).
 * - Consecutive, contiguous segments of the same path whose value falls in
 *   the same one of COLOR_BINS steps of the colour range are merged into ONE
 *   polyline, drawn in the colour of the middle of its step. Merging by the
 *   rounded value instead made tens of thousands of polylines out of a
 *   groundspeed that never sits still, for colours no eye tells apart. The
 *   merged polyline keeps its segment list so the tooltip can show the exact
 *   data of the segment nearest to the cursor (`findNearestSegment`).
 * - Below SIMPLIFY_MAX_ZOOM the geometry of a polyline is simplified to a
 *   quarter of a screen pixel at the whole zoom level it is drawn at, and
 *   swapped when a zoom crosses into another whole level. Leaflet simplifies
 *   to a pixel when it renders anyway, but only after projecting every
 *   vertex, on every zoom. The heatmap, the replay and the statistics read
 *   the full data and are not affected.
 * - Polylines are tracked per path id; selection changes restyle them
 *   (`updateSelectionStyles`) and rebuild only the paths that were or are
 *   selected, whose runs follow the selection's colour range.
 * - Tooltip HTML is generated lazily when the tooltip opens.
 */
import * as L from "leaflet";
import type { MapApp } from "../mapApp";
import type { Range } from "../state/store";
import type { KMLDataset, PathInfo, PathSegment } from "../types";
import type { Coordinate } from "../utils/geometry";
import { getColorForAirspeed, getColorForAltitude } from "../utils/colors";
import { domCache } from "../utils/domCache";
import { generateSegmentPopupHtml } from "../utils/htmlGenerators";
import { datasetIndex } from "../calculations/datasetIndex";
import { segmentsForPathIds } from "../calculations/statistics";
import {
  calculateAirspeedRange,
  calculateAltitudeRange,
  calculateSegmentProperties,
  findNearestSegment,
  formatAirspeedLabel,
  formatAltitudeLabel,
} from "../features/layers";

export type LayerMode = "altitude" | "airspeed";

interface LayerConfig {
  mode: LayerMode;
  layer: L.LayerGroup;
  range: Range;
  getValue: (seg: PathSegment) => number;
  getColor: (value: number, min: number, max: number) => string;
  /** Range of the given segments, `fallback` when they have no value */
  computeRange: (
    segments: PathSegment[],
    fallback: Range,
    paths: PathInfo[],
  ) => Range;
  filterSegment?: (seg: PathSegment) => boolean;
  legendMinId: string;
  legendMaxId: string;
  formatLegend: (value: number) => string;
}

/** Colour steps a range is cut into; the merge key of a polyline */
const COLOR_BINS = 32;

/** From this zoom on, polylines keep every exported point */
const SIMPLIFY_MAX_ZOOM = 13;

interface PolylineEntry {
  polyline: L.Polyline;
  pathId: number;
  /** The value the polyline is coloured with: the middle of its colour step */
  value: number;
  /** Segments merged into this polyline, in drawing order */
  segments: PathSegment[];
}

/**
 * Whether the pointer cannot hover, so tooltips need a tap instead. Touch
 * support alone does not say: a laptop with a touchscreen is driven by its
 * mouse most of the time, and lost the hover tooltips for having one.
 */
export function isTouchDevice(): boolean {
  if (typeof window.matchMedia === "function") {
    return window.matchMedia("(hover: none)").matches;
  }
  return "ontouchstart" in window || navigator.maxTouchPoints > 0;
}

/** The whole zoom level geometry is simplified for, capped where it stops */
function simplifyZoom(map: L.Map | null): number {
  return Math.min(
    Math.floor(map?.getZoom() ?? SIMPLIFY_MAX_ZOOM),
    SIMPLIFY_MAX_ZOOM,
  );
}

/**
 * The value in the middle of the one of COLOR_BINS equal steps of `range`
 * that `value` falls in: the merge key of a run, and the value it is
 * coloured with
 */
function stepValue(value: number, range: Range): number {
  // The same normalisation as the colour ramps in utils/colors.ts
  const span = Math.max(range.max - range.min, 1);
  const step = Math.floor(((value - range.min) / span) * COLOR_BINS);
  return (
    range.min +
    ((Math.min(Math.max(step, 0), COLOR_BINS - 1) + 0.5) / COLOR_BINS) * span
  );
}

/**
 * Douglas-Peucker to a quarter pixel at `zoom`, on longitudes scaled by the
 * cosine of the latitude so that both axes are in degrees of latitude
 */
function simplify(latLngs: Coordinate[], zoom: number): Coordinate[] {
  if (zoom >= SIMPLIFY_MAX_ZOOM || latLngs.length < 3) return latLngs;
  const scale = Math.cos((latLngs[0]![0] * Math.PI) / 180);
  const points = latLngs.map((c, i) =>
    Object.assign(L.point(c[1] * scale, c[0]), { i }),
  );
  // A pixel spans 360 / 256 / 2^zoom degrees of longitude, and fewer
  // degrees of latitude by the cosine on a Mercator map
  const tolerance = ((0.25 * 360) / 256 / 2 ** zoom) * scale;
  return L.LineUtil.simplify(points, tolerance).map(
    (p) => latLngs[(p as typeof p & { i: number }).i]!,
  );
}

export class LayerManager {
  private app: MapApp;
  private polylinesByPath: Record<LayerMode, Map<number, PolylineEntry[]>> = {
    altitude: new Map(),
    airspeed: new Map(),
  };

  /** The zoom and the selection each drawn layer was built for */
  private built: Partial<
    Record<LayerMode, { zoom: number; selected: Set<number> }>
  > = {};

  private readonly handleZoom = (): void => this.onZoom();

  constructor(app: MapApp) {
    this.app = app;
    // On "zoom" rather than "zoomend": Leaflet projects every vertex again
    // on zoomend, and should find the new geometry there already
    app.map?.on("zoom", this.handleZoom);
  }

  /** Stop following the zoom; the drawn layers stay on the map */
  destroy(): void {
    this.app.map?.off("zoom", this.handleZoom);
  }

  /** Swap in the geometry of another zoom level where one was crossed */
  private onZoom(): void {
    const zoom = simplifyZoom(this.app.map);
    for (const mode of ["altitude", "airspeed"] as const) {
      const built = this.built[mode];
      if (!built || built.zoom === zoom) continue;
      built.zoom = zoom;
      for (const entries of this.polylinesByPath[mode].values()) {
        for (const { polyline, segments } of entries) {
          const latLngs = segments.map((segment) => segment.coords![1]);
          latLngs.unshift(segments[0]!.coords![0]);
          polyline.setLatLngs(simplify(latLngs, zoom));
        }
      }
    }
  }

  private getConfig(mode: LayerMode): LayerConfig {
    if (mode === "altitude") {
      return {
        mode,
        layer: this.app.altitudeLayer,
        range: this.app.altitudeRange,
        getValue: (seg) => seg.altitude_ft ?? 0,
        getColor: getColorForAltitude,
        computeRange: calculateAltitudeRange,
        legendMinId: "legend-min",
        legendMaxId: "legend-max",
        formatLegend: formatAltitudeLabel,
      };
    }
    return {
      mode,
      layer: this.app.airspeedLayer,
      range: this.app.airspeedRange,
      getValue: (seg) => seg.groundspeed_knots ?? 0,
      getColor: getColorForAirspeed,
      computeRange: (segments, fallback) =>
        calculateAirspeedRange(segments, fallback),
      filterSegment: (seg) => (seg.groundspeed_knots ?? 0) > 0,
      legendMinId: "airspeed-legend-min",
      legendMaxId: "airspeed-legend-max",
      formatLegend: formatAirspeedLabel,
    };
  }

  redrawAltitudePaths(): void {
    this.redrawPaths(this.getConfig("altitude"));
  }

  redrawAirspeedPaths(): void {
    this.redrawPaths(this.getConfig("airspeed"));
  }

  /**
   * Remove all polylines of a layer (used for hidden layers so they do not
   * keep stale geometry around)
   */
  clearLayer(mode: LayerMode): void {
    const config = this.getConfig(mode);
    config.layer.clearLayers();
    this.polylinesByPath[mode] = new Map();
    delete this.built[mode];
  }

  /**
   * Colour range used for the layer: the selected paths' range when a
   * selection exists, the layer's full range otherwise.
   */
  private resolveColorRange(config: LayerConfig): Range {
    const selected = this.app.selectedPathIds;
    const data = this.app.currentData;
    if (selected.size === 0 || !data) {
      return config.range;
    }
    // Only the selected paths' segments, sliced out through the path index:
    // a selection click should not walk the whole dataset
    return config.computeRange(
      segmentsForPathIds(data.path_segments, selected),
      config.range,
      data.path_info,
    );
  }

  /**
   * Build the polylines of a layer, or with `only` rebuild those of the
   * given paths and leave the others as they are
   */
  private redrawPaths(config: LayerConfig, only?: Set<number>): void {
    const data = this.app.currentData;
    if (!data) return;

    let byPath = this.polylinesByPath[config.mode];
    if (only) {
      for (const id of only) {
        for (const entry of byPath.get(id) ?? []) {
          config.layer.removeLayer(entry.polyline);
        }
        byPath.delete(id);
      }
    } else {
      config.layer.clearLayers();
      byPath = this.polylinesByPath[config.mode] = new Map<
        number,
        PolylineEntry[]
      >();
    }

    const range = this.resolveColorRange(config);
    const zoom = simplifyZoom(this.app.map);
    const selectedPathIds = this.app.selectedPathIds;
    this.built[config.mode] = { zoom, selected: new Set(selectedPathIds) };
    const { min: colorMin, max: colorMax } = range;
    // Resolve the filter once over the path info instead of re-deriving it per
    // segment: `null` means every path passes, so no lookup is needed at all
    const visiblePathIds = this.visiblePathIds(data);
    const hasSelection = selectedPathIds.size > 0;
    const isolate = this.app.isolateSelection;
    const touch = isTouchDevice();

    // Current merge run. Its key is the middle of its colour step: of the
    // selection's range for a selected path, which is shown on it, and of
    // the full range for the others, which are dimmed until they return to
    // it when the selection is cleared
    let run: PathSegment[] = [];
    let runLatLngs: Coordinate[] = [];
    let runPathId = -1;
    let runKey = NaN;
    let runEnd: Coordinate | null = null;

    const flush = (): void => {
      if (run.length === 0) return;
      const props = calculateSegmentProperties({
        pathId: runPathId,
        selectedPathIds,
        isolateSelection: isolate,
        colorFunction: config.getColor,
        colorMin,
        colorMax,
        value: runKey,
      });
      const polyline = L.polyline(simplify(runLatLngs, zoom), {
        color: props.color,
        weight: props.weight,
        opacity: props.opacity,
        // Round caps and joins and interactivity are Leaflet's defaults
        renderer: this.app.pathRenderer,
        bubblingMouseEvents: false,
      });
      const entry: PolylineEntry = {
        polyline,
        pathId: runPathId,
        value: runKey,
        segments: run,
      };
      this.bindSegmentInteractions(entry, touch);
      polyline.addTo(config.layer);

      const list = byPath.get(runPathId);
      if (list) list.push(entry);
      else byPath.set(runPathId, [entry]);

      run = [];
      runLatLngs = [];
      runEnd = null;
    };

    for (const segment of only
      ? segmentsForPathIds(data.path_segments, only)
      : data.path_segments) {
      const pathId = segment.path_id;
      const coords = segment.coords;

      if (
        !coords ||
        (visiblePathIds !== null && !visiblePathIds.has(pathId)) ||
        (config.filterSegment && !config.filterSegment(segment)) ||
        (hasSelection && isolate && !selectedPathIds.has(pathId))
      ) {
        flush();
        continue;
      }

      const key = stepValue(
        config.getValue(segment),
        selectedPathIds.has(pathId) ? range : config.range,
      );
      const contiguous =
        runEnd !== null &&
        pathId === runPathId &&
        key === runKey &&
        runEnd[0] === coords[0][0] &&
        runEnd[1] === coords[0][1];

      if (!contiguous) {
        flush();
        runPathId = pathId;
        runKey = key;
        runLatLngs = [coords[0]];
      }
      runLatLngs.push(coords[1]);
      runEnd = coords[1];
      run.push(segment);
    }
    flush();

    this.updateLegend(colorMin, colorMax, config);
  }

  /**
   * Restyle the drawn polylines of the visible layers for the current
   * selection (weight/opacity/colour range). Only the paths that were or
   * are now selected are rebuilt, since their runs are cut at the colour
   * steps of the range they are shown on.
   * Isolate mode changes which paths are drawn and therefore needs a redraw
   * (see DataManager.updateLayers).
   */
  updateSelectionStyles(): void {
    const modes: LayerMode[] = ["altitude", "airspeed"];
    for (const mode of modes) {
      const visible =
        mode === "altitude"
          ? this.app.altitudeVisible
          : this.app.airspeedVisible;
      const built = this.built[mode];
      if (!visible || !built) continue;

      const config = this.getConfig(mode);
      const selectedPathIds = this.app.selectedPathIds;
      const recut = new Set([...built.selected, ...selectedPathIds]);
      if (recut.size > 0) this.redrawPaths(config, recut);
      const { min, max } = this.resolveColorRange(config);

      for (const [pathId, entries] of this.polylinesByPath[mode]) {
        for (const entry of entries) {
          const props = calculateSegmentProperties({
            pathId,
            selectedPathIds,
            isolateSelection: this.app.isolateSelection,
            colorFunction: config.getColor,
            colorMin: min,
            colorMax: max,
            value: entry.value,
          });
          // isSelected rides along into the options, where nothing reads it
          entry.polyline.setStyle(props);
        }
      }

      this.updateLegend(min, max, config);
    }
  }

  private bindSegmentInteractions(entry: PolylineEntry, touch: boolean): void {
    const { polyline, segments, pathId } = entry;
    let current: PathSegment = segments[0]!;

    const pick = (latlng: L.LatLng): void => {
      if (segments.length > 1) {
        current =
          findNearestSegment(segments, latlng.lat, latlng.lng) ?? current;
      }
    };
    const tooltipHtml = (): string => this.formatSegmentTooltip(current);

    if (!touch) {
      // Registered before bindTooltip so the nearest segment is known when
      // Leaflet's own mouseover handler opens the (lazy) tooltip
      polyline.on("mouseover", (e: L.LeafletMouseEvent) => pick(e.latlng));
      polyline.bindTooltip(tooltipHtml, {
        sticky: true,
        direction: "top",
        offset: [0, -10],
        opacity: 1,
        className: "segment-tooltip",
      });
      if (segments.length > 1) {
        polyline.on("mousemove", (e: L.LeafletMouseEvent) => {
          const previous = current;
          pick(e.latlng);
          if (current !== previous) {
            polyline.setTooltipContent(tooltipHtml());
          }
        });
      }
    }

    polyline.on("click", (e: L.LeafletMouseEvent) => {
      L.DomEvent.stopPropagation(e);
      if (e.originalEvent) {
        e.originalEvent.stopPropagation();
      }
      if (touch && this.app.map) {
        pick(e.latlng);
        L.popup({ className: "segment-tooltip" })
          .setLatLng(e.latlng)
          .setContent(tooltipHtml())
          .openOn(this.app.map);
      }
      this.app.pathSelection.togglePathSelection(pathId);
      // Selecting rebuilds the polylines of the path, this one included.
      // The one that draws the clicked segment now takes over the hover,
      // tooltip and all, until the pointer moves on.
      if (!touch && !this.app.map?.hasLayer(polyline)) {
        for (const byPath of Object.values(this.polylinesByPath)) {
          byPath
            .get(pathId)
            ?.find((other) => other.segments.includes(current))
            ?.polyline.fire("mouseover", { latlng: e.latlng });
        }
      }
    });
  }

  /** Coloured on the same range as the polylines, the selection's if any */
  private formatSegmentTooltip(segment: PathSegment): string {
    const altitude = this.resolveColorRange(this.getConfig("altitude"));
    const speed = this.resolveColorRange(this.getConfig("airspeed"));
    return generateSegmentPopupHtml({
      segment,
      altMin: altitude.min,
      altMax: altitude.max,
      speedMin: speed.min,
      speedMax: speed.max,
    });
  }

  /**
   * Ids of the paths the year/aircraft filter keeps, or `null` when no filter
   * is active and every segment is drawn regardless of its path info.
   */
  private visiblePathIds(data: KMLDataset): Set<number> | null {
    const year = this.app.selectedYear;
    const aircraft = this.app.selectedAircraft;
    if (year === "all" && aircraft === "all") return null;
    return datasetIndex(data).filter(year, aircraft).pathIds;
  }

  private updateLegend(
    min: number,
    max: number,
    config: Pick<LayerConfig, "legendMinId" | "legendMaxId" | "formatLegend">,
  ): void {
    const minEl = domCache.get(config.legendMinId);
    const maxEl = domCache.get(config.legendMaxId);
    if (minEl) minEl.textContent = config.formatLegend(min);
    if (maxEl) maxEl.textContent = config.formatLegend(max);
  }

  updateAltitudeLegend(minAlt: number, maxAlt: number): void {
    this.updateLegend(minAlt, maxAlt, this.getConfig("altitude"));
  }

  updateAirspeedLegend(minSpeed: number, maxSpeed: number): void {
    this.updateLegend(minSpeed, maxSpeed, this.getConfig("airspeed"));
  }
}
