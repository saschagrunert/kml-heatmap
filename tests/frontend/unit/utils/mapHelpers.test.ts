import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Map as MapLibreMap, Popup as MapLibrePopup } from "maplibre-gl";
import {
  cssVar,
  firstSymbolLayerId,
  fromLngLat,
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

    it("resolves at once for a style that has already loaded", async () => {
      const map = mapStub();
      await whenStyleReady(map);
      map.once.mockClear();

      await expect(whenStyleReady(map)).resolves.toBe(map);
      expect(map.once).not.toHaveBeenCalled();
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

    it("carries on with an image that does not decode", async () => {
      HTMLImageElement.prototype.decode = vi.fn(() =>
        Promise.reject(new Error("decode")),
      );
      const map = stillMap();
      const fn = vi.fn();

      await withMapStill(map, fn);

      expect(fn).toHaveBeenCalledOnce();
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
