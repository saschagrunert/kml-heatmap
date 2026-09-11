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
  calculateFilteredStatistics,
  buildSegmentRanges,
  perPathSeconds,
  segmentRangesFor,
  segmentsForPathIds,
} from "../../../../kml_heatmap/frontend/calculations/statistics";
import {
  FEET_TO_METERS,
  METERS_TO_FEET,
} from "../../../../kml_heatmap/frontend/utils/constants";
import type {
  PathInfo,
  PathSegment,
} from "../../../../kml_heatmap/frontend/types";

const FT = (meters: number): number => meters * METERS_TO_FEET;

describe("statistics calculations", () => {
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
      aircraft_registration: "D-EXYZ",
      aircraft_type: "C172",
      start_airport: "EDDK",
      end_airport: "EDDM",
    },
  ];

  const mockSegments: PathSegment[] = [
    {
      path_id: 1,
      coords: [
        [52.5, 13.4],
        [50.0, 8.5],
      ],
      altitude_ft: FT(1000),
      groundspeed_knots: 120,
      time: 1000,
    },
    {
      path_id: 1,
      coords: [
        [50.0, 8.5],
        [50.1, 8.6],
      ],
      altitude_ft: FT(1500),
      groundspeed_knots: 130,
      time: 1100,
    },
    {
      path_id: 2,
      coords: [
        [50.1, 8.6],
        [52.5, 13.4],
      ],
      altitude_ft: FT(1200),
      groundspeed_knots: 125,
      time: 2000,
    },
    {
      path_id: 3,
      coords: [
        [48.3, 11.7],
        [50.9, 6.9],
      ],
      altitude_ft: FT(2000),
      groundspeed_knots: 140,
      time: 3000,
    },
    {
      path_id: 4,
      coords: [
        [50.9, 6.9],
        [48.3, 11.7],
      ],
      altitude_ft: FT(1800),
      groundspeed_knots: 135,
      time: 4000,
    },
  ];

  describe("filterPaths", () => {
    it("returns all paths when no filters applied", () => {
      expect(filterPaths(mockPathInfo, "all", "all")).toHaveLength(4);
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
        true,
      );
    });

    it("filters by both year and aircraft", () => {
      const result = filterPaths(mockPathInfo, "2025", "D-EXYZ");
      expect(result.map((p) => p.id)).toEqual([4]);
    });

    it("returns empty array when no matches", () => {
      expect(filterPaths(mockPathInfo, "2023", "all")).toHaveLength(0);
    });

    it("excludes paths with missing year or aircraft when filtering on them", () => {
      const paths: PathInfo[] = [
        { id: 1, aircraft_registration: "D-EAGJ" },
        { id: 2, year: 2025 },
        { id: 3, year: 2025, aircraft_registration: "D-EAGJ" },
      ];
      expect(filterPaths(paths, "2025", "all").map((p) => p.id)).toEqual([
        2, 3,
      ]);
      expect(filterPaths(paths, "all", "D-EAGJ").map((p) => p.id)).toEqual([
        1, 3,
      ]);
    });
  });

  describe("collectAirports", () => {
    it("collects unique airports", () => {
      const airports = collectAirports(mockPathInfo);
      expect([...airports].sort()).toEqual(["EDAV", "EDDF", "EDDK", "EDDM"]);
    });

    it("handles paths without airports and partial airports", () => {
      expect(collectAirports([{ id: 1 }, { id: 2 }]).size).toBe(0);
      expect([...collectAirports([{ id: 1, start_airport: "EDAV" }])]).toEqual([
        "EDAV",
      ]);
      expect([...collectAirports([{ id: 1, end_airport: "EDDF" }])]).toEqual([
        "EDDF",
      ]);
    });

    it("deduplicates airports", () => {
      const airports = collectAirports([
        { id: 1, start_airport: "EDAV", end_airport: "EDDF" },
        { id: 2, start_airport: "EDAV", end_airport: "EDDF" },
      ]);
      expect(airports.size).toBe(2);
    });
  });

  describe("aggregateAircraft", () => {
    it("aggregates aircraft with flight counts", () => {
      const aircraft = aggregateAircraft(mockPathInfo);
      expect(aircraft).toHaveLength(2);

      const eagj = aircraft.find((a) => a.registration === "D-EAGJ")!;
      expect(eagj.flights).toBe(2);
      expect(eagj.type).toBe("DA40");

      const exyz = aircraft.find((a) => a.registration === "D-EXYZ")!;
      expect(exyz.flights).toBe(2);
      expect(exyz.type).toBe("C172");
    });

    it("sorts by flight count descending", () => {
      const aircraft = aggregateAircraft([
        { id: 1, aircraft_registration: "A", aircraft_type: "T1" },
        { id: 2, aircraft_registration: "B", aircraft_type: "T2" },
        { id: 3, aircraft_registration: "B", aircraft_type: "T2" },
        { id: 4, aircraft_registration: "B", aircraft_type: "T2" },
      ]);

      expect(aircraft.map((a) => [a.registration, a.flights])).toEqual([
        ["B", 3],
        ["A", 1],
      ]);
    });

    it("handles paths without aircraft and empty input", () => {
      expect(aggregateAircraft([{ id: 1 }, { id: 2 }])).toHaveLength(0);
      expect(aggregateAircraft([])).toHaveLength(0);
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
      expect(filterSegmentsByPaths(mockSegments, [])).toHaveLength(0);
    });

    it("returns all segments when all paths match", () => {
      expect(filterSegmentsByPaths(mockSegments, mockPathInfo)).toHaveLength(5);
    });
  });

  describe("calculateTotalDistance", () => {
    it("calculates total distance from segments", () => {
      const distance = calculateTotalDistance(mockSegments);
      // Berlin-Frankfurt (~427 km) x2 plus Munich-Cologne (~455 km) x2 plus ~13 km
      expect(distance).toBeGreaterThan(1700);
      expect(distance).toBeLessThan(1800);
    });

    it("returns 0 for empty segments", () => {
      expect(calculateTotalDistance([])).toBe(0);
    });

    it("ignores segments without or with malformed coords", () => {
      const good: PathSegment = {
        path_id: 2,
        coords: [
          [50.0, 8.0],
          [51.0, 9.0],
        ],
      };
      const expected = calculateTotalDistance([good]);
      const segments: PathSegment[] = [
        { path_id: 1, altitude_ft: 1000 },
        {
          path_id: 1,
          coords: [[50.0, 8.0]] as unknown as PathSegment["coords"],
        },
        good,
      ];
      expect(calculateTotalDistance(segments)).toBe(expected);
      expect(expected).toBeGreaterThan(0);
    });
  });

  describe("calculateAltitudeStats", () => {
    it("calculates altitude statistics in meters from altitude_ft", () => {
      const stats = calculateAltitudeStats(mockSegments);

      expect(stats.min).toBeCloseTo(1000, 6);
      expect(stats.max).toBeCloseTo(2000, 6);
      expect(stats.gain).toBeGreaterThan(0);
    });

    it("returns zeros for empty segments", () => {
      expect(calculateAltitudeStats([])).toEqual({ min: 0, max: 0, gain: 0 });
    });

    it("calculates altitude gain correctly", () => {
      const segments: PathSegment[] = [
        { path_id: 1, altitude_ft: FT(1000) },
        { path_id: 1, altitude_ft: FT(1500) }, // +500
        { path_id: 1, altitude_ft: FT(1200) }, // descent, no gain
        { path_id: 1, altitude_ft: FT(2000) }, // +800
      ];
      expect(calculateAltitudeStats(segments).gain).toBeCloseTo(1300, 6);
    });

    it("skips segments with undefined altitude", () => {
      const segments: PathSegment[] = [
        { path_id: 1, altitude_ft: FT(1000) },
        { path_id: 1 },
        { path_id: 1, altitude_ft: FT(1500) },
      ];
      const stats = calculateAltitudeStats(segments);
      expect(stats.min).toBeCloseTo(1000, 6);
      expect(stats.max).toBeCloseTo(1500, 6);
      expect(stats.gain).toBeCloseTo(500, 6);
    });

    it("resets the altitude gain at path boundaries (backend parity)", () => {
      const segments: PathSegment[] = [
        { path_id: 1, altitude_ft: FT(1000) },
        { path_id: 1, altitude_ft: FT(1200) }, // +200
        { path_id: 2, altitude_ft: FT(1500) }, // new path: no carry-over
        { path_id: 2, altitude_ft: FT(1600) }, // +100
      ];
      expect(calculateAltitudeStats(segments).gain).toBeCloseTo(300, 6);
    });

    it("keeps negative altitudes", () => {
      const segments: PathSegment[] = [
        { path_id: 1, altitude_ft: FT(-420) },
        { path_id: 1, altitude_ft: FT(100) },
      ];
      const stats = calculateAltitudeStats(segments);
      expect(stats.min).toBeCloseTo(-420, 6);
      expect(stats.gain).toBeCloseTo(520, 6);
    });
  });

  describe("calculateSpeedStats", () => {
    it("calculates speed statistics", () => {
      const stats = calculateSpeedStats(mockSegments);

      expect(stats.max).toBe(140);
      expect(stats.avg).toBe(130); // (120+130+125+140+135)/5
    });

    it("returns zeros for empty segments", () => {
      expect(calculateSpeedStats([])).toEqual({ max: 0, avg: 0 });
    });

    it("filters out zero, negative and undefined speeds", () => {
      const segments: PathSegment[] = [
        { path_id: 1, groundspeed_knots: 0 },
        { path_id: 1, groundspeed_knots: -10 },
        { path_id: 1 },
        { path_id: 1, groundspeed_knots: 100 },
        { path_id: 1, groundspeed_knots: 200 },
      ];
      expect(calculateSpeedStats(segments)).toEqual({ max: 200, avg: 150 });
    });
  });

  describe("calculateLongestFlight", () => {
    it("returns 0 for empty segments", () => {
      expect(calculateLongestFlight([])).toBe(0);
    });

    it("identifies the longest flight by summing its segments", () => {
      const segments: PathSegment[] = [
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
            [50.0, 8.0],
            [55.0, 13.0],
          ],
        },
        {
          path_id: 2,
          coords: [
            [55.0, 13.0],
            [55.5, 13.5],
          ],
        },
      ];
      const path2 = calculateTotalDistance(segments.slice(1));
      expect(calculateLongestFlight(segments)).toBeCloseTo(path2, 6);
      expect(path2).toBeGreaterThan(100);
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
      expect(stats.total_distance_nm).toBeCloseTo(
        stats.total_distance_km * 0.539957,
        2,
      );
      expect(stats.max_altitude_m).toBeCloseTo(2000, 6);
      expect(stats.min_altitude_m).toBeCloseTo(1000, 6);
      expect(stats.max_altitude_ft).toBeCloseTo(FT(2000), 6);
      expect(stats.max_groundspeed_knots).toBe(140);
      expect(stats.avg_groundspeed_knots).toBe(130);
      expect(stats.total_flight_time_seconds).toBe(100);
      expect(stats.total_flight_time_str).toBe("0h 1m");
      // 5 segments plus the end point of each of the 4 paths they belong to
      expect(stats.total_points).toBe(9);
    });

    it("counts the track points behind the filtered segments", () => {
      const stats = calculateFilteredStatistics({
        pathInfo: [
          { id: 1, year: 2025 },
          { id: 2, year: 2025 },
        ],
        segments: [
          { path_id: 1, altitude_ft: 1000, groundspeed_knots: 100 },
          { path_id: 1, altitude_ft: 1000, groundspeed_knots: 100 },
          { path_id: 2, altitude_ft: 1000, groundspeed_knots: 100 },
        ],
      });
      // 3 segments plus one closing point for each of the 2 paths
      expect(stats.total_points).toBe(5);
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
      expect(stats.aircraft_list[0]!.registration).toBe("D-EAGJ");
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

    it("uses pre-filtered paths and segments when provided", () => {
      const stats = calculateFilteredStatistics({
        pathInfo: mockPathInfo,
        segments: mockSegments,
        year: "2023", // would match nothing
        preFiltered: {
          paths: [mockPathInfo[2]!],
          segments: [mockSegments[3]!],
        },
      });

      expect(stats.num_paths).toBe(1);
      expect(stats.max_groundspeed_knots).toBe(140);
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

    it("handles missing pathInfo or segments", () => {
      const noPaths = calculateFilteredStatistics({
        pathInfo: null as unknown as PathInfo[],
        segments: mockSegments,
      });
      expect(noPaths.num_paths).toBe(0);

      const noSegments = calculateFilteredStatistics({
        pathInfo: mockPathInfo,
        segments: null as unknown as PathSegment[],
      });
      expect(noSegments.total_distance_km).toBe(0);
    });

    it("computes cruise speed and most common cruise altitude above 1000 ft AGL", () => {
      const segments: PathSegment[] = [
        // ground level 500 ft
        {
          path_id: 1,
          coords: [
            [50.0, 8.0],
            [50.01, 8.0],
          ],
          altitude_ft: 500,
          groundspeed_knots: 30,
          time: 0,
        },
        // 1400 ft AGL -> cruise
        {
          path_id: 1,
          coords: [
            [50.01, 8.0],
            [50.1, 8.0],
          ],
          altitude_ft: 1900,
          groundspeed_knots: 100,
          time: 100,
        },
        // 1450 ft AGL -> cruise, same 100 ft bucket
        {
          path_id: 1,
          coords: [
            [50.1, 8.0],
            [50.2, 8.0],
          ],
          altitude_ft: 1950,
          groundspeed_knots: 100,
          time: 200,
        },
      ];
      const stats = calculateFilteredStatistics({
        pathInfo: [{ id: 1 }],
        segments,
      });

      expect(stats.cruise_speed_knots).toBeCloseTo(100, 6);
      expect(stats.most_common_cruise_altitude_ft).toBe(1400);
      expect(stats.most_common_cruise_altitude_m).toBeCloseTo(
        1400 * FEET_TO_METERS,
        6,
      );
    });

    it("resolves ties for the most common cruise altitude to the lowest bin", () => {
      const seg = (altitudeFt: number, lat: number): PathSegment => ({
        path_id: 1,
        coords: [
          [lat, 8.0],
          [lat + 0.1, 8.0],
        ],
        altitude_ft: altitudeFt,
        groundspeed_knots: 100,
      });
      const stats = calculateFilteredStatistics({
        pathInfo: [{ id: 1 }],
        segments: [seg(0, 50), seg(3000, 50.1), seg(2000, 50.2)],
      });

      expect(stats.most_common_cruise_altitude_ft).toBe(2000);
    });

    it("leaves cruise fields undefined without cruise segments", () => {
      const stats = calculateFilteredStatistics({
        pathInfo: [{ id: 1 }],
        segments: [
          {
            path_id: 1,
            coords: [
              [50.0, 8.0],
              [50.1, 8.0],
            ],
            altitude_ft: 500,
            groundspeed_knots: 100,
          },
        ],
      });

      expect(stats.cruise_speed_knots).toBeUndefined();
      expect(stats.most_common_cruise_altitude_ft).toBeUndefined();
      expect(stats.total_flight_time_str).toBeUndefined();
    });

    it("handles large datasets without stack overflow (10k segments)", () => {
      const largeSegments: PathSegment[] = [];
      const largePathInfo: PathInfo[] = [];

      for (let i = 0; i < 10000; i++) {
        largeSegments.push({
          path_id: Math.floor(i / 10),
          coords: [
            [50.0 + i * 0.001, 8.0 + i * 0.001],
            [50.1 + i * 0.001, 8.1 + i * 0.001],
          ],
          altitude_ft: 1000 + i,
          groundspeed_knots: 100 + (i % 50),
          time: 1000 + i * 10,
        });

        if (i % 10 === 0) {
          largePathInfo.push({
            id: Math.floor(i / 10),
            year: 2026,
            aircraft_registration: `D-TEST${i}`,
            start_airport: "EDDF",
            end_airport: "EDDM",
          });
        }
      }

      const stats = calculateFilteredStatistics({
        pathInfo: largePathInfo,
        segments: largeSegments,
        year: "all",
        aircraft: "all",
      });
      expect(stats.num_paths).toBe(1000);
      expect(stats.total_distance_km).toBeGreaterThan(0);
      expect(stats.max_altitude_ft).toBeCloseTo(10999, 6);
      expect(stats.max_groundspeed_knots).toBe(149);
      expect(stats.total_flight_time_seconds).toBe(1000 * 90);
    });
  });

  describe("segment index", () => {
    const grouped: PathSegment[] = [
      { path_id: 1, time: 0 },
      { path_id: 1, time: 10 },
      { path_id: 2, time: 0 },
      { path_id: 3, time: 0 },
      { path_id: 3, time: 5 },
      { path_id: 3, time: 9 },
    ];

    it("locates every path as a slice of a grouped array", () => {
      expect(buildSegmentRanges(grouped)).toEqual(
        new Map([
          [1, [0, 2]],
          [2, [2, 3]],
          [3, [3, 6]],
        ]),
      );
      expect(buildSegmentRanges([])).toEqual(new Map());
    });

    it("refuses an array where a path comes back after another one", () => {
      expect(
        buildSegmentRanges([{ path_id: 1 }, { path_id: 2 }, { path_id: 1 }]),
      ).toBeNull();
    });

    it("builds the index once per array", () => {
      const first = segmentRangesFor(grouped);
      expect(segmentRangesFor(grouped)).toBe(first);
      expect(segmentRangesFor([...grouped])).not.toBe(first);
    });

    it("returns the segments of the given paths in array order", () => {
      const result = segmentsForPathIds(grouped, [3, 1]);

      expect(result).toEqual([
        grouped[0],
        grouped[1],
        grouped[3],
        grouped[4],
        grouped[5],
      ]);
      expect(segmentsForPathIds(grouped, new Set([2]))).toEqual([grouped[2]]);
      expect(segmentsForPathIds(grouped, [99])).toEqual([]);
      expect(segmentsForPathIds(grouped, [])).toEqual([]);
    });

    it("falls back to a filter for an array that is not grouped", () => {
      const interleaved: PathSegment[] = [
        { path_id: 1, time: 0 },
        { path_id: 2, time: 0 },
        { path_id: 1, time: 10 },
      ];

      expect(segmentsForPathIds(interleaved, [1])).toEqual([
        interleaved[0],
        interleaved[2],
      ]);
      expect(filterSegmentsByPaths(interleaved, [{ id: 2 }])).toEqual([
        interleaved[1],
      ]);
    });
  });

  describe("perPathSeconds", () => {
    it("measures each path from its first to its last timestamp", () => {
      const seconds = perPathSeconds([
        { path_id: 1, time: 30 },
        { path_id: 1, time: 0 },
        { path_id: 1, time: 90 },
        { path_id: 2, time: 5 },
        { path_id: 3 },
      ]);

      expect(seconds).toEqual(
        new Map([
          [1, 90],
          [2, 0],
        ]),
      );
    });

    it("restricts the paths when a set is given", () => {
      const seconds = perPathSeconds(
        [
          { path_id: 1, time: 0 },
          { path_id: 1, time: 60 },
          { path_id: 2, time: 0 },
          { path_id: 2, time: 10 },
        ],
        new Set([2]),
      );

      expect(seconds).toEqual(new Map([[2, 10]]));
    });
  });
});
