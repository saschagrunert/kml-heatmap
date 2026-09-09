/**
 * ReplayManager: play, pause, stop, seek, speed and auto-zoom.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ReplayManager } from "../../../../kml_heatmap/frontend/ui/replayManager";
import {
  createReplayManager,
  createReplayMockApp,
  el,
  liveRegionText,
  mockAnimationFrame,
  mountReplayDom,
  unmountReplayDom,
  type ReplayMockApp,
} from "./replayTestSetup";

vi.mock("../../../../kml_heatmap/frontend/utils/htmlGenerators", () => ({
  generateSegmentPopupHtml: vi.fn(() => "<div>popup</div>"),
}));

describe("ReplayManager playback", () => {
  let replayManager: ReplayManager;
  let mockApp: ReplayMockApp;

  beforeEach(() => {
    vi.useFakeTimers();
    mountReplayDom();
    mockAnimationFrame();
    mockApp = createReplayMockApp();
    replayManager = createReplayManager(mockApp);
    mockApp.selectedPathIds = new Set([1]);
    replayManager.initializeReplay();
    replayManager.state.active = true;
  });

  afterEach(() => {
    vi.useRealTimers();
    unmountReplayDom();
    vi.restoreAllMocks();
  });

  describe("playReplay", () => {
    it("returns early if not active", () => {
      replayManager.state.active = false;

      replayManager.playReplay();

      expect(replayManager.state.playing).toBe(false);
      expect(requestAnimationFrame).not.toHaveBeenCalled();
    });

    it("returns early if no map", () => {
      mockApp.map = null;

      replayManager.playReplay();

      expect(replayManager.state.playing).toBe(false);
    });

    it("sets playing state, swaps play/pause buttons and announces", () => {
      replayManager.playReplay();

      expect(replayManager.state.playing).toBe(true);
      expect(el("replay-play-btn").hidden).toBe(true);
      expect(el("replay-pause-btn").hidden).toBe(false);
      expect(liveRegionText()).toBe("Replay playing");
    });

    it("starts a single animation frame loop", () => {
      replayManager.playReplay();

      expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
      expect(replayManager.state.animationFrameId).not.toBeNull();
    });

    it("does not start a second loop while already playing", () => {
      replayManager.playReplay();
      const firstFrameId = replayManager.state.animationFrameId;

      replayManager.playReplay();

      expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
      expect(replayManager.state.animationFrameId).toBe(firstFrameId);
    });

    it("does not persist state when playing", () => {
      replayManager.playReplay();

      expect(mockApp.stateManager.saveMapState).not.toHaveBeenCalled();
    });

    it("restarts from beginning when at the end", () => {
      replayManager.state.currentTime = replayManager.state.maxTime;
      replayManager.state.lastDrawnIndex = 2;
      replayManager.state.currentIndex = 2;

      replayManager.playReplay();

      expect(replayManager.state.currentTime).toBe(0);
      expect(replayManager.state.lastDrawnIndex).toBe(-1);
      expect(replayManager.state.currentIndex).toBe(-1);
      expect(replayManager.state.layer!.clearLayers).toHaveBeenCalled();
    });

    it("resets airplane to start when restarting from end", () => {
      replayManager.state.currentTime = replayManager.state.maxTime;

      replayManager.playReplay();

      expect(
        replayManager.state.airplaneMarker!.setLatLng,
      ).toHaveBeenCalledWith([48.0, 16.0]);
    });

    it("resets to initial zoom when restarting with autoZoom enabled", () => {
      replayManager.state.currentTime = replayManager.state.maxTime;
      replayManager.state.autoZoom = true;

      replayManager.playReplay();

      expect(mockApp.map!.setView).toHaveBeenCalledWith(
        [48.0, 16.0],
        16,
        expect.objectContaining({ animate: true }),
      );
      expect(replayManager.state.lastZoom).toBe(16);
    });

    it("advances time with the configured speed and keeps looping", () => {
      replayManager.state.speed = 50;
      replayManager.playReplay();

      // First frame only records the timestamp, the second one advances
      vi.advanceTimersByTime(16);
      vi.advanceTimersByTime(16);

      expect(replayManager.state.playing).toBe(true);
      expect(replayManager.state.currentTime).toBeGreaterThan(0);
      expect(replayManager.state.currentTime).toBeLessThan(
        replayManager.state.maxTime,
      );
      expect(requestAnimationFrame).toHaveBeenCalledTimes(3);
    });

    it("pauses, fits bounds and announces when reaching max time", () => {
      replayManager.state.currentTime = replayManager.state.maxTime - 0.001;
      replayManager.state.speed = 1000;

      replayManager.playReplay();
      vi.advanceTimersByTime(50);

      expect(replayManager.state.playing).toBe(false);
      expect(replayManager.state.currentTime).toBe(replayManager.state.maxTime);
      expect(mockApp.map!.fitBounds).toHaveBeenCalled();
      expect(liveRegionText()).toBe("Replay finished");
      expect(el("replay-play-btn").hidden).toBe(false);
    });

    it("stops the loop when playing is set to false", () => {
      replayManager.playReplay();
      replayManager.state.playing = false;

      vi.advanceTimersByTime(20);

      expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
      expect(replayManager.state.currentTime).toBe(0);
    });
  });

  describe("pauseReplay", () => {
    it("sets playing to false and swaps buttons", () => {
      replayManager.playReplay();

      replayManager.pauseReplay();

      expect(replayManager.state.playing).toBe(false);
      expect(el("replay-play-btn").hidden).toBe(false);
      expect(el("replay-pause-btn").hidden).toBe(true);
    });

    it("cancels animation frame", () => {
      replayManager.state.animationFrameId = 42;

      replayManager.pauseReplay();

      expect(cancelAnimationFrame).toHaveBeenCalledWith(42);
      expect(replayManager.state.animationFrameId).toBeNull();
    });

    it("resets frame time", () => {
      replayManager.state.lastFrameTime = 12345;

      replayManager.pauseReplay();

      expect(replayManager.state.lastFrameTime).toBeNull();
    });

    it("announces the paused position when it was playing", () => {
      replayManager.playReplay();
      replayManager.state.currentTime = 65;

      replayManager.pauseReplay();

      expect(liveRegionText()).toBe("Replay paused at 1:05");
    });

    it("does not announce when it was not playing", () => {
      replayManager.pauseReplay();

      expect(liveRegionText()).toBe("");
    });

    it("does not persist state when pausing", () => {
      replayManager.playReplay();
      replayManager.pauseReplay();

      expect(mockApp.stateManager.saveMapState).not.toHaveBeenCalled();
    });
  });

  describe("stopReplay", () => {
    it("pauses and resets time", () => {
      replayManager.state.currentTime = 50;

      replayManager.stopReplay();

      expect(replayManager.state.playing).toBe(false);
      expect(replayManager.state.currentTime).toBe(0);
      expect(replayManager.state.lastDrawnIndex).toBe(-1);
      expect(liveRegionText()).toBe("Replay stopped");
    });

    it("clears replay layer", () => {
      replayManager.stopReplay();

      expect(replayManager.state.layer!.clearLayers).toHaveBeenCalled();
    });

    it("resets airplane to start position", () => {
      replayManager.stopReplay();

      expect(
        replayManager.state.airplaneMarker!.setLatLng,
      ).toHaveBeenCalledWith([48.0, 16.0]);
    });

    it("resets the slider and time display", () => {
      replayManager.state.currentTime = 50;

      replayManager.stopReplay();

      expect((el("replay-slider") as HTMLInputElement).value).toBe("0");
      expect(el("replay-time-display").textContent).toBe("0:00 / 2:00");
    });
  });

  describe("seekReplay", () => {
    it("sets current time from string value", () => {
      replayManager.seekReplay("60.5");

      expect(replayManager.state.currentTime).toBe(60.5);
      expect((el("replay-slider") as HTMLInputElement).value).toBe("60.5");
    });

    it("removes only the segments after the new time when seeking backward", () => {
      replayManager.seekReplay("100");
      expect(replayManager.state.lastDrawnIndex).toBe(1);
      const clearSpy = replayManager.state.layer!.clearLayers as ReturnType<
        typeof vi.fn
      >;
      const removeSpy = replayManager.state.layer!.removeLayer as ReturnType<
        typeof vi.fn
      >;
      clearSpy.mockClear();
      removeSpy.mockClear();

      replayManager.seekReplay("30");

      // A full clear would redraw the whole flight on every drag event
      expect(clearSpy).not.toHaveBeenCalled();
      expect(removeSpy).toHaveBeenCalledTimes(1);
      expect(replayManager.state.currentTime).toBe(30);
      // Only the segment at t=0 is visible again
      expect(replayManager.state.lastDrawnIndex).toBe(0);
      expect(replayManager.state.drawnLayers).toHaveLength(1);
    });

    it("does not clear when seeking forward", () => {
      replayManager.seekReplay("30");
      const clearSpy = replayManager.state.layer!.clearLayers as ReturnType<
        typeof vi.fn
      >;
      clearSpy.mockClear();

      replayManager.seekReplay("60");

      expect(clearSpy).not.toHaveBeenCalled();
      expect(replayManager.state.lastDrawnIndex).toBe(1);
    });

    it("does not persist state when seeking", () => {
      replayManager.seekReplay("30");

      expect(mockApp.stateManager.saveMapState).not.toHaveBeenCalled();
    });

    it("does not announce every seek step", () => {
      replayManager.seekReplay("30");

      expect(liveRegionText()).toBe("");
    });
  });

  describe("changeReplaySpeed", () => {
    it("updates speed from select element", () => {
      (el("replay-speed") as HTMLSelectElement).value = "100";

      replayManager.changeReplaySpeed();

      expect(replayManager.state.speed).toBe(100);
      expect(mockApp.stateManager.saveMapState).not.toHaveBeenCalled();
    });

    it("keeps the speed if no speed select element", () => {
      el("replay-speed").remove();

      replayManager.changeReplaySpeed();

      expect(replayManager.state.speed).toBe(50.0);
    });
  });

  describe("toggleAutoZoom", () => {
    it("toggles autoZoom on and marks the button pressed", () => {
      replayManager.state.autoZoom = false;

      replayManager.toggleAutoZoom();

      expect(replayManager.state.autoZoom).toBe(true);
      const btn = el("replay-autozoom-btn");
      expect(btn.style.opacity).toBe("1");
      expect(btn.getAttribute("aria-pressed")).toBe("true");
      expect(btn.title).toBe("Auto-zoom enabled");
    });

    it("toggles autoZoom off", () => {
      replayManager.state.autoZoom = true;

      replayManager.toggleAutoZoom();

      expect(replayManager.state.autoZoom).toBe(false);
      const btn = el("replay-autozoom-btn");
      expect(btn.style.opacity).toBe("0.5");
      expect(btn.getAttribute("aria-pressed")).toBe("false");
      expect(btn.title).toBe("Auto-zoom disabled");
    });

    it("does not persist state", () => {
      replayManager.toggleAutoZoom();

      expect(mockApp.stateManager.saveMapState).not.toHaveBeenCalled();
    });

    it("works without the auto-zoom button", () => {
      el("replay-autozoom-btn").remove();

      replayManager.toggleAutoZoom();

      expect(replayManager.state.autoZoom).toBe(true);
    });
  });
});
