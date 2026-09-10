export const METERS_TO_FEET = 3.28084;
export const FEET_TO_METERS = 1.0 / METERS_TO_FEET;
export const NAUTICAL_MILES_TO_KM = 1.852;
export const KM_TO_NAUTICAL_MILES = 1.0 / NAUTICAL_MILES_TO_KM;
/** AGL threshold for cruise statistics; matches constants.py */
export const CRUISE_ALTITUDE_THRESHOLD_FT = 1000;

/** Zoom limits of the map (tile layers and URL state share these) */
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 20;

/**
 * Elements hidden while the map is captured as an image (export, wrapped).
 * The two grouped control columns and the statistics rail are listed as
 * containers so their titles and separators disappear with their buttons;
 * the individual ids stay for panels that live outside a column.
 */
export const HIDEABLE_CONTROL_IDS = [
  "left-buttons",
  "right-buttons",
  "stats-rail",
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
