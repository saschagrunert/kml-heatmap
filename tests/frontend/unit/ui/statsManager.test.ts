import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { StatsManager } from "../../../../kml_heatmap/frontend/ui/statsManager";
import type { FilteredStatistics } from "../../../../kml_heatmap/frontend/types";
import {
  createMockApp,
  createDataset,
  createSegment,
  asMapApp,
  type MockApp,
} from "../../testHelpers";

describe("StatsManager", () => {
  let statsManager: StatsManager;
  let mockApp: MockApp;
  let statsPanel: HTMLElement;

  beforeEach(() => {
    statsPanel = document.createElement("div");
    statsPanel.id = "stats-panel";
    statsPanel.style.display = "none";
    document.body.appendChild(statsPanel);

    mockApp = createMockApp({
      currentData: createDataset(
        [
          {
            id: 1,
            year: 2025,
            aircraft_registration: "D-ABCD",
            start_airport: "EDDF",
            end_airport: "EDDM",
          },
          {
            id: 2,
            year: 2024,
            aircraft_registration: "D-EFGH",
            start_airport: "EDDM",
            end_airport: "EDDK",
          },
        ],
        [
          createSegment({ path_id: 1, altitude_ft: 3000, time: 0 }),
          createSegment({
            path_id: 1,
            altitude_ft: 4000,
            time: 600,
            coords: [
              [50.1, 8.1],
              [50.2, 8.2],
            ],
          }),
          createSegment({
            path_id: 2,
            altitude_ft: 2000,
            coords: [
              [51.0, 9.0],
              [51.1, 9.1],
            ],
          }),
        ],
        1234,
      ),
    });

    statsManager = new StatsManager(asMapApp(mockApp));
  });

  afterEach(() => {
    statsPanel.remove();
    vi.useRealTimers();
  });

  describe("updateStatsForSelection", () => {
    it("shows filtered statistics for all paths when nothing is selected", () => {
      mockApp.selectedYear = "2025";

      statsManager.updateStatsForSelection();

      expect(statsPanel.innerHTML).toContain("Flight Statistics");
      expect(statsPanel.innerHTML).toContain("<strong>Flights:</strong> 1");
      expect(statsPanel.innerHTML).toContain(
        "<strong>Data Points:</strong> 1234",
      );
      expect(statsPanel.innerHTML).toContain("EDDF");
      expect(statsPanel.innerHTML).not.toContain("EDDK");
      expect(statsPanel.innerHTML).toContain(
        "Total Flight Time:</strong> 0h 10m",
      );
    });

    it("shows statistics for the selected paths only", () => {
      mockApp.selectedPathIds.add(2);

      statsManager.updateStatsForSelection();

      expect(statsPanel.innerHTML).toContain("Selected Paths Statistics");
      expect(statsPanel.innerHTML).toContain(
        "Showing stats for 1 selected path(s)",
      );
      // unique coordinates of the selected segments
      expect(statsPanel.innerHTML).toContain("<strong>Data Points:</strong> 2");
      expect(statsPanel.innerHTML).toContain("EDDK");
      expect(statsPanel.innerHTML).not.toContain("EDDF");
    });

    it("ignores year/aircraft filters for a selection", () => {
      mockApp.selectedYear = "2025";
      mockApp.selectedPathIds.add(2); // path 2 is from 2024

      statsManager.updateStatsForSelection();

      expect(statsPanel.innerHTML).toContain("<strong>Flights:</strong> 1");
      expect(statsPanel.innerHTML).toContain("D-EFGH");
    });

    it("keeps the panel unchanged if the selected paths have no segments", () => {
      statsPanel.innerHTML = "before";
      mockApp.selectedPathIds.add(999);

      statsManager.updateStatsForSelection();

      expect(statsPanel.innerHTML).toBe("before");
    });

    it("handles missing data", () => {
      mockApp.currentData = null;

      statsManager.updateStatsForSelection();

      expect(statsPanel.innerHTML).toContain("<strong>Flights:</strong> 0");
    });
  });

  describe("updateStatsPanel", () => {
    const mockStats: FilteredStatistics = {
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
      avg_groundspeed_knots: 120,
      cruise_speed_knots: 125,
      max_groundspeed_knots: 150,
      longest_flight_km: 500,
      longest_flight_nm: 270,
      most_common_cruise_altitude_ft: 5500,
      most_common_cruise_altitude_m: 1676,
    };

    it("renders headings and sections with kh- classes", () => {
      statsManager.updateStatsPanel(mockStats, false);

      expect(statsPanel.querySelector("h2.kh-stats-title")!.textContent).toBe(
        "📊 Flight Statistics",
      );
      const subtitles = [
        ...statsPanel.querySelectorAll("h3.kh-stats-subtitle"),
      ].map((el) => el.textContent);
      expect(subtitles).toEqual(["Airports (3):", "Aircraft (2):"]);
      expect(statsPanel.querySelectorAll("ul.kh-stats-list li")).toHaveLength(
        5,
      );
      expect(statsPanel.querySelector("[style]")).toBeNull();
      expect(statsPanel.querySelector('[role="list"]')).toBeNull();
    });

    it("renders the selection indicator", () => {
      statsManager.updateStatsPanel(mockStats, true);

      expect(statsPanel.querySelector("h2.kh-stats-title")!.textContent).toBe(
        "📊 Selected Paths Statistics",
      );
      expect(statsPanel.querySelector(".kh-stats-note")!.textContent).toBe(
        "Showing stats for 50 selected path(s)",
      );
    });

    it("renders all metrics with unit conversions", () => {
      statsManager.updateStatsPanel(mockStats, false);
      const html = statsPanel.innerHTML;

      expect(html).toContain("<strong>Data Points:</strong> 10000");
      expect(html).toContain("<strong>Flights:</strong> 50");
      expect(html).toContain("<li>D-ABCD (DA40) - 30 flight(s)</li>");
      expect(html).toContain("<li>D-EFGH - 20 flight(s)</li>");
      expect(html).toContain("<strong>Total Flight Time:</strong> 25h 30m");
      expect(html).toContain(
        "<strong>Distance:</strong> 2700.0 nm (5000.4 km)",
      );
      expect(html).toContain(
        "<strong>Average Distance per Trip:</strong> 54.0 nm (100.0 km)",
      );
      expect(html).toContain(
        "<strong>Longest Flight:</strong> 270.0 nm (500.0 km)",
      );
      expect(html).toContain(
        "<strong>Average Groundspeed:</strong> 120 kt (222 km/h)",
      );
      expect(html).toContain(
        "<strong>Cruise Speed (&gt;1000ft AGL):</strong> 125 kt (232 km/h)",
      );
      expect(html).toContain(
        "<strong>Max Groundspeed:</strong> 150 kt (278 km/h)",
      );
      expect(html).toContain(
        "<strong>Max Altitude (MSL):</strong> 10000 ft (3048 m)",
      );
      expect(html).toContain(
        "<strong>Elevation Gain:</strong> 50000 ft (15240 m)",
      );
      expect(html).toContain(
        "<strong>Most Common Cruise Altitude (AGL):</strong> 5500 ft (1676 m)",
      );
    });

    it("groups airports by country", () => {
      window.KML_AIRPORTS = {
        airports: [
          { name: "EDDF", lat: 50, lon: 8, country: "DE" },
          { name: "LOWW", lat: 48, lon: 16, country: "AT" },
        ],
      };
      // features/airports caches the country map per module instance; the
      // "Other" group is always available for unknown airports
      statsManager.updateStatsPanel(mockStats, false);

      const groups = [...statsPanel.querySelectorAll(".kh-stats-group")];
      expect(groups.length).toBeGreaterThan(0);
      expect(statsPanel.innerHTML).toContain("<li>EDDF</li>");
    });

    it("escapes HTML in names", () => {
      statsManager.updateStatsPanel(
        {
          ...mockStats,
          airport_names: ["<b>X</b>"],
          num_airports: 1,
          aircraft_list: [{ registration: "<i>", type: "<u>", flights: 1 }],
          num_aircraft: 1,
        },
        false,
      );

      expect(statsPanel.innerHTML).toContain("&lt;b&gt;X&lt;/b&gt;");
      expect(statsPanel.innerHTML).toContain("&lt;i&gt; (&lt;u&gt;)");
      expect(statsPanel.querySelector("b")).toBeNull();
    });

    it("omits optional sections when fields are absent", () => {
      const minimal: FilteredStatistics = {
        total_points: 0,
        num_paths: 0,
        num_airports: 0,
        airport_names: [],
        num_aircraft: 0,
        aircraft_list: [],
        total_distance_km: 0,
        total_distance_nm: 0,
      };

      statsManager.updateStatsPanel(minimal, false);
      const html = statsPanel.innerHTML;

      expect(html).toContain("<strong>Distance:</strong> 0.0 nm (0.0 km)");
      expect(html).not.toContain("Airports (");
      expect(html).not.toContain("Aircraft (");
      expect(html).not.toContain("Average Distance");
      expect(html).not.toContain("Longest Flight");
      expect(html).not.toContain("Groundspeed");
      expect(html).not.toContain("Altitude");
      expect(html).not.toContain("Flight Time");
    });

    it("does nothing if the panel element is missing", () => {
      statsPanel.remove();
      expect(() =>
        statsManager.updateStatsPanel(mockStats, false),
      ).not.toThrow();
    });
  });

  describe("toggleStats", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it("shows the panel, updates the store and saves state", () => {
      statsManager.toggleStats();

      expect(statsPanel.style.display).toBe("block");
      expect(statsPanel.classList.contains("visible")).toBe(true);
      expect(mockApp.store.get("statsPanelVisible")).toBe(true);
      expect(mockApp.stateManager.saveMapState).toHaveBeenCalledTimes(1);
    });

    it("hides the panel after the transition and saves state", () => {
      statsPanel.style.display = "block";
      statsPanel.classList.add("visible");
      mockApp.store.set("statsPanelVisible", true);

      statsManager.toggleStats();

      expect(statsPanel.classList.contains("visible")).toBe(false);
      expect(mockApp.store.get("statsPanelVisible")).toBe(false);
      expect(statsPanel.style.display).toBe("block");
      expect(mockApp.stateManager.saveMapState).not.toHaveBeenCalled();

      vi.advanceTimersByTime(300);

      expect(statsPanel.style.display).toBe("none");
      expect(mockApp.stateManager.saveMapState).toHaveBeenCalledTimes(1);
    });

    it("cancels a pending hide when reopened quickly", () => {
      statsPanel.style.display = "block";
      statsPanel.classList.add("visible");

      statsManager.toggleStats(); // hide (timer pending)
      vi.advanceTimersByTime(100);
      statsManager.toggleStats(); // show again
      vi.advanceTimersByTime(300);

      expect(statsPanel.style.display).toBe("block");
      expect(statsPanel.classList.contains("visible")).toBe(true);
      expect(mockApp.store.get("statsPanelVisible")).toBe(true);
    });

    it("does nothing if panel doesn't exist", () => {
      statsPanel.remove();
      expect(() => statsManager.toggleStats()).not.toThrow();
      expect(mockApp.stateManager.saveMapState).not.toHaveBeenCalled();
    });

    it("triggers reflow when showing (for animation)", () => {
      const offsetHeightSpy = vi.spyOn(statsPanel, "offsetHeight", "get");

      statsManager.toggleStats();

      expect(offsetHeightSpy).toHaveBeenCalled();
    });
  });

  describe("setStatsPanelVisible", () => {
    it("can show without saving state (restore)", () => {
      statsManager.setStatsPanelVisible(true, false);

      expect(statsPanel.classList.contains("visible")).toBe(true);
      expect(mockApp.store.get("statsPanelVisible")).toBe(true);
      expect(mockApp.stateManager.saveMapState).not.toHaveBeenCalled();
    });
  });
});
