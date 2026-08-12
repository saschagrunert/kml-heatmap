export { calculateDistance, calculateBearing, ddToDms } from "./utils/geometry";
export {
  formatTime,
  formatDistance,
  formatAltitude,
  formatSpeed,
} from "./utils/formatters";
export { getColorForAltitude, getColorForAirspeed } from "./utils/colors";
export { findMin, findMax, findMinMax } from "./utils/arrayHelpers";

export {
  parseUrlParams,
  encodeStateToUrl,
  getDefaultState,
  mergeState,
} from "./state/urlState";

export {
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

export { DataLoader } from "./services/dataLoader";

export {
  calculateAirportFlightCounts,
  findHomeBase,
  calculateAirportOpacity,
  calculateAirportMarkerSize,
  calculateAirportVisibility,
} from "./features/airports";

export {
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

export {
  prepareReplaySegments,
  calculateTimeRange,
  findSegmentsAtTime,
  interpolatePosition,
  calculateSmoothedBearing,
  calculateAutoZoom,
  shouldRecenter,
  calculateReplayProgress,
  validateReplayData,
} from "./features/replay";

export {
  calculateYearStats,
  generateFunFacts,
  selectDiverseFacts,
  calculateAircraftColorClass,
  findHomeBase as wrappedFindHomeBase,
  getDestinations,
} from "./features/wrapped";
