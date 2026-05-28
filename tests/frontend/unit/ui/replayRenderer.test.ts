import { describe, it, expect, beforeEach, vi } from "vitest";
import { ReplayRenderer } from "../../../../kml_heatmap/frontend/ui/replayRenderer";
import { ReplayState } from "../../../../kml_heatmap/frontend/ui/replayState";
import type { PathSegment } from "../../../../kml_heatmap/frontend/types";
import * as L from "leaflet";

const mockDomElements: Record<string, HTMLElement> = {};
vi.mock("../../../../kml_heatmap/frontend/utils/domCache", () => ({
  domCache: {
    get: vi.fn((id: string) => mockDomElements[id] || null),
  },
}));

vi.mock("../../../../kml_heatmap/frontend/utils/htmlGenerators", () => ({
  generateSegmentPopupHtml: vi.fn(() => "<div>popup</div>"),
}));

function makeSegment(overrides: Partial<PathSegment> = {}): PathSegment {
  return {
    coords: [
      [50.0, 8.5],
      [50.01, 8.51],
    ],
    altitude_ft: 3000,
    altitude_m: 914,
    groundspeed_knots: 120,
    path_id: 0,
    time: 0,
    ...overrides,
  };
}

describe("ReplayRenderer", () => {
  let renderer: ReplayRenderer;
  let mockApp: Record<string, unknown>;
  let mockReplayManager: {
    state: ReplayState;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    Object.keys(mockDomElements).forEach((key) => delete mockDomElements[key]);

    ["replay-time-display", "replay-slider", "replay-slider-start"].forEach(
      (id) => {
        const el = document.createElement("div");
        el.id = id;
        document.body.appendChild(el);
        mockDomElements[id] = el;
      }
    );

    window.KMLHeatmap = {
      formatTime: vi.fn(
        (t: number) =>
          `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`
      ),
      getColorForAltitude: vi.fn(() => "rgb(255, 0, 0)"),
      getColorForAirspeed: vi.fn(() => "rgb(0, 0, 255)"),
      findMinMax: vi.fn(),
      calculateBearing: vi.fn(() => 90),
      calculateSmoothedBearing: vi.fn(() => 90),
    } as typeof window.KMLHeatmap;

    const mockMap = L.map();
    (mockMap.hasLayer as ReturnType<typeof vi.fn>).mockReturnValue(true);

    mockApp = {
      map: mockMap,
      altitudeVisible: true,
      airspeedVisible: false,
    };

    mockReplayManager = {
      state: new ReplayState(),
    };

    renderer = new ReplayRenderer(
      mockApp as unknown as ConstructorParameters<typeof ReplayRenderer>[0]
    );
  });

  describe("updateAirplanePopup", () => {
    it("skips when no marker", () => {
      mockReplayManager.state.active = true;
      mockReplayManager.state.airplaneMarker = null;
      renderer.updateAirplanePopup(
        mockReplayManager as unknown as Parameters<
          typeof renderer.updateAirplanePopup
        >[0]
      );
    });

    it("skips when not active", () => {
      mockReplayManager.state.active = false;
      const markerObj = L.marker([0, 0]);
      mockReplayManager.state.airplaneMarker = markerObj;
      renderer.updateAirplanePopup(
        mockReplayManager as unknown as Parameters<
          typeof renderer.updateAirplanePopup
        >[0]
      );
      expect(markerObj.openPopup).not.toHaveBeenCalled();
    });

    it("finds current segment by time", () => {
      mockReplayManager.state.active = true;
      const markerObj = L.marker([0, 0]);
      mockReplayManager.state.airplaneMarker = markerObj;
      mockReplayManager.state.currentTime = 15;
      mockReplayManager.state.segments = [
        makeSegment({ time: 0 }),
        makeSegment({ time: 10 }),
        makeSegment({ time: 20 }),
      ];

      renderer.updateAirplanePopup(
        mockReplayManager as unknown as Parameters<
          typeof renderer.updateAirplanePopup
        >[0]
      );
      expect(markerObj.bindPopup).toHaveBeenCalled();
      expect(markerObj.openPopup).toHaveBeenCalled();
    });

    it("falls back to first segment when currentTime is before all", () => {
      mockReplayManager.state.active = true;
      const markerObj = L.marker([0, 0]);
      mockReplayManager.state.airplaneMarker = markerObj;
      mockReplayManager.state.currentTime = 0;
      mockReplayManager.state.segments = [
        makeSegment({ time: 5 }),
        makeSegment({ time: 10 }),
      ];

      renderer.updateAirplanePopup(
        mockReplayManager as unknown as Parameters<
          typeof renderer.updateAirplanePopup
        >[0]
      );
      expect(markerObj.openPopup).toHaveBeenCalled();
    });

    it("skips when no segments", () => {
      mockReplayManager.state.active = true;
      const markerObj = L.marker([0, 0]);
      mockReplayManager.state.airplaneMarker = markerObj;
      mockReplayManager.state.segments = [];
      renderer.updateAirplanePopup(
        mockReplayManager as unknown as Parameters<
          typeof renderer.updateAirplanePopup
        >[0]
      );
      expect(markerObj.openPopup).not.toHaveBeenCalled();
    });

    it("updates existing popup instead of creating new", () => {
      mockReplayManager.state.active = true;
      const markerObj = L.marker([0, 0]);
      const mockPopup = { setContent: vi.fn() };
      (markerObj.getPopup as ReturnType<typeof vi.fn>).mockReturnValue(
        mockPopup
      );
      mockReplayManager.state.airplaneMarker = markerObj;
      mockReplayManager.state.segments = [makeSegment({ time: 0 })];
      mockReplayManager.state.currentTime = 5;

      renderer.updateAirplanePopup(
        mockReplayManager as unknown as Parameters<
          typeof renderer.updateAirplanePopup
        >[0]
      );
      expect(mockPopup.setContent).toHaveBeenCalled();
      expect(markerObj.bindPopup).not.toHaveBeenCalled();
    });
  });

  describe("updateDisplay", () => {
    function callUpdateDisplay(isManualSeek = false): void {
      renderer.updateDisplay(
        mockReplayManager as unknown as Parameters<
          typeof renderer.updateDisplay
        >[0],
        isManualSeek
      );
    }

    it("updates time display text", () => {
      mockReplayManager.state.currentTime = 65;
      mockReplayManager.state.maxTime = 300;
      callUpdateDisplay();
      expect(mockDomElements["replay-time-display"]!.textContent).toContain(
        "1:05"
      );
    });

    it("updates slider value", () => {
      const slider = document.createElement("input");
      slider.id = "replay-slider";
      mockDomElements["replay-slider"] = slider;
      mockReplayManager.state.currentTime = 42;
      callUpdateDisplay();
      expect(slider.value).toBe("42");
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
      expect(L.polyline).toHaveBeenCalled();
      expect(mockReplayManager.state.lastDrawnIndex).toBe(1);
    });

    it("does not draw segments at time 0", () => {
      const layer = L.layerGroup();
      mockReplayManager.state.layer = layer;
      mockReplayManager.state.currentTime = 0;
      mockReplayManager.state.segments = [makeSegment({ time: 0 })];

      callUpdateDisplay();
      expect(L.polyline).not.toHaveBeenCalled();
    });

    it("skips already-drawn segments", () => {
      const layer = L.layerGroup();
      mockReplayManager.state.layer = layer;
      mockReplayManager.state.lastDrawnIndex = 1;
      mockReplayManager.state.currentTime = 30;
      mockReplayManager.state.segments = [
        makeSegment({ time: 0 }),
        makeSegment({ time: 10 }),
        makeSegment({ time: 20 }),
      ];

      callUpdateDisplay();
      expect(L.polyline).toHaveBeenCalledTimes(1);
    });

    it("positions airplane marker at segment end", () => {
      const markerObj = L.marker([0, 0]);
      mockReplayManager.state.airplaneMarker = markerObj;
      mockReplayManager.state.currentTime = 5;
      mockReplayManager.state.segments = [makeSegment({ time: 0 })];

      callUpdateDisplay();
      expect(markerObj.setLatLng).toHaveBeenCalled();
    });

    it("uses airspeed colors when airspeed is visible and altitude is not", () => {
      mockApp.airspeedVisible = true;
      mockApp.altitudeVisible = false;

      const layer = L.layerGroup();
      mockReplayManager.state.layer = layer;
      mockReplayManager.state.lastDrawnIndex = -1;
      mockReplayManager.state.currentTime = 5;
      mockReplayManager.state.segments = [
        makeSegment({ time: 0, groundspeed_knots: 150 }),
      ];

      callUpdateDisplay();
      expect(window.KMLHeatmap.getColorForAltitude).toHaveBeenCalledWith(
        150,
        mockReplayManager.state.colorMinSpeed,
        mockReplayManager.state.colorMaxSpeed
      );
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
      (markerObj.getElement as ReturnType<typeof vi.fn>).mockReturnValue(
        iconElement
      );
      mockReplayManager.state.airplaneMarker = markerObj;
      mockReplayManager.state.currentTime = 5;
      mockReplayManager.state.segments = [makeSegment({ time: 0 })];

      callUpdateDisplay();
      expect(iconDiv.style.transform).toContain("rotate(");
      expect(iconDiv.style.transform).toContain("translate3d(0,0,0)");
    });

    it("auto-pans when airplane is near viewport edge during playback", () => {
      const mockMap = mockApp.map as Record<string, ReturnType<typeof vi.fn>>;
      mockMap.latLngToContainerPoint.mockReturnValue({ x: 10, y: 10 });

      const markerObj = L.marker([0, 0]);
      mockReplayManager.state.airplaneMarker = markerObj;
      mockReplayManager.state.playing = true;
      mockReplayManager.state.currentTime = 5;
      mockReplayManager.state.segments = [makeSegment({ time: 0 })];

      callUpdateDisplay();
      expect(mockMap.panTo).toHaveBeenCalled();
    });

    it("always recenters on manual seek", () => {
      const mockMap = mockApp.map as Record<string, ReturnType<typeof vi.fn>>;
      mockMap.latLngToContainerPoint.mockReturnValue({ x: 400, y: 300 });

      const markerObj = L.marker([0, 0]);
      mockReplayManager.state.airplaneMarker = markerObj;
      mockReplayManager.state.playing = true;
      mockReplayManager.state.currentTime = 5;
      mockReplayManager.state.segments = [makeSegment({ time: 0 })];

      callUpdateDisplay(true);
      expect(mockMap.panTo).toHaveBeenCalled();
    });

    it("auto-zooms out after frequent recenters", () => {
      const mockMap = mockApp.map as Record<string, ReturnType<typeof vi.fn>>;
      mockMap.latLngToContainerPoint.mockReturnValue({ x: 10, y: 10 });

      const markerObj = L.marker([0, 0]);
      mockReplayManager.state.airplaneMarker = markerObj;
      mockReplayManager.state.playing = true;
      mockReplayManager.state.autoZoom = true;
      mockReplayManager.state.lastZoom = 12;
      mockReplayManager.state.currentTime = 5;
      mockReplayManager.state.segments = [makeSegment({ time: 0 })];

      const now = Date.now();
      mockReplayManager.state.recenterTimestamps = [
        now - 1000,
        now - 500,
        now - 100,
      ];

      callUpdateDisplay();
      expect(mockMap.setZoom).toHaveBeenCalledWith(
        11,
        expect.objectContaining({ animate: true })
      );
    });

    it("adds marker to map if missing", () => {
      const mockMap = mockApp.map as Record<string, ReturnType<typeof vi.fn>>;
      mockMap.hasLayer.mockReturnValue(false);

      const markerObj = L.marker([0, 0]);
      mockReplayManager.state.airplaneMarker = markerObj;
      mockReplayManager.state.currentTime = 5;
      mockReplayManager.state.segments = [makeSegment({ time: 0 })];

      callUpdateDisplay();
      expect(markerObj.addTo).toHaveBeenCalledWith(mockMap);
    });
  });
});
