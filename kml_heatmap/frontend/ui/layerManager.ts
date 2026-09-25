/**
 * Layer Manager - Handles altitude/airspeed path rendering and legend updates
 *
 * Rendering strategy:
 * - Each mode draws from two GeoJSON sources that exist from the start (see
 *   mapLayers.ts): the main one with every flight, and a small one for the
 *   selection, whose layer lies on top. This module only ever calls
 *   `setData` on them and sets paint properties and a filter.
 * - Consecutive, contiguous segments of the same path whose value falls in
 *   the same one of COLOR_BINS steps of the colour range are merged into ONE
 *   LineString feature, in the colour of the middle of its step. Merging by
 *   the rounded value instead made tens of thousands of lines out of a
 *   groundspeed that never sits still, for colours no eye tells apart. The
 *   colour is computed here and carried as a property, so the map and the
 *   legend cannot disagree.
 * - A run table per source remembers which segments of the dataset each
 *   feature stands for, which lets the tooltip show the exact data of the
 *   segment nearest to the cursor (`findNearestSegment`). MapLibre simplifies the geometry per tile; the
 *   heatmap, the replay and the statistics read the full data anyway.
 * - A selection rebuilds only the selection's source, whose runs follow the
 *   selection's colour range. The main source stays as it is: its layer is
 *   dimmed with one paint property and filtered to leave the selected
 *   flights (in isolate mode: everything) out.
 * - In the 3D view (calculations/lift.ts) each run is written as a ribbon
 *   at its height instead of its line, at every zoom, to a source of
 *   ribbons of its own. The ribbon climbs and descends with the flight, in
 *   pieces of one height each, and every piece is a feature of the same
 *   run, so the run table, the selection and the tooltip serve all of them
 *   as they do the line. Its width is part of its geometry, so the ribbons
 *   are written again as the map zooms to another whole level. A mode that
 *   is hidden (the replay hides them without clearing them) is left as it
 *   is until it is drawn again.
 * - Paths are pixels of a layer and have no events of their own. One
 *   `mousemove` handler per map asks what is rendered under the pointer, at
 *   most once per frame, and moves one reused tooltip along.
 */
import {
  Point as PointClass,
  Popup,
  type ExpressionSpecification,
  type GeoJSONSource,
  type LngLat,
  type Map as MapLibreMap,
  type MapMouseEvent,
  type Point,
} from "maplibre-gl";
import type { MapApp } from "../mapApp";
import type { Range } from "../state/store";
import type {
  KMLDataset,
  LayerHandle,
  PathHit,
  PathHitResult,
  PathHitTester,
  PathInfo,
  PathRunProperties,
  PathSegment,
} from "../types";
import { getColorForAirspeed, getColorForAltitude } from "../utils/colors";
import { MAP_LAYERS, MAP_SOURCES } from "../utils/constants";
import { domCache } from "../utils/domCache";
import { frameCoalescer } from "../utils/frameCoalescer";
import { generateSegmentPopupHtml } from "../utils/htmlGenerators";
import { logError } from "../utils/logger";
import {
  closeWhenBehindGlobe,
  isInMarker,
  isOnMarker,
  isReplayCameraMove,
  toLngLat,
  unwrapLng,
  whenContextRestored,
  type LatLon,
  type LngLatTuple,
} from "../utils/mapHelpers";
import { datasetIndex } from "../calculations/datasetIndex";
import {
  segmentRangesFor,
  segmentsForPathIds,
} from "../calculations/statistics";
import { loadFeatures } from "../services/featureLoader";
import {
  followsLevel,
  groundProfilesFt,
  isLiftedAt,
  liftExaggeration,
  liftOffsetPx,
  reliefLevel,
  ribbonHeightFt,
  ribbonOf,
  ribbonProperties,
  ribbonWidthZoom,
  smoothFlights,
  type SmoothedFlights,
} from "../calculations/lift";
import { appendCurve, flatCurves } from "../calculations/curves";
import {
  calculateAirspeedRange,
  calculateAltitudeRange,
  calculateSegmentProperties,
  findNearestOnCurve,
  findNearestSegment,
  formatAirspeedLabel,
  formatAltitudeLabel,
} from "../features/layers";

/** The look the hover tooltip and the tapped popup share (styles.css) */
const SEGMENT_DETAILS_CLASS = "segment-details";

export type LayerMode = "altitude" | "airspeed";

/** The two sources of a mode, and the layers drawn from them */
type RunSet = "main" | "selected";

/**
 * What sets the two modes apart, the same for every app. The handle of a
 * mode's layers and its colour range are the app's (see handleOf and
 * rangeOf).
 */
interface LayerConfig {
  mode: LayerMode;
  /** Source and layer share their id, see MAP_SOURCES and MAP_LAYERS */
  sources: Record<RunSet, string>;
  layers: Record<RunSet, string>;
  /**
   * The sources the 3D view writes the runs to as ribbons, and their
   * layers, which share their id
   */
  ribbons: Record<RunSet, string>;
  getValue: (seg: PathSegment) => number;
  getColor: (value: number, min: number, max: number) => string;
  /** Range of the given segments, `fallback` when they have no value */
  computeRange: (
    segments: PathSegment[],
    fallback: Range,
    paths: PathInfo[],
  ) => Range;
  filterSegment?: (seg: PathSegment) => boolean;
  legendMinId: string;
  legendMaxId: string;
  formatLegend: (value: number) => string;
}

/** Colour steps a range is cut into; the merge key of a run */
const COLOR_BINS = 32;

/**
 * How far from the pointer a flight still counts as under it, in pixels to
 * each side. A finger covers more of the map than it aims at.
 */
const HIT_PADDING_PX = 5;
const TOUCH_HIT_PADDING_PX = 12;

/** Distance of the tooltip from the pointer, in pixels */
const TOOLTIP_OFFSET_PX = 10;

const MODES: readonly LayerMode[] = ["altitude", "airspeed"];

/** The two modes, made once rather than on every call that needs one */
const CONFIGS: Readonly<Record<LayerMode, LayerConfig>> = {
  altitude: {
    mode: "altitude",
    sources: {
      main: MAP_SOURCES.pathsAltitude,
      selected: MAP_SOURCES.pathsAltitudeSelected,
    },
    layers: {
      main: MAP_LAYERS.pathsAltitude,
      selected: MAP_LAYERS.pathsAltitudeSelected,
    },
    ribbons: {
      main: MAP_SOURCES.pathsAltitudeRibbons,
      selected: MAP_SOURCES.pathsAltitudeSelectedRibbons,
    },
    getValue: (seg) => seg.altitude_ft ?? 0,
    getColor: getColorForAltitude,
    computeRange: calculateAltitudeRange,
    legendMinId: "legend-min",
    legendMaxId: "legend-max",
    formatLegend: formatAltitudeLabel,
  },
  airspeed: {
    mode: "airspeed",
    sources: {
      main: MAP_SOURCES.pathsAirspeed,
      selected: MAP_SOURCES.pathsAirspeedSelected,
    },
    layers: {
      main: MAP_LAYERS.pathsAirspeed,
      selected: MAP_LAYERS.pathsAirspeedSelected,
    },
    ribbons: {
      main: MAP_SOURCES.pathsAirspeedRibbons,
      selected: MAP_SOURCES.pathsAirspeedSelectedRibbons,
    },
    getValue: (seg) => seg.groundspeed_knots ?? 0,
    getColor: getColorForAirspeed,
    computeRange: (segments, fallback) =>
      calculateAirspeedRange(segments, fallback),
    filterSegment: (seg) => (seg.groundspeed_knots ?? 0) > 0,
    legendMinId: "airspeed-legend-min",
    legendMaxId: "airspeed-legend-max",
    formatLegend: formatAirspeedLabel,
  },
};

/** The layers of the ribbons of both modes */
const RIBBON_LAYERS: ReadonlySet<string> = new Set(
  MODES.flatMap((mode) => Object.values(CONFIGS[mode].ribbons)),
);

/** One feature of a source: a run of segments of one path in one colour */
interface Run {
  /** Half-open index range of the run within the drawn segment array */
  start: number;
  end: number;
  pathId: number;
  /** The value the run is coloured with: the middle of its colour step */
  value: number;
  color: string;
}

/** The runs of one source; the index of a run is the `r` of its feature */
interface RunTable {
  runs: Run[];
  /**
   * Bumped on every change of the runs, written or not; features of an
   * older one are stale
   */
  g: number;
  /**
   * The source that holds the runs' features, null while none does, which
   * is how they are created: the lines' source, or in the 3D view the
   * ribbons' source
   */
  written: string | null;
  /**
   * How far the last `setData` has got: with the worker, with the tiles in
   * view being cut from it, or null once the map shows it. Until then the
   * tiles answer for the data before it.
   */
  landing: "worker" | "tiles" | null;
  /**
   * The zoom level the runs were last written for in the 3D view (see
   * ribbonWidthZoom), null outside it
   */
  widthZoom: number | null;
}

/** The selection a mode's layers were last styled for */
interface ShownSelection {
  selected: Set<number>;
  isolate: boolean;
}

interface ModeState {
  tables: Record<RunSet, RunTable>;
  /** The array the runs index into, null while the mode is not drawn */
  segments: PathSegment[] | null;
  shown: ShownSelection;
  /** The filter on the main layer, serialised, to set it only on a change */
  filterKey: string;
  /**
   * The colour range of the selection, and what it was worked out for (see
   * resolveColorRange)
   */
  selectionRange: {
    data: KMLDataset;
    full: Range;
    selected: Set<number>;
    range: Range;
  } | null;
  /**
   * Its sources hold runs of before a change of the view that passed it by
   * while it was hidden; it is drawn again as a whole
   */
  dirty: boolean;
}

function emptyModeState(): ModeState {
  const table = (): RunTable => ({
    runs: [],
    g: 0,
    written: null,
    landing: null,
    widthZoom: null,
  });
  return {
    tables: { main: table(), selected: table() },
    segments: null,
    shown: { selected: new Set(), isolate: false },
    filterKey: "null",
    selectionRange: null,
    dirty: false,
  };
}

/**
 * Whether the pointer cannot hover, so tooltips need a tap instead. Touch
 * support alone does not say: a laptop with a touchscreen is driven by its
 * mouse most of the time, and lost the hover tooltips for having one.
 */
export function isTouchDevice(): boolean {
  if (typeof window.matchMedia === "function") {
    return window.matchMedia("(hover: none)").matches;
  }
  return "ontouchstart" in window || navigator.maxTouchPoints > 0;
}

/**
 * The value in the middle of the one of COLOR_BINS equal steps of `range`
 * that `value` falls in: the merge key of a run, and the value it is
 * coloured with
 */
function stepValue(value: number, range: Range): number {
  // The same normalisation as the colour ramps in utils/colors.ts
  const span = Math.max(range.max - range.min, 1);
  const step = Math.floor(((value - range.min) / span) * COLOR_BINS);
  return (
    range.min +
    ((Math.min(Math.max(step, 0), COLOR_BINS - 1) + 0.5) / COLOR_BINS) * span
  );
}

/**
 * Width and opacity of the runs of a selected or an unselected path. The
 * numbers are those of `calculateSegmentProperties`, asked for a path that
 * stands in for every path of its kind, since a layer has one look.
 */
function runLook(
  isSelected: boolean,
  shown: ShownSelection,
): { weight: number; opacity: number } {
  const hasSelection = shown.selected.size > 0;
  const { weight, opacity } = calculateSegmentProperties({
    pathId: 0,
    selectedPathIds: new Set(isSelected ? [0] : hasSelection ? [1] : []),
    isolateSelection: shown.isolate,
  });
  return { weight, opacity };
}

/** A position of the data in the copy of the world nearest to `pointerLng` */
function nearPointer(latLon: LatLon, pointerLng: number): LngLatTuple {
  const [lng, lat] = toLngLat(latLon);
  return [unwrapLng(lng, pointerLng), lat];
}

/**
 * Distance in pixels between a point of the map and a drawn segment, or a
 * piece of its curve.
 *
 * `project` answers for the longitude it is given and does not wrap it, so
 * a segment lands in the copy of the world its data names, however far from
 * the pointer that is. Each end is projected into the copy nearest to
 * `pointerLng`, the pointer's longitude as the map reports it, unwrapped:
 * that is the one drawn under the pointer, which near the antimeridian need
 * not be the copy the pointer itself is in.
 */
function pixelDistance(
  map: MapLibreMap,
  point: Point,
  pointerLng: number,
  coords: readonly [LatLon, LatLon] | undefined,
): number {
  if (!coords) return Infinity;
  const a = map.project(nearPointer(coords[0], pointerLng));
  const b = map.project(nearPointer(coords[1], pointerLng));
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  let t = 0;
  if (lengthSquared > 0) {
    t = ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared;
    t = Math.max(0, Math.min(1, t));
  }
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

export class LayerManager implements PathHitTester {
  private app: MapApp;
  private state: Record<LayerMode, ModeState> = {
    altitude: emptyModeState(),
    airspeed: emptyModeState(),
  };

  /** Modes that were drawn or cleared before the sources existed */
  private pendingModes = new Set<LayerMode>();
  private destroyed = false;

  /** The map the pointer handlers are registered on */
  private listeningTo: MapLibreMap | null = null;
  /** The last move of the pointer over the map; null once it is off it */
  private lastMove: MapMouseEvent | null = null;
  private readonly hoverFrame = frameCoalescer<void>(() => this.hover());
  private rehoverPending = false;
  /** The one tooltip, created on the first hover and reused from then on */
  private tooltip: Popup | null = null;
  /** The segment the tooltip describes, null while it is closed */
  private hovered: PathSegment | null = null;
  /** The popup a tap opened; a tap elsewhere replaces it */
  private touchPopup: Popup | null = null;
  /** Every flight of a dataset smoothed at its height, for the 3D view */
  private smoothed: {
    segments: PathSegment[];
    flights: SmoothedFlights;
  } | null = null;
  /** The relief's code has been loaded and follows terrainActive */
  private terrainLoaded = false;
  /** A cut of the flights waits for the relief's code (see syncTerrain) */
  private cutAwaited = false;
  /**
   * 0 while the relief's code hides the ribbons, until the map has drawn
   * them on their new ground (ui/terrain.ts), 1 otherwise
   */
  ribbonsShown = 1;
  /**
   * How often the relief level has changed, the visit of a level a cut of
   * the ribbons belongs to, which their id tells apart (see ribbonId)
   */
  ribbonEpoch = 0;

  private readonly handleMouseMove = (e: MapMouseEvent): void => {
    // The overview of the Wrapped dialog is this map, but there to be
    // looked at: no frame is asked for that would find nothing to do
    if (this.app.store.get("wrappedVisible")) {
      this.lastMove = null;
      return;
    }
    this.lastMove = e;
    // A pointer moves many times per frame, and a query walks the tiles.
    // What the pointer is on is asked in the frame as well, once.
    this.hoverFrame.schedule();
  };

  private readonly handleMouseOut = (): void => {
    this.lastMove = null;
    this.hideTooltip();
  };

  /**
   * A ribbon is as wide as the zoom level it was written for (see lift.ts).
   * A flat line is the same at every zoom: from LIFT_MAX_ZOOM on, where the
   * 3D view draws the lines, only the zoom that lifts them again counts.
   */
  private readonly handleZoomEnd = (event: object): void => {
    const map = this.listeningTo;
    // The replay's camera rests of its own (see isReplayCameraMove)
    if (!map || !this.app.threeDVisible || isReplayCameraMove(event)) return;
    // Onto or off the relief the flights are cut anew on their other
    // ground, once its code has arrived (see syncTerrain); onto another
    // level of it, as wide as the new level asks, below
    const changed = this.syncTerrain();
    if (changed === null) return;
    if (changed || this.cutAwaited) this.redrawVisibleModes();
    const zoom = map.getZoom();
    const level = ribbonWidthZoom(zoom);
    for (const mode of MODES) {
      const state = this.state[mode];
      const config = CONFIGS[mode];
      if (!this.drawsNow(mode)) continue;
      for (const set of ["main", "selected"] as const) {
        const table = state.tables[set];
        if (table.widthZoom === null || table.widthZoom === level) continue;
        if (table.written === config.ribbons[set] || isLiftedAt(zoom)) {
          this.setRuns(config, set, table.runs, true);
        } else {
          table.widthZoom = level;
        }
      }
    }
  };

  constructor(app: MapApp) {
    this.app = app;
    // Lifted or flat, the flights are cut and written anew. The smoothed
    // flights only the 3D view needs are let go with it.
    app.store.subscribe("threeDVisible", (threeD) => {
      if (!threeD) this.smoothed = null;
      if (this.syncTerrain() !== null) this.redrawVisibleModes();
    });
    app.store.subscribe("globeVisible", () => {
      if (this.syncTerrain()) this.redrawVisibleModes();
    });
    if (app.map) {
      this.listen(app.map);
    } else {
      this.whenMapReady(() => {
        if (app.map) this.listen(app.map);
      });
    }
  }

  /**
   * Run `onReady` once the map has its sources, unless the manager is gone
   * by then. A map that never gets ready is no business of this class:
   * `initialize()` reports it and takes the app down, this manager with it.
   * What `onReady` throws is logged: it runs in a promise nobody waits for,
   * where it would surface as an unhandled rejection without a word of
   * where it came from.
   */
  private whenMapReady(onReady: () => void): void {
    void this.app.mapReady.then(
      () => {
        if (this.destroyed) return;
        try {
          onReady();
        } catch (error) {
          logError("Path layers: the map got ready, but not for them", error);
        }
      },
      () => {},
    );
  }

  private listen(map: MapLibreMap): void {
    this.listeningTo = map;
    map.on("mousemove", this.handleMouseMove);
    map.on("mouseout", this.handleMouseOut);
    map.on("zoomend", this.handleZoomEnd);
    whenContextRestored(map, () => this.restoreModes());
    // A link or a saved view can open in 3D and close in: the store had
    // its 3D view before this manager subscribed, and a map built at a
    // zoom fires no zoomend
    if (this.syncTerrain()) this.redrawVisibleModes();
  }

  /** Stop following the pointer; the drawn layers stay on the map */
  destroy(): void {
    this.destroyed = true;
    this.listeningTo?.off("mousemove", this.handleMouseMove);
    this.listeningTo?.off("mouseout", this.handleMouseOut);
    this.listeningTo?.off("zoomend", this.handleZoomEnd);
    this.listeningTo = null;
    this.hoverFrame.cancel();
    this.lastMove = null;
    this.hideTooltip();
    this.touchPopup?.remove();
    this.touchPopup = null;
  }

  /** The handle of a mode's layers */
  private handleOf(mode: LayerMode): LayerHandle {
    return mode === "altitude"
      ? this.app.altitudeLayer
      : this.app.airspeedLayer;
  }

  /** The colour range of a mode over every flight */
  private rangeOf(mode: LayerMode): Range {
    return mode === "altitude"
      ? this.app.altitudeRange
      : this.app.airspeedRange;
  }

  /**
   * The map once the path sources exist on it. They are created when the
   * style has loaded, and a source that is not there cannot take data.
   */
  private readyMap(): MapLibreMap | null {
    const map = this.app.map;
    return map?.getSource(MAP_SOURCES.pathsAltitude) ? map : null;
  }

  /**
   * Remember a mode that could not reach its sources, and bring it up to
   * date once the map is ready: drawn again from the data of that moment,
   * or cleared, whichever it was last.
   */
  private deferUntilReady(mode: LayerMode): void {
    // A mode already waiting means the wait is under way
    const waiting = this.pendingModes.size > 0;
    this.pendingModes.add(mode);
    if (waiting) return;
    this.whenMapReady(() => {
      const pending = [...this.pendingModes];
      this.pendingModes.clear();
      // Without the sources even now there is nothing to wait for
      if (!this.readyMap()) return;
      for (const pendingMode of pending) {
        if (this.state[pendingMode].segments) {
          this.redrawPaths(pendingMode);
        } else {
          this.clearLayer(pendingMode);
        }
      }
    });
  }

  /**
   * The flight drawn at a point of the map, or null beside every flight.
   * Until a `setData` has landed the tiles still hold the data before it,
   * which may have flights where the new data has none, or none where the
   * new data has one: finding nothing then is "stale", neither a flight nor
   * the empty map, and a caller should leave things as they are. Part of
   * the contract with MapApp's click dispatcher, and what the hover runs on.
   */
  hitTest(point: Point): PathHitResult {
    return this.look(point).result;
  }

  /** `hitTest`, and whether the tiles had any feature at the point at all */
  private look(point: Point): { result: PathHitResult; found: boolean } {
    const map = this.readyMap();
    if (!map) return { result: null, found: false };

    const tableOfLayer = new Map<string, [ModeState, RunSet]>();
    // Told by the app's own `setData` calls and not by whether the source
    // is loaded alone: that is false during every pan and zoom as well,
    // and a camera move must not make a click on the empty map one to
    // ignore
    let landing = false;
    // Only the 3D view writes ribbons to look for, and not while they are
    // hidden as they settle on another ground (ui/terrain.ts): a query
    // finds a feature whatever its opacity. Nothing found then is no word
    // of the empty map either.
    const ribbons = this.app.threeDVisible && this.ribbonsShown > 0;
    const settling = this.app.threeDVisible && !ribbons;
    for (const mode of MODES) {
      const config = CONFIGS[mode];
      const state = this.state[mode];
      if (!this.handleOf(mode).isVisible() || !state.segments) continue;
      tableOfLayer.set(config.layers.main, [state, "main"]);
      tableOfLayer.set(config.layers.selected, [state, "selected"]);
      if (ribbons) {
        tableOfLayer.set(config.ribbons.main, [state, "main"]);
        tableOfLayer.set(config.ribbons.selected, [state, "selected"]);
      }
      for (const set of ["main", "selected"] as const) {
        const table = state.tables[set];
        // Asked here rather than followed through the map's events: the
        // answer is only needed when someone looks
        if (
          table.landing === "tiles" &&
          map.isSourceLoaded(table.written ?? config.sources[set])
        ) {
          table.landing = null;
        }
        landing ||= table.landing !== null;
      }
    }
    if (tableOfLayer.size === 0) return { result: null, found: false };
    const nothing: PathHitResult = landing || settling ? "stale" : null;

    const pad = isTouchDevice() ? TOUCH_HIT_PADDING_PX : HIT_PADDING_PX;
    const features = map.queryRenderedFeatures(
      [
        [point.x - pad, point.y - pad],
        [point.x + pad, point.y + pad],
      ],
      { layers: [...tableOfLayer.keys()] },
    );
    if (features.length === 0) return { result: nothing, found: false };

    // World copies are drawn, and a point in one of them is 360 degrees
    // away from the segments, which would all be equally far. Both the
    // search in degrees and the ranking in pixels take the pointer as the
    // map reports it, unwrapped, and put each segment into the copy of the
    // world nearest to it (see findNearestSegment and pixelDistance).
    const pointer = map.unproject(point);
    const seen = new Set<Run>();
    let stale = false;
    let best: PathHit | null = null;
    let bestDistance = Infinity;
    let bestSelected = false;

    for (const feature of features) {
      const entry = tableOfLayer.get(feature.layer.id);
      if (!entry) continue;
      const [state, set] = entry;
      const table = state.tables[set];
      const { r, g } = feature.properties as Partial<PathRunProperties>;
      // Tiles cut from the data before the last `setData` still answer for
      // a while, with indices into a table that is gone
      if (g !== table.g) {
        stale = true;
        continue;
      }
      if (r === undefined) continue;
      const run = table.runs[r];
      // A run crossing a tile border comes back once per tile
      if (!run || seen.has(run)) continue;
      seen.add(run);
      // Left out by the isolate filter, but still in tiles cut before it.
      // A selected path is not skipped: its main runs are the same flight,
      // and they bridge the moment until the selection's tiles are there.
      const { selected, isolate } = state.shown;
      if (
        set === "main" &&
        isolate &&
        selected.size > 0 &&
        !selected.has(run.pathId)
      ) {
        continue;
      }

      // A ribbon is drawn above the ground it stands on: the pointer is
      // taken down by as much before the segment and the distance to it
      // are looked for (see liftOffsetPx, which scales by the centre).
      // Over the relief that ground is raised too, but `project` and
      // `unproject` meet the relief themselves, of the level of the map's
      // zoom, as the ribbon's own height is taken. The exaggeration is the
      // one the map is drawn for, which every ribbon has (see ribbonHeights)
      const properties = feature.properties as Partial<PathRunProperties>;
      const ribbon =
        properties.h !== undefined && RIBBON_LAYERS.has(feature.layer.id);
      const lift = ribbon
        ? liftOffsetPx(
            map,
            map.getCenter().lat,
            ribbonHeightFt(properties, map.getZoom()),
            liftExaggeration(this.app.reliefLevel),
          )
        : 0;
      const ground = lift ? map.unproject([point.x, point.y + lift]) : pointer;
      // A line is drawn along its flight's curve, and its points belong to
      // the segment they lie on (see calculations/curves.ts)
      const onCurve = ribbon
        ? null
        : findNearestOnCurve(
            flatCurves(state.segments!),
            run.start,
            run.end,
            ground.lat,
            ground.lng,
          );
      const segment = onCurve
        ? state.segments![onCurve.index]
        : findNearestSegment(
            state.segments!.slice(run.start, run.end),
            ground.lat,
            ground.lng,
          );
      if (!segment) continue;
      const distance = pixelDistance(
        map,
        new PointClass(point.x, point.y + lift),
        pointer.lng,
        onCurve?.piece ?? segment.coords,
      );
      const isSelected = set === "selected";
      if (
        distance < bestDistance ||
        (distance === bestDistance && isSelected && !bestSelected)
      ) {
        best = { pathId: run.pathId, segment };
        bestDistance = distance;
        bestSelected = isSelected;
      }
    }
    return { result: best ?? (stale ? "stale" : nothing), found: true };
  }

  /**
   * What a click on a flight does: toggle its selection and, on touch, show
   * the segment's values. Part of the contract with MapApp's click dispatcher.
   */
  onPathClick(hit: PathHit, lngLat: LngLat): void {
    const map = this.app.map;
    if (map && isTouchDevice()) {
      // No pointer to follow: the values stay where the finger was until
      // the next tap on the map closes them
      this.touchPopup?.remove();
      const popup = (this.touchPopup = new Popup({
        // Not the tooltip's class: that one takes no pointer events, and
        // this popup has a close button to press
        className: `${SEGMENT_DETAILS_CLASS} segment-popup`,
        // MapLibre would close it on every click on the map, also on one
        // the click dispatcher decides to ignore (a "stale" hit), and the
        // values would go while nothing else happens. The dispatcher closes
        // it when the click is one on the empty map.
        closeOnClick: false,
        maxWidth: "none",
        focusAfterOpen: false,
      }));
      // Before it opens: that is the moment it starts to follow the map
      closeWhenBehindGlobe(map, popup);
      popup
        .setLngLat(lngLat)
        .setHTML(this.formatSegmentTooltip(hit.segment))
        .addTo(map);
    }
    // Selecting rebuilds the runs of the path, the hovered one included;
    // `updateSelectionStyles` hands the tooltip over to its replacement
    this.app.pathSelection.togglePathSelection(hit.pathId);
  }

  /**
   * Put away the values a hover or a tap left on the map. MapLibre keeps
   * no list of open popups to close them by, and the popup of a tap does
   * not close on a click by itself: MapApp's click dispatcher calls this
   * for a click on the empty map, and Replay and Wrapped as they open.
   */
  closeSegmentPopup(): void {
    this.hideTooltip();
    this.touchPopup?.remove();
    this.touchPopup = null;
  }

  /** Look under the pointer and show, move on or close the tooltip */
  private hover(mapHasMoved = false): void {
    const map = this.app.map;
    const move = this.lastMove;
    // A marker lies on top of the flights. The map reports `mouseout` as
    // the pointer comes onto one, and goes on reporting its moves there:
    // over a marker there is no flight to show, but the point is kept. A
    // zoom may take the marker from under a pointer that rests, or bring
    // one there, so after the map has moved the document is asked what is
    // under the pointer now rather than the event what it was aimed at.
    const onMarker =
      !!move &&
      (mapHasMoved
        ? isInMarker(
            document.elementFromPoint?.(
              move.originalEvent.clientX,
              move.originalEvent.clientY,
            ),
          )
        : isOnMarker(move));
    const point = onMarker ? undefined : move?.point;
    // Not over the overview of the Wrapped dialog either (a pointer that
    // rested on the map as the dialog opened gets here through the look on
    // idle): MapApp ignores clicks on it as well
    const { result: hit, found } =
      map &&
      point &&
      !this.destroyed &&
      !isTouchDevice() &&
      !this.app.store.get("wrappedVisible")
        ? this.look(point)
        : { result: null, found: false };
    // A look on idle decides, with tiles that can tell. Asked for from
    // here: the one a redraw asks for is skipped while the pointer is off
    // the map. Until then the tooltip stays only where the tiles of before
    // have a flight, which may well still be there; over nothing at all
    // there is nothing to go on showing.
    if (hit === "stale") {
      this.rehoverOnIdle();
      if (found) return;
    }
    if (!map || !point || !hit || hit === "stale") {
      this.hideTooltip();
      return;
    }

    const tooltip = (this.tooltip ??= new Popup({
      closeButton: false,
      closeOnClick: false,
      focusAfterOpen: false,
      className: `${SEGMENT_DETAILS_CLASS} segment-tooltip`,
      maxWidth: "none",
      offset: TOOLTIP_OFFSET_PX,
    }));
    if (hit.segment !== this.hovered) {
      this.hovered = hit.segment;
      tooltip.setHTML(this.formatSegmentTooltip(hit.segment));
    }
    if (!tooltip.isOpen()) {
      // A popup that tracks the pointer has no place until the pointer
      // moves again, and sits in the corner of the map until then. Opened
      // at a position first, it starts out where the pointer is.
      tooltip.setLngLat(map.unproject(point)).addTo(map).trackPointer();
    }
    map.getCanvas().style.cursor = "pointer";
  }

  private hideTooltip(): void {
    this.hovered = null;
    if (!this.tooltip?.isOpen()) return;
    this.tooltip.remove();
    const canvas = this.app.map?.getCanvas();
    if (canvas) canvas.style.cursor = "";
  }

  /**
   * Look under the resting pointer again once the map has drawn what was
   * just changed. Until then the tiles answer with the features of before,
   * and the tooltip would close although the flight is still there.
   */
  private rehoverOnIdle(): void {
    const map = this.app.map;
    if (!map || !this.lastMove || this.rehoverPending) return;
    this.rehoverPending = true;
    map.once("idle", () => {
      this.rehoverPending = false;
      if (this.destroyed) return;
      // The colour range may have changed under the same segment
      this.hovered = null;
      this.hover(true);
    });
  }

  /**
   * Show the colour layers the store asks for: a mode shows while its flag
   * is on and no replay runs (see ui/layerVisibility.ts). One that shows
   * again is drawn anew, since it may have missed changes while it was
   * hidden (see drawsNow); one switched off lets go of its runs, which for
   * a large year hold tens of MB. A mode the replay hides keeps them.
   *
   * @param rebuild - The data or the filter changed: draw every mode that
   *   shows, whether it did before or not
   */
  syncModes(rebuild = false): void {
    for (const mode of MODES) {
      const handle = this.handleOf(mode);
      const wanted = this.app[`${mode}Visible`];
      const shown = wanted && !this.app.replayActive;
      const showing = handle.isVisible();
      handle.setVisible(shown);
      if (!wanted) {
        if (rebuild || this.state[mode].segments) this.clearLayer(mode);
      } else if (shown && (rebuild || !showing)) {
        this.redrawPaths(mode);
      } else if (rebuild) {
        // Hidden by the replay: drawn as it shows again
        this.state[mode].dirty = true;
      }
    }
  }

  /**
   * Empty both sources of a mode (used for hidden layers so they do not
   * keep stale geometry around)
   */
  clearLayer(mode: LayerMode): void {
    const config = CONFIGS[mode];
    const state = this.state[mode];
    state.segments = null;
    state.dirty = false;
    this.setRuns(config, "main", []);
    this.setRuns(config, "selected", []);
    // Nothing drawn is left to smooth
    if (MODES.every((other) => !this.state[other].segments)) {
      this.smoothed = null;
    }
    this.rehoverOnIdle();
  }

  /**
   * Colour range used for the layer: the selected paths' range when a
   * selection exists, the layer's full range otherwise. The selection's is
   * kept until the selection, the dataset or the full range changes: the
   * tooltip asks for both modes' on every segment it shows, and working
   * them out took milliseconds with a hundred flights selected.
   */
  private resolveColorRange(config: LayerConfig): Range {
    const selected = this.app.selectedPathIds;
    const data = this.app.currentData;
    const full = this.rangeOf(config.mode);
    if (selected.size === 0 || !data) return full;
    const state = this.state[config.mode];
    const held = state.selectionRange;
    if (
      held?.data === data &&
      held.full === full &&
      held.selected.size === selected.size &&
      [...selected].every((id) => held.selected.has(id))
    ) {
      return held.range;
    }
    // Only the selected paths' segments, sliced out through the path index:
    // a selection click should not walk the whole dataset
    const range = config.computeRange(
      segmentsForPathIds(data.path_segments, selected),
      full,
      data.path_info,
    );
    state.selectionRange = { data, full, selected: new Set(selected), range };
    return range;
  }

  /**
   * Cut the segments into runs: of every path on the full range, or with
   * `only` of the given paths on `range`. The year/aircraft filter and the
   * mode's own filter apply to both.
   */
  private cutRuns(
    config: LayerConfig,
    data: KMLDataset,
    range: Range,
    only?: Set<number>,
  ): Run[] {
    const segments = data.path_segments;
    // Resolve the filter once over the path info instead of re-deriving it per
    // segment: `null` means every path passes, so no lookup is needed at all
    const visiblePathIds = this.visiblePathIds(data);
    const runs: Run[] = [];

    // The stretches of the array to walk: all of it, or the slices of the
    // wanted paths where the array is indexed by path
    let stretches: [number, number][] = [[0, segments.length]];
    const index = only ? segmentRangesFor(segments) : null;
    if (only && index) {
      stretches = [];
      for (const id of only) {
        const stretch = index.get(id);
        if (stretch) stretches.push([stretch[0], stretch[1]]);
      }
      stretches.sort((a, b) => a[0] - b[0]);
    }

    // Current merge run. Its key is the middle of its colour step.
    let runStart = -1;
    let runPathId = -1;
    let runKey = NaN;
    let runEnd: readonly number[] | null = null;

    const flush = (end: number): void => {
      if (runStart < 0) return;
      runs.push({
        start: runStart,
        end,
        pathId: runPathId,
        value: runKey,
        color: config.getColor(runKey, range.min, range.max),
      });
      runStart = -1;
      runEnd = null;
    };

    for (const [from, to] of stretches) {
      for (let i = from; i < to; i++) {
        const segment = segments[i]!;
        const pathId = segment.path_id;
        const coords = segment.coords;

        if (
          !coords ||
          (only && !only.has(pathId)) ||
          (visiblePathIds !== null && !visiblePathIds.has(pathId)) ||
          (config.filterSegment && !config.filterSegment(segment))
        ) {
          flush(i);
          continue;
        }

        const key = stepValue(config.getValue(segment), range);
        const contiguous =
          runEnd !== null &&
          pathId === runPathId &&
          key === runKey &&
          runEnd[0] === coords[0][0] &&
          runEnd[1] === coords[0][1];

        if (!contiguous) {
          flush(i);
          runStart = i;
          runPathId = pathId;
          runKey = key;
        }
        runEnd = coords[1];
      }
      flush(to);
    }
    return runs;
  }

  /**
   * Replace the runs of one source, and its data where the map has it.
   * `recut` writes the same runs again, cut for another zoom: the features
   * the tiles still hold stand for the same runs, so they stay valid, and
   * the flights under the pointer are not "stale" meanwhile.
   */
  private setRuns(
    config: LayerConfig,
    set: RunSet,
    runs: Run[],
    recut = false,
  ): void {
    const state = this.state[config.mode];
    const table = state.tables[set];
    table.runs = runs;
    // Before the map is asked: without a WebGL context it has no sources,
    // and it comes back with the data of before, whose features must not
    // index into these runs (see restoreModes). A source that never had
    // any has no features to tell apart.
    const g =
      recut || (runs.length === 0 && table.written === null)
        ? table.g
        : ++table.g;

    const map = this.readyMap();
    if (!map) {
      this.deferUntilReady(config.mode);
      return;
    }
    // Most redraws happen without a selection; an empty source that stays
    // empty is not worth cutting its tiles again
    if (runs.length === 0 && table.written === null) return;

    // Zoomed in close the 3D view draws the lines (see LIFT_MAX_ZOOM)
    const threeD = this.app.threeDVisible;
    const lifted = threeD && isLiftedAt(map.getZoom());
    const id = lifted ? config.ribbons[set] : config.sources[set];
    // Lifted or flat, the runs are in one source, and leave the other
    if (table.written !== null && table.written !== id) {
      void map
        .getSource<GeoJSONSource>(table.written)
        ?.setData({ type: "FeatureCollection", features: [] });
    }

    const moved = table.written !== null && table.written !== id;
    const segments = state.segments ?? [];
    // Every flight smoothed at its height, in the 3D view (see lift.ts),
    // and the ribbons as wide as the zoom asks
    const smoothed = lifted ? this.smoothedFlights(segments) : null;
    const widthZoom = ribbonWidthZoom(map.getZoom());
    table.widthZoom = threeD ? widthZoom : null;
    const level = this.app.reliefLevel;
    const features: GeoJSON.Feature<
      GeoJSON.LineString | GeoJSON.MultiPolygon,
      PathRunProperties
    >[] = [];
    // Flat, along the curve through the fixes (see calculations/curves.ts)
    const curves = smoothed ? null : flatCurves(segments);
    runs.forEach((run, r) => {
      const properties = { r, g, pathId: run.pathId, color: run.color };
      if (!smoothed) {
        const coordinates: LngLatTuple[] = [
          toLngLat(segments[run.start]!.coords![0]),
        ];
        for (let i = run.start; i < run.end; i++) {
          appendCurve(coordinates, curves!, i);
        }
        features.push({
          type: "Feature",
          properties,
          geometry: { type: "LineString", coordinates },
        });
        return;
      }
      // In the 3D view the run is a ribbon at its height, at every zoom, cut
      // from its flight's smoothed curve so it meets the runs on either side
      // without a seam
      for (const piece of ribbonOf(smoothed, run.start, run.end, widthZoom)) {
        features.push({
          type: "Feature",
          properties: {
            ...properties,
            ...ribbonProperties(piece, level, this.ribbonEpoch),
          },
          geometry: piece.geometry,
        });
      }
    });
    table.written = runs.length === 0 ? null : id;
    const source = map.getSource<GeoJSONSource>(id);
    if (!source) return;
    // A recut into the source that has the runs changes nothing a click
    // or the pointer could find; into the other one, it has none of them
    // until its tiles are cut
    if (recut && !moved) {
      void source.setData({ type: "FeatureCollection", features });
      return;
    }
    table.landing = "worker";
    // The promise never rejects: a failure arrives as the map's error
    // event. It settles once the worker has the data of the last call,
    // also for a call that was queued behind another; the tiles in view
    // are cut from it after that, unless no layer in use draws the source.
    void source.setData({ type: "FeatureCollection", features }).then(() => {
      // A later call has taken over, and answers for itself
      if (table.g !== g) return;
      table.landing = map.isSourceLoaded(id) ? null : "tiles";
    });
  }

  /** Draw every flight of a mode, and the selection on top of them */
  private redrawPaths(mode: LayerMode): void {
    const data = this.app.currentData;
    if (!data) return;

    const config = CONFIGS[mode];
    const state = this.state[mode];
    state.segments = data.path_segments;
    state.dirty = false;
    // The flights of another dataset are smoothed anew when they are lifted
    if (this.smoothed?.segments !== data.path_segments) this.smoothed = null;
    this.setRuns(
      config,
      "main",
      this.cutRuns(config, data, this.rangeOf(mode)),
    );
    this.showSelection(config, data);
    this.rehoverOnIdle();
  }

  /**
   * Draw the selected paths on the selection's layer, cut at the colour
   * steps of the selection's range, which is shown on them; and give both
   * layers the look the selection asks for. The others stay cut on the
   * full range, dimmed until the selection is cleared.
   */
  private showSelection(config: LayerConfig, data: KMLDataset): void {
    const selected = this.app.selectedPathIds;
    const range = this.resolveColorRange(config);
    this.setRuns(
      config,
      "selected",
      selected.size > 0 ? this.cutRuns(config, data, range, selected) : [],
    );
    this.applyLook(config);
    this.updateLegend(range.min, range.max, config);
  }

  /**
   * Style the two layers of a mode for the current selection. The handle
   * owns their visibility, so what the main layer must not show (the
   * selected flights, drawn on top, or in isolate mode everything) is left
   * out by a filter.
   */
  private applyLook(config: LayerConfig): void {
    const state = this.state[config.mode];
    const shown: ShownSelection = {
      selected: new Set(this.app.selectedPathIds),
      isolate: this.app.isolateSelection,
    };
    state.shown = shown;
    const map = this.readyMap();
    if (!map) return;

    const selectedLook = runLook(true, shown);
    const mainOpacity = runLook(false, shown).opacity;
    map.setPaintProperty(config.layers.main, "line-opacity", mainOpacity);
    map.setPaintProperty(
      config.layers.selected,
      "line-width",
      selectedLook.weight,
    );
    map.setPaintProperty(
      config.layers.selected,
      "line-opacity",
      selectedLook.opacity,
    );
    // The ribbons of the 3D view, dimmed for a selection like the lines,
    // and out of sight while they settle on another ground
    map.setPaintProperty(
      config.ribbons.main,
      "fill-extrusion-opacity",
      mainOpacity * this.ribbonsShown,
    );
    map.setPaintProperty(
      config.ribbons.selected,
      "fill-extrusion-opacity",
      selectedLook.opacity * this.ribbonsShown,
    );

    let filter: ExpressionSpecification | null = null;
    if (shown.selected.size > 0) {
      filter = shown.isolate
        ? ["literal", false]
        : ["!", ["in", ["get", "pathId"], ["literal", [...shown.selected]]]];
    }
    // A filter cuts the tiles of the layer again, even one equal to the last
    const filterKey = JSON.stringify(filter);
    if (filterKey !== state.filterKey) {
      state.filterKey = filterKey;
      map.setFilter(config.layers.main, filter);
      map.setFilter(config.ribbons.main, filter);
    }
  }

  /**
   * Whether a mode is drawn and shown. A drawn mode that is hidden (the
   * replay hides the colour layers and keeps them) is marked to be drawn
   * again as a whole instead: a change of the view is not worth writing to
   * sources nobody sees, and the mode is redrawn as it shows again.
   */
  private drawsNow(mode: LayerMode): boolean {
    const state = this.state[mode];
    if (!state.segments) return false;
    if (this.handleOf(mode).isVisible()) return true;
    state.dirty = true;
    return false;
  }

  /** Cut and write the visible modes again, as the 3D view comes or goes */
  private redrawVisibleModes(): void {
    this.cutAwaited = false;
    for (const mode of MODES) {
      if (this.drawsNow(mode)) this.redrawPaths(mode);
    }
  }

  /**
   * After a lost WebGL context the sources are back with the data of before
   * the loss, and their features with the generations of then, which the
   * run tables may have gone past since: every mode is written again, or
   * emptied, a hidden one once it shows. The filters are set again with
   * them, whatever the map came back with.
   */
  private restoreModes(): void {
    if (this.destroyed) return;
    for (const mode of MODES) {
      this.state[mode].filterKey = "";
      if (!this.state[mode].segments) this.clearLayer(mode);
      else if (this.drawsNow(mode)) this.redrawPaths(mode);
    }
  }

  /**
   * Every flight smoothed at its height above its ground, kept for the
   * dataset it was worked out for: the data of a year does not change while
   * it is on the map
   */
  private smoothedFlights(segments: PathSegment[]): SmoothedFlights {
    if (this.smoothed?.segments !== segments) {
      // Each flight stands on its own fields (groundProfileFt), and on the
      // relief where it is drawn, as coarse as the level draws it, with the
      // ground of the levels around it (let go of as either changes)
      const { ground, offsets } = groundProfilesFt(
        segments,
        this.app.terrainActive,
        this.app.reliefLevel,
      );
      this.smoothed = {
        segments,
        flights: smoothFlights(segments, (i) => segments[i]!.altitude_ft ?? 0, {
          groundOf: (i) => ground[i]!,
          offsets,
        }),
      };
    }
    return this.smoothed.flights;
  }

  /**
   * Whether the 3D view draws the relief (terrainActive), and the level it
   * is drawn for (reliefLevel): its exaggeration and how coarse its ground
   * is, which the heights of the flights and the ground they are cut on
   * follow. The level is the one the ribbons are cut for, and changes only
   * as a zoom ends: the map switches the exaggeration of the relief and of
   * the ribbons in one frame (see ui/terrain.ts), and a ribbon stands on
   * the relief of every level around the one it was cut for (see
   * ribbonHeights), so the flights stay on it while the zoom goes on and
   * until they are cut for the new level, as wide as it asks. Returns
   * whether the relief came or went, which the caller answers by cutting
   * the flights anew on their other ground; a level that moved lets go of
   * the smoothed flights, for the cut at the end of the zoom, and of the
   * ribbons that cannot stay on the relief until then (see followsLevel)
   * or are out of sight. The globe
   * leaves the relief out (MapLibre 6.10 breaks the ribbons up on it) and
   * only shades it (reliefShaded), over the flat ground the ribbons stand
   * on there. Its code comes with the feature bundle, which is fetched the
   * first time either is wanted: until it has arrived the relief is not
   * drawn and the cut is left to its arrival (cutAwaited), or to its
   * failure, after which the flights stay on the flat map. Cut on the flat
   * ground first, they would be cut twice in a row, and the map's worker
   * hold both cuts at once.
   */
  private syncTerrain(): boolean | null {
    const map = this.listeningTo;
    const shaded = !!map && this.app.threeDVisible;
    const wanted = shaded && !this.app.globeVisible;
    const level = map ? reliefLevel(map.getZoom()) : this.app.reliefLevel;
    this.app.reliefShaded = shaded;
    if (shaded && !this.terrainLoaded) {
      void loadFeatures().then((features) => {
        if (this.destroyed || this.terrainLoaded) return;
        if (features) {
          features.followTerrain(this.app);
          this.terrainLoaded = true;
        }
        // A failure is tried again by the next zoom, not from here
        if ((features && this.syncTerrain()) || this.cutAwaited) {
          this.redrawVisibleModes();
        }
      });
      if (wanted) {
        // Nothing follows the level before the code has arrived, but a cut
        // of the flights meanwhile, on the flat map, is lifted by it
        if (level !== this.app.reliefLevel) this.ribbonEpoch++;
        this.app.reliefLevel = level;
        this.cutAwaited = true;
        return null;
      }
    }
    const was = this.app.reliefLevel;
    const moved = shaded && level !== was;
    const switched = wanted !== this.app.terrainActive;
    if (!switched && !moved) return false;
    if (level !== was) this.ribbonEpoch++;
    // The relief goes before it would be built for the new level
    if (!wanted) this.app.terrainActive = false;
    this.app.reliefLevel = level;
    this.app.terrainActive = wanted;
    this.smoothed = null;
    if (switched || !followsLevel(was, level)) {
      // Out of sight until the new cut has landed (ui/terrain.ts)
      this.releaseRibbons(false);
    } else if (moved) {
      // A mode out of sight is cut again as it shows, and would show the
      // cut of before until then, on the ground of another level
      this.releaseRibbons(true);
    }
    return switched;
  }

  /**
   * Empty the ribbons about to be cut on their other ground, before they
   * are, or those of the modes out of sight only (`hiddenOnly`): the map's
   * worker lets go of the tiles of the old cut before it takes in the new
   * one, instead of holding both, and the page of its copy of the old
   * before the new is built. Nobody sees them go: the relief's code hides
   * the ribbons as the relief comes or goes, or the level changes to one
   * they do not follow (see followsLevel), until the new cut has been drawn
   * (ui/terrain.ts). A mode that is hidden is drawn anew as it shows
   * (drawsNow).
   */
  private releaseRibbons(hiddenOnly: boolean): void {
    const map = this.readyMap();
    for (const mode of MODES) {
      if (hiddenOnly && this.drawsNow(mode)) continue;
      const ribbons = Object.values(CONFIGS[mode].ribbons);
      for (const { written } of Object.values(this.state[mode].tables)) {
        if (written && ribbons.includes(written)) {
          void map
            ?.getSource<GeoJSONSource>(written)
            ?.setData({ type: "FeatureCollection", features: [] });
        }
      }
    }
  }

  /** Style the layers of both modes again, for ribbonsShown */
  restyle(): void {
    for (const mode of MODES) this.applyLook(CONFIGS[mode]);
  }

  /**
   * Follow a change of the selection on the visible layers: only the
   * selection's source is rebuilt, the main one keeps its runs and is
   * dimmed and filtered instead.
   */
  updateSelectionStyles(): void {
    const data = this.app.currentData;
    for (const mode of MODES) {
      const visible =
        mode === "altitude"
          ? this.app.altitudeVisible
          : this.app.airspeedVisible;
      const state = this.state[mode];
      if (!visible || !data || !state.segments) continue;
      const config = CONFIGS[mode];
      // A mode left behind while it was hidden is drawn again as a whole
      if (state.dirty && this.handleOf(mode).isVisible()) {
        this.redrawPaths(mode);
      } else this.showSelection(config, data);
    }
    this.rehoverOnIdle();
  }

  /** Coloured on the same range as the runs, the selection's if any */
  private formatSegmentTooltip(segment: PathSegment): string {
    const altitude = this.resolveColorRange(CONFIGS.altitude);
    const speed = this.resolveColorRange(CONFIGS.airspeed);
    return generateSegmentPopupHtml({
      segment,
      altMin: altitude.min,
      altMax: altitude.max,
      speedMin: speed.min,
      speedMax: speed.max,
    });
  }

  /**
   * Ids of the paths the year/aircraft filter keeps, or `null` when no filter
   * is active and every segment is drawn regardless of its path info.
   */
  private visiblePathIds(data: KMLDataset): Set<number> | null {
    const year = this.app.selectedYear;
    const aircraft = this.app.selectedAircraft;
    if (year === "all" && aircraft === "all") return null;
    return datasetIndex(data).filter(year, aircraft).pathIds;
  }

  private updateLegend(
    min: number,
    max: number,
    config: Pick<LayerConfig, "legendMinId" | "legendMaxId" | "formatLegend">,
  ): void {
    const minEl = domCache.get(config.legendMinId);
    const maxEl = domCache.get(config.legendMaxId);
    if (minEl) minEl.textContent = config.formatLegend(min);
    if (maxEl) maxEl.textContent = config.formatLegend(max);
  }

  updateAltitudeLegend(minAlt: number, maxAlt: number): void {
    this.updateLegend(minAlt, maxAlt, CONFIGS.altitude);
  }

  updateAirspeedLegend(minSpeed: number, maxSpeed: number): void {
    this.updateLegend(minSpeed, maxSpeed, CONFIGS.airspeed);
  }
}
