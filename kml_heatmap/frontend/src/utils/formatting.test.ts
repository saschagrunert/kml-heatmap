import { describe, it, expect } from "vitest";
import {
  formatTime,
  getColorForAltitude,
  getColorForAirspeed,
} from "./formatting";

describe("formatting utilities", () => {
  describe("formatTime", () => {
    it("should format seconds only", () => {
      expect(formatTime(45)).toBe("45s");
    });

    it("should format minutes and seconds", () => {
      expect(formatTime(125)).toBe("2m 5s");
    });

    it("should format hours, minutes, and seconds", () => {
      expect(formatTime(3665)).toBe("1h 1m 5s");
    });

    it("should handle zero", () => {
      expect(formatTime(0)).toBe("0s");
    });

    it("should handle large values", () => {
      const result = formatTime(36000); // 10 hours
      expect(result).toBe("10h 0m 0s");
    });
  });

  describe("getColorForAltitude", () => {
    it("should return blue for minimum altitude", () => {
      const color = getColorForAltitude(0, 0, 10000);
      expect(color).toContain("rgb");
      expect(color).toContain("0");
      expect(color).toContain("255"); // Blue component
    });

    it("should return red for maximum altitude", () => {
      const color = getColorForAltitude(10000, 0, 10000);
      expect(color).toContain("rgb");
      expect(color).toContain("255");
      expect(color).toContain("0"); // Green component at end
    });

    it("should return intermediate color for mid-range altitude", () => {
      const color = getColorForAltitude(5000, 0, 10000);
      expect(color).toContain("rgb");
    });

    it("should handle values outside range (clamp to min)", () => {
      const color = getColorForAltitude(-1000, 0, 10000);
      expect(color).toContain("rgb");
    });

    it("should handle values outside range (clamp to max)", () => {
      const color = getColorForAltitude(15000, 0, 10000);
      expect(color).toContain("rgb");
    });
  });

  describe("getColorForAirspeed", () => {
    it("should return purple for minimum speed", () => {
      const color = getColorForAirspeed(0, 0, 200);
      expect(color).toContain("rgb");
      expect(color).toContain("128"); // Purple
    });

    it("should return yellow for maximum speed", () => {
      const color = getColorForAirspeed(200, 0, 200);
      expect(color).toContain("rgb");
      expect(color).toContain("255");
    });

    it("should return intermediate color for mid-range speed", () => {
      const color = getColorForAirspeed(100, 0, 200);
      expect(color).toContain("rgb");
    });

    it("should handle values outside range", () => {
      const color1 = getColorForAirspeed(-50, 0, 200);
      const color2 = getColorForAirspeed(300, 0, 200);
      expect(color1).toContain("rgb");
      expect(color2).toContain("rgb");
    });
  });
});
