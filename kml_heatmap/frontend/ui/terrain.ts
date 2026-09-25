/**
 * Terrain - the relief under the 3D view
 *
 * The 3D view draws the relief and stands the flights on it, at every
 * zoom, exaggerated as much as they are (calculations/lift.ts). The layer
 * manager decides when, and for which level (terrainActive, reliefLevel),
 * in the task it cuts the ribbons on their ground; this module makes the
 * map follow. The globe only shades the relief (reliefShaded) and leaves
 * the relief itself out, whose mesh MapLibre 6.10 breaks the ribbons up
 * on. It comes with the feature bundle: most visits never turn the 3D
 * view on.
 *
 * The elevation tiles are AWS's Terrarium tiles, the ones the build samples
 * the ground from (kml_heatmap/terrain.py), so the relief and the ground
 * the flights are measured against are the same model, smoothed as the
 * map draws it at each level. The browser fetches them only while the
 * relief is drawn or shaded, and the map shows their credit only then.
 */
import type { Map as MapLibreMap } from "maplibre-gl";
import type { MapApp } from "../mapApp";
import {
  EXAGGERATION_STATE,
  followsLevel,
  liftExaggeration,
  ribbonId,
  switchesExaggeration,
  TERRAIN_TILE_MAX_ZOOM,
} from "../calculations/lift";
import { MAP_LAYERS, MAP_SOURCES } from "../utils/constants";
import { cssVar, whenContextRestored } from "../utils/mapHelpers";
import { SATELLITE_LAYER } from "./satellite";

const TERRAIN_TILE_URL =
  "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";

/**
 * The shading of the relief, from the same elevation tiles. It is not a
 * layer the map is created with: it only exists once the relief has been
 * drawn, and belongs with the base map rather than with the app's layers.
 */
export const HILLSHADE_LAYER = "terrain-hillshade";

/** The ribbons of the 3D view, which stand on the relief (MAP_LAYERS) */
const RIBBON_LAYERS = [
  MAP_SOURCES.pathsAltitudeRibbons,
  MAP_SOURCES.pathsAirspeedRibbons,
  MAP_SOURCES.pathsAltitudeSelectedRibbons,
  MAP_SOURCES.pathsAirspeedSelectedRibbons,
  MAP_SOURCES.replayTrailRibbons,
];

/**
 * Switch the relief on and off with terrainActive, its exaggeration with
 * reliefLevel, and its shading with reliefShaded, from now on. Each switch
 * builds the relief anew and throws away what the map drew onto it (a few
 * milliseconds), which is why it follows the level, once a zoom has
 * ended, and never the zoom itself. The ribbons switch their exaggeration
 * with it, in the same frame (see exaggerateRibbons).
 */
export function followTerrain(app: MapApp): void {
  const map = app.map;
  if (!map) return;
  const apply = (): void => {
    const active = app.terrainActive;
    const shaded = app.reliefShaded;
    if (active || shaded) addSource(map);
    shade(map, shaded);
    const exaggeration = liftExaggeration(app.reliefLevel);
    const terrain = map.getTerrain();
    if (!active) {
      if (terrain) map.setTerrain(null);
      return;
    }
    if (terrain?.exaggeration === exaggeration) return;
    map.setTerrain({ source: MAP_SOURCES.terrain, exaggeration });
  };
  // The relief is part of the style, so it waits for one
  void app.mapReady.then(() => {
    const settle = settleRibbons(app, map);
    const ribbons = exaggerateRibbons(app, map);
    // Onto or off the relief the ribbons stand on other ground; another
    // level of it they stand on already (see ribbonHeights), and take its
    // exaggeration along with the relief, all but those the map does not
    // know by an id (see followsLevel), which wait out of sight for their
    // new cut then
    app.store.subscribe("terrainActive", () => {
      settle();
      apply();
    });
    app.store.subscribe("reliefLevel", (level) => {
      if (!ribbons(level)) settle();
      apply();
    });
    app.store.subscribe("reliefShaded", apply);
    // MapLibre restores the relief with the style after a lost WebGL
    // context, but some of what it draws onto it stays black until the
    // relief is built anew
    whenContextRestored(map, () => {
      map.setTerrain(null);
      ribbons(null);
      apply();
    });
    // A move ends on ground whose elevation tiles land after it: the map
    // raises its centre onto them then, and everything drawn shifts on the
    // screen, without a move event. The markers and popups follow the
    // map's moves and would stay where the ground was until the next one,
    // an airport a few dozen pixels off its field. A "terrain" event has
    // them follow every frame until the map has loaded, as when the relief
    // is switched on (MapLibre 6.10's markers).
    map.on("moveend", () => {
      if (map.getTerrain()) map.fire("terrain");
    });
    // A new base style drops the shading, which is none of the app's layers
    // for `withDataLayers` to carry; it goes back where it belongs in it
    map.on("styledata", () => {
      if (app.reliefShaded && !map.getLayer(HILLSHADE_LAYER)) apply();
    });
    // The layer manager may have switched it on already, as it loaded this
    if (app.terrainActive) settle();
    apply();
  });
}

/** The elevation tiles, once: `withDataLayers` carries them from then on */
function addSource(map: MapLibreMap): void {
  if (map.getSource(MAP_SOURCES.terrain)) return;
  map.addSource(MAP_SOURCES.terrain, {
    type: "raster-dem",
    tiles: [TERRAIN_TILE_URL],
    encoding: "terrarium",
    tileSize: 256,
    maxzoom: TERRAIN_TILE_MAX_ZOOM,
    attribution:
      'Elevation: <a href="https://registry.opendata.aws/terrain-tiles/">Terrain Tiles</a> (Mapzen and others)',
  });
}

/**
 * Show the shading while the relief is drawn or, on the globe, would be,
 * hide it otherwise: created the first time, directly above the last of
 * the base map's area fills (land, parks, water) and the satellite imagery
 * (ui/satellite.ts), and so below its labels and every layer of the app.
 * Its colours are the stylesheet's (--terrain-*), subtle on the dark map,
 * so the heat and the flights stay what reads.
 */
function shade(map: MapLibreMap, shown: boolean): void {
  if (map.getLayer(HILLSHADE_LAYER)) {
    map.setLayoutProperty(
      HILLSHADE_LAYER,
      "visibility",
      shown ? "visible" : "none",
    );
    return;
  }
  if (!shown) return;
  const own = new Set<string>(Object.values(MAP_LAYERS));
  let before: string | undefined;
  const order = map.getLayersOrder();
  for (const [i, id] of order.entries()) {
    const type = map.getLayer(id)?.type;
    if (own.has(id) || type === "symbol") break;
    if (type === "fill" || type === "background" || id === SATELLITE_LAYER) {
      before = order[i + 1];
    }
  }
  const shadow = cssVar("--terrain-shadow") || "rgba(0, 0, 0, 0.7)";
  map.addLayer(
    {
      id: HILLSHADE_LAYER,
      type: "hillshade",
      source: MAP_SOURCES.terrain,
      paint: {
        "hillshade-shadow-color": shadow,
        "hillshade-highlight-color":
          cssVar("--terrain-highlight") || "rgba(255, 255, 255, 0.12)",
        "hillshade-accent-color": shadow,
        "hillshade-exaggeration":
          Number.parseFloat(cssVar("--terrain-exaggeration")) || 0.5,
      },
    },
    before,
  );
}

/**
 * What gives the ribbons cut for another relief level the exaggeration of
 * the level the map is drawn for, as the store moves to the level `level`,
 * and tells whether all the ribbons the map may still draw stay on the
 * relief until they are cut for it (see followsLevel); null gives the
 * states again to a map that has lost them with its style.
 *
 * The map may still draw the cut of every level since all the ribbons last
 * landed; the layer manager empties those of a mode out of sight. The cuts
 * of a level the map knows by an id get the exaggeration of the new level
 * through a feature state for that id, which the map applies to all of
 * their tiles in the frame the relief switches. The cut for the new level
 * has an id no state was given (see ribbonId), and gets none: MapLibre
 * works out the paint of every feature of an id it has a state for anew in
 * each tile it loads. Once all the ribbons have landed, the old cuts and
 * their ids are gone for good.
 */
function exaggerateRibbons(
  app: MapApp,
  map: MapLibreMap,
): (level: number | null) => boolean {
  const cutOf = (level: number): { level: number; id: number | null } => ({
    level,
    id: switchesExaggeration(level)
      ? ribbonId(level, app.layerManager.ribbonEpoch)
      : null,
  });
  /** The cuts the map may draw: their level, and their id or null */
  let cuts = [cutOf(app.reliefLevel)];
  // The exaggeration each id's ribbons were given
  const given = new Map<number, number>();
  const give = (): void => {
    const exaggeration = liftExaggeration(app.reliefLevel);
    for (const { level, id } of cuts) {
      if (id === null) continue;
      const own = liftExaggeration(level) === exaggeration;
      if (own ? !given.has(id) : given.get(id) === exaggeration) continue;
      for (const source of RIBBON_LAYERS) {
        if (!map.getSource(source)) continue;
        if (own) {
          map.removeFeatureState({ source, id }, EXAGGERATION_STATE);
        } else {
          map.setFeatureState(
            { source, id },
            { [EXAGGERATION_STATE]: exaggeration },
          );
        }
      }
      if (own) given.delete(id);
      else given.set(id, exaggeration);
    }
  };
  const landed = (): void => {
    const loading = RIBBON_LAYERS.some(
      (id) => map.getSource(id) && !map.isSourceLoaded(id),
    );
    if (loading) return;
    map.off("render", landed);
    cuts = [cutOf(app.reliefLevel)];
    given.clear();
  };
  return (level) => {
    if (level === null) {
      given.clear();
      give();
      return true;
    }
    const follow = cuts.every((drawn) => followsLevel(drawn.level, level));
    cuts.push(cutOf(level));
    give();
    map.off("render", landed);
    map.on("render", landed);
    return follow;
  };
}

/**
 * The longest the ribbons stay hidden as the ground changes. Settling takes
 * a few frames, well under a second on a GPU; in software WebGL a frame of
 * the relief takes seconds, and waiting for every tile would leave the
 * flights off the map for a minute. Past this they show on whatever ground
 * has landed.
 */
const SETTLE_MAX_MS = 3000;

/**
 * What hides the ribbons, the replay's trail too, until the map has drawn
 * them cut on their new ground and the relief under them, or for
 * SETTLE_MAX_MS at most: the tiles of a `setData` land one by one, and the
 * elevation tiles after the relief is switched, so for a while some ribbons
 * would stand on the ground of the other view. Asked after every frame,
 * since the relief asks for its tiles as it is drawn; not on `idle`, which
 * waits for the base map and its labels as well.
 */
function settleRibbons(app: MapApp, map: MapLibreMap): () => void {
  const trail = MAP_SOURCES.replayTrailRibbons;
  const trailOpacity = map.getPaintProperty(
    trail,
    "fill-extrusion-opacity",
  ) as number;
  const show = (shown: number): void => {
    app.layerManager.ribbonsShown = shown;
    app.layerManager.restyle();
    map.setPaintProperty(
      trail,
      "fill-extrusion-opacity",
      shown ? trailOpacity : 0,
    );
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const done = (): void => {
    clearTimeout(timer);
    map.off("render", settled);
    show(1);
  };
  const settled = (): void => {
    const loading = [...RIBBON_LAYERS, MAP_SOURCES.terrain].some(
      (id) => map.getSource(id) && !map.isSourceLoaded(id),
    );
    if (!loading) done();
  };
  return () => {
    if (app.layerManager.ribbonsShown) map.on("render", settled);
    // Another change of the ground starts the wait anew
    clearTimeout(timer);
    timer = setTimeout(done, SETTLE_MAX_MS);
    show(0);
  };
}
