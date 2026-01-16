/**
 * Global type declarations
 */

import type * as KMLHeatmapLib from "./main";
import type { MapApp } from "./mapApp";

declare global {
  interface Window {
    KMLHeatmap: typeof KMLHeatmapLib;
    MapAppInstance?: MapApp;
    initMapApp?: (config: any) => MapApp;
    mapApp?: MapApp;

    // Map configuration
    MAP_CONFIG?: any;

    // UI toggle functions
    toggleHeatmap?: () => void;
    toggleAltitude?: () => void;
    toggleAirspeed?: () => void;
    toggleAirports?: () => void;
    toggleAviation?: () => void;
    toggleReplay?: () => void;
    toggleButtonsVisibility?: () => void;

    // Filter functions
    filterByYear?: (year: string) => void;
    filterByAircraft?: (aircraft: string) => void;

    // Path selection
    togglePathSelection?: (id: string) => void;

    // Export and wrapped
    exportMap?: () => void;
    showWrapped?: () => void;
    closeWrapped?: (e?: MouseEvent) => void;

    // Replay controls
    playReplay?: () => void;
    pauseReplay?: () => void;
    stopReplay?: () => void;
    seekReplay?: (value: string) => void;
    changeReplaySpeed?: (multiplier: number) => void;
    toggleAutoZoom?: () => void;
  }
}

export {};
