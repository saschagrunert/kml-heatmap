import { describe, it, expect, vi } from "vitest";
import {
  AppStore,
  createDefaultState,
} from "../../../../kml_heatmap/frontend/state/store";

describe("createDefaultState", () => {
  it("returns expected defaults", () => {
    const state = createDefaultState();
    expect(state.selectedYear).toBe("all");
    expect(state.selectedAircraft).toBe("all");
    expect(state.selectedPathIds).toEqual(new Set());
    expect(state.heatmapVisible).toBe(true);
    expect(state.altitudeVisible).toBe(false);
    expect(state.currentData).toBeNull();
    expect(state.altitudeRange).toEqual({ min: 0, max: 10000 });
  });

  it("returns a fresh object each call", () => {
    const a = createDefaultState();
    const b = createDefaultState();
    expect(a).not.toBe(b);
    expect(a.selectedPathIds).not.toBe(b.selectedPathIds);
  });
});

describe("AppStore", () => {
  describe("get/set", () => {
    it("returns default values", () => {
      const store = new AppStore();
      expect(store.get("selectedYear")).toBe("all");
      expect(store.get("heatmapVisible")).toBe(true);
    });

    it("accepts initial overrides", () => {
      const store = new AppStore({
        selectedYear: "2024",
        heatmapVisible: false,
      });
      expect(store.get("selectedYear")).toBe("2024");
      expect(store.get("heatmapVisible")).toBe(false);
    });

    it("sets and retrieves values", () => {
      const store = new AppStore();
      store.set("selectedYear", "2025");
      expect(store.get("selectedYear")).toBe("2025");
    });
  });

  describe("equality short-circuit", () => {
    it("skips notification when value is identical", () => {
      const store = new AppStore();
      const fn = vi.fn();
      store.subscribe("selectedYear", fn);
      store.set("selectedYear", "all");
      expect(fn).not.toHaveBeenCalled();
    });

    it("notifies when value changes", () => {
      const store = new AppStore();
      const fn = vi.fn();
      store.subscribe("selectedYear", fn);
      store.set("selectedYear", "2025");
      expect(fn).toHaveBeenCalledWith("2025", "all");
    });
  });

  describe("subscribe/unsubscribe", () => {
    it("calls listener on change", () => {
      const store = new AppStore();
      const fn = vi.fn();
      store.subscribe("heatmapVisible", fn);
      store.set("heatmapVisible", false);
      expect(fn).toHaveBeenCalledWith(false, true);
    });

    it("supports multiple listeners", () => {
      const store = new AppStore();
      const fn1 = vi.fn();
      const fn2 = vi.fn();
      store.subscribe("selectedYear", fn1);
      store.subscribe("selectedYear", fn2);
      store.set("selectedYear", "2024");
      expect(fn1).toHaveBeenCalledOnce();
      expect(fn2).toHaveBeenCalledOnce();
    });

    it("unsubscribes correctly", () => {
      const store = new AppStore();
      const fn = vi.fn();
      const unsub = store.subscribe("selectedYear", fn);
      unsub();
      store.set("selectedYear", "2025");
      expect(fn).not.toHaveBeenCalled();
    });

    it("does not affect other listeners on unsubscribe", () => {
      const store = new AppStore();
      const fn1 = vi.fn();
      const fn2 = vi.fn();
      const unsub1 = store.subscribe("selectedYear", fn1);
      store.subscribe("selectedYear", fn2);
      unsub1();
      store.set("selectedYear", "2025");
      expect(fn1).not.toHaveBeenCalled();
      expect(fn2).toHaveBeenCalledOnce();
    });
  });

  describe("update", () => {
    it("applies updater function", () => {
      const store = new AppStore({
        altitudeRange: { min: 100, max: 500 },
      });
      store.update("altitudeRange", (prev) => ({ ...prev, max: 1000 }));
      expect(store.get("altitudeRange")).toEqual({ min: 100, max: 1000 });
    });

    it("notifies listeners", () => {
      const store = new AppStore();
      const fn = vi.fn();
      store.subscribe("selectedPathIds", fn);
      const newSet = new Set([1, 2, 3]);
      store.update("selectedPathIds", () => newSet);
      expect(fn).toHaveBeenCalledOnce();
      expect(store.get("selectedPathIds")).toBe(newSet);
    });
  });

  describe("notifyMutation", () => {
    it("fires listeners for in-place mutations", () => {
      const store = new AppStore();
      const fn = vi.fn();
      store.subscribe("selectedPathIds", fn);
      store.get("selectedPathIds").add(42);
      store.notifyMutation("selectedPathIds");
      expect(fn).toHaveBeenCalledOnce();
      const ids = fn.mock.calls[0][0] as Set<number>;
      expect(ids.has(42)).toBe(true);
    });

    it("passes same reference for old and new value", () => {
      const store = new AppStore();
      const fn = vi.fn();
      store.subscribe("selectedPathIds", fn);
      store.get("selectedPathIds").add(1);
      store.notifyMutation("selectedPathIds");
      const [newVal, oldVal] = fn.mock.calls[0];
      expect(newVal).toBe(oldVal);
    });
  });

  describe("batch", () => {
    it("defers notifications until batch completes", () => {
      const store = new AppStore();
      const fn = vi.fn();
      store.subscribe("selectedYear", fn);
      store.batch(() => {
        store.set("selectedYear", "2024");
        expect(fn).not.toHaveBeenCalled();
      });
      expect(fn).toHaveBeenCalledOnce();
    });

    it("preserves correct old values across batch", () => {
      const store = new AppStore();
      const fn = vi.fn();
      store.subscribe("selectedYear", fn);
      store.batch(() => {
        store.set("selectedYear", "2024");
        store.set("selectedYear", "2025");
      });
      expect(fn).toHaveBeenCalledWith("2025", "all");
    });

    it("batches multiple keys", () => {
      const store = new AppStore();
      const yearFn = vi.fn();
      const visFn = vi.fn();
      store.subscribe("selectedYear", yearFn);
      store.subscribe("heatmapVisible", visFn);
      store.batch(() => {
        store.set("selectedYear", "2024");
        store.set("heatmapVisible", false);
      });
      expect(yearFn).toHaveBeenCalledWith("2024", "all");
      expect(visFn).toHaveBeenCalledWith(false, true);
    });

    it("flushes even if batch function throws", () => {
      const store = new AppStore();
      const fn = vi.fn();
      store.subscribe("selectedYear", fn);
      expect(() => {
        store.batch(() => {
          store.set("selectedYear", "2024");
          throw new Error("test");
        });
      }).toThrow("test");
      expect(fn).toHaveBeenCalledWith("2024", "all");
    });

    it("skips notification when value reverted within batch", () => {
      const store = new AppStore();
      const fn = vi.fn();
      store.subscribe("selectedYear", fn);
      store.batch(() => {
        store.set("selectedYear", "2024");
        store.set("selectedYear", "all");
      });
      expect(fn).not.toHaveBeenCalled();
    });

    it("supports nested batch calls", () => {
      const store = new AppStore();
      const yearFn = vi.fn();
      const visFn = vi.fn();
      store.subscribe("selectedYear", yearFn);
      store.subscribe("heatmapVisible", visFn);
      store.batch(() => {
        store.set("selectedYear", "2024");
        store.batch(() => {
          store.set("heatmapVisible", false);
          expect(yearFn).not.toHaveBeenCalled();
          expect(visFn).not.toHaveBeenCalled();
        });
        // Inner batch exits but outer is still open
        expect(yearFn).not.toHaveBeenCalled();
        expect(visFn).not.toHaveBeenCalled();
      });
      // Outer batch exits, now both fire
      expect(yearFn).toHaveBeenCalledWith("2024", "all");
      expect(visFn).toHaveBeenCalledWith(false, true);
    });
  });

  describe("listener safety", () => {
    it("handles unsubscribe during notification", () => {
      const store = new AppStore();
      const calls: string[] = [];
      const unsub = { fn: () => {} };

      unsub.fn = store.subscribe("selectedYear", () => {
        calls.push("first");
        unsub.fn();
      });
      store.subscribe("selectedYear", () => {
        calls.push("second");
      });

      store.set("selectedYear", "2025");
      expect(calls).toEqual(["first", "second"]);
    });

    it("subscribes to nullable object key", () => {
      const store = new AppStore();
      const fn = vi.fn();
      store.subscribe("currentData", fn);

      const data = {
        coordinates: [],
        path_segments: [],
        path_info: [],
        resolution: "full",
        original_points: 0,
      };
      store.set("currentData", data);
      expect(fn).toHaveBeenCalledWith(data, null);

      store.set("currentData", null);
      expect(fn).toHaveBeenCalledWith(null, data);
    });
  });
});
