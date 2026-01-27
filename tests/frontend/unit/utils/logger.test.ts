import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  initLogger,
  logDebug,
  logInfo,
  logWarn,
  logError,
  isDebugEnabled,
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

  describe("initLogger", () => {
    it("enables debug when URL has debug=true", () => {
      (window as any).location.search = "?debug=true";

      initLogger();

      expect(isDebugEnabled()).toBe(true);
    });

    it("disables debug when URL does not have debug=true", () => {
      (window as any).location.search = "";

      initLogger();

      expect(isDebugEnabled()).toBe(false);
    });

    it("disables debug when debug parameter is not 'true'", () => {
      (window as any).location.search = "?debug=false";

      initLogger();

      expect(isDebugEnabled()).toBe(false);
    });
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

  describe("logInfo", () => {
    it("logs when debug is enabled", () => {
      (window as any).location.search = "?debug=true";
      initLogger(); // Initialize with debug enabled

      const consoleSpy = vi.spyOn(console, "info");

      logInfo("info message", { key: "value" });
      expect(consoleSpy).toHaveBeenCalledWith("info message", { key: "value" });
    });

    it("does not log when debug is disabled", () => {
      (window as any).location.search = "";
      initLogger(); // Initialize with debug disabled

      const consoleSpy = vi.spyOn(console, "info");

      logInfo("info message");
      expect(consoleSpy).not.toHaveBeenCalled();
    });
  });

  describe("logWarn", () => {
    it("always logs warnings", () => {
      const consoleSpy = vi.spyOn(console, "warn");

      logWarn("warning message");
      expect(consoleSpy).toHaveBeenCalledWith("warning message");
    });

    it("logs warnings with multiple arguments", () => {
      const consoleSpy = vi.spyOn(console, "warn");

      logWarn("warning:", "critical", 500);
      expect(consoleSpy).toHaveBeenCalledWith("warning:", "critical", 500);
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

  describe("isDebugEnabled", () => {
    it("returns true when debug is enabled", () => {
      (window as any).location.search = "?debug=true";
      initLogger();

      expect(isDebugEnabled()).toBe(true);
    });

    it("returns false when debug is disabled", () => {
      (window as any).location.search = "";
      initLogger();

      expect(isDebugEnabled()).toBe(false);
    });

    it("auto-initializes on first call", () => {
      (window as any).location.search = "?debug=true&other=param";
      initLogger(); // Need to re-init after changing search

      expect(isDebugEnabled()).toBe(true);
    });
  });
});
