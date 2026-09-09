import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  applyToggleButtonState,
  syncToggleButton,
} from "../../../../kml_heatmap/frontend/utils/buttonState";
import { AppStore } from "../../../../kml_heatmap/frontend/state/store";
import { domCache } from "../../../../kml_heatmap/frontend/utils/domCache";

describe("buttonState", () => {
  let button: HTMLButtonElement;

  beforeEach(() => {
    domCache.clear();
    button = document.createElement("button");
    button.id = "heatmap-btn";
    document.body.appendChild(button);
  });

  afterEach(() => {
    button.remove();
    domCache.clear();
  });

  describe("applyToggleButtonState", () => {
    it("sets aria-pressed, active class and opacity for an active button", () => {
      applyToggleButtonState(button, true);

      expect(button.getAttribute("aria-pressed")).toBe("true");
      expect(button.classList.contains("active")).toBe(true);
      expect(button.style.opacity).toBe("1");
    });

    it("clears them for an inactive button", () => {
      button.classList.add("active");

      applyToggleButtonState(button, false);

      expect(button.getAttribute("aria-pressed")).toBe("false");
      expect(button.classList.contains("active")).toBe(false);
      expect(button.style.opacity).toBe("0.5");
    });
  });

  describe("syncToggleButton", () => {
    it("applies the current store value immediately", () => {
      const store = new AppStore({ heatmapVisible: false });

      syncToggleButton(store, "heatmapVisible", "heatmap-btn");

      expect(button.getAttribute("aria-pressed")).toBe("false");
      expect(button.style.opacity).toBe("0.5");
    });

    it("follows store changes", () => {
      const store = new AppStore();
      syncToggleButton(store, "heatmapVisible", "heatmap-btn");
      expect(button.getAttribute("aria-pressed")).toBe("true");

      store.set("heatmapVisible", false);

      expect(button.getAttribute("aria-pressed")).toBe("false");
      expect(button.classList.contains("active")).toBe(false);
      expect(button.style.opacity).toBe("0.5");
    });

    it("stops following after unsubscribe", () => {
      const store = new AppStore();
      const unsubscribe = syncToggleButton(
        store,
        "heatmapVisible",
        "heatmap-btn",
      );

      unsubscribe();
      store.set("heatmapVisible", false);

      expect(button.getAttribute("aria-pressed")).toBe("true");
    });

    it("tolerates a missing button", () => {
      const store = new AppStore();
      expect(() =>
        syncToggleButton(store, "altitudeVisible", "missing-btn"),
      ).not.toThrow();
      expect(() => store.set("altitudeVisible", true)).not.toThrow();
    });
  });
});
