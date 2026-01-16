import { describe, it, expect } from "vitest";
import {
  filterPaths,
  collectAirports,
  aggregateAircraft,
  filterSegmentsByPaths,
  calculateTotalDistance,
  calculateAltitudeStats,
  calculateSpeedStats,
  calculateLongestFlight,
  calculateFlightTime,
  calculateFilteredStatistics,
} from "../../../../kml_heatmap/frontend/calculations/statistics";

describe("statistics calculations", () => {
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
      aircraft_registration: "D-EXYZ",
      aircraft_type: "C172",
      start_airport: "EDDK",
      end_airport: "EDDM",
    },
  ];

  const mockSegments = [
    {
      path_id: 1,
      coords: [
        [52.5, 13.4],
        [50.0, 8.5],
      ],
      altitude_m: 1000,
      groundspeed_knots: 120,
      time: 1000,
    },
    {
      path_id: 1,
      coords: [
        [50.0, 8.5],
        [50.1, 8.6],
      ],
      altitude_m: 1500,
      groundspeed_knots: 130,
      time: 1100,
    },
    {
      path_id: 2,
      coords: [
        [50.1, 8.6],
        [52.5, 13.4],
      ],
      altitude_m: 1200,
      groundspeed_knots: 125,
      time: 2000,
    },
    {
      path_id: 3,
      coords: [
        [48.3, 11.7],
        [50.9, 6.9],
      ],
      altitude_m: 2000,
      groundspeed_knots: 140,
      time: 3000,
    },
    {
      path_id: 4,
      coords: [
        [50.9, 6.9],
        [48.3, 11.7],
      ],
      altitude_m: 1800,
      groundspeed_knots: 135,
      time: 4000,
    },
  ];

  describe("filterPaths", () => {
    it("returns all paths when no filters applied", () => {
      const result = filterPaths(mockPathInfo, "all", "all");
      expect(result).toHaveLength(4);
    });

    it("filters by year", () => {
      const result = filterPaths(mockPathInfo, "2025", "all");
      expect(result).toHaveLength(3);
      expect(result.every((p) => p.year === 2025)).toBe(true);
    });

    it("filters by aircraft", () => {
      const result = filterPaths(mockPathInfo, "all", "D-EAGJ");
      expect(result).toHaveLength(2);
      expect(result.every((p) => p.aircraft_registration === "D-EAGJ")).toBe(
        true
      );
    });

    it("filters by both year and aircraft", () => {
      const result = filterPaths(mockPathInfo, "2025", "D-EXYZ");
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(4);
    });

    it("returns empty array when no matches", () => {
      const result = filterPaths(mockPathInfo, "2023", "all");
      expect(result).toHaveLength(0);
    });

    it("handles missing year in path data", () => {
      const pathsWithMissingYear = [
        { id: 1, aircraft_registration: "D-EAGJ" },
        { id: 2, year: 2025, aircraft_registration: "D-EAGJ" },
      ];
      const result = filterPaths(pathsWithMissingYear, "2025", "all");
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(2);
    });

    it("handles missing aircraft in path data", () => {
      const pathsWithMissingAircraft = [
        { id: 1, year: 2025 },
        { id: 2, year: 2025, aircraft_registration: "D-EAGJ" },
      ];
      const result = filterPaths(pathsWithMissingAircraft, "all", "D-EAGJ");
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(2);
    });
  });

  describe("collectAirports", () => {
    it("collects unique airports", () => {
      const airports = collectAirports(mockPathInfo);
      expect(airports.size).toBe(4);
      expect(airports.has("EDAV")).toBe(true);
      expect(airports.has("EDDF")).toBe(true);
      expect(airports.has("EDDM")).toBe(true);
      expect(airports.has("EDDK")).toBe(true);
    });

    it("handles paths without airports", () => {
      const pathsWithoutAirports = [
        { id: 1, year: 2025 },
        { id: 2, year: 2025 },
      ];
      const airports = collectAirports(pathsWithoutAirports);
      expect(airports.size).toBe(0);
    });

    it("deduplicates airports", () => {
      const duplicatePaths = [
        { id: 1, start_airport: "EDAV", end_airport: "EDDF" },
        { id: 2, start_airport: "EDAV", end_airport: "EDDF" },
      ];
      const airports = collectAirports(duplicatePaths);
      expect(airports.size).toBe(2);
    });

    it("handles only start airports", () => {
      const paths = [{ id: 1, start_airport: "EDAV" }];
      const airports = collectAirports(paths);
      expect(airports.size).toBe(1);
      expect(airports.has("EDAV")).toBe(true);
    });

    it("handles only end airports", () => {
      const paths = [{ id: 1, end_airport: "EDDF" }];
      const airports = collectAirports(paths);
      expect(airports.size).toBe(1);
      expect(airports.has("EDDF")).toBe(true);
    });
  });

  describe("aggregateAircraft", () => {
    it("aggregates aircraft with flight counts", () => {
      const aircraft = aggregateAircraft(mockPathInfo);
      expect(aircraft).toHaveLength(2);

      const eagj = aircraft.find((a) => a.registration === "D-EAGJ");
      expect(eagj).toBeDefined();
      expect(eagj.flights).toBe(2);
      expect(eagj.type).toBe("DA40");

      const exyz = aircraft.find((a) => a.registration === "D-EXYZ");
      expect(exyz).toBeDefined();
      expect(exyz.flights).toBe(2);
      expect(exyz.type).toBe("C172");
    });

    it("sorts by flight count descending", () => {
      const paths = [
        { id: 1, aircraft_registration: "A", aircraft_type: "T1" },
        { id: 2, aircraft_registration: "B", aircraft_type: "T2" },
        { id: 3, aircraft_registration: "B", aircraft_type: "T2" },
        { id: 4, aircraft_registration: "B", aircraft_type: "T2" },
      ];
      const aircraft = aggregateAircraft(paths);

      expect(aircraft[0].registration).toBe("B");
      expect(aircraft[0].flights).toBe(3);
      expect(aircraft[1].registration).toBe("A");
      expect(aircraft[1].flights).toBe(1);
    });

    it("handles paths without aircraft", () => {
      const paths = [{ id: 1 }, { id: 2 }];
      const aircraft = aggregateAircraft(paths);
      expect(aircraft).toHaveLength(0);
    });

    it("handles empty array", () => {
      const aircraft = aggregateAircraft([]);
      expect(aircraft).toHaveLength(0);
    });
  });

  describe("filterSegmentsByPaths", () => {
    it("filters segments by path IDs", () => {
      const pathInfo = mockPathInfo.filter((p) => p.year === 2025);
      const result = filterSegmentsByPaths(mockSegments, pathInfo);

      expect(result).toHaveLength(4); // paths 1, 2, 4
      expect(result.every((s) => [1, 2, 4].includes(s.path_id))).toBe(true);
    });

    it("returns empty array when no paths match", () => {
      const result = filterSegmentsByPaths(mockSegments, []);
      expect(result).toHaveLength(0);
    });

    it("returns all segments when all paths match", () => {
      const result = filterSegmentsByPaths(mockSegments, mockPathInfo);
      expect(result).toHaveLength(5);
    });
  });

  describe("calculateTotalDistance", () => {
    it("calculates total distance from segments", () => {
      const distance = calculateTotalDistance(mockSegments);
      expect(distance).toBeGreaterThan(0);
      expect(typeof distance).toBe("number");
    });

    it("returns 0 for empty segments", () => {
      const distance = calculateTotalDistance([]);
      expect(distance).toBe(0);
    });

    it("handles segments without coords", () => {
      const segments = [
        { path_id: 1, altitude_m: 1000 },
        {
          path_id: 2,
          coords: [
            [50.0, 8.0],
            [51.0, 9.0],
          ],
          altitude_m: 1500,
        },
      ];
      const distance = calculateTotalDistance(segments);
      expect(distance).toBeGreaterThan(0);
    });

    it("handles malformed coords", () => {
      const segments = [
        { path_id: 1, coords: [[50.0, 8.0]], altitude_m: 1000 }, // Only 1 point
        {
          path_id: 2,
          coords: [
            [50.0, 8.0],
            [51.0, 9.0],
          ],
          altitude_m: 1500,
        },
      ];
      const distance = calculateTotalDistance(segments);
      expect(distance).toBeGreaterThan(0);
    });
  });

  describe("calculateAltitudeStats", () => {
    it("calculates altitude statistics", () => {
      const stats = calculateAltitudeStats(mockSegments);

      expect(stats.min).toBe(1000);
      expect(stats.max).toBe(2000);
      expect(stats.gain).toBeGreaterThan(0);
    });

    it("returns zeros for empty segments", () => {
      const stats = calculateAltitudeStats([]);
      expect(stats).toEqual({ min: 0, max: 0, gain: 0 });
    });

    it("calculates altitude gain correctly", () => {
      const segments = [
        { altitude_m: 1000 },
        { altitude_m: 1500 }, // +500
        { altitude_m: 1200 }, // descent, no gain
        { altitude_m: 2000 }, // +800
      ];
      const stats = calculateAltitudeStats(segments);
      expect(stats.gain).toBe(1300); // 500 + 800
    });

    it("handles segments with undefined altitude", () => {
      const segments = [
        { altitude_m: 1000 },
        { altitude_m: undefined },
        { altitude_m: 1500 },
      ];
      const stats = calculateAltitudeStats(segments);
      expect(stats.min).toBe(1000);
      expect(stats.max).toBe(1500);
    });
  });

  describe("calculateSpeedStats", () => {
    it("calculates speed statistics", () => {
      const stats = calculateSpeedStats(mockSegments);

      expect(stats.max).toBe(140);
      expect(stats.avg).toBeCloseTo(130, 0); // (120+130+125+140+135)/5 = 130
    });

    it("returns zeros for empty segments", () => {
      const stats = calculateSpeedStats([]);
      expect(stats).toEqual({ max: 0, avg: 0 });
    });

    it("filters out zero and negative speeds", () => {
      const segments = [
        { groundspeed_knots: 0 },
        { groundspeed_knots: -10 },
        { groundspeed_knots: 100 },
        { groundspeed_knots: 200 },
      ];
      const stats = calculateSpeedStats(segments);
      expect(stats.max).toBe(200);
      expect(stats.avg).toBe(150);
    });

    it("handles segments with undefined speed", () => {
      const segments = [
        { groundspeed_knots: 100 },
        { groundspeed_knots: undefined },
        { groundspeed_knots: 200 },
      ];
      const stats = calculateSpeedStats(segments);
      expect(stats.max).toBe(200);
      expect(stats.avg).toBe(150);
    });
  });

  describe("calculateLongestFlight", () => {
    it("calculates longest flight distance", () => {
      const longest = calculateLongestFlight(mockSegments);
      expect(longest).toBeGreaterThan(0);
      expect(typeof longest).toBe("number");
    });

    it("returns 0 for empty segments", () => {
      const longest = calculateLongestFlight([]);
      expect(longest).toBe(0);
    });

    it("identifies correct longest flight", () => {
      const segments = [
        {
          path_id: 1,
          coords: [
            [50.0, 8.0],
            [50.1, 8.1],
          ],
        }, // Short
        {
          path_id: 2,
          coords: [
            [50.0, 8.0],
            [55.0, 13.0],
          ],
        }, // Long
      ];
      const longest = calculateLongestFlight(segments);
      expect(longest).toBeGreaterThan(100); // Significantly longer than path 1
    });
  });

  describe("calculateFlightTime", () => {
    it("calculates total flight time", () => {
      const time = calculateFlightTime(mockSegments, mockPathInfo);
      expect(time).toBeGreaterThan(0);
    });

    it("returns 0 for empty segments", () => {
      const time = calculateFlightTime([], mockPathInfo);
      expect(time).toBe(0);
    });

    it("calculates time for each path separately", () => {
      const segments = [
        { path_id: 1, time: 1000 },
        { path_id: 1, time: 1500 }, // Path 1: 500 seconds
        { path_id: 2, time: 2000 },
        { path_id: 2, time: 2800 }, // Path 2: 800 seconds
      ];
      const pathInfo = [{ id: 1 }, { id: 2 }];
      const time = calculateFlightTime(segments, pathInfo);
      expect(time).toBe(1300); // 500 + 800
    });

    it("handles segments without time", () => {
      const segments = [
        { path_id: 1, time: 1000 },
        { path_id: 1, time: undefined },
        { path_id: 1, time: 1500 },
      ];
      const pathInfo = [{ id: 1 }];
      const time = calculateFlightTime(segments, pathInfo);
      expect(time).toBe(500); // Still calculates from min to max
    });
  });

  describe("calculateFilteredStatistics", () => {
    it("calculates comprehensive statistics", () => {
      const stats = calculateFilteredStatistics({
        pathInfo: mockPathInfo,
        segments: mockSegments,
        year: "all",
        aircraft: "all",
      });

      expect(stats.num_paths).toBe(4);
      expect(stats.num_airports).toBe(4);
      expect(stats.num_aircraft).toBe(2);
      expect(stats.total_distance_km).toBeGreaterThan(0);
      expect(stats.total_distance_nm).toBeGreaterThan(0);
      expect(stats.max_altitude_m).toBe(2000);
      expect(stats.max_groundspeed_knots).toBe(140);
    });

    it("applies year filter", () => {
      const stats = calculateFilteredStatistics({
        pathInfo: mockPathInfo,
        segments: mockSegments,
        year: "2025",
        aircraft: "all",
      });

      expect(stats.num_paths).toBe(3);
      expect(stats.aircraft_list).toHaveLength(2);
    });

    it("applies aircraft filter", () => {
      const stats = calculateFilteredStatistics({
        pathInfo: mockPathInfo,
        segments: mockSegments,
        year: "all",
        aircraft: "D-EAGJ",
      });

      expect(stats.num_paths).toBe(2);
      expect(stats.num_aircraft).toBe(1);
      expect(stats.aircraft_list[0].registration).toBe("D-EAGJ");
    });

    it("applies both filters", () => {
      const stats = calculateFilteredStatistics({
        pathInfo: mockPathInfo,
        segments: mockSegments,
        year: "2025",
        aircraft: "D-EXYZ",
      });

      expect(stats.num_paths).toBe(1);
      expect(stats.num_aircraft).toBe(1);
    });

    it("returns empty stats when no paths match", () => {
      const stats = calculateFilteredStatistics({
        pathInfo: mockPathInfo,
        segments: mockSegments,
        year: "2023",
        aircraft: "all",
      });

      expect(stats).toEqual({
        total_points: 0,
        num_paths: 0,
        num_airports: 0,
        airport_names: [],
        num_aircraft: 0,
        aircraft_list: [],
        total_distance_nm: 0,
        total_distance_km: 0,
      });
    });

    it("handles missing pathInfo", () => {
      const stats = calculateFilteredStatistics({
        pathInfo: null,
        segments: mockSegments,
      });

      expect(stats.num_paths).toBe(0);
      expect(stats.total_distance_km).toBe(0);
    });

    it("handles missing segments", () => {
      const stats = calculateFilteredStatistics({
        pathInfo: mockPathInfo,
        segments: null,
      });

      expect(stats.num_paths).toBe(0);
      expect(stats.total_distance_km).toBe(0);
    });

    it("converts km to nautical miles correctly", () => {
      const stats = calculateFilteredStatistics({
        pathInfo: mockPathInfo,
        segments: mockSegments,
        year: "all",
        aircraft: "all",
      });

      // 1 km = 0.539957 nautical miles
      const expectedNm = stats.total_distance_km * 0.539957;
      expect(stats.total_distance_nm).toBeCloseTo(expectedNm, 2);
    });

    it("handles large datasets without stack overflow (10k segments)", () => {
      // Generate 10k segments to simulate processing many KML files
      const largeSegments = [];
      const largePathInfo = [];

      for (let i = 0; i < 10000; i++) {
        largeSegments.push({
          path_id: `path${i}`,
          coords: [
            [50.0 + i * 0.001, 8.0 + i * 0.001],
            [50.1 + i * 0.001, 8.1 + i * 0.001],
          ],
          altitude_m: 1000 + i,
          groundspeed_knots: 100 + (i % 50),
          time: 1000 + i * 10,
        });

        if (i % 10 === 0) {
          largePathInfo.push({
            id: `path${i}`,
            year: 2026,
            aircraft_registration: `D-TEST${i}`,
            start_airport: "EDDF",
            end_airport: "EDDM",
          });
        }
      }

      // This should not throw a stack overflow error
      expect(() => {
        const stats = calculateFilteredStatistics({
          pathInfo: largePathInfo,
          segments: largeSegments,
          year: "all",
          aircraft: "all",
        });
        expect(stats.num_paths).toBe(1000);
        expect(stats.total_distance_km).toBeGreaterThan(0);
      }).not.toThrow();
    });

    it("handles calculateAltitudeStats with large arrays without stack overflow", () => {
      // Generate 10k segments
      const largeSegments = [];
      for (let i = 0; i < 10000; i++) {
        largeSegments.push({
          path_id: `path${i}`,
          altitude_m: 1000 + i,
        });
      }

      expect(() => {
        const stats = calculateAltitudeStats(largeSegments);
        expect(stats.min).toBe(1000);
        expect(stats.max).toBe(10999);
      }).not.toThrow();
    });

    it("handles calculateSpeedStats with large arrays without stack overflow", () => {
      // Generate 10k segments
      const largeSegments = [];
      for (let i = 0; i < 10000; i++) {
        largeSegments.push({
          path_id: `path${i}`,
          groundspeed_knots: 100 + (i % 100),
        });
      }

      expect(() => {
        const stats = calculateSpeedStats(largeSegments);
        expect(stats.max).toBe(199);
        expect(stats.avg).toBeGreaterThan(0);
      }).not.toThrow();
    });

    it("handles calculateLongestFlight with large arrays without stack overflow", () => {
      // Generate 10k segments across many paths
      const largeSegments = [];
      for (let i = 0; i < 10000; i++) {
        largeSegments.push({
          path_id: `path${Math.floor(i / 10)}`,
          coords: [
            [50.0 + i * 0.01, 8.0],
            [50.0 + i * 0.01 + 0.1, 8.1],
          ],
        });
      }

      expect(() => {
        const longest = calculateLongestFlight(largeSegments);
        expect(longest).toBeGreaterThan(0);
      }).not.toThrow();
    });

    it("handles calculateFlightTime with large arrays without stack overflow", () => {
      // Generate 10k segments
      const largeSegments = [];
      const largePathInfo = [];
      for (let i = 0; i < 10000; i++) {
        largeSegments.push({
          path_id: `path${Math.floor(i / 100)}`,
          time: 1000 + i * 10,
        });
        if (i % 100 === 0) {
          largePathInfo.push({ id: `path${Math.floor(i / 100)}` });
        }
      }

      expect(() => {
        const time = calculateFlightTime(largeSegments, largePathInfo);
        expect(time).toBeGreaterThan(0);
      }).not.toThrow();
    });
  });
});
