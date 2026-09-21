/**
 * The layer handles, on the mock app every ported suite builds on.
 */
import { describe, it, expect, afterEach } from "vitest";
import { AIRPORTS_HIDDEN_CLASS } from "../../../kml_heatmap/frontend/mapLayers";
import { HEATMAP_RADIUS_PX } from "../../../kml_heatmap/frontend/ui/dataManager";
import {
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
    expect(app.heatmapLayer.ids).toEqual([MAP_LAYERS.heat]);
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
    expect(order[heat + 1]).toBe(MAP_LAYERS.replayRoute);
    expect(heat).toBeLessThan(order.indexOf(MAP_LAYERS.pathsAltitude));
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

  it("only remember the wish on an app without a map", () => {
    const app = createMockApp({ map: null });

    app.heatmapLayer.setVisible(true);

    expect(app.heatmapLayer.isVisible()).toBe(true);
  });
});
