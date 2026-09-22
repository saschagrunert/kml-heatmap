import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { MapOrientation } from "../../../../kml_heatmap/frontend/ui/mapOrientation";
import { domCache } from "../../../../kml_heatmap/frontend/utils/domCache";
import {
  asMapApp,
  createMockApp,
  mountElements,
  type MockApp,
} from "../../testHelpers";
import { showToast } from "../../../../kml_heatmap/frontend/utils/toast";

vi.mock("../../../../kml_heatmap/frontend/utils/toast", () => ({
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
    domCache.clear();
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

    it("tilts a flat map and brings the altitude colours on", () => {
      app.map!.jumpTo({ zoom: 12, pitch: 0 });

      orientation.toggleThreeD();

      expect(app.threeDVisible).toBe(true);
      expect(app.map!.easeTo).toHaveBeenCalledWith({ pitch: 50 });
      // The ribbons are the colour layers lifted: without one, nothing shows
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
