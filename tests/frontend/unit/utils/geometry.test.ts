import { describe, it, expect } from "vitest";
import {
  calculateDistance,
  calculateBearing,
  ddToDms,
} from "../../../../kml_heatmap/frontend/utils/geometry";

describe("geometry utilities", () => {
  describe("calculateDistance", () => {
    it("calculates distance between Berlin and Paris", () => {
      const berlin = [52.52, 13.405];
      const paris = [48.8566, 2.3522];
      const distance = calculateDistance(berlin, paris);

      // Actual distance is ~877 km
      expect(distance).toBeCloseTo(877, 0);
    });

    it("calculates distance between New York and London", () => {
      const newYork = [40.7128, -74.006];
      const london = [51.5074, -0.1278];
      const distance = calculateDistance(newYork, london);

      // Actual distance is ~5570 km
      expect(distance).toBeCloseTo(5570, -1);
    });

    it("returns 0 for same coordinates", () => {
      const coord = [45.0, 10.0];
      const distance = calculateDistance(coord, coord);
      expect(distance).toBe(0);
    });

    it("handles coordinates across the international date line", () => {
      const coord1 = [0, 179];
      const coord2 = [0, -179];
      const distance = calculateDistance(coord1, coord2);

      // Should be ~222 km (2 degrees at equator)
      expect(distance).toBeCloseTo(222, 0);
    });

    it("handles north-south poles", () => {
      const northPole = [90, 0];
      const southPole = [-90, 0];
      const distance = calculateDistance(northPole, southPole);

      // Half circumference of Earth ~20,015 km
      expect(distance).toBeCloseTo(20015, 0);
    });

    it("is symmetric (A to B equals B to A)", () => {
      const coord1 = [52.52, 13.405];
      const coord2 = [48.8566, 2.3522];
      const dist1 = calculateDistance(coord1, coord2);
      const dist2 = calculateDistance(coord2, coord1);

      expect(dist1).toBeCloseTo(dist2, 6);
    });
  });

  describe("calculateBearing", () => {
    it("calculates bearing for due north", () => {
      const bearing = calculateBearing(0, 0, 1, 0);
      expect(bearing).toBeCloseTo(0, 1);
    });

    it("calculates bearing for due east", () => {
      const bearing = calculateBearing(0, 0, 0, 1);
      expect(bearing).toBeCloseTo(90, 1);
    });

    it("calculates bearing for due south", () => {
      const bearing = calculateBearing(0, 0, -1, 0);
      expect(bearing).toBeCloseTo(180, 1);
    });

    it("calculates bearing for due west", () => {
      const bearing = calculateBearing(0, 0, 0, -1);
      expect(bearing).toBeCloseTo(270, 1);
    });

    it("calculates bearing from Berlin to Paris", () => {
      const bearing = calculateBearing(52.52, 13.405, 48.8566, 2.3522);
      // Southwest direction (~240-250 degrees)
      expect(bearing).toBeGreaterThan(230);
      expect(bearing).toBeLessThan(260);
    });

    it("returns value between 0 and 360", () => {
      const bearing = calculateBearing(45, -120, -30, 150);
      expect(bearing).toBeGreaterThanOrEqual(0);
      expect(bearing).toBeLessThan(360);
    });

    it("handles same coordinates", () => {
      const bearing = calculateBearing(45, 10, 45, 10);
      // Bearing is undefined for same point, but function should return a number
      expect(typeof bearing).toBe("number");
      expect(bearing).toBeGreaterThanOrEqual(0);
      expect(bearing).toBeLessThan(360);
    });
  });

  describe("ddToDms", () => {
    it("converts positive latitude to DMS", () => {
      const result = ddToDms(52.52, true);
      expect(result).toBe("52°31'12.0\"N");
    });

    it("converts negative latitude to DMS", () => {
      const result = ddToDms(-33.8688, true);
      expect(result).toBe("33°52'7.7\"S");
    });

    it("converts positive longitude to DMS", () => {
      const result = ddToDms(13.405, false);
      expect(result).toBe("13°24'18.0\"E");
    });

    it("converts negative longitude to DMS", () => {
      const result = ddToDms(-122.4194, false);
      expect(result).toBe("122°25'9.8\"W");
    });

    it("handles zero latitude", () => {
      const result = ddToDms(0, true);
      expect(result).toBe("0°0'0.0\"N");
    });

    it("handles zero longitude", () => {
      const result = ddToDms(0, false);
      expect(result).toBe("0°0'0.0\"E");
    });

    it("handles exact degrees (no minutes/seconds)", () => {
      const result = ddToDms(45.0, true);
      expect(result).toBe("45°0'0.0\"N");
    });

    it("handles maximum latitude", () => {
      const result = ddToDms(90, true);
      expect(result).toBe("90°0'0.0\"N");
    });

    it("handles maximum longitude", () => {
      const result = ddToDms(180, false);
      expect(result).toBe("180°0'0.0\"E");
    });

    it("formats seconds with one decimal place", () => {
      const result = ddToDms(51.50735, true);
      expect(result).toMatch(/\d+°\d+'\d+\.\d"/);
    });
  });
});
