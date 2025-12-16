import { describe, it, expect } from "vitest";
import { getResolutionForZoom } from "./resolution";

describe("resolution utilities", () => {
  describe("getResolutionForZoom", () => {
    it("should return z0_4 for zoom level 0", () => {
      expect(getResolutionForZoom(0)).toBe("z0_4");
    });

    it("should return z0_4 for zoom level 4", () => {
      expect(getResolutionForZoom(4)).toBe("z0_4");
    });

    it("should return z5_7 for zoom level 5", () => {
      expect(getResolutionForZoom(5)).toBe("z5_7");
    });

    it("should return z5_7 for zoom level 7", () => {
      expect(getResolutionForZoom(7)).toBe("z5_7");
    });

    it("should return z8_10 for zoom level 8", () => {
      expect(getResolutionForZoom(8)).toBe("z8_10");
    });

    it("should return z8_10 for zoom level 10", () => {
      expect(getResolutionForZoom(10)).toBe("z8_10");
    });

    it("should return z11_13 for zoom level 11", () => {
      expect(getResolutionForZoom(11)).toBe("z11_13");
    });

    it("should return z11_13 for zoom level 13", () => {
      expect(getResolutionForZoom(13)).toBe("z11_13");
    });

    it("should return z14_plus for zoom level 14", () => {
      expect(getResolutionForZoom(14)).toBe("z14_plus");
    });

    it("should return z14_plus for zoom level 20", () => {
      expect(getResolutionForZoom(20)).toBe("z14_plus");
    });

    it("should handle fractional zoom levels", () => {
      expect(getResolutionForZoom(4.5)).toBe("z5_7"); // 4.5 > 4, so z5_7
      expect(getResolutionForZoom(7.9)).toBe("z8_10"); // 7.9 > 7, so z8_10
      expect(getResolutionForZoom(13.25)).toBe("z14_plus"); // 13.25 > 13, so z14_plus
    });
  });
});
