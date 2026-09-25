/**
 * The layers of the map
 * Everything the app draws on the map lives in a fixed set of sources and
 * layers that are created once, empty, when the style has loaded. This
 * module creates them and provides the handles that show and hide them.
 */
import type {
  FillExtrusionLayerSpecification,
  Map as MapLibreMap,
  StyleSpecification,
} from "maplibre-gl";
import { ribbonHeights } from "./calculations/ribbonPaint";
import { PATH_RIBBON_SOURCES } from "./ui/reliefState";
import {
  cssVar,
  firstSymbolLayerId,
  whenContextRestored,
  withoutValidation,
} from "./utils/mapHelpers";
import {
  HEAT_LINES,
  HEATMAP_CLUSTER,
  MAP_LAYERS,
  MAP_SOURCES,
} from "./utils/constants";
import type { LayerHandle } from "./types";
import { addAirportLabelImages, airportLabelLayer } from "./ui/airportLabels";

/**
 * Aeronautical overlay of open flightmaps: airspaces, airfields, navaids and
 * reporting points on transparent tiles. `latest` follows the current AIRAC
 * cycle, so the URL needs no upkeep, and the tiles need no API key.
 */
const AVIATION_TILE_URL =
  "https://nwy-tiles-api.prod.newaydata.com/tiles/{z}/{x}/{y}.png?path=latest/aero/latest";
/**
 * The zoom levels the overlay is rendered for, as the `z` of its tile URLs;
 * above them it is upscaled. These are tile levels, not map zooms: a 256
 * pixel tile of level z is shown at map zoom z - 1.
 */
const AVIATION_TILE_MIN_ZOOM = 7;
const AVIATION_TILE_MAX_ZOOM = 12;
/** Map zoom the overlay appears at: where its lowest tile level is shown */
const AVIATION_MIN_ZOOM = AVIATION_TILE_MIN_ZOOM - 1;
/**
 * Two levels of upscaling (16 times the area) still read as a chart. Beyond
 * that the overlay is a blur over the base map, so the layer ends instead of
 * stretching a tile up to the map's own limit. Map units; the last zoom the
 * overlay is still shown at.
 */
const AVIATION_MAX_ZOOM = AVIATION_TILE_MAX_ZOOM - 1 + 2;
/** A layer's `maxzoom` is exclusive, and the map zooms in fractions */
const AVIATION_LAYER_MAX_ZOOM = AVIATION_MAX_ZOOM + 0.01;

/** Line widths and opacities of the data layers as they are created */
const PATH_LINE = { width: 4, opacity: 0.85 };
const SELECTED_PATH_LINE = { width: 6, opacity: 1 };
const REPLAY_ROUTE_LINE = { width: 2, opacity: 0.5 };
const REPLAY_TRAIL_LINE = { width: 3, opacity: 0.8 };
const SELECTION_LINE = { width: 1.5, opacity: 0.9 };

/** Class on the map container that hides every airport marker */
export const AIRPORTS_HIDDEN_CLASS = "airports-hidden";

/**
 * Handle of one or more map layers. It owns the `visibility` of its layers:
 * nothing else may set that property on them, or the handle's answer and the
 * map drift apart. Until `attach` the wish is only remembered, which is what
 * lets restored state and early clicks set it before the style has loaded.
 */
export class MapLayerHandle implements LayerHandle {
  protected map: MapLibreMap | null = null;
  private visible: boolean;

  constructor(
    readonly ids: readonly string[],
    visible = false,
  ) {
    this.visible = visible;
  }

  /**
   * Called once the layers exist; applies what was asked for until then.
   * A style restored after a lost WebGL context has the visibility of the
   * moment of the loss, and a switch in between found no layer to set.
   */
  attach(map: MapLibreMap): void {
    this.map = map;
    this.apply();
    whenContextRestored(map, () => this.apply());
  }

  isVisible(): boolean {
    return this.visible;
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.apply();
  }

  protected apply(): void {
    const map = this.map;
    if (!map) return;
    const value = this.visible ? "visible" : "none";
    for (const id of this.ids) {
      if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", value);
    }
  }
}

/**
 * Handle of the airport markers and their labels. The markers are DOM, not
 * a map layer, so hiding them is a class on the map container that the
 * stylesheet acts on; every marker follows at once and none has to be
 * removed and added again. The labels are a layer of the map.
 */
export class AirportLayerHandle extends MapLayerHandle {
  constructor(visible = true) {
    super([MAP_LAYERS.airportLabels], visible);
  }

  protected override apply(): void {
    super.apply();
    this.map
      ?.getContainer()
      .classList.toggle(AIRPORTS_HIDDEN_CLASS, !this.isVisible());
  }
}

/**
 * A source of lifted flights, which the 3D view draws as ribbons at their
 * height (see calculations/lift.ts), and its layer. The source is not
 * simplified: a ribbon is a few pixels across, and its quads would be
 * dropped from the far tiles of a tilted view, whose walls still show. The
 * colour layers' quads are 24 px long at most (see QUAD_SPLIT_PX), so
 * their tiles take a buffer of 32 px rather than 128, which the map's
 * worker holds a copy of every feature in for every tile it reaches into:
 * MapLibre lifts a polygon by the relief at its centroid, and a quad cut
 * at a tile's edge would stand on other relief in either tile. A ribbon is known to the map by the id of its
 * cut where its exaggeration is switched by it (see ribbonId). The layer's
 * opacity is the owner's business: the layer manager dims it for a
 * selection, as it does the lines.
 */
function addRibbons(
  map: MapLibreMap,
  id: string,
  layout: { visibility?: "none" },
  opacity: number | undefined,
  before: string | undefined,
): void {
  map.addSource(id, {
    type: "geojson",
    data: emptyGeoJson(),
    tolerance: 0,
    ...(id !== MAP_SOURCES.replayTrailRibbons && { buffer: 32 }),
    maxzoom: 14,
    promoteId: "k",
  });
  map.addLayer(ribbonLayer(id, layout, opacity), before);
}

function ribbonLayer(
  id: string,
  layout: { visibility?: "none" },
  opacity: number | undefined,
): FillExtrusionLayerSpecification {
  const { base, height } = ribbonHeights();
  return {
    id,
    type: "fill-extrusion",
    source: id,
    layout,
    paint: {
      ...(opacity !== undefined && { "fill-extrusion-opacity": opacity }),
      "fill-extrusion-color": ["get", "color"],
      "fill-extrusion-base": base,
      "fill-extrusion-height": height,
    },
  };
}

/** An empty GeoJSON source, the state every data source is created in */
function emptyGeoJson(): GeoJSON.FeatureCollection {
  return { type: "FeatureCollection", features: [] };
}

/**
 * Create every source and layer the app draws on, empty, in drawing
 * order. They are inserted below the first label layer of the style, so
 * place names stay readable over the flights; the style the map starts on
 * has none, and `withDataLayers` does the same for the one that follows.
 * Doing it once and here keeps the order in one place; the modules that own
 * the content only ever call `setData` and set paint properties.
 */
export function addDataLayers(map: MapLibreMap): void {
  withoutValidation(map, () => addDataLayersTo(map));
}

function addDataLayersTo(map: MapLibreMap): void {
  const before = firstSymbolLayerId(map);
  const hidden = { visibility: "none" } as const;
  const round = { "line-cap": "round", "line-join": "round" } as const;

  map.addSource(MAP_SOURCES.aviation, {
    type: "raster",
    tiles: [AVIATION_TILE_URL],
    tileSize: 256,
    minzoom: AVIATION_TILE_MIN_ZOOM,
    maxzoom: AVIATION_TILE_MAX_ZOOM,
    attribution:
      '&copy; <a href="https://www.openflightmaps.org">open flightmaps</a>',
  });
  map.addLayer(
    {
      id: MAP_LAYERS.aviation,
      type: "raster",
      source: MAP_SOURCES.aviation,
      minzoom: AVIATION_MIN_ZOOM,
      maxzoom: AVIATION_LAYER_MAX_ZOOM,
      layout: hidden,
    },
    before,
  );

  // The look of the heatmap (radius, intensity, colours) belongs to the
  // data manager, which sets it as paint properties. The source merges the
  // fixes into clusters for the zooms at which they are too many to draw
  // one by one (see HEATMAP_CLUSTER). Isolate draws the selected flights
  // from a source of their own, so neither is written again for it.
  for (const id of [MAP_LAYERS.heat, MAP_LAYERS.heatIsolated]) {
    map.addSource(id, {
      type: "geojson",
      data: emptyGeoJson(),
      cluster: true,
      clusterRadius: HEATMAP_CLUSTER.radius,
      clusterMaxZoom: HEATMAP_CLUSTER.maxZoom,
    });
    map.addLayer({ id, type: "heatmap", source: id, layout: hidden }, before);
  }

  // What the heatmap hands over to when zoomed in (see HEAT_LINES): the
  // flights as lines with the time spent around them as `heat`, drawn as a
  // glow and a core. Their look belongs to the data manager, like the
  // heatmap's. Below `fromZoom` they are fully transparent, and the minimum
  // zoom spares the map their tiles there. The hotter lines are drawn last,
  // so a busy taxiway is not painted over by a flight that crossed it once.
  // A flight is a line per step of heat, end to end: round caps overlapped
  // where one ends and the next begins, and the lines being translucent,
  // every change of heat was a brighter bead. Cut square they meet edge to
  // edge, and the curve they run along bends too little at a point for a
  // gap to show (see calculations/curves.ts).
  map.addSource(MAP_SOURCES.heatLines, {
    type: "geojson",
    data: emptyGeoJson(),
    tolerance: 0.25,
    maxzoom: 14,
  });
  for (const id of [MAP_LAYERS.heatLinesGlow, MAP_LAYERS.heatLinesCore]) {
    map.addLayer(
      {
        id,
        type: "line",
        source: MAP_SOURCES.heatLines,
        minzoom: HEAT_LINES.fromZoom,
        layout: {
          ...round,
          ...hidden,
          "line-cap": "butt",
          "line-sort-key": ["get", "heat"],
        },
      },
      before,
    );
  }

  // Two lines of one colour, each from a source of its own named like it.
  // The selected flights over the heatmap while no colour layer draws them
  // (see ui/selectionHighlight.ts): thin and light, so they read over the
  // heatmap, which steps back for them, and are not taken for a colour
  // layer; flat and as wide at every zoom. And the route of a replay, which
  // is always visible and empty outside one
  for (const [id, color, fallback, line, layout] of [
    [
      MAP_LAYERS.selectionHighlight,
      "--selection-highlight-color",
      "#f2f2f2",
      SELECTION_LINE,
      { ...round, ...hidden },
    ],
    [
      MAP_LAYERS.replayRoute,
      "--color-text-dim",
      "#8c8c8c",
      REPLAY_ROUTE_LINE,
      round,
    ],
  ] as const) {
    map.addSource(id, { type: "geojson", data: emptyGeoJson() });
    map.addLayer(
      {
        id,
        type: "line",
        source: id,
        layout,
        paint: {
          "line-color": cssVar(color) || fallback,
          "line-width": line.width,
          "line-opacity": line.opacity,
        },
      },
      before,
    );
  }

  // Main layers first, then both selections, so a selected flight is
  // never painted over by an unselected one of the other mode
  const pathLayers = [
    [MAP_LAYERS.pathsAltitude, MAP_SOURCES.pathsAltitude, PATH_LINE],
    [MAP_LAYERS.pathsAirspeed, MAP_SOURCES.pathsAirspeed, PATH_LINE],
    [
      MAP_LAYERS.pathsAltitudeSelected,
      MAP_SOURCES.pathsAltitudeSelected,
      SELECTED_PATH_LINE,
    ],
    [
      MAP_LAYERS.pathsAirspeedSelected,
      MAP_SOURCES.pathsAirspeedSelected,
      SELECTED_PATH_LINE,
    ],
  ] as const;
  for (const [id, source, line] of pathLayers) {
    map.addSource(source, {
      type: "geojson",
      data: emptyGeoJson(),
      // A quarter of a pixel, which is what the app simplified to itself
      // under Leaflet; above 14 the tiles are overzoomed, not cut again
      tolerance: 0.25,
      maxzoom: 14,
    });
    map.addLayer(
      {
        id,
        type: "line",
        source,
        layout: { ...round, ...hidden },
        paint: {
          "line-color": ["get", "color"],
          "line-width": line.width,
          "line-opacity": line.opacity,
        },
      },
      before,
    );
  }
  // The replay's trail over the flights, and below every ribbon: on the
  // relief MapLibre draws the layers that lie on the ground into a texture
  // of the relief, in one pass as long as no other layer comes between
  // them, and the relief once more for every other run of them. The 3D
  // view draws the ribbons and the heat cloud (ui/heatCloud.ts) above them
  // all in any case.
  map.addSource(MAP_SOURCES.replayTrail, {
    type: "geojson",
    data: emptyGeoJson(),
  });
  map.addLayer(
    {
      id: MAP_LAYERS.replayTrail,
      type: "line",
      source: MAP_SOURCES.replayTrail,
      layout: round,
      paint: {
        "line-color": ["get", "color"],
        "line-width": REPLAY_TRAIL_LINE.width,
        "line-opacity": REPLAY_TRAIL_LINE.opacity,
      },
    },
    before,
  );
  for (const id of PATH_RIBBON_SOURCES) {
    addRibbons(map, id, hidden, undefined, before);
  }

  // In the 3D view the trail is written here instead (see ReplayRenderer)
  addRibbons(
    map,
    MAP_SOURCES.replayTrailRibbons,
    {},
    REPLAY_TRAIL_LINE.opacity,
    before,
  );

  // The airport codes: labels, so on top of every layer, the base style's
  // own labels included (see ui/airportLabels.ts)
  map.addSource(MAP_SOURCES.airportLabels, {
    type: "geojson",
    data: emptyGeoJson(),
    // The hover state is set by the airport's name
    promoteId: "name",
  });
  addAirportLabelImages(map);
  map.addLayer(airportLabelLayer());
}

/**
 * A base style with the app's sources and layers of the style before it:
 * what `setStyle` takes as `transformStyle`, which would otherwise drop
 * them. They are carried over as the map reports them, with their data,
 * filters, visibility and paint, in their order, and below the first label
 * layer of the new style, where `addDataLayers` would have put them; the
 * airport labels go on top of all. The projection comes along too: it
 * lives in the style, and a globe chosen before the base style arrived
 * would otherwise turn back into Mercator; and so does the relief of the
 * 3D view (ui/terrain.ts), which would otherwise go while the flights stay
 * cut for it.
 *
 * `diffed` leaves the data of the GeoJSON sources out, for a style the map
 * applies as the difference to the one before (see setBaseStyle).
 */
export function withDataLayers(
  previous: StyleSpecification | undefined,
  next: StyleSpecification,
  diffed = false,
): StyleSpecification {
  if (!previous) return next;
  const sources = { ...next.sources };
  for (const id of Object.values(MAP_SOURCES)) {
    let source = previous.sources[id];
    if (diffed && source?.type === "geojson") {
      // In the style before as well, so the two are equal
      source = previous.sources[id] = { ...source, data: emptyGeoJson() };
    }
    if (source) sources[id] = source;
  }
  const ids: readonly string[] = Object.values(MAP_LAYERS);
  const own = previous.layers.filter((layer) => ids.includes(layer.id));
  const onTop = own.filter((layer) => layer.id === MAP_LAYERS.airportLabels);
  const below = own.filter((layer) => layer.id !== MAP_LAYERS.airportLabels);
  const labels = next.layers.findIndex((layer) => layer.type === "symbol");
  const layers = [...next.layers];
  layers.splice(labels < 0 ? layers.length : labels, 0, ...below);
  layers.push(...onTop);
  const projection = previous.projection ?? next.projection;
  // The sky of a tilted map: the base style has none of its own
  const sky = next.sky ?? previous.sky;
  const terrain = previous.terrain;
  return {
    ...next,
    sources,
    layers,
    ...(projection && { projection }),
    ...(sky && { sky }),
    ...(terrain && { terrain }),
  };
}

/**
 * Put a base style under the app's sources and layers (see withDataLayers).
 * The map applies the difference to the style on it, which leaves the
 * app's sources alone, with their data and their tiles; so the data is left
 * out of both. Otherwise the map validates the style it is given, copies
 * it, compares it with the one before and keeps the copy for as long as it
 * is on: for all the flights of every year that took a second and 140 MB.
 * Where the map cannot apply the difference it builds the style anew, a
 * frame later, from no style it has loaded, and the sources are made anew
 * from the style: with their data. Neither the style nor the layers the
 * difference adds are validated (see withoutValidation).
 */
export function setBaseStyle(
  map: MapLibreMap,
  style: StyleSpecification,
): void {
  withoutValidation(map, () =>
    map.setStyle(style, {
      validate: false,
      transformStyle: (previous, next) =>
        withDataLayers(previous, next, !!map.getStyle()),
    }),
  );
}
