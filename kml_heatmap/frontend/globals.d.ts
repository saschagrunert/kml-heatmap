/**
 * Global type declarations
 */

import type { MapApp, MapConfig } from "./mapApp";

declare global {
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
