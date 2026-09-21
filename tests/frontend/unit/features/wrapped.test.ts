import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cwd } from "node:process";
import {
  REFERENCE_DISTANCES,
  calculateYearStats,
  findClosestReferenceDistance,
  findFurthestAirport,
  generateFunFacts,
  segmentBounds,
  selectDiverseFacts,
} from "../../../../kml_heatmap/frontend/features/wrapped";
import * as airports from "../../../../kml_heatmap/frontend/features/airports";
import type {
  FunFact,
  PathInfo,
  PathSegment,
  YearStats,
} from "../../../../kml_heatmap/frontend/types";

describe("wrapped feature", () => {
  const mockPathInfo: PathInfo[] = [
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

  const mockSegments: PathSegment[] = [
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

    it("uses pre-filtered paths and segments when provided", () => {
      const preFiltered = {
        paths: [mockPathInfo[2]!],
        segments: mockSegments.filter((s) => s.path_id === 3),
      };

      const stats = calculateYearStats(
        mockPathInfo,
        mockSegments,
        2025,
        {},
        "all",
        preFiltered,
      );

      expect(stats.total_flights).toBe(1);
      expect(stats.aircraft_list[0]?.registration).toBe("D-EXYZ");
    });

    it("sorts aircraft by flight count", () => {
      const stats = calculateYearStats(mockPathInfo, mockSegments, 2025);

      expect(stats.aircraft_list[0]!.flights).toBeGreaterThanOrEqual(
        stats.aircraft_list[1]!.flights,
      );
    });

    it("includes flight time for each aircraft", () => {
      const stats = calculateYearStats(mockPathInfo, mockSegments, 2025);

      expect(stats.aircraft_list.length).toBeGreaterThan(0);
      stats.aircraft_list.forEach((aircraft) => {
        expect(aircraft.flight_time_str).toMatch(/^\d+h \d+m$/);
        expect(typeof aircraft.flight_time_seconds).toBe("number");
      });
    });

    it("enriches aircraft with the model names from the metadata", () => {
      const stats = calculateYearStats(mockPathInfo, mockSegments, 2025, {
        "D-EAGJ": "Diamond DA40 NG",
      });

      const aircraft = stats.aircraft_list.find(
        (a) => a.registration === "D-EAGJ",
      );
      expect(aircraft?.model).toBe("Diamond DA40 NG");
      // Aircraft that aircraft.json does not know keep their KML type
      for (const other of stats.aircraft_list) {
        if (other.registration !== "D-EAGJ") {
          expect(other.model).toBeUndefined();
        }
      }
    });

    it("never takes a model from the object prototype", () => {
      const pathInfo = [
        { id: 1, year: 2025, aircraft_registration: "toString" },
      ];
      const stats = calculateYearStats(pathInfo, [], 2025, {});

      expect(stats.aircraft_list[0]?.model).toBeUndefined();
    });

    it("filters by aircraft when aircraft parameter is provided", () => {
      const stats = calculateYearStats(
        mockPathInfo,
        mockSegments,
        "all",
        {},
        "D-EAGJ",
      );

      expect(stats.total_flights).toBe(2);
      expect(stats.aircraft_list).toHaveLength(1);
      expect(stats.aircraft_list[0]!.registration).toBe("D-EAGJ");
    });

    it("filters by both year and aircraft", () => {
      const stats = calculateYearStats(
        mockPathInfo,
        mockSegments,
        2025,
        {},
        "D-EAGJ",
      );

      expect(stats.total_flights).toBe(2);
      expect(stats.aircraft_list).toHaveLength(1);
    });

    it("returns empty stats when aircraft filter matches nothing", () => {
      const stats = calculateYearStats(
        mockPathInfo,
        mockSegments,
        2025,
        {},
        "D-NONE",
      );

      expect(stats.total_flights).toBe(0);
      expect(stats.aircraft_list).toHaveLength(0);
    });

    it("handles segments without time data", () => {
      const segmentsNoTime: PathSegment[] = [
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
      const pathInfoNoAirports: PathInfo[] = [
        { id: 1, year: 2025, aircraft_registration: "D-EAGJ" },
      ];

      const stats = calculateYearStats(pathInfoNoAirports, mockSegments, 2025);

      expect(stats.num_airports).toBe(0);
      expect(stats.airport_names).toHaveLength(0);
    });

    it("handles duplicate airport names correctly", () => {
      const pathInfoDuplicates: PathInfo[] = [
        { id: 1, year: 2025, start_airport: "EDAV", end_airport: "EDAV" },
      ];

      const stats = calculateYearStats(pathInfoDuplicates, mockSegments, 2025);

      expect(stats.num_airports).toBe(1);
      expect(stats.airport_names).toEqual(["EDAV"]);
    });
  });

  describe("findClosestReferenceDistance", () => {
    it("lists references in ascending order", () => {
      const distances = REFERENCE_DISTANCES.map((ref) => ref.nm);
      expect([...distances].sort((a, b) => a - b)).toEqual(distances);
    });

    it("returns the closest reference within tolerance", () => {
      expect(findClosestReferenceDistance(280)?.label).toBe("Berlin to Munich");
      expect(findClosestReferenceDistance(180)?.label).toBe("London to Paris");
      expect(findClosestReferenceDistance(3200)?.label).toBe(
        "London to New York",
      );
    });

    it("returns null when no reference is close enough", () => {
      expect(findClosestReferenceDistance(30)).toBeNull();
      expect(findClosestReferenceDistance(6000)).toBeNull();
    });

    it("returns null for zero or invalid distances", () => {
      expect(findClosestReferenceDistance(0)).toBeNull();
      expect(findClosestReferenceDistance(-5)).toBeNull();
      expect(findClosestReferenceDistance(Number.NaN)).toBeNull();
    });
  });

  describe("generateFunFacts", () => {
    const yearStats: YearStats = {
      total_flights: 10,
      total_distance_nm: 5000,
      num_airports: 5,
      flight_time: "50h 0m",
      airport_names: [],
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
      const facts = generateFunFacts(yearStats, {
        total_altitude_gain_ft: 50000,
      });

      expect(facts.some((f) => f.category === "altitude")).toBe(true);
    });

    it("generates time facts when provided", () => {
      const facts = generateFunFacts(yearStats, {
        total_flight_time_seconds: 100000,
      });

      const time = facts.find((f) => f.category === "time");
      expect(time?.text).toContain("27 hours");
    });

    it("gives a flight time under an hour in minutes", () => {
      const facts = generateFunFacts(yearStats, {
        total_flight_time_seconds: 45 * 60,
      });

      const time = facts.find((f) => f.category === "time");
      expect(time?.text).toContain("0h 45m");
      expect(time?.text).not.toContain("0 hours");
    });

    it("generates speed facts when provided", () => {
      const facts = generateFunFacts(yearStats, { cruise_speed_knots: 120 });

      expect(facts.some((f) => f.category === "speed")).toBe(true);
    });

    it("generates achievement facts for high altitude", () => {
      const facts = generateFunFacts(yearStats, { max_altitude_ft: 45000 });

      expect(facts.some((f) => f.category === "achievement")).toBe(true);
    });

    it("includes text, category and priority for each fact", () => {
      const facts = generateFunFacts(yearStats);

      facts.forEach((fact) => {
        expect(fact.text).toBeDefined();
        expect(fact.category).toBeDefined();
        expect(fact.priority).toBeDefined();
      });
    });

    it("draws a different mark for facts that share a category", () => {
      // Three of them are about distance, and the category alone drew the
      // same route icon three times in one card
      const facts = generateFunFacts(yearStats, {
        cruise_speed_knots: 110,
        longest_flight_nm: 380,
        total_altitude_gain_ft: 90000,
      });
      const distance = facts.filter((fact) => fact.category === "distance");

      expect(distance.length).toBeGreaterThan(1);
      expect(new Set(distance.map((fact) => fact.icon)).size).toBe(
        distance.length,
      );
    });

    it("carries no emoji of its own; the category names the icon", () => {
      const facts = generateFunFacts(yearStats, {
        cruise_speed_knots: 110,
        total_altitude_gain_ft: 90000,
        total_flight_time_seconds: 7200,
      });

      expect(facts.length).toBeGreaterThan(0);
      facts.forEach((fact) => {
        expect(fact.text).not.toMatch(/\p{Extended_Pictographic}/u);
      });
    });

    it("ends every fact with a full stop or an exclamation mark", () => {
      // The facts are stacked in one card and read down the page, so one that
      // simply stops reads as unfinished beside the ones that do not.
      //
      // Read from the source rather than from a generated set: selectDiverseFacts
      // returns at most six of them, by priority, so no set of inputs puts every
      // string in front of an assertion. The strings are all written in one
      // place, so that is where the rule is checked.
      const source = readFileSync(
        join(cwd(), "kml_heatmap/frontend/features/wrapped.ts"),
        "utf8",
      );
      const texts = [...source.matchAll(/^\s*text: `(.*)`,$/gm)].map(
        (match) => match[1]!,
      );

      // Every `text:` in the file, not just the handful a run happens to pick
      expect(texts.length).toBeGreaterThan(12);
      for (const text of texts) {
        expect(text, text).toMatch(/[.!]$/);
      }
    });

    it("generates around Earth fact for high distance", () => {
      const facts = generateFunFacts({
        ...yearStats,
        total_distance_nm: 20000,
      });

      expect(facts.some((f) => f.text.includes("around the Earth"))).toBe(true);
    });

    it("generates Everest fact for high altitude gain", () => {
      const facts = generateFunFacts(yearStats, {
        total_altitude_gain_ft: 60000,
      });

      expect(facts.some((f) => f.text.includes("Everest"))).toBe(true);
    });

    it("compares the longest journey with the closest reference distance", () => {
      const facts = generateFunFacts(yearStats, { longest_flight_nm: 280 });

      const longest = facts.find((f) => f.text.includes("longest journey"));
      expect(longest?.text).toContain("<strong>280.0 nm</strong>");
      expect(longest?.text).toContain(
        "about the distance from Berlin to Munich.",
      );
    });

    it("omits the comparison when no reference distance is close", () => {
      const facts = generateFunFacts(yearStats, { longest_flight_nm: 30 });

      const longest = facts.find((f) => f.text.includes("longest journey"));
      expect(longest?.text).toBe(
        "Your longest journey: <strong>30.0 nm</strong>.",
      );
    });

    it("generates loyal aircraft fact for single aircraft", () => {
      const singleAircraftStats: YearStats = {
        ...yearStats,
        total_flights: 10,
        aircraft_list: [{ registration: "D-EAGJ", type: "DA40", flights: 10 }],
      };

      const facts = generateFunFacts(singleAircraftStats);

      const loyal = facts.find((f) => f.category === "aircraft");
      expect(loyal?.text).toBe(
        "Loyal to <strong>D-EAGJ</strong>, all 10 flights in this DA40!",
      );
    });

    it("counts the aircraft's own flights, not the year's", () => {
      // Two flights without a registration (a Charterware export) are in
      // the year total but belong to no aircraft
      const stats: YearStats = {
        ...yearStats,
        total_flights: 4,
        aircraft_list: [{ registration: "D-EAGJ", type: "DA40", flights: 2 }],
      };

      const facts = generateFunFacts(stats);

      const fact = facts.find((f) => f.category === "aircraft");
      expect(fact?.text).toBe(
        "<strong>D-EAGJ</strong> took you on 2 flights in this DA40.",
      );
      expect(fact?.text).not.toContain("Loyal");
    });

    it("escapes the registration and model of the single aircraft", () => {
      const stats: YearStats = {
        ...yearStats,
        total_flights: 1,
        aircraft_list: [
          { registration: "D-<b>", model: "C172 & co", flights: 1 },
        ],
      };

      const facts = generateFunFacts(stats);

      expect(facts.find((f) => f.category === "aircraft")?.text).toBe(
        "Loyal to <strong>D-&lt;b&gt;</strong>, all 1 flight in this C172 &amp; co!",
      );
    });

    it("generates country fact for 3+ countries", () => {
      vi.spyOn(airports, "countCountries").mockReturnValue(
        new Set(["DE", "CH", "CZ"]),
      );
      const stats = { ...yearStats, airport_names: ["A", "B", "C"] };

      const facts = generateFunFacts(stats);

      expect(facts.some((f) => f.category === "countries")).toBe(true);
      expect(facts.some((f) => f.text.includes("3 countries"))).toBe(true);
      vi.restoreAllMocks();
    });

    it("generates country fact for 2 countries", () => {
      vi.spyOn(airports, "countCountries").mockReturnValue(
        new Set(["DE", "CH"]),
      );
      const stats = { ...yearStats, airport_names: ["A", "B"] };

      const facts = generateFunFacts(stats);

      expect(facts.some((f) => f.category === "countries")).toBe(true);
      expect(facts.some((f) => f.text.includes("2 countries"))).toBe(true);
      vi.restoreAllMocks();
    });

    it("does not generate country fact for 1 country", () => {
      vi.spyOn(airports, "countCountries").mockReturnValue(new Set(["DE"]));
      const stats = { ...yearStats, airport_names: ["A"] };

      const facts = generateFunFacts(stats);

      expect(facts.some((f) => f.category === "countries")).toBe(false);
      vi.restoreAllMocks();
    });

    it("names the selected year rather than this year", () => {
      const twoAircraft: YearStats = {
        ...yearStats,
        total_distance_nm: 2000,
        aircraft_list: yearStats.aircraft_list.slice(0, 2),
      };

      const texts = generateFunFacts(twoAircraft, null, "2023").map(
        (f) => f.text,
      );

      expect(texts).toContain(
        "You covered <strong>2,000.0 nautical miles</strong> in 2023!",
      );
      expect(texts).toContain(
        "You flew <strong>2 different aircraft</strong> in 2023.",
      );
      expect(texts.join(" ")).not.toContain("this year");
    });

    it("talks about the total in the All Years view", () => {
      const twoAircraft: YearStats = {
        ...yearStats,
        total_distance_nm: 2000,
        aircraft_list: yearStats.aircraft_list.slice(0, 2),
      };

      const texts = generateFunFacts(twoAircraft, null, "all").map(
        (f) => f.text,
      );

      expect(texts).toContain(
        "You covered <strong>2,000.0 nautical miles</strong> in total!",
      );
      expect(texts).toContain(
        "You flew <strong>2 different aircraft</strong> in total.",
      );
    });

    it("generates explorer fact for many aircraft", () => {
      const manyAircraftStats: YearStats = {
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
        true,
      );
    });

    it("returns 4-6 facts with comprehensive data", () => {
      const comprehensiveStats: YearStats = {
        total_flights: 50,
        total_distance_nm: 10000,
        num_airports: 10,
        flight_time: "100h 0m",
        airport_names: [],
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

      const facts = generateFunFacts(comprehensiveStats, {
        total_altitude_gain_ft: 50000,
        total_flight_time_seconds: 100000,
        cruise_speed_knots: 120,
        longest_flight_nm: 300,
        max_altitude_ft: 5000,
        most_common_cruise_altitude_ft: 1500,
        most_common_cruise_altitude_m: 457,
      });

      expect(facts.length).toBeGreaterThanOrEqual(4);
      expect(facts.length).toBeLessThanOrEqual(6);
    });

    it("limits facts per category", () => {
      const facts = generateFunFacts(yearStats, {
        total_altitude_gain_ft: 50000,
        total_flight_time_seconds: 100000,
        cruise_speed_knots: 120,
        longest_flight_nm: 300,
        max_altitude_ft: 45000,
        most_common_cruise_altitude_ft: 1500,
        most_common_cruise_altitude_m: 457,
      });

      const categoryCount: Record<string, number> = {};
      facts.forEach((fact) => {
        categoryCount[fact.category] = (categoryCount[fact.category] ?? 0) + 1;
      });

      Object.values(categoryCount).forEach((count) => {
        expect(count).toBeLessThanOrEqual(3);
      });
    });
  });

  describe("selectDiverseFacts", () => {
    const allFacts: FunFact[] = [
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
      expect(priorities[0]).toBe(10);
      expect(priorities[0]!).toBeGreaterThanOrEqual(
        priorities[priorities.length - 1]!,
      );
    });

    it("limits facts per category to 3", () => {
      const manyDistance: FunFact[] = [
        ...allFacts,
        { category: "distance", priority: 6, text: "Fact 8" },
      ];

      const selected = selectDiverseFacts(manyDistance);

      const categoryCount: Record<string, number> = {};
      selected.forEach((fact) => {
        categoryCount[fact.category] = (categoryCount[fact.category] ?? 0) + 1;
      });

      expect(categoryCount["distance"]).toBe(3);
      Object.values(categoryCount).forEach((count) => {
        expect(count).toBeLessThanOrEqual(3);
      });
    });

    it("ensures at least 4 facts when available", () => {
      const selected = selectDiverseFacts(allFacts);

      expect(selected.length).toBeGreaterThanOrEqual(4);
    });

    it("handles fewer than 4 facts", () => {
      const fewFacts: FunFact[] = [
        { category: "distance", priority: 10, text: "Fact 1" },
        { category: "altitude", priority: 9, text: "Fact 2" },
      ];

      expect(selectDiverseFacts(fewFacts)).toHaveLength(2);
    });

    it("handles empty array", () => {
      expect(selectDiverseFacts([])).toHaveLength(0);
    });
  });
  describe("findFurthestAirport", () => {
    const coordinates = new Map<string, [number, number]>([
      ["EDAQ Halle-Oppin", [51.55, 12.05]],
      ["EDDM Munich", [48.35, 11.79]],
      ["LJPZ Portoroz", [45.47, 13.61]],
      ["EDCM Kamenz", [51.29, 14.13]],
    ]);

    it("returns the airport furthest from the home base", () => {
      expect(
        findFurthestAirport(
          "EDAQ Halle-Oppin",
          [...coordinates.keys()],
          coordinates,
        ),
      ).toBe("LJPZ Portoroz");
    });

    it("never returns the home base itself", () => {
      expect(
        findFurthestAirport(
          "EDAQ Halle-Oppin",
          ["EDAQ Halle-Oppin", "EDDM Munich"],
          coordinates,
        ),
      ).toBe("EDDM Munich");
    });

    it("returns null when the home base is the only airport", () => {
      expect(
        findFurthestAirport(
          "EDAQ Halle-Oppin",
          ["EDAQ Halle-Oppin"],
          coordinates,
        ),
      ).toBeNull();
    });

    it("keeps the first airport on a tie", () => {
      // Both are the same distance from the home base on the equator
      const tied = new Map<string, [number, number]>([
        ["EDAQ Home", [0, 0]],
        ["AAAA West", [0, -1]],
        ["BBBB East", [0, 1]],
      ]);

      expect(
        findFurthestAirport("EDAQ Home", ["AAAA West", "BBBB East"], tied),
      ).toBe("AAAA West");
      expect(
        findFurthestAirport("EDAQ Home", ["BBBB East", "AAAA West"], tied),
      ).toBe("BBBB East");
    });

    it("skips airports without coordinates", () => {
      expect(
        findFurthestAirport(
          "EDAQ Halle-Oppin",
          ["ZZZZ Unknown", "EDDM Munich"],
          coordinates,
        ),
      ).toBe("EDDM Munich");
    });

    it("returns null without a home base or its coordinates", () => {
      expect(
        findFurthestAirport(null, ["EDDM Munich"], coordinates),
      ).toBeNull();
      expect(
        findFurthestAirport("ZZZZ Unknown", ["EDDM Munich"], coordinates),
      ).toBeNull();
    });
  });

  describe("segmentBounds", () => {
    it("spans every point of the segments", () => {
      expect(
        segmentBounds([
          {
            path_id: 1,
            coords: [
              [50, 8],
              [51, 7],
            ],
          },
          { path_id: 2 },
          {
            path_id: 3,
            coords: [
              [49, 9],
              [50.5, 8.5],
            ],
          },
        ]),
      ).toEqual([
        [49, 7],
        [51, 9],
      ]);
    });

    it("returns null without coordinates", () => {
      expect(segmentBounds([])).toBeNull();
      expect(segmentBounds([{ path_id: 1 }])).toBeNull();
    });
  });
});
