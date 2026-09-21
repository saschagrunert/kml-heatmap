/**
 * The layer handles, on the mock app every ported suite builds on.
 */
import { describe, it, expect, afterEach } from "vitest";
import { AIRPORTS_HIDDEN_CLASS } from "../../../kml_heatmap/frontend/mapLayers";
import {
  HEATMAP_BANDS,
  HEATMAP_LAYER_IDS,
  MAP_LAYERS,
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

  it("draw the heat source with one layer per level of detail, below the paths", () => {
    const app = createMockApp();
    const map = app.map!;

    // The full detail first: the e2e driver reads the heatmap off `ids[0]`
    expect(app.heatmapLayer.ids).toEqual(HEATMAP_LAYER_IDS);
    expect(app.heatmapLayer.ids[0]).toBe(MAP_LAYERS.heat);
    for (const band of HEATMAP_BANDS) {
      const layer = map.layer(band.layer);
      expect(layer.type).toBe("heatmap");
      expect(layer.source).toBe(MAP_SOURCES.heat);
      expect(layer.minzoom).toBe(band.minzoom);
      expect(layer.maxzoom).toBe(band.maxzoom);
      expect(layer.filter).toEqual(["==", ["get", "detail"], band.detail]);
    }

    const order = map.getLayersOrder();
    const heat = HEATMAP_LAYER_IDS.map((id) => order.indexOf(id));
    // One block, where the single heat layer was
    expect(heat).toEqual(heat.map((_, i) => heat[0]! + i));
    expect(order[heat[0]! - 1]).toBe(MAP_LAYERS.aviation);
    expect(order[heat[heat.length - 1]! + 1]).toBe(MAP_LAYERS.replayRoute);
    expect(Math.max(...heat)).toBeLessThan(
      order.indexOf(MAP_LAYERS.pathsAltitude),
    );
  });

  it("switch every level of detail of the heatmap together", () => {
    const app = createMockApp();
    const map = app.map!;
    const visibilities = (): unknown[] =>
      HEATMAP_LAYER_IDS.map((id) => map.layer(id).layout["visibility"]);

    app.heatmapLayer.setVisible(true);

    expect(app.heatmapLayer.isVisible()).toBe(true);
    expect(visibilities()).toEqual(HEATMAP_LAYER_IDS.map(() => "visible"));
    expect(map.layer(MAP_LAYERS.pathsAltitude).layout["visibility"]).toBe(
      "none",
    );

    app.heatmapLayer.setVisible(false);

    expect(app.heatmapLayer.isVisible()).toBe(false);
    expect(visibilities()).toEqual(HEATMAP_LAYER_IDS.map(() => "none"));
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
