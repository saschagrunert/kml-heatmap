import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ReplayManager } from "../../../../kml_heatmap/frontend/ui/replayManager";
import type { MockMapApp } from "../../testHelpers";

describe("ReplayManager", () => {
  let replayManager: ReplayManager;
  let mockApp: MockMapApp;
  let replayBtn: HTMLButtonElement;

  beforeEach(() => {
    // Create replay button
    replayBtn = document.createElement("button");
    replayBtn.id = "replay-btn";
    document.body.appendChild(replayBtn);

    // Create mock app
    mockApp = {
      selectedPathIds: new Set<number>(),
      fullStats: null,
    } as MockMapApp;

    replayManager = new ReplayManager(mockApp);
  });

  afterEach(() => {
    const btn = document.getElementById("replay-btn");
    if (btn) {
      document.body.removeChild(btn);
    }
  });

  describe("updateReplayButtonState", () => {
    it("enables button when one path is selected and timing data is available", () => {
      mockApp.selectedPathIds.add(1);
      mockApp.fullStats = {
        max_groundspeed_knots: 150,
      } as any;

      replayManager.updateReplayButtonState();

      expect(replayBtn.style.opacity).toBe("1");
      expect(replayBtn.disabled).toBe(false);
      expect(replayBtn.getAttribute("aria-disabled")).toBe("false");
    });

    it("disables button when timing data is not available", () => {
      mockApp.selectedPathIds.add(1);
      mockApp.fullStats = {
        max_groundspeed_knots: 0,
      } as any;

      replayManager.updateReplayButtonState();

      expect(replayBtn.style.opacity).toBe("0.5");
      expect(replayBtn.disabled).toBe(true);
      expect(replayBtn.getAttribute("aria-disabled")).toBe("true");
    });

    it("disables button when max_groundspeed_knots is undefined", () => {
      mockApp.selectedPathIds.add(1);
      mockApp.fullStats = {} as any;

      replayManager.updateReplayButtonState();

      expect(replayBtn.style.opacity).toBe("0.5");
      expect(replayBtn.disabled).toBe(true);
      expect(replayBtn.getAttribute("aria-disabled")).toBe("true");
    });

    it("disables button when fullStats is null", () => {
      mockApp.selectedPathIds.add(1);
      mockApp.fullStats = null;

      replayManager.updateReplayButtonState();

      expect(replayBtn.style.opacity).toBe("0.5");
      expect(replayBtn.disabled).toBe(true);
      expect(replayBtn.getAttribute("aria-disabled")).toBe("true");
    });

    it("disables button when no paths are selected", () => {
      mockApp.fullStats = {
        max_groundspeed_knots: 150,
      } as any;

      replayManager.updateReplayButtonState();

      expect(replayBtn.style.opacity).toBe("0.5");
      expect(replayBtn.disabled).toBe(true);
      expect(replayBtn.getAttribute("aria-disabled")).toBe("true");
    });

    it("disables button when multiple paths are selected", () => {
      mockApp.selectedPathIds.add(1);
      mockApp.selectedPathIds.add(2);
      mockApp.fullStats = {
        max_groundspeed_knots: 150,
      } as any;

      replayManager.updateReplayButtonState();

      expect(replayBtn.style.opacity).toBe("0.5");
      expect(replayBtn.disabled).toBe(true);
      expect(replayBtn.getAttribute("aria-disabled")).toBe("true");
    });

    it("handles missing replay button gracefully", () => {
      const btn = document.getElementById("replay-btn");
      if (btn) {
        document.body.removeChild(btn);
      }

      expect(() => replayManager.updateReplayButtonState()).not.toThrow();
    });
  });
});
