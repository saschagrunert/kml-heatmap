/**
 * Map layer management service
 */

import L from "leaflet";
import "leaflet.heat";
import type { Layers, PathSegment } from "../types";
import { getColorForAltitude, getColorForAirspeed } from "../utils/formatting";
import { HEATMAP_CONFIG, PATH_CONFIG } from "../constants";

export class LayerManager {
  private map: any; // L.Map - using any to avoid Leaflet type resolution issues
  private layers: Layers;

  constructor(map: any) {
    this.map = map;
    this.layers = {
      heatmap: null,
      altitude: L.layerGroup(),
      airspeed: L.layerGroup(),
      airport: L.layerGroup(),
      replay: null,
    };
  }

  /**
   * Update heatmap layer with filtered coordinates
   */
  updateHeatmap(coordinates: [number, number][], visible: boolean): void {
    // Remove existing heatmap
    if (this.layers.heatmap) {
      this.map.removeLayer(this.layers.heatmap);
    }

    // Create new heatmap
    this.layers.heatmap = L.heatLayer(coordinates, {
      radius: HEATMAP_CONFIG.RADIUS,
      blur: HEATMAP_CONFIG.BLUR,
      minOpacity: HEATMAP_CONFIG.MIN_OPACITY,
      maxOpacity: HEATMAP_CONFIG.MAX_OPACITY,
      max: 1.0,
      gradient: {
        0.0: "#00008B",
        0.2: "#0000CD",
        0.4: "#4169E1",
        0.6: "#FF8C00",
        0.8: "#FF4500",
        1.0: "#FF0000",
      },
    });

    if (visible) {
      this.layers.heatmap.addTo(this.map);
    }
  }

  /**
   * Update altitude layer with path segments
   */
  updateAltitudePaths(
    segments: PathSegment[],
    minAlt: number,
    maxAlt: number,
    onSegmentClick?: (pathId: string) => void,
  ): void {
    this.updatePathLayer(
      this.layers.altitude,
      segments,
      (segment) => {
        if (!segment.altitude) return null;
        const avgAlt = (segment.altitude[0] + segment.altitude[1]) / 2;
        return getColorForAltitude(avgAlt, minAlt, maxAlt);
      },
      onSegmentClick,
    );
  }

  /**
   * Update airspeed layer with path segments
   */
  updateAirspeedPaths(
    segments: PathSegment[],
    minSpeed: number,
    maxSpeed: number,
    onSegmentClick?: (pathId: string) => void,
  ): void {
    this.updatePathLayer(
      this.layers.airspeed,
      segments,
      (segment) => {
        if (!segment.groundspeed) return null;
        const avgSpeed = (segment.groundspeed[0] + segment.groundspeed[1]) / 2;
        return getColorForAirspeed(avgSpeed, minSpeed, maxSpeed);
      },
      onSegmentClick,
    );
  }

  /**
   * Generic method to update path layers with custom color function
   */
  private updatePathLayer(
    layer: any,
    segments: PathSegment[],
    getColor: (segment: PathSegment) => string | null,
    onSegmentClick?: (pathId: string) => void,
  ): void {
    layer.clearLayers();

    const renderer = L.svg();

    segments.forEach((segment) => {
      if (!segment.coords || segment.coords.length < 2) {
        return;
      }

      const color = getColor(segment);
      if (!color) return;

      const polyline = L.polyline(
        [
          [segment.coords[0].lat, segment.coords[0].lon],
          [segment.coords[1].lat, segment.coords[1].lon],
        ],
        {
          color,
          weight: PATH_CONFIG.WEIGHT,
          opacity: PATH_CONFIG.OPACITY,
          renderer,
        },
      );

      if (onSegmentClick) {
        polyline.on("click", () => onSegmentClick(segment.path_id));
      }

      polyline.addTo(layer);
    });
  }

  /**
   * Toggle layer visibility
   */
  toggleLayer(layerName: keyof Layers, visible: boolean): void {
    const layer = this.layers[layerName];
    if (!layer) return;

    if (visible) {
      if (!this.map.hasLayer(layer)) {
        layer.addTo(this.map);
      }
    } else {
      if (this.map.hasLayer(layer)) {
        this.map.removeLayer(layer);
      }
    }
  }

  /**
   * Get layer reference
   */
  getLayer(layerName: keyof Layers): Layers[typeof layerName] {
    return this.layers[layerName];
  }

  /**
   * Clear all layers
   */
  clearAll(): void {
    Object.values(this.layers).forEach((layer) => {
      if (layer) {
        if ("clearLayers" in layer) {
          (layer as L.LayerGroup).clearLayers();
        }
        if (this.map.hasLayer(layer)) {
          this.map.removeLayer(layer);
        }
      }
    });
  }
}
