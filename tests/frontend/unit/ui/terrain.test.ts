/**
 * The relief under the 3D view: the map following terrainActive,
 * reliefLevel and reliefShaded, the shading's place in the base map, and
 * the ribbons hidden while they settle on another ground.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Map as MapLibreMap, StyleSpecification } from "maplibre-gl";
import {
  followTerrain,
  HILLSHADE_LAYER,
} from "../../../../kml_heatmap/frontend/ui/terrain";
import {
  followSatellite,
  SATELLITE_LAYER,
} from "../../../../kml_heatmap/frontend/ui/satellite";
import { setBaseStyle } from "../../../../kml_heatmap/frontend/mapLayers";
import { liftExaggeration } from "../../../../kml_heatmap/frontend/calculations/lift";
import {
  MAP_LAYERS,
  MAP_SOURCES,
} from "../../../../kml_heatmap/frontend/utils/constants";
import { REPLAY_CAMERA_MOVE } from "../../../../kml_heatmap/frontend/utils/mapHelpers";
import { asMapApp, createMockApp, type MockApp } from "../../testHelpers";
import { resetMapLibreMock } from "../../../mocks/maplibre-gl";

/**
 * A base style shaped like CARTO's dark matter: the ground (land cover, land
 * use, water) with borders among it, then the runways, roads, bridges and
 * buildings, which are area fills as well, then the labels
 */
const CARTO_LIKE: StyleSpecification = {
  version: 8,
  sources: { carto: { type: "vector", tiles: [] } },
  layers: [
    { id: "background", type: "background" },
    ...(
      [
        ["landcover", "fill", "landcover"],
        ["landuse", "fill", "landuse"],
        ["boundary_county", "line", "boundary"],
        ["water", "fill", "water"],
        ["aeroway-runway", "fill", "aeroway"],
        ["road_pri_fill", "line", "transportation"],
        ["bridge_mot_fill", "line", "transportation"],
        ["building", "fill", "building"],
        ["building-top", "fill", "building"],
        ["place_town", "symbol", "place"],
      ] as const
    ).map(([id, type, sourceLayer]) => ({
      id,
      type,
      source: "carto",
      "source-layer": sourceLayer,
    })),
  ] as StyleSpecification["layers"],
};

/** The trail's opacity as addDataLayers creates it */
const TRAIL_OPACITY = 0.8;

describe("the relief", () => {
  let app: MockApp;
  let lifetime: AbortController;

  const map = (): NonNullable<MockApp["map"]> => app.map!;
  const order = (): string[] => map().getLayersOrder();
  const trailOpacity = (): unknown =>
    map().getPaintProperty(
      MAP_SOURCES.replayTrailRibbons,
      "fill-extrusion-opacity",
    );

  /** Follow the store, once the map is ready */
  async function follow(): Promise<void> {
    followTerrain(asMapApp(app));
    await app.mapReady;
  }

  /** Swap the base style as MapApp does when CARTO's arrives */
  function swapBaseStyle(style: StyleSpecification): void {
    setBaseStyle(map() as unknown as MapLibreMap, style);
    map().emit("styledata");
  }

  beforeEach(() => {
    lifetime = new AbortController();
    app = createMockApp({ signal: lifetime.signal });
  });

  afterEach(() => {
    vi.useRealTimers();
    resetMapLibreMock();
  });

  describe("its shading", () => {
    it("lies right above the ground of the base map, below its runways, roads and buildings", async () => {
      swapBaseStyle(CARTO_LIKE);
      app.reliefShaded = true;

      await follow();

      const layers = order();
      expect(layers.indexOf(HILLSHADE_LAYER)).toBe(layers.indexOf("water") + 1);
      expect(layers[layers.indexOf(HILLSHADE_LAYER) + 1]).toBe(
        "aeroway-runway",
      );
      expect(layers.indexOf(HILLSHADE_LAYER)).toBeLessThan(
        layers.indexOf(MAP_LAYERS.aviation),
      );
    });

    it("lies right above the satellite imagery and the borders lifted over it, whichever comes first", async () => {
      const shadeOver = (): string[] => {
        const layers = order();
        const water = layers.indexOf("water");
        return layers.slice(water, water + 5);
      };
      const expected = [
        "water",
        SATELLITE_LAYER,
        "boundary_county",
        HILLSHADE_LAYER,
        "aeroway-runway",
      ];
      swapBaseStyle(CARTO_LIKE);
      app.satelliteVisible = true;
      followSatellite(asMapApp(app));
      app.reliefShaded = true;
      await follow();
      expect(shadeOver()).toEqual(expected);

      // The shading first, then the imagery
      resetMapLibreMock();
      app = createMockApp();
      swapBaseStyle(CARTO_LIKE);
      app.reliefShaded = true;
      await follow();
      app.satelliteVisible = true;
      followSatellite(asMapApp(app));
      await app.mapReady;
      expect(shadeOver()).toEqual(expected);
    });

    it("lies right above the background of the map's own style", async () => {
      app.reliefShaded = true;

      await follow();

      expect(order().slice(0, 3)).toEqual([
        "background",
        HILLSHADE_LAYER,
        MAP_LAYERS.aviation,
      ]);
    });

    it("goes back into a new base style, where it belongs in it", async () => {
      app.reliefShaded = true;
      await follow();

      swapBaseStyle(CARTO_LIKE);

      expect(order().indexOf(HILLSHADE_LAYER)).toBe(
        order().indexOf("water") + 1,
      );
      // Its elevation tiles are carried over, not made anew
      expect(map().source(MAP_SOURCES.terrain).spec).toMatchObject({
        type: "raster-dem",
      });
    });
  });

  describe("the ribbons as the ground changes", () => {
    it("hide, the trail's too, until the map has drawn them on the new ground", async () => {
      await follow();
      map().isSourceLoaded.mockReturnValue(false);

      app.terrainActive = true;

      expect(app.layerManager.ribbonsShown).toBe(0);
      expect(app.layerManager.restyle).toHaveBeenCalledTimes(1);
      expect(trailOpacity()).toBe(0);

      // Asked after every frame, until the tiles have landed
      map().emit("render");
      expect(app.layerManager.ribbonsShown).toBe(0);
      map().isSourceLoaded.mockReturnValue(true);
      map().emit("render");

      expect(app.layerManager.ribbonsShown).toBe(1);
      expect(app.layerManager.restyle).toHaveBeenCalledTimes(2);
      expect(trailOpacity()).toBe(TRAIL_OPACITY);
      expect(map().listenerCount("render")).toBe(0);
    });

    it("show on whatever ground has landed after a while, a change starting the wait anew", async () => {
      vi.useFakeTimers();
      await follow();
      map().isSourceLoaded.mockReturnValue(false);

      app.terrainActive = true;
      vi.advanceTimersByTime(2000);
      app.reliefLevel = 9;
      vi.advanceTimersByTime(2999);
      expect(app.layerManager.ribbonsShown).toBe(0);

      vi.advanceTimersByTime(1);
      expect(app.layerManager.ribbonsShown).toBe(1);
      expect(trailOpacity()).toBe(TRAIL_OPACITY);
      // Only the ribbons' exaggeration waits on, for them to land (see
      // exaggerateRibbons)
      expect(map().listenerCount("render")).toBe(1);
      map().isSourceLoaded.mockReturnValue(true);
      map().emit("render");
      expect(map().listenerCount("render")).toBe(0);
    });
  });

  it("is built anew after a lost WebGL context", async () => {
    app.reliefLevel = 11;
    app.terrainActive = true;
    await follow();
    map().setTerrain.mockClear();

    map().emit("webglcontextrestored");
    map().emit("style.load");

    expect(map().setTerrain.mock.calls).toEqual([
      [null],
      [{ source: MAP_SOURCES.terrain, exaggeration: liftExaggeration(11) }],
    ]);
  });

  it("has the markers follow the ground at the end of a move, not at every frame of the replay's camera", async () => {
    app.terrainActive = true;
    await follow();
    const terrainEvents = (): number =>
      map().fire.mock.calls.filter(([type]) => type === "terrain").length;

    map().emit("moveend", REPLAY_CAMERA_MOVE);
    expect(terrainEvents()).toBe(0);

    map().emit("moveend");
    expect(terrainEvents()).toBe(1);
  });

  it("stops following the map with the app", async () => {
    vi.useFakeTimers();
    app.terrainActive = true;
    app.reliefShaded = true;
    await follow();
    map().isSourceLoaded.mockReturnValue(false);
    app.reliefLevel = 9;
    map().setTerrain.mockClear();

    lifetime.abort();
    map().emit("moveend");
    swapBaseStyle(CARTO_LIKE);
    map().emit("webglcontextrestored");
    map().emit("style.load");
    vi.advanceTimersByTime(5000);

    expect(map().fire).not.toHaveBeenCalledWith("terrain");
    expect(map().getLayer(HILLSHADE_LAYER)).toBeUndefined();
    expect(map().setTerrain).not.toHaveBeenCalled();
    expect(map().listenerCount("render")).toBe(0);
    // Nothing shows the ribbons for a map the app has let go of
    expect(app.layerManager.ribbonsShown).toBe(0);
  });
});
