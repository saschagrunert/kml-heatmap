/**
 * Global type declarations
 */

import type { MapApp, MapConfig } from "./mapApp";
import type * as L from "leaflet";

// Leaflet heatmap plugin types
export interface HeatmapOptions {
  radius?: number;
  blur?: number;
  minOpacity?: number;
  max?: number;
  gradient?: Record<string, string>;
}

export interface HeatmapLayer extends L.Layer {
  _canvas?: HTMLCanvasElement; // Private Leaflet property for canvas access
  /** Replace the points and redraw; the canvas stays where it is */
  setLatLngs(latlngs: [number, number][] | [number, number, number][]): this;
}

declare global {
  // Extend Leaflet namespace
  namespace L {
    function heatLayer(
      latlngs: [number, number][] | [number, number, number][],
      options?: HeatmapOptions,
    ): HeatmapLayer;
  }

  // html-to-image, loaded on the first export; its UMD build publishes the
  // same API the package's module entry point types
  type HtmlToImage = typeof import("html-to-image");

  interface Window {
    initMapApp?: (config: MapConfig) => Promise<MapApp>;
    mapApp?: MapApp;
    htmlToImage?: HtmlToImage;

    // Map configuration
    MAP_CONFIG?: MapConfig;
  }
}

export {};
