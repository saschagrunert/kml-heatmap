import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { LayerManager } from "../../../../kml_heatmap/frontend/ui/layerManager";
import type { MockMapApp } from "../../testHelpers";

// Mock domCache
vi.mock("../../../../kml_heatmap/frontend/utils/domCache", () => ({
  domCache: {
    cacheElements: vi.fn(),
    get: vi.fn((id: string) => {
      return document.getElementById(id);
    }),
  },
}));

// Mock logger
vi.mock("../../../../kml_heatmap/frontend/utils/logger", () => ({
  logDebug: vi.fn(),
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

describe("LayerManager", () => {
  let layerManager: LayerManager;
  let mockApp: MockMapApp;

  beforeEach(() => {
    // Mock window.KMLHeatmap
    window.KMLHeatmap = {
      getColorForAltitude: vi.fn(() => "#ff0000"),
      getColorForAirspeed: vi.fn(() => "#0000ff"),
    } as typeof window.KMLHeatmap;

    // Create DOM elements for legends
    const legendMin = document.createElement("span");
    legendMin.id = "legend-min";
    document.body.appendChild(legendMin);

    const legendMax = document.createElement("span");
    legendMax.id = "legend-max";
    document.body.appendChild(legendMax);

    const airspeedLegendMin = document.createElement("span");
    airspeedLegendMin.id = "airspeed-legend-min";
    document.body.appendChild(airspeedLegendMin);

    const airspeedLegendMax = document.createElement("span");
    airspeedLegendMax.id = "airspeed-legend-max";
    document.body.appendChild(airspeedLegendMax);

    // Create mock app
    mockApp = {
      selectedYear: "all",
      selectedAircraft: "all",
      selectedPathIds: new Set<number>(),
      fullPathInfo: [],
      currentData: {
        path_info: [{ id: 1, year: 2025, aircraft_registration: "D-ABCD" }],
        path_segments: [
          {
            path_id: 1,
            altitude_ft: 3000,
            altitude_m: 914,
            groundspeed_knots: 100,
            coords: [
              [48, 16],
              [49, 17],
            ],
          },
        ],
      },
      altitudeRange: { min: 0, max: 5000 },
      airspeedRange: { min: 0, max: 200 },
      altitudeLayer: { clearLayers: vi.fn() },
      airspeedLayer: { clearLayers: vi.fn() },
      altitudeRenderer: {},
      airspeedRenderer: {},
      pathSegments: {},
      buttonsHidden: false,
      airportManager: { updateAirportOpacity: vi.fn() },
      statsManager: { updateStatsForSelection: vi.fn() },
      pathSelection: { togglePathSelection: vi.fn() },
    } as MockMapApp;

    layerManager = new LayerManager(mockApp as any);
  });

  afterEach(() => {
    document.getElementById("legend-min")?.remove();
    document.getElementById("legend-max")?.remove();
    document.getElementById("airspeed-legend-min")?.remove();
    document.getElementById("airspeed-legend-max")?.remove();
  });

  describe("updateAltitudeLegend", () => {
    it("sets correct text with ft and m conversion", () => {
      layerManager.updateAltitudeLegend(1000, 5000);

      const minEl = document.getElementById("legend-min");
      const maxEl = document.getElementById("legend-max");

      expect(minEl!.textContent).toBe("1000 ft (305 m)");
      expect(maxEl!.textContent).toBe("5000 ft (1524 m)");
    });

    it("rounds values correctly", () => {
      layerManager.updateAltitudeLegend(1234.6, 5678.4);

      const minEl = document.getElementById("legend-min");
      const maxEl = document.getElementById("legend-max");

      expect(minEl!.textContent).toBe("1235 ft (376 m)");
      expect(maxEl!.textContent).toBe("5678 ft (1731 m)");
    });

    it("handles zero values", () => {
      layerManager.updateAltitudeLegend(0, 0);

      const minEl = document.getElementById("legend-min");
      const maxEl = document.getElementById("legend-max");

      expect(minEl!.textContent).toBe("0 ft (0 m)");
      expect(maxEl!.textContent).toBe("0 ft (0 m)");
    });
  });

  describe("updateAirspeedLegend", () => {
    it("sets correct text with knots and km/h conversion", () => {
      layerManager.updateAirspeedLegend(100, 200);

      const minEl = document.getElementById("airspeed-legend-min");
      const maxEl = document.getElementById("airspeed-legend-max");

      expect(minEl!.textContent).toBe("100 kt (185 km/h)");
      expect(maxEl!.textContent).toBe("200 kt (370 km/h)");
    });

    it("rounds values correctly", () => {
      layerManager.updateAirspeedLegend(123.4, 234.6);

      const minEl = document.getElementById("airspeed-legend-min");
      const maxEl = document.getElementById("airspeed-legend-max");

      expect(minEl!.textContent).toBe("123 kt (229 km/h)");
      expect(maxEl!.textContent).toBe("235 kt (434 km/h)");
    });

    it("handles zero values", () => {
      layerManager.updateAirspeedLegend(0, 0);

      const minEl = document.getElementById("airspeed-legend-min");
      const maxEl = document.getElementById("airspeed-legend-max");

      expect(minEl!.textContent).toBe("0 kt (0 km/h)");
      expect(maxEl!.textContent).toBe("0 kt (0 km/h)");
    });
  });

  describe("redrawAltitudePaths", () => {
    it("returns early if no currentData", () => {
      mockApp.currentData = null;

      layerManager.redrawAltitudePaths();

      expect(mockApp.altitudeLayer!.clearLayers).not.toHaveBeenCalled();
    });

    it("clears altitude layer", () => {
      layerManager.redrawAltitudePaths();

      expect(mockApp.altitudeLayer!.clearLayers).toHaveBeenCalled();
    });

    it("resets pathSegments", () => {
      mockApp.pathSegments = { 1: ["existing"] };

      layerManager.redrawAltitudePaths();

      // pathSegments is reset then rebuilt; it should not contain old data
      expect(mockApp.pathSegments).not.toEqual({ 1: ["existing"] });
    });

    it("uses full altitude range when no paths selected", () => {
      layerManager.redrawAltitudePaths();

      expect(window.KMLHeatmap.getColorForAltitude).toHaveBeenCalledWith(
        3000,
        0,
        5000
      );
    });

    it("uses selected paths altitude range when paths are selected", () => {
      mockApp.selectedPathIds.add(1);

      layerManager.redrawAltitudePaths();

      // With path 1 selected, altitude range should be derived from its segment (3000, 3000)
      expect(window.KMLHeatmap.getColorForAltitude).toHaveBeenCalledWith(
        3000,
        3000,
        3000
      );
    });

    it("filters segments by year", () => {
      mockApp.selectedYear = "2024";

      layerManager.redrawAltitudePaths();

      // Path info has year 2025, so filtering by 2024 should skip it
      expect(window.KMLHeatmap.getColorForAltitude).not.toHaveBeenCalled();
    });

    it("does not filter segments when year is 'all'", () => {
      mockApp.selectedYear = "all";

      layerManager.redrawAltitudePaths();

      expect(window.KMLHeatmap.getColorForAltitude).toHaveBeenCalled();
    });

    it("filters segments by aircraft", () => {
      mockApp.selectedAircraft = "D-EFGH";

      layerManager.redrawAltitudePaths();

      // Path info has aircraft D-ABCD, so filtering by D-EFGH should skip it
      expect(window.KMLHeatmap.getColorForAltitude).not.toHaveBeenCalled();
    });

    it("does not filter segments when aircraft is 'all'", () => {
      mockApp.selectedAircraft = "all";

      layerManager.redrawAltitudePaths();

      expect(window.KMLHeatmap.getColorForAltitude).toHaveBeenCalled();
    });

    it("calls updateAirportOpacity", () => {
      layerManager.redrawAltitudePaths();

      expect(mockApp.airportManager!.updateAirportOpacity).toHaveBeenCalled();
    });

    it("calls updateStatsForSelection", () => {
      layerManager.redrawAltitudePaths();

      expect(mockApp.statsManager!.updateStatsForSelection).toHaveBeenCalled();
    });

    it("updates altitude legend", () => {
      layerManager.redrawAltitudePaths();

      const minEl = document.getElementById("legend-min");
      const maxEl = document.getElementById("legend-max");

      // Full range: 0 to 5000
      expect(minEl!.textContent).toBe("0 ft (0 m)");
      expect(maxEl!.textContent).toBe("5000 ft (1524 m)");
    });

    it("stores path segments by path_id", () => {
      layerManager.redrawAltitudePaths();

      expect(mockApp.pathSegments![1]).toBeDefined();
      expect(mockApp.pathSegments![1].length).toBe(1);
    });
  });

  describe("redrawAirspeedPaths", () => {
    it("returns early if no currentData", () => {
      mockApp.currentData = null;

      layerManager.redrawAirspeedPaths();

      expect(mockApp.airspeedLayer!.clearLayers).not.toHaveBeenCalled();
    });

    it("clears airspeed layer", () => {
      layerManager.redrawAirspeedPaths();

      expect(mockApp.airspeedLayer!.clearLayers).toHaveBeenCalled();
    });

    it("uses full airspeed range when no paths selected", () => {
      layerManager.redrawAirspeedPaths();

      expect(window.KMLHeatmap.getColorForAirspeed).toHaveBeenCalledWith(
        100,
        0,
        200
      );
    });

    it("uses selected paths airspeed range when paths are selected", () => {
      mockApp.selectedPathIds.add(1);

      layerManager.redrawAirspeedPaths();

      // With path 1 selected (groundspeed_knots: 100), range should be (100, 100)
      expect(window.KMLHeatmap.getColorForAirspeed).toHaveBeenCalledWith(
        100,
        100,
        100
      );
    });

    it("filters segments by year", () => {
      mockApp.selectedYear = "2024";

      layerManager.redrawAirspeedPaths();

      // Path info has year 2025, so filtering by 2024 should skip it
      expect(window.KMLHeatmap.getColorForAirspeed).not.toHaveBeenCalled();
    });

    it("filters segments by aircraft", () => {
      mockApp.selectedAircraft = "D-EFGH";

      layerManager.redrawAirspeedPaths();

      // Path info has aircraft D-ABCD, so filtering by D-EFGH should skip it
      expect(window.KMLHeatmap.getColorForAirspeed).not.toHaveBeenCalled();
    });

    it("calls updateAirportOpacity", () => {
      layerManager.redrawAirspeedPaths();

      expect(mockApp.airportManager!.updateAirportOpacity).toHaveBeenCalled();
    });

    it("calls updateStatsForSelection", () => {
      layerManager.redrawAirspeedPaths();

      expect(mockApp.statsManager!.updateStatsForSelection).toHaveBeenCalled();
    });

    it("updates airspeed legend", () => {
      layerManager.redrawAirspeedPaths();

      const minEl = document.getElementById("airspeed-legend-min");
      const maxEl = document.getElementById("airspeed-legend-max");

      // Full range: 0 to 200
      expect(minEl!.textContent).toBe("0 kt (0 km/h)");
      expect(maxEl!.textContent).toBe("200 kt (370 km/h)");
    });

    it("skips segments with zero groundspeed", () => {
      mockApp.currentData!.path_segments = [
        {
          path_id: 1,
          altitude_ft: 3000,
          altitude_m: 914,
          groundspeed_knots: 0,
          coords: [
            [48, 16],
            [49, 17],
          ],
        },
      ];

      layerManager.redrawAirspeedPaths();

      expect(window.KMLHeatmap.getColorForAirspeed).not.toHaveBeenCalled();
    });
  });
});
