export const METERS_TO_FEET = 3.28084;
export const FEET_TO_METERS = 1.0 / METERS_TO_FEET;
export const NAUTICAL_MILES_TO_KM = 1.852;
export const KM_TO_NAUTICAL_MILES = 1.0 / NAUTICAL_MILES_TO_KM;
/** AGL threshold for cruise statistics */
export const CRUISE_ALTITUDE_THRESHOLD_FT = 1000;

/**
 * Widths below this get the phone layout: the mobile bar in place of the
 * control columns, and a phone-sized export (matches styles.css)
 */
export const MOBILE_BREAKPOINT_PX = 768;

/**
 * Zoom comes in two units. MapLibre counts in 512 pixel tiles where Leaflet
 * counted in 256 pixel ones, so the same view is one level lower: state zoom
 * = map zoom + ZOOM_OFFSET. The code and the map speak the map's own unit.
 * Saved state and the `z` of a link stay in the old one, so a link shared
 * before the switch still shows the same area; `stateZoomToMap` and
 * `mapZoomToState` in mapHelpers are the only crossing points.
 */
export const ZOOM_OFFSET = 1;

/** Zoom limits of saved state and the URL `z`, in state (legacy) units */
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 20;

/** Zoom limits of the map itself, in map units: the two above, translated */
export const MAP_MIN_ZOOM = MIN_ZOOM - ZOOM_OFFSET;
export const MAP_MAX_ZOOM = MAX_ZOOM - ZOOM_OFFSET;

/**
 * Zoom of a view that names no zoom of its own: the map's first view, and
 * a link that carries a centre without `z`. Map units.
 */
export const DEFAULT_ZOOM = 9;

/**
 * Zoom auto-zoom follows the aircraft at: close enough to read the ground it
 * flies over. Map units.
 */
export const AUTO_ZOOM_FOLLOW = 15;

/** Auto-zoom does not zoom out beyond this level. Map units. */
export const AUTO_ZOOM_MIN = 8;

/**
 * The airport marker size for a zoom, largest first: the first entry whose
 * `minZoom` the map has reached names the size class, and below the last one
 * there is none. Map units.
 */
export const AIRPORT_SIZE_ZOOMS = [
  { minZoom: 13, sizeClass: "xlarge" },
  { minZoom: 11, sizeClass: "large" },
  { minZoom: 9, sizeClass: "medium" },
  { minZoom: 7, sizeClass: "medium-small" },
  { minZoom: 5, sizeClass: "small" },
] as const;

/** Below this zoom the airport markers drop their labels. Map units. */
export const AIRPORT_HIDE_LABELS_BELOW_ZOOM = 4;

/**
 * Ids of the sources the map is created with. Every one exists, empty, from
 * the moment `mapReady` resolves; modules fill them with `setData` and never
 * add or remove one.
 */
export const MAP_SOURCES = {
  aviation: "aviation",
  heat: "heat",
  replayRoute: "replay-route",
  pathsAltitude: "paths-altitude",
  pathsAirspeed: "paths-airspeed",
  pathsAltitudeSelected: "paths-altitude-selected",
  pathsAirspeedSelected: "paths-airspeed-selected",
  replayTrail: "replay-trail",
} as const;

/**
 * Ids of the layers the map is created with, one per source and named like
 * it. The order here is the drawing order, bottom to top; all of them sit
 * below the first label layer of the base style.
 */
export const MAP_LAYERS = {
  aviation: "aviation",
  heat: "heat",
  replayRoute: "replay-route",
  pathsAltitude: "paths-altitude",
  pathsAirspeed: "paths-airspeed",
  pathsAltitudeSelected: "paths-altitude-selected",
  pathsAirspeedSelected: "paths-airspeed-selected",
  replayTrail: "replay-trail",
} as const;

/**
 * How the heat source merges the fixes when the map is zoomed out. The
 * worker does it (supercluster): up to `maxZoom` a tile holds clusters, each
 * at the centre of its fixes and carrying their number as `point_count`,
 * which the heat layer takes as the weight. Closer in it holds the fixes.
 *
 * The intensity of a point halves with every level zoomed out (see
 * heatmapIntensity in the data manager), and MapLibre adds the points up in
 * a half-float texture. Below about 0.004 a single point's share underflows
 * there and the whole heatmap vanishes, which with every fix drawn happens
 * under zoom 9. So the fixes are drawn as they are from zoom 9 on, and
 * `maxZoom` is the level below.
 *
 * A cluster gathers the fixes within `radius` pixels of its first one, so
 * along a track the clusters are about `radius` apart at a whole zoom and
 * just under twice that before the next level takes over, where the map
 * still draws the tiles of the level below, scaled up. At 6 that is 6 to
 * 12 px, well inside the 22 px a point reaches, and a lone track stays an
 * even line. At 12 it already shows as a string of beads, and at the reach
 * of a point the tracks fall apart into blobs.
 *
 * The share of a cluster cannot underflow. A pixel of the map at zoom z is
 * 40075 km * cos(latitude) / (512 * 2^z), which at 51 degrees north and
 * zoom 12 is 12 m. The fixes of a track are about 235 m apart, so 6 px of it
 * hold 6 * 12 * 2^(12 - z) / 235 = 0.31 * 2^(12 - z) fixes, while a point
 * weighs 0.0375 / 2^(12 - z). The zoom cancels: a cluster of a lone track
 * weighs about 0.0115 at every zoom, and where flights overlap it weighs
 * more. That holds for fixes as close as a flight logger writes them. A
 * fix without a neighbour in reach stays a point of its own, which is why
 * the weight of the heat layer has a floor (see heatmapWeight in the data
 * manager).
 */
export const HEATMAP_CLUSTER = { radius: 6, maxZoom: 8 } as const;

/**
 * Elements hidden while the map is captured as an image (export, wrapped).
 * The two grouped control columns and the statistics rail are listed as
 * containers so their titles and separators disappear with their buttons;
 * the individual ids stay for panels that live outside a column.
 *
 * The loading indicator is not listed: the dialog covers it anyway, and
 * restoring the display saved on opening put back a `block` that a load
 * finishing in the meantime had already cleared, stranding the indicator.
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
  "selection-chip",
] as const;
