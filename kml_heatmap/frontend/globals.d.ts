/**
 * Global type declarations
 */

import type { MapApp, MapConfig } from "./mapApp";

declare global {
  interface Window {
    initMapApp?: (config: MapConfig) => Promise<MapApp>;
    mapApp?: MapApp;

    // Map configuration
    MAP_CONFIG?: MapConfig;
  }
}

export {};
