import { describe, it, expect, beforeEach, vi } from "vitest";
import { WrappedManager } from "../../../../kml_heatmap/frontend/ui/wrappedManager";
import type { MockMapApp } from "../../testHelpers";
import type { FilteredStatistics } from "../../../../kml_heatmap/frontend/types";

// Mock DOMPurify
vi.mock("dompurify", () => ({
  default: {
    sanitize: (html: string) => html,
  },
}));

// Mock domCache
vi.mock("../../../../kml_heatmap/frontend/utils/domCache", () => ({
  domCache: {
    cacheElements: vi.fn(),
    get: vi.fn((id: string) => {
      return document.getElementById(id);
    }),
  },
}));

// Mock window.KMLHeatmap
(global as any).window = {
  KMLHeatmap: {
    calculateYearStats: vi.fn(() => ({
      total_flights: 10,
      num_airports: 5,
      total_distance_nm: 1000,
      flight_time: "10:00",
      aircraft_list: [],
      airport_names: [],
    })),
    generateFunFacts: vi.fn(() => []),
  },
};

describe("WrappedManager", () => {
  let wrappedManager: WrappedManager;
  let mockApp: MockMapApp;
  let mockStatsEl: HTMLElement;

  beforeEach(() => {
    // Setup DOM elements
    document.body.innerHTML = `
      <div id="wrapped-title"></div>
      <div id="wrapped-year"></div>
      <div id="wrapped-stats"></div>
      <div id="wrapped-fun-facts"></div>
      <div id="wrapped-aircraft-fleet"></div>
      <div id="wrapped-top-airports"></div>
      <div id="wrapped-airports-grid"></div>
      <div id="wrapped-modal"></div>
      <div id="map"></div>
      <div id="wrapped-map-container"></div>
    `;

    mockStatsEl = document.getElementById("wrapped-stats")!;

    // Create mock app
    mockApp = {
      selectedYear: "2024",
      selectedAircraft: "all",
      selectedPathIds: new Set<number>(),
      fullPathInfo: [],
      fullPathSegments: [],
      fullStats: null,
      map: {
        fitBounds: vi.fn(),
        invalidateSize: vi.fn(),
      } as any,
      config: {
        bounds: [
          [50, 8],
          [52, 10],
        ] as [[number, number], [number, number]],
        center: [51, 9] as [number, number],
        dataDir: "/data",
      },
      stateManager: {
        saveMapState: vi.fn(),
      },
    } as MockMapApp;

    wrappedManager = new WrappedManager(mockApp as any);
  });

  describe("showWrapped - timing data conditional rendering", () => {
    it("includes flight time and max groundspeed stats when timing data is available", () => {
      mockApp.fullStats = {
        max_groundspeed_knots: 150,
        max_altitude_m: 3000,
      } as FilteredStatistics;

      wrappedManager.showWrapped();

      const statsHtml = mockStatsEl.innerHTML;
      expect(statsHtml).toContain("Flight Time");
      expect(statsHtml).toContain("Max Groundspeed");
      expect(statsHtml).toContain("150 kt");
    });

    it("excludes flight time and max groundspeed stats when max_groundspeed_knots is 0", () => {
      mockApp.fullStats = {
        max_groundspeed_knots: 0,
        max_altitude_m: 3000,
      } as FilteredStatistics;

      wrappedManager.showWrapped();

      const statsHtml = mockStatsEl.innerHTML;
      expect(statsHtml).not.toContain("Flight Time");
      expect(statsHtml).not.toContain("Max Groundspeed");
    });

    it("excludes flight time and max groundspeed stats when max_groundspeed_knots is undefined", () => {
      mockApp.fullStats = {
        max_altitude_m: 3000,
      } as FilteredStatistics;

      wrappedManager.showWrapped();

      const statsHtml = mockStatsEl.innerHTML;
      expect(statsHtml).not.toContain("Flight Time");
      expect(statsHtml).not.toContain("Max Groundspeed");
    });

    it("excludes flight time and max groundspeed stats when fullStats is null", () => {
      mockApp.fullStats = null;

      wrappedManager.showWrapped();

      const statsHtml = mockStatsEl.innerHTML;
      expect(statsHtml).not.toContain("Flight Time");
      expect(statsHtml).not.toContain("Max Groundspeed");
    });

    it("always includes max altitude regardless of timing data", () => {
      mockApp.fullStats = {
        max_groundspeed_knots: 0,
        max_altitude_m: 3048, // 10000 ft
      } as FilteredStatistics;

      wrappedManager.showWrapped();

      const statsHtml = mockStatsEl.innerHTML;
      expect(statsHtml).toContain("Max Altitude");
      expect(statsHtml).toContain("10000 ft");
    });

    it("always includes flights, airports, and distance stats", () => {
      mockApp.fullStats = {
        max_groundspeed_knots: 0,
      } as FilteredStatistics;

      wrappedManager.showWrapped();

      const statsHtml = mockStatsEl.innerHTML;
      expect(statsHtml).toContain("Flights");
      expect(statsHtml).toContain("Airports");
      expect(statsHtml).toContain("Nautical Miles");
    });
  });

  describe("showWrapped - year display", () => {
    it('displays "All Years" when year is "all"', () => {
      mockApp.selectedYear = "all";
      mockApp.fullStats = {
        max_groundspeed_knots: 150,
      } as FilteredStatistics;

      wrappedManager.showWrapped();

      const titleEl = document.getElementById("wrapped-title");
      const yearEl = document.getElementById("wrapped-year");

      expect(titleEl?.textContent).toBe("✨ Your Flight History");
      expect(yearEl?.textContent).toBe("All Years");
    });

    it('displays specific year when year is not "all"', () => {
      mockApp.selectedYear = "2024";
      mockApp.fullStats = {
        max_groundspeed_knots: 150,
      } as FilteredStatistics;

      wrappedManager.showWrapped();

      const titleEl = document.getElementById("wrapped-title");
      const yearEl = document.getElementById("wrapped-year");

      expect(titleEl?.textContent).toBe("✨ Your Year in Flight");
      expect(yearEl?.textContent).toBe("2024");
    });
  });
});
