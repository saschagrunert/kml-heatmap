import type { MockMapApp } from "../../testHelpers";
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { StatsManager } from "../../../../kml_heatmap/frontend/ui/statsManager";

describe("StatsManager", () => {
  let statsManager: StatsManager;
  let mockApp: MockMapApp;
  let statsPanel: HTMLElement;

  beforeEach(() => {
    // Mock window.KMLHeatmap
    window.KMLHeatmap = {
      calculateFilteredStatistics: vi.fn(() => ({
        total_points: 10000,
        num_paths: 50,
        num_airports: 10,
        airport_names: ["EDDF", "EDDM", "EDDK"],
        num_aircraft: 2,
        aircraft_list: [
          { registration: "D-ABCD", type: "DA40", flights: 30 },
          { registration: "D-EFGH", type: "C172", flights: 20 },
        ],
        total_distance_km: 5000,
        total_distance_nm: 2700,
        total_flight_time_str: "25h 30m",
        max_altitude_ft: 10000,
        max_altitude_m: 3048,
        total_altitude_gain_ft: 50000,
        average_groundspeed_knots: 120,
        cruise_speed_knots: 125,
        max_groundspeed_knots: 150,
        longest_flight_km: 500,
        longest_flight_nm: 270,
        most_common_cruise_altitude_ft: 5500,
        most_common_cruise_altitude_m: 1676,
      })),
    };

    // Create stats panel element
    statsPanel = document.createElement("div");
    statsPanel.id = "stats-panel";
    statsPanel.style.display = "none";
    document.body.appendChild(statsPanel);

    // Create mock app
    mockApp = {
      selectedPathIds: new Set<number>(),
      fullPathInfo: [
        {
          id: 1,
          year: 2025,
          aircraft_registration: "D-ABCD",
        },
        {
          id: 2,
          year: 2025,
          aircraft_registration: "D-EFGH",
        },
      ],
      fullPathSegments: [
        {
          path_id: 1,
          coords: [
            [50.0, 8.0],
            [50.1, 8.1],
          ],
        },
        {
          path_id: 2,
          coords: [
            [50.1, 8.1],
            [50.2, 8.2],
          ],
        },
      ],
      selectedYear: "all",
      selectedAircraft: "all",
      stateManager: {
        saveMapState: vi.fn(),
      },
    };

    statsManager = new StatsManager(mockApp);
  });

  afterEach(() => {
    if (statsPanel && statsPanel.parentNode) {
      document.body.removeChild(statsPanel);
    }
  });

  describe("updateStatsForSelection", () => {
    it("calculates stats for all paths when no selection", () => {
      mockApp.selectedPathIds.clear();

      statsManager.updateStatsForSelection();

      expect(
        window.KMLHeatmap.calculateFilteredStatistics
      ).toHaveBeenCalledWith({
        pathInfo: mockApp.fullPathInfo,
        segments: mockApp.fullPathSegments,
        year: mockApp.selectedYear,
        aircraft: mockApp.selectedAircraft,
      });
    });

    it("calculates stats for selected paths only", () => {
      mockApp.selectedPathIds.add(1);

      statsManager.updateStatsForSelection();

      const calls = window.KMLHeatmap.calculateFilteredStatistics.mock.calls;
      expect(calls[0][0].pathInfo).toHaveLength(1);
      expect(calls[0][0].segments).toHaveLength(1);
      expect(calls[0][0].year).toBe("all"); // No year filter for selection
      expect(calls[0][0].aircraft).toBe("all"); // No aircraft filter for selection
    });

    it("filters pathInfo by selected IDs", () => {
      mockApp.selectedPathIds.add(2);

      statsManager.updateStatsForSelection();

      const calls = window.KMLHeatmap.calculateFilteredStatistics.mock.calls;
      expect(calls[0][0].pathInfo[0].id).toBe(2);
    });

    it("filters segments by selected path IDs", () => {
      mockApp.selectedPathIds.add(1);

      statsManager.updateStatsForSelection();

      const calls = window.KMLHeatmap.calculateFilteredStatistics.mock.calls;
      expect(calls[0][0].segments[0].path_id).toBe(1);
    });

    it("does nothing if selected segments are empty", () => {
      mockApp.selectedPathIds.add("nonexistent");
      mockApp.fullPathSegments = [];

      statsManager.updateStatsForSelection();

      // Stats panel should not be updated
      expect(statsPanel.innerHTML).toBe("");
    });

    it("handles empty fullPathInfo", () => {
      mockApp.fullPathInfo = null;
      mockApp.selectedPathIds.add(1);

      expect(() => statsManager.updateStatsForSelection()).not.toThrow();
    });

    it("handles empty fullPathSegments", () => {
      mockApp.fullPathSegments = null;
      mockApp.selectedPathIds.add(1);

      expect(() => statsManager.updateStatsForSelection()).not.toThrow();
    });
  });

  describe("updateStatsPanel", () => {
    const mockStats = {
      total_points: 10000,
      num_paths: 50,
      num_airports: 3,
      airport_names: ["EDDF", "EDDM", "EDDK"],
      num_aircraft: 2,
      aircraft_list: [
        { registration: "D-ABCD", type: "DA40", flights: 30 },
        { registration: "D-EFGH", flights: 20 }, // No type
      ],
      total_distance_km: 5000,
      total_distance_nm: 2700,
      total_flight_time_str: "25h 30m",
      max_altitude_ft: 10000,
      total_altitude_gain_ft: 50000,
      average_groundspeed_knots: 120,
      cruise_speed_knots: 125,
      max_groundspeed_knots: 150,
      longest_flight_km: 500,
      longest_flight_nm: 270,
      most_common_cruise_altitude_ft: 5500,
      most_common_cruise_altitude_m: 1676,
    };

    it("displays selection indicator when isSelection is true", () => {
      statsManager.updateStatsPanel(mockStats, true);

      expect(statsPanel.innerHTML).toContain("Selected Paths Statistics");
      expect(statsPanel.innerHTML).toContain("50 selected path(s)");
    });

    it("displays regular title when isSelection is false", () => {
      statsManager.updateStatsPanel(mockStats, false);

      expect(statsPanel.innerHTML).toContain("Flight Statistics");
      expect(statsPanel.innerHTML).not.toContain("Selected");
    });

    it("displays total data points", () => {
      statsManager.updateStatsPanel(mockStats, false);

      expect(statsPanel.innerHTML).toContain("Data Points:");
      expect(statsPanel.innerHTML).toContain("10000");
    });

    it("displays number of flights", () => {
      statsManager.updateStatsPanel(mockStats, false);

      expect(statsPanel.innerHTML).toContain("Flights:");
      expect(statsPanel.innerHTML).toContain("50");
    });

    it("displays airports list", () => {
      statsManager.updateStatsPanel(mockStats, false);

      expect(statsPanel.innerHTML).toContain("Airports (3)");
      expect(statsPanel.innerHTML).toContain("EDDF");
      expect(statsPanel.innerHTML).toContain("EDDM");
      expect(statsPanel.innerHTML).toContain("EDDK");
    });

    it("displays aircraft list with flight counts", () => {
      statsManager.updateStatsPanel(mockStats, false);

      expect(statsPanel.innerHTML).toContain("Aircrafts (2)");
      expect(statsPanel.innerHTML).toContain("D-ABCD");
      expect(statsPanel.innerHTML).toContain("DA40");
      expect(statsPanel.innerHTML).toContain("30 flight(s)");
      expect(statsPanel.innerHTML).toContain("D-EFGH");
      expect(statsPanel.innerHTML).toContain("20 flight(s)");
    });

    it("handles aircraft without type", () => {
      statsManager.updateStatsPanel(mockStats, false);

      // D-EFGH has no type, should still be displayed
      expect(statsPanel.innerHTML).toContain("D-EFGH");
    });

    it("displays total flight time", () => {
      statsManager.updateStatsPanel(mockStats, false);

      expect(statsPanel.innerHTML).toContain("Total Flight Time:");
      expect(statsPanel.innerHTML).toContain("25h 30m");
    });

    it("displays distance in nm and km", () => {
      statsManager.updateStatsPanel(mockStats, false);

      expect(statsPanel.innerHTML).toContain("Distance:");
      expect(statsPanel.innerHTML).toContain("2700.0 nm");
      expect(statsPanel.innerHTML).toContain("5000.4 km"); // 2700 * 1.852
    });

    it("displays average distance per trip", () => {
      statsManager.updateStatsPanel(mockStats, false);

      expect(statsPanel.innerHTML).toContain("Average Distance per Trip:");
      expect(statsPanel.innerHTML).toContain("54.0 nm"); // 2700 / 50
    });

    it("displays longest flight", () => {
      statsManager.updateStatsPanel(mockStats, false);

      expect(statsPanel.innerHTML).toContain("Longest Flight:");
      expect(statsPanel.innerHTML).toContain("270.0 nm");
      expect(statsPanel.innerHTML).toContain("500.0 km");
    });

    it("displays average groundspeed", () => {
      statsManager.updateStatsPanel(mockStats, false);

      expect(statsPanel.innerHTML).toContain("Average Groundspeed:");
      expect(statsPanel.innerHTML).toContain("120 kt");
      expect(statsPanel.innerHTML).toContain("222 km/h"); // 120 * 1.852
    });

    it("displays cruise speed", () => {
      statsManager.updateStatsPanel(mockStats, false);

      expect(statsPanel.innerHTML).toContain("Cruise Speed");
      expect(statsPanel.innerHTML).toContain("1000ft AGL");
      expect(statsPanel.innerHTML).toContain("125 kt");
      expect(statsPanel.innerHTML).toContain("232 km/h"); // 125 * 1.852
    });

    it("displays max groundspeed", () => {
      statsManager.updateStatsPanel(mockStats, false);

      expect(statsPanel.innerHTML).toContain("Max Groundspeed:");
      expect(statsPanel.innerHTML).toContain("150 kt");
      expect(statsPanel.innerHTML).toContain("278 km/h"); // 150 * 1.852
    });

    it("displays max altitude", () => {
      statsManager.updateStatsPanel(mockStats, false);

      expect(statsPanel.innerHTML).toContain("Max Altitude (MSL):");
      expect(statsPanel.innerHTML).toContain("10000 ft");
      expect(statsPanel.innerHTML).toContain("3048 m"); // 10000 * 0.3048
    });

    it("displays elevation gain", () => {
      statsManager.updateStatsPanel(mockStats, false);

      expect(statsPanel.innerHTML).toContain("Elevation Gain:");
      expect(statsPanel.innerHTML).toContain("50000 ft");
      expect(statsPanel.innerHTML).toContain("15240 m"); // 50000 * 0.3048
    });

    it("displays most common cruise altitude", () => {
      statsManager.updateStatsPanel(mockStats, false);

      expect(statsPanel.innerHTML).toContain("Most Common Cruise Altitude");
      expect(statsPanel.innerHTML).toContain("5500 ft");
      expect(statsPanel.innerHTML).toContain("1676 m");
    });

    it("handles missing optional fields gracefully", () => {
      const minimalStats = {
        total_points: 100,
        num_paths: 1,
        num_airports: 0,
        airport_names: [],
        num_aircraft: 0,
        aircraft_list: [],
        total_distance_nm: 50,
        total_distance_km: 92.6,
      };

      statsManager.updateStatsPanel(minimalStats, false);

      expect(statsPanel.innerHTML).toContain("Data Points:");
      expect(statsPanel.innerHTML).not.toContain("Total Flight Time:");
      expect(statsPanel.innerHTML).not.toContain("Max Altitude:");
    });

    it("does not display section if panel element doesn't exist", () => {
      const panel = document.getElementById("stats-panel");
      if (panel) document.body.removeChild(panel);

      expect(() =>
        statsManager.updateStatsPanel(mockStats, false)
      ).not.toThrow();
    });
  });

  describe("toggleStats", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("shows panel when hidden", () => {
      statsPanel.style.display = "none";
      statsPanel.classList.remove("visible");

      statsManager.toggleStats();

      expect(statsPanel.style.display).toBe("block");
      expect(statsPanel.classList.contains("visible")).toBe(true);
      expect(mockApp.stateManager.saveMapState).toHaveBeenCalled();
    });

    it("hides panel when visible", () => {
      statsPanel.style.display = "block";
      statsPanel.classList.add("visible");

      statsManager.toggleStats();

      expect(statsPanel.classList.contains("visible")).toBe(false);

      // Fast forward timers to complete animation
      vi.advanceTimersByTime(300);

      expect(statsPanel.style.display).toBe("none");
      expect(mockApp.stateManager.saveMapState).toHaveBeenCalled();
    });

    it("saves state after hiding completes", () => {
      statsPanel.style.display = "block";
      statsPanel.classList.add("visible");
      mockApp.stateManager.saveMapState.mockClear();

      statsManager.toggleStats();

      // State should not be saved immediately
      expect(mockApp.stateManager.saveMapState).not.toHaveBeenCalled();

      // Fast forward past animation
      vi.advanceTimersByTime(300);

      expect(mockApp.stateManager.saveMapState).toHaveBeenCalled();
    });

    it("does nothing if panel doesn't exist", () => {
      const panel = document.getElementById("stats-panel");
      if (panel) document.body.removeChild(panel);

      expect(() => statsManager.toggleStats()).not.toThrow();
    });

    it("triggers reflow when showing (for animation)", () => {
      statsPanel.style.display = "none";
      const offsetHeightSpy = vi.spyOn(statsPanel, "offsetHeight", "get");

      statsManager.toggleStats();

      expect(offsetHeightSpy).toHaveBeenCalled();
    });
  });
});
