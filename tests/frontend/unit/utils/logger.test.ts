import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  initLogger,
  logDebug,
  logError,
} from "../../../../kml_heatmap/frontend/utils/logger";

describe("logger utilities", () => {
  beforeEach(() => {
    // Reset console spies
    vi.restoreAllMocks();

    // Mock window.location for all tests
    delete (window as any).location;
    (window as any).location = {
      search: "",
      href: "http://localhost/",
      protocol: "http:",
      host: "localhost",
      hostname: "localhost",
      port: "",
      pathname: "/",
      hash: "",
      origin: "http://localhost",
    };

    // Force logger to re-initialize by calling initLogger
    // This ensures each test starts with a clean state
    initLogger();
  });

  afterEach(() => {
    // Clean up
    vi.restoreAllMocks();
  });

  describe("logDebug", () => {
    it("logs when debug is enabled", () => {
      (window as any).location.search = "?debug=true";
      initLogger(); // Initialize with debug enabled

      const consoleSpy = vi.spyOn(console, "log");

      logDebug("debug message", 123);
      expect(consoleSpy).toHaveBeenCalledWith("debug message", 123);
    });

    it("does not log when debug is disabled", () => {
      (window as any).location.search = "";
      initLogger(); // Initialize with debug disabled

      const consoleSpy = vi.spyOn(console, "log");

      logDebug("debug message");
      expect(consoleSpy).not.toHaveBeenCalled();
    });
  });

  describe("logError", () => {
    it("always logs errors", () => {
      const consoleSpy = vi.spyOn(console, "error");

      logError("error message");
      expect(consoleSpy).toHaveBeenCalledWith("error message");
    });

    it("logs errors with error objects", () => {
      const consoleSpy = vi.spyOn(console, "error");
      const error = new Error("test error");

      logError("Failed:", error);
      expect(consoleSpy).toHaveBeenCalledWith("Failed:", error);
    });
  });
});
