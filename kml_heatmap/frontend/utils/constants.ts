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
 * it, except for the heat source, which is drawn by one layer per level of
 * detail (see HEATMAP_BANDS). The order here is the drawing order, bottom to
 * top; all of them sit below the first label layer of the base style.
 */
export const MAP_LAYERS = {
  aviation: "aviation",
  heat: "heat",
  heatDetail1: "heat-detail-1",
  heatDetail2: "heat-detail-2",
  heatDetail3: "heat-detail-3",
  replayRoute: "replay-route",
  pathsAltitude: "paths-altitude",
  pathsAirspeed: "paths-airspeed",
  pathsAltitudeSelected: "paths-altitude-selected",
  pathsAirspeedSelected: "paths-airspeed-selected",
  replayTrail: "replay-trail",
} as const;

/**
 * The levels of detail of the heatmap: which share of the fixes is drawn in
 * which zoom range, and by which layer. `minzoom` is inclusive and `maxzoom`
 * exclusive, as MapLibre reads them on a layer. Map units.
 *
 * The intensity of a point halves with every level zoomed out (see
 * heatmapIntensity in the data manager), and MapLibre adds the points up in
 * a half-float texture. Below about 0.004 a single point's share underflows
 * there and the whole heatmap vanishes, which with every fix drawn happens
 * under zoom 9. So further out fewer points are drawn, each `stride` times
 * as heavy: the sum stays what it was, and a point never weighs less than
 * it does at zoom 9.
 *
 * Nobody sees the missing fixes, because the ones left still overlap. A
 * pixel of the map at zoom z is 40075 km / (512 * 2^z) at the equator. The
 * closest view of the stride 8 band is just under zoom 9, 153 m a pixel,
 * where 8 fixes of 235 m are 1880 m or 12 px; at 50 degrees north a pixel is
 * 98 m and they are 19 px. Both are less than the 22 px a point reaches. The
 * other bands repeat that: three levels further out, eight times the stride.
 *
 * `detail` is the property the features of the heat source carry and the
 * layers filter on. The first band is the full detail and its layer the one
 * the heatmap handle lists first.
 */
export const HEATMAP_BANDS = [
  { detail: 0, stride: 1, minzoom: 9, maxzoom: 24, layer: MAP_LAYERS.heat },
  {
    detail: 1,
    stride: 8,
    minzoom: 6,
    maxzoom: 9,
    layer: MAP_LAYERS.heatDetail1,
  },
  {
    detail: 2,
    stride: 64,
    minzoom: 3,
    maxzoom: 6,
    layer: MAP_LAYERS.heatDetail2,
  },
  {
    detail: 3,
    stride: 512,
    minzoom: 0,
    maxzoom: 3,
    layer: MAP_LAYERS.heatDetail3,
  },
] as const;

/** Ids of the heat layers, the full detail first */
export const HEATMAP_LAYER_IDS = HEATMAP_BANDS.map((band) => band.layer);

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
