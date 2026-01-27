import { describe, it, expect } from "vitest";
import {
  findMin,
  findMax,
  findMinMax,
} from "../../../../kml_heatmap/frontend/utils/arrayHelpers";

describe("arrayHelpers", () => {
  describe("findMin", () => {
    it("finds minimum value in array", () => {
      expect(findMin([5, 2, 8, 1, 9])).toBe(1);
    });

    it("handles single element", () => {
      expect(findMin([42])).toBe(42);
    });

    it("handles negative numbers", () => {
      expect(findMin([-5, -2, -8, -1])).toBe(-8);
    });

    it("handles mixed positive and negative", () => {
      expect(findMin([5, -2, 8, -10, 3])).toBe(-10);
    });

    it("handles all same values", () => {
      expect(findMin([7, 7, 7, 7])).toBe(7);
    });

    it("returns 0 for empty array", () => {
      expect(findMin([])).toBe(0);
    });

    it("handles large arrays efficiently", () => {
      const largeArray = Array.from({ length: 100000 }, (_, i) => i);
      expect(findMin(largeArray)).toBe(0);
    });

    it("handles decimals", () => {
      expect(findMin([1.5, 0.3, 2.7, 0.1])).toBe(0.1);
    });
  });

  describe("findMax", () => {
    it("finds maximum value in array", () => {
      expect(findMax([5, 2, 8, 1, 9])).toBe(9);
    });

    it("handles single element", () => {
      expect(findMax([42])).toBe(42);
    });

    it("handles negative numbers", () => {
      expect(findMax([-5, -2, -8, -1])).toBe(-1);
    });

    it("handles mixed positive and negative", () => {
      expect(findMax([5, -2, 8, -10, 3])).toBe(8);
    });

    it("handles all same values", () => {
      expect(findMax([7, 7, 7, 7])).toBe(7);
    });

    it("returns 0 for empty array", () => {
      expect(findMax([])).toBe(0);
    });

    it("handles large arrays efficiently", () => {
      const largeArray = Array.from({ length: 100000 }, (_, i) => i);
      expect(findMax(largeArray)).toBe(99999);
    });

    it("handles decimals", () => {
      expect(findMax([1.5, 0.3, 2.7, 0.1])).toBe(2.7);
    });
  });

  describe("findMinMax", () => {
    it("finds both min and max in one pass", () => {
      const result = findMinMax([5, 2, 8, 1, 9]);
      expect(result.min).toBe(1);
      expect(result.max).toBe(9);
    });

    it("handles single element", () => {
      const result = findMinMax([42]);
      expect(result.min).toBe(42);
      expect(result.max).toBe(42);
    });

    it("handles negative numbers", () => {
      const result = findMinMax([-5, -2, -8, -1]);
      expect(result.min).toBe(-8);
      expect(result.max).toBe(-1);
    });

    it("handles mixed positive and negative", () => {
      const result = findMinMax([5, -2, 8, -10, 3]);
      expect(result.min).toBe(-10);
      expect(result.max).toBe(8);
    });

    it("handles all same values", () => {
      const result = findMinMax([7, 7, 7, 7]);
      expect(result.min).toBe(7);
      expect(result.max).toBe(7);
    });

    it("returns {min: 0, max: 0} for empty array", () => {
      const result = findMinMax([]);
      expect(result.min).toBe(0);
      expect(result.max).toBe(0);
    });

    it("handles large arrays efficiently", () => {
      const largeArray = Array.from({ length: 100000 }, (_, i) => i);
      const result = findMinMax(largeArray);
      expect(result.min).toBe(0);
      expect(result.max).toBe(99999);
    });

    it("handles decimals", () => {
      const result = findMinMax([1.5, 0.3, 2.7, 0.1]);
      expect(result.min).toBe(0.1);
      expect(result.max).toBe(2.7);
    });

    it("is more efficient than calling findMin and findMax separately", () => {
      // This is a behavioral test - findMinMax should complete quickly
      const largeArray = Array.from(
        { length: 1000000 },
        () => Math.random() * 1000
      );

      const start = performance.now();
      findMinMax(largeArray);
      const durationCombined = performance.now() - start;

      const start2 = performance.now();
      findMin(largeArray);
      findMax(largeArray);
      const durationSeparate = performance.now() - start2;

      // findMinMax should be faster (single pass vs two passes)
      // We use 1.5x as a threshold to account for performance variance
      expect(durationCombined).toBeLessThan(durationSeparate * 1.5);
    });
  });
});
