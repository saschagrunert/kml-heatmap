import { describe, it, expect } from "vitest";
import {
  prepareReplaySegments,
  calculateTimeRange,
  findSegmentsAtTime,
  interpolatePosition,
  calculateSmoothedBearing,
  calculateAutoZoom,
  shouldRecenter,
  calculateReplayProgress,
  validateReplayData,
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

  describe("calculateTimeRange", () => {
    it("calculates min and max time", () => {
      const segments: PathSegment[] = [
        { path_id: 1, time: 1000 },
        { path_id: 1, time: 1500 },
        { path_id: 1, time: 1200 },
      ];

      const range = calculateTimeRange(segments);

      expect(range.min).toBe(1000);
      expect(range.max).toBe(1500);
    });

    it("handles empty array", () => {
      const range = calculateTimeRange([]);

      expect(range.min).toBe(0);
      expect(range.max).toBe(0);
    });

    it("handles single segment", () => {
      const range = calculateTimeRange([{ path_id: 1, time: 1000 }]);

      expect(range.min).toBe(1000);
      expect(range.max).toBe(1000);
    });
  });

  describe("findSegmentsAtTime", () => {
    const sorted = prepareReplaySegments(mockSegments, 1);

    it("finds current and next segment", () => {
      const result = findSegmentsAtTime(sorted, 1050);

      expect(result.current?.time).toBe(1000);
      expect(result.next?.time).toBe(1100);
      expect(result.index).toBe(0);
    });

    it("finds segment at exact time", () => {
      const result = findSegmentsAtTime(sorted, 1100);

      expect(result.current?.time).toBe(1100);
      expect(result.next?.time).toBe(1200);
      expect(result.index).toBe(1);
    });

    it("handles time at end of replay", () => {
      const result = findSegmentsAtTime(sorted, 1200);

      expect(result.current?.time).toBe(1200);
      expect(result.next).toBeNull();
      expect(result.index).toBe(2);
    });

    it("handles time before first segment", () => {
      const result = findSegmentsAtTime(sorted, 0);

      expect(result.current).toBe(sorted[0]);
      expect(result.next).toBe(sorted[1]);
    });

    it("handles empty segments", () => {
      const result = findSegmentsAtTime([], 1000);

      expect(result.current).toBeNull();
      expect(result.next).toBeNull();
      expect(result.index).toBe(-1);
    });
  });

  describe("interpolatePosition", () => {
    const seg1: PathSegment = {
      path_id: 1,
      time: 1000,
      coords: [
        [50.0, 8.0],
        [50.1, 8.1],
      ],
      altitude_ft: 5000,
      groundspeed_knots: 120,
    };

    const seg2: PathSegment = {
      path_id: 1,
      time: 1100,
      coords: [
        [50.1, 8.1],
        [50.2, 8.2],
      ],
      altitude_ft: 6000,
      groundspeed_knots: 130,
    };

    it("interpolates position halfway between segments", () => {
      const pos = interpolatePosition(seg1, seg2, 1050);

      // seg1 end and seg2 start are the same point, so the position stays
      expect(pos.lat).toBeCloseTo(50.1, 5);
      expect(pos.lon).toBeCloseTo(8.1, 5);
      expect(pos.altitude).toBeCloseTo(5500, 0);
      expect(pos.speed).toBeCloseTo(125, 0);
    });

    it("interpolates at start time", () => {
      const pos = interpolatePosition(seg1, seg2, 1000);

      expect(pos.lat).toBeCloseTo(50.1, 5);
      expect(pos.lon).toBeCloseTo(8.1, 5);
      expect(pos.altitude).toBe(5000);
    });

    it("interpolates at end time", () => {
      const pos = interpolatePosition(seg1, seg2, 1100);

      expect(pos.lat).toBeCloseTo(50.1, 5);
      expect(pos.lon).toBeCloseTo(8.1, 5);
      expect(pos.altitude).toBe(6000);
    });

    it("handles last segment without next", () => {
      const pos = interpolatePosition(seg1, null, 1050);

      expect(pos.lat).toBe(50.1);
      expect(pos.lon).toBe(8.1);
      expect(pos.altitude).toBe(5000);
      expect(pos.speed).toBe(120);
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

  describe("calculateAutoZoom", () => {
    it("returns max zoom for low altitude and speed", () => {
      expect(calculateAutoZoom(1000, 50)).toBeGreaterThan(13);
    });

    it("returns lower zoom for high altitude and speed", () => {
      expect(calculateAutoZoom(10000, 200)).toBeLessThan(13);
    });

    it("respects min and max zoom bounds", () => {
      const zoom1 = calculateAutoZoom(0, 0, { minZoom: 10, maxZoom: 16 });
      const zoom2 = calculateAutoZoom(20000, 500, { minZoom: 10, maxZoom: 16 });

      expect(zoom1).toBeGreaterThanOrEqual(10);
      expect(zoom1).toBeLessThanOrEqual(16);
      expect(zoom2).toBeGreaterThanOrEqual(10);
      expect(zoom2).toBeLessThanOrEqual(16);
    });

    it("uses custom cruise values", () => {
      const zoom = calculateAutoZoom(10000, 200, {
        minZoom: 10,
        maxZoom: 16,
        cruiseAltitude: 10000,
        cruiseSpeed: 200,
      });

      // Both factors are exactly 1: halfway between min and max zoom
      expect(zoom).toBe(13);
    });
  });

  describe("shouldRecenter", () => {
    const bounds = {
      north: 51.0,
      south: 50.0,
      east: 9.0,
      west: 8.0,
    };

    it("returns false when position is in center", () => {
      expect(shouldRecenter({ lat: 50.5, lon: 8.5 }, bounds)).toBe(false);
    });

    it("returns true when position is near north edge", () => {
      expect(shouldRecenter({ lat: 50.95, lon: 8.5 }, bounds)).toBe(true);
    });

    it("returns true when position is near south edge", () => {
      expect(shouldRecenter({ lat: 50.05, lon: 8.5 }, bounds)).toBe(true);
    });

    it("returns true when position is near east edge", () => {
      expect(shouldRecenter({ lat: 50.5, lon: 8.95 }, bounds)).toBe(true);
    });

    it("returns true when position is near west edge", () => {
      expect(shouldRecenter({ lat: 50.5, lon: 8.05 }, bounds)).toBe(true);
    });

    it("respects custom margin", () => {
      const position = { lat: 50.5, lon: 8.85 };

      expect(shouldRecenter(position, bounds, 0.1)).toBe(false);
      expect(shouldRecenter(position, bounds, 0.2)).toBe(true);
    });
  });

  describe("calculateReplayProgress", () => {
    it("calculates progress percentage", () => {
      expect(calculateReplayProgress(50, 100)).toBe(50);
      expect(calculateReplayProgress(25, 100)).toBe(25);
      expect(calculateReplayProgress(100, 100)).toBe(100);
    });

    it("handles zero max time", () => {
      expect(calculateReplayProgress(50, 0)).toBe(0);
    });

    it("caps at 100%", () => {
      expect(calculateReplayProgress(150, 100)).toBe(100);
    });

    it("handles zero current time", () => {
      expect(calculateReplayProgress(0, 100)).toBe(0);
    });
  });

  describe("validateReplayData", () => {
    it("validates correct replay data", () => {
      const result = validateReplayData(mockSegments);

      expect(result.valid).toBe(true);
      expect(result.message).toContain("valid");
    });

    it("rejects null segments", () => {
      const result = validateReplayData(null as unknown as PathSegment[]);

      expect(result.valid).toBe(false);
      expect(result.message).toContain("No segments");
    });

    it("rejects empty segments", () => {
      const result = validateReplayData([]);

      expect(result.valid).toBe(false);
      expect(result.message).toContain("No segments");
    });

    it("rejects segments without time data", () => {
      const segments: PathSegment[] = [
        { path_id: 1, altitude_ft: 5000 },
        { path_id: 1, time: undefined },
      ];

      const result = validateReplayData(segments);

      expect(result.valid).toBe(false);
      expect(result.message).toContain("No timestamp data");
    });

    it("accepts segments with partial time data", () => {
      const segments: PathSegment[] = [
        { path_id: 1, time: 1000 },
        { path_id: 1, time: undefined },
      ];

      expect(validateReplayData(segments).valid).toBe(true);
    });
  });
});
