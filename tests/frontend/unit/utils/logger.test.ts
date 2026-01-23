import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  logWarn,
  logError,
} from "../../../../kml_heatmap/frontend/utils/logger";

describe("logger utilities", () => {
  beforeEach(() => {
    // Reset console spies
    vi.restoreAllMocks();
  });

  describe("logWarn", () => {
    it("always logs warnings", () => {
      const consoleSpy = vi.spyOn(console, "warn");

      logWarn("warning message");
      expect(consoleSpy).toHaveBeenCalledWith("warning message");
    });
  });

  describe("logError", () => {
    it("always logs errors", () => {
      const consoleSpy = vi.spyOn(console, "error");

      logError("error message");
      expect(consoleSpy).toHaveBeenCalledWith("error message");
    });
  });
});
