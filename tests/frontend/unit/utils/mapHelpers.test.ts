import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type * as L from "leaflet";
import { invalidateMapAfterTransition } from "../../../../kml_heatmap/frontend/utils/mapHelpers";

/** A map stub that only knows the one method the helper calls */
function mapStub(): L.Map & { invalidateSize: ReturnType<typeof vi.fn> } {
  return { invalidateSize: vi.fn() } as unknown as L.Map & {
    invalidateSize: ReturnType<typeof vi.fn>;
  };
}

describe("mapHelpers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe("invalidateMapAfterTransition", () => {
    it("invalidates after fallback timeout when no element is given", () => {
      const mockMap = mapStub();

      invalidateMapAfterTransition(mockMap);

      expect(mockMap.invalidateSize).not.toHaveBeenCalled();

      vi.advanceTimersByTime(350);

      expect(mockMap.invalidateSize).toHaveBeenCalledOnce();
    });

    it("invalidates on transitionend when element is given", () => {
      const mockMap = mapStub();
      const el = document.createElement("div");

      invalidateMapAfterTransition(mockMap, el);

      expect(mockMap.invalidateSize).not.toHaveBeenCalled();

      el.dispatchEvent(
        new TransitionEvent("transitionend", { bubbles: false }),
      );

      expect(mockMap.invalidateSize).toHaveBeenCalledOnce();
    });

    it("falls back to timeout when transitionend does not fire", () => {
      const mockMap = mapStub();
      const el = document.createElement("div");

      invalidateMapAfterTransition(mockMap, el);

      vi.advanceTimersByTime(350);

      expect(mockMap.invalidateSize).toHaveBeenCalledOnce();
    });

    it("does not double-call when both transitionend and timeout fire", () => {
      const mockMap = mapStub();
      const el = document.createElement("div");

      invalidateMapAfterTransition(mockMap, el);

      el.dispatchEvent(
        new TransitionEvent("transitionend", { bubbles: false }),
      );
      vi.advanceTimersByTime(350);

      expect(mockMap.invalidateSize).toHaveBeenCalledOnce();
    });

    it("does not call invalidateSize if map is null", () => {
      invalidateMapAfterTransition(null);

      vi.advanceTimersByTime(350);

      expect(true).toBe(true);
    });

    it("ignores transitionend from child elements", () => {
      const mockMap = mapStub();
      const el = document.createElement("div");
      const child = document.createElement("span");
      el.append(child);

      invalidateMapAfterTransition(mockMap, el);

      const event = new TransitionEvent("transitionend", { bubbles: true });
      Object.defineProperty(event, "target", { value: child });
      el.dispatchEvent(event);

      expect(mockMap.invalidateSize).not.toHaveBeenCalled();

      vi.advanceTimersByTime(350);
      expect(mockMap.invalidateSize).toHaveBeenCalledOnce();
    });
  });
});
