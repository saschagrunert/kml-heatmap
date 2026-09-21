import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Map as MapLibreMap, Popup as MapLibrePopup } from "maplibre-gl";
import {
  cssVar,
  firstSymbolLayerId,
  fromLngLat,
  isOnMarker,
  keepMarkerClickFromMap,
  keepMarkerTapsFromZoom,
  MAP_STILL_TIMEOUT_MS,
  mapZoomToState,
  panPopupIntoView,
  resizeMapAfterTransition,
  stateZoomToMap,
  toBounds,
  toLngLat,
  whenStyleReady,
  withMapStill,
} from "../../../../kml_heatmap/frontend/utils/mapHelpers";
import {
  Map as MockMap,
  Popup as MockPopup,
  mockControl,
  resetMapLibreMock,
} from "../../../mocks/maplibre-gl";
import { setDevicePixelRatio } from "../../testHelpers";

/** A mock map, typed the way the helpers take it */
function mapStub(options: Record<string, unknown> = {}): MapLibreMap & MockMap {
  const container = document.createElement("div");
  document.body.append(container);
  return new MockMap({
    container,
    style: "style.json",
    ...options,
  }) as MapLibreMap & MockMap;
}

function rect(
  left: number,
  top: number,
  right: number,
  bottom: number,
): DOMRect {
  return {
    left,
    top,
    right,
    bottom,
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
    toJSON: () => ({}),
  };
}

describe("mapHelpers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    resetMapLibreMock();
    document.body.innerHTML = "";
    document.documentElement.removeAttribute("style");
  });

  describe("coordinates", () => {
    it("swaps latitude-first data into MapLibre's order and back", () => {
      expect(toLngLat([50.1, 8.6])).toEqual([8.6, 50.1]);
      expect(fromLngLat({ lng: 8.6, lat: 50.1 })).toEqual([50.1, 8.6]);
    });

    it("drops an altitude behind the pair", () => {
      expect(toLngLat([50.1, 8.6, 1200])).toEqual([8.6, 50.1]);
    });

    it("turns the configured bounds into south-west and north-east", () => {
      expect(
        toBounds([
          [49, 7],
          [51, 9],
        ]),
      ).toEqual([
        [7, 49],
        [9, 51],
      ]);
    });
  });

  describe("zoom units", () => {
    it("keeps saved state one level above the map", () => {
      expect(stateZoomToMap(10)).toBe(9);
      expect(mapZoomToState(9)).toBe(10);
      expect(mapZoomToState(stateZoomToMap(12.25))).toBe(12.25);
    });
  });

  describe("whenStyleReady", () => {
    it("resolves with the map on style.load", async () => {
      mockControl.autoLoadStyle = false;
      const map = mapStub();
      const ready = vi.fn();
      void whenStyleReady(map).then(ready);

      await Promise.resolve();
      expect(ready).not.toHaveBeenCalled();

      map.finishStyleLoad();
      await Promise.resolve();
      expect(ready).toHaveBeenCalledWith(map);
    });
  });

  describe("firstSymbolLayerId", () => {
    it("names the lowest label layer", async () => {
      const map = mapStub({
        style: {
          version: 8,
          sources: {},
          layers: [
            { id: "land", type: "background" },
            { id: "roads", type: "line" },
            { id: "road-names", type: "symbol" },
            { id: "places", type: "symbol" },
          ],
        },
      });
      await whenStyleReady(map);

      expect(firstSymbolLayerId(map)).toBe("road-names");
    });

    it("is undefined for a style without labels", async () => {
      const map = mapStub({
        style: {
          version: 8,
          sources: {},
          layers: [{ id: "land", type: "background" }],
        },
      });
      await whenStyleReady(map);

      expect(firstSymbolLayerId(map)).toBeUndefined();
    });
  });

  describe("panPopupIntoView", () => {
    function openPopup(
      map: MapLibreMap & MockMap,
      box: DOMRect,
    ): MapLibrePopup {
      vi.spyOn(map.getContainer(), "getBoundingClientRect").mockReturnValue(
        rect(0, 0, 800, 600),
      );
      const popup = new MockPopup().setLngLat([8, 50]).addTo(map);
      vi.spyOn(popup.getElement(), "getBoundingClientRect").mockReturnValue(
        box,
      );
      return popup as unknown as MapLibrePopup;
    }

    it("leaves a popup that is inside the padding alone", () => {
      const map = mapStub();
      panPopupIntoView(map, openPopup(map, rect(100, 100, 300, 300)), 16);

      expect(map.panBy).not.toHaveBeenCalled();
    });

    it("pans by what sticks out at the top left, plus the padding", () => {
      const map = mapStub();
      panPopupIntoView(map, openPopup(map, rect(-20, 6, 180, 200)), 16);

      expect(map.panBy).toHaveBeenCalledWith([-36, -10], { animate: true });
    });

    it("pans by what sticks out at the bottom right", () => {
      const map = mapStub();
      panPopupIntoView(
        map,
        openPopup(map, rect(600, 400, 820, 590)),
        16,
        false,
      );

      expect(map.panBy).toHaveBeenCalledWith([36, 6], { animate: false });
    });

    it("shows the start of a popup larger than the map", () => {
      const map = mapStub();
      panPopupIntoView(map, openPopup(map, rect(-50, 100, 900, 300)), 16);

      expect(map.panBy).toHaveBeenCalledWith([-66, 0], { animate: true });
    });

    it("does nothing for a closed popup", () => {
      const map = mapStub();
      const popup = openPopup(map, rect(-50, 100, 900, 300));
      popup.remove();

      panPopupIntoView(map, popup, 16);

      expect(map.panBy).not.toHaveBeenCalled();
    });
  });

  describe("isOnMarker", () => {
    it("tells an event aimed at a marker, or inside one, from the rest", () => {
      const container = document.createElement("div");
      const canvas = document.createElement("canvas");
      const marker = document.createElement("button");
      marker.className = "maplibregl-marker airport-marker";
      const label = document.createElement("span");
      marker.append(label);
      container.append(canvas, marker);
      const aimedAt = (target: Element): { originalEvent: Event } => {
        const originalEvent = new Event("click", { bubbles: true });
        target.dispatchEvent(originalEvent);
        return { originalEvent };
      };

      expect(isOnMarker(aimedAt(marker))).toBe(true);
      expect(isOnMarker(aimedAt(label))).toBe(true);
      expect(isOnMarker(aimedAt(canvas))).toBe(false);
      // An event the app made up carries none
      expect(isOnMarker({})).toBe(false);
    });
  });

  describe("keepMarkerClickFromMap", () => {
    it("stops the click and lets everything else through", () => {
      const parent = document.createElement("div");
      const element = document.createElement("button");
      parent.append(element);
      const seen: string[] = [];
      const types = [
        "click",
        "mousemove",
        "dblclick",
        "mousedown",
        "touchstart",
      ];
      for (const type of types) {
        parent.addEventListener(type, () => seen.push(type));
      }

      keepMarkerClickFromMap(element);
      for (const type of types) {
        element.dispatchEvent(new Event(type, { bubbles: true }));
      }

      expect(seen).toEqual([
        "mousemove",
        "dblclick",
        "mousedown",
        "touchstart",
      ]);
    });
  });

  describe("keepMarkerTapsFromZoom", () => {
    function mapWithMarker(): {
      map: MapLibreMap & MockMap;
      onMarker: (type: string) => { originalEvent: Event };
      onCanvas: (type: string) => { originalEvent: Event };
    } {
      const map = mapStub();
      const marker = document.createElement("button");
      marker.className = "maplibregl-marker";
      map.getCanvasContainer().append(marker);
      const aimedAt =
        (target: Element) =>
        (type: string): { originalEvent: Event } => {
          const originalEvent = new Event(type, { bubbles: true });
          target.dispatchEvent(originalEvent);
          return { originalEvent };
        };
      return {
        map,
        onMarker: aimedAt(marker),
        onCanvas: aimedAt(map.getCanvas()),
      };
    }

    it("prevents the zoom of a double click on a marker only", () => {
      const { map, onMarker, onCanvas } = mapWithMarker();
      keepMarkerTapsFromZoom(map);
      const preventDefault = vi.fn();

      map.emit("dblclick", { ...onCanvas("dblclick"), preventDefault });
      expect(preventDefault).not.toHaveBeenCalled();

      map.emit("dblclick", { ...onMarker("dblclick"), preventDefault });
      expect(preventDefault).toHaveBeenCalledTimes(1);
    });

    it("switches the tap zoom off for the length of a touch on a marker", () => {
      const { map, onMarker, onCanvas } = mapWithMarker();
      keepMarkerTapsFromZoom(map);

      map.emit("touchstart", onCanvas("touchstart"));
      expect(map.doubleClickZoom.isEnabled()).toBe(true);
      map.emit("touchend", onCanvas("touchend"));
      expect(map.doubleClickZoom.enable).not.toHaveBeenCalled();

      map.emit("touchstart", onMarker("touchstart"));
      expect(map.doubleClickZoom.isEnabled()).toBe(false);
      // The pan is not touched: a drag that starts on a marker moves the map
      expect(map.dragPan.disable).not.toHaveBeenCalled();

      map.emit("touchend", onMarker("touchend"));
      expect(map.doubleClickZoom.isEnabled()).toBe(true);
    });

    it("leaves a zoom that was switched off by someone else off", () => {
      const { map, onMarker } = mapWithMarker();
      map.doubleClickZoom.disable();
      keepMarkerTapsFromZoom(map);

      map.emit("touchstart", onMarker("touchstart"));
      map.emit("touchcancel", onMarker("touchcancel"));

      expect(map.doubleClickZoom.isEnabled()).toBe(false);
    });

    it("takes everything back, a zoom it had switched off included", () => {
      const { map, onMarker } = mapWithMarker();
      const release = keepMarkerTapsFromZoom(map);
      map.emit("touchstart", onMarker("touchstart"));

      release();

      expect(map.doubleClickZoom.isEnabled()).toBe(true);
      for (const type of [
        "dblclick",
        "touchstart",
        "touchend",
        "touchcancel",
      ]) {
        expect(map.listenerCount(type)).toBe(0);
      }
    });
  });

  describe("withMapStill", () => {
    beforeEach(() => {
      vi.useRealTimers();
      // jsdom does not implement it
      HTMLImageElement.prototype.decode = vi.fn(() => Promise.resolve());
    });

    afterEach(() => {
      // The workers share one jsdom, so the prototype is put back
      delete (HTMLImageElement.prototype as { decode?: unknown }).decode;
    });

    function stillMap(): MapLibreMap & MockMap {
      const map = mapStub();
      vi.spyOn(map.getCanvas(), "toDataURL").mockReturnValue(
        "data:image/png;base64,AAAA",
      );
      return map;
    }

    it("shows a still of the rendered frame while the callback runs", async () => {
      const map = stillMap();
      const canvas = map.getCanvas();
      const parent = canvas.parentElement!;

      const result = await withMapStill(map, () => {
        const still = parent.querySelector("img")!;
        expect(parent.contains(canvas)).toBe(false);
        expect(still.src).toBe("data:image/png;base64,AAAA");
        expect(still.className).toBe(canvas.className);
        return "done";
      });

      expect(result).toBe("done");
      expect(map.triggerRepaint).toHaveBeenCalledOnce();
      expect(canvas.toDataURL).toHaveBeenCalledWith("image/png");
      expect(parent.contains(canvas)).toBe(true);
      expect(parent.querySelector("img")).toBeNull();
    });

    it("reads the canvas inside the render event, not before", async () => {
      const map = stillMap();
      const canvas = map.getCanvas();
      map.triggerRepaint.mockImplementation(() => {
        expect(canvas.toDataURL).not.toHaveBeenCalled();
        queueMicrotask(() => map.emit("render"));
      });

      await withMapStill(map, () => undefined);

      expect(canvas.toDataURL).toHaveBeenCalledOnce();
    });

    it("puts the canvas back when the callback fails", async () => {
      const map = stillMap();
      const canvas = map.getCanvas();
      const parent = canvas.parentElement!;

      await expect(
        withMapStill(map, () => Promise.reject(new Error("capture failed"))),
      ).rejects.toThrow("capture failed");

      expect(parent.contains(canvas)).toBe(true);
      expect(parent.querySelector("img")).toBeNull();
    });

    it("rejects when the canvas cannot be read, and leaves the map as it was", async () => {
      const map = stillMap();
      const canvas = map.getCanvas();
      const parent = canvas.parentElement!;
      vi.mocked(canvas.toDataURL).mockImplementation(() => {
        throw new Error("tainted canvas");
      });
      const fn = vi.fn();

      await expect(withMapStill(map, fn)).rejects.toThrow("tainted canvas");

      expect(fn).not.toHaveBeenCalled();
      expect(parent.contains(canvas)).toBe(true);
      expect(map.listenerCount("render")).toBe(0);
    });

    it("rejects when the map draws no frame in time, as after a lost context", async () => {
      vi.useFakeTimers();
      const map = stillMap();
      const canvas = map.getCanvas();
      const parent = canvas.parentElement!;
      map.triggerRepaint.mockImplementation(() => undefined);
      const fn = vi.fn();

      const pending = withMapStill(map, fn);
      const settled = expect(pending).rejects.toThrow(
        "the map did not draw in time",
      );
      await vi.advanceTimersByTimeAsync(MAP_STILL_TIMEOUT_MS);
      await settled;

      expect(fn).not.toHaveBeenCalled();
      expect(parent.contains(canvas)).toBe(true);
      // A frame that comes late after all finds nobody waiting
      expect(map.listenerCount("render")).toBe(0);
      vi.useRealTimers();
    });

    it("stops the clock once the frame is there", async () => {
      vi.useFakeTimers();
      const map = stillMap();

      await withMapStill(map, () => undefined);

      expect(vi.getTimerCount()).toBe(0);
      expect(map.listenerCount("render")).toBe(0);
      vi.useRealTimers();
    });

    it("carries on with an image that does not decode", async () => {
      HTMLImageElement.prototype.decode = vi.fn(() =>
        Promise.reject(new Error("decode")),
      );
      const map = stillMap();
      const fn = vi.fn();

      await withMapStill(map, fn);

      expect(fn).toHaveBeenCalledOnce();
    });

    describe("at a pixel ratio", () => {
      afterEach(() => setDevicePixelRatio(1));

      it("draws the still at the ratio asked for and hands the map back to the screen's", async () => {
        const map = stillMap();
        const canvas = map.getCanvas();
        const steps: string[] = [];
        map.setPixelRatio.mockImplementation((ratio: number | null) => {
          steps.push(`ratio ${String(ratio)}`);
        });
        vi.mocked(canvas.toDataURL).mockImplementation(() => {
          steps.push("frame read");
          return "data:image/png;base64,AAAA";
        });
        await withMapStill(
          map,
          () => {
            steps.push(
              canvas.parentElement ? "capture of canvas" : "capture of still",
            );
          },
          2,
        );
        steps.push(canvas.parentElement ? "canvas back" : "canvas gone");

        // Null, not 1: the map follows the screen again instead of being
        // pinned to the ratio the screen had during the export
        expect(steps).toEqual([
          "ratio 2",
          "frame read",
          "capture of still",
          "ratio null",
          "canvas back",
        ]);
      });

      it("puts the canvas back even when the ratio cannot be restored", async () => {
        // A map removed during the capture throws on the resize behind
        // setPixelRatio; the page must not be left showing a still
        const map = stillMap();
        const canvas = map.getCanvas();
        const parent = canvas.parentElement!;
        map.setPixelRatio.mockImplementation((ratio: number | null) => {
          if (ratio === null) throw new TypeError("the map is gone");
        });

        await expect(withMapStill(map, () => undefined, 2)).rejects.toThrow(
          "the map is gone",
        );

        expect(parent.contains(canvas)).toBe(true);
        expect(parent.querySelector("img")).toBeNull();
      });

      it("hands the map back to the screen although the screen changed meanwhile", async () => {
        // A browser zoom or another monitor during the capture: asked at the
        // end, the map would look like one with a ratio of its own and be
        // pinned to the old one
        const map = stillMap();
        const restored: (number | null)[] = [];
        map.setPixelRatio.mockImplementation((ratio: number | null) => {
          restored.push(ratio);
        });

        await withMapStill(map, () => setDevicePixelRatio(1.25), 2);

        expect(restored).toEqual([2, null]);
      });

      it("leaves a canvas alone that is already as large as it can get", async () => {
        // MapLibre holds the canvas below the ratio it was asked for once it
        // hits its size limit; raising the ratio would cost two resizes, and
        // their move events, to take the same still
        const map = stillMap();
        const canvas = map.getCanvas();
        Object.defineProperty(canvas, "clientWidth", {
          value: 5000,
          configurable: true,
        });
        canvas.width = 4096;

        await withMapStill(map, () => undefined, 2);

        expect(map.setPixelRatio).not.toHaveBeenCalled();
      });

      it("puts the canvas back only after the ratio is restored", async () => {
        const map = stillMap();
        const canvas = map.getCanvas();
        const attached: boolean[] = [];
        map.setPixelRatio.mockImplementation(() => {
          attached.push(canvas.parentElement !== null);
        });

        await withMapStill(map, () => undefined, 2);

        // Raised on the canvas in the page, lowered behind the still
        expect(attached).toEqual([true, false]);
      });

      it("restores a ratio the map was given, as the number it was", async () => {
        const map = stillMap();
        map.setPixelRatio(1.5);
        map.setPixelRatio.mockClear();

        await withMapStill(map, () => undefined, 2);

        expect(map.setPixelRatio.mock.calls).toEqual([[2], [1.5]]);
        expect(map.getPixelRatio()).toBe(1.5);
      });

      it.each([
        ["denser than", 3],
        ["as dense as", 2],
      ])(
        "leaves the ratio alone on a screen %s the export",
        async (_name, screen) => {
          setDevicePixelRatio(screen);
          const map = stillMap();
          const fn = vi.fn();

          await withMapStill(map, fn, 2);

          expect(fn).toHaveBeenCalledOnce();
          expect(map.setPixelRatio).not.toHaveBeenCalled();
        },
      );

      it("leaves the ratio alone when none is asked for", async () => {
        const map = stillMap();

        await withMapStill(map, () => undefined);

        expect(map.setPixelRatio).not.toHaveBeenCalled();
      });

      it("restores the ratio when the callback fails", async () => {
        const map = stillMap();
        const canvas = map.getCanvas();
        const parent = canvas.parentElement!;

        await expect(
          withMapStill(
            map,
            () => Promise.reject(new Error("capture failed")),
            2,
          ),
        ).rejects.toThrow("capture failed");

        expect(map.setPixelRatio.mock.calls).toEqual([[2], [null]]);
        expect(parent.contains(canvas)).toBe(true);
        expect(parent.querySelector("img")).toBeNull();
      });

      it("restores the ratio when the canvas cannot be read", async () => {
        const map = stillMap();
        const canvas = map.getCanvas();
        vi.mocked(canvas.toDataURL).mockImplementation(() => {
          throw new Error("tainted canvas");
        });

        await expect(withMapStill(map, vi.fn(), 2)).rejects.toThrow(
          "tainted canvas",
        );

        expect(map.setPixelRatio.mock.calls).toEqual([[2], [null]]);
        expect(canvas.parentElement).not.toBeNull();
        expect(map.listenerCount("render")).toBe(0);
      });

      it("restores the ratio when the map draws no frame in time", async () => {
        vi.useFakeTimers();
        const map = stillMap();
        map.triggerRepaint.mockImplementation(() => undefined);

        const pending = withMapStill(map, vi.fn(), 2);
        const settled = expect(pending).rejects.toThrow(
          "the map did not draw in time",
        );
        await vi.advanceTimersByTimeAsync(MAP_STILL_TIMEOUT_MS);
        await settled;

        expect(map.setPixelRatio.mock.calls).toEqual([[2], [null]]);
        expect(map.getCanvas().parentElement).not.toBeNull();
        expect(map.listenerCount("render")).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
        vi.useRealTimers();
      });

      it("lets go of the frame once the canvas is back", async () => {
        const map = stillMap();
        const parent = map.getCanvas().parentElement!;
        let still: HTMLImageElement | null = null;

        await withMapStill(
          map,
          () => {
            still = parent.querySelector("img");
          },
          2,
        );

        expect(still!.hasAttribute("src")).toBe(false);
      });
    });
  });

  describe("cssVar", () => {
    it("reads a token of the root element, trimmed", () => {
      document.documentElement.style.setProperty("--color-test", "  #123456 ");

      expect(cssVar("--color-test")).toBe("#123456");
    });

    it("is empty for a token that is not set", () => {
      expect(cssVar("--color-unset")).toBe("");
    });
  });

  describe("resizeMapAfterTransition", () => {
    it("invalidates after fallback timeout when no element is given", () => {
      const mockMap = mapStub();

      resizeMapAfterTransition(mockMap);

      expect(mockMap.resize).not.toHaveBeenCalled();

      vi.advanceTimersByTime(350);

      expect(mockMap.resize).toHaveBeenCalledOnce();
    });

    it("invalidates on transitionend when element is given", () => {
      const mockMap = mapStub();
      const el = document.createElement("div");

      resizeMapAfterTransition(mockMap, el);

      expect(mockMap.resize).not.toHaveBeenCalled();

      el.dispatchEvent(
        new TransitionEvent("transitionend", { bubbles: false }),
      );

      expect(mockMap.resize).toHaveBeenCalledOnce();
    });

    it("falls back to timeout when transitionend does not fire", () => {
      const mockMap = mapStub();
      const el = document.createElement("div");

      resizeMapAfterTransition(mockMap, el);

      vi.advanceTimersByTime(350);

      expect(mockMap.resize).toHaveBeenCalledOnce();
    });

    it("does not double-call when both transitionend and timeout fire", () => {
      const mockMap = mapStub();
      const el = document.createElement("div");

      resizeMapAfterTransition(mockMap, el);

      el.dispatchEvent(
        new TransitionEvent("transitionend", { bubbles: false }),
      );
      vi.advanceTimersByTime(350);

      expect(mockMap.resize).toHaveBeenCalledOnce();
    });

    it("schedules nothing and listens to nothing without a map", () => {
      const el = document.createElement("div");
      const listen = vi.spyOn(el, "addEventListener");

      resizeMapAfterTransition(null, el);
      resizeMapAfterTransition(null);

      expect(vi.getTimerCount()).toBe(0);
      expect(listen).not.toHaveBeenCalled();
    });

    it("ignores transitionend from child elements", () => {
      const mockMap = mapStub();
      const el = document.createElement("div");
      const child = document.createElement("span");
      el.append(child);

      resizeMapAfterTransition(mockMap, el);

      const event = new TransitionEvent("transitionend", { bubbles: true });
      Object.defineProperty(event, "target", { value: child });
      el.dispatchEvent(event);

      expect(mockMap.resize).not.toHaveBeenCalled();

      vi.advanceTimersByTime(350);
      expect(mockMap.resize).toHaveBeenCalledOnce();
    });
  });
});
