/**
 * Layer Manager - Handles altitude/airspeed path rendering and legend updates
 *
 * Rendering strategy:
 * - Paths are drawn on the shared canvas renderer (`app.pathRenderer`).
 * - Consecutive, contiguous segments of the same path whose value rounds to
 *   the same whole foot/knot are merged into ONE polyline. The merged
 *   polyline keeps its segment list so the tooltip can show the data of the
 *   segment nearest to the cursor (`findNearestSegment`).
 * - Polylines are tracked per path id; selection changes only restyle them
 *   (`updateSelectionStyles`) instead of rebuilding the layer.
 * - Tooltip HTML is generated lazily when the tooltip opens.
 */
import * as L from "leaflet";
import type { MapApp } from "../mapApp";
import type { Range } from "../state/store";
import type { PathInfo, PathSegment } from "../types";
import type { Coordinate } from "../utils/geometry";
import { getColorForAirspeed, getColorForAltitude } from "../utils/colors";
import { domCache } from "../utils/domCache";
import { generateSegmentPopupHtml } from "../utils/htmlGenerators";
import { filterPaths } from "../calculations/statistics";
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
  computeRange: (
    segments: PathSegment[],
    selectedPathIds: Set<number>,
    fallback: Range,
    paths: PathInfo[],
  ) => Range;
  filterSegment?: (seg: PathSegment) => boolean;
  legendMinId: string;
  legendMaxId: string;
  formatLegend: (value: number) => string;
}

interface PolylineEntry {
  polyline: L.Polyline;
  pathId: number;
  /** Representative value (first segment of the run) used for colouring */
  value: number;
  /** Segments merged into this polyline, in drawing order */
  segments: PathSegment[];
}

export function isTouchDevice(): boolean {
  return "ontouchstart" in window || navigator.maxTouchPoints > 0;
}

export class LayerManager {
  private app: MapApp;
  private pathInfoMapCache: Map<number, PathInfo> | null = null;
  private pathInfoMapSource: PathInfo[] | null = null;
  private polylinesByPath: Record<LayerMode, Map<number, PolylineEntry[]>> = {
    altitude: new Map(),
    airspeed: new Map(),
  };

  constructor(app: MapApp) {
    this.app = app;

    // Pre-cache legend elements
    domCache.cacheElements([
      "legend-min",
      "legend-max",
      "airspeed-legend-min",
      "airspeed-legend-max",
    ]);
  }

  private getConfig(mode: LayerMode): LayerConfig {
    if (mode === "altitude") {
      return {
        mode,
        layer: this.app.altitudeLayer,
        range: this.app.altitudeRange,
        getValue: (seg) => seg.altitude_ft ?? 0,
        getColor: getColorForAltitude,
        computeRange: (segments, selected, fallback, paths) =>
          calculateAltitudeRange(segments, selected, fallback, paths),
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
      computeRange: (segments, selected, fallback) =>
        calculateAirspeedRange(segments, selected, fallback),
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
  }

  /**
   * Number of polylines currently drawn for a layer (merged runs)
   */
  getPolylineCount(mode: LayerMode): number {
    let count = 0;
    for (const entries of this.polylinesByPath[mode].values()) {
      count += entries.length;
    }
    return count;
  }

  /**
   * Colour range used for the layer: the selected paths' range when a
   * selection exists, the layer's full range otherwise.
   */
  private resolveColorRange(config: LayerConfig): Range {
    const selected = this.app.selectedPathIds;
    if (selected.size === 0 || !this.app.currentData) {
      return config.range;
    }
    return config.computeRange(
      this.app.currentData.path_segments,
      selected,
      config.range,
      this.app.currentData.path_info,
    );
  }

  private redrawPaths(config: LayerConfig): void {
    const data = this.app.currentData;
    if (!data) return;

    config.layer.clearLayers();
    const byPath = new Map<number, PolylineEntry[]>();
    this.polylinesByPath[config.mode] = byPath;

    const { min: colorMin, max: colorMax } = this.resolveColorRange(config);
    // Resolve the filter once over the path info instead of re-deriving it per
    // segment: `null` means every path passes, so no lookup is needed at all
    const visiblePathIds = this.visiblePathIds(data.path_info);
    const selectedPathIds = this.app.selectedPathIds;
    const hasSelection = selectedPathIds.size > 0;
    const isolate = this.app.isolateSelection;

    // Current merge run
    let run: PathSegment[] = [];
    let runLatLngs: Coordinate[] = [];
    let runPathId = -1;
    let runKey = NaN;
    let runEnd: Coordinate | null = null;

    const flush = (): void => {
      if (run.length === 0) return;
      const first = run[0]!;
      const value = config.getValue(first);
      const props = calculateSegmentProperties({
        pathId: runPathId,
        selectedPathIds,
        isolateSelection: isolate,
        colorFunction: config.getColor,
        colorMin,
        colorMax,
        value,
      });
      const polyline = L.polyline(runLatLngs, {
        color: props.color,
        weight: props.weight,
        opacity: props.opacity,
        lineCap: "round",
        lineJoin: "round",
        renderer: this.app.pathRenderer,
        interactive: true,
        bubblingMouseEvents: false,
      });
      const entry: PolylineEntry = {
        polyline,
        pathId: runPathId,
        value,
        segments: run,
      };
      this.bindSegmentInteractions(entry);
      polyline.addTo(config.layer);

      const list = byPath.get(runPathId);
      if (list) list.push(entry);
      else byPath.set(runPathId, [entry]);

      run = [];
      runLatLngs = [];
      runEnd = null;
    };

    for (const segment of data.path_segments) {
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

      const key = Math.round(config.getValue(segment));
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
   * selection (weight/opacity/colour range) without rebuilding them.
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
      if (!visible) continue;

      const config = this.getConfig(mode);
      const { min, max } = this.resolveColorRange(config);
      const selectedPathIds = this.app.selectedPathIds;

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
          entry.polyline.setStyle({
            color: props.color,
            weight: props.weight,
            opacity: props.opacity,
          });
        }
      }

      this.updateLegend(min, max, config);
    }
  }

  private bindSegmentInteractions(entry: PolylineEntry): void {
    const { polyline, segments, pathId } = entry;
    let current: PathSegment = segments[0]!;
    const touch = isTouchDevice();

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
    });
  }

  private formatSegmentTooltip(segment: PathSegment): string {
    return generateSegmentPopupHtml({
      segment,
      altMin: this.app.altitudeRange.min,
      altMax: this.app.altitudeRange.max,
      speedMin: this.app.airspeedRange.min,
      speedMax: this.app.airspeedRange.max,
    });
  }

  /**
   * Ids of the paths the year/aircraft filter keeps, or `null` when no filter
   * is active and every segment is drawn regardless of its path info.
   */
  private visiblePathIds(pathInfo: PathInfo[]): Set<number> | null {
    const year = this.app.selectedYear;
    const aircraft = this.app.selectedAircraft;
    if (year === "all" && aircraft === "all") return null;
    return new Set(filterPaths(pathInfo, year, aircraft).map((p) => p.id));
  }

  /**
   * Path info indexed by id (cached per currentData.path_info instance)
   */
  getPathInfoMap(): Map<number, PathInfo> {
    const source = this.app.currentData?.path_info;
    if (!source) return new Map();
    if (source !== this.pathInfoMapSource) {
      this.pathInfoMapCache = new Map(source.map((p) => [p.id, p]));
      this.pathInfoMapSource = source;
    }
    return this.pathInfoMapCache!;
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
    this.updateLegend(minAlt, maxAlt, {
      legendMinId: "legend-min",
      legendMaxId: "legend-max",
      formatLegend: formatAltitudeLabel,
    });
  }

  updateAirspeedLegend(minSpeed: number, maxSpeed: number): void {
    this.updateLegend(minSpeed, maxSpeed, {
      legendMinId: "airspeed-legend-min",
      legendMaxId: "airspeed-legend-max",
      formatLegend: formatAirspeedLabel,
    });
  }
}
