import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ReplayManager } from "../../../../kml_heatmap/frontend/ui/replayManager";
import type { MockMapApp } from "../../testHelpers";

// Mock domCache
const mockDomElements: Record<string, HTMLElement> = {};
vi.mock("../../../../kml_heatmap/frontend/utils/domCache", () => ({
  domCache: {
    get: vi.fn((id: string) => mockDomElements[id] || null),
    cacheElements: vi.fn(),
  },
}));

describe("ReplayManager", () => {
  let replayManager: ReplayManager;
  let mockApp: MockMapApp;

  beforeEach(() => {
    vi.useFakeTimers();

    // Create DOM elements
    [
      "replay-controls",
      "replay-btn",
      "replay-play-btn",
      "replay-pause-btn",
      "replay-slider",
      "replay-slider-start",
      "replay-slider-end",
      "replay-time-display",
      "replay-speed",
      "replay-autozoom-btn",
      "altitude-btn",
      "altitude-legend",
      "airspeed-btn",
      "airspeed-legend",
      "heatmap-btn",
      "airports-btn",
      "aviation-btn",
    ].forEach((id) => {
      const el = document.createElement("div");
      el.id = id;
      document.body.appendChild(el);
      mockDomElements[id] = el;
    });

    // Mock window.KMLHeatmap
    window.KMLHeatmap = {
      formatTime: vi.fn(
        (t: number) =>
          `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`
      ),
      getColorForAltitude: vi.fn(() => "rgb(255, 0, 0)"),
      getColorForAirspeed: vi.fn(() => "rgb(0, 0, 255)"),
      findMinMax: vi.fn((arr: number[]) => {
        let min = arr[0] ?? 0;
        let max = arr[0] ?? 0;
        for (let i = 1; i < arr.length; i++) {
          if ((arr[i] ?? 0) < min) min = arr[i] ?? 0;
          if ((arr[i] ?? 0) > max) max = arr[i] ?? 0;
        }
        return { min, max };
      }),
      calculateBearing: vi.fn(() => 90),
      calculateSmoothedBearing: vi.fn(() => 90),
    } as typeof window.KMLHeatmap;

    // Mock requestAnimationFrame / cancelAnimationFrame
    vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((cb) => {
      return setTimeout(() => cb(performance.now()), 16) as unknown as number;
    });
    vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation((id) => {
      clearTimeout(id);
    });

    mockApp = {
      map: {
        addLayer: vi.fn(),
        removeLayer: vi.fn(),
        hasLayer: vi.fn(() => true),
        invalidateSize: vi.fn(),
        setView: vi.fn(),
        panTo: vi.fn(),
        setZoom: vi.fn(),
        getSize: vi.fn(() => ({ x: 800, y: 600 })),
        latLngToContainerPoint: vi.fn(() => ({ x: 400, y: 300 })),
        fitBounds: vi.fn(),
      },
      heatmapLayer: { _canvas: null },
      heatmapVisible: true,
      altitudeLayer: {},
      airspeedLayer: {},
      airportLayer: {},
      altitudeVisible: false,
      airspeedVisible: false,
      airportsVisible: true,
      aviationVisible: false,
      buttonsHidden: false,
      selectedPathIds: new Set<number>(),
      fullPathInfo: [],
      fullPathSegments: [
        {
          path_id: 1,
          coords: [
            [48.0, 16.0],
            [48.1, 16.1],
          ],
          altitude_ft: 3000,
          altitude_m: 914,
          groundspeed_knots: 100,
          time: 0,
        },
        {
          path_id: 1,
          coords: [
            [48.1, 16.1],
            [48.2, 16.2],
          ],
          altitude_ft: 4000,
          altitude_m: 1219,
          groundspeed_knots: 120,
          time: 60,
        },
        {
          path_id: 1,
          coords: [
            [48.2, 16.2],
            [48.3, 16.3],
          ],
          altitude_ft: 5000,
          altitude_m: 1524,
          groundspeed_knots: 130,
          time: 120,
        },
      ],
      currentData: {
        path_info: [{ id: 1 }],
        path_segments: [
          {
            path_id: 1,
            altitude_ft: 3000,
            groundspeed_knots: 100,
          },
          {
            path_id: 1,
            altitude_ft: 5000,
            groundspeed_knots: 130,
          },
        ],
      },
      altitudeRange: { min: 0, max: 10000 },
      airspeedRange: { min: 0, max: 200 },
      stateManager: { saveMapState: vi.fn() },
      layerManager: {
        redrawAltitudePaths: vi.fn(),
        redrawAirspeedPaths: vi.fn(),
        updateAltitudeLegend: vi.fn(),
        updateAirspeedLegend: vi.fn(),
      },
      replayManager: { replayActive: false },
      fullStats: {
        max_groundspeed_knots: 130,
      },
    } as MockMapApp;

    replayManager = new ReplayManager(mockApp as any);
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.keys(mockDomElements).forEach((id) => {
      const el = document.getElementById(id);
      if (el) document.body.removeChild(el);
      delete mockDomElements[id];
    });
    document.body.classList.remove("replay-active");
    vi.restoreAllMocks();
  });

  describe("constructor", () => {
    it("initializes with default replay state", () => {
      expect(replayManager.replayActive).toBe(false);
      expect(replayManager.replayPlaying).toBe(false);
      expect(replayManager.replayCurrentTime).toBe(0);
      expect(replayManager.replayMaxTime).toBe(0);
      expect(replayManager.replaySpeed).toBe(50.0);
      expect(replayManager.replayLayer).toBeNull();
      expect(replayManager.replaySegments).toEqual([]);
      expect(replayManager.replayAirplaneMarker).toBeNull();
      expect(replayManager.replayLastDrawnIndex).toBe(-1);
      expect(replayManager.replayAutoZoom).toBe(false);
    });
  });

  describe("toggleReplay", () => {
    it("returns early if replay-controls panel not found", () => {
      delete mockDomElements["replay-controls"];

      replayManager.toggleReplay();

      expect(mockApp.stateManager!.saveMapState).not.toHaveBeenCalled();
    });

    it("does nothing when activating with no path selected", () => {
      mockApp.selectedPathIds = new Set();

      replayManager.toggleReplay();

      expect(replayManager.replayActive).toBe(false);
    });

    it("does nothing when activating with multiple paths selected", () => {
      mockApp.selectedPathIds = new Set([1, 2]);

      replayManager.toggleReplay();

      expect(replayManager.replayActive).toBe(false);
    });

    it("activates replay when exactly one path is selected", () => {
      mockApp.selectedPathIds = new Set([1]);

      replayManager.toggleReplay();

      expect(replayManager.replayActive).toBe(true);
      expect(mockDomElements["replay-controls"].style.display).toBe("block");
      expect(document.body.classList.contains("replay-active")).toBe(true);
      expect(mockApp.stateManager!.saveMapState).toHaveBeenCalled();
    });

    it("sets replay-btn text on activation", () => {
      mockApp.selectedPathIds = new Set([1]);

      replayManager.toggleReplay();

      const replayBtn = mockDomElements["replay-btn"];
      expect(replayBtn.textContent).toContain("Replay");
      expect(replayBtn.style.opacity).toBe("1");
    });

    it("sets auto-zoom button opacity on activation based on autoZoom state", () => {
      mockApp.selectedPathIds = new Set([1]);
      replayManager.replayAutoZoom = true;

      replayManager.toggleReplay();

      expect(mockDomElements["replay-autozoom-btn"].style.opacity).toBe("1");
    });

    it("sets auto-zoom button disabled style when auto-zoom is off", () => {
      mockApp.selectedPathIds = new Set([1]);
      replayManager.replayAutoZoom = false;

      replayManager.toggleReplay();

      expect(mockDomElements["replay-autozoom-btn"].style.opacity).toBe("0.5");
    });

    it("hides other layers during replay activation", () => {
      mockApp.selectedPathIds = new Set([1]);
      mockApp.heatmapVisible = true;
      mockApp.altitudeVisible = true;

      replayManager.toggleReplay();

      // Should hide heatmap and altitude layers
      expect(mockApp.map!.removeLayer).toHaveBeenCalledWith(
        mockApp.heatmapLayer
      );
      expect(mockApp.map!.removeLayer).toHaveBeenCalledWith(
        mockApp.altitudeLayer
      );
    });

    it("deactivates replay when already active", () => {
      // First activate
      mockApp.selectedPathIds = new Set([1]);
      replayManager.toggleReplay();
      expect(replayManager.replayActive).toBe(true);

      // Now deactivate
      replayManager.toggleReplay();

      expect(replayManager.replayActive).toBe(false);
      expect(mockDomElements["replay-controls"].style.display).toBe("none");
      expect(document.body.classList.contains("replay-active")).toBe(false);
    });

    it("removes airplane marker on deactivation", () => {
      mockApp.selectedPathIds = new Set([1]);
      replayManager.toggleReplay();
      // Airplane marker should exist after activation
      expect(replayManager.replayAirplaneMarker).not.toBeNull();

      replayManager.toggleReplay();

      // Airplane marker should be removed and nulled
      expect(mockApp.map!.removeLayer).toHaveBeenCalled();
      expect(replayManager.replayAirplaneMarker).toBeNull();
    });

    it("removes replay layer from map on deactivation", () => {
      mockApp.selectedPathIds = new Set([1]);
      replayManager.toggleReplay();
      const layer = replayManager.replayLayer;

      replayManager.toggleReplay();

      expect(mockApp.map!.removeLayer).toHaveBeenCalledWith(layer);
    });

    it("restores layer visibility on deactivation", () => {
      mockApp.selectedPathIds = new Set([1]);
      mockApp.heatmapVisible = true;

      replayManager.toggleReplay();
      replayManager.toggleReplay();

      // restoreLayerVisibility should restore heatmap
      expect(mockApp.map!.addLayer).toHaveBeenCalledWith(mockApp.heatmapLayer);
    });

    it("enables altitude when neither altitude nor airspeed visible on deactivation", () => {
      mockApp.selectedPathIds = new Set([1]);
      mockApp.altitudeVisible = false;
      mockApp.airspeedVisible = false;

      replayManager.toggleReplay();
      replayManager.toggleReplay();

      // Should enable altitude
      expect(mockApp.altitudeVisible).toBe(true);
      expect(mockDomElements["altitude-btn"].style.opacity).toBe("1");
      expect(mockDomElements["altitude-legend"].style.display).toBe("block");
      expect(mockApp.map!.addLayer).toHaveBeenCalledWith(mockApp.altitudeLayer);
    });

    it("redraws altitude paths after deactivation with timeout", () => {
      mockApp.selectedPathIds = new Set([1]);
      mockApp.altitudeVisible = false;
      mockApp.airspeedVisible = false;

      replayManager.toggleReplay();
      replayManager.toggleReplay();
      // altitudeVisible is set to true during deactivation
      vi.advanceTimersByTime(200);

      expect(mockApp.layerManager!.redrawAltitudePaths).toHaveBeenCalled();
    });

    it("redraws airspeed paths after deactivation when airspeed was visible", () => {
      mockApp.selectedPathIds = new Set([1]);
      mockApp.altitudeVisible = false;
      mockApp.airspeedVisible = true;

      replayManager.toggleReplay();
      replayManager.toggleReplay();
      vi.advanceTimersByTime(200);

      expect(mockApp.layerManager!.redrawAirspeedPaths).toHaveBeenCalled();
    });
  });

  describe("initializeReplay", () => {
    it("returns false and alerts if no fullPathSegments", () => {
      mockApp.fullPathSegments = null;
      const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});

      const result = replayManager.initializeReplay();

      expect(result).toBe(false);
      expect(alertSpy).toHaveBeenCalled();
    });

    it("returns false if no segments match the selected path", () => {
      mockApp.selectedPathIds = new Set([999]);

      const result = replayManager.initializeReplay();

      expect(result).toBe(false);
    });

    it("filters segments by selected path id", () => {
      mockApp.selectedPathIds = new Set([1]);

      replayManager.initializeReplay();

      expect(replayManager.replaySegments.length).toBe(3);
      expect(replayManager.replaySegments.every((s) => s.path_id === 1)).toBe(
        true
      );
    });

    it("sorts segments by time", () => {
      mockApp.selectedPathIds = new Set([1]);
      // Add segments in reverse time order
      (mockApp.fullPathSegments as any[]).push({
        path_id: 1,
        coords: [
          [48.4, 16.4],
          [48.5, 16.5],
        ],
        altitude_ft: 2000,
        time: -10,
      });

      replayManager.initializeReplay();

      // First segment should be the one with time -10
      expect(replayManager.replaySegments[0].time).toBe(-10);
    });

    it("calculates color ranges from current data path_segments", () => {
      mockApp.selectedPathIds = new Set([1]);

      replayManager.initializeReplay();

      expect(window.KMLHeatmap.findMinMax).toHaveBeenCalled();
      // Should calculate from current resolution segments for path 1
      expect(replayManager.replayColorMinAlt).toBeDefined();
      expect(replayManager.replayColorMaxAlt).toBeDefined();
    });

    it("uses fallback airspeed range when no groundspeeds > 0 in current data", () => {
      mockApp.selectedPathIds = new Set([1]);
      // Set all groundspeeds to 0 in current data
      mockApp.currentData!.path_segments = [
        { path_id: 1, altitude_ft: 3000, groundspeed_knots: 0 },
      ];

      replayManager.initializeReplay();

      expect(replayManager.replayColorMinSpeed).toBe(
        mockApp.airspeedRange!.min
      );
      expect(replayManager.replayColorMaxSpeed).toBe(
        mockApp.airspeedRange!.max
      );
    });

    it("uses full resolution fallback when no current res segments match path", () => {
      mockApp.selectedPathIds = new Set([1]);
      // Set current data segments to a different path
      mockApp.currentData!.path_segments = [
        { path_id: 999, altitude_ft: 1000, groundspeed_knots: 50 },
      ];

      replayManager.initializeReplay();

      // Should use full resolution segments' altitude range as fallback
      expect(window.KMLHeatmap.findMinMax).toHaveBeenCalled();
    });

    it("uses app airspeedRange as fallback when full-res segments have no groundspeeds", () => {
      mockApp.selectedPathIds = new Set([1]);
      // Set current data segments to a different path (triggers full-res fallback)
      mockApp.currentData!.path_segments = [
        { path_id: 999, altitude_ft: 1000, groundspeed_knots: 50 },
      ];
      // Set full-res segments to have no groundspeeds
      mockApp.fullPathSegments = [
        {
          path_id: 1,
          coords: [
            [48.0, 16.0],
            [48.1, 16.1],
          ],
          altitude_ft: 3000,
          groundspeed_knots: 0,
          time: 0,
        },
        {
          path_id: 1,
          coords: [
            [48.1, 16.1],
            [48.2, 16.2],
          ],
          altitude_ft: 4000,
          groundspeed_knots: 0,
          time: 60,
        },
      ];

      replayManager.initializeReplay();

      expect(replayManager.replayColorMinSpeed).toBe(
        mockApp.airspeedRange!.min
      );
      expect(replayManager.replayColorMaxSpeed).toBe(
        mockApp.airspeedRange!.max
      );
    });

    it("sets replayMaxTime from last segment", () => {
      mockApp.selectedPathIds = new Set([1]);

      replayManager.initializeReplay();

      expect(replayManager.replayMaxTime).toBe(120);
    });

    it("updates slider max value", () => {
      mockApp.selectedPathIds = new Set([1]);

      replayManager.initializeReplay();

      const slider = mockDomElements["replay-slider"] as HTMLInputElement;
      expect(slider.getAttribute("max") || (slider as any).max).toBeDefined();
    });

    it("creates replay layer group and adds to map", () => {
      mockApp.selectedPathIds = new Set([1]);

      replayManager.initializeReplay();

      expect(replayManager.replayLayer).not.toBeNull();
      // replayLayer.addTo(map) is called, not map.addLayer(replayLayer)
      expect(replayManager.replayLayer!.addTo).toHaveBeenCalledWith(
        mockApp.map
      );
    });

    it("creates airplane marker at first segment's start coords", () => {
      mockApp.selectedPathIds = new Set([1]);

      replayManager.initializeReplay();

      expect(replayManager.replayAirplaneMarker).not.toBeNull();
    });

    it("resets replay state on initialization", () => {
      mockApp.selectedPathIds = new Set([1]);
      replayManager.replayCurrentTime = 50;
      replayManager.replayLastDrawnIndex = 5;
      replayManager.replayLastBearing = 180;

      replayManager.initializeReplay();

      // replayCurrentTime and replayLastDrawnIndex are reset to initial values
      // before updateReplayDisplay() is called at the end of initializeReplay()
      expect(replayManager.replayCurrentTime).toBe(0);
      // updateReplayDisplay at time 0 does not draw segments, so lastDrawnIndex stays -1
      expect(replayManager.replayLastDrawnIndex).toBe(-1);
    });

    it("sets initial zoom when autoZoom is enabled", () => {
      mockApp.selectedPathIds = new Set([1]);
      replayManager.replayAutoZoom = true;

      replayManager.initializeReplay();

      expect(mockApp.map!.setView).toHaveBeenCalledWith(
        [48.0, 16.0],
        16,
        expect.objectContaining({ animate: true })
      );
      expect(replayManager.replayLastZoom).toBe(16);
    });

    it("pans to start position without changing zoom when autoZoom is disabled", () => {
      mockApp.selectedPathIds = new Set([1]);
      replayManager.replayAutoZoom = false;

      replayManager.initializeReplay();

      expect(mockApp.map!.panTo).toHaveBeenCalledWith(
        [48.0, 16.0],
        expect.objectContaining({ animate: true })
      );
    });

    it("updates altitude and airspeed legends", () => {
      mockApp.selectedPathIds = new Set([1]);

      replayManager.initializeReplay();

      expect(mockApp.layerManager!.updateAltitudeLegend).toHaveBeenCalled();
      expect(mockApp.layerManager!.updateAirspeedLegend).toHaveBeenCalled();
    });

    it("removes old airplane marker if it exists before creating new one", () => {
      mockApp.selectedPathIds = new Set([1]);

      // First init
      replayManager.initializeReplay();
      const firstMarker = replayManager.replayAirplaneMarker;

      // Second init
      replayManager.initializeReplay();

      expect(mockApp.map!.removeLayer).toHaveBeenCalledWith(firstMarker);
    });

    it("returns true on success", () => {
      mockApp.selectedPathIds = new Set([1]);

      const result = replayManager.initializeReplay();

      expect(result).toBe(true);
    });
  });

  describe("hideOtherLayersDuringReplay", () => {
    it("returns early if no map", () => {
      mockApp.map = undefined;

      replayManager.hideOtherLayersDuringReplay();

      // No errors thrown
    });

    it("hides heatmap when visible", () => {
      mockApp.heatmapVisible = true;

      replayManager.hideOtherLayersDuringReplay();

      expect(mockApp.map!.removeLayer).toHaveBeenCalledWith(
        mockApp.heatmapLayer
      );
    });

    it("does not hide heatmap when not visible", () => {
      mockApp.heatmapVisible = false;

      replayManager.hideOtherLayersDuringReplay();

      expect(mockApp.map!.removeLayer).not.toHaveBeenCalledWith(
        mockApp.heatmapLayer
      );
    });

    it("hides altitude layer when visible", () => {
      mockApp.altitudeVisible = true;

      replayManager.hideOtherLayersDuringReplay();

      expect(mockApp.map!.removeLayer).toHaveBeenCalledWith(
        mockApp.altitudeLayer
      );
    });

    it("hides airspeed layer when visible", () => {
      mockApp.airspeedVisible = true;

      replayManager.hideOtherLayersDuringReplay();

      expect(mockApp.map!.removeLayer).toHaveBeenCalledWith(
        mockApp.airspeedLayer
      );
    });

    it("disables certain buttons during replay", () => {
      // Create the elements the function looks for
      ["heatmap-btn", "airports-btn", "aviation-btn"].forEach((id) => {
        const el = document.getElementById(id);
        if (el) (el as HTMLButtonElement).disabled = false;
      });
      const yearSelect = document.createElement("select");
      yearSelect.id = "year-select";
      document.body.appendChild(yearSelect);
      const aircraftSelect = document.createElement("select");
      aircraftSelect.id = "aircraft-select";
      document.body.appendChild(aircraftSelect);

      replayManager.hideOtherLayersDuringReplay();

      expect(
        (document.getElementById("year-select") as HTMLSelectElement).disabled
      ).toBe(true);
      expect(
        (document.getElementById("aircraft-select") as HTMLSelectElement)
          .disabled
      ).toBe(true);

      yearSelect.remove();
      aircraftSelect.remove();
    });
  });

  describe("restoreLayerVisibility", () => {
    it("returns early if no map", () => {
      mockApp.map = undefined;

      replayManager.restoreLayerVisibility();

      // No errors thrown
    });

    it("restores heatmap when visible", () => {
      mockApp.heatmapVisible = true;

      replayManager.restoreLayerVisibility();

      expect(mockApp.map!.addLayer).toHaveBeenCalledWith(mockApp.heatmapLayer);
    });

    it("sets pointer-events none on heatmap canvas when restoring", () => {
      const canvas = document.createElement("canvas");
      (mockApp as any).heatmapLayer._canvas = canvas;
      mockApp.heatmapVisible = true;

      replayManager.restoreLayerVisibility();

      expect(canvas.style.pointerEvents).toBe("none");
    });

    it("does not restore heatmap when not visible", () => {
      mockApp.heatmapVisible = false;

      replayManager.restoreLayerVisibility();

      expect(mockApp.map!.addLayer).not.toHaveBeenCalledWith(
        mockApp.heatmapLayer
      );
    });

    it("restores altitude layer when visible and redraws with delay", () => {
      mockApp.altitudeVisible = true;

      replayManager.restoreLayerVisibility();

      expect(mockApp.map!.addLayer).toHaveBeenCalledWith(mockApp.altitudeLayer);
      vi.advanceTimersByTime(100);
      expect(mockApp.layerManager!.redrawAltitudePaths).toHaveBeenCalled();
      expect(mockApp.map!.invalidateSize).toHaveBeenCalled();
    });

    it("restores airspeed layer when visible and redraws with delay", () => {
      mockApp.airspeedVisible = true;

      replayManager.restoreLayerVisibility();

      expect(mockApp.map!.addLayer).toHaveBeenCalledWith(mockApp.airspeedLayer);
      vi.advanceTimersByTime(100);
      expect(mockApp.layerManager!.redrawAirspeedPaths).toHaveBeenCalled();
      expect(mockApp.map!.invalidateSize).toHaveBeenCalled();
    });

    it("re-enables disabled buttons", () => {
      const yearSelect = document.createElement("select");
      yearSelect.id = "year-select";
      yearSelect.disabled = true;
      document.body.appendChild(yearSelect);
      const aircraftSelect = document.createElement("select");
      aircraftSelect.id = "aircraft-select";
      aircraftSelect.disabled = true;
      document.body.appendChild(aircraftSelect);

      replayManager.restoreLayerVisibility();

      expect(
        (document.getElementById("year-select") as HTMLSelectElement).disabled
      ).toBe(false);
      expect(
        (document.getElementById("aircraft-select") as HTMLSelectElement)
          .disabled
      ).toBe(false);

      yearSelect.remove();
      aircraftSelect.remove();
    });
  });

  describe("playReplay", () => {
    beforeEach(() => {
      mockApp.selectedPathIds = new Set([1]);
      replayManager.initializeReplay();
      replayManager.replayActive = true;
    });

    it("returns early if not active", () => {
      replayManager.replayActive = false;

      replayManager.playReplay();

      expect(replayManager.replayPlaying).toBe(false);
    });

    it("returns early if no map", () => {
      mockApp.map = undefined;

      replayManager.playReplay();

      expect(replayManager.replayPlaying).toBe(false);
    });

    it("sets playing state and swaps play/pause buttons", () => {
      replayManager.playReplay();

      expect(replayManager.replayPlaying).toBe(true);
      expect(mockDomElements["replay-play-btn"].style.display).toBe("none");
      expect(mockDomElements["replay-pause-btn"].style.display).toBe(
        "inline-block"
      );
    });

    it("starts animation frame", () => {
      replayManager.playReplay();

      expect(requestAnimationFrame).toHaveBeenCalled();
      expect(replayManager.replayAnimationFrameId).not.toBeNull();
    });

    it("restarts from beginning when at the end", () => {
      replayManager.replayCurrentTime = replayManager.replayMaxTime;

      replayManager.playReplay();

      expect(replayManager.replayCurrentTime).toBe(0);
      expect(replayManager.replayLastDrawnIndex).toBe(-1);
    });

    it("resets airplane to start when restarting from end", () => {
      replayManager.replayCurrentTime = replayManager.replayMaxTime;

      replayManager.playReplay();

      expect(
        replayManager.replayAirplaneMarker!.setLatLng
      ).toHaveBeenCalledWith([48.0, 16.0]);
    });

    it("resets to initial zoom when restarting with autoZoom enabled", () => {
      replayManager.replayCurrentTime = replayManager.replayMaxTime;
      replayManager.replayAutoZoom = true;

      replayManager.playReplay();

      expect(mockApp.map!.setView).toHaveBeenCalledWith(
        [48.0, 16.0],
        16,
        expect.objectContaining({ animate: true })
      );
    });

    it("saves map state", () => {
      replayManager.playReplay();

      expect(mockApp.stateManager!.saveMapState).toHaveBeenCalled();
    });

    it("animation callback advances time and continues loop", () => {
      replayManager.replaySpeed = 50;
      replayManager.playReplay();

      // Advance timers to trigger the requestAnimationFrame callback
      vi.advanceTimersByTime(20);

      // Animation should have advanced current time (deltaMs * speed / 1000)
      // and requested another frame
      expect(replayManager.replayPlaying).toBe(true);
    });

    it("animation callback pauses when reaching max time and fits bounds", () => {
      // Set current time very close to max so animation reaches end quickly
      replayManager.replayCurrentTime = replayManager.replayMaxTime - 0.001;
      replayManager.replaySpeed = 1000;

      replayManager.playReplay();

      // Advance past enough frames for the animation to reach maxTime
      vi.advanceTimersByTime(50);

      // Should have paused
      expect(replayManager.replayPlaying).toBe(false);
      // Should fit bounds at end
      expect(mockApp.map!.fitBounds).toHaveBeenCalled();
    });

    it("animation callback stops when playing is set to false", () => {
      replayManager.playReplay();
      replayManager.replayPlaying = false;

      // Advance past the first frame
      vi.advanceTimersByTime(20);

      // The callback should have returned early
      // No further frames requested since playing was set to false
    });
  });

  describe("pauseReplay", () => {
    it("sets playing to false and swaps buttons", () => {
      replayManager.replayPlaying = true;

      replayManager.pauseReplay();

      expect(replayManager.replayPlaying).toBe(false);
      expect(mockDomElements["replay-play-btn"].style.display).toBe(
        "inline-block"
      );
      expect(mockDomElements["replay-pause-btn"].style.display).toBe("none");
    });

    it("cancels animation frame", () => {
      replayManager.replayAnimationFrameId = 42;

      replayManager.pauseReplay();

      expect(cancelAnimationFrame).toHaveBeenCalledWith(42);
      expect(replayManager.replayAnimationFrameId).toBeNull();
    });

    it("resets frame time", () => {
      replayManager.replayLastFrameTime = 12345;

      replayManager.pauseReplay();

      expect(replayManager.replayLastFrameTime).toBeNull();
    });

    it("saves map state", () => {
      replayManager.pauseReplay();

      expect(mockApp.stateManager!.saveMapState).toHaveBeenCalled();
    });
  });

  describe("stopReplay", () => {
    beforeEach(() => {
      mockApp.selectedPathIds = new Set([1]);
      replayManager.initializeReplay();
      replayManager.replayActive = true;
    });

    it("pauses and resets time", () => {
      replayManager.replayCurrentTime = 50;

      replayManager.stopReplay();

      expect(replayManager.replayPlaying).toBe(false);
      expect(replayManager.replayCurrentTime).toBe(0);
      // stopReplay calls updateReplayDisplay which may update lastDrawnIndex
      // but at time 0 it should not draw segments
      expect(replayManager.replayLastDrawnIndex).toBe(-1);
    });

    it("clears replay layer", () => {
      replayManager.stopReplay();

      expect(replayManager.replayLayer!.clearLayers).toHaveBeenCalled();
    });

    it("resets airplane to start position", () => {
      replayManager.stopReplay();

      expect(
        replayManager.replayAirplaneMarker!.setLatLng
      ).toHaveBeenCalledWith([48.0, 16.0]);
    });
  });

  describe("seekReplay", () => {
    beforeEach(() => {
      mockApp.selectedPathIds = new Set([1]);
      replayManager.initializeReplay();
      replayManager.replayActive = true;
    });

    it("sets current time from string value", () => {
      replayManager.seekReplay("60.5");

      expect(replayManager.replayCurrentTime).toBe(60.5);
    });

    it("clears and redraws when seeking backward", () => {
      replayManager.replayCurrentTime = 100;

      replayManager.seekReplay("30");

      // seekReplay clears layers when going backward, then calls updateReplayDisplay
      expect(replayManager.replayLayer!.clearLayers).toHaveBeenCalled();
      // After clearing, updateReplayDisplay redraws segments up to t=30 (segment at t=0)
      expect(replayManager.replayCurrentTime).toBe(30);
    });

    it("does not clear when seeking forward", () => {
      replayManager.replayCurrentTime = 30;
      const clearSpy = replayManager.replayLayer!.clearLayers as ReturnType<
        typeof vi.fn
      >;
      clearSpy.mockClear();

      replayManager.seekReplay("60");

      expect(clearSpy).not.toHaveBeenCalled();
    });

    it("saves map state", () => {
      replayManager.seekReplay("30");

      expect(mockApp.stateManager!.saveMapState).toHaveBeenCalled();
    });
  });

  describe("changeReplaySpeed", () => {
    it("updates speed from select element", () => {
      const select = mockDomElements["replay-speed"] as HTMLSelectElement;
      (select as any).value = "100";

      replayManager.changeReplaySpeed();

      expect(replayManager.replaySpeed).toBe(100);
    });

    it("returns early if no speed select element", () => {
      delete mockDomElements["replay-speed"];

      replayManager.changeReplaySpeed();

      // Should not throw
      expect(replayManager.replaySpeed).toBe(50.0);
    });
  });

  describe("toggleAutoZoom", () => {
    it("toggles autoZoom on", () => {
      replayManager.replayAutoZoom = false;

      replayManager.toggleAutoZoom();

      expect(replayManager.replayAutoZoom).toBe(true);
      // Browser normalizes "1.0" to "1"
      expect(mockDomElements["replay-autozoom-btn"].style.opacity).toBe("1");
    });

    it("toggles autoZoom off", () => {
      replayManager.replayAutoZoom = true;

      replayManager.toggleAutoZoom();

      expect(replayManager.replayAutoZoom).toBe(false);
      expect(mockDomElements["replay-autozoom-btn"].style.opacity).toBe("0.5");
    });

    it("saves map state", () => {
      replayManager.toggleAutoZoom();

      expect(mockApp.stateManager!.saveMapState).toHaveBeenCalled();
    });
  });

  describe("updateReplayButtonState", () => {
    it("enables button when exactly one path selected and timing data available", () => {
      mockApp.selectedPathIds = new Set([1]);
      mockApp.fullStats = { max_groundspeed_knots: 130 } as any;

      replayManager.updateReplayButtonState();

      const btn = mockDomElements["replay-btn"] as HTMLButtonElement;
      // Browser normalizes "1.0" to "1"
      expect(btn.style.opacity).toBe("1");
      expect(btn.disabled).toBe(false);
    });

    it("disables button when no paths selected", () => {
      mockApp.selectedPathIds = new Set();
      mockApp.fullStats = { max_groundspeed_knots: 130 } as any;

      replayManager.updateReplayButtonState();

      const btn = mockDomElements["replay-btn"] as HTMLButtonElement;
      expect(btn.style.opacity).toBe("0.5");
      expect(btn.disabled).toBe(true);
    });

    it("disables button when no timing data", () => {
      mockApp.selectedPathIds = new Set([1]);
      mockApp.fullStats = { max_groundspeed_knots: 0 } as any;

      replayManager.updateReplayButtonState();

      const btn = mockDomElements["replay-btn"] as HTMLButtonElement;
      expect(btn.style.opacity).toBe("0.5");
      expect(btn.disabled).toBe(true);
    });

    it("returns early if no replay button", () => {
      delete mockDomElements["replay-btn"];

      replayManager.updateReplayButtonState();

      // Should not throw
    });
  });

  describe("updateReplayDisplay", () => {
    beforeEach(() => {
      mockApp.selectedPathIds = new Set([1]);
      replayManager.initializeReplay();
      replayManager.replayActive = true;
    });

    it("updates time display", () => {
      replayManager.replayCurrentTime = 60;

      replayManager.updateReplayDisplay();

      expect(mockDomElements["replay-time-display"].textContent).toContain("/");
    });

    it("updates slider value", () => {
      replayManager.replayCurrentTime = 60;

      replayManager.updateReplayDisplay();

      const slider = mockDomElements["replay-slider"] as HTMLInputElement;
      expect(slider.value).toBe("60");
    });

    it("draws path segments incrementally", () => {
      replayManager.replayCurrentTime = 65;

      replayManager.updateReplayDisplay();

      // Should have drawn segments with time <= 65 (first two: t=0 and t=60)
      // but only when time > 0
      expect(replayManager.replayLastDrawnIndex).toBeGreaterThanOrEqual(0);
    });

    it("does not draw segments when at time 0", () => {
      replayManager.replayCurrentTime = 0;
      replayManager.replayLastDrawnIndex = -1;

      replayManager.updateReplayDisplay();

      expect(replayManager.replayLastDrawnIndex).toBe(-1);
    });

    it("positions airplane at first segment when no lastSegment found", () => {
      replayManager.replayCurrentTime = -1;

      replayManager.updateReplayDisplay();

      // Should position airplane at start of first segment
      expect(replayManager.replayAirplaneMarker!.setLatLng).toHaveBeenCalled();
    });

    it("uses airspeed colors when airspeed visible and altitude not visible", () => {
      mockApp.airspeedVisible = true;
      mockApp.altitudeVisible = false;
      replayManager.replayCurrentTime = 65;

      replayManager.updateReplayDisplay();

      expect(window.KMLHeatmap.getColorForAltitude).toHaveBeenCalled();
    });

    it("adds airplane marker back to map if it was removed", () => {
      (mockApp.map!.hasLayer as ReturnType<typeof vi.fn>).mockReturnValue(
        false
      );
      replayManager.replayCurrentTime = 30;

      replayManager.updateReplayDisplay();

      expect(replayManager.replayAirplaneMarker!.addTo).toHaveBeenCalledWith(
        mockApp.map
      );
    });

    it("updates airplane rotation via element transform", () => {
      replayManager.replayCurrentTime = 65;
      const mockElement = document.createElement("div");
      const iconDiv = document.createElement("div");
      iconDiv.className = "replay-airplane-icon";
      mockElement.appendChild(iconDiv);
      (
        replayManager.replayAirplaneMarker!.getElement as ReturnType<
          typeof vi.fn
        >
      ).mockReturnValue(mockElement);

      replayManager.updateReplayDisplay();

      expect(iconDiv.style.transform).toContain("rotate(");
    });

    it("pans map when airplane is near edge during playing", () => {
      replayManager.replayPlaying = true;
      replayManager.replayCurrentTime = 65;
      // Simulate airplane near left edge
      (
        mockApp.map!.latLngToContainerPoint as ReturnType<typeof vi.fn>
      ).mockReturnValue({ x: 10, y: 300 });

      replayManager.updateReplayDisplay();

      expect(mockApp.map!.panTo).toHaveBeenCalled();
    });

    it("always pans on manual seek", () => {
      replayManager.replayPlaying = false;
      replayManager.replayCurrentTime = 65;
      // Airplane in center
      (
        mockApp.map!.latLngToContainerPoint as ReturnType<typeof vi.fn>
      ).mockReturnValue({ x: 400, y: 300 });

      replayManager.updateReplayDisplay(true);

      expect(mockApp.map!.panTo).toHaveBeenCalled();
    });

    it("interpolates position between segments", () => {
      replayManager.replayCurrentTime = 30;

      replayManager.updateReplayDisplay();

      // Should interpolate between segment at t=0 and segment at t=60
      expect(replayManager.replayAirplaneMarker!.setLatLng).toHaveBeenCalled();
    });

    it("uses last known bearing when smoothed bearing is null", () => {
      (
        window.KMLHeatmap.calculateSmoothedBearing as ReturnType<typeof vi.fn>
      ).mockReturnValue(null);
      replayManager.replayLastBearing = 45;
      replayManager.replayCurrentTime = 65;

      replayManager.updateReplayDisplay();

      // Should use last known bearing since smoothed returned null
      expect(replayManager.replayLastBearing).toBe(45);
    });

    it("auto-zooms out when too many recenters happen", () => {
      replayManager.replayPlaying = true;
      replayManager.replayAutoZoom = true;
      replayManager.replayLastZoom = 14;
      replayManager.replayCurrentTime = 65;
      // Simulate airplane near edge to trigger recenter
      (
        mockApp.map!.latLngToContainerPoint as ReturnType<typeof vi.fn>
      ).mockReturnValue({ x: 10, y: 300 });
      // Pre-populate with recent recenter timestamps
      const now = Date.now();
      replayManager.replayRecenterTimestamps = [
        now - 1000,
        now - 500,
        now - 100,
      ];

      replayManager.updateReplayDisplay();

      // Should zoom out
      expect(mockApp.map!.setZoom).toHaveBeenCalled();
    });
  });

  describe("updateReplayDisplay - popup auto-update", () => {
    beforeEach(() => {
      mockApp.selectedPathIds = new Set([1]);
      replayManager.initializeReplay();
      replayManager.replayActive = true;
    });

    it("updates airplane popup when popup is open during display update", () => {
      replayManager.replayCurrentTime = 65;
      const mockPopup = { setContent: vi.fn() };
      (
        replayManager.replayAirplaneMarker!.getPopup as ReturnType<typeof vi.fn>
      ).mockReturnValue(mockPopup);
      (
        replayManager.replayAirplaneMarker!.isPopupOpen as ReturnType<
          typeof vi.fn
        >
      ).mockReturnValue(true);

      replayManager.updateReplayDisplay();

      // Should have called updateAirplanePopup which updates the popup content
      expect(mockPopup.setContent).toHaveBeenCalled();
    });
  });

  describe("updateReplayAirplanePopup", () => {
    beforeEach(() => {
      mockApp.selectedPathIds = new Set([1]);
      replayManager.initializeReplay();
      replayManager.replayActive = true;
    });

    it("returns early if no airplane marker", () => {
      replayManager.replayAirplaneMarker = null;

      replayManager.updateReplayAirplanePopup();

      // No errors thrown
    });

    it("returns early if replay not active", () => {
      replayManager.replayActive = false;

      replayManager.updateReplayAirplanePopup();

      // No errors thrown
    });

    it("creates popup with altitude and speed data", () => {
      replayManager.replayCurrentTime = 30;

      replayManager.updateReplayAirplanePopup();

      expect(replayManager.replayAirplaneMarker!.bindPopup).toHaveBeenCalled();
      expect(replayManager.replayAirplaneMarker!.openPopup).toHaveBeenCalled();
    });

    it("uses first segment when no segment has time <= currentTime", () => {
      replayManager.replayCurrentTime = -10;

      replayManager.updateReplayAirplanePopup();

      expect(replayManager.replayAirplaneMarker!.bindPopup).toHaveBeenCalled();
    });

    it("returns early when replaySegments is empty", () => {
      replayManager.replaySegments = [];

      replayManager.updateReplayAirplanePopup();

      // Should not call bindPopup since there are no segments to display
      expect(
        replayManager.replayAirplaneMarker!.bindPopup
      ).not.toHaveBeenCalled();
    });

    it("updates existing popup content instead of creating new one", () => {
      const mockPopup = { setContent: vi.fn() };
      (
        replayManager.replayAirplaneMarker!.getPopup as ReturnType<typeof vi.fn>
      ).mockReturnValue(mockPopup);
      replayManager.replayCurrentTime = 30;

      replayManager.updateReplayAirplanePopup();

      expect(mockPopup.setContent).toHaveBeenCalled();
    });
  });
});
