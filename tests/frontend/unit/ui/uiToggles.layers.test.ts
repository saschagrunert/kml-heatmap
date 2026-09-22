/**
 * UIToggles: the layer toggles. The buttons and legends follow the store,
 * so the store sync is wired here the way MapApp wires it, and the tests
 * read the resulting DOM.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { UIToggles } from "../../../../kml_heatmap/frontend/ui/uiToggles";
import { AIRPORTS_HIDDEN_CLASS } from "../../../../kml_heatmap/frontend/mapLayers";
import { MAP_LAYERS } from "../../../../kml_heatmap/frontend/utils/constants";
import {
  asMapApp,
  createMockApp,
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
  let unmount: () => void;

  /** The `visibility` the map holds for a layer */
  const visibility = (id: string): unknown =>
    app.map!.layer(id).layout["visibility"];
  /** Put a layer on the map the way restored state or a toggle would have */
  const shown = (
    layer: "heatmap" | "altitude" | "airspeed" | "aviation",
  ): void => {
    app[`${layer}Layer`].setVisible(true);
    app[`${layer}Layer`].setVisible.mockClear();
  };

  beforeEach(() => {
    unmount = mountElements(DOM);
    app = createMockApp();
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
      shown("heatmap");

      uiToggles.toggleHeatmap();

      expect(app.heatmapLayer.setVisible).toHaveBeenCalledExactlyOnceWith(
        false,
      );
      expect(visibility(MAP_LAYERS.heat)).toBe("none");
      expect(app.heatmapVisible).toBe(false);
      expect(el("heatmap-btn").style.opacity).toBe("0.5");
      expect(el("heatmap-btn").getAttribute("aria-pressed")).toBe("false");
    });

    it("shows the heatmap and the store lights the button", () => {
      app.heatmapVisible = false;

      uiToggles.toggleHeatmap();

      expect(app.heatmapLayer.setVisible).toHaveBeenCalledWith(true);
      expect(app.heatmapLayer.setVisible).not.toHaveBeenCalledWith(false);
      expect(visibility(MAP_LAYERS.heat)).toBe("visible");
      expect(app.heatmapVisible).toBe(true);
      expect(el("heatmap-btn").style.opacity).toBe("1");
      expect(el("heatmap-btn").getAttribute("aria-pressed")).toBe("true");
    });

    it("hands the layer to the data manager, which dims it under a colour layer", () => {
      app.heatmapVisible = false;

      uiToggles.toggleHeatmap();

      expect(app.dataManager.showHeatmap).toHaveBeenCalledTimes(1);
    });

    it("writes the store last, once the layer is shown", () => {
      app.heatmapVisible = false;
      const seen: boolean[] = [];
      app.store.subscribe("heatmapVisible", () => {
        seen.push(app.heatmapLayer.isVisible());
        expect(app.dataManager.showHeatmap).toHaveBeenCalled();
      });

      uiToggles.toggleHeatmap();

      expect(seen).toEqual([true]);
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
      expect(app.heatmapLayer.setVisible).not.toHaveBeenCalled();
    });
  });

  describe("toggleAltitude", () => {
    it("shows altitude and hides airspeed when airspeed is visible", () => {
      app.altitudeVisible = false;
      app.airspeedVisible = true;
      shown("airspeed");

      uiToggles.toggleAltitude();

      expect(app.airspeedLayer.setVisible).toHaveBeenCalledExactlyOnceWith(
        false,
      );
      expect(visibility(MAP_LAYERS.pathsAirspeed)).toBe("none");
      expect(visibility(MAP_LAYERS.pathsAirspeedSelected)).toBe("none");
      expect(app.airspeedVisible).toBe(false);
      expect(el("airspeed-btn").style.opacity).toBe("0.5");
      expect(el("airspeed-btn").getAttribute("aria-pressed")).toBe("false");
      expect(el("airspeed-legend").hidden).toBe(true);

      expect(app.altitudeLayer.setVisible).toHaveBeenCalledExactlyOnceWith(
        true,
      );
      expect(visibility(MAP_LAYERS.pathsAltitude)).toBe("visible");
      expect(visibility(MAP_LAYERS.pathsAltitudeSelected)).toBe("visible");
      expect(app.altitudeVisible).toBe(true);
      expect(el("altitude-btn").style.opacity).toBe("1");
      expect(el("altitude-btn").getAttribute("aria-pressed")).toBe("true");
      expect(el("altitude-legend").hidden).toBe(false);
      expect(app.layerManager.redrawAltitudePaths).toHaveBeenCalled();
      // The layer it replaces lets go of its features
      expect(app.layerManager.clearLayer).toHaveBeenCalledExactlyOnceWith(
        "airspeed",
      );
    });

    it("hides altitude when visible", () => {
      app.altitudeVisible = true;
      shown("altitude");

      uiToggles.toggleAltitude();

      expect(app.altitudeLayer.setVisible).toHaveBeenCalledExactlyOnceWith(
        false,
      );
      expect(visibility(MAP_LAYERS.pathsAltitude)).toBe("none");
      expect(visibility(MAP_LAYERS.pathsAltitudeSelected)).toBe("none");
      expect(app.altitudeVisible).toBe(false);
      expect(el("altitude-btn").style.opacity).toBe("0.5");
      expect(el("altitude-legend").hidden).toBe(true);
      // Kept, the features of a hidden layer held tens of MB
      expect(app.layerManager.clearLayer).toHaveBeenCalledExactlyOnceWith(
        "altitude",
      );
    });

    it("rebuilds a layer that was hidden when it is shown again", () => {
      // What the layer manager holds for the layer, and whether the layer
      // was on the map when it changed
      const steps: string[] = [];
      const at = (step: string): void => {
        steps.push(`${step}:${app.altitudeLayer.isVisible() ? "on" : "off"}`);
      };
      app.layerManager.redrawAltitudePaths.mockImplementation(() =>
        at("redraw"),
      );
      app.layerManager.clearLayer.mockImplementation((mode: string) =>
        at(`clear ${mode}`),
      );

      uiToggles.toggleAltitude();
      uiToggles.toggleAltitude();
      uiToggles.toggleAltitude();

      // Drawn before it is shown, cleared after it is hidden
      expect(steps).toEqual(["redraw:off", "clear altitude:off", "redraw:off"]);
      expect(app.altitudeLayer.isVisible()).toBe(true);
      expect(visibility(MAP_LAYERS.pathsAltitude)).toBe("visible");
    });

    it("shows altitude without airspeed conflict", () => {
      uiToggles.toggleAltitude();

      expect(app.altitudeLayer.setVisible).toHaveBeenCalledExactlyOnceWith(
        true,
      );
      expect(visibility(MAP_LAYERS.pathsAltitude)).toBe("visible");
      expect(visibility(MAP_LAYERS.pathsAltitudeSelected)).toBe("visible");
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
      expect(app.altitudeLayer.setVisible).not.toHaveBeenCalled();
      // Hidden for the replay, and not coming back until shown again
      expect(app.layerManager.clearLayer).toHaveBeenCalledWith("altitude");
      expect(app.replayManager.redrawReplayPath).not.toHaveBeenCalled();
      expect(el("altitude-btn").getAttribute("aria-pressed")).toBe("false");
    });

    it("during replay does not add the layer but updates the state", () => {
      app.replayManager.state.active = true;

      uiToggles.toggleAltitude();

      expect(app.altitudeLayer.setVisible).not.toHaveBeenCalled();
      expect(visibility(MAP_LAYERS.pathsAltitude)).toBe("none");
      expect(app.layerManager.redrawAltitudePaths).not.toHaveBeenCalled();
      expect(app.altitudeVisible).toBe(true);
      expect(el("altitude-legend").hidden).toBe(false);
    });

    it("during replay hides airspeed without removing the layer", () => {
      app.airspeedVisible = true;
      app.replayManager.state.active = true;

      uiToggles.toggleAltitude();

      expect(app.airspeedLayer.setVisible).not.toHaveBeenCalled();
      expect(app.altitudeLayer.setVisible).not.toHaveBeenCalled();
      expect(app.airspeedVisible).toBe(false);
      expect(app.altitudeVisible).toBe(true);
      expect(app.layerManager.clearLayer).toHaveBeenCalledExactlyOnceWith(
        "airspeed",
      );
    });

    it("during replay updates the airplane popup if it is open", () => {
      app.replayManager.state.active = true;
      app.replayManager.state.airplaneMarker = {
        isPopupOpen: vi.fn(() => true),
      } as never;

      uiToggles.toggleAltitude();

      expect(app.replayManager.updateReplayAirplanePopup).toHaveBeenCalled();
    });

    it("during replay leaves a closed airplane popup alone", () => {
      app.replayManager.state.active = true;
      app.replayManager.state.airplaneMarker = {
        isPopupOpen: vi.fn(() => false),
      } as never;

      uiToggles.toggleAltitude();

      expect(
        app.replayManager.updateReplayAirplanePopup,
      ).not.toHaveBeenCalled();
    });

    it("during replay delegates the redraw to the replay manager", () => {
      app.replayManager.state.active = true;

      uiToggles.toggleAltitude();

      expect(app.replayManager.redrawReplayPath).toHaveBeenCalledWith(
        "altitude",
      );
      expect(app.altitudeLayer.setVisible).not.toHaveBeenCalled();
    });
  });

  describe("toggleAirspeed", () => {
    it("shows airspeed and hides altitude when altitude is visible", () => {
      app.altitudeVisible = true;
      shown("altitude");

      uiToggles.toggleAirspeed();

      expect(app.altitudeLayer.setVisible).toHaveBeenCalledExactlyOnceWith(
        false,
      );
      expect(visibility(MAP_LAYERS.pathsAltitude)).toBe("none");
      expect(visibility(MAP_LAYERS.pathsAltitudeSelected)).toBe("none");
      expect(app.altitudeVisible).toBe(false);
      expect(el("altitude-btn").style.opacity).toBe("0.5");
      expect(el("altitude-legend").hidden).toBe(true);

      expect(app.airspeedLayer.setVisible).toHaveBeenCalledExactlyOnceWith(
        true,
      );
      expect(visibility(MAP_LAYERS.pathsAirspeed)).toBe("visible");
      expect(visibility(MAP_LAYERS.pathsAirspeedSelected)).toBe("visible");
      expect(app.airspeedVisible).toBe(true);
      expect(el("airspeed-btn").style.opacity).toBe("1");
      expect(el("airspeed-legend").hidden).toBe(false);
      expect(app.layerManager.redrawAirspeedPaths).toHaveBeenCalled();
    });

    it("hides airspeed when visible", () => {
      app.airspeedVisible = true;
      shown("airspeed");

      uiToggles.toggleAirspeed();

      expect(app.airspeedLayer.setVisible).toHaveBeenCalledExactlyOnceWith(
        false,
      );
      expect(visibility(MAP_LAYERS.pathsAirspeed)).toBe("none");
      expect(visibility(MAP_LAYERS.pathsAirspeedSelected)).toBe("none");
      expect(app.airspeedVisible).toBe(false);
      expect(el("airspeed-btn").style.opacity).toBe("0.5");
      expect(el("airspeed-legend").hidden).toBe(true);
    });

    it("shows airspeed without altitude conflict", () => {
      uiToggles.toggleAirspeed();

      expect(app.airspeedLayer.setVisible).toHaveBeenCalledExactlyOnceWith(
        true,
      );
      expect(visibility(MAP_LAYERS.pathsAirspeed)).toBe("visible");
      expect(visibility(MAP_LAYERS.pathsAirspeedSelected)).toBe("visible");
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
      expect(app.airspeedLayer.setVisible).not.toHaveBeenCalled();
      expect(app.replayManager.redrawReplayPath).toHaveBeenCalledWith(
        "altitude",
      );
    });

    it("during replay does not add the layer but updates the state", () => {
      app.replayManager.state.active = true;

      uiToggles.toggleAirspeed();

      expect(app.airspeedLayer.setVisible).not.toHaveBeenCalled();
      expect(visibility(MAP_LAYERS.pathsAirspeed)).toBe("none");
      expect(app.layerManager.redrawAirspeedPaths).not.toHaveBeenCalled();
      expect(app.airspeedVisible).toBe(true);
      expect(el("airspeed-legend").hidden).toBe(false);
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

      expect(app.airportLayer.setVisible).toHaveBeenCalledExactlyOnceWith(
        false,
      );
      expect(el("map").classList.contains(AIRPORTS_HIDDEN_CLASS)).toBe(true);
      expect(app.airportsVisible).toBe(false);
      expect(el("airports-btn").style.opacity).toBe("0.5");
      expect(el("airports-btn").getAttribute("aria-pressed")).toBe("false");
    });

    it("shows airports when hidden", () => {
      app.airportsVisible = false;
      app.airportLayer.setVisible(false);
      app.airportLayer.setVisible.mockClear();

      uiToggles.toggleAirports();

      expect(app.airportLayer.setVisible).toHaveBeenCalledExactlyOnceWith(true);
      expect(el("map").classList.contains(AIRPORTS_HIDDEN_CLASS)).toBe(false);
      expect(app.airportsVisible).toBe(true);
      expect(el("airports-btn").style.opacity).toBe("1");
      expect(el("airports-btn").getAttribute("aria-pressed")).toBe("true");
    });

    it("does nothing without a map", () => {
      app.map = null;

      uiToggles.toggleAirports();

      expect(app.airportsVisible).toBe(true);
      expect(app.airportLayer.setVisible).not.toHaveBeenCalled();
    });
  });

  describe("toggleAviation", () => {
    it("shows the aviation layer when hidden", () => {
      uiToggles.toggleAviation();

      expect(app.aviationLayer.setVisible).toHaveBeenCalledExactlyOnceWith(
        true,
      );
      expect(visibility(MAP_LAYERS.aviation)).toBe("visible");
      expect(app.aviationVisible).toBe(true);
      expect(el("aviation-btn").getAttribute("aria-pressed")).toBe("true");
    });

    it("hides the aviation layer when visible", () => {
      app.aviationVisible = true;
      shown("aviation");

      uiToggles.toggleAviation();

      expect(app.aviationLayer.setVisible).toHaveBeenCalledExactlyOnceWith(
        false,
      );
      expect(visibility(MAP_LAYERS.aviation)).toBe("none");
      expect(app.aviationVisible).toBe(false);
      expect(el("aviation-btn").getAttribute("aria-pressed")).toBe("false");
    });

    it("does nothing without a map", () => {
      app.map = null;

      uiToggles.toggleAviation();

      expect(app.aviationLayer.setVisible).not.toHaveBeenCalled();
      expect(app.aviationVisible).toBe(false);
    });
  });
});
