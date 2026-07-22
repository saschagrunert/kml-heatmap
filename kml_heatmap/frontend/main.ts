/**
 * Main entry point for KML Heatmap application
 * This module imports and initializes all features
 */

// Import utilities
import { calculateDistance, calculateBearing, ddToDms } from "./utils/geometry";
import {
  formatTime,
  formatDistance,
  formatAltitude,
  formatSpeed,
} from "./utils/formatters";
import { getColorForAltitude, getColorForAirspeed } from "./utils/colors";
import { findMin, findMax, findMinMax } from "./utils/arrayHelpers";

// Import state management
import {
  parseUrlParams,
  encodeStateToUrl,
  getDefaultState,
  mergeState,
} from "./state/urlState";

// Import calculations
import {
  filterPaths,
  collectAirports,
  aggregateAircraft,
  calculateTotalDistance,
  calculateAltitudeStats,
  calculateSpeedStats,
  calculateLongestFlight,
  calculateFlightTime,
  calculateFilteredStatistics,
} from "./calculations/statistics";

// Import services
import { DataLoader } from "./services/dataLoader";

// Import features
import {
  calculateAirportFlightCounts,
  findHomeBase,
  calculateAirportOpacity,
  calculateAirportMarkerSize,
  calculateAirportVisibility,
} from "./features/airports";

import {
  calculateAltitudeRange,
  calculateAirspeedRange,
  shouldRenderSegment,
  calculateSegmentProperties,
  formatAltitudeLegendLabels,
  formatAirspeedLegendLabels,
  filterSegmentsForRendering,
  groupSegmentsByPath,
  calculateLayerStats,
} from "./features/layers";

import {
  prepareReplaySegments,
  calculateTimeRange,
  findSegmentsAtTime,
  interpolatePosition,
  calculateSmoothedBearing,
  calculateBearing as replayCalculateBearing,
  calculateAutoZoom,
  shouldRecenter,
  calculateReplayProgress,
  validateReplayData,
} from "./features/replay";

import {
  calculateYearStats,
  generateFunFacts,
  selectDiverseFacts,
  calculateAircraftColorClass,
  findHomeBase as wrappedFindHomeBase,
  getDestinations,
} from "./features/wrapped";

const api = {
  calculateDistance,
  calculateBearing,
  ddToDms,
  formatTime,
  formatDistance,
  formatAltitude,
  formatSpeed,
  getColorForAltitude,
  getColorForAirspeed,
  findMin,
  findMax,
  findMinMax,
  parseUrlParams,
  encodeStateToUrl,
  getDefaultState,
  mergeState,
  filterPaths,
  collectAirports,
  aggregateAircraft,
  calculateTotalDistance,
  calculateAltitudeStats,
  calculateSpeedStats,
  calculateLongestFlight,
  calculateFlightTime,
  calculateFilteredStatistics,
  DataLoader,
  calculateAirportFlightCounts,
  findHomeBase,
  calculateAirportOpacity,
  calculateAirportMarkerSize,
  calculateAirportVisibility,
  calculateAltitudeRange,
  calculateAirspeedRange,
  shouldRenderSegment,
  calculateSegmentProperties,
  formatAltitudeLegendLabels,
  formatAirspeedLegendLabels,
  filterSegmentsForRendering,
  groupSegmentsByPath,
  calculateLayerStats,
  prepareReplaySegments,
  calculateTimeRange,
  findSegmentsAtTime,
  interpolatePosition,
  calculateSmoothedBearing,
  replayCalculateBearing,
  calculateAutoZoom,
  shouldRecenter,
  calculateReplayProgress,
  validateReplayData,
  calculateYearStats,
  generateFunFacts,
  selectDiverseFacts,
  calculateAircraftColorClass,
  wrappedFindHomeBase,
  getDestinations,
};

export {
  calculateDistance,
  calculateBearing,
  ddToDms,
  formatTime,
  formatDistance,
  formatAltitude,
  formatSpeed,
  getColorForAltitude,
  getColorForAirspeed,
  findMin,
  findMax,
  findMinMax,
  parseUrlParams,
  encodeStateToUrl,
  getDefaultState,
  mergeState,
  filterPaths,
  collectAirports,
  aggregateAircraft,
  calculateTotalDistance,
  calculateAltitudeStats,
  calculateSpeedStats,
  calculateLongestFlight,
  calculateFlightTime,
  calculateFilteredStatistics,
  DataLoader,
  calculateAirportFlightCounts,
  findHomeBase,
  calculateAirportOpacity,
  calculateAirportMarkerSize,
  calculateAirportVisibility,
  calculateAltitudeRange,
  calculateAirspeedRange,
  shouldRenderSegment,
  calculateSegmentProperties,
  formatAltitudeLegendLabels,
  formatAirspeedLegendLabels,
  filterSegmentsForRendering,
  groupSegmentsByPath,
  calculateLayerStats,
  prepareReplaySegments,
  calculateTimeRange,
  findSegmentsAtTime,
  interpolatePosition,
  calculateSmoothedBearing,
  replayCalculateBearing,
  calculateAutoZoom,
  shouldRecenter,
  calculateReplayProgress,
  validateReplayData,
  calculateYearStats,
  generateFunFacts,
  selectDiverseFacts,
  calculateAircraftColorClass,
  wrappedFindHomeBase,
  getDestinations,
};

if (typeof window !== "undefined") {
  window.KMLHeatmap = api;
}
