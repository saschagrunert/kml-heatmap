/**
 * Layer Manager - Handles altitude/airspeed path rendering and legend updates
 */
import * as L from "leaflet";
import type { MapApp } from "../mapApp";
import type { Range } from "../state/store";
import type { PathInfo, PathSegment } from "../types";
import { domCache } from "../utils/domCache";
import { generateSegmentPopupHtml } from "../utils/htmlGenerators";

interface LayerConfig {
  layer: L.LayerGroup;
  renderer: L.SVG;
  range: Range;
  getValue: (seg: PathSegment) => number;
  getColor: (value: number, min: number, max: number) => string;
  filterSegment?: (seg: PathSegment) => boolean;
  storeSegments: boolean;
  legendMinId: string;
  legendMaxId: string;
  formatLegend: (value: number) => string;
}

export function isTouchDevice(): boolean {
  return "ontouchstart" in window || navigator.maxTouchPoints > 0;
}

export class LayerManager {
  private app: MapApp;
  private pathInfoMapCache: Map<number, PathInfo> | null = null;
  private pathInfoMapSource: PathInfo[] | null = null;

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

  redrawAltitudePaths(): void {
    this.redrawPaths({
      layer: this.app.altitudeLayer,
      renderer: this.app.altitudeRenderer,
      range: this.app.altitudeRange,
      getValue: (seg) => seg.altitude_ft ?? 0,
      getColor: (value, min, max) =>
        window.KMLHeatmap.getColorForAltitude(value, min, max),
      storeSegments: true,
      legendMinId: "legend-min",
      legendMaxId: "legend-max",
      formatLegend: (value) => {
        const ft = Math.round(value);
        const m = Math.round(value * 0.3048);
        return ft + " ft (" + m + " m)";
      },
    });
  }

  redrawAirspeedPaths(): void {
    this.redrawPaths({
      layer: this.app.airspeedLayer,
      renderer: this.app.airspeedRenderer,
      range: this.app.airspeedRange,
      getValue: (seg) => seg.groundspeed_knots ?? 0,
      getColor: (value, min, max) =>
        window.KMLHeatmap.getColorForAirspeed(value, min, max),
      filterSegment: (seg) => (seg.groundspeed_knots ?? 0) > 0,
      storeSegments: false,
      legendMinId: "airspeed-legend-min",
      legendMaxId: "airspeed-legend-max",
      formatLegend: (value) => {
        const kt = Math.round(value);
        const kmh = Math.round(value * 1.852);
        return kt + " kt (" + kmh + " km/h)";
      },
    });
  }

  private redrawPaths(config: LayerConfig): void {
    if (!this.app.currentData) return;

    config.layer.clearLayers();
    if (config.storeSegments) {
      this.app.pathSegments = {};
    }

    // Calculate color range
    let colorMin: number, colorMax: number;
    if (this.app.selectedPathIds.size > 0) {
      const selectedSegments = this.app.currentData.path_segments.filter(
        (seg) => {
          if (!this.app.selectedPathIds.has(seg.path_id)) return false;
          if (config.filterSegment && !config.filterSegment(seg)) return false;
          return true;
        }
      );
      if (selectedSegments.length > 0) {
        const values = selectedSegments.map(config.getValue);
        let min = values[0] ?? 0;
        let max = values[0] ?? 0;
        for (let i = 1; i < values.length; i++) {
          const v = values[i] ?? 0;
          if (v < min) min = v;
          if (v > max) max = v;
        }
        colorMin = min;
        colorMax = max;
      } else {
        colorMin = config.range.min;
        colorMax = config.range.max;
      }
    } else {
      colorMin = config.range.min;
      colorMax = config.range.max;
    }

    const pathInfoMap = this.getPathInfoMap();

    this.app.currentData.path_segments.forEach((segment) => {
      const pathId = segment.path_id;
      const pathInfo = pathInfoMap.get(pathId);

      if (this.app.selectedYear !== "all") {
        if (
          pathInfo &&
          pathInfo.year &&
          pathInfo.year.toString() !== this.app.selectedYear
        ) {
          return;
        }
      }

      if (this.app.selectedAircraft !== "all") {
        if (
          pathInfo &&
          pathInfo.aircraft_registration !== this.app.selectedAircraft
        ) {
          return;
        }
      }

      if (config.filterSegment && !config.filterSegment(segment)) return;

      const isSelected = this.app.selectedPathIds.has(pathId);

      if (this.app.selectedPathIds.size > 0 && !isSelected) {
        if (this.app.isolateSelection) {
          return;
        }
      }

      const color = config.getColor(
        config.getValue(segment),
        colorMin,
        colorMax
      );
      const inSolo = this.app.isolateSelection && isSelected;
      const polyline = L.polyline(segment.coords ?? [], {
        color: color,
        weight: isSelected && !inSolo ? 6 : 4,
        opacity: inSolo
          ? 0.85
          : isSelected
            ? 1.0
            : this.app.selectedPathIds.size > 0
              ? 0.1
              : 0.85,
        lineCap: "round",
        lineJoin: "round",
        renderer: config.renderer,
        interactive: true,
      });

      const tooltipHtml = this.formatSegmentTooltip(segment);
      if (!isTouchDevice()) {
        polyline.bindTooltip(tooltipHtml, {
          sticky: true,
          direction: "top",
          offset: [0, -10],
          opacity: 1,
          className: "segment-tooltip",
        });
      }

      polyline.addTo(config.layer);

      polyline.on("click", (e: L.LeafletMouseEvent) => {
        L.DomEvent.stopPropagation(e);
        if (e.originalEvent) {
          e.originalEvent.stopPropagation();
        }
        if (isTouchDevice() && this.app.map) {
          L.popup({ className: "segment-tooltip" })
            .setLatLng(e.latlng)
            .setContent(tooltipHtml)
            .openOn(this.app.map);
        }
        this.app.pathSelection.togglePathSelection(pathId);
      });

      if (config.storeSegments) {
        if (!this.app.pathSegments[pathId]) {
          this.app.pathSegments[pathId] = [];
        }
        this.app.pathSegments[pathId].push(segment);
      }
    });

    this.updateLegend(colorMin, colorMax, config);
    this.app.airportManager.updateAirportOpacity();
    this.app.statsManager.updateStatsForSelection();
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

  private getPathInfoMap(): Map<number, PathInfo> {
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
    config: Pick<LayerConfig, "legendMinId" | "legendMaxId" | "formatLegend">
  ): void {
    const minEl = domCache.get(config.legendMinId);
    const maxEl = domCache.get(config.legendMaxId);
    if (minEl) minEl.textContent = config.formatLegend(min);
    if (maxEl) maxEl.textContent = config.formatLegend(max);
  }

  updateAltitudeLegend(minAlt: number, maxAlt: number): void {
    const format = (value: number) => {
      const ft = Math.round(value);
      const m = Math.round(value * 0.3048);
      return ft + " ft (" + m + " m)";
    };
    this.updateLegend(minAlt, maxAlt, {
      legendMinId: "legend-min",
      legendMaxId: "legend-max",
      formatLegend: format,
    });
  }

  updateAirspeedLegend(minSpeed: number, maxSpeed: number): void {
    const format = (value: number) => {
      const kt = Math.round(value);
      const kmh = Math.round(value * 1.852);
      return kt + " kt (" + kmh + " km/h)";
    };
    this.updateLegend(minSpeed, maxSpeed, {
      legendMinId: "airspeed-legend-min",
      legendMaxId: "airspeed-legend-max",
      formatLegend: format,
    });
  }
}
