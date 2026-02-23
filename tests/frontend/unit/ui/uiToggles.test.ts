import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { UIToggles } from "../../../../kml_heatmap/frontend/ui/uiToggles";
import type { MockMapApp } from "../../testHelpers";

// Mock domCache
const mockDomElements: Record<string, HTMLElement> = {};
vi.mock("../../../../kml_heatmap/frontend/utils/domCache", () => ({
  domCache: {
    get: vi.fn((id: string) => mockDomElements[id] || null),
    cacheElements: vi.fn(),
  },
}));

describe("UIToggles", () => {
  let uiToggles: UIToggles;
  let mockApp: MockMapApp;

  beforeEach(() => {
    // Create DOM elements and register in mockDomElements
    [
      "heatmap-btn",
      "altitude-btn",
      "airspeed-btn",
      "airports-btn",
      "altitude-legend",
      "airspeed-legend",
      "hide-buttons-btn",
      "export-btn",
      "map",
    ].forEach((id) => {
      const el = document.createElement("div");
      el.id = id;
      document.body.appendChild(el);
      mockDomElements[id] = el;
    });

    mockApp = {
      map: { addLayer: vi.fn(), removeLayer: vi.fn() },
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
      stateManager: { saveMapState: vi.fn() },
      replayManager: { replayActive: false },
      layerManager: {
        redrawAltitudePaths: vi.fn(),
        redrawAirspeedPaths: vi.fn(),
      },
      config: { openaipApiKey: "" },
      openaipLayers: {},
      selectedYear: "all",
      selectedAircraft: "all",
      selectedPathIds: new Set<number>(),
      fullPathInfo: [],
    } as MockMapApp;

    uiToggles = new UIToggles(mockApp as any);
  });

  afterEach(() => {
    // Clean up DOM elements
    Object.keys(mockDomElements).forEach((id) => {
      const el = document.getElementById(id);
      if (el) document.body.removeChild(el);
      delete mockDomElements[id];
    });
    // Clean up any toggleable buttons
    document.querySelectorAll(".toggleable-btn").forEach((el) => el.remove());
  });

  describe("toggleHeatmap", () => {
    it("hides heatmap when visible", () => {
      mockApp.heatmapVisible = true;

      uiToggles.toggleHeatmap();

      expect(mockApp.map!.removeLayer).toHaveBeenCalledWith(
        mockApp.heatmapLayer
      );
      expect(mockApp.heatmapVisible).toBe(false);
      expect(mockDomElements["heatmap-btn"].style.opacity).toBe("0.5");
      expect(mockApp.stateManager!.saveMapState).toHaveBeenCalled();
    });

    it("shows heatmap when hidden", () => {
      mockApp.heatmapVisible = false;

      uiToggles.toggleHeatmap();

      expect(mockApp.map!.addLayer).toHaveBeenCalledWith(mockApp.heatmapLayer);
      expect(mockApp.heatmapVisible).toBe(true);
      expect(mockDomElements["heatmap-btn"].style.opacity).toBe("1");
      expect(mockApp.stateManager!.saveMapState).toHaveBeenCalled();
    });

    it("sets pointer-events to none on canvas when showing heatmap", () => {
      mockApp.heatmapVisible = false;
      const canvas = document.createElement("canvas");
      (mockApp as any).heatmapLayer._canvas = canvas;

      uiToggles.toggleHeatmap();

      expect(canvas.style.pointerEvents).toBe("none");
    });

    it("returns early if no map", () => {
      mockApp.map = undefined;

      uiToggles.toggleHeatmap();

      expect(mockApp.stateManager!.saveMapState).not.toHaveBeenCalled();
    });
  });

  describe("toggleAltitude", () => {
    it("shows altitude and hides airspeed when airspeed is visible", () => {
      mockApp.altitudeVisible = false;
      mockApp.airspeedVisible = true;

      uiToggles.toggleAltitude();

      // Should remove airspeed layer
      expect(mockApp.map!.removeLayer).toHaveBeenCalledWith(
        mockApp.airspeedLayer
      );
      expect(mockApp.airspeedVisible).toBe(false);
      expect(mockDomElements["airspeed-btn"].style.opacity).toBe("0.5");
      expect(mockDomElements["airspeed-legend"].style.display).toBe("none");

      // Should add altitude layer
      expect(mockApp.map!.addLayer).toHaveBeenCalledWith(mockApp.altitudeLayer);
      expect(mockApp.altitudeVisible).toBe(true);
      expect(mockDomElements["altitude-btn"].style.opacity).toBe("1");
      expect(mockDomElements["altitude-legend"].style.display).toBe("block");
      expect(mockApp.layerManager!.redrawAltitudePaths).toHaveBeenCalled();
      expect(mockApp.stateManager!.saveMapState).toHaveBeenCalled();
    });

    it("hides altitude when visible", () => {
      mockApp.altitudeVisible = true;

      uiToggles.toggleAltitude();

      expect(mockApp.map!.removeLayer).toHaveBeenCalledWith(
        mockApp.altitudeLayer
      );
      expect(mockApp.altitudeVisible).toBe(false);
      expect(mockDomElements["altitude-btn"].style.opacity).toBe("0.5");
      expect(mockDomElements["altitude-legend"].style.display).toBe("none");
      expect(mockApp.stateManager!.saveMapState).toHaveBeenCalled();
    });

    it("shows altitude without airspeed conflict", () => {
      mockApp.altitudeVisible = false;
      mockApp.airspeedVisible = false;

      uiToggles.toggleAltitude();

      expect(mockApp.map!.addLayer).toHaveBeenCalledWith(mockApp.altitudeLayer);
      expect(mockApp.altitudeVisible).toBe(true);
      expect(mockApp.layerManager!.redrawAltitudePaths).toHaveBeenCalled();
      expect(mockApp.stateManager!.saveMapState).toHaveBeenCalled();
    });

    it("returns early if no map", () => {
      mockApp.map = undefined;

      uiToggles.toggleAltitude();

      expect(mockApp.stateManager!.saveMapState).not.toHaveBeenCalled();
    });

    it("prevents hiding altitude during replay if airspeed is also hidden", () => {
      mockApp.altitudeVisible = true;
      mockApp.airspeedVisible = false;
      (mockApp.replayManager as any).replayActive = true;

      uiToggles.toggleAltitude();

      // Should not hide - both would be hidden
      expect(mockApp.altitudeVisible).toBe(true);
      expect(mockApp.map!.removeLayer).not.toHaveBeenCalled();
    });

    it("during replay does not add layer but updates state", () => {
      mockApp.altitudeVisible = false;
      mockApp.airspeedVisible = false;
      (mockApp.replayManager as any).replayActive = true;
      (mockApp.replayManager as any).replayCurrentTime = 0;
      (mockApp.replayManager as any).replayLastDrawnIndex = -1;
      (mockApp.replayManager as any).replayLayer = { clearLayers: vi.fn() };
      (mockApp.replayManager as any).replaySegments = [];
      (mockApp.replayManager as any).replayAirplaneMarker = null;

      uiToggles.toggleAltitude();

      expect(mockApp.map!.addLayer).not.toHaveBeenCalled();
      expect(mockApp.layerManager!.redrawAltitudePaths).not.toHaveBeenCalled();
      expect(mockApp.altitudeVisible).toBe(true);
      expect(mockDomElements["altitude-legend"].style.display).toBe("block");
      expect(mockApp.stateManager!.saveMapState).toHaveBeenCalled();
    });

    it("during replay hides airspeed without removing layer", () => {
      mockApp.altitudeVisible = false;
      mockApp.airspeedVisible = true;
      (mockApp.replayManager as any).replayActive = true;
      (mockApp.replayManager as any).replayCurrentTime = 0;
      (mockApp.replayManager as any).replayLastDrawnIndex = -1;
      (mockApp.replayManager as any).replayLayer = { clearLayers: vi.fn() };
      (mockApp.replayManager as any).replaySegments = [];
      (mockApp.replayManager as any).replayAirplaneMarker = null;

      uiToggles.toggleAltitude();

      // Should NOT call removeLayer for airspeed during replay
      expect(mockApp.map!.removeLayer).not.toHaveBeenCalled();
      expect(mockApp.airspeedVisible).toBe(false);
      expect(mockApp.altitudeVisible).toBe(true);
    });

    it("during replay updates airplane popup if open", () => {
      mockApp.altitudeVisible = false;
      (mockApp.replayManager as any).replayActive = true;
      (mockApp.replayManager as any).replayCurrentTime = 0;
      (mockApp.replayManager as any).replayLastDrawnIndex = -1;
      (mockApp.replayManager as any).replayLayer = { clearLayers: vi.fn() };
      (mockApp.replayManager as any).replaySegments = [];
      (mockApp.replayManager as any).replayAirplaneMarker = {
        isPopupOpen: vi.fn(() => true),
      };
      (mockApp.replayManager as any).updateReplayAirplanePopup = vi.fn();

      uiToggles.toggleAltitude();

      expect(
        (mockApp.replayManager as any).updateReplayAirplanePopup
      ).toHaveBeenCalled();
    });

    it("during replay redraws altitude path from replay segments", () => {
      mockApp.altitudeVisible = false;
      (mockApp.replayManager as any).replayActive = true;
      (mockApp.replayManager as any).replayCurrentTime = 60;
      (mockApp.replayManager as any).replayLastDrawnIndex = 1;
      (mockApp.replayManager as any).replayLayer = { clearLayers: vi.fn() };
      (mockApp.replayManager as any).replayColorMinAlt = 1000;
      (mockApp.replayManager as any).replayColorMaxAlt = 5000;
      (mockApp.replayManager as any).replaySegments = [
        {
          path_id: 1,
          altitude_ft: 3000,
          time: 0,
          coords: [
            [48, 16],
            [48.1, 16.1],
          ],
        },
        {
          path_id: 1,
          altitude_ft: 4000,
          time: 30,
          coords: [
            [48.1, 16.1],
            [48.2, 16.2],
          ],
        },
      ];
      (mockApp.replayManager as any).replayAirplaneMarker = null;

      // Mock window.KMLHeatmap.getColorForAltitude
      window.KMLHeatmap = {
        getColorForAltitude: vi.fn(() => "#ff0000"),
      } as typeof window.KMLHeatmap;

      uiToggles.toggleAltitude();

      expect(window.KMLHeatmap.getColorForAltitude).toHaveBeenCalled();
      expect((mockApp.replayManager as any).replayLastDrawnIndex).toBe(1);
    });
  });

  describe("toggleAirspeed", () => {
    it("shows airspeed and hides altitude when altitude is visible", () => {
      mockApp.airspeedVisible = false;
      mockApp.altitudeVisible = true;

      uiToggles.toggleAirspeed();

      // Should remove altitude layer
      expect(mockApp.map!.removeLayer).toHaveBeenCalledWith(
        mockApp.altitudeLayer
      );
      expect(mockApp.altitudeVisible).toBe(false);
      expect(mockDomElements["altitude-btn"].style.opacity).toBe("0.5");
      expect(mockDomElements["altitude-legend"].style.display).toBe("none");

      // Should add airspeed layer
      expect(mockApp.map!.addLayer).toHaveBeenCalledWith(mockApp.airspeedLayer);
      expect(mockApp.airspeedVisible).toBe(true);
      expect(mockDomElements["airspeed-btn"].style.opacity).toBe("1");
      expect(mockDomElements["airspeed-legend"].style.display).toBe("block");
      expect(mockApp.layerManager!.redrawAirspeedPaths).toHaveBeenCalled();
      expect(mockApp.stateManager!.saveMapState).toHaveBeenCalled();
    });

    it("hides airspeed when visible", () => {
      mockApp.airspeedVisible = true;

      uiToggles.toggleAirspeed();

      expect(mockApp.map!.removeLayer).toHaveBeenCalledWith(
        mockApp.airspeedLayer
      );
      expect(mockApp.airspeedVisible).toBe(false);
      expect(mockDomElements["airspeed-btn"].style.opacity).toBe("0.5");
      expect(mockDomElements["airspeed-legend"].style.display).toBe("none");
      expect(mockApp.stateManager!.saveMapState).toHaveBeenCalled();
    });

    it("shows airspeed without altitude conflict", () => {
      mockApp.airspeedVisible = false;
      mockApp.altitudeVisible = false;

      uiToggles.toggleAirspeed();

      expect(mockApp.map!.addLayer).toHaveBeenCalledWith(mockApp.airspeedLayer);
      expect(mockApp.airspeedVisible).toBe(true);
      expect(mockApp.layerManager!.redrawAirspeedPaths).toHaveBeenCalled();
      expect(mockApp.stateManager!.saveMapState).toHaveBeenCalled();
    });

    it("returns early if no map", () => {
      mockApp.map = undefined;

      uiToggles.toggleAirspeed();

      expect(mockApp.stateManager!.saveMapState).not.toHaveBeenCalled();
    });

    it("prevents hiding airspeed during replay if altitude is also hidden", () => {
      mockApp.airspeedVisible = true;
      mockApp.altitudeVisible = false;
      (mockApp.replayManager as any).replayActive = true;

      uiToggles.toggleAirspeed();

      expect(mockApp.airspeedVisible).toBe(true);
      expect(mockApp.map!.removeLayer).not.toHaveBeenCalled();
    });

    it("during replay does not add layer but updates state", () => {
      mockApp.airspeedVisible = false;
      mockApp.altitudeVisible = false;
      (mockApp.replayManager as any).replayActive = true;
      (mockApp.replayManager as any).replayCurrentTime = 0;
      (mockApp.replayManager as any).replayLastDrawnIndex = -1;
      (mockApp.replayManager as any).replayLayer = { clearLayers: vi.fn() };
      (mockApp.replayManager as any).replaySegments = [];
      (mockApp.replayManager as any).replayAirplaneMarker = null;

      uiToggles.toggleAirspeed();

      expect(mockApp.map!.addLayer).not.toHaveBeenCalled();
      expect(mockApp.layerManager!.redrawAirspeedPaths).not.toHaveBeenCalled();
      expect(mockApp.airspeedVisible).toBe(true);
      expect(mockDomElements["airspeed-legend"].style.display).toBe("block");
      expect(mockApp.stateManager!.saveMapState).toHaveBeenCalled();
    });

    it("during replay updates airplane popup if open", () => {
      mockApp.airspeedVisible = false;
      mockApp.altitudeVisible = false;
      (mockApp.replayManager as any).replayActive = true;
      (mockApp.replayManager as any).replayCurrentTime = 0;
      (mockApp.replayManager as any).replayLastDrawnIndex = -1;
      (mockApp.replayManager as any).replayLayer = { clearLayers: vi.fn() };
      (mockApp.replayManager as any).replaySegments = [];
      (mockApp.replayManager as any).replayAirplaneMarker = {
        isPopupOpen: vi.fn(() => true),
      };
      (mockApp.replayManager as any).updateReplayAirplanePopup = vi.fn();

      uiToggles.toggleAirspeed();

      expect(
        (mockApp.replayManager as any).updateReplayAirplanePopup
      ).toHaveBeenCalled();
    });

    it("during replay redraws airspeed path from replay segments", () => {
      mockApp.airspeedVisible = false;
      mockApp.altitudeVisible = false;
      (mockApp.replayManager as any).replayActive = true;
      (mockApp.replayManager as any).replayCurrentTime = 60;
      (mockApp.replayManager as any).replayLastDrawnIndex = 1;
      (mockApp.replayManager as any).replayLayer = { clearLayers: vi.fn() };
      (mockApp.replayManager as any).replayColorMinSpeed = 50;
      (mockApp.replayManager as any).replayColorMaxSpeed = 200;
      (mockApp.replayManager as any).replaySegments = [
        {
          path_id: 1,
          groundspeed_knots: 100,
          time: 0,
          coords: [
            [48, 16],
            [48.1, 16.1],
          ],
        },
        {
          path_id: 1,
          groundspeed_knots: 120,
          time: 30,
          coords: [
            [48.1, 16.1],
            [48.2, 16.2],
          ],
        },
      ];
      (mockApp.replayManager as any).replayAirplaneMarker = null;

      // Mock window.KMLHeatmap.getColorForAltitude (used for airspeed coloring too)
      window.KMLHeatmap = {
        getColorForAltitude: vi.fn(() => "#0000ff"),
      } as typeof window.KMLHeatmap;

      uiToggles.toggleAirspeed();

      expect(window.KMLHeatmap.getColorForAltitude).toHaveBeenCalled();
      expect((mockApp.replayManager as any).replayLastDrawnIndex).toBe(1);
    });
  });

  describe("toggleAirports", () => {
    it("hides airports when visible", () => {
      mockApp.airportsVisible = true;

      uiToggles.toggleAirports();

      expect(mockApp.map!.removeLayer).toHaveBeenCalledWith(
        mockApp.airportLayer
      );
      expect(mockApp.airportsVisible).toBe(false);
      expect(mockDomElements["airports-btn"].style.opacity).toBe("0.5");
      expect(mockApp.stateManager!.saveMapState).toHaveBeenCalled();
    });

    it("shows airports when hidden", () => {
      mockApp.airportsVisible = false;

      uiToggles.toggleAirports();

      expect(mockApp.map!.addLayer).toHaveBeenCalledWith(mockApp.airportLayer);
      expect(mockApp.airportsVisible).toBe(true);
      expect(mockDomElements["airports-btn"].style.opacity).toBe("1");
      expect(mockApp.stateManager!.saveMapState).toHaveBeenCalled();
    });

    it("returns early if no map", () => {
      mockApp.map = undefined;

      uiToggles.toggleAirports();

      expect(mockApp.stateManager!.saveMapState).not.toHaveBeenCalled();
    });
  });

  describe("toggleAviation", () => {
    it("shows aviation layer when hidden and API key is set", () => {
      (mockApp as any).config.openaipApiKey = "test-key";
      (mockApp as any).openaipLayers["Aviation Data"] = {};
      mockApp.aviationVisible = false;

      uiToggles.toggleAviation();

      expect(mockApp.map!.addLayer).toHaveBeenCalledWith(
        (mockApp as any).openaipLayers["Aviation Data"]
      );
      expect(mockApp.aviationVisible).toBe(true);
      expect(mockApp.stateManager!.saveMapState).toHaveBeenCalled();
    });

    it("hides aviation layer when visible", () => {
      (mockApp as any).config.openaipApiKey = "test-key";
      (mockApp as any).openaipLayers["Aviation Data"] = {};
      mockApp.aviationVisible = true;

      uiToggles.toggleAviation();

      expect(mockApp.map!.removeLayer).toHaveBeenCalledWith(
        (mockApp as any).openaipLayers["Aviation Data"]
      );
      expect(mockApp.aviationVisible).toBe(false);
      expect(mockApp.stateManager!.saveMapState).toHaveBeenCalled();
    });

    it("does nothing when no API key is set", () => {
      (mockApp as any).config.openaipApiKey = "";
      mockApp.aviationVisible = false;

      uiToggles.toggleAviation();

      expect(mockApp.map!.addLayer).not.toHaveBeenCalled();
      expect(mockApp.stateManager!.saveMapState).not.toHaveBeenCalled();
    });

    it("returns early if no map", () => {
      mockApp.map = undefined;

      uiToggles.toggleAviation();

      expect(mockApp.stateManager!.saveMapState).not.toHaveBeenCalled();
    });
  });

  describe("toggleButtonsVisibility", () => {
    let toggleableButtons: HTMLElement[];

    beforeEach(() => {
      toggleableButtons = [];
      for (let i = 0; i < 3; i++) {
        const btn = document.createElement("button");
        btn.classList.add("toggleable-btn");
        document.body.appendChild(btn);
        toggleableButtons.push(btn);
      }
    });

    it("hides buttons when visible", () => {
      mockApp.buttonsHidden = false;

      uiToggles.toggleButtonsVisibility();

      toggleableButtons.forEach((btn) => {
        expect(btn.classList.contains("buttons-hidden")).toBe(true);
      });
      expect(mockApp.buttonsHidden).toBe(true);
      expect(mockApp.stateManager!.saveMapState).toHaveBeenCalled();
    });

    it("shows buttons when hidden", () => {
      mockApp.buttonsHidden = true;
      toggleableButtons.forEach((btn) => btn.classList.add("buttons-hidden"));

      uiToggles.toggleButtonsVisibility();

      toggleableButtons.forEach((btn) => {
        expect(btn.classList.contains("buttons-hidden")).toBe(false);
      });
      expect(mockApp.buttonsHidden).toBe(false);
      expect(mockApp.stateManager!.saveMapState).toHaveBeenCalled();
    });

    it("redraws altitude paths when altitude is visible", () => {
      mockApp.buttonsHidden = false;
      mockApp.altitudeVisible = true;

      uiToggles.toggleButtonsVisibility();

      expect(mockApp.layerManager!.redrawAltitudePaths).toHaveBeenCalled();
    });

    it("redraws airspeed paths when airspeed is visible", () => {
      mockApp.buttonsHidden = false;
      mockApp.airspeedVisible = true;

      uiToggles.toggleButtonsVisibility();

      expect(mockApp.layerManager!.redrawAirspeedPaths).toHaveBeenCalled();
    });

    it("does not redraw paths when neither altitude nor airspeed is visible", () => {
      mockApp.buttonsHidden = false;
      mockApp.altitudeVisible = false;
      mockApp.airspeedVisible = false;

      uiToggles.toggleButtonsVisibility();

      expect(mockApp.layerManager!.redrawAltitudePaths).not.toHaveBeenCalled();
      expect(mockApp.layerManager!.redrawAirspeedPaths).not.toHaveBeenCalled();
    });
  });

  describe("exportMap", () => {
    it("disables button and sets exporting text", () => {
      const btn = mockDomElements["export-btn"] as HTMLButtonElement;

      uiToggles.exportMap();

      expect(btn.disabled).toBe(true);
      expect(btn.textContent).toContain("Exporting...");
    });

    it("returns early if export button is not found", () => {
      // Remove the export-btn from mock
      const original = mockDomElements["export-btn"];
      delete mockDomElements["export-btn"];

      // Should not throw
      expect(() => uiToggles.exportMap()).not.toThrow();

      // Restore
      mockDomElements["export-btn"] = original;
    });

    it("returns early if map container is not found", () => {
      const originalMap = mockDomElements["map"];
      delete mockDomElements["map"];

      const btn = mockDomElements["export-btn"] as HTMLButtonElement;
      uiToggles.exportMap();

      // Button is set to disabled but nothing else happens
      expect(btn.disabled).toBe(true);

      mockDomElements["map"] = originalMap;
    });

    it("hides controls, calls domtoimage.toJpeg and downloads on success", async () => {
      vi.useFakeTimers();
      const btn = mockDomElements["export-btn"] as HTMLButtonElement;
      const mockLink = { download: "", href: "", click: vi.fn() };
      vi.spyOn(document, "createElement").mockReturnValue(mockLink as any);

      const toJpegMock = vi
        .fn()
        .mockResolvedValue("data:image/jpeg;base64,abc");
      window.domtoimage = { toJpeg: toJpegMock } as any;

      uiToggles.exportMap();

      // Advance past the setTimeout(200ms)
      vi.advanceTimersByTime(200);
      await vi.runAllTimersAsync();

      expect(toJpegMock).toHaveBeenCalled();
      expect(btn.disabled).toBe(false);
      expect(btn.textContent).toContain("Export");
      expect(mockLink.click).toHaveBeenCalled();
      expect(mockLink.download).toContain("heatmap_");

      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it("restores controls and shows alert on domtoimage failure", async () => {
      vi.useFakeTimers();
      const btn = mockDomElements["export-btn"] as HTMLButtonElement;
      const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});

      const toJpegMock = vi.fn().mockRejectedValue(new Error("Export failed"));
      window.domtoimage = { toJpeg: toJpegMock } as any;

      uiToggles.exportMap();

      vi.advanceTimersByTime(200);
      await vi.runAllTimersAsync();

      expect(alertSpy).toHaveBeenCalledWith(
        expect.stringContaining("Export failed")
      );
      expect(btn.disabled).toBe(false);
      expect(btn.textContent).toContain("Export");

      vi.useRealTimers();
      vi.restoreAllMocks();
    });
  });
});
