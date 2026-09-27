/**
 * The heat cloud - the heatmap of the 3D view, in the air
 *
 * While the 3D view is on, the heat is drawn as a cloud of the fixes at
 * their height instead of as the flat heatmap on the ground, so the busy
 * airspace glows where it is: the circuits over a field, the routes along a
 * valley, the climbs out and the descents in. It shows what the heatmap
 * would: the fixes of the flights the year and aircraft filters keep, of
 * the selection alone while it is isolated, nothing while the Heatmap
 * switch is off; and it steps back under the aviation chart or a
 * selection's lines as the heatmap does, but not under the ribbons of a
 * colour layer, which are drawn in front of it (dimsHeatCloud). While a
 * replay runs it stays, faintly and without its pulses, so the chase
 * camera flies through the flights of before. The flat heatmap steps aside
 * for it (heatCloud in the store, see ui/layerVisibility.ts) from the
 * moment the cloud's layer is on the map until the 3D view is turned off,
 * or, where the cloud's shaders do not work, until the map has a new WebGL
 * context, which leaves the heatmap as it was meanwhile.
 *
 * The heights are the ribbons', on the same ground and as exaggerated (see
 * calculations/heatCloud.ts), and the layer (ui/heatCloudLayer.ts) is
 * drawn against the relief. It only draws: the map cannot tell what is
 * under the pointer in a custom layer, and the ribbons of the colour
 * layers stay what is hovered and clicked. It comes with the feature
 * bundle, with the relief, the first time the 3D view is on.
 *
 * Wrapped's intro flies over the cloud with the 3D view off
 * (forcedHeatCloud in the store). There the cloud stands on flat ground, as
 * on the globe the intro turns on, and is cut for the level of the zoom the
 * map last came to rest at, which the layer manager only follows in the 3D
 * view. It is the year of the cards: the flights the year and aircraft
 * filters keep, whatever the Heatmap switch, an isolated selection or a
 * colour layer say, at full strength. It pulses as in the 3D view, woken by
 * the flight and resting when the map does: the replay of all flights that
 * plays under the intro is no replay of the app's (replayActive), which
 * would dim it.
 *
 * In the 3D view the band of heights of its control (ui/heightBand.ts)
 * leaves out the heat below and above it. Wrapped, which has no such
 * control, shows all of it.
 */
import type { MapApp } from "../mapApp";
import type { StoreState } from "../state/store";
import type { KMLDataset, PathSegment } from "../types";
import { cloudPoints, type CloudPoints } from "../calculations/heatCloud";
import {
  groundedFlights,
  heldFlights,
  smoothGrounded,
} from "../calculations/groundProfile";
import type { SmoothedFlights } from "../calculations/smoothing";
import { datasetIndex } from "../calculations/datasetIndex";
import {
  FULL_BAND,
  heightBandEdgesFt,
  parseHeightBand,
} from "../calculations/heightBand";
import {
  isLiftedAt,
  liftExaggeration,
  reliefLevel,
} from "../calculations/lift";
import { FEET_TO_METERS, MAP_LAYERS } from "../utils/constants";
import { logError } from "../utils/logger";
import {
  hasLostContext,
  isReplayCameraMove,
  whenContextRestored,
} from "../utils/mapHelpers";
import { dimmedHeatmapOpacity } from "./dataManager";
import { dimsHeatCloud } from "./layerVisibility";
import {
  HEAT_CLOUD_LAYER,
  HeatCloudLayer,
  type HeatCloudStyle,
} from "./heatCloudLayer";
import { followHeightBand } from "./heightBand";

/**
 * The layer the cloud is drawn below: the first of the ribbons, above every
 * layer of the app that lies on the ground (the selection's lines, the
 * replay's route and trail) and below the flights in the air and the
 * labels. On the relief MapLibre draws the layers on the ground into a
 * texture of it, and the relief once more for every run of them another
 * layer breaks: between the heatmaps and the heat lines the cloud cut them
 * in two, and every frame of the 3D view drew the relief twice, even with
 * the Heatmap switch off.
 */
const CLOUD_BEFORE = MAP_LAYERS.pathsAltitudeRibbons;

/** How strongly the cloud is drawn while a replay runs */
const CLOUD_REPLAY_OPACITY = 0.25;

/** The keys the cloud follows */
const CLOUD_KEYS: readonly (keyof StoreState)[] = [
  "threeDVisible",
  "forcedHeatCloud",
  "heightBand",
  "wrappedVisible",
  "heatmapVisible",
  "replayActive",
  "currentData",
  "selectedYear",
  "selectedAircraft",
  "selectedPathIds",
  "isolateSelection",
  "reliefLevel",
  "terrainActive",
  "altitudeVisible",
  "airspeedVisible",
  "aviationVisible",
];

/**
 * Whether the selection is isolated in the cloud: as in the heatmap, but
 * not in Wrapped's (`forced`), whose cards describe every flight of the
 * filters
 */
function isolatesIn(app: MapApp, forced: boolean): boolean {
  return !forced && app.isolateSelection && app.selectedPathIds.size > 0;
}

/**
 * Whether the cloud stands on the relief: where the 3D view draws it, and
 * never in Wrapped's (`forced`), which is on the globe, where the relief is
 * left out (see LayerManager.syncTerrain)
 */
function onReliefIn(app: MapApp, forced: boolean): boolean {
  return !forced && app.terrainActive;
}

/**
 * What the points of the cloud were made of, as a key: the dataset, the
 * filter, the isolated selection, and the ground they stand on, in the
 * 3D view's cloud or in Wrapped's (`forced`); the relief level they are cut
 * for is kept apart (see CLOUD_LEVELS_KEPT)
 */
function pointsKey(app: MapApp, forced: boolean): unknown[] {
  const isolated = isolatesIn(app, forced)
    ? [...app.selectedPathIds].sort((a, b) => a - b).join()
    : "";
  return [
    app.currentData,
    app.selectedYear,
    app.selectedAircraft,
    isolated,
    onReliefIn(app, forced),
  ];
}

/** Whether two keys of pointsKey are the same */
function sameKey(a: unknown[] | null, b: unknown[]): boolean {
  return !!a && a.every((value, i) => value === b[i]);
}

/** The points of a cloud kept by relief level (see CLOUD_LEVELS_KEPT) */
interface KeptPoints {
  /** What they were made of (pointsKey) */
  made: unknown[] | null;
  /** By relief level, the one asked for last at the end */
  byLevel: Map<number, CloudPoints>;
}

/** No points kept yet */
function keptPoints(): KeptPoints {
  return { made: null, byLevel: new Map() };
}

/**
 * How many relief levels the points of the cloud are kept for, the last
 * ones it was drawn at. The points of a level are cut from every flight
 * smoothed on its ground (groundedFlights), which with the heatmap alone
 * was all of the 50 to 90 ms a zoom into another level took for two years
 * of flights; a zoom back, or in and out around one level, takes none. All
 * levels of those two years are about 7.0 MB of points, the four deepest
 * about 6.0.
 */
const CLOUD_LEVELS_KEPT = 4;

/**
 * How long points the cloud does not draw are kept: all of them while it
 * draws none (the Heatmap switch is off in the 3D view, Wrapped's button
 * had them cut ahead of time, prepareHeatCloud, for an intro that did not
 * come, or the intro is over), and those of the other cloud while it draws
 * one (Wrapped's cut ahead in the 3D view, or the 3D view's while Wrapped's
 * draws). With the flights smoothed for them Wrapped's held 8.6 MB of the
 * heap after a pointer had merely crossed the button.
 */
export const CLOUD_IDLE_MS = 15_000;

/**
 * The apps whose cloud is followed, each with what cuts its points ahead
 * of time (see prepareHeatCloud)
 */
const followed = new WeakMap<MapApp, (levels: readonly number[]) => void>();

/**
 * Cut the points of Wrapped's cloud (forcedHeatCloud) for the relief
 * `levels` ahead of time, once followHeatCloud follows it: Wrapped does
 * while its button is pointed at, so that its intro does not stall on them.
 * They are kept like the points of the levels drawn last, for
 * CLOUD_IDLE_MS unless the intro draws them.
 */
export function prepareHeatCloud(app: MapApp, levels: readonly number[]): void {
  followed.get(app)?.(levels);
}

/**
 * Draw the heat of the 3D view as a cloud while the 3D view is on, or the
 * store forces it (forcedHeatCloud), from now on, for as long as the app
 * lives. A second call for the same app does nothing.
 */
export function followHeatCloud(app: MapApp): void {
  const map = app.map;
  if (!map || followed.has(app)) return;
  followHeightBand(app);
  /**
   * The shaders did not work in the map's context: the heatmap stays, until
   * a lost context is restored
   */
  let broken = false;
  /** How strongly the cloud is drawn, as the heatmap would be */
  let opacity = 1;
  /**
   * Whether the flights are lifted: as the ribbons, which the layer manager
   * hands to the flat lines from LIFT_MAX_ZOOM on once a zoom has ended
   * (see LayerManager.handleZoomEnd), not while it goes on
   */
  let lifted = isLiftedAt(map.getZoom());
  /**
   * The points kept of the 3D view's cloud and of Wrapped's (`forced`),
   * each by what they were made of: a cut ahead of time for Wrapped does
   * not take the place of the points the 3D view draws
   */
  const kept = { own: keptPoints(), forced: keptPoints() };
  const keptOf = (forced: boolean): KeptPoints =>
    forced ? kept.forced : kept.own;
  /** The points handed to the layer */
  let drawn: CloudPoints | null = null;
  /**
   * The flights of Wrapped's cloud smoothed on their flat ground, the same
   * at every level, where groundedFlights holds none (see flightsFor)
   */
  let aside: {
    segments: readonly PathSegment[];
    flights: SmoothedFlights;
  } | null = null;
  /** Let go of the points of every level of one cloud (`forced`) */
  const forget = (forced: boolean): void => {
    const cloud = keptOf(forced);
    cloud.made = null;
    cloud.byLevel.clear();
    if (forced) aside = null;
  };
  /** Lets go of the points the cloud does not draw (CLOUD_IDLE_MS) */
  let idle: ReturnType<typeof setTimeout> | undefined;
  /**
   * The relief level of the zoom the map last came to rest at, which the
   * cloud is cut for outside the 3D view, where the layer manager follows
   * no level (see LayerManager.syncTerrain)
   */
  let atRest = reliefLevel(map.getZoom());
  /** The relief level the cloud is cut for and lifted as */
  const level = (): number => (app.threeDVisible ? app.reliefLevel : atRest);

  /** Whether the layer is on the map */
  const wanted = (): boolean =>
    (app.threeDVisible || app.forcedHeatCloud) && !broken;
  /** Whether it draws: Wrapped's whatever the Heatmap switch says */
  const shown = (): boolean =>
    wanted() && (app.forcedHeatCloud || app.heatmapVisible);

  const style = (): HeatCloudStyle | null => {
    if (!shown()) return null;
    // The relief's own exaggeration, which it switches as a zoom ends (see
    // ui/terrain.ts), or the level's where the map draws none
    const exaggeration =
      map.getTerrain()?.exaggeration ?? liftExaggeration(level());
    const metres = exaggeration * FEET_TO_METERS;
    return {
      groundM: onReliefIn(app, app.forcedHeatCloud) ? metres : 0,
      liftM: lifted ? metres : 0,
      opacity,
      flow: !app.replayActive,
      // Wrapped shows the whole year, without the control of the band
      band: heightBandEdgesFt(
        app.wrappedVisible ? FULL_BAND : parseHeightBand(app.heightBand),
      ),
    };
  };

  const layer = new HeatCloudLayer(style, (error) => {
    if (broken) return;
    logError("The heat cloud of the 3D view cannot be drawn:", error);
    broken = true;
    // Out of the frame it failed in
    setTimeout(sync, 0);
  });

  /** Hand the layer `points`, unless it has them already */
  const draw = (points: CloudPoints | null): void => {
    if (points === drawn) return;
    drawn = points;
    layer.setPoints(points);
  };

  /**
   * Let go in CLOUD_IDLE_MS of the points the cloud does not draw then:
   * all of them, or those of the other cloud
   */
  const release = (): void => {
    clearTimeout(idle);
    idle = setTimeout(() => {
      if (app.signal.aborted) return;
      if (shown()) {
        forget(!app.forcedHeatCloud);
        return;
      }
      draw(null);
      forget(false);
      forget(true);
    }, CLOUD_IDLE_MS);
  };

  /**
   * The points of what the heatmap shows cut for the level `at`, or of
   * Wrapped's cloud (`forced`): those kept for it while nothing they were
   * made of changed, or cut now
   */
  const pointsAt = (at: number, forced: boolean): CloudPoints | null => {
    const data = app.currentData;
    const key = pointsKey(app, forced);
    const cloud = keptOf(forced);
    if (!sameKey(cloud.made, key)) {
      forget(forced);
      cloud.made = key;
    }
    const { byLevel } = cloud;
    if (!data) return null;
    let points = byLevel.get(at);
    if (points) {
      byLevel.delete(at);
    } else {
      // The other cloud's where they are of the same: both on flat ground,
      // nothing isolated
      const other = keptOf(!forced);
      points =
        (sameKey(other.made, key) && other.byLevel.get(at)) ||
        makePoints(data, at, forced);
      const oldest = byLevel.keys().next();
      if (!oldest.done && byLevel.size >= CLOUD_LEVELS_KEPT) {
        byLevel.delete(oldest.value);
      }
    }
    byLevel.set(at, points);
    return points;
  };

  /** The points of what the heatmap shows, when that changed */
  const updatePoints = (): void => draw(pointsAt(level(), app.forcedHeatCloud));
  followed.set(app, (levels) => {
    for (const at of levels) pointsAt(at, true);
    release();
  });

  /**
   * The flights of `segments` smoothed on the ground of the cloud at
   * `level`. The 3D view's are the ribbons' curves, smoothed once for both
   * (see groundedFlights). Wrapped's stand on flat ground and are smoothed
   * aside, unless groundedFlights holds them: a cut ahead of time must not
   * take the place of the curves the ribbons stand on, and in 2D nothing
   * lets go of what groundedFlights holds.
   */
  const flightsFor = (
    segments: readonly PathSegment[],
    level: number,
    forced: boolean,
  ): SmoothedFlights => {
    const relief = onReliefIn(app, forced);
    if (!forced) return groundedFlights(segments, relief, level);
    const held = heldFlights(segments, relief, level);
    if (held) return held;
    if (aside?.segments !== segments) {
      aside = { segments, flights: smoothGrounded(segments, relief, level) };
    }
    return aside.flights;
  };

  /** The points of the flights the heatmap shows, cut for `level` */
  const makePoints = (
    data: KMLDataset,
    level: number,
    forced: boolean,
  ): CloudPoints => {
    const kept = datasetIndex(data).filter(
      app.selectedYear,
      app.selectedAircraft,
    ).pathIds;
    const isolated = isolatesIn(app, forced);
    const selected = app.selectedPathIds;
    const keep = isolated
      ? (pathId: number) => kept.has(pathId) && selected.has(pathId)
      : (pathId: number) => kept.has(pathId);
    const segments = data.path_segments;
    const flights = flightsFor(segments, level, forced);
    return cloudPoints(segments, flights, keep, level);
  };

  /** Put the layer where it belongs, or take it off */
  const place = (): void => {
    if (hasLostContext(map)) return;
    const on = !!map.getLayer(HEAT_CLOUD_LAYER);
    if (!wanted()) {
      if (on) map.removeLayer(HEAT_CLOUD_LAYER);
      return;
    }
    const before = map.getLayer(CLOUD_BEFORE) ? CLOUD_BEFORE : undefined;
    if (!on) {
      map.addLayer(layer, before);
      return;
    }
    // A new base style keeps the layer, which is none it knows of, but
    // not necessarily where it was
    if (!before) return;
    const order = map.getLayersOrder();
    if (order.indexOf(HEAT_CLOUD_LAYER) !== order.indexOf(before) - 1) {
      map.moveLayer(HEAT_CLOUD_LAYER, before);
    }
  };

  /** The 3D switch as the last sync found it */
  let threeD = app.threeDVisible;

  const sync = (): void => {
    if (app.signal.aborted) return;
    place();
    // The flat heatmap steps aside while the layer is there to draw
    app.heatCloud = wanted();
    const left3D = threeD && !app.threeDVisible;
    threeD = app.threeDVisible;
    if (!app.heatCloud) {
      // Nothing to hold on to until the 3D view is back. Those Wrapped drew
      // or had cut ahead of time (prepareHeatCloud) are kept for a while
      // (CLOUD_IDLE_MS), while what they were made of stays: its button
      // asks for them again as soon as the closing dialog hands it the
      // focus back.
      if (left3D) forget(false);
      draw(null);
      release();
      return;
    }
    // Wrapped's at full strength: the dialog hides what the heatmap steps
    // back for
    opacity = app.forcedHeatCloud
      ? 1
      : app.replayActive
        ? CLOUD_REPLAY_OPACITY
        : dimsHeatCloud(app)
          ? dimmedHeatmapOpacity()
          : 1;
    if (!map.isZooming()) lifted = isLiftedAt(map.getZoom());
    if (shown()) updatePoints();
    release();
    map.triggerRepaint();
  };

  void app.mapReady.then(() => {
    const signal = app.signal;
    if (signal.aborted) return;
    const unsubscribe = app.store.subscribeKeys(CLOUD_KEYS, sync);
    const zoomed = map.on("zoomend", (event: object) => {
      // Outside the 3D view the cloud follows the level itself, where the
      // map comes to rest: not on every jump of the replay's camera, nor
      // on the moves of Wrapped's intro (see REPLAY_CAMERA_MOVE)
      const at = reliefLevel(map.getZoom());
      if (!isReplayCameraMove(event) && at !== atRest) {
        atRest = at;
        if (!app.threeDVisible && shown()) {
          updatePoints();
          map.triggerRepaint();
        }
      }
      if (lifted === isLiftedAt(map.getZoom())) return;
      lifted = !lifted;
      map.triggerRepaint();
    });
    // A new base style, or one made anew, may have left the layer out
    const styled = map.on("styledata", () => {
      if (wanted()) place();
    });
    // The style that comes back after a lost WebGL context has none of the
    // custom layers of before (MapLibre warns of it at the loss), and the
    // layer's buffers went with the context. The shaders are tried again in
    // the new context: what failed may have failed with the old one.
    whenContextRestored(map, () => {
      broken = false;
      sync();
    });
    signal.addEventListener("abort", () => {
      clearTimeout(idle);
      unsubscribe();
      styled.unsubscribe();
      zoomed.unsubscribe();
    });
    sync();
  });
}
