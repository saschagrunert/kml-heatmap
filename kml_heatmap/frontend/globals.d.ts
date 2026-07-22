/**
 * Global type declarations
 */

import type * as KMLHeatmapLib from "./main";
import type { MapApp, MapConfig } from "./mapApp";
import type * as L from "leaflet";

export type KMLHeatmapModule = typeof KMLHeatmapLib;

// Leaflet heatmap plugin types
export interface HeatmapOptions {
  radius?: number;
  blur?: number;
  minOpacity?: number;
  maxOpacity?: number;
  max?: number;
  gradient?: Record<string, string>;
}

export interface HeatmapLayer extends L.Layer {
  setLatLngs(latlngs: [number, number][] | [number, number, number][]): this;
  _canvas?: HTMLCanvasElement; // Private Leaflet property for canvas access
}

declare global {
  // Extend Leaflet namespace
  namespace L {
    function heatLayer(
      latlngs: [number, number][] | [number, number, number][],
      options?: HeatmapOptions
    ): HeatmapLayer;
  }

  // dom-to-image library types
  interface DomToImageOptions {
    width?: number;
    height?: number;
    quality?: number;
    bgcolor?: string;
  }

  interface DomToImage {
    toJpeg(node: HTMLElement, options?: DomToImageOptions): Promise<string>;
    toPng(node: HTMLElement, options?: DomToImageOptions): Promise<string>;
    toBlob(node: HTMLElement, options?: DomToImageOptions): Promise<Blob>;
  }

  interface Window {
    KMLHeatmap: KMLHeatmapModule;
    MapAppInstance?: MapApp;
    initMapApp?: (config: MapConfig) => Promise<MapApp>;
    mapApp?: MapApp;
    domtoimage?: DomToImage;

    // Map configuration
    MAP_CONFIG?: MapConfig;
  }
}

export {};
