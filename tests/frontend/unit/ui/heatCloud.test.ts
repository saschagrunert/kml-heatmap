/**
 * The heat cloud of the 3D view: on the map while the 3D view is on, in
 * place of the flat heatmap, drawing what the heatmap would, at the
 * heights of the ribbons.
 */
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type MockInstance,
} from "vitest";
import type { StyleSpecification } from "maplibre-gl";
import { followHeatCloud } from "../../../../kml_heatmap/frontend/ui/heatCloud";
import {
  HEAT_CLOUD_LAYER,
  HeatCloudLayer,
  type HeatCloudStyle,
} from "../../../../kml_heatmap/frontend/ui/heatCloudLayer";
import {
  mercatorOf,
  type CloudPoints,
} from "../../../../kml_heatmap/frontend/calculations/heatCloud";
import { liftExaggeration } from "../../../../kml_heatmap/frontend/calculations/lift";
import {
  groundedFlights,
  heldGroundedFlights,
  levelGroundFt,
  releaseGroundProfiles,
} from "../../../../kml_heatmap/frontend/calculations/groundProfile";
import { setBaseStyle } from "../../../../kml_heatmap/frontend/mapLayers";
import {
  FEET_TO_METERS,
  MAP_LAYERS,
  MAP_SOURCES,
} from "../../../../kml_heatmap/frontend/utils/constants";
import type { PathSegment } from "../../../../kml_heatmap/frontend/types";
import {
  asMapApp,
  createDataset,
  createMockApp,
  type MockApp,
} from "../../testHelpers";
import { resetMapLibreMock } from "../../../mocks/maplibre-gl";
import type { Map as MapLibreMap } from "maplibre-gl";

const logger = vi.hoisted(() => ({ logError: vi.fn() }));
vi.mock("../../../../kml_heatmap/frontend/utils/logger", async (original) => ({
  ...(await original<object>()),
  logError: logger.logError,
}));

/** A flight of `path_id`: `count` fixes along the latitude `lat` */
function flight(path_id: number, lat: number, count = 6): PathSegment[] {
  return Array.from({ length: count - 1 }, (_, i) => ({
    path_id,
    coords: [
      [lat, 11 + i * 0.01],
      [lat, 11 + (i + 1) * 0.01],
    ],
    altitude_ft: 4000,
    groundspeed_knots: 100,
    time: i * 5,
  }));
}

/** Three flights: two of D-EAAA in 2025 and 2026, one of D-EBBB in 2026 */
const DATA = createDataset(
  [
    { id: 1, year: 2025, aircraft_registration: "D-EAAA" },
    { id: 2, year: 2026, aircraft_registration: "D-EAAA" },
    { id: 3, year: 2026, aircraft_registration: "D-EBBB" },
  ],
  [...flight(1, 47), ...flight(2, 48), ...flight(3, 49)],
);

/** The latitudes of the flights the points on the layer are of */
function latitudesOf(cloud: CloudPoints | null): number[] {
  if (!cloud) return [];
  const lats = new Set<number>();
  for (let k = 1; k <= cloud.count; k++) {
    const y = cloud.points[k * 5 + 1]! + cloud.origin[1];
    const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;
    lats.add(Math.round(lat));
  }
  return [...lats].sort();
}

describe("the heat cloud", () => {
  let app: MockApp;
  let lifetime: AbortController;
  let setPoints: MockInstance<HeatCloudLayer["setPoints"]>;

  const map = (): NonNullable<MockApp["map"]> => app.map!;
  const order = (): string[] => map().getLayersOrder();
  /** The layer the cloud put on the map, as it was handed to it */
  const layer = (): HeatCloudLayer => {
    const calls = map().addLayer.mock.calls.filter(
      ([spec]) => (spec as { id: string }).id === HEAT_CLOUD_LAYER,
    );
    return calls[calls.length - 1]![0] as unknown as HeatCloudLayer;
  };
  /** What the layer is asked to draw with in the next frame */
  const style = (): HeatCloudStyle | null =>
    (layer() as unknown as { style: () => HeatCloudStyle | null }).style();
  /** The points the layer draws, as it was last handed them */
  const drawn = (): CloudPoints | null => setPoints.mock.lastCall?.[0] ?? null;

  async function follow(): Promise<void> {
    followHeatCloud(asMapApp(app));
    await app.mapReady;
  }

  beforeEach(() => {
    lifetime = new AbortController();
    app = createMockApp({
      signal: lifetime.signal,
      currentData: DATA,
      heatmapVisible: true,
    });
    setPoints = vi.spyOn(HeatCloudLayer.prototype, "setPoints");
    logger.logError.mockClear();
  });

  afterEach(() => {
    lifetime.abort();
    setPoints.mockRestore();
    releaseGroundProfiles();
    resetMapLibreMock();
  });

  it("is on the map while the 3D view is on, above every layer on the ground and below the ribbons, and steps in for the heatmap", async () => {
    await follow();
    expect(map().getLayer(HEAT_CLOUD_LAYER)).toBeUndefined();
    expect(app.store.get("heatCloud")).toBe(false);

    app.threeDVisible = true;

    // Between the layers on the ground and those in the air, where it
    // does not cut the run the relief draws in one pass in two
    const layers = order();
    expect(layers.indexOf(HEAT_CLOUD_LAYER)).toBe(
      layers.indexOf(MAP_LAYERS.replayTrail) + 1,
    );
    expect(layers[layers.indexOf(HEAT_CLOUD_LAYER) + 1]).toBe(
      MAP_LAYERS.pathsAltitudeRibbons,
    );
    expect(app.store.get("heatCloud")).toBe(true);

    app.threeDVisible = false;
    expect(map().getLayer(HEAT_CLOUD_LAYER)).toBeUndefined();
    expect(app.store.get("heatCloud")).toBe(false);
    // Nothing held until the 3D view is back
    expect(drawn()).toBeNull();
  });

  it("draws along the flights the ribbons are cut from, smoothed once for both", async () => {
    app.threeDVisible = true;
    await follow();
    expect(heldGroundedFlights()).toBe(DATA.path_segments);
    const flights = groundedFlights(
      DATA.path_segments,
      app.terrainActive,
      app.reliefLevel,
    );
    const chain = flights.chains[0]!;
    const cloud = drawn()!;
    // The first point of the cloud is the first of the first curve
    const [x, y] = mercatorOf(chain.points[0]!);
    expect(cloud.points[5]! + cloud.origin[0]).toBeCloseTo(x, 9);
    expect(cloud.points[6]! + cloud.origin[1]).toBeCloseTo(y, 9);
  });

  it("starts in 3D, as a link or a saved view opens it", async () => {
    app.threeDVisible = true;
    await follow();
    expect(map().getLayer(HEAT_CLOUD_LAYER)).toBeDefined();
    expect(app.store.get("heatCloud")).toBe(true);
    expect(latitudesOf(drawn())).toEqual([47, 48, 49]);
  });

  it("draws nothing while the heatmap is off or a replay runs, as the heatmap", async () => {
    app.threeDVisible = true;
    await follow();
    expect(style()).not.toBeNull();

    app.heatmapVisible = false;
    expect(style()).toBeNull();
    // Still on the map, and the flat heatmap still stepped aside
    expect(map().getLayer(HEAT_CLOUD_LAYER)).toBeDefined();
    expect(app.store.get("heatCloud")).toBe(true);

    app.heatmapVisible = true;
    app.replayActive = true;
    expect(style()).toBeNull();
    app.replayActive = false;
    expect(style()).not.toBeNull();
  });

  it("steps back under a colour layer, as far as the heatmap does", async () => {
    app.threeDVisible = true;
    await follow();
    expect(style()!.opacity).toBe(1);
    app.altitudeVisible = true;
    expect(style()!.opacity).toBeGreaterThan(0);
    expect(style()!.opacity).toBeLessThan(1);
    app.altitudeVisible = false;
    expect(style()!.opacity).toBe(1);
  });

  it("follows the year and aircraft filters", async () => {
    app.threeDVisible = true;
    await follow();
    app.selectedYear = "2026";
    expect(latitudesOf(drawn())).toEqual([48, 49]);
    app.selectedAircraft = "D-EBBB";
    expect(latitudesOf(drawn())).toEqual([49]);
    app.selectedYear = "all";
    app.selectedAircraft = "all";
    expect(latitudesOf(drawn())).toEqual([47, 48, 49]);
  });

  it("draws the isolated flights alone, of those the filter keeps", async () => {
    app.threeDVisible = true;
    await follow();
    app.selectedPathIds = new Set([1, 3]);
    // Selected but not isolated: every flight still
    expect(latitudesOf(drawn())).toEqual([47, 48, 49]);
    app.isolateSelection = true;
    expect(latitudesOf(drawn())).toEqual([47, 49]);
    app.selectedYear = "2026";
    expect(latitudesOf(drawn())).toEqual([49]);
    app.isolateSelection = false;
    expect(latitudesOf(drawn())).toEqual([48, 49]);
  });

  it("works its points out again only for what changes them", async () => {
    app.threeDVisible = true;
    await follow();
    const calls = setPoints.mock.calls.length;
    app.altitudeVisible = true;
    app.heatmapVisible = false;
    app.heatmapVisible = true;
    expect(setPoints.mock.calls.length).toBe(calls);
    app.reliefLevel = 5;
    expect(setPoints.mock.calls.length).toBe(calls + 1);
    app.terrainActive = true;
    expect(setPoints.mock.calls.length).toBe(calls + 2);
  });

  it("keeps the points of the last few relief levels, for as long as what they are of stays", async () => {
    app.threeDVisible = true;
    app.reliefLevel = 5;
    await follow();
    const five = drawn()!;
    app.reliefLevel = 6;
    const six = drawn()!;
    expect(six).not.toBe(five);
    // A zoom back into a level drawn a moment ago works nothing out
    app.reliefLevel = 5;
    expect(drawn()).toBe(five);
    app.reliefLevel = 6;
    expect(drawn()).toBe(six);
    // Four levels at most: the one drawn longest ago goes
    for (const level of [7, 8, 9]) app.reliefLevel = level;
    app.reliefLevel = 6;
    expect(drawn()).toBe(six);
    app.reliefLevel = 5;
    expect(drawn()).not.toBe(five);
    // Another filter makes them all anew
    const again = drawn()!;
    app.selectedYear = "2026";
    app.reliefLevel = 6;
    expect(drawn()).not.toBe(six);
    app.reliefLevel = 5;
    expect(drawn()).not.toBe(again);
    expect(latitudesOf(drawn())).toEqual([48, 49]);
  });

  it("stands the points on the ground of the relief level, on the relief, and as high as the ribbons", async () => {
    const sampled = DATA.path_segments.map((segment) => ({
      ...segment,
      ground_ft: 1200,
    }));
    app.currentData = createDataset(DATA.path_info, sampled);
    app.threeDVisible = true;
    app.store.batch(() => {
      app.reliefLevel = 8;
      app.terrainActive = true;
    });
    await follow();
    const ground = levelGroundFt(sampled, true, 8);
    const cloud = drawn()!;
    expect(cloud.points[5 + 2]).toBeCloseTo(ground[0]!, 3);
    expect(cloud.points[5 + 3]).toBeCloseTo(4000 - ground[0]!, 3);

    // The relief's exaggeration, or the level's without a relief
    const metres = liftExaggeration(8) * FEET_TO_METERS;
    expect(style()).toMatchObject({ groundM: metres, liftM: metres });
    map().addSource(MAP_SOURCES.terrain, { type: "raster-dem" });
    map().setTerrain({ source: MAP_SOURCES.terrain, exaggeration: 3 });
    expect(style()!.groundM).toBeCloseTo(3 * FEET_TO_METERS, 9);
    app.terrainActive = false;
    map().setTerrain(null);
    expect(style()).toMatchObject({ groundM: 0, liftM: metres });

    // Flat, as the ribbons are, from the zoom the 3D view draws lines, and
    // as they are, once the zoom there has ended: the layer manager cuts
    // the flights as lines then
    map().setZoom(17.5);
    expect(style()!.liftM).toBe(metres);
    map().emit("zoomend");
    expect(style()!.liftM).toBe(0);
    // Nor while a zoom out goes on, whatever else changes meanwhile
    map().setZoom(16.5);
    map().isZooming.mockReturnValue(true);
    app.selectedYear = "2026";
    expect(style()!.liftM).toBe(0);
    map().isZooming.mockReturnValue(false);
    map().emit("zoomend");
    expect(style()!.liftM).toBe(metres);
  });

  it("goes back where it belongs after a new base style", async () => {
    app.threeDVisible = true;
    await follow();
    const style: StyleSpecification = {
      version: 8,
      sources: {},
      layers: [{ id: "background", type: "background" }],
    };
    setBaseStyle(map() as unknown as MapLibreMap, style);
    // Wherever the new style left it, or without it
    map().removeLayer(HEAT_CLOUD_LAYER);
    map().emit("styledata");
    const layers = order();
    expect(layers.indexOf(HEAT_CLOUD_LAYER)).toBe(
      layers.indexOf(MAP_LAYERS.pathsAltitudeRibbons) - 1,
    );

    map().moveLayer(HEAT_CLOUD_LAYER);
    map().emit("styledata");
    expect(order().indexOf(HEAT_CLOUD_LAYER)).toBe(
      order().indexOf(MAP_LAYERS.pathsAltitudeRibbons) - 1,
    );
  });

  it("comes back after a lost WebGL context, whose style has none of the custom layers", async () => {
    app.threeDVisible = true;
    await follow();
    map().emit("webglcontextlost");
    map().removeLayer(HEAT_CLOUD_LAYER);
    map().emit("webglcontextrestored");
    map().emit("style.load");
    expect(map().getLayer(HEAT_CLOUD_LAYER)).toBeDefined();
  });

  it("leaves the heatmap as it was where its shaders do not work", async () => {
    vi.useFakeTimers();
    try {
      app.threeDVisible = true;
      await follow();
      const failed = (layer() as unknown as { failed: (e: unknown) => void })
        .failed;
      failed(new Error("the cloud's shader did not compile"));
      failed(new Error("again"));
      vi.runAllTimers();

      expect(logger.logError).toHaveBeenCalledOnce();
      expect(map().getLayer(HEAT_CLOUD_LAYER)).toBeUndefined();
      expect(app.store.get("heatCloud")).toBe(false);
      // For good
      app.threeDVisible = false;
      app.threeDVisible = true;
      expect(map().getLayer(HEAT_CLOUD_LAYER)).toBeUndefined();
      expect(app.store.get("heatCloud")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops following the store and the map with the app", async () => {
    await follow();
    lifetime.abort();
    app.threeDVisible = true;
    expect(map().getLayer(HEAT_CLOUD_LAYER)).toBeUndefined();
    expect(app.store.get("heatCloud")).toBe(false);
  });
});
