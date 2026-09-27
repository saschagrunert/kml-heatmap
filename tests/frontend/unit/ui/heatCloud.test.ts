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
import {
  CLOUD_IDLE_MS,
  followHeatCloud,
  prepareHeatCloud,
} from "../../../../kml_heatmap/frontend/ui/heatCloud";
import {
  HEAT_CLOUD_LAYER,
  HeatCloudLayer,
  type HeatCloudStyle,
} from "../../../../kml_heatmap/frontend/ui/heatCloudLayer";
import {
  CLOUD_POINT_FLOATS,
  mercatorOf,
  type CloudPoints,
} from "../../../../kml_heatmap/frontend/calculations/heatCloud";
import { liftExaggeration } from "../../../../kml_heatmap/frontend/calculations/lift";
import {
  FULL_BAND,
  heightBandEdgesFt,
  parseHeightBand,
} from "../../../../kml_heatmap/frontend/calculations/heightBand";
import {
  groundedFlights,
  heldFlights,
  heldGroundedFlights,
  levelGroundFt,
  releaseGroundProfiles,
} from "../../../../kml_heatmap/frontend/calculations/groundProfile";
import { setBaseStyle } from "../../../../kml_heatmap/frontend/mapLayers";
import { REPLAY_CAMERA_MOVE } from "../../../../kml_heatmap/frontend/utils/mapHelpers";
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

/** Counts the cuts of the cloud's points, which it otherwise leaves alone */
const cuts = vi.hoisted(() => ({ count: 0 }));
vi.mock(
  "../../../../kml_heatmap/frontend/calculations/heatCloud",
  async (original) => {
    const actual =
      await original<
        typeof import("../../../../kml_heatmap/frontend/calculations/heatCloud")
      >();
    return {
      ...actual,
      cloudPoints: (...args: Parameters<typeof actual.cloudPoints>) => {
        cuts.count++;
        return actual.cloudPoints(...args);
      },
    };
  },
);

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
    const y = cloud.points[k * CLOUD_POINT_FLOATS + 1]! + cloud.origin[1];
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
    expect(cloud.points[CLOUD_POINT_FLOATS]! + cloud.origin[0]).toBeCloseTo(
      x,
      9,
    );
    expect(cloud.points[CLOUD_POINT_FLOATS + 1]! + cloud.origin[1]).toBeCloseTo(
      y,
      9,
    );
  });

  it("starts in 3D, as a link or a saved view opens it", async () => {
    app.threeDVisible = true;
    await follow();
    expect(map().getLayer(HEAT_CLOUD_LAYER)).toBeDefined();
    expect(app.store.get("heatCloud")).toBe(true);
    expect(latitudesOf(drawn())).toEqual([47, 48, 49]);
  });

  it("draws nothing while the heatmap is off, as the heatmap", async () => {
    app.threeDVisible = true;
    await follow();
    expect(style()).not.toBeNull();

    app.heatmapVisible = false;
    expect(style()).toBeNull();
    // Still on the map, and the flat heatmap still stepped aside
    expect(map().getLayer(HEAT_CLOUD_LAYER)).toBeDefined();
    expect(app.store.get("heatCloud")).toBe(true);
    app.heatmapVisible = true;
    expect(style()).not.toBeNull();
  });

  it("stays faintly and without its pulses while a replay runs, where the heatmap goes", async () => {
    app.threeDVisible = true;
    await follow();
    expect(style()).toMatchObject({ opacity: 1, flow: true });

    // Under the aviation chart as well: fainter still than it steps back
    // there
    app.aviationVisible = true;
    app.replayActive = true;
    const faint = style()!;
    expect(faint.flow).toBe(false);
    expect(faint.opacity).toBeGreaterThanOrEqual(0.2);
    expect(faint.opacity).toBeLessThanOrEqual(0.3);
    expect(latitudesOf(drawn())).toEqual([47, 48, 49]);

    app.replayActive = false;
    app.aviationVisible = false;
    expect(style()).toMatchObject({ opacity: 1, flow: true });
    app.heatmapVisible = false;
    app.replayActive = true;
    expect(style()).toBeNull();
  });

  it("stays at full strength under the ribbons of a colour layer, which the 3D button turns on, as a link without them opens it", async () => {
    app.threeDVisible = true;
    await follow();
    expect(style()!.opacity).toBe(1);
    app.altitudeVisible = true;
    expect(style()!.opacity).toBe(1);
    app.store.batch(() => {
      app.altitudeVisible = false;
      app.airspeedVisible = true;
    });
    expect(style()!.opacity).toBe(1);
    // Nor for a selection the colour layer draws
    app.selectedPathIds = new Set([1]);
    expect(style()!.opacity).toBe(1);
  });

  it("steps back under the aviation chart and a selection's lines, as far as the heatmap does", async () => {
    app.threeDVisible = true;
    await follow();
    app.aviationVisible = true;
    expect(style()!.opacity).toBeGreaterThan(0);
    expect(style()!.opacity).toBeLessThan(1);
    app.aviationVisible = false;
    expect(style()!.opacity).toBe(1);
    app.selectedPathIds = new Set([1]);
    expect(style()!.opacity).toBeGreaterThan(0);
    expect(style()!.opacity).toBeLessThan(1);
  });

  it("draws the band of heights of its control in the 3D view, and every height in Wrapped", async () => {
    app.threeDVisible = true;
    await follow();
    expect(style()!.band).toEqual(heightBandEdgesFt(FULL_BAND));
    const cut = cuts.count;
    const handed = setPoints.mock.calls.length;
    const repaints = map().triggerRepaint.mock.calls.length;

    app.heightBand = "500-3000";
    expect(style()!.band).toEqual(
      heightBandEdgesFt(parseHeightBand("500-3000")),
    );
    expect(map().triggerRepaint.mock.calls.length).toBeGreaterThan(repaints);
    // The band is drawn by the shaders, from the same points
    expect(cuts.count).toBe(cut);
    expect(setPoints.mock.calls.length).toBe(handed);
    // Its control, under the 3D switch or over the map
    expect(document.getElementById("height-band")?.hidden).toBe(false);

    // Wrapped has no control for it, and shows the whole year
    app.wrappedVisible = true;
    expect(style()!.band).toEqual(heightBandEdgesFt(FULL_BAND));
    app.wrappedVisible = false;
    expect(style()!.band).toEqual(
      heightBandEdgesFt(parseHeightBand("500-3000")),
    );
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

  it("draws every flight while Isolate has nothing to isolate, and follows the selection only while isolated", async () => {
    app.threeDVisible = true;
    await follow();
    app.isolateSelection = true;
    expect(latitudesOf(drawn())).toEqual([47, 48, 49]);

    app.selectedPathIds = new Set([2]);
    expect(latitudesOf(drawn())).toEqual([48]);
    app.selectedPathIds = new Set([2, 3]);
    expect(latitudesOf(drawn())).toEqual([48, 49]);
    // The selection emptied: every flight again
    app.selectedPathIds = new Set();
    expect(latitudesOf(drawn())).toEqual([47, 48, 49]);

    // Not isolated, a new selection cuts nothing anew
    app.isolateSelection = false;
    const calls = setPoints.mock.calls.length;
    const cutsBefore = cuts.count;
    app.selectedPathIds = new Set([1]);
    expect(setPoints.mock.calls.length).toBe(calls);
    expect(cuts.count).toBe(cutsBefore);
  });

  it("stays on the map with the same points as the globe comes and goes in 3D", async () => {
    app.threeDVisible = true;
    await follow();
    const points = drawn();
    const calls = setPoints.mock.calls.length;

    app.globeVisible = true;
    expect(map().getLayer(HEAT_CLOUD_LAYER)).toBeDefined();
    expect(app.store.get("heatCloud")).toBe(true);
    expect(style()).toMatchObject({ opacity: 1, flow: true });
    app.globeVisible = false;

    expect(drawn()).toBe(points);
    expect(setPoints.mock.calls.length).toBe(calls);
    expect(map().getLayer(HEAT_CLOUD_LAYER)).toBeDefined();
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
    expect(cloud.points[CLOUD_POINT_FLOATS + 2]).toBeCloseTo(ground[0]!, 3);
    expect(cloud.points[CLOUD_POINT_FLOATS + 3]).toBeCloseTo(
      4000 - ground[0]!,
      3,
    );

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
      // For as long as the map keeps its context
      app.threeDVisible = false;
      app.threeDVisible = true;
      expect(map().getLayer(HEAT_CLOUD_LAYER)).toBeUndefined();
      expect(app.store.get("heatCloud")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("tries its shaders again in the context the map gets back after a loss, which is what they may have failed with", async () => {
    vi.useFakeTimers();
    try {
      app.threeDVisible = true;
      await follow();
      (layer() as unknown as { failed: (e: unknown) => void }).failed(
        new Error("the cloud's buffers could not be made"),
      );
      vi.runOnlyPendingTimers();
      expect(app.store.get("heatCloud")).toBe(false);
      map().emit("webglcontextlost");

      map().emit("webglcontextrestored");
      map().emit("style.load");
      expect(map().getLayer(HEAT_CLOUD_LAYER)).toBeDefined();
      expect(app.store.get("heatCloud")).toBe(true);
      expect(style()).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets go of its points a while after the Heatmap switch went off, and cuts them again as it comes back", async () => {
    vi.useFakeTimers();
    try {
      app.threeDVisible = true;
      await follow();
      const points = drawn();
      cuts.count = 0;
      // Back in time: nothing to cut
      app.heatmapVisible = false;
      vi.advanceTimersByTime(CLOUD_IDLE_MS - 1);
      app.heatmapVisible = true;
      expect(cuts.count).toBe(0);
      expect(drawn()).toBe(points);

      app.heatmapVisible = false;
      vi.advanceTimersByTime(CLOUD_IDLE_MS);
      expect(drawn()).toBeNull();
      app.heatmapVisible = true;
      expect(cuts.count).toBe(1);
      expect(latitudesOf(drawn())).toEqual([47, 48, 49]);
    } finally {
      vi.useRealTimers();
    }
  });

  describe("forced on with the 3D view off, as Wrapped's intro does", () => {
    const liftM = (level: number): number =>
      liftExaggeration(level) * FEET_TO_METERS;

    beforeEach(() => {
      map().setZoom(7.4);
      cuts.count = 0;
    });

    it("is on the map in place of the heatmap, on flat ground, until the store lets go", async () => {
      await follow();
      app.forcedHeatCloud = true;

      expect(map().getLayer(HEAT_CLOUD_LAYER)).toBeDefined();
      expect(app.store.get("heatCloud")).toBe(true);
      expect(latitudesOf(drawn())).toEqual([47, 48, 49]);
      // Pulsing as in the 3D view: the intro's replay-all is no replay of
      // the map, which would dim it
      expect(style()).toMatchObject({
        groundM: 0,
        liftM: liftM(7),
        opacity: 1,
        flow: true,
      });
      app.forcedHeatCloud = false;
      expect(map().getLayer(HEAT_CLOUD_LAYER)).toBeUndefined();
      expect(app.store.get("heatCloud")).toBe(false);
      expect(drawn()).toBeNull();
    });

    it("draws the year of the cards, whatever the Heatmap switch, Isolate, a colour layer or a selection say, and leaves them as they were", async () => {
      app.store.batch(() => {
        app.heatmapVisible = false;
        app.selectedPathIds = new Set([1]);
        app.isolateSelection = true;
        app.altitudeVisible = true;
        app.aviationVisible = true;
      });
      await follow();
      app.forcedHeatCloud = true;

      expect(style()).toMatchObject({ opacity: 1, flow: true });
      expect(latitudesOf(drawn())).toEqual([47, 48, 49]);
      // Still the year and aircraft filters'
      app.selectedYear = "2026";
      expect(latitudesOf(drawn())).toEqual([48, 49]);

      app.forcedHeatCloud = false;
      expect(map().getLayer(HEAT_CLOUD_LAYER)).toBeUndefined();
      expect(app.store.get("heatCloud")).toBe(false);
      expect(app.heatmapVisible).toBe(false);
      expect(app.isolateSelection).toBe(true);
    });

    it("gives the 3D view its own cloud back as it goes: isolated, dimmed, or none with the Heatmap switch off", async () => {
      app.store.batch(() => {
        app.threeDVisible = true;
        app.reliefLevel = 7;
        app.selectedPathIds = new Set([1]);
        app.isolateSelection = true;
      });
      await follow();
      const isolated = drawn();
      expect(latitudesOf(isolated)).toEqual([47]);
      const dimmed = style()!.opacity;
      expect(dimmed).toBeLessThan(1);

      app.forcedHeatCloud = true;
      expect(latitudesOf(drawn())).toEqual([47, 48, 49]);
      expect(style()!.opacity).toBe(1);
      app.forcedHeatCloud = false;
      expect(latitudesOf(drawn())).toEqual([47]);
      expect(style()!.opacity).toBe(dimmed);
      expect(app.store.get("heatCloud")).toBe(true);

      app.heatmapVisible = false;
      app.forcedHeatCloud = true;
      expect(style()).not.toBeNull();
      app.forcedHeatCloud = false;
      expect(style()).toBeNull();
      expect(map().getLayer(HEAT_CLOUD_LAYER)).toBeDefined();
    });

    it("cuts ahead of time for the flat ground of the intro's globe, and leaves the flights the ribbons stand on on the relief", async () => {
      app.store.batch(() => {
        app.threeDVisible = true;
        app.reliefLevel = 7;
        app.terrainActive = true;
      });
      await follow();
      const segments = DATA.path_segments;
      const ribbons = heldFlights(segments, true, 7);
      expect(ribbons).not.toBeNull();
      cuts.count = 0;

      prepareHeatCloud(asMapApp(app), [6, 7]);
      expect(cuts.count).toBe(2);
      expect(heldFlights(segments, true, 7)).toBe(ribbons);

      // The intro: the cloud forced, then the relief gone with the globe,
      // a round of the store later
      app.forcedHeatCloud = true;
      // On the ground its points were cut on from the first
      expect(style()!.groundM).toBe(0);
      app.terrainActive = false;
      expect(cuts.count).toBe(2);
    });

    it("keeps the 3D view's own points while its button cuts Wrapped's ahead of time, and lets go of those that are not drawn", async () => {
      vi.useFakeTimers();
      try {
        app.store.batch(() => {
          app.threeDVisible = true;
          app.reliefLevel = 7;
          app.terrainActive = true;
        });
        await follow();
        app.reliefLevel = 6;
        const six = drawn();
        cuts.count = 0;

        prepareHeatCloud(asMapApp(app), [6, 7]);
        expect(cuts.count).toBe(2);
        // What changes nothing of its points cuts nothing, nor does a zoom
        // back into a level it drew
        app.selectedPathIds = new Set([1]);
        expect(drawn()).toBe(six);
        app.reliefLevel = 7;
        app.reliefLevel = 6;
        expect(drawn()).toBe(six);
        expect(cuts.count).toBe(2);

        // Those cut ahead go unless the intro draws them, the 3D view's
        // stay while it draws them
        vi.advanceTimersByTime(CLOUD_IDLE_MS);
        app.forcedHeatCloud = true;
        expect(cuts.count).toBe(3);
        app.forcedHeatCloud = false;
        expect(drawn()).toBe(six);
        expect(cuts.count).toBe(3);
        // And the 3D view's go while Wrapped's cloud draws in their place
        app.forcedHeatCloud = true;
        vi.advanceTimersByTime(CLOUD_IDLE_MS);
        app.forcedHeatCloud = false;
        expect(cuts.count).toBe(4);
      } finally {
        vi.useRealTimers();
      }
    });

    it("holds nothing of what it cut ahead of time for long, flights nor points, unless the intro draws it", async () => {
      vi.useFakeTimers();
      try {
        await follow();
        prepareHeatCloud(asMapApp(app), [7]);
        expect(cuts.count).toBe(1);
        // Nothing left for the layer manager to let go of
        expect(heldGroundedFlights()).toBeNull();

        vi.advanceTimersByTime(CLOUD_IDLE_MS - 1);
        prepareHeatCloud(asMapApp(app), [7]);
        expect(cuts.count).toBe(1);
        vi.advanceTimersByTime(CLOUD_IDLE_MS);
        app.forcedHeatCloud = true;
        expect(cuts.count).toBe(2);

        // Not while it draws them
        vi.advanceTimersByTime(CLOUD_IDLE_MS);
        expect(drawn()).not.toBeNull();
        app.forcedHeatCloud = false;
        vi.advanceTimersByTime(CLOUD_IDLE_MS);
        prepareHeatCloud(asMapApp(app), [7]);
        expect(cuts.count).toBe(3);
      } finally {
        vi.useRealTimers();
      }
    });

    it("is cut for the zoom the map comes to rest at, not for the moves of a scripted camera", async () => {
      await follow();
      app.forcedHeatCloud = true;
      const seven = drawn();

      // The intro's flight: far out and back, tagged
      map().setZoom(1.2);
      map().emit("zoomend", REPLAY_CAMERA_MOVE);
      map().setZoom(9.3);
      map().emit("zoomend", REPLAY_CAMERA_MOVE);
      expect(drawn()).toBe(seven);
      expect(style()!.liftM).toBeCloseTo(liftM(7), 9);

      // Where it comes to rest
      map().emit("zoomend");
      expect(drawn()).not.toBe(seven);
      expect(style()!.liftM).toBeCloseTo(liftM(9), 9);
      expect(cuts.count).toBe(2);
    });

    it("leaves the level to the 3D view while that is on", async () => {
      app.store.batch(() => {
        app.threeDVisible = true;
        app.reliefLevel = 5;
      });
      await follow();
      app.forcedHeatCloud = true;
      map().emit("zoomend");
      expect(style()!.liftM).toBeCloseTo(liftM(5), 9);
      // Turning the force off leaves the 3D view's cloud where it is
      app.forcedHeatCloud = false;
      expect(map().getLayer(HEAT_CLOUD_LAYER)).toBeDefined();
    });

    it("draws points cut ahead of time without cutting them again, for as long as what they are of stays", async () => {
      await follow();
      prepareHeatCloud(asMapApp(app), [6, 7]);
      expect(cuts.count).toBe(2);
      // Nothing drawn meanwhile, and a change of what does not make them
      // keeps them
      expect(setPoints).not.toHaveBeenCalled();
      app.altitudeVisible = true;

      app.forcedHeatCloud = true;
      expect(cuts.count).toBe(2);
      expect(latitudesOf(drawn())).toEqual([47, 48, 49]);

      // Another year makes them anew
      app.forcedHeatCloud = false;
      prepareHeatCloud(asMapApp(app), [7]);
      app.selectedYear = "2026";
      app.forcedHeatCloud = true;
      expect(latitudesOf(drawn())).toEqual([48, 49]);
    });

    it("keeps the points it drew once the store lets go, for the next opening, and shares them with the 3D view on flat ground", async () => {
      await follow();
      app.forcedHeatCloud = true;
      const seven = drawn();
      app.forcedHeatCloud = false;
      // Wrapped's button asks for them again as the dialog closes
      prepareHeatCloud(asMapApp(app), [7]);
      expect(cuts.count).toBe(1);
      app.forcedHeatCloud = true;
      expect(drawn()).toBe(seven);
      app.forcedHeatCloud = false;

      // The same points: flat ground, nothing isolated
      app.store.batch(() => {
        app.threeDVisible = true;
        app.reliefLevel = 7;
      });
      expect(drawn()).toBe(seven);
      expect(cuts.count).toBe(1);
      // The 3D view's go with it, Wrapped's stay a while
      app.threeDVisible = false;
      prepareHeatCloud(asMapApp(app), [7]);
      expect(cuts.count).toBe(1);
    });

    it("prepares nothing before it is followed, and is followed once", async () => {
      prepareHeatCloud(asMapApp(app), [7]);
      expect(cuts.count).toBe(0);
      await follow();
      followHeatCloud(asMapApp(app));
      await app.mapReady;
      app.forcedHeatCloud = true;
      expect(
        map().addLayer.mock.calls.filter(
          ([spec]) => (spec as { id: string }).id === HEAT_CLOUD_LAYER,
        ),
      ).toHaveLength(1);
    });
  });

  it("stops following the store and the map with the app", async () => {
    await follow();
    lifetime.abort();
    app.threeDVisible = true;
    expect(map().getLayer(HEAT_CLOUD_LAYER)).toBeUndefined();
    expect(app.store.get("heatCloud")).toBe(false);
  });
});
