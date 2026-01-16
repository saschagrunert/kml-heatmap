import { describe, it, expect } from "vitest";
import {
  formatTime,
  formatDistance,
  formatAltitude,
  formatSpeed,
  getResolutionForZoom,
} from "../../../../kml_heatmap/frontend/utils/formatters";

describe("formatter utilities", () => {
  describe("formatTime", () => {
    it("formats time with hours, minutes, and seconds", () => {
      expect(formatTime(3661)).toBe("1:01:01");
    });

    it("formats time with only minutes and seconds", () => {
      expect(formatTime(330)).toBe("5:30");
    });

    it("pads single-digit minutes and seconds when hours present", () => {
      expect(formatTime(3605)).toBe("1:00:05");
    });

    it("handles zero seconds", () => {
      expect(formatTime(0)).toBe("0:00");
    });

    it("formats large time values", () => {
      expect(formatTime(36000)).toBe("10:00:00");
    });

    it("handles 59 seconds (edge case)", () => {
      expect(formatTime(59)).toBe("0:59");
    });

    it("handles exactly 1 hour", () => {
      expect(formatTime(3600)).toBe("1:00:00");
    });

    it("handles exactly 1 minute", () => {
      expect(formatTime(60)).toBe("1:00");
    });
  });

  describe("formatDistance", () => {
    it("formats distance with default 0 decimals", () => {
      expect(formatDistance(1234)).toBe("1,234 km");
    });

    it("formats distance with specified decimals", () => {
      expect(formatDistance(1234.567, 2)).toBe("1,234.57 km");
    });

    it("handles small distances", () => {
      expect(formatDistance(5)).toBe("5 km");
    });

    it("handles zero distance", () => {
      expect(formatDistance(0)).toBe("0 km");
    });

    it("formats large distances with commas", () => {
      expect(formatDistance(1234567)).toBe("1,234,567 km");
    });

    it("rounds to specified decimals", () => {
      expect(formatDistance(123.456, 1)).toBe("123.5 km");
    });
  });

  describe("formatAltitude", () => {
    it("converts meters to feet", () => {
      // 1000m ≈ 3281 feet
      expect(formatAltitude(1000)).toBe("3,281 ft");
    });

    it("handles zero altitude", () => {
      expect(formatAltitude(0)).toBe("0 ft");
    });

    it("formats high altitudes with commas", () => {
      // 10000m ≈ 32808 feet
      expect(formatAltitude(10000)).toBe("32,808 ft");
    });

    it("rounds to nearest foot", () => {
      const result = formatAltitude(100);
      expect(result).toMatch(/^\d+,?\d* ft$/);
    });
  });

  describe("formatSpeed", () => {
    it("formats speed in knots", () => {
      expect(formatSpeed(120)).toBe("120 kt");
    });

    it("rounds to nearest knot", () => {
      expect(formatSpeed(120.6)).toBe("121 kt");
    });

    it("handles zero speed", () => {
      expect(formatSpeed(0)).toBe("0 kt");
    });

    it("formats high speeds with commas", () => {
      expect(formatSpeed(1234)).toBe("1,234 kt");
    });

    it("rounds down decimal values", () => {
      expect(formatSpeed(120.4)).toBe("120 kt");
    });
  });

  describe("getResolutionForZoom", () => {
    it("returns z0_4 for zoom 0", () => {
      expect(getResolutionForZoom(0)).toBe("z0_4");
    });

    it("returns z0_4 for zoom 4", () => {
      expect(getResolutionForZoom(4)).toBe("z0_4");
    });

    it("returns z5_7 for zoom 5", () => {
      expect(getResolutionForZoom(5)).toBe("z5_7");
    });

    it("returns z5_7 for zoom 7", () => {
      expect(getResolutionForZoom(7)).toBe("z5_7");
    });

    it("returns z8_10 for zoom 8", () => {
      expect(getResolutionForZoom(8)).toBe("z8_10");
    });

    it("returns z8_10 for zoom 10", () => {
      expect(getResolutionForZoom(10)).toBe("z8_10");
    });

    it("returns z11_13 for zoom 11", () => {
      expect(getResolutionForZoom(11)).toBe("z11_13");
    });

    it("returns z11_13 for zoom 13", () => {
      expect(getResolutionForZoom(13)).toBe("z11_13");
    });

    it("returns z14_plus for zoom 14", () => {
      expect(getResolutionForZoom(14)).toBe("z14_plus");
    });

    it("returns z14_plus for high zoom levels", () => {
      expect(getResolutionForZoom(18)).toBe("z14_plus");
    });

    it("handles boundary conditions correctly", () => {
      expect(getResolutionForZoom(4.0)).toBe("z0_4"); // At boundary
      expect(getResolutionForZoom(4.9)).toBe("z5_7"); // Just above boundary
      expect(getResolutionForZoom(5.0)).toBe("z5_7");
      expect(getResolutionForZoom(7.0)).toBe("z5_7"); // At boundary
      expect(getResolutionForZoom(7.9)).toBe("z8_10"); // Just above boundary
      expect(getResolutionForZoom(8.0)).toBe("z8_10");
    });
  });
});
