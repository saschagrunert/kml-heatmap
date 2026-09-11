/**
 * MapApp: store-driven controls, the statistics rail, map events and setup.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import * as L from "leaflet";
import { MapApp } from "../../../../kml_heatmap/frontend/mapApp";
import { invalidateMapAfterTransition } from "../../../../kml_heatmap/frontend/utils/mapHelpers";

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
    cacheElements: vi.fn(),
    get: vi.fn((id: string, ctor?: new () => HTMLElement) => {
      const element = document.getElementById(id);
      if (!element || !ctor) return element;
      return element instanceof ctor ? element : null;
    }),
    clear: vi.fn(),
  },
}));
vi.mock("../../../../kml_heatmap/frontend/utils/mapHelpers", () => ({
  invalidateMapAfterTransition: vi.fn(),
}));
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
  mockPathSelectionInstance,
  mockReplayManagerInstance,
  mockStateManagerInstance,
  mockStatsManagerInstance,
  resetManagerMocks,
  setupDOM,
} = m;

function createApp(openaipApiKey?: string): MapApp {
  return new MapApp({ ...m.APP_CONFIG, openaipApiKey });
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
  });

  describe("store-driven buttons", () => {
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
      vi.mocked(invalidateMapAfterTransition).mockClear();

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
      expect(invalidateMapAfterTransition).toHaveBeenCalledWith(
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

  describe("map event handlers", () => {
    function handler(event: string): (e?: unknown) => void {
      const on = vi.mocked(app.map!.on) as unknown as {
        mock: { calls: unknown[][] };
      };
      const call = on.mock.calls.find((c) => c[0] === event);
      return call![1] as (e?: unknown) => void;
    }

    it("schedules a state save on move and zoom", async () => {
      await initializeApp(app);

      handler("moveend")();
      handler("zoomend")();

      expect(mockStateManagerInstance.scheduleSave).toHaveBeenCalledTimes(2);
      expect(
        mockAirportManagerInstance.updateAirportMarkerSizes,
      ).toHaveBeenCalledTimes(2);
    });

    it("clears the selection on map click outside replay", async () => {
      await initializeApp(app);
      app.selectedPathIds.add(1);

      handler("click")({});

      expect(mockPathSelectionInstance.clearSelection).toHaveBeenCalledTimes(1);
    });

    it("does not clear an empty selection", async () => {
      await initializeApp(app);

      handler("click")({});

      expect(mockPathSelectionInstance.clearSelection).not.toHaveBeenCalled();
    });

    it("closes the airplane popup during replay instead of clearing", async () => {
      await initializeApp(app);
      app.selectedPathIds.add(1);
      const closePopup = vi.fn();
      mockReplayManagerInstance.state.active = true;
      mockReplayManagerInstance.state.airplaneMarker = {
        isPopupOpen: () => true,
        closePopup,
      };

      handler("click")({});

      expect(closePopup).toHaveBeenCalledTimes(1);
      expect(mockPathSelectionInstance.clearSelection).not.toHaveBeenCalled();
    });
  });

  describe("map setup", () => {
    it("creates the map with the shared zoom limits and tile layers", async () => {
      const appWithKey = createApp("key");
      await initializeApp(appWithKey);

      expect(L.map).toHaveBeenCalledWith(
        "map",
        expect.objectContaining({
          minZoom: 1,
          maxZoom: 20,
          preferCanvas: true,
          // Pinch, scroll and double tap cover zooming
          zoomControl: false,
        }),
      );
      expect(L.tileLayer).toHaveBeenCalledWith(
        expect.stringContaining("basemaps.cartocdn.com"),
        expect.objectContaining({ maxZoom: 20 }),
      );
      expect(L.tileLayer).toHaveBeenCalledWith(
        expect.stringContaining("openaip.net"),
        expect.objectContaining({ maxZoom: 20, maxNativeZoom: 18 }),
      );
      appWithKey.destroy();
    });

    it("appends the CARTO API key to the tile URL when configured", async () => {
      const appWithCarto = new MapApp({
        ...m.APP_CONFIG,
        cartoApiKey: "carto-key",
      });

      await initializeApp(appWithCarto);

      expect(L.tileLayer).toHaveBeenCalledWith(
        expect.stringContaining("?key=carto-key"),
        expect.anything(),
      );
      appWithCarto.destroy();
    });
  });
});
