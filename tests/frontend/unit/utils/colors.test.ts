import { describe, it, expect } from "vitest";
import {
  getColorForAltitude,
  getColorForAirspeed,
  parseRgb,
} from "../../../../kml_heatmap/frontend/utils/colors";

describe("color utilities", () => {
  describe("getColorForAltitude", () => {
    it("returns light blue for minimum altitude", () => {
      const color = getColorForAltitude(0, 0, 10000);
      const { r, g, b } = parseRgb(color);

      // Should be light blue (low red, medium-high green, high blue)
      expect(r).toBeLessThan(100);
      expect(g).toBeGreaterThan(150);
      expect(b).toBe(255);
    });

    it("returns light red for maximum altitude", () => {
      const color = getColorForAltitude(10000, 0, 10000);
      const { r, g, b } = parseRgb(color);

      // Should be light red (high red, low green, some blue)
      expect(r).toBe(255);
      expect(g).toBeLessThan(100);
      expect(b).toBeGreaterThan(0);
    });

    it("returns green for mid-range altitude", () => {
      const color = getColorForAltitude(5000, 0, 10000);
      const { r, g, b } = parseRgb(color);

      // Mid-range should be green-yellow range
      expect(r).toBeGreaterThan(0);
      expect(g).toBe(255);
      expect(b).toBeLessThan(50);
    });

    it("clamps values below minimum to minimum color", () => {
      const color1 = getColorForAltitude(-1000, 0, 10000);
      const color2 = getColorForAltitude(0, 0, 10000);
      expect(color1).toBe(color2);
    });

    it("clamps values above maximum to maximum color", () => {
      const color1 = getColorForAltitude(15000, 0, 10000);
      const color2 = getColorForAltitude(10000, 0, 10000);
      expect(color1).toBe(color2);
    });

    it("handles zero range (min === max)", () => {
      const color = getColorForAltitude(5000, 5000, 5000);
      const { r, g, b } = parseRgb(color);

      // Should return minimum color when range is zero
      expect(typeof r).toBe("number");
      expect(typeof g).toBe("number");
      expect(typeof b).toBe("number");
    });

    it("returns valid RGB string format", () => {
      const color = getColorForAltitude(5000, 0, 10000);
      expect(color).toMatch(/^rgb\(\d+,\d+,\d+\)$/);
    });

    it("produces smooth gradient across range", () => {
      const colors = [];
      for (let i = 0; i <= 10; i++) {
        const alt = i * 1000;
        colors.push(getColorForAltitude(alt, 0, 10000));
      }

      // All colors should be unique (smooth gradient)
      const uniqueColors = new Set(colors);
      expect(uniqueColors.size).toBeGreaterThan(5);
    });
  });

  describe("getColorForAirspeed", () => {
    it("returns blue for minimum speed", () => {
      const color = getColorForAirspeed(0, 0, 200);
      const { r, g, b } = parseRgb(color);

      // Should be blue (low red, medium green, high blue)
      expect(r).toBe(0);
      expect(g).toBeGreaterThan(100);
      expect(b).toBe(255);
    });

    it("returns red for maximum speed", () => {
      const color = getColorForAirspeed(200, 0, 200);
      const { r, g, b } = parseRgb(color);

      // Should be red (high red, low green, no blue)
      expect(r).toBe(255);
      expect(g).toBeLessThan(50);
      expect(b).toBe(0);
    });

    it("returns green-yellow for mid-range speed", () => {
      const color = getColorForAirspeed(100, 0, 200);
      const { r: _r, g, b: _b } = parseRgb(color);

      // Mid-range should be green-yellow
      expect(g).toBe(255);
    });

    it("clamps values below minimum", () => {
      const color1 = getColorForAirspeed(-50, 0, 200);
      const color2 = getColorForAirspeed(0, 0, 200);
      expect(color1).toBe(color2);
    });

    it("clamps values above maximum", () => {
      const color1 = getColorForAirspeed(300, 0, 200);
      const color2 = getColorForAirspeed(200, 0, 200);
      expect(color1).toBe(color2);
    });

    it("handles zero range", () => {
      const color = getColorForAirspeed(100, 100, 100);
      expect(color).toMatch(/^rgb\(\d+,\d+,\d+\)$/);
    });

    it("returns valid RGB string format", () => {
      const color = getColorForAirspeed(100, 0, 200);
      expect(color).toMatch(/^rgb\(\d+,\d+,\d+\)$/);
    });

    it("produces smooth gradient", () => {
      const colors = [];
      for (let i = 0; i <= 10; i++) {
        const speed = i * 20;
        colors.push(getColorForAirspeed(speed, 0, 200));
      }

      const uniqueColors = new Set(colors);
      expect(uniqueColors.size).toBeGreaterThan(5);
    });
  });

  describe("parseRgb", () => {
    it("parses valid RGB string", () => {
      const result = parseRgb("rgb(255,128,0)");
      expect(result).toEqual({ r: 255, g: 128, b: 0 });
    });

    it("parses RGB string with spaces", () => {
      const result = parseRgb("rgb(255, 128, 0)");
      expect(result).toEqual({ r: 255, g: 128, b: 0 });
    });

    it("handles single-digit values", () => {
      const result = parseRgb("rgb(0,5,9)");
      expect(result).toEqual({ r: 0, g: 5, b: 9 });
    });

    it("handles maximum RGB values", () => {
      const result = parseRgb("rgb(255,255,255)");
      expect(result).toEqual({ r: 255, g: 255, b: 255 });
    });

    it("returns zero values for invalid string", () => {
      const result = parseRgb("invalid");
      expect(result).toEqual({ r: 0, g: 0, b: 0 });
    });

    it("returns zero values for empty string", () => {
      const result = parseRgb("");
      expect(result).toEqual({ r: 0, g: 0, b: 0 });
    });

    it("can parse output from getColorForAltitude", () => {
      const color = getColorForAltitude(5000, 0, 10000);
      const { r, g, b } = parseRgb(color);

      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThanOrEqual(255);
      expect(g).toBeGreaterThanOrEqual(0);
      expect(g).toBeLessThanOrEqual(255);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThanOrEqual(255);
    });
  });
});
