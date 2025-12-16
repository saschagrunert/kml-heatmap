/**
 * Application-wide constants
 */

// Map configuration
export const MAP_CONFIG = {
  DEFAULT_ZOOM: 10,
  ZOOM_SNAP: 0.25,
  ZOOM_DELTA: 0.25,
  WHEEL_PX_PER_ZOOM_LEVEL: 120,
  BOUNDS_PADDING: [30, 30] as [number, number],
} as const;

// Heatmap configuration
export const HEATMAP_CONFIG = {
  RADIUS: 10,
  BLUR: 15,
  MIN_OPACITY: 0.25,
  MAX_OPACITY: 0.6,
} as const;

// Path styling
export const PATH_CONFIG = {
  WEIGHT: 2,
  OPACITY: 0.7,
  SELECTED_WEIGHT: 3,
  SELECTED_OPACITY: 0.8,
} as const;

// Replay configuration
export const REPLAY_CONFIG = {
  DEFAULT_ALTITUDE_MIN: 0,
  DEFAULT_ALTITUDE_MAX: 10000,
  DEFAULT_SPEED_MIN: 0,
  DEFAULT_SPEED_MAX: 200,
  DEFAULT_LOOK_AHEAD: 5,
  AIRPLANE_MARKER_SIZE: 20,
  AIRPLANE_MARKER_BORDER: 2,
} as const;

// Unit conversion constants
export const UNIT_CONVERSIONS = {
  METERS_TO_FEET: 3.28084,
  KM_TO_NAUTICAL_MILES: 0.539957,
  EARTH_CIRCUMFERENCE_KM: 40075,
} as const;

// Storage
export const STORAGE_KEY = "kml-heatmap-state";

// Z-index values
export const Z_INDEX = {
  MODAL: 10000,
} as const;
