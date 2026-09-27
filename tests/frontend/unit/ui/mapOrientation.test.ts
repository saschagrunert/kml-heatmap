import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  MapOrientation,
  THREE_D_HINT_MESSAGE,
} from "../../../../kml_heatmap/frontend/ui/mapOrientation";
import { REPLAY_CAMERA_MOVE } from "../../../../kml_heatmap/frontend/utils/mapHelpers";
import {
  asMapApp,
  createMockApp,
  mountElements,
  type MockApp,
} from "../../testHelpers";
import {
  dismissToast,
  showToast,
  type ToastAction,
} from "../../../../kml_heatmap/frontend/utils/toast";

vi.mock("../../../../kml_heatmap/frontend/utils/toast", () => ({
  dismissToast: vi.fn(),
  showToast: vi.fn(),
}));

describe("MapOrientation", () => {
  let app: MockApp;
  let orientation: MapOrientation;
  let unmount: () => void;

  const compass = (): HTMLElement => document.getElementById("compass-btn")!;
  const floating = (): HTMLElement =>
    document.getElementById("compass-float-btn")!;
  const needle = (button: HTMLElement): string =>
    button.style.getPropertyValue("--compass-turn");

  /** Move the camera and say so the way the map does */
  function turn(camera: { bearing?: number; pitch?: number }): void {
    app.map!.jumpTo(camera);
    if (camera.bearing !== undefined) app.map!.emit("rotate");
    if (camera.pitch !== undefined) app.map!.emit("pitch");
    app.map!.emit("moveend");
  }

  beforeEach(() => {
    unmount = mountElements({
      // In the document, so the map's canvas can take focus
      map: "div",
      "compass-btn": "button",
      "compass-float-btn": "button",
    });
    floating().hidden = true;
    app = createMockApp();
    orientation = new MapOrientation(asMapApp(app));
  });

  afterEach(() => {
    orientation.destroy();
    unmount();
  });

  describe("compass", () => {
    it("starts pointing up, with the floating one out of the way", () => {
      expect(needle(compass())).toBe("0deg");
      expect(floating().hidden).toBe(true);
    });

    it("points to where north is on a turned map", () => {
      turn({ bearing: 40 });

      // The top of the map is 40 degrees east of north, so north is to its left
      expect(needle(compass())).toBe("-40deg");
      expect(needle(floating())).toBe("-40deg");
      expect(floating().hidden).toBe(false);
    });

    it("shows the floating compass for a map that is only tilted", () => {
      turn({ pitch: 30 });

      expect(needle(compass())).toBe("0deg");
      expect(floating().hidden).toBe(false);
    });

    it("lays the needle back with the map, grown so it stays readable", () => {
      const tilt = (button: HTMLElement): string =>
        button.style.getPropertyValue("--compass-tilt");
      const grow = (button: HTMLElement): number =>
        Number(button.style.getPropertyValue("--compass-grow"));
      // Flat, no 3D transform at all (the stylesheet's fallback)
      expect(tilt(compass())).toBe("");

      turn({ pitch: 60 });

      for (const button of [compass(), floating()]) {
        expect(tilt(button)).toBe("rotateX(60deg)");
        // Half as tall laid back by 60, so it grows by the root of two
        expect(grow(button)).toBeCloseTo(Math.SQRT2, 6);
      }

      // Further back it would lie flat and outgrow its button
      turn({ pitch: 85 });
      expect(tilt(compass())).toBe("rotateX(60deg)");
      expect(grow(compass())).toBeCloseTo(Math.SQRT2, 6);

      turn({ pitch: 0 });
      expect(tilt(compass())).toBe("");
      expect(compass().style.getPropertyValue("--compass-grow")).toBe("");
    });

    it("reads the orientation a link opened the map with", () => {
      orientation.destroy();
      app.map!.jumpTo({ bearing: -120 });

      orientation = new MapOrientation(asMapApp(app));

      expect(needle(compass())).toBe("120deg");
      expect(floating().hidden).toBe(false);
    });

    it("shows the compass unavailable while the map is north up and flat", () => {
      expect(compass().getAttribute("aria-disabled")).toBe("true");
      // The stylesheet dims it from the attribute
      expect(compass().style.opacity).toBe("");

      turn({ bearing: 40 });
      expect(compass().getAttribute("aria-disabled")).toBe("false");

      turn({ bearing: 0, pitch: 30 });
      expect(compass().getAttribute("aria-disabled")).toBe("false");

      turn({ bearing: 0, pitch: 0 });
      expect(compass().getAttribute("aria-disabled")).toBe("true");
    });

    it("turns the map north up and lays it flat", () => {
      turn({ bearing: 40, pitch: 30 });

      orientation.resetNorth();

      expect(app.map!.easeTo).toHaveBeenCalledWith({ bearing: 0, pitch: 0 });
      expect(app.map!.getBearing()).toBe(0);
      expect(app.map!.getPitch()).toBe(0);
    });

    it("hands focus to the map when the floating compass hides under it", () => {
      turn({ bearing: 40 });
      floating().focus();
      expect(document.activeElement).toBe(floating());

      turn({ bearing: 0 });

      expect(floating().hidden).toBe(true);
      expect(document.activeElement).toBe(app.map!.getCanvas());
    });

    it("leaves focus alone when it is somewhere else", () => {
      turn({ bearing: 40 });
      compass().focus();

      turn({ bearing: 0 });

      expect(document.activeElement).toBe(compass());
    });
  });

  describe("globe", () => {
    it("leaves a map that opens in Mercator alone", async () => {
      await app.mapReady;

      expect(app.map!.setProjection).not.toHaveBeenCalled();
    });

    it("switches to the globe and back with the store", async () => {
      await app.mapReady;

      orientation.toggleGlobe();
      expect(app.globeVisible).toBe(true);
      expect(app.map!.getProjection()).toEqual({ type: "globe" });

      orientation.toggleGlobe();
      expect(app.globeVisible).toBe(false);
      expect(app.map!.getProjection()).toEqual({ type: "mercator" });
    });

    it("opens a restored globe as soon as the map has a style", async () => {
      orientation.destroy();
      app = createMockApp({ globeVisible: true });
      orientation = new MapOrientation(asMapApp(app));
      expect(app.map!.setProjection).not.toHaveBeenCalled();

      await app.mapReady;

      expect(app.map!.setProjection).toHaveBeenCalledExactlyOnceWith({
        type: "globe",
      });
    });

    it("waits for the style with a switch made before it has loaded", async () => {
      orientation.destroy();
      let styleLoaded: (map: MockApp["map"]) => void = () => {};
      const mapReady = new Promise<MockApp["map"]>((resolve) => {
        styleLoaded = resolve;
      });
      app = createMockApp({ mapReady });
      orientation = new MapOrientation(asMapApp(app));

      // A projection is part of the style: set earlier, MapLibre throws
      orientation.toggleGlobe();
      expect(app.map!.setProjection).not.toHaveBeenCalled();

      styleLoaded(app.map);
      await mapReady;

      expect(app.map!.getProjection()).toEqual({ type: "globe" });
    });

    it("stays quiet about a map that never got ready", async () => {
      orientation.destroy();
      const failed = Promise.reject(new Error("no layers"));
      app = createMockApp({ mapReady: failed });

      orientation = new MapOrientation(asMapApp(app));

      await expect(failed).rejects.toThrow("no layers");
      expect(app.map!.setProjection).not.toHaveBeenCalled();
    });
  });

  describe("3D", () => {
    beforeEach(() => vi.mocked(showToast).mockClear());

    it("tilts a flat map and leaves the heatmap alone to be lifted as the cloud", () => {
      app.map!.jumpTo({ zoom: 12, pitch: 0 });
      app.heatmapVisible = true;
      app.altitudeVisible = false;
      app.airspeedVisible = false;

      orientation.toggleThreeD();

      expect(app.threeDVisible).toBe(true);
      expect(app.map!.easeTo).toHaveBeenCalledWith({ pitch: 50 });
      expect(app.uiToggles.toggleAltitude).not.toHaveBeenCalled();
    });

    it("brings the altitude colours on where nothing would be lifted", () => {
      app.heatmapVisible = false;
      app.altitudeVisible = false;
      app.airspeedVisible = false;

      orientation.toggleThreeD();

      expect(app.threeDVisible).toBe(true);
      // The ribbons are the colour layers lifted, the cloud the heatmap
      expect(app.uiToggles.toggleAltitude).toHaveBeenCalledOnce();
    });

    it("leaves a tilted map and a shown colour layer as they are", () => {
      app.map!.jumpTo({ zoom: 12, pitch: 40 });
      app.airspeedVisible = true;

      orientation.toggleThreeD();

      expect(app.map!.easeTo).not.toHaveBeenCalled();
      expect(app.uiToggles.toggleAltitude).not.toHaveBeenCalled();
    });

    it("puts the flights back on the ground and leaves the map be", () => {
      orientation.toggleThreeD();
      vi.mocked(app.map!.easeTo).mockClear();

      orientation.toggleThreeD();

      expect(app.threeDVisible).toBe(false);
      expect(app.map!.easeTo).not.toHaveBeenCalled();
    });
  });

  describe("the offer of the 3D view", () => {
    beforeEach(() => {
      vi.mocked(showToast).mockClear();
      vi.mocked(dismissToast).mockClear();
    });

    /** Tilt the map to `pitch` and end it as a gesture or `eventData` does */
    function tilt(pitch: number, eventData: object = {}): void {
      app.map!.jumpTo({ pitch });
      app.map!.emit("pitchend", eventData);
    }
    const byHand = { originalEvent: new MouseEvent("mouseup") };
    const offers = (): unknown[][] =>
      vi
        .mocked(showToast)
        .mock.calls.filter(([message]) => message === THREE_D_HINT_MESSAGE);

    it("comes once a visit, as a flat map is tilted by hand past 30 degrees", () => {
      tilt(25, byHand);
      expect(offers()).toHaveLength(0);

      tilt(35, byHand);
      expect(offers()).toHaveLength(1);
      expect(offers()[0]![1]).toBe("info");

      tilt(0, byHand);
      tilt(40, byHand);
      expect(offers()).toHaveLength(1);
    });

    it("does not come for the app's own camera moves", () => {
      tilt(50);
      tilt(50, REPLAY_CAMERA_MOVE);
      expect(offers()).toHaveLength(0);
    });

    it("does not come in the 3D view, a replay or Wrapped, nor once 3D was used", () => {
      for (const key of ["replayActive", "wrappedVisible"] as const) {
        app[key] = true;
        tilt(45, byHand);
        app[key] = false;
      }
      app.threeDVisible = true;
      tilt(45, byHand);
      app.threeDVisible = false;
      tilt(45, byHand);
      expect(offers()).toHaveLength(0);
    });

    it("turns the 3D view on as the 3D button does, and goes when 3D comes on", () => {
      tilt(45, byHand);
      const action = offers()[0]![2] as ToastAction;
      expect(action.label).toBe("3D");

      action.run();
      expect(app.threeDVisible).toBe(true);
      expect(dismissToast).toHaveBeenCalledWith(THREE_D_HINT_MESSAGE);
      // Run again with the 3D view on, it leaves it on
      action.run();
      expect(app.threeDVisible).toBe(true);
    });

    it("goes when the 3D view comes on another way", () => {
      tilt(45, byHand);
      app.threeDVisible = true;
      expect(dismissToast).toHaveBeenCalledWith(THREE_D_HINT_MESSAGE);
    });

    it("lets go of the store and the map when destroyed", () => {
      orientation.destroy();
      tilt(45, byHand);
      app.threeDVisible = true;
      expect(offers()).toHaveLength(0);
      expect(dismissToast).not.toHaveBeenCalled();
    });
  });

  describe("a focused marker that goes behind the globe", () => {
    let marker: HTMLButtonElement;

    /** The frame after a move, in which MapLibre has marked the markers */
    const nextFrame = (): Promise<void> =>
      new Promise((resolve) => requestAnimationFrame(() => resolve()));

    beforeEach(() => {
      orientation.destroy();
      marker = document.createElement("button");
      marker.className = "maplibregl-marker";
      document.body.append(marker);
      app = createMockApp({ globeVisible: true });
      orientation = new MapOrientation(asMapApp(app));
      marker.focus();
    });

    afterEach(() => marker.remove());

    it("hands its focus to the map, so the keys go on turning the globe", async () => {
      app.map!.emit("moveend");
      await nextFrame();
      expect(document.activeElement).toBe(marker);

      // What MapLibre does to a marker on the far side, a frame after the
      // move; the stylesheet hides it only once it has lost the focus
      app.map!.emit("moveend");
      marker.classList.add("maplibregl-marker-covered");
      await nextFrame();

      expect(document.activeElement).toBe(app.map!.getCanvas());
    });

    it("takes focus from inside a marker as well", async () => {
      const inner = document.createElement("button");
      marker.append(inner);
      inner.focus();
      marker.classList.add("maplibregl-marker-covered");

      app.map!.emit("moveend");
      await nextFrame();

      expect(document.activeElement).toBe(app.map!.getCanvas());
    });

    it("leaves focus that is somewhere else alone", async () => {
      marker.classList.add("maplibregl-marker-covered");
      compass().focus();

      app.map!.emit("moveend");
      await nextFrame();

      expect(document.activeElement).toBe(compass());
    });

    it("does not look at every frame of the replay's camera", async () => {
      marker.classList.add("maplibregl-marker-covered");

      app.map!.emit("moveend", REPLAY_CAMERA_MOVE);
      await nextFrame();

      expect(document.activeElement).toBe(marker);
    });

    it("does not look on a flat map, where nothing is ever behind", async () => {
      app.globeVisible = false;
      marker.classList.add("maplibregl-marker-covered");

      app.map!.emit("moveend");
      await nextFrame();

      expect(document.activeElement).toBe(marker);
    });
  });

  describe("teardown", () => {
    it("stops listening to the map", () => {
      for (const type of ["rotate", "pitch", "moveend"]) {
        expect(app.map!.listenerCount(type)).toBe(1);
      }

      orientation.destroy();

      for (const type of ["rotate", "pitch", "moveend"]) {
        expect(app.map!.listenerCount(type)).toBe(0);
      }
    });

    it("does nothing without a map", () => {
      const mapless = createMockApp({ map: null });

      const idle = new MapOrientation(asMapApp(mapless));

      expect(() => idle.resetNorth()).not.toThrow();
      expect(() => idle.destroy()).not.toThrow();
    });
  });
});
