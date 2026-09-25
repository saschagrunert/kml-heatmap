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
 *   are written again as the map zooms to another whole level, cut for the
 *   pixels of that level (see screenCut), and from CULL_FROM_ZOOM on only
 *   those around the view, again as the view leaves that. A mode that
 *   is hidden (the replay hides them without clearing them) is left as it
 *   is until it is drawn again.
 * - Paths are pixels of a layer and have no events of their own: what is
 *   under the pointer, for a click and for the tooltip, is found in
 *   ui/pathHover.ts, among the layers and runs this module has drawn.
 */
import type {
  ExpressionSpecification,
  GeoJSONSource,
  LngLat,
  Map as MapLibreMap,
  Point,
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
import {
  airspeedColorAt,
  altitudeColorAt,
  scalePosition,
} from "../utils/colors";
import { FEET_TO_METERS, MAP_LAYERS, MAP_SOURCES } from "../utils/constants";
import { domCache } from "../utils/domCache";
import { generateSegmentPopupHtml } from "../utils/htmlGenerators";
import { logError } from "../utils/logger";
import {
  isReplayCameraMove,
  toLngLat,
  hasLostContext,
  whenContextRestored,
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
  isLiftedAt,
  liftExaggeration,
  reliefLevel,
  ribbonWidthZoom,
} from "../calculations/lift";
import type { SmoothedFlights } from "../calculations/smoothing";
import {
  groundedFlights,
  heldGroundedFlights,
  releaseGroundedFlights,
  releaseGroundProfiles,
} from "../calculations/groundProfile";
import { ribbonOf, ribbonProperties } from "../calculations/ribbons";
import { appendCurve, flatCurves } from "../calculations/curves";
import {
  calculateAirspeedRange,
  calculateAltitudeRange,
  calculateSegmentProperties,
  formatAirspeedLabel,
  formatAltitudeLabel,
  rangeMiddle,
} from "../features/layers";
import { formatNumber } from "../utils/formatters";
import { DEGREES_TO_RADIANS, METRES_PER_DEGREE } from "../utils/geometry";
import { PathHover, type DrawnRuns, type RunsOnLayer } from "./pathHover";

export type LayerMode = "altitude" | "airspeed";

/** The two sources of a mode, and the layers drawn from them */
type RunSet = "main" | "selected";

const RUN_SETS: readonly RunSet[] = ["main", "selected"];

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
  /** The ramp's colour at a position along it, from 0 to 1 */
  colorAt: (position: number) => string;
  /** Range of the given segments, `fallback` when they have no value */
  computeRange: (
    segments: PathSegment[],
    fallback: Range,
    paths: PathInfo[],
  ) => Range;
  filterSegment?: (seg: PathSegment) => boolean;
  legendMinId: string;
  /** The label of the middle of the ramp, a number in the unit of the ends */
  legendMidId: string;
  legendMaxId: string;
  formatLegend: (value: number) => string;
  /** The middle's, narrower: the ends carry the second unit */
  formatMiddle: (value: number) => string;
}

/** Colour steps a range is cut into; the merge key of a run */
const COLOR_BINS = 32;

/**
 * The whole zoom level (see ribbonWidthZoom) from which the 3D view writes
 * only the ribbons around the view (see viewBox), app zoom 9: at app zoom
 * 12, 916 of the 205,000 ribbons of all years were in view
 */
const CULL_FROM_ZOOM = 8;

/**
 * How far around the view the ribbons are written, in spans of the view:
 * a pan of a quarter of a view or a zoom out of about half a level writes
 * them again
 */
const VIEW_SPARE = 0.25;

/** `[west, south, east, north]`, in degrees */
type Box = readonly [number, number, number, number];

/**
 * The part of the map a view of `map` may show ribbons of, and `spare`
 * spans of it around: the ground in view, which MapLibre draws no further
 * than the bounds of the view, and as far beyond as a ribbon `topM` metres
 * up as drawn reaches into view from outside it in a tilted view.
 */
function viewBox(map: MapLibreMap, topM: number, spare: number): Box {
  const bounds = map.getBounds();
  const { lng: west, lat: south } = bounds.getSouthWest();
  const { lng: east, lat: north } = bounds.getNorthEast();
  const reach =
    (topM * Math.tan(map.getPitch() * DEGREES_TO_RADIANS)) / METRES_PER_DEGREE;
  const lat = reach + spare * (north - south);
  const lng =
    reach /
      Math.cos(Math.min(Math.max(-south, north), 85) * DEGREES_TO_RADIANS) +
    spare * (east - west);
  return [west - lng, south - lat, east + lng, north + lat];
}

/** Whether two boxes overlap, in any copy of the world */
function overlaps(a: Box, b: Box): boolean {
  return (
    a[1] <= b[3] &&
    b[1] <= a[3] &&
    [-360, 0, 360].some((shift) => a[0] <= b[2] + shift && b[0] + shift <= a[2])
  );
}

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
    getValue: (seg) => seg.altitude_ft,
    colorAt: altitudeColorAt,
    computeRange: calculateAltitudeRange,
    legendMinId: "legend-min",
    legendMidId: "legend-mid",
    legendMaxId: "legend-max",
    formatLegend: formatAltitudeLabel,
    formatMiddle: (value) => `${formatNumber(value)} ft`,
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
    getValue: (seg) => seg.groundspeed_knots,
    colorAt: airspeedColorAt,
    computeRange: (segments, fallback) =>
      calculateAirspeedRange(segments, fallback),
    filterSegment: (seg) => seg.groundspeed_knots > 0,
    legendMinId: "airspeed-legend-min",
    legendMidId: "airspeed-legend-mid",
    legendMaxId: "airspeed-legend-max",
    formatLegend: formatAirspeedLabel,
    formatMiddle: (value) => `${formatNumber(value)} kt`,
  },
};

/** One feature of a source: a run of segments of one path in one colour */
interface Run {
  /** Half-open index range of the run within the drawn segment array */
  start: number;
  end: number;
  pathId: number;
  /**
   * Where the run is coloured on the ramp, from 0 to 1: the middle of its
   * colour step
   */
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
  /**
   * The part of the map the ribbons were written for (see viewBox), null
   * for all of them
   */
  box: Box | null;
  /**
   * A cut for another zoom or view was left out while isolate mode hid the
   * runs (see isolatedOut); they are written again as they show
   */
  behind: boolean;
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
    box: null,
    behind: false,
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
 * The middle of the one of COLOR_BINS equal steps of the ramp that `value`
 * falls in on `range` (see scalePosition), from 0 to 1: the merge key of a
 * run, and where on the ramp it is coloured
 */
function stepPosition(value: number, range: Range): number {
  const position = scalePosition(value, range.min, range.max, range.ranks);
  const step = Math.floor(position * COLOR_BINS);
  return (Math.min(Math.max(step, 0), COLOR_BINS - 1) + 0.5) / COLOR_BINS;
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

export class LayerManager implements PathHitTester {
  private app: MapApp;
  private state: Record<LayerMode, ModeState> = {
    altitude: emptyModeState(),
    airspeed: emptyModeState(),
  };

  /** Modes that were drawn or cleared before the sources existed */
  private pendingModes = new Set<LayerMode>();
  private destroyed = false;

  /** The map the zoom handler is registered on */
  private listeningTo: MapLibreMap | null = null;
  /** The flight under the pointer, and its values (ui/pathHover.ts) */
  private readonly pathHover: PathHover;
  /** The relief's code has been loaded and follows terrainActive */
  private terrainLoaded = false;
  /** A cut of the flights waits for the relief's code (see syncTerrain) */
  private cutAwaited = false;
  /** Stops restyling the ribbons as the relief's code shows or hides them */
  private readonly unfollowRibbons: () => void;
  /** Modes drawn once the camera comes to rest (see drawAtRest) */
  private readonly atRest = new Set<LayerMode>();

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
      if (!this.drawsNow(mode) || this.atRest.has(mode)) continue;
      for (const set of RUN_SETS) {
        const table = state.tables[set];
        if (table.widthZoom === null || table.widthZoom === level) continue;
        // Out of sight in isolate mode: written as it shows again
        if (this.isolatedOut(state, set)) {
          table.behind = true;
          continue;
        }
        if (table.written === config.ribbons[set] || isLiftedAt(zoom)) {
          this.setRuns(config, set, table.runs, true);
        } else {
          table.widthZoom = level;
        }
      }
    }
  };

  /**
   * Ribbons written around the view (see viewBox) are written again, as
   * they are, around a view that has left that
   */
  private readonly handleMoveEnd = (event: object): void => {
    const map = this.listeningTo;
    if (
      !map ||
      !this.app.threeDVisible ||
      this.cutAwaited ||
      isReplayCameraMove(event)
    ) {
      return;
    }
    for (const mode of MODES) {
      if (!this.drawsNow(mode) || this.atRest.has(mode)) continue;
      const state = this.state[mode];
      for (const set of RUN_SETS) {
        const table = state.tables[set];
        const { box, runs } = table;
        const view = box && viewBox(map, this.topM(), 0);
        // Written again once the view reaches past one of its edges, or as
        // they show again when isolate mode hides them
        if (
          view?.some((edge, i) => (i < 2 ? edge < box![i]! : edge > box![i]!))
        ) {
          if (this.isolatedOut(state, set)) table.behind = true;
          else this.setRuns(CONFIGS[mode], set, runs, true);
        }
      }
    }
  };

  constructor(app: MapApp) {
    this.app = app;
    this.pathHover = new PathHover(app, {
      readyMap: () => this.readyMap(),
      drawnRuns: (map) => this.drawnRuns(map),
      describe: (segment) => this.formatSegmentTooltip(segment),
    });
    // Lifted or flat, the flights are cut and written anew. The smoothed
    // flights and the ground of every level only the 3D view needs are let
    // go with it.
    app.store.subscribe("threeDVisible", (threeD) => {
      if (!threeD) releaseGroundProfiles();
      if (this.syncTerrain() !== null) this.redrawVisibleModes();
    });
    app.store.subscribe("globeVisible", () => {
      if (this.syncTerrain()) this.redrawVisibleModes();
    });
    // Out of sight while they settle on another ground (ui/terrain.ts)
    // Without its WebGL context the map has no style to write to: the
    // restore styles the modes as they are then (see restoreModes)
    this.unfollowRibbons = app.relief.onRibbonsShown(() => {
      if (!app.map || !hasLostContext(app.map)) this.restyle();
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
    this.pathHover.listen(map);
    map.on("zoomend", this.handleZoomEnd);
    map.on("moveend", this.handleMoveEnd);
    whenContextRestored(map, () => this.restoreModes());
    // A link or a saved view can open in 3D and close in: the store had
    // its 3D view before this manager subscribed, and a map built at a
    // zoom fires no zoomend
    if (this.syncTerrain()) this.redrawVisibleModes();
  }

  /** Stop following the pointer; the drawn layers stay on the map */
  destroy(): void {
    this.destroyed = true;
    this.unfollowRibbons();
    this.pathHover.destroy();
    this.listeningTo?.off("zoomend", this.handleZoomEnd);
    this.listeningTo?.off("moveend", this.handleMoveEnd);
    this.listeningTo = null;
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
   * The flight drawn at a point of the map, or null beside every flight, or
   * "stale" while the tiles cannot tell (see PathHover.hitTest). Part of
   * the contract with MapApp's click dispatcher, and what the hover runs on.
   */
  hitTest(point: Point): PathHitResult {
    return this.pathHover.hitTest(point);
  }

  /**
   * The layers a look under the pointer searches, with the runs their
   * features stand for: the lines of every mode that shows, and in the 3D
   * view its ribbons, unless they are hidden as they settle on another
   * ground (ui/terrain.ts): a query finds a feature whatever its opacity.
   * What is found is stale while a `setData` has not landed, told by the
   * app's own calls and not by whether the source is loaded alone: that is
   * false during every pan and zoom as well, and a camera move must not
   * make a click on the empty map one to ignore. While the ribbons settle,
   * nothing found is no word of the empty map either.
   */
  private drawnRuns(map: MapLibreMap): DrawnRuns {
    const threeD = this.app.threeDVisible;
    const ribbons = threeD && this.app.relief.ribbonsShown > 0;
    const layers = new Map<string, RunsOnLayer>();
    let landing = false;
    for (const mode of MODES) {
      const config = CONFIGS[mode];
      const state = this.state[mode];
      if (!this.handleOf(mode).isVisible() || !state.segments) continue;
      const drawn = RUN_SETS.map((set) => this.runsOnLayer(state, set));
      RUN_SETS.forEach((set, i) => layers.set(config.layers[set], drawn[i]!));
      if (ribbons) {
        RUN_SETS.forEach((set, i) =>
          layers.set(config.ribbons[set], { ...drawn[i]!, ribbon: true }),
        );
      }
      for (const set of RUN_SETS) {
        landing = this.stillLanding(map, config, set) || landing;
      }
    }
    return { layers, stale: landing || (threeD && !ribbons) };
  }

  /** What the features of a mode's lines of one set stand for */
  private runsOnLayer(state: ModeState, set: RunSet): RunsOnLayer {
    const { selected, isolate } = state.shown;
    return {
      table: state.tables[set],
      segments: state.segments ?? [],
      selected: set === "selected",
      ribbon: false,
      only: set === "main" && isolate && selected.size > 0 ? selected : null,
    };
  }

  /**
   * Whether the last `setData` of a mode's set is still on its way to the
   * map's tiles: asked here rather than followed through the map's events,
   * since the answer is only needed when someone looks
   */
  private stillLanding(
    map: MapLibreMap,
    config: LayerConfig,
    set: RunSet,
  ): boolean {
    const table = this.state[config.mode].tables[set];
    if (
      table.landing === "tiles" &&
      map.isSourceLoaded(table.written ?? config.sources[set])
    ) {
      table.landing = null;
    }
    return table.landing !== null;
  }

  /**
   * What a click on a flight does: toggle its selection and, on touch, show
   * the segment's values. Part of the contract with MapApp's click dispatcher.
   */
  onPathClick(hit: PathHit, lngLat: LngLat): void {
    this.pathHover.showTapped(hit, lngLat);
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
    this.pathHover.closeSegmentPopup();
  }

  /**
   * Show the colour layers the store asks for: a mode shows while its flag
   * is on and no replay runs (see ui/layerVisibility.ts). One that shows
   * again is drawn anew, since it may have missed changes while it was
   * hidden (see drawsNow); one switched off lets go of its runs, which for
   * a large year hold tens of MB. A mode the replay hides keeps them.
   * In a 3D view whose relief's code is still on its way, a mode that shows
   * is drawn as it arrives, on the relief (see syncTerrain): cut on the
   * flat ground first, the flights were cut and written twice in a row as
   * the 3D view came on, 60,000 ribbons and then 72,000.
   *
   * @param rebuild - The data or the filter changed: draw every mode that
   *   shows, whether it did before or not
   */
  syncModes(rebuild = false): void {
    const data = this.app.currentData;
    const awaiting =
      this.app.threeDVisible &&
      !this.terrainLoaded &&
      this.syncTerrain() === null;
    for (const mode of MODES) {
      const handle = this.handleOf(mode);
      const wanted = this.app[`${mode}Visible`];
      const shown = wanted && !this.app.replayActive;
      const showing = handle.isVisible();
      handle.setVisible(shown);
      if (!wanted) {
        if (rebuild || this.state[mode].segments) this.clearLayer(mode);
      } else if (shown && (rebuild || !showing)) {
        if (awaiting && data) {
          // What redrawVisibleModes draws once the code has arrived. The
          // runs of before index into the segments of before: the features
          // on the map are stale until then, not flights of this dataset.
          const state = this.state[mode];
          state.segments = data.path_segments;
          state.dirty = false;
          for (const set of RUN_SETS) {
            state.tables[set].runs = [];
            state.tables[set].g++;
          }
        } else if (rebuild || !this.drawAtRest(mode)) this.redrawPaths(mode);
      } else if (rebuild) {
        // Hidden by the replay: drawn as it shows again
        this.state[mode].dirty = true;
      }
    }
  }

  /**
   * Leave a mode that shows again in the 3D view while the camera moves to
   * the end of the move, and say whether it was: as a replay closes, the
   * camera eases back from the chase to the view of before it, and a mode
   * drawn as it showed was smoothed and cut at the level the chase had left
   * the camera at, and then again at the one the move ends on. Until then
   * it shows the cut it had as the replay hid it, whose runs and segments
   * still belong together.
   */
  private drawAtRest(mode: LayerMode): boolean {
    const map = this.listeningTo;
    if (
      !map ||
      !this.app.threeDVisible ||
      !this.state[mode].segments ||
      !map.isMoving()
    ) {
      return false;
    }
    if (this.atRest.size === 0) {
      map.once("moveend", () => {
        const waiting = [...this.atRest];
        this.atRest.clear();
        if (this.destroyed) return;
        for (const other of waiting) {
          if (this.handleOf(other).isVisible()) this.redrawPaths(other);
          else this.state[other].dirty = true;
        }
      });
    }
    this.atRest.add(mode);
    return true;
  }

  /**
   * Empty both sources of a mode (used for hidden layers so they do not
   * keep stale geometry around)
   */
  clearLayer(mode: LayerMode): void {
    const config = CONFIGS[mode];
    const state = this.state[mode];
    this.atRest.delete(mode);
    state.segments = null;
    state.dirty = false;
    this.setRuns(config, "main", []);
    this.setRuns(config, "selected", []);
    // Nothing drawn is left to smooth, unless the heat cloud draws along
    // the smoothed flights (see groundedFlights)
    if (
      MODES.every((other) => !this.state[other].segments) &&
      !(this.app.heatCloud && this.app.heatmapVisible)
    ) {
      releaseGroundedFlights();
    }
    this.pathHover.rehoverOnIdle();
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
        color: config.colorAt(runKey),
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
          (only && !only.has(pathId)) ||
          (visiblePathIds !== null && !visiblePathIds.has(pathId)) ||
          (config.filterSegment && !config.filterSegment(segment))
        ) {
          flush(i);
          continue;
        }

        const key = stepPosition(config.getValue(segment), range);
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
    table.behind = false;
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
    // Zoomed in, the ribbons around the view only
    const box =
      smoothed && widthZoom >= CULL_FROM_ZOOM
        ? viewBox(map, this.topM(), VIEW_SPARE)
        : null;
    table.box = box;
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
          toLngLat(segments[run.start]!.coords[0]),
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
      // without a seam, for the pixels of the zoom
      if (box && !overlaps(box, this.runBox(run, smoothed))) return;
      for (const piece of ribbonOf(
        smoothed,
        run.start,
        run.end,
        widthZoom,
        true,
      )) {
        features.push({
          type: "Feature",
          properties: {
            ...properties,
            ...ribbonProperties(piece, level, this.app.relief.epoch),
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
    // until its tiles are cut. Around the view only, what was not written
    // before is found once they are: nothing found is no word of the
    // empty map until then.
    if (recut && !moved && !box) {
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
    this.atRest.delete(mode);
    state.segments = data.path_segments;
    state.dirty = false;
    // The flights of another dataset are smoothed anew when they are lifted
    const held = heldGroundedFlights();
    if (held && held !== data.path_segments) releaseGroundedFlights();
    this.setRuns(
      config,
      "main",
      this.cutRuns(config, data, this.rangeOf(mode)),
    );
    this.showSelection(config, data);
    this.pathHover.rehoverOnIdle();
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
    this.updateLegend(range, config);
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
    const ribbonsShown = this.app.relief.ribbonsShown;
    map.setPaintProperty(
      config.ribbons.main,
      "fill-extrusion-opacity",
      mainOpacity * ribbonsShown,
    );
    map.setPaintProperty(
      config.ribbons.selected,
      "fill-extrusion-opacity",
      selectedLook.opacity * ribbonsShown,
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

  /**
   * Whether the runs of a set are out of sight as isolate mode shows the
   * selection alone: the main layers are filtered to nothing (see
   * applyLook). A zoom or a pan that would cut them again for the view, and
   * in the 3D view smooth every flight for it, leaves them as they are
   * until they show again (see updateSelectionStyles).
   */
  private isolatedOut(state: ModeState, set: RunSet): boolean {
    return (
      set === "main" && state.shown.isolate && state.shown.selected.size > 0
    );
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
   * Every flight smoothed at its height above its ground, on the ground and
   * at the level the relief is drawn for (see groundedFlights), kept for as
   * long as the dataset, the ground and the level are the same
   */
  private smoothedFlights(segments: PathSegment[]): SmoothedFlights {
    return groundedFlights(
      segments,
      this.app.terrainActive,
      this.app.reliefLevel,
    );
  }

  /**
   * How high the highest flight may be drawn above its ground, in metres,
   * in the 3D view: no higher than its altitude
   */
  private topM(): number {
    return (
      this.app.altitudeRange.max *
      FEET_TO_METERS *
      liftExaggeration(this.app.reliefLevel)
    );
  }

  /** The part of the map the ribbon of a run lies in, along its curve */
  private runBox(run: Run, smoothed: SmoothedFlights): Box {
    const { points } = smoothed.chains[smoothed.chainOf[run.start]!]!;
    let [west, south, east, north] = [540, 90, -540, -90];
    const last = smoothed.to[run.end - 1]!;
    for (let j = smoothed.from[run.start]!; j <= last; j++) {
      const [lat, lng] = points[j]!;
      west = Math.min(west, lng);
      east = Math.max(east, lng);
      south = Math.min(south, lat);
      north = Math.max(north, lat);
    }
    return [west, south, east, north];
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
   * the flights anew on their other ground; a level that moved on the
   * relief has the flights smoothed anew for it (see groundedFlights) for
   * the cut at the end of the zoom, and lets go of the ribbons that cannot
   * stay on the relief until then
   * (see followsLevel) or are out of sight. The globe leaves the relief out
   * (MapLibre 6.10 breaks the ribbons up on it) and only shades it
   * (reliefShaded), over the flat ground the ribbons stand on there. Its
   * code comes with the feature bundle, which is fetched the first time
   * either is wanted: until it has arrived the relief is not drawn and the
   * cut is left to its arrival (cutAwaited), or to its failure, after which
   * the flights stay on the flat map. Cut on the flat ground first, they
   * would be cut twice in a row, and the map's worker hold both cuts at
   * once.
   */
  private syncTerrain(): boolean | null {
    const map = this.listeningTo;
    const shaded = !!map && this.app.threeDVisible;
    const wanted = shaded && !this.app.globeVisible;
    const level = map ? reliefLevel(map.getZoom()) : this.app.reliefLevel;
    const relief = this.app.relief;
    relief.shade(shaded);
    if (shaded && !this.terrainLoaded) {
      void loadFeatures().then((features) => {
        if (this.destroyed || this.terrainLoaded) return;
        if (features) {
          features.followTerrain(this.app);
          features.followHeatCloud(this.app);
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
        relief.moveTo(level);
        this.cutAwaited = true;
        return null;
      }
    }
    const was = this.app.reliefLevel;
    const moved = shaded && level !== was;
    const switched = wanted !== this.app.terrainActive;
    if (!switched && !moved) return false;
    relief.moveTo(level, wanted);
    // Flights on the relief stand on the ground of its level, and are
    // smoothed anew for another (see groundedFlights); on the globe, on the
    // line between their fields, the same at every level: there a zoom that
    // ends on another one would smooth every flight again for nothing, a
    // third of the work of that zoom's end
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
  private restyle(): void {
    for (const mode of MODES) this.applyLook(CONFIGS[mode]);
  }

  /**
   * Follow a change of the selection on the visible layers: only the
   * selection's source is rebuilt, the main one keeps its runs and is
   * dimmed and filtered instead. Isolate mode alone changes neither: the
   * layers are styled again, and the selection keeps the runs it has, and
   * with them the features the tiles hold. Rewritten under a new
   * generation, a click on the map would count as stale until they landed.
   * The main runs a zoom or a pan passed by in isolation are written for
   * the view as they show again.
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
        continue;
      }
      const { selected } = state.shown;
      const current = this.app.selectedPathIds;
      if (
        selected.size === current.size &&
        [...current].every((id) => selected.has(id))
      ) {
        this.applyLook(config);
      } else this.showSelection(config, data);
      const main = state.tables.main;
      if (main.behind && !this.isolatedOut(state, "main")) {
        this.setRuns(config, "main", main.runs, true);
      }
    }
    this.pathHover.rehoverOnIdle();
  }

  /** Coloured on the same range as the runs, the selection's if any */
  private formatSegmentTooltip(segment: PathSegment): string {
    const altitude = this.resolveColorRange(CONFIGS.altitude);
    const speed = this.resolveColorRange(CONFIGS.airspeed);
    return generateSegmentPopupHtml({
      segment,
      altRange: altitude,
      speedRange: speed,
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

  /**
   * Label a legend with the ends of `range` and the value in the middle of
   * its ramp: spread by rank, the colours of the middle are the median's,
   * not those of the value halfway between the ends (see rangeMiddle)
   */
  private updateLegend(
    range: Range,
    config: Pick<
      LayerConfig,
      | "legendMinId"
      | "legendMidId"
      | "legendMaxId"
      | "formatLegend"
      | "formatMiddle"
    >,
  ): void {
    const minEl = domCache.get(config.legendMinId);
    const midEl = domCache.get(config.legendMidId);
    const maxEl = domCache.get(config.legendMaxId);
    if (minEl) minEl.textContent = config.formatLegend(range.min);
    if (midEl) midEl.textContent = config.formatMiddle(rangeMiddle(range));
    if (maxEl) maxEl.textContent = config.formatLegend(range.max);
  }

  updateAltitudeLegend(range: Range): void {
    this.updateLegend(range, CONFIGS.altitude);
  }

  updateAirspeedLegend(range: Range): void {
    this.updateLegend(range, CONFIGS.airspeed);
  }
}
