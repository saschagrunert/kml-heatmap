/**
 * The layers of the map
 * Everything the app draws on the map lives in a fixed set of sources and
 * layers that are created once, empty, when the style has loaded. This
 * module creates them and provides the handles that show and hide them.
 */
import type { Map as MapLibreMap, StyleSpecification } from "maplibre-gl";
import { cssVar, firstSymbolLayerId } from "./utils/mapHelpers";
import { HEATMAP_CLUSTER, MAP_LAYERS, MAP_SOURCES } from "./utils/constants";
import type { LayerHandle } from "./types";

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

  /** Called once the layers exist; applies what was asked for until then */
  attach(map: MapLibreMap): void {
    this.map = map;
    this.apply();
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
 * Handle of the airport markers. They are DOM, not a map layer, so hiding
 * them is a class on the map container that the stylesheet acts on; every
 * marker follows at once and none has to be removed and added again.
 */
export class AirportLayerHandle extends MapLayerHandle {
  constructor(visible = true) {
    super([], visible);
  }

  protected override apply(): void {
    this.map
      ?.getContainer()
      .classList.toggle(AIRPORTS_HIDDEN_CLASS, !this.isVisible());
  }
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
  // one by one (see HEATMAP_CLUSTER)
  map.addSource(MAP_SOURCES.heat, {
    type: "geojson",
    data: emptyGeoJson(),
    cluster: true,
    clusterRadius: HEATMAP_CLUSTER.radius,
    clusterMaxZoom: HEATMAP_CLUSTER.maxZoom,
  });
  map.addLayer(
    {
      id: MAP_LAYERS.heat,
      type: "heatmap",
      source: MAP_SOURCES.heat,
      layout: hidden,
    },
    before,
  );

  // The replay layers are always visible and empty outside a replay
  map.addSource(MAP_SOURCES.replayRoute, {
    type: "geojson",
    data: emptyGeoJson(),
  });
  map.addLayer(
    {
      id: MAP_LAYERS.replayRoute,
      type: "line",
      source: MAP_SOURCES.replayRoute,
      layout: round,
      paint: {
        "line-color": cssVar("--color-text-dim") || "#888888",
        "line-width": REPLAY_ROUTE_LINE.width,
        "line-opacity": REPLAY_ROUTE_LINE.opacity,
      },
    },
    before,
  );

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
}

/**
 * A base style with the app's sources and layers of the style before it:
 * what `setStyle` takes as `transformStyle`, which would otherwise drop
 * them. They are carried over as the map reports them, with their data,
 * filters, visibility and paint, in their order, and below the first label
 * layer of the new style, where `addDataLayers` would have put them. The
 * projection comes along too: it lives in the style, and a globe chosen
 * before the base style arrived would otherwise turn back into Mercator.
 */
export function withDataLayers(
  previous: StyleSpecification | undefined,
  next: StyleSpecification,
): StyleSpecification {
  if (!previous) return next;
  const sources = { ...next.sources };
  for (const id of Object.values(MAP_SOURCES)) {
    const source = previous.sources[id];
    if (source) sources[id] = source;
  }
  const ids: readonly string[] = Object.values(MAP_LAYERS);
  const own = previous.layers.filter((layer) => ids.includes(layer.id));
  const labels = next.layers.findIndex((layer) => layer.type === "symbol");
  const layers = [...next.layers];
  layers.splice(labels < 0 ? layers.length : labels, 0, ...own);
  const projection = previous.projection ?? next.projection;
  return { ...next, sources, layers, ...(projection && { projection }) };
}
