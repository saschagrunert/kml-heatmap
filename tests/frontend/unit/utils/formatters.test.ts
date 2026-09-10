import { describe, it, expect } from "vitest";
import {
  formatTime,
  formatSpeed,
  formatFileSize,
} from "../../../../kml_heatmap/frontend/utils/formatters";

describe("formatter utilities", () => {
  describe("formatFileSize", () => {
    it("formats bytes, KB, MB and GB", () => {
      expect(formatFileSize(0)).toBe("0 B");
      expect(formatFileSize(512)).toBe("512 B");
      expect(formatFileSize(1024)).toBe("1.0 KB");
      expect(formatFileSize(15 * 1024)).toBe("15 KB");
      expect(formatFileSize(1.1 * 1024 * 1024)).toBe("1.1 MB");
      expect(formatFileSize(24 * 1024 * 1024)).toBe("24 MB");
      expect(formatFileSize(2.5 * 1024 * 1024 * 1024)).toBe("2.5 GB");
    });

    it("handles invalid input", () => {
      expect(formatFileSize(-1)).toBe("0 B");
      expect(formatFileSize(NaN)).toBe("0 B");
      expect(formatFileSize(Infinity)).toBe("0 B");
    });
  });

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
