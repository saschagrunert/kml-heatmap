import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  AUTO_ZOOM_SETTLE_MS,
  RECENTER_PAN_DURATION_S,
  ReplayRenderer,
  SEEK_PAN_THROTTLE_MS,
  findSegmentIndexAtTime,
  unwrapRotation,
  zoomOutSteps,
} from "../../../../kml_heatmap/frontend/ui/replayRenderer";
import * as motion from "../../../../kml_heatmap/frontend/utils/motion";
import { ReplayState } from "../../../../kml_heatmap/frontend/ui/replayState";
import type { ReplayManager } from "../../../../kml_heatmap/frontend/ui/replayManager";
import type { MapApp } from "../../../../kml_heatmap/frontend/mapApp";
import type { PathSegment } from "../../../../kml_heatmap/frontend/types";
import {
  getColorForAirspeed,
  getColorForAltitude,
} from "../../../../kml_heatmap/frontend/utils/colors";
import * as replayFeature from "../../../../kml_heatmap/frontend/features/replay";
import { generateSegmentPopupHtml } from "../../../../kml_heatmap/frontend/utils/htmlGenerators";
import * as L from "leaflet";

vi.mock("../../../../kml_heatmap/frontend/utils/htmlGenerators", () => ({
  generateSegmentPopupHtml: vi.fn(() => "<div>popup</div>"),
}));

type AnyMock = ReturnType<typeof vi.fn>;

function makeSegment(overrides: Partial<PathSegment> = {}): PathSegment {
  return {
    coords: [
      [50.0, 8.5],
      [50.01, 8.51],
    ],
    altitude_ft: 3000,
    groundspeed_knots: 120,
    path_id: 0,
    time: 0,
    ...overrides,
  };
}

function el(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing test element #${id}`);
  return element;
}

describe("findSegmentIndexAtTime", () => {
  const segments = [
    makeSegment({ time: 0 }),
    makeSegment({ time: 10 }),
    makeSegment({ time: 20 }),
    makeSegment({ time: 30 }),
  ];

  it("returns the last segment at or before the time", () => {
    expect(findSegmentIndexAtTime(segments, 15)).toBe(1);
    expect(findSegmentIndexAtTime(segments, 20)).toBe(2);
    expect(findSegmentIndexAtTime(segments, 1000)).toBe(3);
  });

  it("returns -1 before the first segment or for empty input", () => {
    expect(findSegmentIndexAtTime(segments, -1)).toBe(-1);
    expect(findSegmentIndexAtTime([], 5)).toBe(-1);
  });
});

describe("unwrapRotation", () => {
  it("takes the first heading as it is", () => {
    expect(unwrapRotation(null, 300)).toBe(300);
  });

  it("turns the short way across north in both directions", () => {
    expect(unwrapRotation(350, 10)).toBe(370);
    expect(unwrapRotation(10, 350)).toBe(-10);
    expect(unwrapRotation(-45, 314)).toBe(-46);
  });

  it("keeps turning from an angle that has already wrapped", () => {
    expect(unwrapRotation(725, 10)).toBe(730);
  });
});

describe("zoomOutSteps", () => {
  const size = { x: 800, y: 600 };

  it("takes one level while the airplane is at most twice as far out", () => {
    expect(zoomOutSteps({ x: 400, y: 300 }, size)).toBe(1);
    expect(zoomOutSteps({ x: -10, y: 300 }, size)).toBe(1);
    expect(zoomOutSteps({ x: 400, y: -300 }, size)).toBe(1);
  });

  it("takes a level for every further doubling", () => {
    expect(zoomOutSteps({ x: 400, y: -301 }, size)).toBe(2);
    expect(zoomOutSteps({ x: 2200, y: 300 }, size)).toBe(3);
  });

  it("stays within the four levels Leaflet animates", () => {
    expect(zoomOutSteps({ x: 400, y: -100_000 }, size)).toBe(4);
  });

  it("takes one level for a map without a size", () => {
    expect(zoomOutSteps({ x: 0, y: 0 }, { x: 0, y: 0 })).toBe(1);
  });
});

describe("ReplayRenderer", () => {
  let renderer: ReplayRenderer;
  let mockApp: {
    map: ReturnType<typeof L.map>;
    altitudeVisible: boolean;
    airspeedVisible: boolean;
  };
  let mockReplayManager: { state: ReplayState };
  let mockMap: Record<string, AnyMock>;

  const manager = () => mockReplayManager as unknown as ReplayManager;

  beforeEach(() => {
    vi.clearAllMocks();

    const timeDisplay = document.createElement("div");
    timeDisplay.id = "replay-time-display";
    const slider = document.createElement("input");
    slider.id = "replay-slider";
    slider.type = "range";
    const sliderStart = document.createElement("span");
    sliderStart.id = "replay-slider-start";
    document.body.append(timeDisplay, slider, sliderStart);

    const leafletMap = L.map("map");
    mockMap = leafletMap as unknown as Record<string, AnyMock>;
    mockMap["hasLayer"]!.mockReturnValue(true);

    mockApp = {
      map: leafletMap,
      altitudeVisible: true,
      airspeedVisible: false,
    };

    mockReplayManager = {
      state: new ReplayState(),
    };

    renderer = new ReplayRenderer(mockApp as unknown as MapApp);
  });

  afterEach(() => {
    ["replay-time-display", "replay-slider", "replay-slider-start"].forEach(
      (id) => document.getElementById(id)?.remove(),
    );
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe("updateAirplanePopup", () => {
    it("skips when no marker", () => {
      mockReplayManager.state.active = true;
      mockReplayManager.state.airplaneMarker = null;
      mockReplayManager.state.segments = [makeSegment()];

      renderer.updateAirplanePopup(manager());

      expect(generateSegmentPopupHtml).not.toHaveBeenCalled();
    });

    it("skips when not active", () => {
      mockReplayManager.state.active = false;
      const markerObj = L.marker([0, 0]);
      mockReplayManager.state.airplaneMarker = markerObj;
      mockReplayManager.state.segments = [makeSegment()];

      renderer.updateAirplanePopup(manager());

      expect(markerObj.openPopup).not.toHaveBeenCalled();
    });

    it("finds current segment by time", () => {
      mockReplayManager.state.active = true;
      const markerObj = L.marker([0, 0]);
      mockReplayManager.state.airplaneMarker = markerObj;
      mockReplayManager.state.currentTime = 15;
      const segments = [
        makeSegment({ time: 0 }),
        makeSegment({ time: 10 }),
        makeSegment({ time: 20 }),
      ];
      mockReplayManager.state.segments = segments;

      renderer.updateAirplanePopup(manager());

      expect(generateSegmentPopupHtml).toHaveBeenCalledWith(
        expect.objectContaining({ segment: segments[1] }),
      );
      expect(markerObj.bindPopup).toHaveBeenCalled();
      expect(markerObj.openPopup).toHaveBeenCalled();
    });

    it("shows where the aircraft is, not where its segment ends", () => {
      mockReplayManager.state.active = true;
      const markerObj = L.marker([0, 0]);
      mockReplayManager.state.airplaneMarker = markerObj;
      mockReplayManager.state.segments = [makeSegment({ time: 0 })];
      // Part way along the segment, as the frame loop leaves it
      markerObj.setLatLng([50.25, 8.25]);

      renderer.updateAirplanePopup(manager());

      expect(generateSegmentPopupHtml).toHaveBeenCalledWith(
        expect.objectContaining({ position: [50.25, 8.25] }),
      );
    });

    it("uses the given index instead of searching", () => {
      mockReplayManager.state.active = true;
      mockReplayManager.state.airplaneMarker = L.marker([0, 0]);
      mockReplayManager.state.currentTime = 25;
      const segments = [
        makeSegment({ time: 0 }),
        makeSegment({ time: 10 }),
        makeSegment({ time: 20 }),
      ];
      mockReplayManager.state.segments = segments;

      renderer.updateAirplanePopup(manager(), 0);

      expect(generateSegmentPopupHtml).toHaveBeenCalledWith(
        expect.objectContaining({ segment: segments[0] }),
      );
    });

    it("falls back to first segment when currentTime is before all", () => {
      mockReplayManager.state.active = true;
      const markerObj = L.marker([0, 0]);
      mockReplayManager.state.airplaneMarker = markerObj;
      mockReplayManager.state.currentTime = 0;
      const segments = [makeSegment({ time: 5 }), makeSegment({ time: 10 })];
      mockReplayManager.state.segments = segments;

      renderer.updateAirplanePopup(manager());

      expect(generateSegmentPopupHtml).toHaveBeenCalledWith(
        expect.objectContaining({ segment: segments[0] }),
      );
      expect(markerObj.openPopup).toHaveBeenCalled();
    });

    it("skips when no segments", () => {
      mockReplayManager.state.active = true;
      const markerObj = L.marker([0, 0]);
      mockReplayManager.state.airplaneMarker = markerObj;
      mockReplayManager.state.segments = [];

      renderer.updateAirplanePopup(manager());

      expect(markerObj.openPopup).not.toHaveBeenCalled();
    });

    it("updates existing popup instead of creating new", () => {
      mockReplayManager.state.active = true;
      const markerObj = L.marker([0, 0]);
      const mockPopup = { setContent: vi.fn() };
      (markerObj.getPopup as AnyMock).mockReturnValue(mockPopup);
      mockReplayManager.state.airplaneMarker = markerObj;
      mockReplayManager.state.segments = [makeSegment({ time: 0 })];
      mockReplayManager.state.currentTime = 5;

      renderer.updateAirplanePopup(manager());

      expect(mockPopup.setContent).toHaveBeenCalledWith("<div>popup</div>");
      expect(markerObj.bindPopup).not.toHaveBeenCalled();
    });
  });

  describe("ensureReadout", () => {
    it("builds the three cells once", () => {
      const panel = document.createElement("div");

      const first = renderer.ensureReadout(panel);
      const second = renderer.ensureReadout(panel);

      expect(second).toBe(first);
      expect(panel.querySelectorAll(".replay-readout-cell")).toHaveLength(3);
      expect(first.querySelector(".replay-readout-value")!.textContent).toBe(
        "—",
      );
    });

    it("places the strip inside the panel's inner wrapper when present", () => {
      const panel = document.createElement("div");
      const inner = document.createElement("div");
      inner.id = "replay-controls-inner";
      panel.append(inner);

      const strip = renderer.ensureReadout(panel);

      expect(strip.parentElement).toBe(inner);
    });
  });

  describe("updateDisplay", () => {
    function callUpdateDisplay(isManualSeek = false): void {
      renderer.updateDisplay(manager(), isManualSeek);
    }

    it("updates time display text", () => {
      mockReplayManager.state.currentTime = 65;
      mockReplayManager.state.maxTime = 300;

      callUpdateDisplay();

      expect(el("replay-time-display").textContent).toBe("1:05 / 5:00");
      expect(el("replay-slider-start").textContent).toBe("1:05");
    });

    it("updates slider value and spoken value text", () => {
      mockReplayManager.state.currentTime = 42;
      mockReplayManager.state.maxTime = 300;

      callUpdateDisplay();

      const slider = el("replay-slider") as HTMLInputElement;
      expect(slider.value).toBe("42");
      expect(slider.getAttribute("aria-valuetext")).toBe("0:42 of 5:00");
    });

    it("works without the replay control elements", () => {
      el("replay-time-display").remove();
      el("replay-slider").remove();
      el("replay-slider-start").remove();
      mockReplayManager.state.currentTime = 5;

      expect(() => callUpdateDisplay()).not.toThrow();
    });

    it("draws segments incrementally", () => {
      const layer = L.layerGroup();
      mockReplayManager.state.layer = layer;
      mockReplayManager.state.lastDrawnIndex = -1;
      mockReplayManager.state.currentTime = 15;
      mockReplayManager.state.segments = [
        makeSegment({ time: 0 }),
        makeSegment({ time: 10 }),
        makeSegment({ time: 20 }),
      ];

      callUpdateDisplay();

      expect(L.polyline).toHaveBeenCalledTimes(2);
      expect(mockReplayManager.state.lastDrawnIndex).toBe(1);
      expect(mockReplayManager.state.currentIndex).toBe(1);
    });

    it("does not draw segments at time 0", () => {
      mockReplayManager.state.layer = L.layerGroup();
      mockReplayManager.state.currentTime = 0;
      mockReplayManager.state.segments = [makeSegment({ time: 0 })];

      callUpdateDisplay();

      expect(L.polyline).not.toHaveBeenCalled();
      expect(mockReplayManager.state.lastDrawnIndex).toBe(-1);
    });

    it("starts drawing after the last drawn index", () => {
      mockReplayManager.state.layer = L.layerGroup();
      mockReplayManager.state.lastDrawnIndex = 1;
      mockReplayManager.state.currentTime = 30;
      mockReplayManager.state.segments = [
        makeSegment({ time: 0 }),
        makeSegment({ time: 10 }),
        makeSegment({ time: 20 }),
      ];

      callUpdateDisplay();

      expect(L.polyline).toHaveBeenCalledTimes(1);
      expect(mockReplayManager.state.lastDrawnIndex).toBe(2);
    });

    it("scans forward from the previous index while playing", () => {
      mockReplayManager.state.currentIndex = 1;
      mockReplayManager.state.currentTime = 25;
      mockReplayManager.state.segments = [
        makeSegment({ time: 0 }),
        makeSegment({ time: 10 }),
        makeSegment({ time: 20 }),
        makeSegment({ time: 30 }),
      ];

      callUpdateDisplay();

      expect(mockReplayManager.state.currentIndex).toBe(2);
    });

    it("searches again when the time moved backwards", () => {
      mockReplayManager.state.currentIndex = 3;
      mockReplayManager.state.currentTime = 5;
      mockReplayManager.state.segments = [
        makeSegment({ time: 0 }),
        makeSegment({ time: 10 }),
        makeSegment({ time: 20 }),
        makeSegment({ time: 30 }),
      ];

      callUpdateDisplay();

      expect(mockReplayManager.state.currentIndex).toBe(0);
    });

    it("positions airplane marker at segment end", () => {
      const markerObj = L.marker([0, 0]);
      mockReplayManager.state.airplaneMarker = markerObj;
      mockReplayManager.state.currentTime = 5;
      mockReplayManager.state.segments = [makeSegment({ time: 0 })];

      callUpdateDisplay();

      expect(markerObj.setLatLng).toHaveBeenCalledWith([50.01, 8.51]);
    });

    it("draws with airspeed colors when airspeed is visible and altitude is not", () => {
      mockApp.airspeedVisible = true;
      mockApp.altitudeVisible = false;

      mockReplayManager.state.layer = L.layerGroup();
      mockReplayManager.state.lastDrawnIndex = -1;
      mockReplayManager.state.currentTime = 5;
      mockReplayManager.state.segments = [
        makeSegment({ time: 0, groundspeed_knots: 150 }),
      ];

      callUpdateDisplay();

      const { colorMinSpeed, colorMaxSpeed } = mockReplayManager.state;
      expect(vi.mocked(L.polyline).mock.calls[0]![1]).toMatchObject({
        color: getColorForAirspeed(150, colorMinSpeed, colorMaxSpeed),
      });
    });

    it("falls back to altitude colors for segments without groundspeed", () => {
      mockApp.airspeedVisible = true;
      mockApp.altitudeVisible = false;

      mockReplayManager.state.layer = L.layerGroup();
      mockReplayManager.state.currentTime = 5;
      mockReplayManager.state.segments = [
        makeSegment({ time: 0, groundspeed_knots: 0 }),
      ];

      callUpdateDisplay();

      expect(vi.mocked(L.polyline).mock.calls[0]![1]).toMatchObject({
        color: getColorForAltitude(3000, 0, 10000),
      });
    });

    it("falls back to first segment coords when no lastSegment", () => {
      const markerObj = L.marker([0, 0]);
      mockReplayManager.state.airplaneMarker = markerObj;
      mockReplayManager.state.currentTime = 0;
      mockReplayManager.state.segments = [
        makeSegment({
          time: 5,
          coords: [
            [51.0, 9.0],
            [51.01, 9.01],
          ],
        }),
      ];

      callUpdateDisplay();

      expect(markerObj.setLatLng).toHaveBeenCalledWith([51.0, 9.0]);
    });

    it("applies rotation transform to airplane icon", () => {
      const iconDiv = document.createElement("div");
      iconDiv.className = "replay-airplane-icon";
      const iconElement = document.createElement("div");
      iconElement.appendChild(iconDiv);

      const markerObj = L.marker([0, 0]);
      (markerObj.getElement as AnyMock).mockReturnValue(iconElement);
      mockReplayManager.state.airplaneMarker = markerObj;
      mockReplayManager.state.currentTime = 5;
      mockReplayManager.state.segments = [makeSegment({ time: 0 })];

      callUpdateDisplay();

      expect(iconDiv.style.transform).toContain("rotate(");
      expect(iconDiv.style.transform).toContain("translate3d(0,0,0)");
      expect(mockReplayManager.state.lastBearing).not.toBeNull();
    });

    it("turns the icon the short way when the heading crosses north", () => {
      const iconDiv = document.createElement("div");
      iconDiv.className = "replay-airplane-icon";
      const iconElement = document.createElement("div");
      iconElement.appendChild(iconDiv);
      const markerObj = L.marker([0, 0]);
      (markerObj.getElement as AnyMock).mockReturnValue(iconElement);
      mockReplayManager.state.airplaneMarker = markerObj;
      mockReplayManager.state.currentTime = 5;
      mockReplayManager.state.segments = [makeSegment({ time: 0 })];
      const bearing = vi.spyOn(replayFeature, "calculateSmoothedBearing");

      bearing.mockReturnValue(350);
      callUpdateDisplay();
      expect(iconDiv.style.transform).toContain("rotate(350deg)");

      // 350 to 10 degrees is a 20 degree turn: 370, not a transition back
      // through 180 to 10
      bearing.mockReturnValue(10);
      callUpdateDisplay();
      expect(iconDiv.style.transform).toContain("rotate(370deg)");

      bearing.mockReturnValue(340);
      callUpdateDisplay();
      expect(iconDiv.style.transform).toContain("rotate(340deg)");
    });

    it("keeps the last bearing when no smoothed bearing is available", () => {
      vi.spyOn(replayFeature, "calculateSmoothedBearing").mockReturnValue(null);
      mockReplayManager.state.lastBearing = 90;
      mockReplayManager.state.airplaneMarker = L.marker([0, 0]);
      mockReplayManager.state.currentTime = 5;
      mockReplayManager.state.segments = [makeSegment({ time: 0 })];

      callUpdateDisplay();

      expect(mockReplayManager.state.lastBearing).toBe(90);
    });

    it("auto-pans when airplane is near viewport edge during playback", () => {
      mockMap["latLngToContainerPoint"]!.mockReturnValue({ x: 10, y: 10 });

      mockReplayManager.state.airplaneMarker = L.marker([0, 0]);
      mockReplayManager.state.playing = true;
      mockReplayManager.state.currentTime = 5;
      mockReplayManager.state.segments = [makeSegment({ time: 0 })];

      callUpdateDisplay();

      expect(mockMap["panTo"]).toHaveBeenCalledWith(
        [50.01, 8.51],
        expect.objectContaining({ animate: true, noMoveStart: true }),
      );
      expect(mockReplayManager.state.recenterTimestamps).toHaveLength(1);
    });

    it("does not pan while playing when the airplane is inside the margins", () => {
      mockMap["latLngToContainerPoint"]!.mockReturnValue({ x: 400, y: 300 });
      mockReplayManager.state.airplaneMarker = L.marker([0, 0]);
      mockReplayManager.state.playing = true;
      mockReplayManager.state.currentTime = 5;
      mockReplayManager.state.segments = [makeSegment({ time: 0 })];

      callUpdateDisplay();

      expect(mockMap["panTo"]).not.toHaveBeenCalled();
    });

    it("does not pan when paused and not seeking", () => {
      mockMap["latLngToContainerPoint"]!.mockReturnValue({ x: 10, y: 10 });
      mockReplayManager.state.airplaneMarker = L.marker([0, 0]);
      mockReplayManager.state.playing = false;
      mockReplayManager.state.currentTime = 5;
      mockReplayManager.state.segments = [makeSegment({ time: 0 })];

      callUpdateDisplay(false);

      expect(mockMap["panTo"]).not.toHaveBeenCalled();
    });

    it("uses binary search on manual seek with multiple segments", () => {
      const markerObj = L.marker([0, 0]);
      mockReplayManager.state.airplaneMarker = markerObj;
      mockReplayManager.state.lastDrawnIndex = 5;
      mockReplayManager.state.currentIndex = 3;
      mockReplayManager.state.currentTime = 15;
      mockReplayManager.state.segments = [
        makeSegment({ time: 0 }),
        makeSegment({ time: 10 }),
        makeSegment({ time: 20 }),
        makeSegment({ time: 30 }),
      ];

      callUpdateDisplay(true);

      expect(mockReplayManager.state.currentIndex).toBe(1);
      expect(markerObj.setLatLng).toHaveBeenCalled();
    });

    it("does not recenter on manual seek while the airplane stays in view", () => {
      mockMap["latLngToContainerPoint"]!.mockReturnValue({ x: 400, y: 300 });
      mockReplayManager.state.airplaneMarker = L.marker([0, 0]);
      mockReplayManager.state.currentTime = 5;
      mockReplayManager.state.segments = [makeSegment({ time: 0 })];

      callUpdateDisplay(true);

      expect(mockMap["panTo"]).not.toHaveBeenCalled();
    });

    it("pans without animation on manual seek near the edge, throttled to 250 ms", () => {
      vi.useFakeTimers();
      vi.setSystemTime(10_000);
      mockMap["latLngToContainerPoint"]!.mockReturnValue({ x: 10, y: 300 });
      mockReplayManager.state.airplaneMarker = L.marker([0, 0]);
      mockReplayManager.state.currentTime = 5;
      mockReplayManager.state.segments = [makeSegment({ time: 0 })];

      callUpdateDisplay(true);
      expect(mockMap["panTo"]).toHaveBeenCalledTimes(1);
      expect(mockMap["panTo"]).toHaveBeenCalledWith([50.01, 8.51], {
        animate: false,
      });

      // A second seek shortly after is throttled
      vi.advanceTimersByTime(SEEK_PAN_THROTTLE_MS - 50);
      callUpdateDisplay(true);
      expect(mockMap["panTo"]).toHaveBeenCalledTimes(1);

      // After the throttle window the map follows again
      vi.advanceTimersByTime(100);
      callUpdateDisplay(true);
      expect(mockMap["panTo"]).toHaveBeenCalledTimes(2);
      // Manual seeks do not feed the auto-zoom recenter counter
      expect(mockReplayManager.state.recenterTimestamps).toHaveLength(0);
    });

    it("pans immediately on manual seek when the airplane left the viewport", () => {
      vi.useFakeTimers();
      vi.setSystemTime(10_000);
      mockMap["latLngToContainerPoint"]!.mockReturnValue({ x: 10, y: 300 });
      mockReplayManager.state.airplaneMarker = L.marker([0, 0]);
      mockReplayManager.state.currentTime = 5;
      mockReplayManager.state.segments = [makeSegment({ time: 0 })];

      callUpdateDisplay(true);
      expect(mockMap["panTo"]).toHaveBeenCalledTimes(1);

      // Outside the viewport: the throttle does not apply
      mockMap["latLngToContainerPoint"]!.mockReturnValue({ x: -50, y: 300 });
      vi.advanceTimersByTime(10);
      callUpdateDisplay(true);
      expect(mockMap["panTo"]).toHaveBeenCalledTimes(2);
    });

    it("auto-zooms out after frequent recenters", () => {
      mockMap["latLngToContainerPoint"]!.mockReturnValue({ x: 10, y: 10 });
      mockMap["getZoom"]!.mockReturnValue(12);

      mockReplayManager.state.airplaneMarker = L.marker([0, 0]);
      mockReplayManager.state.playing = true;
      mockReplayManager.state.autoZoom = true;
      mockReplayManager.state.currentTime = 5;
      mockReplayManager.state.segments = [makeSegment({ time: 0 })];

      const now = Date.now();
      mockReplayManager.state.recenterTimestamps = [
        now - 1000,
        now - 500,
        now - 100,
      ];

      callUpdateDisplay();

      // Around the airplane: Leaflet puts the view back on the point it
      // zoomed around once the animation ends
      expect(mockMap["setView"]).toHaveBeenCalledWith(
        [50.01, 8.51],
        11,
        expect.objectContaining({ animate: true }),
      );
      expect(mockMap["setZoom"]).not.toHaveBeenCalled();
      expect(mockReplayManager.state.recenterTimestamps).toEqual([]);
    });

    it("zooms out from the map's own zoom, which the user may have changed", () => {
      // Replay opened with auto-zoom at 16, then the user zoomed out to 12.5:
      // a remembered 16 made "zoom out" set 15
      mockMap["latLngToContainerPoint"]!.mockReturnValue({ x: 10, y: 10 });
      mockMap["getZoom"]!.mockReturnValue(12.5);
      mockReplayManager.state.airplaneMarker = L.marker([0, 0]);
      mockReplayManager.state.playing = true;
      mockReplayManager.state.autoZoom = true;
      mockReplayManager.state.currentTime = 5;
      mockReplayManager.state.segments = [makeSegment({ time: 0 })];
      const now = Date.now();
      mockReplayManager.state.recenterTimestamps = [now - 900, now - 600];

      callUpdateDisplay();

      expect(mockMap["setView"]).toHaveBeenCalledWith(
        [50.01, 8.51],
        11.5,
        expect.anything(),
      );
    });

    it("counts one recenter per pan, not one per frame of it", () => {
      vi.useFakeTimers();
      vi.setSystemTime(10_000);
      mockMap["latLngToContainerPoint"]!.mockReturnValue({ x: 10, y: 10 });
      mockReplayManager.state.airplaneMarker = L.marker([0, 0]);
      mockReplayManager.state.playing = true;
      mockReplayManager.state.autoZoom = true;
      mockReplayManager.state.currentTime = 5;
      mockReplayManager.state.segments = [makeSegment({ time: 0 })];

      // Twenty frames (320 ms) of the airplane near the edge while the pan
      // runs: the map follows on every frame, but it is one recenter and
      // no zoom. Counted per frame this fired a burst of zoom-outs.
      for (let frame = 0; frame < 20; frame++) {
        callUpdateDisplay();
        vi.advanceTimersByTime(16);
      }
      expect(mockMap["panTo"]).toHaveBeenCalledTimes(20);
      expect(mockReplayManager.state.recenterTimestamps).toHaveLength(1);
      expect(mockMap["setView"]).not.toHaveBeenCalled();

      // Once a pan has had its time, still being at the edge is a new one
      vi.advanceTimersByTime(RECENTER_PAN_DURATION_S * 1000);
      callUpdateDisplay();
      expect(mockReplayManager.state.recenterTimestamps).toHaveLength(2);
    });

    it("pans without animation for reduced motion", () => {
      vi.spyOn(motion, "prefersReducedMotion").mockReturnValue(true);
      mockMap["latLngToContainerPoint"]!.mockReturnValue({ x: 10, y: 10 });
      mockMap["getZoom"]!.mockReturnValue(12);
      mockReplayManager.state.airplaneMarker = L.marker([0, 0]);
      mockReplayManager.state.playing = true;
      mockReplayManager.state.autoZoom = true;
      mockReplayManager.state.currentTime = 5;
      mockReplayManager.state.segments = [makeSegment({ time: 0 })];
      const now = Date.now();
      mockReplayManager.state.recenterTimestamps = [now - 2000, now - 1000];

      callUpdateDisplay();

      expect(mockMap["panTo"]).toHaveBeenCalledWith(
        [50.01, 8.51],
        expect.objectContaining({ animate: false }),
      );
      expect(mockMap["setView"]).toHaveBeenCalledWith([50.01, 8.51], 11, {
        animate: false,
      });
    });

    it("does not zoom out below zoom level 9", () => {
      mockMap["latLngToContainerPoint"]!.mockReturnValue({ x: 10, y: 10 });
      mockMap["getZoom"]!.mockReturnValue(9);
      mockReplayManager.state.airplaneMarker = L.marker([0, 0]);
      mockReplayManager.state.playing = true;
      mockReplayManager.state.autoZoom = true;
      mockReplayManager.state.currentTime = 5;
      mockReplayManager.state.segments = [makeSegment({ time: 0 })];
      const now = Date.now();
      mockReplayManager.state.recenterTimestamps = [
        now - 300,
        now - 200,
        now - 100,
      ];

      callUpdateDisplay();

      expect(mockMap["setView"]).not.toHaveBeenCalled();
    });

    it("zooms out at once when the airplane has left the map", () => {
      // At 200x the pan fell behind at zoom 16, and waiting for three
      // recenters left the airplane above the map for over a second
      vi.useFakeTimers();
      vi.setSystemTime(10_000);
      mockMap["latLngToContainerPoint"]!.mockReturnValue({ x: 400, y: -20 });
      mockMap["getZoom"]!.mockReturnValue(16);
      mockReplayManager.state.airplaneMarker = L.marker([0, 0]);
      mockReplayManager.state.playing = true;
      mockReplayManager.state.autoZoom = true;
      mockReplayManager.state.currentTime = 5;
      mockReplayManager.state.segments = [makeSegment({ time: 0 })];

      callUpdateDisplay();
      expect(mockMap["setView"]).toHaveBeenCalledTimes(1);
      expect(mockMap["setView"]).toHaveBeenCalledWith(
        [50.01, 8.51],
        15,
        expect.objectContaining({ animate: true }),
      );

      // Still outside while Leaflet animates that zoom: no second call,
      // which Leaflet would drop
      mockMap["getZoom"]!.mockReturnValue(15);
      vi.advanceTimersByTime(AUTO_ZOOM_SETTLE_MS - 50);
      callUpdateDisplay();
      expect(mockMap["setView"]).toHaveBeenCalledTimes(1);

      // Once it has ended, further out takes more than one level
      mockMap["latLngToContainerPoint"]!.mockReturnValue({ x: 400, y: -700 });
      vi.advanceTimersByTime(50);
      callUpdateDisplay();
      expect(mockMap["setView"]).toHaveBeenCalledTimes(2);
      expect(mockMap["setView"]).toHaveBeenLastCalledWith(
        [50.01, 8.51],
        13,
        expect.anything(),
      );
    });

    it("leaves the zoom alone off the map when auto-zoom is off", () => {
      mockMap["latLngToContainerPoint"]!.mockReturnValue({ x: -50, y: 300 });
      mockReplayManager.state.airplaneMarker = L.marker([0, 0]);
      mockReplayManager.state.playing = true;
      mockReplayManager.state.currentTime = 5;
      mockReplayManager.state.segments = [makeSegment({ time: 0 })];

      callUpdateDisplay();

      expect(mockMap["panTo"]).toHaveBeenCalled();
      expect(mockMap["setView"]).not.toHaveBeenCalled();
    });

    it("adds marker to map if missing", () => {
      mockMap["hasLayer"]!.mockReturnValue(false);

      const markerObj = L.marker([0, 0]);
      mockReplayManager.state.airplaneMarker = markerObj;
      mockReplayManager.state.currentTime = 5;
      mockReplayManager.state.segments = [makeSegment({ time: 0 })];

      callUpdateDisplay();

      expect(markerObj.addTo).toHaveBeenCalledWith(mockApp.map);
    });

    it("refreshes an open popup with the current segment index", () => {
      mockReplayManager.state.active = true;
      const markerObj = L.marker([0, 0]);
      const mockPopup = { setContent: vi.fn() };
      (markerObj.getPopup as AnyMock).mockReturnValue(mockPopup);
      (markerObj.isPopupOpen as AnyMock).mockReturnValue(true);
      mockReplayManager.state.airplaneMarker = markerObj;
      mockReplayManager.state.currentTime = 15;
      const segments = [makeSegment({ time: 0 }), makeSegment({ time: 10 })];
      mockReplayManager.state.segments = segments;

      callUpdateDisplay();

      expect(generateSegmentPopupHtml).toHaveBeenCalledWith(
        expect.objectContaining({ segment: segments[1] }),
      );
      expect(mockPopup.setContent).toHaveBeenCalledWith("<div>popup</div>");
    });
  });
});
