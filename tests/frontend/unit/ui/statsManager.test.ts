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

/** Value of the lead figure with the given label */
function leadValue(panel: HTMLElement, label: string): string | null {
  for (const item of panel.querySelectorAll(".kh-stats-lead-item")) {
    const itemLabel = item.querySelector(".kh-stats-lead-label")?.textContent;
    if (itemLabel === label) {
      return item.querySelector(".kh-stats-lead-value")!.textContent.trim();
    }
  }
  return null;
}

/** Text of the metric row with the given label, as "label value alt" */
function metricRow(panel: HTMLElement, label: string): string | null {
  for (const row of panel.querySelectorAll(".kh-stats-metric")) {
    const rowLabel = row.querySelector(".kh-stats-metric-label")?.textContent;
    if (rowLabel === label) {
      const value = row.querySelector(".kh-stats-metric-value")?.textContent;
      const alt = row.querySelector(".kh-stats-metric-alt")?.textContent;
      return alt ? `${value} (${alt})` : `${value}`;
    }
  }
  return null;
}

describe("StatsManager", () => {
  let statsManager: StatsManager;
  let mockApp: MockApp;
  let statsPanel: HTMLElement;

  beforeEach(() => {
    // features/airports caches the country map on its first lookup, so every
    // test needs the airport data before the first render happens
    window.KML_AIRPORTS = {
      airports: [
        { name: "EDAQ Halle-Oppin", lat: 51.55, lon: 12.05, country: "DE" },
        { name: "EDDM Munich", lat: 48.35, lon: 11.79, country: "DE" },
        { name: "LOWW Vienna", lat: 48.11, lon: 16.57, country: "AT" },
        { name: "EDDF", lat: 50.03, lon: 8.57, country: "DE" },
        { name: "EDDM", lat: 48.35, lon: 11.79, country: "DE" },
        { name: "EDDK", lat: 50.87, lon: 7.14, country: "DE" },
      ],
    };

    const railTitle = document.createElement("h2");
    railTitle.id = "stats-rail-title";
    railTitle.innerHTML =
      '<span class="kh-stats-title-text">Flight Statistics</span>';
    document.body.appendChild(railTitle);

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
    document.getElementById("stats-rail-title")?.remove();
    statsPanel.remove();
    vi.useRealTimers();
  });

  describe("updateStatsForSelection", () => {
    it("shows filtered statistics for all paths when nothing is selected", () => {
      mockApp.selectedYear = "2025";

      statsManager.updateStatsForSelection();

      expect(
        document.getElementById("stats-rail-title")!.textContent,
      ).toContain("Flight Statistics");
      expect(leadValue(statsPanel, "Flights")).toBe("1");
      expect(statsPanel.textContent).toContain("3 data points");
      expect(statsPanel.textContent).toContain("EDDF");
      expect(statsPanel.textContent).not.toContain("EDDK");
      expect(leadValue(statsPanel, "Total Flight Time")).toBe("0h 10m");
    });

    it("shows statistics for the selected paths only", () => {
      mockApp.selectedPathIds.add(2);

      statsManager.updateStatsForSelection();

      expect(
        document.getElementById("stats-rail-title")!.textContent,
      ).toContain("Selected Paths Statistics");
      expect(statsPanel.textContent).toContain(
        "Showing stats for 1 selected path",
      );
      // unique coordinates of the selected segments
      expect(statsPanel.textContent).toContain("2 data points");
      expect(statsPanel.textContent).toContain("EDDK");
      expect(statsPanel.textContent).not.toContain("EDDF");
    });

    it("ignores year/aircraft filters for a selection", () => {
      mockApp.selectedYear = "2025";
      mockApp.selectedPathIds.add(2); // path 2 is from 2024

      statsManager.updateStatsForSelection();

      expect(leadValue(statsPanel, "Flights")).toBe("1");
      expect(statsPanel.textContent).toContain("D-EFGH");
    });

    it("renders an empty selection instead of the previous flight", () => {
      statsPanel.innerHTML = "before";
      mockApp.selectedPathIds.add(999);

      statsManager.updateStatsForSelection();

      expect(statsPanel.innerHTML).not.toBe("before");
      expect(statsPanel.textContent).toContain("0 selected paths");
      expect(leadValue(statsPanel, "Flights")).toBe("0");
    });

    it("does not rewrite the panel when the markup is unchanged", () => {
      statsManager.updateStatsForSelection();
      const first = statsPanel.firstElementChild;

      statsManager.updateStatsForSelection();

      // Same nodes, so focus and scroll position inside the panel survive
      expect(statsPanel.firstElementChild).toBe(first);
    });

    it("handles missing data", () => {
      mockApp.currentData = null;

      statsManager.updateStatsForSelection();

      expect(leadValue(statsPanel, "Flights")).toBe("0");
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

      expect(
        document.getElementById("stats-rail-title")!.textContent,
      ).toContain("Flight Statistics");
      const sections = [
        ...statsPanel.querySelectorAll("h3.kh-stats-section-title"),
      ].map((el) => el.querySelector(".kh-stats-section-label")!.textContent);
      expect(sections).toEqual([
        "Distance",
        "Speed",
        "Altitude",
        "Aircraft",
        "Airports",
      ]);
      // Section titles are real headings, lists are real lists
      expect(statsPanel.querySelector('[role="list"]')).toBeNull();
      expect(statsPanel.querySelector('[role="listitem"]')).toBeNull();
      expect(statsPanel.querySelectorAll("ul.kh-stats-list > li").length).toBe(
        statsPanel.querySelectorAll("ul.kh-stats-list li").length,
      );
      // Every rule lives in the stylesheet, none of it inline
      expect(statsPanel.querySelector("[style]")).toBeNull();
      // Icons carry no accessible name of their own
      expect(statsPanel.querySelectorAll("svg.icon").length).toBeGreaterThan(0);
      for (const svg of statsPanel.querySelectorAll("svg.icon")) {
        expect(svg.getAttribute("aria-hidden")).toBe("true");
      }
    });

    it("leads with distance, flight time, flights and airports", () => {
      statsManager.updateStatsPanel(mockStats, false);

      const labels = [
        ...statsPanel.querySelectorAll(".kh-stats-lead-label"),
      ].map((el) => el.textContent);
      expect(labels).toEqual([
        "Distance",
        "Total Flight Time",
        "Flights",
        "Airports",
      ]);
      expect(leadValue(statsPanel, "Distance")).toBe("2700.0 nm");
      expect(leadValue(statsPanel, "Total Flight Time")).toBe("25h 30m");
      expect(leadValue(statsPanel, "Flights")).toBe("50");
      expect(leadValue(statsPanel, "Airports")).toBe("3");
      // The metric equivalent of the distance stays on the lead figure
      expect(statsPanel.querySelector(".kh-stats-lead-alt")!.textContent).toBe(
        "5000.4 km",
      );
    });

    it("keeps four lead figures without timing data", () => {
      statsManager.updateStatsPanel(
        { ...mockStats, total_flight_time_str: undefined },
        false,
      );

      // A missing figure still occupies its cell, so the grid stays full
      expect(statsPanel.querySelectorAll(".kh-stats-lead-item")).toHaveLength(
        4,
      );
      expect(leadValue(statsPanel, "Total Flight Time")).toBe("—");
      expect(leadValue(statsPanel, "Flights")).toBe("50");
    });

    it("renders the selection indicator", () => {
      statsManager.updateStatsPanel(mockStats, true);

      expect(
        document.getElementById("stats-rail-title")!.textContent,
      ).toContain("Selected Paths Statistics");
      expect(statsPanel.querySelector(".kh-stats-note")!.textContent).toBe(
        "Showing stats for 50 selected paths",
      );
    });

    it("pluralises the selection note and the data point count", () => {
      statsManager.updateStatsPanel(
        { ...mockStats, num_paths: 1, total_points: 1 },
        true,
      );

      expect(statsPanel.querySelector(".kh-stats-note")!.textContent).toBe(
        "Showing stats for 1 selected path",
      );
      expect(statsPanel.querySelector(".kh-stats-footer")!.textContent).toBe(
        "1 data point",
      );
    });

    it("renders all metrics with both unit systems", () => {
      statsManager.updateStatsPanel(mockStats, false);

      expect(metricRow(statsPanel, "Average Distance per Trip")).toBe(
        "54.0 nm (100.0 km)",
      );
      expect(metricRow(statsPanel, "Longest Flight")).toBe(
        "270.0 nm (500.0 km)",
      );
      expect(metricRow(statsPanel, "Average Groundspeed")).toBe(
        "120 kt (222 km/h)",
      );
      expect(metricRow(statsPanel, "Cruise Speed (>1000ft AGL)")).toBe(
        "125 kt (232 km/h)",
      );
      expect(metricRow(statsPanel, "Max Groundspeed")).toBe(
        "150 kt (278 km/h)",
      );
      expect(metricRow(statsPanel, "Max Altitude (MSL)")).toBe(
        "10000 ft (3048 m)",
      );
      expect(metricRow(statsPanel, "Elevation Gain")).toBe(
        "50000 ft (15240 m)",
      );
      expect(metricRow(statsPanel, "Most Common Cruise Altitude (AGL)")).toBe(
        "5500 ft (1676 m)",
      );
    });

    it("lists every aircraft with registration, type and flights", () => {
      statsManager.updateStatsPanel(mockStats, false);

      const aircraft = [...statsPanel.querySelectorAll(".kh-stats-aircraft")];
      expect(aircraft).toHaveLength(2);
      expect(aircraft[0]!.querySelector(".kh-stats-code")!.textContent).toBe(
        "D-ABCD",
      );
      expect(
        aircraft[0]!.querySelector(".kh-stats-aircraft-type")!.textContent,
      ).toBe("DA40");
      expect(
        aircraft[0]!.querySelector(".kh-stats-metric-value")!.textContent,
      ).toBe("30 flights");
      // Second aircraft carries no type
      expect(aircraft[1]!.querySelector(".kh-stats-aircraft-type")).toBeNull();
      expect(aircraft[1]!.querySelector(".kh-stats-code")!.textContent).toBe(
        "D-EFGH",
      );
    });

    it("shows a count beside the airports and aircraft headings", () => {
      // A visible number that nothing asserted: dropping the argument to
      // sectionTitle made it disappear with every suite still green
      statsManager.updateStatsPanel(mockStats, false);

      const counts = Array.from(
        statsPanel.querySelectorAll(".kh-stats-section-count"),
      ).map((el) => el.textContent);
      expect(counts).toContain(String(mockStats.num_airports));
      expect(counts).toContain(String(mockStats.aircraft_list.length));
    });

    it("moves the data point count into the footer", () => {
      statsManager.updateStatsPanel(mockStats, false);

      expect(statsPanel.querySelector(".kh-stats-footer")!.textContent).toBe(
        "10000 data points",
      );
      // And not also one of the lead figures. Match the label the lead grid
      // would render, not the pre-redesign "Data Points:" markup, which
      // nothing emits any more and so could never fail.
      const leadLabels = Array.from(
        statsPanel.querySelectorAll(".kh-stats-lead-label"),
      ).map((el) => el.textContent);
      expect(leadLabels).not.toContain("Data Points");
    });

    /** Statistics for the three airports the country fixture knows */
    const namedAirports: FilteredStatistics = {
      ...mockStats,
      airport_names: ["EDAQ Halle-Oppin", "EDDM Munich", "LOWW Vienna"],
      num_airports: 3,
    };

    it("summarizes the airports above the grouped list", () => {
      statsManager.updateStatsPanel(namedAirports, false);

      // The list is shown outright, not behind a disclosure
      expect(statsPanel.querySelector("details")).toBeNull();
      expect(
        statsPanel.querySelector(".kh-stats-airports-summary")!.textContent,
      ).toBe("3 airports in 2 countries");

      const groups = statsPanel.querySelector(".kh-stats-groups")!;
      expect(groups).not.toBeNull();

      // Every airport keeps its code and its full name
      const airports = [...groups.querySelectorAll(".kh-stats-airport")].map(
        (el) => el.textContent,
      );
      expect(airports).toHaveLength(3);
      expect(airports).toContain("EDAQHalle-Oppin");
      expect(airports).toContain("EDDMMunich");
      expect(airports).toContain("LOWWVienna");
    });

    it("summarizes a single airport without a country", () => {
      statsManager.updateStatsPanel(
        { ...mockStats, airport_names: ["ZZZZ Unknown"], num_airports: 1 },
        false,
      );

      expect(
        statsPanel.querySelector(".kh-stats-airports-summary")!.textContent,
      ).toBe("1 airport");
    });

    it("groups airports by country", () => {
      statsManager.updateStatsPanel(namedAirports, false);

      const groups = [...statsPanel.querySelectorAll(".kh-stats-group")].map(
        (group) => ({
          name: group.querySelector(".kh-stats-group-name")!.textContent,
          count: group.querySelector(".kh-stats-group-count")!.textContent,
          flag: group.querySelector(".kh-stats-group-flag")!.textContent,
        }),
      );
      expect(groups).toEqual([
        { name: "Germany", count: "2", flag: "\u{1F1E9}\u{1F1EA}" },
        { name: "Austria", count: "1", flag: "\u{1F1E6}\u{1F1F9}" },
      ]);

      // Each group lists its own airports
      const lists = statsPanel.querySelectorAll("ul.kh-stats-airport-list");
      expect(
        [...lists[0]!.querySelectorAll(".kh-stats-airport")].map(
          (el) => el.textContent,
        ),
      ).toEqual(["EDAQHalle-Oppin", "EDDMMunich"]);
      expect(
        [...lists[1]!.querySelectorAll(".kh-stats-airport")].map(
          (el) => el.textContent,
        ),
      ).toEqual(["LOWWVienna"]);
    });

    it("groups airports the country data does not know as Other", () => {
      statsManager.updateStatsPanel(
        {
          ...mockStats,
          airport_names: ["EDDM Munich", "ZZZZ Unknown"],
          num_airports: 2,
        },
        false,
      );

      const groups = [...statsPanel.querySelectorAll(".kh-stats-group")].map(
        (group) => group.querySelector(".kh-stats-group-name")!.textContent,
      );
      expect(groups).toEqual(["Germany", "Other"]);
      // Only one country is known, so the summary counts one
      expect(
        statsPanel.querySelector(".kh-stats-airports-summary")!.textContent,
      ).toBe("2 airports in 1 country");
    });

    it("keeps the airport list visible across re-renders", () => {
      statsManager.updateStatsPanel(namedAirports, false);
      const before = statsPanel.querySelectorAll(".kh-stats-airport").length;
      expect(before).toBe(3);

      // Selecting a path rebuilds the panel from scratch
      statsManager.updateStatsPanel(namedAirports, true);

      expect(statsPanel.querySelectorAll(".kh-stats-airport")).toHaveLength(3);
      expect(statsPanel.querySelector("details")).toBeNull();
    });

    it("escapes HTML in the lead figures", () => {
      statsManager.updateStatsPanel(
        { ...mockStats, total_flight_time_str: "<b>1h</b>" },
        false,
      );

      expect(leadValue(statsPanel, "Total Flight Time")).toBe("<b>1h</b>");
      expect(statsPanel.querySelector("b")).toBeNull();
      expect(statsPanel.innerHTML).toContain("&lt;b&gt;1h&lt;/b&gt;");
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
      expect(statsPanel.innerHTML).toContain("&lt;i&gt;");
      expect(statsPanel.innerHTML).toContain("&lt;u&gt;");
      expect(statsPanel.querySelector("b")).toBeNull();
      expect(statsPanel.querySelector("i")).toBeNull();
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
      const text = statsPanel.textContent;

      expect(leadValue(statsPanel, "Distance")).toBe("0.0 nm");
      // The four lead figures always stand, the sections below them do not
      expect(statsPanel.querySelectorAll(".kh-stats-lead-item")).toHaveLength(
        4,
      );
      expect(leadValue(statsPanel, "Total Flight Time")).toBe("—");
      expect(statsPanel.querySelectorAll(".kh-stats-section")).toHaveLength(0);
      expect(statsPanel.querySelector("details")).toBeNull();
      expect(text).not.toContain("Average Distance");
      expect(text).not.toContain("Longest Flight");
      expect(text).not.toContain("Groundspeed");
      expect(text).not.toContain("Max Altitude");
      expect(text).toContain("0 data points");
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
      mockApp.store.set("statsPanelVisible", true);

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
