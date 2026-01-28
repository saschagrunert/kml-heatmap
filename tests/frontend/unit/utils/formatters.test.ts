import { describe, it, expect } from "vitest";
import {
  formatTime,
  formatDistance,
  formatAltitude,
  formatSpeed,
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
      expect(formatDistance(1234)).toBe("1234 km");
    });

    it("formats distance with specified decimals", () => {
      expect(formatDistance(1234.567, 2)).toBe("1234.57 km");
    });

    it("handles small distances", () => {
      expect(formatDistance(5)).toBe("5 km");
    });

    it("handles zero distance", () => {
      expect(formatDistance(0)).toBe("0 km");
    });

    it("formats large distances", () => {
      expect(formatDistance(1234567)).toBe("1234567 km");
    });

    it("rounds to specified decimals", () => {
      expect(formatDistance(123.456, 1)).toBe("123.5 km");
    });
  });

  describe("formatAltitude", () => {
    it("converts meters to feet", () => {
      // 1000m ≈ 3281 feet
      expect(formatAltitude(1000)).toBe("3281 ft");
    });

    it("handles zero altitude", () => {
      expect(formatAltitude(0)).toBe("0 ft");
    });

    it("formats high altitudes", () => {
      // 10000m ≈ 32808 feet
      expect(formatAltitude(10000)).toBe("32808 ft");
    });

    it("rounds to nearest foot", () => {
      const result = formatAltitude(100);
      expect(result).toMatch(/^\d+ ft$/);
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

    it("formats high speeds", () => {
      expect(formatSpeed(1234)).toBe("1234 kt");
    });

    it("rounds down decimal values", () => {
      expect(formatSpeed(120.4)).toBe("120 kt");
    });
  });
});
