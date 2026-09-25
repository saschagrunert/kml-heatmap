/**
 * The heat cloud - the heatmap of the 3D view, in the air
 *
 * While the 3D view is on, the heat is drawn as a cloud of the fixes at
 * their height instead of as the flat heatmap on the ground, so the busy
 * airspace glows where it is: the circuits over a field, the routes along a
 * valley, the climbs out and the descents in. It shows what the heatmap
 * would: the fixes of the flights the year and aircraft filters keep, of
 * the selection alone while it is isolated, nothing while the Heatmap
 * switch is off or a replay runs; and it steps back under a colour layer
 * as the heatmap does (dimsHeatmap). The flat heatmap steps aside for it
 * (heatCloud in the store, see ui/layerVisibility.ts) from the moment the
 * cloud's layer is on the map until the 3D view is turned off, or for good
 * where the cloud's shaders do not work, which leaves the heatmap as it was.
 *
 * The heights are the ribbons', on the same ground and as exaggerated (see
 * calculations/heatCloud.ts), and the layer (ui/heatCloudLayer.ts) is
 * drawn against the relief. It only draws: the map cannot tell what is
 * under the pointer in a custom layer, and the ribbons of the colour
 * layers stay what is hovered and clicked. It comes with the feature
 * bundle, with the relief, the first time the 3D view is on.
 */
import type { MapApp } from "../mapApp";
import type { StoreState } from "../state/store";
import type { KMLDataset } from "../types";
import { cloudPoints, type CloudPoints } from "../calculations/heatCloud";
import { groundedFlights } from "../calculations/groundProfile";
import { datasetIndex } from "../calculations/datasetIndex";
import { isLiftedAt, liftExaggeration } from "../calculations/lift";
import { FEET_TO_METERS, MAP_LAYERS } from "../utils/constants";
import { logError } from "../utils/logger";
import { hasLostContext, whenContextRestored } from "../utils/mapHelpers";
import { dimmedHeatmapOpacity } from "./dataManager";
import { dimsHeatmap } from "./layerVisibility";
import {
  HEAT_CLOUD_LAYER,
  HeatCloudLayer,
  type HeatCloudStyle,
} from "./heatCloudLayer";

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

/** The keys the cloud follows */
const CLOUD_KEYS: readonly (keyof StoreState)[] = [
  "threeDVisible",
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
 * What the points of the cloud were made of, as a key: the dataset, the
 * filter, the isolated selection, and the ground they stand on; the relief
 * level they are cut for is kept apart (see CLOUD_LEVELS_KEPT)
 */
function pointsKey(app: MapApp): unknown[] {
  const isolated =
    app.isolateSelection && app.selectedPathIds.size > 0
      ? [...app.selectedPathIds].sort((a, b) => a - b).join()
      : "";
  return [
    app.currentData,
    app.selectedYear,
    app.selectedAircraft,
    isolated,
    app.terrainActive,
  ];
}

/** Whether two keys of pointsKey are the same */
function sameKey(a: unknown[] | null, b: unknown[]): boolean {
  return !!a && a.every((value, i) => value === b[i]);
}

/**
 * How many relief levels the points of the cloud are kept for, the last
 * ones it was drawn at. The points of a level are cut from every flight
 * smoothed on its ground (groundedFlights), which with the heatmap alone
 * was all of the 50 to 90 ms a zoom into another level took for two years
 * of flights; a zoom back, or in and out around one level, takes none. All
 * levels of those two years were 5.8 MB of points, the four deepest 5.1.
 */
const CLOUD_LEVELS_KEPT = 4;

/**
 * Draw the heat of the 3D view as a cloud while the 3D view is on, from
 * now on, for as long as the app lives
 */
export function followHeatCloud(app: MapApp): void {
  const map = app.map;
  if (!map) return;
  /** The shaders did not work in the map's context: the heatmap stays */
  let broken = false;
  /** How strongly the cloud is drawn, as the heatmap would be */
  let opacity = 1;
  /**
   * Whether the flights are lifted: as the ribbons, which the layer manager
   * hands to the flat lines from LIFT_MAX_ZOOM on once a zoom has ended
   * (see LayerManager.handleZoomEnd), not while it goes on
   */
  let lifted = isLiftedAt(map.getZoom());
  /** What the points kept by level were made of */
  let made: unknown[] | null = null;
  /** The points by relief level, the one drawn last at the end */
  const byLevel = new Map<number, CloudPoints>();
  /** Let go of the points of every level */
  const forget = (): void => {
    made = null;
    byLevel.clear();
  };

  const shown = (): boolean =>
    app.threeDVisible && app.heatmapVisible && !app.replayActive && !broken;

  const style = (): HeatCloudStyle | null => {
    if (!shown()) return null;
    // The relief's own exaggeration, which it switches as a zoom ends (see
    // ui/terrain.ts), or the level's where the map draws none
    const exaggeration =
      map.getTerrain()?.exaggeration ?? liftExaggeration(app.reliefLevel);
    const metres = exaggeration * FEET_TO_METERS;
    return {
      groundM: app.terrainActive ? metres : 0,
      liftM: lifted ? metres : 0,
      opacity,
    };
  };

  const layer = new HeatCloudLayer(style, (error) => {
    if (broken) return;
    logError("The heat cloud of the 3D view cannot be drawn:", error);
    broken = true;
    // Out of the frame it failed in
    setTimeout(sync, 0);
  });

  /** The points of what the heatmap shows, when that changed */
  const updatePoints = (): void => {
    const data = app.currentData;
    const key = pointsKey(app);
    if (!sameKey(made, key)) {
      forget();
      made = key;
    }
    if (!data) {
      layer.setPoints(null);
      return;
    }
    const level = app.reliefLevel;
    let points = byLevel.get(level);
    // Drawn already: the last one kept
    if (points && [...byLevel.keys()].pop() === level) return;
    if (points) {
      byLevel.delete(level);
    } else {
      points = makePoints(data, level);
      const oldest = byLevel.keys().next();
      if (!oldest.done && byLevel.size >= CLOUD_LEVELS_KEPT) {
        byLevel.delete(oldest.value);
      }
    }
    byLevel.set(level, points);
    layer.setPoints(points);
  };

  /** The points of the flights the heatmap shows, cut for `level` */
  const makePoints = (data: KMLDataset, level: number): CloudPoints => {
    const kept = datasetIndex(data).filter(
      app.selectedYear,
      app.selectedAircraft,
    ).pathIds;
    const isolated = app.isolateSelection && app.selectedPathIds.size > 0;
    const selected = app.selectedPathIds;
    const keep = isolated
      ? (pathId: number) => kept.has(pathId) && selected.has(pathId)
      : (pathId: number) => kept.has(pathId);
    const segments = data.path_segments;
    // The ribbons' curves, smoothed once for both (see groundedFlights)
    const flights = groundedFlights(segments, app.terrainActive, level);
    return cloudPoints(segments, flights, keep, level);
  };

  /** Put the layer where it belongs, or take it off */
  const place = (): void => {
    if (hasLostContext(map)) return;
    const wanted = app.threeDVisible && !broken;
    const on = !!map.getLayer(HEAT_CLOUD_LAYER);
    if (!wanted) {
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

  const sync = (): void => {
    if (app.signal.aborted) return;
    place();
    // The flat heatmap steps aside while the layer is there to draw
    app.heatCloud = app.threeDVisible && !broken;
    if (!app.threeDVisible) {
      // Nothing to hold on to until the 3D view is back
      forget();
      layer.setPoints(null);
      return;
    }
    opacity = dimsHeatmap(app) ? dimmedHeatmapOpacity() : 1;
    if (!map.isZooming()) lifted = isLiftedAt(map.getZoom());
    if (shown()) updatePoints();
    map.triggerRepaint();
  };

  void app.mapReady.then(() => {
    const signal = app.signal;
    if (signal.aborted) return;
    const unsubscribe = app.store.subscribeKeys(CLOUD_KEYS, sync);
    const zoomed = map.on("zoomend", () => {
      if (lifted === isLiftedAt(map.getZoom())) return;
      lifted = !lifted;
      map.triggerRepaint();
    });
    // A new base style, or one made anew, may have left the layer out
    const styled = map.on("styledata", () => {
      if (app.threeDVisible) place();
    });
    // The style that comes back after a lost WebGL context has none of the
    // custom layers of before (MapLibre warns of it at the loss), and the
    // layer's buffers went with the context
    whenContextRestored(map, sync);
    signal.addEventListener("abort", () => {
      unsubscribe();
      styled.unsubscribe();
      zoomed.unsubscribe();
    });
    sync();
  });
}
