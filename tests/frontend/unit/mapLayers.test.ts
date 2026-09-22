/**
 * The layer handles, on the mock app every ported suite builds on.
 */
import { describe, it, expect, afterEach } from "vitest";
import type { StyleSpecification } from "maplibre-gl";
import {
  AIRPORTS_HIDDEN_CLASS,
  withDataLayers,
} from "../../../kml_heatmap/frontend/mapLayers";
import { HEATMAP_RADIUS_PX } from "../../../kml_heatmap/frontend/ui/dataManager";
import {
  HEAT_LINES,
  HEATMAP_CLUSTER,
  MAP_LAYERS,
  MAP_MIN_ZOOM,
  MAP_SOURCES,
} from "../../../kml_heatmap/frontend/utils/constants";
import { createMockApp } from "../testHelpers";
import { resetMapLibreMock } from "../../mocks/maplibre-gl";

describe("layer handles", () => {
  afterEach(() => {
    resetMapLibreMock();
  });

  it("start on a map that has every source and layer, all hidden", async () => {
    const app = createMockApp();
    const map = app.map!;

    expect(Object.keys(map.sources).sort()).toEqual(
      Object.values(MAP_SOURCES).sort(),
    );
    for (const id of Object.values(MAP_LAYERS)) {
      expect(map.getLayer(id)).toBeDefined();
    }
    for (const id of [...app.heatmapLayer.ids, ...app.altitudeLayer.ids]) {
      expect(map.layer(id).layout["visibility"]).toBe("none");
    }
    await expect(app.mapReady).resolves.toBe(map);
  });

  it("switch every layer they own and nothing else", () => {
    const app = createMockApp();
    const map = app.map!;

    app.altitudeLayer.setVisible(true);

    expect(app.altitudeLayer.isVisible()).toBe(true);
    expect(map.layer(MAP_LAYERS.pathsAltitude).layout["visibility"]).toBe(
      "visible",
    );
    expect(
      map.layer(MAP_LAYERS.pathsAltitudeSelected).layout["visibility"],
    ).toBe("visible");
    expect(map.layer(MAP_LAYERS.pathsAirspeed).layout["visibility"]).toBe(
      "none",
    );

    app.altitudeLayer.setVisible(false);

    expect(map.layer(MAP_LAYERS.pathsAltitude).layout["visibility"]).toBe(
      "none",
    );
    expect(app.altitudeLayer.setVisible).toHaveBeenCalledTimes(2);
  });

  it("draw the heat source, which clusters the fixes, with one layer below the paths", () => {
    const app = createMockApp();
    const map = app.map!;

    // The e2e driver reads the heatmap off `ids[0]`
    expect(app.heatmapLayer.ids).toEqual([
      MAP_LAYERS.heat,
      MAP_LAYERS.heatLinesGlow,
      MAP_LAYERS.heatLinesCore,
    ]);
    expect(map.source(MAP_SOURCES.heat).spec).toMatchObject({
      type: "geojson",
      cluster: true,
      clusterRadius: HEATMAP_CLUSTER.radius,
      clusterMaxZoom: HEATMAP_CLUSTER.maxZoom,
    });
    const layer = map.layer(MAP_LAYERS.heat);
    expect(layer.type).toBe("heatmap");
    expect(layer.source).toBe(MAP_SOURCES.heat);
    // One layer for every zoom: a second one could not show the tiles of
    // the level before while its own still load
    expect(layer.minzoom).toBeUndefined();
    expect(layer.maxzoom).toBeUndefined();
    expect(layer.filter).toBeUndefined();

    const order = map.getLayersOrder();
    const heat = order.indexOf(MAP_LAYERS.heat);
    expect(order[heat - 1]).toBe(MAP_LAYERS.aviation);
    expect(order[heat + 1]).toBe(MAP_LAYERS.heatLinesGlow);
    expect(heat).toBeLessThan(order.indexOf(MAP_LAYERS.pathsAltitude));
  });

  it("draw the heat lines as a glow and a core over it, from where the heatmap fades", () => {
    const app = createMockApp();
    const map = app.map!;

    expect(map.source(MAP_SOURCES.heatLines).spec).toMatchObject({
      type: "geojson",
      tolerance: 0.25,
      maxzoom: 14,
    });
    for (const id of [MAP_LAYERS.heatLinesGlow, MAP_LAYERS.heatLinesCore]) {
      const layer = map.layer(id);
      expect(layer.type).toBe("line");
      expect(layer.source).toBe(MAP_SOURCES.heatLines);
      expect(layer.minzoom).toBe(HEAT_LINES.fromZoom);
      expect(layer.layout["visibility"]).toBe("none");
    }
    expect(HEAT_LINES.fullZoom).toBeGreaterThan(HEAT_LINES.fromZoom);

    const order = map.getLayersOrder();
    expect(order.indexOf(MAP_LAYERS.heatLinesCore)).toBe(
      order.indexOf(MAP_LAYERS.heatLinesGlow) + 1,
    );
    expect(order[order.indexOf(MAP_LAYERS.heatLinesCore) + 1]).toBe(
      MAP_LAYERS.replayRoute,
    );
  });

  it("switch the heat lines with the heatmap", () => {
    const app = createMockApp();
    const map = app.map!;

    app.heatmapLayer.setVisible(true);
    for (const id of [MAP_LAYERS.heatLinesGlow, MAP_LAYERS.heatLinesCore]) {
      expect(map.layer(id).layout["visibility"]).toBe("visible");
    }

    app.heatmapLayer.setVisible(false);
    for (const id of [MAP_LAYERS.heatLinesGlow, MAP_LAYERS.heatLinesCore]) {
      expect(map.layer(id).layout["visibility"]).toBe("none");
    }
  });

  it("keep the clusters finer than the reach of a point", () => {
    // A cluster radius near the reach of a point turns tracks into beads
    expect(HEATMAP_CLUSTER.radius).toBeGreaterThan(0);
    expect(HEATMAP_CLUSTER.radius * 2).toBeLessThan(HEATMAP_RADIUS_PX);
    expect(HEATMAP_CLUSTER.maxZoom).toBeGreaterThanOrEqual(MAP_MIN_ZOOM);
  });

  it("switch the heatmap on and off, and nothing else", () => {
    const app = createMockApp();
    const map = app.map!;
    const visibility = (): unknown =>
      map.layer(MAP_LAYERS.heat).layout["visibility"];

    app.heatmapLayer.setVisible(true);

    expect(app.heatmapLayer.isVisible()).toBe(true);
    expect(visibility()).toBe("visible");
    expect(map.layer(MAP_LAYERS.pathsAltitude).layout["visibility"]).toBe(
      "none",
    );

    app.heatmapLayer.setVisible(false);

    expect(app.heatmapLayer.isVisible()).toBe(false);
    expect(visibility()).toBe("none");
  });

  it("hide the airport markers through a class on the map container", () => {
    const app = createMockApp();
    const container = app.map!.getContainer();

    expect(container.classList.contains(AIRPORTS_HIDDEN_CLASS)).toBe(false);

    app.airportLayer.setVisible(false);
    expect(container.classList.contains(AIRPORTS_HIDDEN_CLASS)).toBe(true);

    app.airportLayer.setVisible(true);
    expect(container.classList.contains(AIRPORTS_HIDDEN_CLASS)).toBe(false);
  });

  it("switch the airport labels, a layer of the map, with their markers", () => {
    const app = createMockApp();
    const map = app.map!;
    const visibility = (): unknown =>
      map.layer(MAP_LAYERS.airportLabels).layout["visibility"];

    // On by default, like the markers
    expect(visibility()).toBe("visible");

    app.airportLayer.setVisible(false);
    expect(visibility()).toBe("none");

    app.airportLayer.setVisible(true);
    expect(visibility()).toBe("visible");
  });

  it("put the airport labels on top of every layer, labels of the style included", () => {
    const app = createMockApp();
    const order = app.map!.getLayersOrder();

    expect(order.at(-1)).toBe(MAP_LAYERS.airportLabels);
    expect(app.map!.layer(MAP_LAYERS.airportLabels).type).toBe("symbol");
  });

  it("only remember the wish on an app without a map", () => {
    const app = createMockApp({ map: null });

    app.heatmapLayer.setVisible(true);

    expect(app.heatmapLayer.isVisible()).toBe(true);
  });
});

describe("withDataLayers", () => {
  const heat = { type: "geojson", data: "fixes", cluster: true } as const;
  const previous: StyleSpecification = {
    version: 8,
    sources: { [MAP_SOURCES.heat]: heat },
    layers: [
      { id: "background", type: "background" },
      { id: MAP_LAYERS.heat, type: "heatmap", source: MAP_SOURCES.heat },
      { id: MAP_LAYERS.replayTrail, type: "line", source: MAP_SOURCES.heat },
    ],
  };

  it("leaves a style alone that has none before it", () => {
    const next: StyleSpecification = { version: 8, sources: {}, layers: [] };

    expect(withDataLayers(undefined, next)).toBe(next);
  });

  it("goes on top of a style without labels, and leaves the old base behind", () => {
    const next: StyleSpecification = {
      version: 8,
      glyphs: "https://example.test/{fontstack}/{range}.pbf",
      sources: { base: { type: "raster", tiles: [] } },
      layers: [{ id: "base", type: "raster", source: "base" }],
    };

    const style = withDataLayers(previous, next);

    expect(style.layers.map((layer) => layer.id)).toEqual([
      "base",
      MAP_LAYERS.heat,
      MAP_LAYERS.replayTrail,
    ]);
    expect(style.sources).toEqual({
      base: next.sources["base"],
      [MAP_SOURCES.heat]: heat,
    });
    // The source as it was, not a copy the map would take for a new one
    expect(style.sources[MAP_SOURCES.heat]).toBe(heat);
    expect(style.glyphs).toBe(next.glyphs);
    expect(next.layers).toHaveLength(1);
    expect(style.projection).toBeUndefined();
  });

  it("keeps the airport labels on top of the new style's labels", () => {
    const next: StyleSpecification = {
      version: 8,
      sources: { places: { type: "geojson", data: "places" } },
      layers: [
        { id: "base", type: "background" },
        { id: "place-labels", type: "symbol", source: "places" },
      ],
    };
    const labelled: StyleSpecification = {
      ...previous,
      layers: [
        ...previous.layers,
        {
          id: MAP_LAYERS.airportLabels,
          type: "symbol",
          source: MAP_SOURCES.heat,
        },
      ],
    };

    const style = withDataLayers(labelled, next);

    expect(style.layers.map((layer) => layer.id)).toEqual([
      "base",
      MAP_LAYERS.heat,
      MAP_LAYERS.replayTrail,
      "place-labels",
      MAP_LAYERS.airportLabels,
    ]);
  });

  it("keeps the globe chosen before the base style arrived", () => {
    const next: StyleSpecification = { version: 8, sources: {}, layers: [] };

    const style = withDataLayers(
      { ...previous, projection: { type: "globe" } },
      next,
    );

    expect(style.projection).toEqual({ type: "globe" });
  });
});
