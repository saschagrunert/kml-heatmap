import { describe, it, expect } from "vitest";
import {
  prepareReplaySegments,
  calculateSmoothedBearing,
} from "../../../../kml_heatmap/frontend/features/replay";
import { calculateBearing } from "../../../../kml_heatmap/frontend/utils/geometry";
import type { PathSegment } from "../../../../kml_heatmap/frontend/types";

describe("replay feature", () => {
  const mockSegments: PathSegment[] = [
    {
      path_id: 1,
      time: 1000,
      coords: [
        [50.0, 8.0],
        [50.1, 8.1],
      ],
      altitude_ft: 5000,
      groundspeed_knots: 120,
    },
    {
      path_id: 1,
      time: 1100,
      coords: [
        [50.1, 8.1],
        [50.2, 8.2],
      ],
      altitude_ft: 6000,
      groundspeed_knots: 130,
    },
    {
      path_id: 1,
      time: 1200,
      coords: [
        [50.2, 8.2],
        [50.3, 8.3],
      ],
      altitude_ft: 7000,
      groundspeed_knots: 140,
    },
    {
      path_id: 2,
      time: 2000,
      coords: [
        [51.0, 9.0],
        [51.1, 9.1],
      ],
      altitude_ft: 4000,
      groundspeed_knots: 110,
    },
  ];

  describe("prepareReplaySegments", () => {
    it("filters and sorts segments by path ID", () => {
      const prepared = prepareReplaySegments(mockSegments, 1);

      expect(prepared).toHaveLength(3);
      expect(prepared.every((s) => s.path_id === 1)).toBe(true);
    });

    it("sorts segments by time", () => {
      const unsorted: PathSegment[] = [
        { path_id: 1, time: 1200 },
        { path_id: 1, time: 1000 },
        { path_id: 1, time: 1100 },
      ];

      const prepared = prepareReplaySegments(unsorted, 1);

      expect(prepared.map((s) => s.time)).toEqual([1000, 1100, 1200]);
    });

    it("filters out segments without time", () => {
      const segments: PathSegment[] = [
        { path_id: 1, time: 1000 },
        { path_id: 1, time: undefined },
        { path_id: 1, time: null as unknown as number },
        { path_id: 1, time: 1100 },
      ];

      const prepared = prepareReplaySegments(segments, 1);

      expect(prepared).toHaveLength(2);
    });

    it("returns empty array for non-existent path ID", () => {
      const prepared = prepareReplaySegments(mockSegments, 999);

      expect(prepared).toHaveLength(0);
    });
  });

  describe("calculateSmoothedBearing", () => {
    const sorted = prepareReplaySegments(mockSegments, 1);

    it("calculates bearing with lookahead", () => {
      const bearing = calculateSmoothedBearing(sorted, 0, 2);

      expect(bearing).toBeGreaterThanOrEqual(0);
      expect(bearing).toBeLessThan(360);
    });

    it("returns null for invalid index", () => {
      expect(calculateSmoothedBearing(sorted, -1)).toBeNull();
      expect(calculateSmoothedBearing(sorted, 999)).toBeNull();
    });

    it("handles last segment", () => {
      const bearing = calculateSmoothedBearing(sorted, sorted.length - 1, 5);

      expect(typeof bearing).toBe("number");
    });

    it("handles segments without enough lookahead", () => {
      const bearing = calculateSmoothedBearing(sorted, sorted.length - 1, 10);

      expect(typeof bearing).toBe("number");
    });

    it("returns null when coordinates are missing", () => {
      const segments: PathSegment[] = [
        { path_id: 1, time: 0 },
        { path_id: 1, time: 10 },
      ];

      expect(calculateSmoothedBearing(segments, 0, 1)).toBeNull();
      expect(calculateSmoothedBearing(segments, 1, 1)).toBeNull();
    });
  });

  describe("calculateBearing", () => {
    it("calculates bearing for due north", () => {
      expect(calculateBearing(0, 0, 1, 0)).toBeCloseTo(0, 1);
    });

    it("calculates bearing for due east", () => {
      expect(calculateBearing(0, 0, 0, 1)).toBeCloseTo(90, 1);
    });

    it("calculates bearing for due south", () => {
      expect(calculateBearing(0, 0, -1, 0)).toBeCloseTo(180, 1);
    });

    it("calculates bearing for due west", () => {
      expect(calculateBearing(0, 0, 0, -1)).toBeCloseTo(270, 1);
    });

    it("returns value between 0 and 360", () => {
      const bearing = calculateBearing(50, 8, 51, 9);
      expect(bearing).toBeGreaterThanOrEqual(0);
      expect(bearing).toBeLessThan(360);
    });
  });
});
