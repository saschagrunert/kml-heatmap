export const METERS_TO_FEET = 3.28084;
export const FEET_TO_METERS = 1.0 / METERS_TO_FEET;
export const NAUTICAL_MILES_TO_KM = 1.852;
export const KM_TO_NAUTICAL_MILES = 1.0 / NAUTICAL_MILES_TO_KM;
export const CRUISE_ALTITUDE_THRESHOLD_M = 304.8; // 1000ft in meters

/** Zoom limits of the map (tile layers and URL state share these) */
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 20;

export const HIDEABLE_CONTROL_IDS = [
  "stats-btn",
  "export-btn",
  "share-btn",
  "wrapped-btn",
  "heatmap-btn",
  "airports-btn",
  "altitude-btn",
  "airspeed-btn",
  "aviation-btn",
  "year-filter",
  "aircraft-filter",
  "stats-panel",
  "altitude-legend",
  "airspeed-legend",
  "loading",
] as const;

/** Accessible labels for the control-visibility toggle button */
export const SHOW_BUTTONS_LABEL = "Show control buttons";
export const HIDE_BUTTONS_LABEL = "Hide control buttons";
