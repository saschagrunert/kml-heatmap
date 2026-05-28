import { describe, it, expect } from "vitest";
import { ReplayState } from "../../../../kml_heatmap/frontend/ui/replayState";

describe("ReplayState", () => {
  describe("default values", () => {
    it("initializes with correct defaults", () => {
      const state = new ReplayState();

      expect(state.active).toBe(false);
      expect(state.playing).toBe(false);
      expect(state.currentTime).toBe(0);
      expect(state.maxTime).toBe(0);
      expect(state.speed).toBe(50.0);
      expect(state.layer).toBeNull();
      expect(state.segments).toEqual([]);
      expect(state.airplaneMarker).toBeNull();
      expect(state.lastDrawnIndex).toBe(-1);
      expect(state.lastBearing).toBeNull();
      expect(state.animationFrameId).toBeNull();
      expect(state.lastFrameTime).toBeNull();
      expect(state.colorMinAlt).toBe(0);
      expect(state.colorMaxAlt).toBe(10000);
      expect(state.colorMinSpeed).toBe(0);
      expect(state.colorMaxSpeed).toBe(200);
      expect(state.autoZoom).toBe(false);
      expect(state.lastZoom).toBeNull();
      expect(state.recenterTimestamps).toEqual([]);
    });
  });

  describe("resetDrawState", () => {
    it("resets drawing-related properties", () => {
      const state = new ReplayState();
      state.currentTime = 120;
      state.lastDrawnIndex = 50;
      state.lastBearing = 180;
      state.recenterTimestamps = [1000, 2000, 3000];

      state.resetDrawState();

      expect(state.currentTime).toBe(0);
      expect(state.lastDrawnIndex).toBe(-1);
      expect(state.lastBearing).toBeNull();
      expect(state.recenterTimestamps).toEqual([]);
    });

    it("preserves non-drawing properties", () => {
      const state = new ReplayState();
      state.active = true;
      state.playing = true;
      state.speed = 100;
      state.maxTime = 500;
      state.colorMinAlt = 200;
      state.colorMaxAlt = 8000;
      state.autoZoom = true;

      state.resetDrawState();

      expect(state.active).toBe(true);
      expect(state.playing).toBe(true);
      expect(state.speed).toBe(100);
      expect(state.maxTime).toBe(500);
      expect(state.colorMinAlt).toBe(200);
      expect(state.colorMaxAlt).toBe(8000);
      expect(state.autoZoom).toBe(true);
    });

    it("can be called multiple times", () => {
      const state = new ReplayState();
      state.currentTime = 100;
      state.resetDrawState();
      state.currentTime = 200;
      state.resetDrawState();

      expect(state.currentTime).toBe(0);
      expect(state.lastDrawnIndex).toBe(-1);
    });
  });
});
