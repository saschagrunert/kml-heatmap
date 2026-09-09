/**
 * ReplayManager: path redraw, frame display updates and the airplane popup.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ReplayManager } from "../../../../kml_heatmap/frontend/ui/replayManager";
import * as colors from "../../../../kml_heatmap/frontend/utils/colors";
import * as replayFeature from "../../../../kml_heatmap/frontend/features/replay";
import { generateSegmentPopupHtml } from "../../../../kml_heatmap/frontend/utils/htmlGenerators";
import {
  createReplayManager,
  createReplayMockApp,
  el,
  mockAnimationFrame,
  mountReplayDom,
  unmountReplayDom,
  type ReplayMockApp,
} from "./replayTestSetup";

vi.mock("../../../../kml_heatmap/frontend/utils/htmlGenerators", () => ({
  generateSegmentPopupHtml: vi.fn(() => "<div>popup</div>"),
}));

type AnyMock = ReturnType<typeof vi.fn>;

describe("ReplayManager display", () => {
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
    vi.mocked(generateSegmentPopupHtml).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    unmountReplayDom();
    vi.restoreAllMocks();
  });

  describe("redrawReplayPath", () => {
    beforeEach(() => {
      replayManager.state.currentTime = 100;
      replayManager.state.lastDrawnIndex = 2;
    });

    it("clears layer and redraws segments up to savedIndex with altitude colors", () => {
      const altitudeSpy = vi.spyOn(colors, "getColorForAltitude");

      replayManager.redrawReplayPath("altitude");

      expect(replayManager.state.layer!.clearLayers).toHaveBeenCalled();
      // Segments at t=0 and t=60 are at or before t=100
      expect(replayManager.state.lastDrawnIndex).toBe(1);
      expect(altitudeSpy).toHaveBeenCalledTimes(2);
      expect(altitudeSpy).toHaveBeenCalledWith(3000, 3000, 5000);
    });

    it("clears layer and redraws segments with airspeed colors", () => {
      const airspeedSpy = vi.spyOn(colors, "getColorForAirspeed");

      replayManager.redrawReplayPath("airspeed");

      expect(replayManager.state.layer!.clearLayers).toHaveBeenCalled();
      expect(airspeedSpy).toHaveBeenCalledTimes(2);
      expect(airspeedSpy).toHaveBeenCalledWith(100, 100, 130);
    });

    it("rebuilds the trim stack so a later backward seek still works", () => {
      replayManager.redrawReplayPath("airspeed");

      // Stale references would make removeSegmentsAfter remove nothing visible
      expect(replayManager.state.drawnLayers).toHaveLength(2);
      const removeSpy = replayManager.state.layer!.removeLayer as AnyMock;
      removeSpy.mockClear();

      replayManager.seekReplay("0");

      expect(removeSpy).toHaveBeenCalledTimes(1);
      expect(replayManager.state.drawnLayers).toHaveLength(1);
      expect(replayManager.state.lastDrawnIndex).toBe(0);
    });

    it("draws zero-groundspeed segments with the altitude colour", () => {
      // Skipping them would both hide part of the trail and desync
      // drawnLayers from lastDrawnIndex, breaking a later backward seek
      const altitudeSpy = vi.spyOn(colors, "getColorForAltitude");
      const airspeedSpy = vi.spyOn(colors, "getColorForAirspeed");
      replayManager.state.segments = [
        {
          path_id: 1,
          coords: [
            [51, 10],
            [51.1, 10.1],
          ],
          altitude_ft: 1000,
          groundspeed_knots: 0,
          time: 50,
        },
      ];
      replayManager.state.lastDrawnIndex = 0;

      replayManager.redrawReplayPath("airspeed");

      expect(replayManager.state.lastDrawnIndex).toBe(0);
      expect(replayManager.state.drawnLayers).toHaveLength(1);
      expect(altitudeSpy).toHaveBeenCalledWith(1000, 3000, 5000);
      expect(airspeedSpy).not.toHaveBeenCalled();
    });

    it("keeps drawnLayers aligned with lastDrawnIndex when speeds vary", () => {
      // The trim stack is popped one entry per index, so a redraw that
      // covered fewer segments than the index range would remove the wrong
      // polylines on the next backward seek
      replayManager.state.segments = [
        {
          path_id: 1,
          coords: [
            [51, 10],
            [51.1, 10.1],
          ],
          altitude_ft: 1000,
          groundspeed_knots: 100,
          time: 0,
        },
        {
          path_id: 1,
          coords: [
            [51.1, 10.1],
            [51.2, 10.2],
          ],
          altitude_ft: 1200,
          groundspeed_knots: 0,
          time: 30,
        },
        {
          path_id: 1,
          coords: [
            [51.2, 10.2],
            [51.3, 10.3],
          ],
          altitude_ft: 1400,
          groundspeed_knots: 120,
          time: 60,
        },
      ];
      replayManager.state.currentTime = 100;
      replayManager.state.lastDrawnIndex = 2;

      replayManager.redrawReplayPath("airspeed");

      expect(replayManager.state.drawnLayers).toHaveLength(
        replayManager.state.lastDrawnIndex + 1,
      );
    });

    it("does nothing if layer is null", () => {
      replayManager.state.layer = null;

      expect(() => replayManager.redrawReplayPath("altitude")).not.toThrow();
      expect(replayManager.state.lastDrawnIndex).toBe(2);
    });
  });

  describe("updateReplayDisplay", () => {
    it("updates time display and slider value text", () => {
      replayManager.state.currentTime = 60;

      replayManager.updateReplayDisplay();

      expect(el("replay-time-display").textContent).toBe("1:00 / 2:00");
      const slider = el("replay-slider") as HTMLInputElement;
      expect(slider.value).toBe("60");
      expect(slider.getAttribute("aria-valuetext")).toBe("1:00 of 2:00");
      expect(el("replay-slider-start").textContent).toBe("1:00");
    });

    it("draws path segments incrementally from the last drawn index", () => {
      const altitudeSpy = vi.spyOn(colors, "getColorForAltitude");
      replayManager.state.currentTime = 65;

      replayManager.updateReplayDisplay();
      expect(replayManager.state.lastDrawnIndex).toBe(1);
      expect(altitudeSpy).toHaveBeenCalledTimes(2);

      // The next frame only draws newly reached segments
      replayManager.state.currentTime = 125;
      replayManager.updateReplayDisplay();
      expect(replayManager.state.lastDrawnIndex).toBe(2);
      expect(altitudeSpy).toHaveBeenCalledTimes(3);
    });

    it("does not draw segments when at time 0", () => {
      replayManager.state.currentTime = 0;
      replayManager.state.lastDrawnIndex = -1;

      replayManager.updateReplayDisplay();

      expect(replayManager.state.lastDrawnIndex).toBe(-1);
    });

    it("tracks the current segment index", () => {
      replayManager.state.currentTime = 65;

      replayManager.updateReplayDisplay();

      expect(replayManager.state.currentIndex).toBe(1);
    });

    it("positions airplane at first segment when no segment has started", () => {
      replayManager.state.currentTime = -1;
      const setLatLng = replayManager.state.airplaneMarker!
        .setLatLng as AnyMock;
      setLatLng.mockClear();

      replayManager.updateReplayDisplay();

      expect(setLatLng).toHaveBeenCalledWith([48.0, 16.0]);
      expect(replayManager.state.currentIndex).toBe(-1);
    });

    it("uses airspeed colors when airspeed visible and altitude not visible", () => {
      const airspeedSpy = vi.spyOn(colors, "getColorForAirspeed");
      mockApp.airspeedVisible = true;
      mockApp.altitudeVisible = false;
      replayManager.state.currentTime = 65;

      replayManager.updateReplayDisplay();

      expect(airspeedSpy).toHaveBeenCalledWith(100, 100, 130);
    });

    it("adds airplane marker back to map if it was removed", () => {
      mockApp.map!.hasLayer.mockReturnValue(false);
      replayManager.state.currentTime = 30;

      replayManager.updateReplayDisplay();

      expect(replayManager.state.airplaneMarker!.addTo).toHaveBeenCalledWith(
        mockApp.map,
      );
    });

    it("updates airplane rotation via element transform", () => {
      replayManager.state.currentTime = 65;
      const mockElement = document.createElement("div");
      const iconDiv = document.createElement("div");
      iconDiv.className = "replay-airplane-icon";
      mockElement.appendChild(iconDiv);
      (
        replayManager.state.airplaneMarker!.getElement as AnyMock
      ).mockReturnValue(mockElement);

      replayManager.updateReplayDisplay();

      expect(iconDiv.style.transform).toMatch(
        /^translate3d\(0,0,0\) rotate\(-?[\d.]+deg\)$/,
      );
    });

    it("pans map when airplane is near edge during playing", () => {
      replayManager.state.playing = true;
      replayManager.state.currentTime = 65;
      mockApp.map!.latLngToContainerPoint.mockReturnValue({
        x: 10,
        y: 300,
      });

      replayManager.updateReplayDisplay();

      expect(mockApp.map!.panTo).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({ animate: true }),
      );
    });

    it("does not pan on manual seek while the airplane is well inside the viewport", () => {
      replayManager.state.playing = false;
      replayManager.state.currentTime = 65;
      mockApp.map!.latLngToContainerPoint.mockReturnValue({
        x: 400,
        y: 300,
      });
      mockApp.map!.panTo.mockClear();

      replayManager.updateReplayDisplay(true);

      expect(mockApp.map!.panTo).not.toHaveBeenCalled();
    });

    it("pans without animation on manual seek when the airplane leaves the viewport", () => {
      replayManager.state.playing = false;
      replayManager.state.currentTime = 65;
      mockApp.map!.latLngToContainerPoint.mockReturnValue({
        x: -20,
        y: 300,
      });
      mockApp.map!.panTo.mockClear();

      replayManager.updateReplayDisplay(true);

      expect(mockApp.map!.panTo).toHaveBeenCalledTimes(1);
      expect(mockApp.map!.panTo).toHaveBeenCalledWith(expect.any(Array), {
        animate: false,
      });
    });

    it("interpolates position between segments", () => {
      replayManager.state.currentTime = 30;
      const setLatLng = replayManager.state.airplaneMarker!
        .setLatLng as AnyMock;
      setLatLng.mockClear();

      replayManager.updateReplayDisplay();

      // Halfway between the end of segment 0 and the start of segment 1
      // (both [48.1, 16.1]), so the interpolated position is that point
      expect(setLatLng).toHaveBeenCalledTimes(1);
      const [lat, lon] = setLatLng.mock.calls[0]![0] as [number, number];
      expect(lat).toBeCloseTo(48.1, 5);
      expect(lon).toBeCloseTo(16.1, 5);
    });

    it("uses last known bearing when smoothed bearing is null", () => {
      vi.spyOn(replayFeature, "calculateSmoothedBearing").mockReturnValue(null);
      replayManager.state.lastBearing = 45;
      replayManager.state.currentTime = 65;
      const mockElement = document.createElement("div");
      const iconDiv = document.createElement("div");
      iconDiv.className = "replay-airplane-icon";
      mockElement.appendChild(iconDiv);
      (
        replayManager.state.airplaneMarker!.getElement as AnyMock
      ).mockReturnValue(mockElement);

      replayManager.updateReplayDisplay();

      expect(replayManager.state.lastBearing).toBe(45);
      expect(iconDiv.style.transform).toContain("rotate(0deg)");
    });

    it("auto-zooms out when too many recenters happen", () => {
      replayManager.state.playing = true;
      replayManager.state.autoZoom = true;
      replayManager.state.lastZoom = 14;
      replayManager.state.currentTime = 65;
      mockApp.map!.latLngToContainerPoint.mockReturnValue({
        x: 10,
        y: 300,
      });
      const now = Date.now();
      replayManager.state.recenterTimestamps = [
        now - 1000,
        now - 500,
        now - 100,
      ];

      replayManager.updateReplayDisplay();

      expect(mockApp.map!.setZoom).toHaveBeenCalledWith(
        13,
        expect.objectContaining({ animate: true }),
      );
      expect(replayManager.state.lastZoom).toBe(13);
      expect(replayManager.state.recenterTimestamps).toEqual([]);
    });
  });

  describe("updateReplayDisplay - popup auto-update", () => {
    it("updates airplane popup when popup is open during display update", () => {
      replayManager.state.currentTime = 65;
      const mockPopup = { setContent: vi.fn() };
      (replayManager.state.airplaneMarker!.getPopup as AnyMock).mockReturnValue(
        mockPopup,
      );
      (
        replayManager.state.airplaneMarker!.isPopupOpen as AnyMock
      ).mockReturnValue(true);

      replayManager.updateReplayDisplay();

      expect(mockPopup.setContent).toHaveBeenCalledWith("<div>popup</div>");
      expect(generateSegmentPopupHtml).toHaveBeenCalledWith(
        expect.objectContaining({
          segment: replayManager.state.segments[1],
          title: "Current Position",
        }),
      );
    });

    it("does not touch the popup when it is closed", () => {
      replayManager.state.currentTime = 65;
      const mockPopup = { setContent: vi.fn() };
      (replayManager.state.airplaneMarker!.getPopup as AnyMock).mockReturnValue(
        mockPopup,
      );
      (
        replayManager.state.airplaneMarker!.isPopupOpen as AnyMock
      ).mockReturnValue(false);

      replayManager.updateReplayDisplay();

      expect(mockPopup.setContent).not.toHaveBeenCalled();
    });
  });

  describe("updateReplayAirplanePopup", () => {
    it("does nothing without an airplane marker", () => {
      replayManager.state.airplaneMarker = null;

      replayManager.updateReplayAirplanePopup();

      expect(generateSegmentPopupHtml).not.toHaveBeenCalled();
    });

    it("does nothing when replay is not active", () => {
      replayManager.state.active = false;

      replayManager.updateReplayAirplanePopup();

      expect(generateSegmentPopupHtml).not.toHaveBeenCalled();
      expect(
        replayManager.state.airplaneMarker!.openPopup,
      ).not.toHaveBeenCalled();
    });

    it("creates popup with the segment at the current time", () => {
      replayManager.state.currentTime = 30;

      replayManager.updateReplayAirplanePopup();

      expect(generateSegmentPopupHtml).toHaveBeenCalledWith(
        expect.objectContaining({
          segment: replayManager.state.segments[0],
          altMin: 3000,
          altMax: 5000,
          speedMin: 100,
          speedMax: 130,
          icon: "✈️",
        }),
      );
      expect(
        replayManager.state.airplaneMarker!.bindPopup,
      ).toHaveBeenCalledWith(
        "<div>popup</div>",
        expect.objectContaining({ autoPanPadding: [50, 50] }),
      );
      expect(replayManager.state.airplaneMarker!.openPopup).toHaveBeenCalled();
    });

    it("uses first segment when no segment has time <= currentTime", () => {
      replayManager.state.currentTime = -10;

      replayManager.updateReplayAirplanePopup();

      expect(generateSegmentPopupHtml).toHaveBeenCalledWith(
        expect.objectContaining({ segment: replayManager.state.segments[0] }),
      );
    });

    it("returns early when replaySegments is empty", () => {
      replayManager.state.segments = [];

      replayManager.updateReplayAirplanePopup();

      expect(generateSegmentPopupHtml).not.toHaveBeenCalled();
      expect(
        replayManager.state.airplaneMarker!.bindPopup,
      ).not.toHaveBeenCalled();
    });

    it("updates existing popup content instead of creating new one", () => {
      const mockPopup = { setContent: vi.fn() };
      (replayManager.state.airplaneMarker!.getPopup as AnyMock).mockReturnValue(
        mockPopup,
      );
      replayManager.state.currentTime = 30;

      replayManager.updateReplayAirplanePopup();

      expect(mockPopup.setContent).toHaveBeenCalledWith("<div>popup</div>");
      expect(
        replayManager.state.airplaneMarker!.bindPopup,
      ).not.toHaveBeenCalled();
    });
  });
});
