import { describe, it, expect } from "vitest";
import {
  ddToDms,
  calculateBearing,
  calculateSmoothedBearing,
} from "./coordinates";

describe("coordinates utilities", () => {
  describe("ddToDms", () => {
    it("should convert positive latitude correctly", () => {
      const result = ddToDms(52.52, true);
      expect(result).toContain("N");
      expect(result).toContain("52°");
    });

    it("should convert negative latitude correctly", () => {
      const result = ddToDms(-33.87, true);
      expect(result).toContain("S");
      expect(result).toContain("33°");
    });

    it("should convert positive longitude correctly", () => {
      const result = ddToDms(13.405, false);
      expect(result).toContain("E");
      expect(result).toContain("13°");
    });

    it("should convert negative longitude correctly", () => {
      const result = ddToDms(-122.4194, false);
      expect(result).toContain("W");
      expect(result).toContain("122°");
    });

    it("should handle zero correctly", () => {
      const resultLat = ddToDms(0, true);
      const resultLon = ddToDms(0, false);
      expect(resultLat).toContain("N");
      expect(resultLon).toContain("E");
      expect(resultLat).toContain("0°");
    });
  });

  describe("calculateBearing", () => {
    it("should calculate bearing from point A to point B (eastward)", () => {
      const bearing = calculateBearing(0, 0, 0, 1);
      expect(bearing).toBeCloseTo(90, 1);
    });

    it("should calculate bearing from point A to point B (northward)", () => {
      const bearing = calculateBearing(0, 0, 1, 0);
      expect(bearing).toBeCloseTo(0, 1);
    });

    it("should calculate bearing from point A to point B (southward)", () => {
      const bearing = calculateBearing(0, 0, -1, 0);
      expect(bearing).toBeCloseTo(180, 1);
    });

    it("should calculate bearing from point A to point B (westward)", () => {
      const bearing = calculateBearing(0, 0, 0, -1);
      expect(bearing).toBeCloseTo(270, 1);
    });

    it("should return value between 0 and 360", () => {
      const bearing = calculateBearing(52.52, 13.405, 51.5074, -0.1278);
      expect(bearing).toBeGreaterThanOrEqual(0);
      expect(bearing).toBeLessThan(360);
    });
  });

  describe("calculateSmoothedBearing", () => {
    it("should return null for empty array", () => {
      const result = calculateSmoothedBearing([], 0);
      expect(result).toBeNull();
    });

    it("should return null for out of bounds index", () => {
      const segments = [
        {
          coords: [
            [0, 0],
            [1, 1],
          ] as [number, number][],
        },
      ];
      const result = calculateSmoothedBearing(segments, 10);
      expect(result).toBeNull();
    });

    it("should calculate bearing for single segment", () => {
      const segments = [
        {
          coords: [
            [0, 0],
            [1, 1],
          ] as [number, number][],
        },
      ];
      const result = calculateSmoothedBearing(segments, 0, 0);
      expect(result).not.toBeNull();
      expect(typeof result).toBe("number");
    });

    it("should look ahead when multiple segments available", () => {
      const segments = [
        {
          coords: [
            [0, 0],
            [0, 1],
          ] as [number, number][],
        },
        {
          coords: [
            [0, 1],
            [0, 2],
          ] as [number, number][],
        },
        {
          coords: [
            [0, 2],
            [0, 3],
          ] as [number, number][],
        },
      ];
      const result = calculateSmoothedBearing(segments, 0, 2);
      expect(result).not.toBeNull();
      expect(result).toBeCloseTo(90, 1); // Eastward (lat=0, lon increasing)
    });
  });
});
