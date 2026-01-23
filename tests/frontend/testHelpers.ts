/**
 * Test helper types and utilities
 */
import type { Mock } from "vitest";
import type { MapApp } from "../../kml_heatmap/frontend/mapApp";
import type { PathInfo, Airport } from "../../kml_heatmap/frontend/types";

/**
 * Mock Leaflet marker for testing
 */
export interface MockMarker {
  setPopupContent: Mock<[string], void>;
  setOpacity: Mock<[number], void>;
  addTo: Mock<[unknown], void>;
  on?: Mock;
  off?: Mock;
  bindPopup?: Mock;
  openPopup?: Mock;
  closePopup?: Mock;
}

/**
 * Mock Leaflet layer for testing
 */
export interface MockLayer {
  hasLayer: Mock<[unknown], boolean>;
  removeLayer: Mock<[unknown], void>;
  addLayer?: Mock<[unknown], void>;
  clearLayers?: Mock<[], void>;
  eachLayer?: Mock;
}

/**
 * Mock Leaflet map for testing
 */
export interface MockMap {
  addLayer?: Mock<[unknown], void>;
  removeLayer?: Mock<[unknown], void>;
  setView?: Mock;
  fitBounds?: Mock;
  getZoom?: Mock<[], number>;
  getCenter?: Mock;
  invalidateSize?: Mock<[], void>;
}

/**
 * Mock manager with common methods
 */
export interface MockManager {
  updateStatsPanel?: Mock;
  updateAirportOpacity?: Mock;
  updateAirportPopups?: Mock;
  saveMapState?: Mock;
  updateLayers?: Mock<[], Promise<void>>;
  loadData?: Mock;
  clearLayers?: Mock;
  redrawAltitudePaths?: Mock;
  redrawAirspeedPaths?: Mock;
  updateReplayButtonState?: Mock;
  replayActive?: boolean;
}

/**
 * Partial MapApp for testing
 */
export type MockMapApp = Partial<MapApp> & {
  selectedYear: string;
  selectedAircraft: string;
  selectedPathIds: Set<number>;
  fullPathInfo: PathInfo[];
  allAirportsData?: Airport[];
  airportMarkers?: Record<string, MockMarker>;
  airportLayer?: MockLayer;
  pathToAirports?: Record<number, { start: string; end: string }>;
  airportToPaths?: Record<string, Set<number>>;
  fullPathSegments?: unknown[];
  currentResolution?: string | null;
  pathSegments?: Record<string, unknown>;
  isInitializing?: boolean;
  dataManager?: MockManager;
  statsManager?: MockManager;
  airportManager?: MockManager;
  stateManager?: MockManager;
  replayManager?: MockManager;
  layerManager?: MockManager;
  altitudeLayer?: MockLayer;
  altitudeVisible?: boolean;
  airspeedVisible?: boolean;
  map?: MockMap;
};
