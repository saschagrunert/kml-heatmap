/**
 * Global type declarations
 */

import type * as KMLHeatmapLib from "./main";
import type { MapApp, MapConfig } from "./mapApp";
import type * as L from "leaflet";

// Explicitly define all KMLHeatmap module exports with proper types
// This ensures TypeScript can resolve all function signatures correctly
export type KMLHeatmapModule = {
  // Utilities
  calculateDistance: typeof KMLHeatmapLib.calculateDistance;
  calculateBearing: typeof KMLHeatmapLib.calculateBearing;
  ddToDms: typeof KMLHeatmapLib.ddToDms;
  formatTime: typeof KMLHeatmapLib.formatTime;
  formatDistance: typeof KMLHeatmapLib.formatDistance;
  formatAltitude: typeof KMLHeatmapLib.formatAltitude;
  formatSpeed: typeof KMLHeatmapLib.formatSpeed;
  getColorForAltitude: typeof KMLHeatmapLib.getColorForAltitude;
  getColorForAirspeed: typeof KMLHeatmapLib.getColorForAirspeed;
  findMin: typeof KMLHeatmapLib.findMin;
  findMax: typeof KMLHeatmapLib.findMax;
  findMinMax: typeof KMLHeatmapLib.findMinMax;

  // State management
  parseUrlParams: typeof KMLHeatmapLib.parseUrlParams;
  encodeStateToUrl: typeof KMLHeatmapLib.encodeStateToUrl;
  getDefaultState: typeof KMLHeatmapLib.getDefaultState;
  mergeState: typeof KMLHeatmapLib.mergeState;

  // Calculations
  filterPaths: typeof KMLHeatmapLib.filterPaths;
  collectAirports: typeof KMLHeatmapLib.collectAirports;
  aggregateAircraft: typeof KMLHeatmapLib.aggregateAircraft;
  calculateTotalDistance: typeof KMLHeatmapLib.calculateTotalDistance;
  calculateAltitudeStats: typeof KMLHeatmapLib.calculateAltitudeStats;
  calculateSpeedStats: typeof KMLHeatmapLib.calculateSpeedStats;
  calculateLongestFlight: typeof KMLHeatmapLib.calculateLongestFlight;
  calculateFlightTime: typeof KMLHeatmapLib.calculateFlightTime;
  calculateFilteredStatistics: typeof KMLHeatmapLib.calculateFilteredStatistics;

  // Services
  DataLoader: typeof KMLHeatmapLib.DataLoader;

  // Airport features
  calculateAirportFlightCounts: typeof KMLHeatmapLib.calculateAirportFlightCounts;
  findHomeBase: typeof KMLHeatmapLib.findHomeBase;
  generateAirportPopup: typeof KMLHeatmapLib.generateAirportPopup;
  calculateAirportOpacity: typeof KMLHeatmapLib.calculateAirportOpacity;
  calculateAirportMarkerSize: typeof KMLHeatmapLib.calculateAirportMarkerSize;
  calculateAirportVisibility: typeof KMLHeatmapLib.calculateAirportVisibility;

  // Layer features
  calculateAltitudeRange: typeof KMLHeatmapLib.calculateAltitudeRange;
  calculateAirspeedRange: typeof KMLHeatmapLib.calculateAirspeedRange;
  shouldRenderSegment: typeof KMLHeatmapLib.shouldRenderSegment;
  calculateSegmentProperties: typeof KMLHeatmapLib.calculateSegmentProperties;
  formatAltitudeLegendLabels: typeof KMLHeatmapLib.formatAltitudeLegendLabels;
  formatAirspeedLegendLabels: typeof KMLHeatmapLib.formatAirspeedLegendLabels;
  filterSegmentsForRendering: typeof KMLHeatmapLib.filterSegmentsForRendering;
  groupSegmentsByPath: typeof KMLHeatmapLib.groupSegmentsByPath;
  calculateLayerStats: typeof KMLHeatmapLib.calculateLayerStats;

  // Replay features
  prepareReplaySegments: typeof KMLHeatmapLib.prepareReplaySegments;
  calculateTimeRange: typeof KMLHeatmapLib.calculateTimeRange;
  findSegmentsAtTime: typeof KMLHeatmapLib.findSegmentsAtTime;
  interpolatePosition: typeof KMLHeatmapLib.interpolatePosition;
  calculateSmoothedBearing: typeof KMLHeatmapLib.calculateSmoothedBearing;
  replayCalculateBearing: typeof KMLHeatmapLib.replayCalculateBearing;
  calculateAutoZoom: typeof KMLHeatmapLib.calculateAutoZoom;
  shouldRecenter: typeof KMLHeatmapLib.shouldRecenter;
  calculateReplayProgress: typeof KMLHeatmapLib.calculateReplayProgress;
  validateReplayData: typeof KMLHeatmapLib.validateReplayData;

  // Wrapped features
  calculateYearStats: typeof KMLHeatmapLib.calculateYearStats;
  generateFunFacts: typeof KMLHeatmapLib.generateFunFacts;
  selectDiverseFacts: typeof KMLHeatmapLib.selectDiverseFacts;
  calculateAircraftColorClass: typeof KMLHeatmapLib.calculateAircraftColorClass;
  wrappedFindHomeBase: typeof KMLHeatmapLib.wrappedFindHomeBase;
  getDestinations: typeof KMLHeatmapLib.getDestinations;
};

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

    // UI toggle functions
    toggleHeatmap?: () => void;
    toggleStats?: () => void;
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
