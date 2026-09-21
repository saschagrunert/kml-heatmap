/**
 * ReplayManager: path redraw, frame display updates and the airplane popup.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ReplayManager } from "../../../../kml_heatmap/frontend/ui/replayManager";
import {
  getColorForAirspeed,
  getColorForAltitude,
} from "../../../../kml_heatmap/frontend/utils/colors";
import * as replayFeature from "../../../../kml_heatmap/frontend/features/replay";
import { generateSegmentPopupHtml } from "../../../../kml_heatmap/frontend/utils/htmlGenerators";
import * as mapHelpers from "../../../../kml_heatmap/frontend/utils/mapHelpers";
import type { ReplayAirplane } from "../../../../kml_heatmap/frontend/ui/replayState";
import {
  createReplayManager,
  createReplayMockApp,
  el,
  featuresOf,
  mockAnimationFrame,
  mountReplayDom,
  replaySources,
  unmountReplayDom,
  type MockApp,
} from "./replayTestSetup";

vi.mock("../../../../kml_heatmap/frontend/utils/htmlGenerators", () => ({
  generateSegmentPopupHtml: vi.fn(() => "<div>popup</div>"),
}));

describe("ReplayManager display", () => {
  let replayManager: ReplayManager;
  let mockApp: MockApp;

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
    replaySources(mockApp).route.setData.mockClear();
    replaySources(mockApp).trail.setData.mockClear();
  });

  /** Let the frame run in which the trail is handed to the map */
  function runFrame(): void {
    vi.advanceTimersByTime(16);
  }

  /** Colours of the trail on the map, one per run, in flight order */
  function drawnColors(): unknown[] {
    runFrame();
    return featuresOf(replaySources(mockApp).trail).map(
      (feature) => feature.properties["color"],
    );
  }

  function airplane(): ReplayAirplane {
    return replayManager.state.airplaneMarker!;
  }

  /** Where the map says the airplane is, in pixels of an 800 x 600 map */
  function airplaneAt(x: number, y: number): void {
    mockApp.map!.project.mockReturnValue({ x, y });
  }

  /** Positions the airplane was moved to, latitude first */
  function positions(): [number, number][] {
    return vi.mocked(airplane().marker.setLngLat).mock.calls.map(([lngLat]) => {
      const [lng, lat] = lngLat as [number, number];
      return [lat, lng];
    });
  }

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

    it("rebuilds the trail up to savedIndex with altitude colors", () => {
      replayManager.redrawReplayPath("altitude");

      // Segments at t=0 and t=60 are at or before t=100
      expect(replayManager.state.lastDrawnIndex).toBe(1);
      expect(drawnColors()).toEqual([
        getColorForAltitude(3000, 3000, 5000),
        getColorForAltitude(4000, 3000, 5000),
      ]);
    });

    it("rebuilds the trail with airspeed colors", () => {
      replayManager.redrawReplayPath("airspeed");

      expect(drawnColors()).toEqual([
        getColorForAirspeed(100, 100, 130),
        getColorForAirspeed(120, 100, 130),
      ]);
    });

    it("switches the colours of a trail that is already on the map", () => {
      replayManager.state.lastDrawnIndex = -1;
      replayManager.state.currentTime = 100;
      replayManager.updateReplayDisplay();
      expect(drawnColors()).toEqual([
        getColorForAltitude(3000, 3000, 5000),
        getColorForAltitude(4000, 3000, 5000),
      ]);

      replayManager.redrawReplayPath("airspeed");

      expect(drawnColors()).toEqual([
        getColorForAirspeed(100, 100, 130),
        getColorForAirspeed(120, 100, 130),
      ]);
      // One write for the trail as it was flown, one for the new colours
      expect(replaySources(mockApp).trail.setData).toHaveBeenCalledTimes(2);
    });

    it("leaves the route alone: it is laid down once, when replay opens", () => {
      replayManager.redrawReplayPath("altitude");
      runFrame();

      const { route } = replaySources(mockApp);
      expect(route.setData).not.toHaveBeenCalled();
      // One point per segment, plus the end of the last one
      expect(featuresOf(route)[0]!.geometry.coordinates).toHaveLength(
        replayManager.state.segments.length + 1,
      );
    });

    it("rebuilds the runs so a later backward seek still works", () => {
      replayManager.redrawReplayPath("airspeed");
      expect(replayManager.state.trailRuns).toHaveLength(2);

      replayManager.seekReplay("0");

      expect(replayManager.state.trailRuns).toHaveLength(1);
      expect(replayManager.state.lastDrawnIndex).toBe(0);
      expect(drawnColors()).toEqual([getColorForAirspeed(100, 100, 130)]);
    });

    it("draws zero-groundspeed segments with the altitude colour", () => {
      // Skipping them would hide part of the trail
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
      expect(replayManager.state.trailRuns).toHaveLength(1);
      expect(drawnColors()).toEqual([getColorForAltitude(1000, 3000, 5000)]);
    });

    it("keeps the runs aligned with lastDrawnIndex when speeds vary", () => {
      // A backward seek cuts the runs by segment index, so a redraw that
      // covered fewer segments than the index range would cut the wrong
      // part of the trail
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

      const runs = replayManager.state.trailRuns;
      expect(replayManager.state.lastDrawnIndex).toBe(2);
      expect(runs[0]!.firstIndex).toBe(0);
      expect(runs[runs.length - 1]!.lastIndex).toBe(2);
      // Every segment is in exactly one run
      const covered = runs.reduce(
        (sum, run) => sum + run.lastIndex - run.firstIndex + 1,
        0,
      );
      expect(covered).toBe(3);
    });

    it("does nothing while the replay layer is not set up", () => {
      replayManager.state.layerActive = false;

      expect(() => replayManager.redrawReplayPath("altitude")).not.toThrow();
      expect(replayManager.state.lastDrawnIndex).toBe(2);
      runFrame();
      expect(replaySources(mockApp).trail.setData).not.toHaveBeenCalled();
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

    it("writes the transport row only when its text changes", () => {
      replayManager.state.currentTime = 60;
      replayManager.updateReplayDisplay();
      const timeDisplay = el("replay-time-display");
      const sliderStart = el("replay-slider-start");
      // A sentinel survives a frame that changes nothing visible
      timeDisplay.textContent = "sentinel";
      sliderStart.textContent = "sentinel";

      replayManager.state.currentTime = 60.2;
      replayManager.updateReplayDisplay();

      expect(timeDisplay.textContent).toBe("sentinel");
      expect(sliderStart.textContent).toBe("sentinel");
      // The slider itself moves with the fine time value
      expect((el("replay-slider") as HTMLInputElement).value).toBe("60.2");

      replayManager.state.currentTime = 61;
      replayManager.updateReplayDisplay();

      expect(timeDisplay.textContent).toBe("1:01 / 2:00");
      expect(sliderStart.textContent).toBe("1:01");
    });

    it("draws path segments incrementally from the last drawn index", () => {
      replayManager.state.currentTime = 65;

      replayManager.updateReplayDisplay();
      expect(replayManager.state.lastDrawnIndex).toBe(1);
      expect(drawnColors()).toHaveLength(2);

      // The next frame only draws newly reached segments
      replayManager.state.currentTime = 125;
      replayManager.updateReplayDisplay();
      expect(replayManager.state.lastDrawnIndex).toBe(2);
      expect(drawnColors()).toHaveLength(3);
    });

    it("tells the map of the trail only in frames that drew a segment", () => {
      const { trail } = replaySources(mockApp);

      // Several frames on the first segment: one write, for the first
      for (const time of [5, 10, 15, 20]) {
        replayManager.state.currentTime = time;
        replayManager.updateReplayDisplay();
        runFrame();
      }
      expect(trail.setData).toHaveBeenCalledTimes(1);

      // Several positions of a slider drag within one frame: one write
      for (const time of [65, 125]) {
        replayManager.state.currentTime = time;
        replayManager.updateReplayDisplay(true);
      }
      runFrame();
      expect(trail.setData).toHaveBeenCalledTimes(2);
      expect(featuresOf(trail)).toHaveLength(3);
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
      airplane().setLatLng([0, 0]);

      replayManager.updateReplayDisplay();

      expect(airplane().getLatLng()).toEqual([48.0, 16.0]);
      expect(replayManager.state.currentIndex).toBe(-1);
    });

    it("uses airspeed colors when airspeed visible and altitude not visible", () => {
      mockApp.airspeedVisible = true;
      mockApp.altitudeVisible = false;
      replayManager.state.currentTime = 65;

      replayManager.updateReplayDisplay();

      expect(drawnColors()).toEqual([
        getColorForAirspeed(100, 100, 130),
        getColorForAirspeed(120, 100, 130),
      ]);
    });

    it("updates airplane rotation via element transform", () => {
      replayManager.state.currentTime = 65;
      const iconDiv = airplane()
        .getElement()
        .querySelector<HTMLElement>(".replay-airplane-icon")!;

      replayManager.updateReplayDisplay();

      expect(iconDiv.style.transform).toMatch(
        /^translate3d\(0,0,0\) rotate\(-?[\d.]+deg\)$/,
      );
    });

    it("pans map when airplane is near edge during playing", () => {
      replayManager.state.playing = true;
      replayManager.state.currentTime = 65;
      airplaneAt(10, 300);
      mockApp.map!.easeTo.mockClear();

      replayManager.updateReplayDisplay();

      // Half a second, in MapLibre's milliseconds
      expect(mockApp.map!.easeTo).toHaveBeenCalledWith(
        expect.objectContaining({
          center: airplane().marker.getLngLat().toArray(),
          duration: 500,
          animate: true,
        }),
      );
    });

    it("does not pan on manual seek while the airplane is well inside the viewport", () => {
      replayManager.state.playing = false;
      replayManager.state.currentTime = 65;
      airplaneAt(400, 300);
      mockApp.map!.easeTo.mockClear();

      replayManager.updateReplayDisplay(true);

      expect(mockApp.map!.jumpTo).not.toHaveBeenCalled();
      expect(mockApp.map!.easeTo).not.toHaveBeenCalled();
    });

    it("pans without animation on manual seek when the airplane leaves the viewport", () => {
      replayManager.state.playing = false;
      replayManager.state.currentTime = 65;
      airplaneAt(-20, 300);
      mockApp.map!.easeTo.mockClear();

      replayManager.updateReplayDisplay(true);

      expect(mockApp.map!.jumpTo).toHaveBeenCalledTimes(1);
      expect(mockApp.map!.jumpTo).toHaveBeenCalledWith({
        center: airplane().marker.getLngLat().toArray(),
      });
      expect(mockApp.map!.easeTo).not.toHaveBeenCalled();
    });

    it("interpolates the position along the segment being flown", () => {
      // A segment's time is its start: segment 0 runs from [48.0, 16.0] at
      // t=0 to [48.1, 16.1] at t=60, when segment 1 starts. Halfway in time
      // the airplane is halfway along segment 0, not already on segment 1.
      replayManager.state.currentTime = 30;
      vi.mocked(airplane().marker.setLngLat).mockClear();

      replayManager.updateReplayDisplay();

      expect(airplane().marker.setLngLat).toHaveBeenCalledTimes(1);
      const [lat, lon] = positions()[0]!;
      expect(lat).toBeCloseTo(48.05, 5);
      expect(lon).toBeCloseTo(16.05, 5);
    });

    it("starts a segment at its first point and ends the flight at the last", () => {
      replayManager.state.currentTime = 60;
      replayManager.updateReplayDisplay();
      expect(airplane().getLatLng()).toEqual([48.1, 16.1]);

      replayManager.state.currentTime = 120;
      replayManager.updateReplayDisplay();
      expect(airplane().getLatLng()).toEqual([48.3, 16.3]);
    });

    it("crosses a gap in the recording over its duration, not at its start", () => {
      replayManager.state.segments = [
        {
          path_id: 1,
          coords: [
            [48.0, 16.0],
            [49.0, 17.0],
          ],
          time: 0,
        },
        {
          path_id: 1,
          coords: [
            [49.0, 17.0],
            [49.1, 17.1],
          ],
          time: 600,
        },
      ];
      replayManager.state.currentTime = 1;
      replayManager.updateReplayDisplay(true);

      const [lat] = airplane().getLatLng();
      expect(lat).toBeLessThan(48.01);
    });

    it("moves the airplane between two frames within one segment", () => {
      replayManager.state.currentTime = 15;
      replayManager.updateReplayDisplay();
      replayManager.state.currentTime = 45;
      replayManager.updateReplayDisplay();

      const moves = positions();
      const first = moves[moves.length - 2]!;
      const second = moves[moves.length - 1]!;
      expect(second[0]).toBeGreaterThan(first[0]);
      expect(second[1]).toBeGreaterThan(first[1]);
    });

    it("rewrites the rotation only when the heading changes", () => {
      const iconDiv = airplane()
        .getElement()
        .querySelector<HTMLElement>(".replay-airplane-icon")!;
      replayManager.state.currentTime = 65;
      replayManager.updateReplayDisplay();
      const transform = iconDiv.style.transform;
      expect(transform).toContain("rotate(");

      // The same heading a frame later is not written again (a valid
      // transform is used as the sentinel; jsdom drops invalid values)
      iconDiv.style.transform = "rotate(1deg)";
      replayManager.state.currentTime = 66;
      replayManager.updateReplayDisplay();
      expect(iconDiv.style.transform).toBe("rotate(1deg)");

      // The airplane of the next activation gets its own lookup and write
      replayManager.initializeReplay();
      const rebuiltIcon = airplane()
        .getElement()
        .querySelector<HTMLElement>(".replay-airplane-icon")!;
      expect(rebuiltIcon).not.toBe(iconDiv);
      replayManager.state.currentTime = 66;
      replayManager.updateReplayDisplay();
      expect(rebuiltIcon.style.transform).toBe(transform);
    });

    it("uses last known bearing when smoothed bearing is null", () => {
      vi.spyOn(replayFeature, "calculateSmoothedBearing").mockReturnValue(null);
      replayManager.state.lastBearing = 45;
      replayManager.state.currentTime = 65;
      const iconDiv = airplane()
        .getElement()
        .querySelector<HTMLElement>(".replay-airplane-icon")!;

      replayManager.updateReplayDisplay();

      expect(replayManager.state.lastBearing).toBe(45);
      // The marker is drawn nose up, so the rotation is the bearing itself
      // (turned there from the heading before, hence the rounding)
      const degrees = /rotate\(([-\d.e]+)deg\)/.exec(iconDiv.style.transform);
      expect(Number(degrees?.[1])).toBeCloseTo(45);
    });

    it("auto-zooms out when too many recenters happen", () => {
      replayManager.state.playing = true;
      replayManager.state.autoZoom = true;
      mockApp.map!.getZoom.mockReturnValue(14);
      replayManager.state.currentTime = 65;
      airplaneAt(10, 300);
      const now = Date.now();
      replayManager.state.recenterTimestamps = [
        now - 1000,
        now - 500,
        now - 100,
      ];

      replayManager.updateReplayDisplay();

      // Out onto the airplane, five seconds into the second segment
      expect(mockApp.map!.easeTo).toHaveBeenLastCalledWith({
        center: [expect.closeTo(16.1083, 3), expect.closeTo(48.1083, 3)],
        zoom: 13,
        duration: 250,
        animate: true,
      });
      expect(replayManager.state.recenterTimestamps).toEqual([]);
    });
  });

  describe("updateReplayDisplay - popup auto-update", () => {
    it("updates airplane popup when popup is open during display update", () => {
      replayManager.state.currentTime = 65;
      airplane().openPopup();

      replayManager.updateReplayDisplay();

      expect(airplane().popup.setHTML).toHaveBeenCalledWith("<div>popup</div>");
      expect(generateSegmentPopupHtml).toHaveBeenCalledWith(
        expect.objectContaining({
          segment: replayManager.state.segments[1],
          title: "Current Position",
        }),
      );
    });

    it("moves an open popup along with the airplane", () => {
      airplane().openPopup();
      replayManager.state.currentTime = 30;

      replayManager.updateReplayDisplay();

      expect(airplane().popup.getLngLat()).toEqual(
        airplane().marker.getLngLat(),
      );
    });

    it("rebuilds an open popup only when the airplane reaches another segment", () => {
      airplane().openPopup();
      const { popup } = airplane();
      vi.mocked(popup.addTo).mockClear();

      replayManager.state.currentTime = 61;
      replayManager.updateReplayDisplay();
      replayManager.state.currentTime = 62;
      replayManager.updateReplayDisplay();
      replayManager.state.currentTime = 63;
      replayManager.updateReplayDisplay();
      expect(popup.setHTML).toHaveBeenCalledTimes(1);

      replayManager.state.currentTime = 121;
      replayManager.updateReplayDisplay();
      expect(popup.setHTML).toHaveBeenCalledTimes(2);
      // Already open, so it is not opened again
      expect(popup.addTo).not.toHaveBeenCalled();
    });

    it("does not touch the popup when it is closed", () => {
      replayManager.state.currentTime = 65;

      replayManager.updateReplayDisplay();

      expect(airplane().popup.setHTML).not.toHaveBeenCalled();
      expect(airplane().isPopupOpen()).toBe(false);
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
      expect(airplane().isPopupOpen()).toBe(false);
    });

    it("fills the popup with the segment at the current time and opens it", () => {
      replayManager.state.currentTime = 30;

      replayManager.updateReplayAirplanePopup();

      expect(generateSegmentPopupHtml).toHaveBeenCalledWith(
        expect.objectContaining({
          segment: replayManager.state.segments[0],
          altMin: 3000,
          altMax: 5000,
          speedMin: 100,
          speedMax: 130,
          icon: "aircraftTop",
        }),
      );
      const { popup } = airplane();
      expect(popup.getElement().innerHTML).toContain("<div>popup</div>");
      expect(airplane().isPopupOpen()).toBe(true);
      // At the airplane, and never bound to the marker: MapLibre would
      // toggle a bound popup a second time on the same click
      expect(popup.getLngLat()).toEqual(airplane().marker.getLngLat());
      expect(airplane().marker.setPopup).not.toHaveBeenCalled();
    });

    it("pans the map to show the popup only while paused", () => {
      const pan = vi.spyOn(mapHelpers, "panPopupIntoView");
      // Panning for the popup would stop the map's recenter pan each time
      replayManager.playReplay();
      replayManager.updateReplayAirplanePopup();
      expect(pan).not.toHaveBeenCalled();

      // Paused, the popup pans the map to show itself: without that a click
      // on an airplane near the top edge opened it off the map
      replayManager.pauseReplay();
      replayManager.updateReplayAirplanePopup();
      expect(pan).toHaveBeenCalledWith(
        mockApp.map,
        airplane().popup,
        undefined,
        true,
      );
    });

    it("fills and opens the popup on a click, which Enter on the button is too", () => {
      const button = airplane().getElement();
      expect(button.tagName).toBe("BUTTON");
      replayManager.state.currentTime = 30;

      button.click();

      expect(airplane().isPopupOpen()).toBe(true);
      expect(airplane().popup.getElement().innerHTML).toContain(
        "<div>popup</div>",
      );

      // The next click puts it away again
      button.click();
      expect(airplane().isPopupOpen()).toBe(false);
    });

    it("keeps the click from the map, whose handler would close the popup", () => {
      const mapClick = vi.fn();
      mockApp.map!.getCanvasContainer().addEventListener("click", mapClick);

      airplane().getElement().click();

      expect(mapClick).not.toHaveBeenCalled();
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
      expect(airplane().isPopupOpen()).toBe(false);
    });

    it("refills an open popup instead of opening it again", () => {
      airplane().openPopup();
      vi.mocked(airplane().popup.addTo).mockClear();
      replayManager.state.currentTime = 30;

      replayManager.updateReplayAirplanePopup();

      expect(airplane().popup.setHTML).toHaveBeenCalledWith("<div>popup</div>");
      expect(airplane().popup.addTo).not.toHaveBeenCalled();
    });
  });
});
