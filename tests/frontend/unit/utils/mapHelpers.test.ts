import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { invalidateMapWithDelay } from "../../../../kml_heatmap/frontend/utils/mapHelpers";

describe("mapHelpers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe("invalidateMapWithDelay", () => {
    it("calls invalidateSize after default delay", () => {
      const mockMap = {
        invalidateSize: vi.fn(),
      } as any;

      invalidateMapWithDelay(mockMap);

      expect(mockMap.invalidateSize).not.toHaveBeenCalled();

      vi.advanceTimersByTime(50);

      expect(mockMap.invalidateSize).toHaveBeenCalledOnce();
    });

    it("calls invalidateSize after custom delay", () => {
      const mockMap = {
        invalidateSize: vi.fn(),
      } as any;

      invalidateMapWithDelay(mockMap, 100);

      expect(mockMap.invalidateSize).not.toHaveBeenCalled();

      vi.advanceTimersByTime(99);
      expect(mockMap.invalidateSize).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(mockMap.invalidateSize).toHaveBeenCalledOnce();
    });

    it("does not call invalidateSize if map is null", () => {
      invalidateMapWithDelay(null);

      vi.advanceTimersByTime(50);

      // No error should be thrown
      expect(true).toBe(true);
    });

    it("handles zero delay", () => {
      const mockMap = {
        invalidateSize: vi.fn(),
      } as any;

      invalidateMapWithDelay(mockMap, 0);

      expect(mockMap.invalidateSize).not.toHaveBeenCalled();

      vi.advanceTimersByTime(0);

      expect(mockMap.invalidateSize).toHaveBeenCalledOnce();
    });

    it("only calls invalidateSize once per invocation", () => {
      const mockMap = {
        invalidateSize: vi.fn(),
      } as any;

      invalidateMapWithDelay(mockMap);

      vi.advanceTimersByTime(50);
      expect(mockMap.invalidateSize).toHaveBeenCalledOnce();

      vi.advanceTimersByTime(50);
      expect(mockMap.invalidateSize).toHaveBeenCalledOnce(); // Still only once
    });

    it("can be called multiple times independently", () => {
      const mockMap = {
        invalidateSize: vi.fn(),
      } as any;

      invalidateMapWithDelay(mockMap, 25);
      invalidateMapWithDelay(mockMap, 50);

      vi.advanceTimersByTime(25);
      expect(mockMap.invalidateSize).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(25);
      expect(mockMap.invalidateSize).toHaveBeenCalledTimes(2);
    });
  });
});
