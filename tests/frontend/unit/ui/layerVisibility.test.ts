/**
 * What the layers show follows from the store: the user's layer flags and
 * whether a replay runs. Wired with a real layer manager, so the colour
 * layers are drawn and cleared for real.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  dimsHeatmap,
  followLayerVisibility,
  highlightsSelection,
  setColorLayer,
} from "../../../../kml_heatmap/frontend/ui/layerVisibility";
import { LayerManager } from "../../../../kml_heatmap/frontend/ui/layerManager";
import {
  MAP_LAYERS,
  MAP_SOURCES,
} from "../../../../kml_heatmap/frontend/utils/constants";
import {
  asMapApp,
  createDataset,
  createMockApp,
  createSegment,
  el,
  mountElements,
  type MockApp,
} from "../../testHelpers";

describe("layer visibility", () => {
  let app: MockApp;
  let unmount: () => void;

  const visibility = (id: string): unknown =>
    app.map!.layer(id).layout["visibility"];
  const runs = (source: string): number =>
    (app.map!.source(source).data as GeoJSON.FeatureCollection).features.length;
  /** What the map shows, layer by layer */
  const shown = (): Record<string, unknown> => ({
    heatmap: visibility(MAP_LAYERS.heat),
    altitude: visibility(MAP_LAYERS.pathsAltitude),
    airspeed: visibility(MAP_LAYERS.pathsAirspeed),
    airports: app.airportLayer.isVisible(),
    aviation: visibility(MAP_LAYERS.aviation),
  });

  beforeEach(() => {
    unmount = mountElements({
      "heatmap-btn": "button",
      "altitude-legend": "div",
    });
    app = createMockApp({
      currentData: createDataset(
        [{ id: 1, year: 2025 }],
        [createSegment({ path_id: 1 })],
      ),
    });
    app.layerManager = new LayerManager(
      asMapApp(app),
    ) as unknown as MockApp["layerManager"];
    app.dataManager.showHeatmap.mockImplementation(() =>
      app.heatmapLayer.setVisible(true),
    );
  });

  afterEach(() => {
    unmount();
    vi.restoreAllMocks();
  });

  it("shows what the store holds from the start", () => {
    app.store.batch(() => {
      app.heatmapVisible = false;
      app.airspeedVisible = true;
      app.airportsVisible = false;
      app.aviationVisible = true;
    });

    followLayerVisibility(asMapApp(app));

    expect(shown()).toEqual({
      heatmap: "none",
      altitude: "none",
      airspeed: "visible",
      airports: false,
      aviation: "visible",
    });
    expect(runs(MAP_SOURCES.pathsAirspeed)).toBeGreaterThan(0);
    expect(el("heatmap-btn").getAttribute("aria-pressed")).toBe("false");
  });

  it("hides the heatmap and the colour layers for a replay, and keeps the flags", () => {
    app.altitudeVisible = true;
    app.aviationVisible = true;
    followLayerVisibility(asMapApp(app));
    const drawn = runs(MAP_SOURCES.pathsAltitude);

    app.replayActive = true;

    expect(shown()).toEqual({
      heatmap: "none",
      altitude: "none",
      airspeed: "none",
      airports: true,
      aviation: "visible",
    });
    expect(app.heatmapVisible).toBe(true);
    expect(app.altitudeVisible).toBe(true);
    // Hidden, not cleared: it comes back as it was
    expect(runs(MAP_SOURCES.pathsAltitude)).toBe(drawn);
    // The heatmap's toggle does not claim a layer the replay hides
    expect(el("heatmap-btn").getAttribute("aria-pressed")).toBe("false");
    expect(el("heatmap-btn").classList.contains("active")).toBe(false);
  });

  it("brings back exactly what the user chose, changes made during the replay included", () => {
    app.store.batch(() => {
      app.heatmapVisible = false;
      app.airspeedVisible = true;
    });
    followLayerVisibility(asMapApp(app));
    app.replayActive = true;

    // The colour toggles stay usable while the replay runs
    setColorLayer(asMapApp(app), "altitude", true);
    app.replayActive = false;

    expect(shown()).toEqual({
      heatmap: "none",
      altitude: "visible",
      airspeed: "none",
      airports: true,
      aviation: "none",
    });
    expect(runs(MAP_SOURCES.pathsAltitude)).toBeGreaterThan(0);
    expect(runs(MAP_SOURCES.pathsAirspeed)).toBe(0);
    expect(el("heatmap-btn").getAttribute("aria-pressed")).toBe("false");
  });

  it("shows the heatmap through the data manager once the replay ends", () => {
    followLayerVisibility(asMapApp(app));
    app.replayActive = true;
    app.dataManager.showHeatmap.mockClear();

    app.replayActive = false;

    expect(app.dataManager.showHeatmap).toHaveBeenCalledTimes(1);
    expect(visibility(MAP_LAYERS.heat)).toBe("visible");
    expect(el("heatmap-btn").getAttribute("aria-pressed")).toBe("true");
  });

  it("draws a colour layer anew as the replay ends", () => {
    // Its legend shows the range of the replayed flight until then
    app.altitudeVisible = true;
    followLayerVisibility(asMapApp(app));
    app.replayActive = true;
    const setData = app.map!.source(MAP_SOURCES.pathsAltitude).setData;
    setData.mockClear();

    app.replayActive = false;

    expect(setData).toHaveBeenCalled();
  });

  it("shows the altitude scale for a replay trail coloured by altitude", () => {
    followLayerVisibility(asMapApp(app));
    const legend = el("altitude-legend");
    expect(legend.hidden).toBe(true);

    app.replayActive = true;
    expect(legend.hidden).toBe(false);

    // The speed layer colours the trail by speed
    setColorLayer(asMapApp(app), "airspeed", true);
    expect(legend.hidden).toBe(true);

    setColorLayer(asMapApp(app), "airspeed", false);
    app.replayActive = false;
    expect(legend.hidden).toBe(true);
  });

  it("dims the heatmap as the colour flags change", () => {
    followLayerVisibility(asMapApp(app));
    app.dataManager.applyHeatmapEmphasis.mockClear();

    app.altitudeVisible = true;

    expect(app.dataManager.applyHeatmapEmphasis).toHaveBeenCalledTimes(1);
  });

  describe("the selection's lines", () => {
    const highlight = (): unknown => visibility(MAP_LAYERS.selectionHighlight);

    // selected, altitude, airspeed, replay, isolate: shown
    it.each([
      [false, false, false, false, false, false],
      [true, false, false, false, false, true],
      [true, false, false, false, true, true],
      [true, true, false, false, false, false],
      [true, false, true, false, false, false],
      [true, false, true, false, true, false],
      [true, false, false, true, false, false],
      [true, true, false, true, false, false],
      [false, true, false, false, false, false],
    ])(
      "selection %s, altitude %s, speed %s, replay %s, isolate %s: shown %s",
      (selected, altitude, airspeed, replay, isolate, expected) => {
        app.store.batch(() => {
          if (selected) {
            app.selectedPathIds.add(1);
            app.store.notifyMutation("selectedPathIds");
          }
          app.altitudeVisible = altitude;
          app.airspeedVisible = airspeed;
          app.replayActive = replay;
          app.isolateSelection = isolate;
        });

        followLayerVisibility(asMapApp(app));

        expect(highlightsSelection(asMapApp(app))).toBe(expected);
        expect(highlight()).toEqual(expected ? "visible" : "none");
        // The heatmap steps back for exactly what is drawn over it
        expect(dimsHeatmap(asMapApp(app))).toBe(
          expected || altitude || airspeed,
        );
      },
    );

    it("dim the heatmap under the aviation chart too", () => {
      followLayerVisibility(asMapApp(app));
      app.dataManager.applyHeatmapEmphasis.mockClear();

      // Its airspace outlines drowned under the bloom (regression)
      app.aviationVisible = true;
      expect(dimsHeatmap(asMapApp(app))).toBe(true);
      expect(app.dataManager.applyHeatmapEmphasis).toHaveBeenCalledTimes(1);

      app.aviationVisible = false;
      expect(dimsHeatmap(asMapApp(app))).toBe(false);
    });

    it("come and go with the selection, and dim the heatmap with them", () => {
      followLayerVisibility(asMapApp(app));
      app.dataManager.applyHeatmapEmphasis.mockClear();

      app.selectedPathIds.add(1);
      app.store.notifyMutation("selectedPathIds");
      expect(highlight()).toBe("visible");
      expect(app.dataManager.applyHeatmapEmphasis).toHaveBeenCalledTimes(1);

      app.selectedPathIds.clear();
      app.store.notifyMutation("selectedPathIds");
      expect(highlight()).toBe("none");
      expect(dimsHeatmap(asMapApp(app))).toBe(false);
      expect(app.dataManager.applyHeatmapEmphasis).toHaveBeenCalledTimes(2);
    });

    it("give way to a colour layer and a replay, and come back after them", () => {
      app.selectedPathIds.add(1);
      followLayerVisibility(asMapApp(app));
      expect(highlight()).toBe("visible");

      setColorLayer(asMapApp(app), "altitude", true);
      expect(highlight()).toBe("none");
      setColorLayer(asMapApp(app), "altitude", false);
      expect(highlight()).toBe("visible");

      app.replayActive = true;
      expect(highlight()).toBe("none");
      app.replayActive = false;
      expect(highlight()).toBe("visible");
    });
  });

  describe("setColorLayer", () => {
    it("switches the other colour layer off in the same update", () => {
      app.airspeedVisible = true;
      const listener = vi.fn();
      app.store.subscribeKeys(["altitudeVisible", "airspeedVisible"], listener);

      const replaced = setColorLayer(asMapApp(app), "altitude", true);

      expect(replaced).toBe(true);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(app.altitudeVisible).toBe(true);
      expect(app.airspeedVisible).toBe(false);
    });

    it("replaces nothing when the other one is off", () => {
      expect(setColorLayer(asMapApp(app), "airspeed", true)).toBe(false);
      expect(app.airspeedVisible).toBe(true);
    });

    it("leaves the other one alone when switching off", () => {
      app.altitudeVisible = true;

      expect(setColorLayer(asMapApp(app), "airspeed", false)).toBe(false);
      expect(app.altitudeVisible).toBe(true);
      expect(app.airspeedVisible).toBe(false);
    });
  });
});
