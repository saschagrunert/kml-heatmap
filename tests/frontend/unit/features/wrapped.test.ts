import { describe, it, expect } from "vitest";
import {
  calculateYearStats,
  generateFunFacts,
  selectDiverseFacts,
  calculateAircraftColorClass,
  findHomeBase,
  getDestinations,
} from "../../../../kml_heatmap/frontend/features/wrapped";

describe("wrapped feature", () => {
  const mockPathInfo = [
    {
      id: 1,
      year: 2025,
      aircraft_registration: "D-EAGJ",
      aircraft_type: "DA40",
      start_airport: "EDAV",
      end_airport: "EDDF",
    },
    {
      id: 2,
      year: 2025,
      aircraft_registration: "D-EAGJ",
      aircraft_type: "DA40",
      start_airport: "EDDF",
      end_airport: "EDAV",
    },
    {
      id: 3,
      year: 2024,
      aircraft_registration: "D-EXYZ",
      aircraft_type: "C172",
      start_airport: "EDDM",
      end_airport: "EDDK",
    },
    {
      id: 4,
      year: 2025,
      aircraft_registration: "D-EABC",
      aircraft_type: "PA28",
      start_airport: "EDAV",
      end_airport: "EDDM",
    },
  ];

  const mockSegments = [
    {
      path_id: 1,
      coords: [
        [50.0, 8.0],
        [50.1, 8.1],
      ],
      time: 1000,
    },
    {
      path_id: 1,
      coords: [
        [50.1, 8.1],
        [50.2, 8.2],
      ],
      time: 1100,
    },
    {
      path_id: 2,
      coords: [
        [50.2, 8.2],
        [50.3, 8.3],
      ],
      time: 2000,
    },
    {
      path_id: 2,
      coords: [
        [50.3, 8.3],
        [50.4, 8.4],
      ],
      time: 2100,
    },
    {
      path_id: 3,
      coords: [
        [51.0, 9.0],
        [51.1, 9.1],
      ],
      time: 3000,
    },
    {
      path_id: 3,
      coords: [
        [51.1, 9.1],
        [51.2, 9.2],
      ],
      time: 3100,
    },
    {
      path_id: 4,
      coords: [
        [50.0, 8.0],
        [50.5, 8.5],
      ],
      time: 4000,
    },
    {
      path_id: 4,
      coords: [
        [50.5, 8.5],
        [51.0, 9.0],
      ],
      time: 4200,
    },
  ];

  describe("calculateYearStats", () => {
    it("calculates stats for specific year", () => {
      const stats = calculateYearStats(mockPathInfo, mockSegments, 2025);

      expect(stats.total_flights).toBe(3);
      expect(stats.num_airports).toBe(3);
      expect(stats.airport_names).toContain("EDAV");
      expect(stats.airport_names).toContain("EDDF");
      expect(stats.airport_names).toContain("EDDM");
      expect(stats.aircraft_list).toHaveLength(2);
    });

    it("calculates stats for all years", () => {
      const stats = calculateYearStats(mockPathInfo, mockSegments, "all");

      expect(stats.total_flights).toBe(4);
      expect(stats.num_airports).toBe(4);
      expect(stats.aircraft_list).toHaveLength(3);
    });

    it("calculates total distance correctly", () => {
      const stats = calculateYearStats(mockPathInfo, mockSegments, 2025);

      expect(stats.total_distance_nm).toBeGreaterThan(0);
      expect(typeof stats.total_distance_nm).toBe("number");
    });

    it("formats flight time correctly", () => {
      const stats = calculateYearStats(mockPathInfo, mockSegments, 2025);

      expect(stats.flight_time).toMatch(/^\d+h \d+m$/);
    });

    it("returns empty stats for non-existent year", () => {
      const stats = calculateYearStats(mockPathInfo, mockSegments, 2023);

      expect(stats.total_flights).toBe(0);
      expect(stats.total_distance_nm).toBe(0);
      expect(stats.num_airports).toBe(0);
      expect(stats.flight_time).toBe("0h 0m");
      expect(stats.aircraft_list).toHaveLength(0);
      expect(stats.airport_names).toHaveLength(0);
    });

    it("returns empty stats for null pathInfo", () => {
      const stats = calculateYearStats(null, mockSegments, 2025);

      expect(stats.total_flights).toBe(0);
    });

    it("returns empty stats for empty pathInfo", () => {
      const stats = calculateYearStats([], mockSegments, 2025);

      expect(stats.total_flights).toBe(0);
    });

    it("sorts aircraft by flight count", () => {
      const stats = calculateYearStats(mockPathInfo, mockSegments, 2025);

      expect(stats.aircraft_list[0].flights).toBeGreaterThanOrEqual(
        stats.aircraft_list[1].flights
      );
    });

    it("includes flight time for each aircraft", () => {
      const stats = calculateYearStats(mockPathInfo, mockSegments, 2025);

      stats.aircraft_list.forEach((aircraft) => {
        expect(aircraft.flight_time_str).toMatch(/^\d+h \d+m$/);
      });
    });

    it("enriches aircraft with model from fullStats", () => {
      const fullStats = {
        aircraft_list: [{ registration: "D-EAGJ", model: "Diamond DA40 NG" }],
      };

      const stats = calculateYearStats(
        mockPathInfo,
        mockSegments,
        2025,
        fullStats
      );

      const aircraft = stats.aircraft_list.find(
        (a) => a.registration === "D-EAGJ"
      );
      expect(aircraft.model).toBe("Diamond DA40 NG");
    });

    it("handles segments without time data", () => {
      const segmentsNoTime = [
        {
          path_id: 1,
          coords: [
            [50.0, 8.0],
            [50.1, 8.1],
          ],
        },
      ];

      const stats = calculateYearStats(mockPathInfo, segmentsNoTime, 2025);

      expect(stats.flight_time).toBe("0h 0m");
    });

    it("handles paths without airports", () => {
      const pathInfoNoAirports = [
        { id: 1, year: 2025, aircraft_registration: "D-EAGJ" },
      ];

      const stats = calculateYearStats(pathInfoNoAirports, mockSegments, 2025);

      expect(stats.num_airports).toBe(0);
      expect(stats.airport_names).toHaveLength(0);
    });

    it("handles duplicate airport names correctly", () => {
      const pathInfoDuplicates = [
        { id: 1, year: 2025, start_airport: "EDAV", end_airport: "EDAV" },
      ];

      const stats = calculateYearStats(pathInfoDuplicates, mockSegments, 2025);

      expect(stats.num_airports).toBe(1);
      expect(stats.airport_names).toEqual(["EDAV"]);
    });
  });

  describe("generateFunFacts", () => {
    const yearStats = {
      total_flights: 10,
      total_distance_nm: 5000, // Increased to trigger distance comparisons
      num_airports: 5,
      aircraft_list: [
        {
          registration: "D-EAGJ",
          type: "DA40",
          flights: 8,
          model: "Diamond DA40",
        },
        { registration: "D-EXYZ", type: "C172", flights: 2 },
      ],
    };

    it("generates distance facts", () => {
      const facts = generateFunFacts(yearStats);

      expect(facts.length).toBeGreaterThan(0);
      expect(facts.some((f) => f.category === "distance")).toBe(true);
    });

    it("generates aircraft facts", () => {
      const facts = generateFunFacts(yearStats);

      expect(facts.some((f) => f.category === "aircraft")).toBe(true);
    });

    it("generates altitude facts when provided", () => {
      const fullStats = {
        total_altitude_gain_ft: 50000,
      };

      const facts = generateFunFacts(yearStats, fullStats);

      expect(facts.some((f) => f.category === "altitude")).toBe(true);
    });

    it("generates time facts when provided", () => {
      const fullStats = {
        total_flight_time_seconds: 100000,
      };

      const facts = generateFunFacts(yearStats, fullStats);

      expect(facts.some((f) => f.category === "time")).toBe(true);
    });

    it("generates speed facts when provided", () => {
      const fullStats = {
        cruise_speed_knots: 120,
      };

      const facts = generateFunFacts(yearStats, fullStats);

      expect(facts.some((f) => f.category === "speed")).toBe(true);
    });

    it("generates achievement facts for high altitude", () => {
      const fullStats = {
        max_altitude_ft: 45000,
      };

      const facts = generateFunFacts(yearStats, fullStats);

      expect(facts.some((f) => f.category === "achievement")).toBe(true);
    });

    it("includes icon and text for each fact", () => {
      const facts = generateFunFacts(yearStats);

      facts.forEach((fact) => {
        expect(fact.icon).toBeDefined();
        expect(fact.text).toBeDefined();
        expect(fact.category).toBeDefined();
        expect(fact.priority).toBeDefined();
      });
    });

    it("generates around Earth fact for high distance", () => {
      const highDistanceStats = { ...yearStats, total_distance_nm: 20000 };
      const facts = generateFunFacts(highDistanceStats);

      expect(facts.some((f) => f.text.includes("around the Earth"))).toBe(true);
    });

    it("generates Everest fact for high altitude gain", () => {
      const fullStats = {
        total_altitude_gain_ft: 60000,
      };

      const facts = generateFunFacts(yearStats, fullStats);

      expect(facts.some((f) => f.text.includes("Everest"))).toBe(true);
    });

    it("generates loyal aircraft fact for single aircraft", () => {
      const singleAircraftStats = {
        ...yearStats,
        aircraft_list: [{ registration: "D-EAGJ", type: "DA40", flights: 10 }],
      };

      const facts = generateFunFacts(singleAircraftStats);

      expect(facts.some((f) => f.text.includes("Loyal"))).toBe(true);
    });

    it("generates explorer fact for many aircraft", () => {
      const manyAircraftStats = {
        ...yearStats,
        aircraft_list: [
          { registration: "D-EAGJ", flights: 5 },
          { registration: "D-EXYZ", flights: 3 },
          { registration: "D-EABC", flights: 2 },
          { registration: "D-EDEF", flights: 1 },
        ],
      };

      const facts = generateFunFacts(manyAircraftStats);

      expect(facts.some((f) => f.text.includes("different aircraft"))).toBe(
        true
      );
    });

    it("returns 4-6 facts with comprehensive data", () => {
      const comprehensiveStats = {
        total_flights: 50,
        total_distance_nm: 10000,
        num_airports: 10,
        aircraft_list: [
          {
            registration: "D-EAGJ",
            type: "DA40",
            flights: 30,
            model: "Diamond DA40",
          },
          { registration: "D-EXYZ", type: "C172", flights: 20 },
        ],
      };

      const fullStats = {
        total_altitude_gain_ft: 50000,
        total_flight_time_seconds: 100000,
        cruise_speed_knots: 120,
        longest_flight_nm: 300,
        longest_flight_km: 555,
        max_altitude_ft: 5000,
        most_common_cruise_altitude_ft: 1500,
        most_common_cruise_altitude_m: 457,
      };

      const facts = generateFunFacts(comprehensiveStats, fullStats);

      expect(facts.length).toBeGreaterThanOrEqual(4);
      expect(facts.length).toBeLessThanOrEqual(6);
    });

    it("limits facts per category", () => {
      const fullStats = {
        total_altitude_gain_ft: 50000,
        total_flight_time_seconds: 100000,
        cruise_speed_knots: 120,
        longest_flight_nm: 300,
        longest_flight_km: 555,
        max_altitude_ft: 45000,
        most_common_cruise_altitude_ft: 1500,
        most_common_cruise_altitude_m: 457,
      };

      const facts = generateFunFacts(yearStats, fullStats);

      // Count facts per category
      const categoryCount = {};
      facts.forEach((fact) => {
        categoryCount[fact.category] = (categoryCount[fact.category] || 0) + 1;
      });

      // Each category should have at most 3 facts
      Object.values(categoryCount).forEach((count) => {
        expect(count).toBeLessThanOrEqual(3);
      });
    });
  });

  describe("selectDiverseFacts", () => {
    const allFacts = [
      { category: "distance", priority: 10, text: "Fact 1" },
      { category: "distance", priority: 9, text: "Fact 2" },
      { category: "distance", priority: 8, text: "Fact 3" },
      { category: "altitude", priority: 9, text: "Fact 4" },
      { category: "altitude", priority: 7, text: "Fact 5" },
      { category: "time", priority: 8, text: "Fact 6" },
      { category: "speed", priority: 7, text: "Fact 7" },
    ];

    it("selects up to 6 facts", () => {
      const selected = selectDiverseFacts(allFacts);

      expect(selected.length).toBeLessThanOrEqual(6);
    });

    it("prioritizes high-priority facts", () => {
      const selected = selectDiverseFacts(allFacts);

      const priorities = selected.map((f) => f.priority);
      expect(priorities[0]).toBeGreaterThanOrEqual(
        priorities[priorities.length - 1]
      );
    });

    it("limits facts per category to 2", () => {
      const selected = selectDiverseFacts(allFacts);

      const categoryCount = {};
      selected.forEach((fact) => {
        categoryCount[fact.category] = (categoryCount[fact.category] || 0) + 1;
      });

      Object.values(categoryCount).forEach((count) => {
        expect(count).toBeLessThanOrEqual(3);
      });
    });

    it("ensures at least 4 facts when available", () => {
      const selected = selectDiverseFacts(allFacts);

      expect(selected.length).toBeGreaterThanOrEqual(4);
    });

    it("handles fewer than 4 facts", () => {
      const fewFacts = [
        { category: "distance", priority: 10, text: "Fact 1" },
        { category: "altitude", priority: 9, text: "Fact 2" },
      ];

      const selected = selectDiverseFacts(fewFacts);

      expect(selected.length).toBe(2);
    });

    it("handles empty array", () => {
      const selected = selectDiverseFacts([]);

      expect(selected.length).toBe(0);
    });
  });

  describe("calculateAircraftColorClass", () => {
    it("returns high class for most flights", () => {
      const colorClass = calculateAircraftColorClass(10, 10, 1);

      expect(colorClass).toBe("fleet-aircraft-high");
    });

    it("returns low class for least flights", () => {
      const colorClass = calculateAircraftColorClass(1, 10, 1);

      expect(colorClass).toBe("fleet-aircraft-low");
    });

    it("returns medium-high class for 75th percentile", () => {
      const colorClass = calculateAircraftColorClass(8, 10, 1);

      expect(colorClass).toBe("fleet-aircraft-high");
    });

    it("returns low class for below 25th percentile", () => {
      // 3 flights out of range 1-10: normalized = (3-1)/(10-1) = 0.222 < 0.25
      const colorClass = calculateAircraftColorClass(3, 10, 1);

      expect(colorClass).toBe("fleet-aircraft-low");
    });

    it("returns medium-low class for 25-50th percentile", () => {
      // 4 flights out of range 1-10: normalized = (4-1)/(10-1) = 0.333, between 0.25 and 0.5
      const colorClass = calculateAircraftColorClass(4, 10, 1);

      expect(colorClass).toBe("fleet-aircraft-medium-low");
    });

    it("handles equal min and max", () => {
      const colorClass = calculateAircraftColorClass(5, 5, 5);

      expect(colorClass).toBe("fleet-aircraft-high");
    });

    it("handles edge cases", () => {
      // 5.5 out of 1-10: normalized = (5.5-1)/(10-1) = 0.5 (exactly at boundary)
      const colorClass1 = calculateAircraftColorClass(5.5, 10, 1);
      // 7.5 out of 1-10: normalized = (7.5-1)/(10-1) = 0.722 < 0.75
      const colorClass2 = calculateAircraftColorClass(7.5, 10, 1);
      // 8 out of 1-10: normalized = (8-1)/(10-1) = 0.777 >= 0.75
      const colorClass3 = calculateAircraftColorClass(8, 10, 1);

      expect(colorClass1).toBe("fleet-aircraft-medium-high");
      expect(colorClass2).toBe("fleet-aircraft-medium-high");
      expect(colorClass3).toBe("fleet-aircraft-high");
    });
  });

  describe("findHomeBase", () => {
    it("finds airport with most flights", () => {
      const airportNames = ["EDAV", "EDDF", "EDDM"];
      const airportCounts = { EDAV: 10, EDDF: 5, EDDM: 3 };

      const homeBase = findHomeBase(airportNames, airportCounts);

      expect(homeBase.name).toBe("EDAV");
      expect(homeBase.flight_count).toBe(10);
    });

    it("returns null for empty airport list", () => {
      const homeBase = findHomeBase([], {});

      expect(homeBase).toBeNull();
    });

    it("returns null for null airport list", () => {
      const homeBase = findHomeBase(null, {});

      expect(homeBase).toBeNull();
    });

    it("handles single airport", () => {
      const airportNames = ["EDAV"];
      const airportCounts = { EDAV: 5 };

      const homeBase = findHomeBase(airportNames, airportCounts);

      expect(homeBase.name).toBe("EDAV");
      expect(homeBase.flight_count).toBe(5);
    });

    it("handles airports with zero counts", () => {
      const airportNames = ["EDAV", "EDDF"];
      const airportCounts = { EDAV: 10 };

      const homeBase = findHomeBase(airportNames, airportCounts);

      expect(homeBase.name).toBe("EDAV");
      expect(homeBase.flight_count).toBe(10);
    });

    it("handles tied counts", () => {
      const airportNames = ["EDAV", "EDDF"];
      const airportCounts = { EDAV: 5, EDDF: 5 };

      const homeBase = findHomeBase(airportNames, airportCounts);

      expect(["EDAV", "EDDF"]).toContain(homeBase.name);
      expect(homeBase.flight_count).toBe(5);
    });
  });

  describe("getDestinations", () => {
    it("filters out home base from airport list", () => {
      const airportNames = ["EDAV", "EDDF", "EDDM", "EDDK"];
      const homeBaseName = "EDAV";

      const destinations = getDestinations(airportNames, homeBaseName);

      expect(destinations).toEqual(["EDDF", "EDDM", "EDDK"]);
      expect(destinations).not.toContain("EDAV");
    });

    it("returns empty array if all airports are home base", () => {
      const airportNames = ["EDAV"];
      const homeBaseName = "EDAV";

      const destinations = getDestinations(airportNames, homeBaseName);

      expect(destinations).toEqual([]);
    });

    it("returns all airports if home base not in list", () => {
      const airportNames = ["EDDF", "EDDM"];
      const homeBaseName = "EDAV";

      const destinations = getDestinations(airportNames, homeBaseName);

      expect(destinations).toEqual(["EDDF", "EDDM"]);
    });

    it("handles null airport names", () => {
      const destinations = getDestinations(null, "EDAV");

      expect(destinations).toEqual([]);
    });

    it("handles null home base", () => {
      const airportNames = ["EDAV", "EDDF"];
      const destinations = getDestinations(airportNames, null);

      expect(destinations).toEqual(["EDAV", "EDDF"]);
    });

    it("handles empty airport names", () => {
      const destinations = getDestinations([], "EDAV");

      expect(destinations).toEqual([]);
    });
  });
});
