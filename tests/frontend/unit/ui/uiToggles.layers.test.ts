/**
 * UIToggles: the layer toggles. The buttons and legends follow the store,
 * so the store sync is wired here the way MapApp wires it, and the tests
 * read the resulting DOM.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { UIToggles } from "../../../../kml_heatmap/frontend/ui/uiToggles";
import type { HeatmapLayer } from "../../../../kml_heatmap/frontend/globals";
import {
  LayerManager,
  type LayerMode,
} from "../../../../kml_heatmap/frontend/ui/layerManager";
import {
  asMapApp,
  createDataset,
  createMockApp,
  createSegment,
  el,
  mountElements,
  syncControlsWithStore,
  type MockApp,
} from "../../testHelpers";

const DOM: Record<string, string> = {
  "heatmap-btn": "button",
  "altitude-btn": "button",
  "airspeed-btn": "button",
  "airports-btn": "button",
  "aviation-btn": "button",
  "altitude-legend": "div",
  "airspeed-legend": "div",
  map: "div",
};

describe("UIToggles layers", () => {
  let uiToggles: UIToggles;
  let app: MockApp;
  let heatmap: HeatmapLayer;
  let unmount: () => void;

  beforeEach(() => {
    unmount = mountElements(DOM);
    app = createMockApp();
    heatmap = {
      addTo: vi.fn(),
      remove: vi.fn(),
      setLatLngs: vi.fn(),
    } as unknown as HeatmapLayer;
    app.heatmapLayer = heatmap;
    syncControlsWithStore(app.store);
    uiToggles = new UIToggles(asMapApp(app));
  });

  afterEach(() => {
    unmount();
    vi.restoreAllMocks();
  });

  describe("toggleHeatmap", () => {
    it("hides the heatmap and the store dims the button", () => {
      app.heatmapVisible = true;

      uiToggles.toggleHeatmap();

      expect(app.map!.removeLayer).toHaveBeenCalledWith(heatmap);
      expect(app.heatmapVisible).toBe(false);
      expect(el("heatmap-btn").style.opacity).toBe("0.5");
      expect(el("heatmap-btn").getAttribute("aria-pressed")).toBe("false");
    });

    it("shows the heatmap and the store lights the button", () => {
      app.heatmapVisible = false;

      uiToggles.toggleHeatmap();

      expect(app.map!.addLayer).toHaveBeenCalledWith(heatmap);
      expect(app.heatmapVisible).toBe(true);
      expect(el("heatmap-btn").style.opacity).toBe("1");
      expect(el("heatmap-btn").getAttribute("aria-pressed")).toBe("true");
    });

    it("hands the layer to the data manager, which feeds it the points it missed", () => {
      app.heatmapVisible = false;

      uiToggles.toggleHeatmap();

      expect(app.dataManager.showHeatmap).toHaveBeenCalledTimes(1);
    });

    it("does not hand the layer over when hiding it", () => {
      uiToggles.toggleHeatmap();

      expect(app.heatmapVisible).toBe(false);
      expect(app.dataManager.showHeatmap).not.toHaveBeenCalled();
    });

    it("does nothing without a map", () => {
      app.map = null;

      uiToggles.toggleHeatmap();

      expect(app.heatmapVisible).toBe(true);
    });
  });

  describe("toggleAltitude", () => {
    it("shows altitude and hides airspeed when airspeed is visible", () => {
      app.altitudeVisible = false;
      app.airspeedVisible = true;

      uiToggles.toggleAltitude();

      expect(app.map!.removeLayer).toHaveBeenCalledWith(app.airspeedLayer);
      expect(app.airspeedVisible).toBe(false);
      expect(el("airspeed-btn").style.opacity).toBe("0.5");
      expect(el("airspeed-btn").getAttribute("aria-pressed")).toBe("false");
      expect(el("airspeed-legend").style.display).toBe("none");

      expect(app.map!.addLayer).toHaveBeenCalledWith(app.altitudeLayer);
      expect(app.altitudeVisible).toBe(true);
      expect(el("altitude-btn").style.opacity).toBe("1");
      expect(el("altitude-btn").getAttribute("aria-pressed")).toBe("true");
      expect(el("altitude-legend").style.display).toBe("block");
      expect(app.layerManager.redrawAltitudePaths).toHaveBeenCalled();
      // The layer it replaces lets go of its polylines
      expect(app.layerManager.clearLayer).toHaveBeenCalledExactlyOnceWith(
        "airspeed",
      );
    });

    it("hides altitude when visible", () => {
      app.altitudeVisible = true;

      uiToggles.toggleAltitude();

      expect(app.map!.removeLayer).toHaveBeenCalledWith(app.altitudeLayer);
      expect(app.altitudeVisible).toBe(false);
      expect(el("altitude-btn").style.opacity).toBe("0.5");
      expect(el("altitude-legend").style.display).toBe("none");
      // Kept, the polylines of a hidden layer held tens of MB
      expect(app.layerManager.clearLayer).toHaveBeenCalledExactlyOnceWith(
        "altitude",
      );
    });

    it("rebuilds a layer that was hidden when it is shown again", () => {
      const data = createDataset(
        [{ id: 1, year: 2025 }],
        [
          createSegment({
            coords: [
              [48, 16],
              [48.1, 16.1],
            ],
          }),
        ],
      );
      app.currentData = data;
      app.altitudeRange = { min: 0, max: 5000 };
      const layers = new LayerManager(asMapApp(app));
      app.layerManager.redrawAltitudePaths.mockImplementation(() =>
        layers.redrawAltitudePaths(),
      );
      app.layerManager.clearLayer.mockImplementation((mode: LayerMode) =>
        layers.clearLayer(mode),
      );

      uiToggles.toggleAltitude();
      expect(app.altitudeLayer.layers.size).toBe(1);

      uiToggles.toggleAltitude();
      expect(app.altitudeLayer.layers.size).toBe(0);

      uiToggles.toggleAltitude();
      expect(app.altitudeLayer.layers.size).toBe(1);
      expect(app.map!.hasLayer(app.altitudeLayer)).toBe(true);
    });

    it("shows altitude without airspeed conflict", () => {
      uiToggles.toggleAltitude();

      expect(app.map!.addLayer).toHaveBeenCalledWith(app.altitudeLayer);
      expect(app.altitudeVisible).toBe(true);
      expect(app.layerManager.redrawAltitudePaths).toHaveBeenCalled();
    });

    // The heatmap steps back under a colour layer, but the toggle does not
    // do it: MapApp.followHeatmapEmphasis() follows the two layer keys, so
    // a restored link and a replay get the same treatment for free. Covered
    // in mapApp.initialize.test.ts.

    it("does nothing without a map", () => {
      app.map = null;

      uiToggles.toggleAltitude();

      expect(app.altitudeVisible).toBe(false);
    });

    it("during replay turns altitude off without touching the hidden layer", () => {
      app.altitudeVisible = true;
      app.replayManager.state.active = true;

      uiToggles.toggleAltitude();

      // The trail is drawn by altitude either way, so no redraw
      expect(app.altitudeVisible).toBe(false);
      expect(app.map!.removeLayer).not.toHaveBeenCalled();
      // Off the map for the replay, and not coming back until shown again
      expect(app.layerManager.clearLayer).toHaveBeenCalledWith("altitude");
      expect(app.replayManager.redrawReplayPath).not.toHaveBeenCalled();
      expect(el("altitude-btn").getAttribute("aria-pressed")).toBe("false");
    });

    it("during replay does not add the layer but updates the state", () => {
      app.replayManager.state.active = true;

      uiToggles.toggleAltitude();

      expect(app.map!.addLayer).not.toHaveBeenCalled();
      expect(app.layerManager.redrawAltitudePaths).not.toHaveBeenCalled();
      expect(app.altitudeVisible).toBe(true);
      expect(el("altitude-legend").style.display).toBe("block");
    });

    it("during replay hides airspeed without removing the layer", () => {
      app.airspeedVisible = true;
      app.replayManager.state.active = true;

      uiToggles.toggleAltitude();

      expect(app.map!.removeLayer).not.toHaveBeenCalled();
      expect(app.airspeedVisible).toBe(false);
      expect(app.altitudeVisible).toBe(true);
    });

    it("during replay updates the airplane popup if it is open", () => {
      app.replayManager.state.active = true;
      app.replayManager.state.airplaneMarker = {
        isPopupOpen: vi.fn(() => true),
      } as never;

      uiToggles.toggleAltitude();

      expect(app.replayManager.updateReplayAirplanePopup).toHaveBeenCalled();
    });

    it("during replay delegates the redraw to the replay manager", () => {
      app.replayManager.state.active = true;

      uiToggles.toggleAltitude();

      expect(app.replayManager.redrawReplayPath).toHaveBeenCalledWith(
        "altitude",
      );
      expect(app.map!.addLayer).not.toHaveBeenCalled();
    });
  });

  describe("toggleAirspeed", () => {
    it("shows airspeed and hides altitude when altitude is visible", () => {
      app.altitudeVisible = true;

      uiToggles.toggleAirspeed();

      expect(app.map!.removeLayer).toHaveBeenCalledWith(app.altitudeLayer);
      expect(app.altitudeVisible).toBe(false);
      expect(el("altitude-btn").style.opacity).toBe("0.5");
      expect(el("altitude-legend").style.display).toBe("none");

      expect(app.map!.addLayer).toHaveBeenCalledWith(app.airspeedLayer);
      expect(app.airspeedVisible).toBe(true);
      expect(el("airspeed-btn").style.opacity).toBe("1");
      expect(el("airspeed-legend").style.display).toBe("block");
      expect(app.layerManager.redrawAirspeedPaths).toHaveBeenCalled();
    });

    it("hides airspeed when visible", () => {
      app.airspeedVisible = true;

      uiToggles.toggleAirspeed();

      expect(app.map!.removeLayer).toHaveBeenCalledWith(app.airspeedLayer);
      expect(app.airspeedVisible).toBe(false);
      expect(el("airspeed-btn").style.opacity).toBe("0.5");
      expect(el("airspeed-legend").style.display).toBe("none");
    });

    it("shows airspeed without altitude conflict", () => {
      uiToggles.toggleAirspeed();

      expect(app.map!.addLayer).toHaveBeenCalledWith(app.airspeedLayer);
      expect(app.airspeedVisible).toBe(true);
      expect(app.layerManager.redrawAirspeedPaths).toHaveBeenCalled();
    });

    it("does nothing without a map", () => {
      app.map = null;

      uiToggles.toggleAirspeed();

      expect(app.airspeedVisible).toBe(false);
    });

    it("during replay turns airspeed off and the trail falls back to altitude", () => {
      app.airspeedVisible = true;
      app.replayManager.state.active = true;

      uiToggles.toggleAirspeed();

      expect(app.airspeedVisible).toBe(false);
      expect(app.map!.removeLayer).not.toHaveBeenCalled();
      expect(app.replayManager.redrawReplayPath).toHaveBeenCalledWith(
        "altitude",
      );
    });

    it("during replay does not add the layer but updates the state", () => {
      app.replayManager.state.active = true;

      uiToggles.toggleAirspeed();

      expect(app.map!.addLayer).not.toHaveBeenCalled();
      expect(app.layerManager.redrawAirspeedPaths).not.toHaveBeenCalled();
      expect(app.airspeedVisible).toBe(true);
      expect(el("airspeed-legend").style.display).toBe("block");
    });

    it("during replay delegates the redraw to the replay manager", () => {
      app.replayManager.state.active = true;

      uiToggles.toggleAirspeed();

      expect(app.replayManager.redrawReplayPath).toHaveBeenCalledWith(
        "airspeed",
      );
    });
  });

  describe("toggleAirports", () => {
    it("hides airports when visible", () => {
      uiToggles.toggleAirports();

      expect(app.map!.removeLayer).toHaveBeenCalledWith(app.airportLayer);
      expect(app.airportsVisible).toBe(false);
      expect(el("airports-btn").style.opacity).toBe("0.5");
      expect(el("airports-btn").getAttribute("aria-pressed")).toBe("false");
    });

    it("shows airports when hidden", () => {
      app.airportsVisible = false;

      uiToggles.toggleAirports();

      expect(app.map!.addLayer).toHaveBeenCalledWith(app.airportLayer);
      expect(app.airportsVisible).toBe(true);
      expect(el("airports-btn").style.opacity).toBe("1");
      expect(el("airports-btn").getAttribute("aria-pressed")).toBe("true");
    });

    it("does nothing without a map", () => {
      app.map = null;

      uiToggles.toggleAirports();

      expect(app.airportsVisible).toBe(true);
    });
  });

  describe("toggleAviation", () => {
    it("shows the aviation layer when hidden", () => {
      app.aviationLayer = {} as never;

      uiToggles.toggleAviation();

      expect(app.map!.addLayer).toHaveBeenCalledWith(app.aviationLayer);
      expect(app.aviationVisible).toBe(true);
      expect(el("aviation-btn").getAttribute("aria-pressed")).toBe("true");
    });

    it("hides the aviation layer when visible", () => {
      app.aviationLayer = {} as never;
      app.aviationVisible = true;

      uiToggles.toggleAviation();

      expect(app.map!.removeLayer).toHaveBeenCalledWith(app.aviationLayer);
      expect(app.aviationVisible).toBe(false);
      expect(el("aviation-btn").getAttribute("aria-pressed")).toBe("false");
    });

    it("does nothing before the layer exists", () => {
      app.aviationLayer = null;

      uiToggles.toggleAviation();

      expect(app.map!.addLayer).not.toHaveBeenCalled();
      expect(app.aviationVisible).toBe(false);
    });

    it("does nothing without a map", () => {
      app.map = null;
      app.aviationLayer = {} as never;

      uiToggles.toggleAviation();

      expect(app.aviationVisible).toBe(false);
    });
  });
});
