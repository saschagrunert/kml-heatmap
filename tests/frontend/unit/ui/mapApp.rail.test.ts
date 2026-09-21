/**
 * MapApp: store-driven controls, the statistics rail, map events and setup.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  cartoTransformRequest,
  FALLBACK_STYLE,
  FEATURES_UNAVAILABLE_MESSAGE,
  MapApp,
} from "../../../../kml_heatmap/frontend/mapApp";
import { logError } from "../../../../kml_heatmap/frontend/utils/logger";
import {
  AttributionControl,
  lastMap,
  mockControl,
  resetMapLibreMock,
  type Map as MockMap,
} from "../../../mocks/maplibre-gl";
import { showToast } from "../../../../kml_heatmap/frontend/utils/toast";
import { loadFeatures } from "../../../../kml_heatmap/frontend/services/featureLoader";
import { resizeMapAfterTransition } from "../../../../kml_heatmap/frontend/utils/mapHelpers";
import * as motion from "../../../../kml_heatmap/frontend/utils/motion";

// The instances the mocked manager constructors hand out live in the setup
// module, which is loaded before the mocks are registered
const m = await vi.hoisted(() => import("./mapAppTestSetup"));

vi.mock("../../../../kml_heatmap/frontend/utils/logger", () => ({
  logError: vi.fn(),
  logDebug: vi.fn(),
  initLogger: vi.fn(),
}));
vi.mock("../../../../kml_heatmap/frontend/utils/domCache", () => ({
  domCache: {
    get: vi.fn((id: string, ctor?: new () => HTMLElement) => {
      const element = document.getElementById(id);
      if (!element || !ctor) return element;
      return element instanceof ctor ? element : null;
    }),
    clear: vi.fn(),
  },
}));
vi.mock(
  "../../../../kml_heatmap/frontend/utils/mapHelpers",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../../../kml_heatmap/frontend/utils/mapHelpers")
    >()),
    resizeMapAfterTransition: vi.fn(),
  }),
);
vi.mock("../../../../kml_heatmap/frontend/utils/toast", () => ({
  showToast: vi.fn(),
}));
const mobileBarMock = vi.hoisted(() => ({ mountFor: vi.fn() }));
vi.mock("../../../../kml_heatmap/frontend/ui/mobileBar", () => ({
  MobileBar: mobileBarMock,
}));
vi.mock("../../../../kml_heatmap/frontend/ui/dataManager", () => ({
  DataManager: vi.fn(function () {
    return m.mockDataManagerInstance;
  }),
}));
vi.mock("../../../../kml_heatmap/frontend/ui/filterManager", () => ({
  FilterManager: vi.fn(function () {
    return m.mockFilterManagerInstance;
  }),
}));
vi.mock("../../../../kml_heatmap/frontend/ui/statsManager", () => ({
  StatsManager: vi.fn(function () {
    return m.mockStatsManagerInstance;
  }),
}));
vi.mock("../../../../kml_heatmap/frontend/ui/airportManager", () => ({
  AirportManager: vi.fn(function () {
    return m.mockAirportManagerInstance;
  }),
}));
vi.mock("../../../../kml_heatmap/frontend/ui/replayManager", () => ({
  ReplayManager: vi.fn(function () {
    return m.mockReplayManagerInstance;
  }),
}));
vi.mock("../../../../kml_heatmap/frontend/ui/layerManager", () => ({
  LayerManager: vi.fn(function () {
    return m.mockLayerManagerInstance;
  }),
}));
vi.mock("../../../../kml_heatmap/frontend/ui/stateManager", () => ({
  StateManager: vi.fn(function () {
    return m.mockStateManagerInstance;
  }),
}));
vi.mock("../../../../kml_heatmap/frontend/ui/wrappedManager", () => ({
  WrappedManager: vi.fn(function () {
    return m.mockWrappedManagerInstance;
  }),
}));
vi.mock("../../../../kml_heatmap/frontend/services/featureLoader", () => ({
  // Replay and Wrapped come from the lazily loaded feature bundle; here they
  // are the doubles the module mocks above return
  loadFeatures: vi.fn(() =>
    Promise.resolve({
      ReplayManager: vi.fn(function () {
        return m.mockReplayManagerInstance;
      }),
      WrappedManager: vi.fn(function () {
        return m.mockWrappedManagerInstance;
      }),
    }),
  ),
}));
vi.mock("../../../../kml_heatmap/frontend/ui/uiToggles", () => ({
  UIToggles: vi.fn(function () {
    return m.mockUITogglesInstance;
  }),
}));
vi.mock("../../../../kml_heatmap/frontend/ui/pathSelection", () => ({
  PathSelection: vi.fn(function () {
    return m.mockPathSelectionInstance;
  }),
}));

const {
  initializeApp,
  mockAirportManagerInstance,
  mockLayerManagerInstance,
  mockPathSelectionInstance,
  mockStateManagerInstance,
  mockStatsManagerInstance,
  resetManagerMocks,
  setupDOM,
} = m;

function createApp(): MapApp {
  return new MapApp({ ...m.APP_CONFIG });
}

/** The mock behind `app.map`, for what the real type does not have */
function mockMap(app: MapApp): MockMap {
  return app.map as unknown as MockMap;
}

describe("MapApp controls and map", () => {
  let app: MapApp;

  beforeEach(() => {
    resetManagerMocks();
    mobileBarMock.mountFor.mockReturnValue(null);
    setupDOM();
    app = createApp();
  });

  afterEach(() => {
    app.destroy();
    document.body.innerHTML = "";
    resetMapLibreMock();
  });

  describe("store-driven buttons", () => {
    // Replay lives in the lazily loaded feature bundle, so the app itself
    // keeps its control showing whether replay is available; it has to say
    // so from the first paint, before anyone has opened replay
    it("dims the replay control until one timed flight is selected", async () => {
      await initializeApp(app);
      const btn = document.getElementById("replay-btn") as HTMLButtonElement;

      expect(btn.style.opacity).toBe("0.5");
      expect(btn.title).toBe(
        "Select exactly one flight with timing data to replay",
      );

      app.selectedPathIds.add(1);
      app.store.notifyMutation("selectedPathIds");

      expect(btn.style.opacity).toBe("1");
      expect(btn.title).toBe("Replay selected flight path");
    });

    it("follows the timing data of the loaded metadata", async () => {
      await initializeApp(app);
      app.selectedPathIds.add(1);
      app.store.notifyMutation("selectedPathIds");
      const btn = document.getElementById("replay-btn") as HTMLButtonElement;
      expect(btn.style.opacity).toBe("1");

      app.hasTimingData = false;

      expect(btn.style.opacity).toBe("0.5");
    });

    it("reflects a selection restored before the first paint", async () => {
      mockStateManagerInstance.loadState.mockReturnValue({
        selectedPathIds: [1],
      });

      await initializeApp(app);

      const btn = document.getElementById("replay-btn") as HTMLButtonElement;
      expect(btn.style.opacity).toBe("1");
    });

    it("reflects the restored visibility state in the toggle buttons", async () => {
      mockStateManagerInstance.loadState.mockReturnValue({
        heatmapVisible: false,
        altitudeVisible: true,
        airportsVisible: false,
        aviationVisible: true,
      });

      await initializeApp(app);

      const state = (id: string): [string | null, boolean, string] => {
        const el = document.getElementById(id)!;
        return [
          el.getAttribute("aria-pressed"),
          el.classList.contains("active"),
          el.style.opacity,
        ];
      };
      expect(state("heatmap-btn")).toEqual(["false", false, "0.5"]);
      expect(state("altitude-btn")).toEqual(["true", true, "1"]);
      expect(state("airports-btn")).toEqual(["false", false, "0.5"]);
      expect(state("aviation-btn")).toEqual(["true", true, "1"]);
    });

    it("updates buttons when the store changes after initialization", async () => {
      await initializeApp(app);

      app.heatmapVisible = false;
      app.altitudeVisible = true;

      expect(
        document.getElementById("heatmap-btn")!.getAttribute("aria-pressed"),
      ).toBe("false");
      expect(
        document.getElementById("altitude-btn")!.getAttribute("aria-pressed"),
      ).toBe("true");
    });

    it("leaves the isolate button to the path selection", async () => {
      mockStateManagerInstance.loadState.mockReturnValue({
        selectedPathIds: [1],
        isolateSelection: true,
      });

      await initializeApp(app);

      // PathSelection subscribes to both keys itself; MapApp writes nothing
      const isolate = document.getElementById("isolate-btn")!;
      expect(isolate.getAttribute("aria-pressed")).toBeNull();
      expect(isolate.style.opacity).toBe("");
    });
  });

  describe("statistics rail", () => {
    it("stays closed while the statistics are hidden", async () => {
      await initializeApp(app);

      expect(document.getElementById("stats-rail")!.hidden).toBe(true);
      expect(document.body.classList.contains("stats-open")).toBe(false);
    });

    it("opens the rail and remeasures the map", async () => {
      await initializeApp(app);
      vi.mocked(resizeMapAfterTransition).mockClear();

      const column = document.getElementById("left-buttons")!;
      // The column's own layout and its labels, not the per-button state
      // that the Statistics trigger legitimately gains when the rail opens
      const shape = () => ({
        className: column.className,
        labels: [...column.querySelectorAll(".control-label")].map(
          (el) => el.textContent,
        ),
        iconWidths: [...column.querySelectorAll("svg.icon")].map((el) =>
          el.getAttribute("width"),
        ),
      });
      const before = shape();

      app.store.set("statsPanelVisible", true);

      expect(document.getElementById("stats-rail")!.hidden).toBe(false);
      expect(document.body.classList.contains("stats-open")).toBe(true);
      expect(resizeMapAfterTransition).toHaveBeenCalledWith(
        app.map,
        document.getElementById("map"),
      );
      // The column is left alone; the stylesheet slides it past the rail
      expect(shape()).toEqual(before);

      app.store.set("statsPanelVisible", false);

      expect(document.getElementById("stats-rail")!.hidden).toBe(true);
      expect(document.body.classList.contains("stats-open")).toBe(false);
      expect(shape()).toEqual(before);
    });

    it("marks both triggers expanded and accents the statistics row", async () => {
      await initializeApp(app);
      const statsBtn = document.getElementById("stats-btn")!;
      const collapseBtn = document.getElementById("stats-collapse-btn")!;

      expect(statsBtn.getAttribute("aria-expanded")).toBe("false");
      expect(statsBtn.classList.contains("active")).toBe(false);

      app.store.set("statsPanelVisible", true);

      expect(statsBtn.getAttribute("aria-expanded")).toBe("true");
      expect(collapseBtn.getAttribute("aria-expanded")).toBe("true");
      expect(statsBtn.classList.contains("active")).toBe(true);

      app.store.set("statsPanelVisible", false);

      expect(statsBtn.getAttribute("aria-expanded")).toBe("false");
      expect(collapseBtn.getAttribute("aria-expanded")).toBe("false");
      expect(statsBtn.classList.contains("active")).toBe(false);
    });

    it("hands focus back to the trigger when the collapse button hides", async () => {
      await initializeApp(app);
      app.store.set("statsPanelVisible", true);
      document.getElementById("stats-collapse-btn")!.focus();

      app.store.set("statsPanelVisible", false);

      expect(document.activeElement).toBe(document.getElementById("stats-btn"));
    });

    it("hands focus back from the panel too", async () => {
      await initializeApp(app);
      app.store.set("statsPanelVisible", true);
      document.getElementById("stats-panel")!.focus();

      app.store.set("statsPanelVisible", false);

      expect(document.activeElement).toBe(document.getElementById("stats-btn"));
    });

    it("leaves focus alone when it is outside the rail", async () => {
      await initializeApp(app);
      app.store.set("statsPanelVisible", true);
      const heatmapBtn = document.getElementById("heatmap-btn")!;
      heatmapBtn.focus();

      app.store.set("statsPanelVisible", false);

      expect(document.activeElement).toBe(heatmapBtn);
    });

    it("restores an open rail from the saved state", async () => {
      mockStatsManagerInstance.setStatsPanelVisible.mockImplementation(
        (visible: boolean) => app.store.set("statsPanelVisible", visible),
      );
      mockStateManagerInstance.loadState.mockReturnValue({
        statsPanelVisible: true,
      });

      await initializeApp(app);

      expect(document.getElementById("stats-rail")!.hidden).toBe(false);
      expect(document.body.classList.contains("stats-open")).toBe(true);
      mockStatsManagerInstance.setStatsPanelVisible.mockReset();
    });
  });

  describe("the lazily loaded features", () => {
    it("says so when the bundle cannot be fetched", async () => {
      await initializeApp(app);
      vi.mocked(loadFeatures).mockResolvedValueOnce(null);

      const manager = await app.loadReplay();

      // Not a dead control: a click that loads nothing has to explain itself
      expect(manager).toBeUndefined();
      expect(showToast).toHaveBeenCalledWith(
        FEATURES_UNAVAILABLE_MESSAGE,
        "error",
      );
    });

    it("hands both callers the same manager and builds it once", async () => {
      await initializeApp(app);

      const [first, second] = await Promise.all([
        app.loadReplay(),
        app.loadReplay(),
      ]);

      expect(first).toBe(second);
      expect(first).toBeDefined();
    });

    it("opens replay once for quick clicks while the bundle loads", async () => {
      await initializeApp(app);
      let deliver: () => void = () => {};
      const bundle = await loadFeatures();
      vi.mocked(loadFeatures).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            deliver = () => resolve(bundle);
          }),
      );
      m.mockReplayManagerInstance.toggleReplay.mockClear();

      // Each click used to queue a toggle; two of them opened replay and
      // closed it again as soon as the bundle arrived
      app.toggleReplay();
      app.toggleReplay();
      deliver();
      await vi.waitFor(() => expect(app.replayManager).toBeDefined());
      await Promise.resolve();

      expect(m.mockReplayManagerInstance.toggleReplay).toHaveBeenCalledTimes(1);

      // Once it is there, every click toggles
      app.toggleReplay();
      expect(m.mockReplayManagerInstance.toggleReplay).toHaveBeenCalledTimes(2);
    });

    it("keeps the manager once it has been built", async () => {
      await initializeApp(app);
      const first = await app.loadWrapped();

      vi.mocked(loadFeatures).mockClear();
      const second = await app.loadWrapped();

      expect(second).toBe(first);
      expect(loadFeatures).not.toHaveBeenCalled();
    });
  });

  describe("replay availability", () => {
    function replayButton(): HTMLButtonElement {
      return document.getElementById("replay-btn") as HTMLButtonElement;
    }

    it("is not offered for a flight whose times are all 0", async () => {
      await initializeApp(app, m.defaultAirports, m.defaultMetadata, {
        ...m.defaultData,
        path_segments: [{ path_id: 1, altitude_ft: 5000, time: 0 }],
      });

      app.selectedPathIds.add(1);
      app.store.notifyMutation("selectedPathIds");

      // It would finish the moment it started, with nothing drawn
      expect(app.canReplay()).toBe(false);
      expect(replayButton().style.opacity).toBe("0.5");
    });

    it("leaves the button to a running replay", async () => {
      await initializeApp(app);
      app.selectedPathIds.add(1);
      app.store.notifyMutation("selectedPathIds");
      replayButton().title = "Stop replay";
      app.replayState.active = true;

      app.selectedPathIds.clear();
      app.store.notifyMutation("selectedPathIds");

      expect(replayButton().style.opacity).toBe("1");
      expect(replayButton().title).toBe("Stop replay");
    });
  });

  describe("destroy", () => {
    it("takes down the listeners it set up", async () => {
      await initializeApp(app);
      const map = mockMap(app);
      const statsListener = vi.fn();
      app.store.subscribe("statsPanelVisible", statsListener);
      const signal = app.signal;
      for (const type of ["moveend", "zoomend", "click", "error"]) {
        expect(map.listenerCount(type)).toBe(1);
      }

      app.destroy();

      expect(signal.aborted).toBe(true);
      for (const type of ["moveend", "zoomend", "click", "error"]) {
        expect(map.listenerCount(type)).toBe(0);
      }
      expect(mockStateManagerInstance.cancelSave).toHaveBeenCalled();
      expect(m.mockDataManagerInstance.destroy).toHaveBeenCalled();
      app.store.set("statsPanelVisible", true);
      expect(statsListener).not.toHaveBeenCalled();
      // The map itself stays as it is
      expect(map.remove).not.toHaveBeenCalled();
    });

    it("loads nothing once destroyed while the style was on its way", async () => {
      mockControl.autoLoadStyle = false;
      const pending = initializeApp(app);
      await Promise.resolve();

      app.destroy();
      mockMap(app).finishStyleLoad();
      await pending;

      expect(m.mockDataManagerInstance.loadAirports).not.toHaveBeenCalled();
    });

    it("drops a Replay click still waiting for the bundle", async () => {
      await initializeApp(app);
      let deliver: () => void = () => {};
      const bundle = await loadFeatures();
      vi.mocked(loadFeatures).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            deliver = () => resolve(bundle);
          }),
      );
      m.mockReplayManagerInstance.toggleReplay.mockClear();

      app.toggleReplay();
      app.destroy();
      deliver();
      await vi.waitFor(() => expect(app.replayManager).toBeDefined());
      await Promise.resolve();

      expect(m.mockReplayManagerInstance.toggleReplay).not.toHaveBeenCalled();
    });
  });

  describe("map event handlers", () => {
    const click = { point: { x: 10, y: 20 }, lngLat: { lng: 8.5, lat: 50.5 } };

    it("schedules a state save on move and zoom", async () => {
      await initializeApp(app);

      mockMap(app).emit("moveend");
      mockMap(app).emit("zoomend");

      expect(mockStateManagerInstance.scheduleSave).toHaveBeenCalledTimes(2);
      expect(
        mockAirportManagerInstance.updateAirportMarkerSizes,
      ).toHaveBeenCalledTimes(2);
    });

    it("clears the selection on map click outside replay", async () => {
      await initializeApp(app);
      app.selectedPathIds.add(1);

      mockMap(app).emit("click", click);

      expect(mockLayerManagerInstance.hitTest).toHaveBeenCalledWith(
        click.point,
      );
      expect(mockPathSelectionInstance.clearSelection).toHaveBeenCalledTimes(1);
    });

    it("does not clear an empty selection", async () => {
      await initializeApp(app);

      mockMap(app).emit("click", click);

      expect(mockPathSelectionInstance.clearSelection).not.toHaveBeenCalled();
    });

    it("hands a click on a flight to the layer manager instead of clearing", async () => {
      await initializeApp(app);
      app.selectedPathIds.add(1);
      const hit = { pathId: 2, segment: { path_id: 2 } };
      mockLayerManagerInstance.hitTest.mockReturnValue(hit);

      mockMap(app).emit("click", click);

      expect(mockLayerManagerInstance.onPathClick).toHaveBeenCalledWith(
        hit,
        click.lngLat,
      );
      expect(mockPathSelectionInstance.clearSelection).not.toHaveBeenCalled();
    });

    it("closes the airplane popup during replay instead of clearing", async () => {
      await initializeApp(app);
      app.selectedPathIds.add(1);
      const closePopup = vi.fn();
      app.replayState.active = true;
      app.replayState.airplaneMarker = {
        isPopupOpen: () => true,
        closePopup,
      } as unknown as MapApp["replayState"]["airplaneMarker"];

      mockMap(app).emit("click", click);

      expect(closePopup).toHaveBeenCalledTimes(1);
      expect(mockPathSelectionInstance.clearSelection).not.toHaveBeenCalled();
      // The colour layers are hidden during a replay
      expect(mockLayerManagerInstance.hitTest).not.toHaveBeenCalled();
    });
  });

  describe("map setup", () => {
    it("creates the map in its own zoom units, north up and flat", async () => {
      await initializeApp(app);

      // One below the 1 to 20 that saved state and links are clamped to
      expect(mockMap(app).options).toMatchObject({
        container: "map",
        style:
          "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
        minZoom: 0,
        maxZoom: 19,
        attributionControl: false,
        dragRotate: false,
        pitchWithRotate: false,
        touchPitch: false,
        rollEnabled: false,
        maxPitch: 0,
      });
      expect(mockMap(app).options["transformRequest"]).toBeNull();
      expect(
        mockMap(app).touchZoomRotate.disableRotation,
      ).toHaveBeenCalledOnce();
      expect(mockMap(app).keyboard.disableRotation).toHaveBeenCalledOnce();
    });

    it("adds an attribution that stays expanded, bottom right", async () => {
      await initializeApp(app);

      const [{ control, position }] = mockMap(app).controls as [
        { control: AttributionControl; position: string },
      ];
      expect(control).toBeInstanceOf(AttributionControl);
      expect(control.options).toEqual({ compact: false });
      expect(position).toBe("bottom-right");
    });

    it("creates every layer once, in drawing order below the labels", async () => {
      await initializeApp(app);

      expect(mockMap(app).getLayersOrder()).toEqual([
        "background",
        "aviation",
        "heat",
        "heat-detail-1",
        "heat-detail-2",
        "heat-detail-3",
        "replay-route",
        "paths-altitude",
        "paths-airspeed",
        "paths-altitude-selected",
        "paths-airspeed-selected",
        "replay-trail",
        "place-labels",
      ]);
      // Empty until the managers fill them
      for (const id of [
        "heat",
        "replay-route",
        "paths-altitude",
        "paths-airspeed",
        "paths-altitude-selected",
        "paths-airspeed-selected",
        "replay-trail",
      ]) {
        expect(mockMap(app).source(id).data).toEqual({
          type: "FeatureCollection",
          features: [],
        });
      }
    });

    it("lets MapLibre simplify the paths the way the app used to", async () => {
      await initializeApp(app);

      for (const id of ["paths-altitude", "paths-altitude-selected"]) {
        expect(mockMap(app).source(id).spec).toMatchObject({
          tolerance: 0.25,
          maxzoom: 14,
        });
      }
      expect(mockMap(app).layer("paths-altitude").paint).toEqual({
        "line-color": ["get", "color"],
        "line-width": 4,
        "line-opacity": 0.85,
      });
      expect(mockMap(app).layer("paths-altitude-selected").paint).toMatchObject(
        { "line-width": 6, "line-opacity": 1 },
      );
    });

    it("limits the aviation overlay to the zooms it still reads at", async () => {
      await initializeApp(app);

      // The overlay needs no key, and `latest` follows the AIRAC cycle, so
      // the URL carries neither
      expect(mockMap(app).source("aviation").spec).toEqual({
        type: "raster",
        tiles: [
          "https://nwy-tiles-api.prod.newaydata.com/tiles/{z}/{x}/{y}.png?path=latest/aero/latest",
        ],
        tileSize: 256,
        // Tile levels: a 256 pixel tile of level 7 is shown at map zoom 6
        minzoom: 7,
        maxzoom: 12,
        attribution: expect.stringContaining("open flightmaps") as string,
      });
      // Map zooms: two levels past the native 11 is as far as the tiles
      // stretch before they are only a blur, and maxzoom is exclusive
      expect(mockMap(app).layer("aviation")).toMatchObject({
        minzoom: 6,
        maxzoom: 13.01,
      });
    });

    it("resolves mapReady with the map once the layers are on it", async () => {
      mockControl.autoLoadStyle = false;
      const pending = initializeApp(app);
      const ready = vi.fn((map: unknown) => {
        expect((map as MockMap).getLayer("replay-trail")).toBeDefined();
      });
      void app.mapReady.then(ready);
      await Promise.resolve();

      expect(ready).not.toHaveBeenCalled();
      expect(m.mockDataManagerInstance.loadAirports).not.toHaveBeenCalled();

      mockMap(app).finishStyleLoad();
      await pending;

      expect(ready).toHaveBeenCalledWith(app.map);
      expect(m.mockDataManagerInstance.loadAirports).toHaveBeenCalled();
    });

    it("remembers a visibility asked for before the style has loaded", async () => {
      mockControl.autoLoadStyle = false;
      const pending = initializeApp(app);
      await Promise.resolve();

      app.heatmapLayer.setVisible(true);
      expect(app.heatmapLayer.isVisible()).toBe(true);

      mockMap(app).finishStyleLoad();
      await pending;

      expect(mockMap(app).layer("heat").layout["visibility"]).toBe("visible");
    });

    it("lists the drawn paths through the provider the layer manager sets", () => {
      const entry = {
        pathId: 1,
        options: { color: "#ff0000", weight: 4, opacity: 0.85 },
      };

      expect(app.altitudeLayer.getLayers()).toEqual([]);
      app.altitudeLayer.setLayersProvider(() => [entry]);
      expect(app.altitudeLayer.getLayers()).toEqual([entry]);
      expect(app.airspeedLayer.getLayers()).toEqual([]);
      app.altitudeLayer.setLayersProvider(null);
      expect(app.altitudeLayer.getLayers()).toEqual([]);
    });

    it("falls back to a style that needs no network when the base style fails", async () => {
      mockControl.autoLoadStyle = false;
      const pending = initializeApp(app);
      await Promise.resolve();
      const map = mockMap(app);

      map.emit("error", { error: new Error("Failed to fetch") });
      // A second failure of the same load must not swap again
      map.emit("error", { error: new Error("Failed to fetch") });

      expect(map.setStyle).toHaveBeenCalledExactlyOnceWith(FALLBACK_STYLE, {
        diff: false,
      });
      expect(logError).toHaveBeenCalledWith(
        "Base map style failed to load: Failed to fetch",
      );

      map.finishStyleLoad(FALLBACK_STYLE);
      await pending;

      // No labels to stay below, so the data layers go on top
      expect(map.getLayersOrder().slice(0, 2)).toEqual([
        "background",
        "aviation",
      ]);
      expect(m.mockDataManagerInstance.loadAirports).toHaveBeenCalled();
    });

    it("logs what fails later and keeps the style", async () => {
      await initializeApp(app);

      mockMap(app).emit("error", { error: new Error("tile 5/1/2 failed") });
      mockMap(app).emit("error", { error: "no message" });

      expect(logError).toHaveBeenCalledWith("Map error: tile 5/1/2 failed");
      expect(logError).toHaveBeenCalledWith("Map error: no message");
      expect(mockMap(app).setStyle).not.toHaveBeenCalled();
    });

    it.each([
      [false, 300],
      [true, 0],
    ])(
      "creates the map for reduced motion %s with a fade of %s ms",
      async (reduced, fadeDuration) => {
        // MapLibre cuts its camera moves and the glide after a drag short by
        // itself when told; the tile fade is the one thing it keeps
        const spy = vi
          .spyOn(motion, "prefersReducedMotion")
          .mockReturnValue(reduced);

        await initializeApp(app);

        expect(lastMap().options).toMatchObject({
          reduceMotion: reduced,
          fadeDuration,
        });
        spy.mockRestore();
      },
    );

    it("hands the map's canvas the focus the rail gives up as a last resort", async () => {
      await initializeApp(app);
      app.store.set("statsPanelVisible", true);
      document.getElementById("stats-btn")!.remove();
      document.getElementById("stats-collapse-btn")!.focus();

      app.store.set("statsPanelVisible", false);

      expect(document.activeElement).toBe(mockMap(app).getCanvas());
    });

    describe("with a CARTO API key", () => {
      it("puts the key on the style URL", async () => {
        const appWithCarto = new MapApp({
          ...m.APP_CONFIG,
          cartoApiKey: "carto key",
        });

        await initializeApp(appWithCarto);

        expect(lastMap().options["style"]).toBe(
          "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json?key=carto%20key",
        );
        expect(lastMap().options["transformRequest"]).toBeTypeOf("function");
        appWithCarto.destroy();
      });

      it("puts the key on every other request to CARTO", () => {
        const transform = cartoTransformRequest("carto-key")!;

        expect(
          transform("https://tiles-a.basemaps.cartocdn.com/vector/1/2/3.mvt"),
        ).toEqual({
          url: "https://tiles-a.basemaps.cartocdn.com/vector/1/2/3.mvt?key=carto-key",
        });
        expect(
          transform(
            "https://tiles.basemaps.cartocdn.com/fonts/a/0-255.pbf?v=1",
          ),
        ).toEqual({
          url: "https://tiles.basemaps.cartocdn.com/fonts/a/0-255.pbf?v=1&key=carto-key",
        });
        expect(
          transform("https://basemaps.cartocdn.com/gl/sprite.json"),
        ).toEqual({
          url: "https://basemaps.cartocdn.com/gl/sprite.json?key=carto-key",
        });
      });

      it("leaves everything else alone", () => {
        const transform = cartoTransformRequest("carto-key")!;

        // Already keyed, another host, a lookalike host, a relative URL
        expect(
          transform("https://basemaps.cartocdn.com/style.json?key=other"),
        ).toBeUndefined();
        expect(
          transform(
            "https://nwy-tiles-api.prod.newaydata.com/tiles/7/1/2.png?path=x",
          ),
        ).toBeUndefined();
        expect(
          transform("https://evilbasemaps.cartocdn.com/1/2/3.mvt"),
        ).toBeUndefined();
        expect(transform("data/2025.json")).toBeUndefined();
      });

      it("transforms nothing without a key", () => {
        expect(cartoTransformRequest()).toBeNull();
        expect(cartoTransformRequest("")).toBeNull();
      });
    });
  });
});
