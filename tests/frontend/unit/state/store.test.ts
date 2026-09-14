import { describe, it, expect, vi } from "vitest";
import {
  AppStore,
  STORE_ACCESSOR_KEYS,
  createDefaultState,
  defineStoreAccessors,
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

  describe("notifyMutation", () => {
    it("fires listeners for in-place mutations", () => {
      const store = new AppStore();
      const fn = vi.fn();
      store.subscribe("selectedPathIds", fn);
      store.get("selectedPathIds").add(42);
      store.notifyMutation("selectedPathIds");
      expect(fn).toHaveBeenCalledOnce();
      const ids = fn.mock.calls[0]![0] as Set<number>;
      expect(ids.has(42)).toBe(true);
    });

    it("passes same reference for old and new value", () => {
      const store = new AppStore();
      const fn = vi.fn();
      store.subscribe("selectedPathIds", fn);
      store.get("selectedPathIds").add(1);
      store.notifyMutation("selectedPathIds");
      const [newVal, oldVal] = fn.mock.calls[0]!;
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

  describe("reentrancy", () => {
    it("defers set() called during notification", () => {
      const store = new AppStore();
      const yearFn = vi.fn();
      const aircraftFn = vi.fn();
      store.subscribe("selectedYear", () => {
        store.set("selectedAircraft", "D-EXYZ");
      });
      store.subscribe("selectedYear", yearFn);
      store.subscribe("selectedAircraft", aircraftFn);

      store.set("selectedYear", "2024");
      expect(yearFn).toHaveBeenCalledOnce();
      expect(aircraftFn).toHaveBeenCalledOnce();
      expect(store.get("selectedAircraft")).toBe("D-EXYZ");
    });

    it("does not stack overflow on mutual listeners", () => {
      const store = new AppStore();
      let yearCount = 0;
      let aircraftCount = 0;

      store.subscribe("selectedYear", () => {
        yearCount++;
        if (yearCount <= 2) {
          store.set("selectedAircraft", `aircraft-${yearCount}`);
        }
      });
      store.subscribe("selectedAircraft", () => {
        aircraftCount++;
        if (aircraftCount <= 2) {
          store.set("selectedYear", `year-${aircraftCount}`);
        }
      });

      expect(() => store.set("selectedYear", "2024")).not.toThrow();
    });

    it("stays quiet for an object set and set back within a batch", () => {
      const original = { min: 0, max: 10000 };
      const store = new AppStore({ altitudeRange: original });
      const fn = vi.fn();
      store.subscribe("altitudeRange", fn);

      store.batch(() => {
        store.set("altitudeRange", { min: 0, max: 5000 });
        store.set("altitudeRange", original);
      });

      expect(fn).not.toHaveBeenCalled();
    });

    it("defers notifyMutation during batch", () => {
      const store = new AppStore();
      const fn = vi.fn();
      store.subscribe("selectedPathIds", fn);

      store.batch(() => {
        store.get("selectedPathIds").add(1);
        store.notifyMutation("selectedPathIds");
        expect(fn).not.toHaveBeenCalled();
      });
      expect(fn).toHaveBeenCalledOnce();
    });

    it("defers notifyMutation during notification", () => {
      const store = new AppStore();
      const pathFn = vi.fn();
      store.subscribe("selectedYear", () => {
        store.get("selectedPathIds").add(99);
        store.notifyMutation("selectedPathIds");
      });
      store.subscribe("selectedPathIds", pathFn);

      store.set("selectedYear", "2024");
      expect(pathFn).toHaveBeenCalledOnce();
    });

    it("listener calling batch() during notification works", () => {
      const store = new AppStore();
      const aircraftFn = vi.fn();
      store.subscribe("selectedYear", () => {
        store.batch(() => {
          store.set("selectedAircraft", "D-EXYZ");
        });
      });
      store.subscribe("selectedAircraft", aircraftFn);

      store.set("selectedYear", "2024");
      expect(aircraftFn).toHaveBeenCalledWith("D-EXYZ", "all");
    });
  });

  describe("subscribeKeys", () => {
    it("runs once for a batch that changes several of its keys", () => {
      const store = new AppStore();
      const fn = vi.fn();
      store.subscribeKeys(["selectedYear", "selectedAircraft"], fn);

      store.batch(() => {
        store.set("selectedYear", "2024");
        store.set("selectedAircraft", "D-EXYZ");
      });

      expect(fn).toHaveBeenCalledOnce();
    });

    it("runs for each separate change and ignores other keys", () => {
      const store = new AppStore();
      const fn = vi.fn();
      store.subscribeKeys(["selectedYear", "selectedAircraft"], fn);

      store.set("selectedYear", "2024");
      store.set("selectedAircraft", "D-EXYZ");
      store.set("heatmapVisible", false);

      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("sees the final state of the whole batch", () => {
      const store = new AppStore();
      const seen: string[] = [];
      store.subscribeKeys(["selectedYear", "selectedAircraft"], () => {
        seen.push(
          store.get("selectedYear") + "/" + store.get("selectedAircraft"),
        );
      });

      store.batch(() => {
        store.set("selectedYear", "2024");
        store.set("selectedAircraft", "D-EXYZ");
      });

      expect(seen).toEqual(["2024/D-EXYZ"]);
    });

    it("runs again for a key another listener changes after it ran", () => {
      const store = new AppStore();
      const fn = vi.fn();
      store.subscribeKeys(["selectedYear", "selectedAircraft"], () => {
        fn(store.get("selectedAircraft"));
      });
      store.subscribe("selectedYear", () => {
        store.set("selectedAircraft", "D-EXYZ");
      });

      store.batch(() => {
        store.set("selectedYear", "2024");
      });

      expect(fn.mock.calls).toEqual([["all"], ["D-EXYZ"]]);
    });

    it("unsubscribes from every key", () => {
      const store = new AppStore();
      const fn = vi.fn();
      const unsubscribe = store.subscribeKeys(
        ["selectedYear", "selectedAircraft"],
        fn,
      );

      unsubscribe();
      store.set("selectedYear", "2024");
      store.set("selectedAircraft", "D-EXYZ");

      expect(fn).not.toHaveBeenCalled();
    });
  });

  describe("listener safety", () => {
    it("keeps notifying after a listener throws", () => {
      const store = new AppStore();
      const error = new Error("broken listener");
      const consoleSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      const after = vi.fn();
      const otherKey = vi.fn();
      store.subscribe("selectedYear", () => {
        throw error;
      });
      store.subscribe("selectedYear", after);
      store.subscribe("heatmapVisible", otherKey);

      store.batch(() => {
        store.set("selectedYear", "2024");
        store.set("heatmapVisible", false);
      });

      // The rest of the listeners and the rest of the flush still ran
      expect(after).toHaveBeenCalledOnce();
      expect(otherKey).toHaveBeenCalledOnce();
      expect(consoleSpy).toHaveBeenCalledWith(
        "Store listener for selectedYear failed:",
        error,
      );
      consoleSpy.mockRestore();
    });

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

  describe("defineStoreAccessors", () => {
    it("forwards every accessor key to the store", () => {
      const store = new AppStore();
      const holder = { store } as { store: AppStore } & Record<string, unknown>;

      defineStoreAccessors(holder);

      for (const key of STORE_ACCESSOR_KEYS) {
        expect(holder[key]).toBe(store.get(key));
      }
      holder["selectedYear"] = "2025";
      expect(store.get("selectedYear")).toBe("2025");
      store.set("heatmapVisible", false);
      expect(holder["heatmapVisible"]).toBe(false);
    });

    it("notifies subscribers through the accessor", () => {
      const store = new AppStore();
      const holder = { store } as { store: AppStore } & Record<string, unknown>;
      defineStoreAccessors(holder);
      const fn = vi.fn();
      store.subscribe("selectedAircraft", fn);

      holder["selectedAircraft"] = "D-EAGJ";

      expect(fn).toHaveBeenCalledWith("D-EAGJ", "all");
    });

    it("covers every non-panel key of the default state", () => {
      const panelKeys = new Set(["statsPanelVisible", "wrappedVisible"]);
      const expected = Object.keys(createDefaultState()).filter(
        (key) => !panelKeys.has(key),
      );
      expect([...STORE_ACCESSOR_KEYS].sort()).toEqual(expected.sort());
    });
  });
});
