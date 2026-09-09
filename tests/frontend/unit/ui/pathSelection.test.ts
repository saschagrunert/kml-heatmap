import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PathSelection } from "../../../../kml_heatmap/frontend/ui/pathSelection";
import { createMockApp, asMapApp, type MockApp } from "../../testHelpers";

const mapHelpers = vi.hoisted(() => ({ invalidateMapWithDelay: vi.fn() }));
vi.mock("../../../../kml_heatmap/frontend/utils/mapHelpers", () => mapHelpers);

describe("PathSelection", () => {
  let pathSelection: PathSelection;
  let mockApp: MockApp;
  let btn: HTMLButtonElement;

  beforeEach(() => {
    vi.clearAllMocks();
    btn = document.createElement("button");
    btn.id = "isolate-btn";
    document.body.appendChild(btn);

    mockApp = createMockApp({
      airportToPaths: {
        EDDF: new Set([1, 2, 3]),
        EDDM: new Set([4, 5]),
      },
    });
    pathSelection = new PathSelection(asMapApp(mockApp));
  });

  afterEach(() => {
    btn.remove();
  });

  async function flush(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
  }

  describe("togglePathSelection", () => {
    it("adds path when not selected and notifies the store", () => {
      const notify = vi.spyOn(mockApp.store, "notifyMutation");

      pathSelection.togglePathSelection(1);

      expect(mockApp.selectedPathIds.has(1)).toBe(true);
      expect(notify).toHaveBeenCalledWith("selectedPathIds");
      expect(
        mockApp.replayManager.updateReplayButtonState,
      ).toHaveBeenCalledTimes(1);
    });

    it("removes path when already selected", () => {
      mockApp.selectedPathIds.add(1);

      pathSelection.togglePathSelection(1);

      expect(mockApp.selectedPathIds.has(1)).toBe(false);
    });

    it("restyles polylines in place and refreshes stats and airports", () => {
      mockApp.altitudeVisible = true;

      pathSelection.togglePathSelection(1);

      expect(mockApp.layerManager.updateSelectionStyles).toHaveBeenCalledTimes(
        1,
      );
      expect(mockApp.layerManager.redrawAltitudePaths).not.toHaveBeenCalled();
      expect(
        mockApp.statsManager.updateStatsForSelection,
      ).toHaveBeenCalledTimes(1);
      expect(mockApp.airportManager.updateAirportOpacity).toHaveBeenCalledTimes(
        1,
      );
      expect(mapHelpers.invalidateMapWithDelay).toHaveBeenCalledWith(
        mockApp.map,
      );
      expect(mockApp.dataManager.updateLayers).not.toHaveBeenCalled();
    });

    it("does not invalidate the map when no colour layer is visible", () => {
      pathSelection.togglePathSelection(1);

      expect(mapHelpers.invalidateMapWithDelay).not.toHaveBeenCalled();
      expect(mockApp.statsManager.updateStatsForSelection).toHaveBeenCalled();
    });

    it("rebuilds layers in isolate mode", () => {
      mockApp.selectedPathIds.add(1);
      mockApp.isolateSelection = true;

      pathSelection.togglePathSelection(2);

      expect(mockApp.dataManager.updateLayers).toHaveBeenCalledTimes(1);
      expect(mockApp.layerManager.updateSelectionStyles).not.toHaveBeenCalled();
      expect(
        mockApp.statsManager.updateStatsForSelection,
      ).not.toHaveBeenCalled();
    });

    it("disables isolate mode when the last path is deselected", () => {
      mockApp.selectedPathIds.add(1);
      mockApp.isolateSelection = true;

      pathSelection.togglePathSelection(1);

      expect(mockApp.isolateSelection).toBe(false);
      // Isolate mode drew only the selected path, so the paths that were
      // hidden have to be drawn again
      expect(mockApp.dataManager.updateLayers).toHaveBeenCalledTimes(1);
      expect(mockApp.layerManager.updateSelectionStyles).not.toHaveBeenCalled();
    });

    it("logs errors from updateLayers", async () => {
      const error = new Error("boom");
      mockApp.selectedPathIds.add(1);
      mockApp.isolateSelection = true;
      mockApp.dataManager.updateLayers.mockRejectedValueOnce(error);
      const consoleSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});

      pathSelection.togglePathSelection(2);
      await flush();

      expect(consoleSpy).toHaveBeenCalledWith(error);
      consoleSpy.mockRestore();
    });
  });

  describe("selectPathsByAirport", () => {
    it("selects all paths for an airport", () => {
      pathSelection.selectPathsByAirport("EDDF");

      expect([...mockApp.selectedPathIds]).toEqual([1, 2, 3]);
      expect(mockApp.replayManager.updateReplayButtonState).toHaveBeenCalled();
      expect(mockApp.layerManager.updateSelectionStyles).toHaveBeenCalled();
      expect(mockApp.statsManager.updateStatsForSelection).toHaveBeenCalled();
      expect(mockApp.airportManager.updateAirportOpacity).toHaveBeenCalled();
    });

    it("adds to an existing selection", () => {
      mockApp.selectedPathIds.add(4);

      pathSelection.selectPathsByAirport("EDDF");

      expect(mockApp.selectedPathIds.size).toBe(4);
    });

    it("handles airport with no paths gracefully", () => {
      const notify = vi.spyOn(mockApp.store, "notifyMutation");

      pathSelection.selectPathsByAirport("NONEXISTENT");

      expect(mockApp.selectedPathIds.size).toBe(0);
      expect(notify).not.toHaveBeenCalled();
      expect(mockApp.replayManager.updateReplayButtonState).toHaveBeenCalled();
    });

    it("rebuilds layers when isolate mode is active", () => {
      mockApp.selectedPathIds.add(4);
      mockApp.isolateSelection = true;

      pathSelection.selectPathsByAirport("EDDF");

      expect(mockApp.dataManager.updateLayers).toHaveBeenCalledTimes(1);
    });
  });

  describe("clearSelection", () => {
    beforeEach(() => {
      mockApp.selectedPathIds.add(1);
      mockApp.selectedPathIds.add(2);
    });

    it("clears all selected paths and restyles", () => {
      pathSelection.clearSelection();

      expect(mockApp.selectedPathIds.size).toBe(0);
      expect(mockApp.layerManager.updateSelectionStyles).toHaveBeenCalled();
      expect(mockApp.replayManager.updateReplayButtonState).toHaveBeenCalled();
    });

    it("disables isolate mode when clearing selection", () => {
      mockApp.isolateSelection = true;

      pathSelection.clearSelection();

      expect(mockApp.isolateSelection).toBe(false);
      // Leaving isolate mode has to restore the previously hidden paths
      expect(mockApp.dataManager.updateLayers).toHaveBeenCalledTimes(1);
      expect(mockApp.layerManager.updateSelectionStyles).not.toHaveBeenCalled();
    });
  });

  describe("toggleIsolateSelection", () => {
    it("enables isolate mode when paths are selected and rebuilds", () => {
      mockApp.selectedPathIds.add(1);

      pathSelection.toggleIsolateSelection();

      expect(mockApp.isolateSelection).toBe(true);
      expect(mockApp.dataManager.updateLayers).toHaveBeenCalledTimes(1);
    });

    it("disables isolate mode when toggled again", () => {
      mockApp.selectedPathIds.add(1);
      mockApp.isolateSelection = true;

      pathSelection.toggleIsolateSelection();

      expect(mockApp.isolateSelection).toBe(false);
      expect(mockApp.dataManager.updateLayers).toHaveBeenCalledTimes(1);
    });

    it("does nothing when no paths are selected", () => {
      pathSelection.toggleIsolateSelection();

      expect(mockApp.isolateSelection).toBe(false);
      expect(mockApp.dataManager.updateLayers).not.toHaveBeenCalled();
    });
  });

  describe("updateIsolateButton", () => {
    it("sets dimmed, not pressed state when no paths are selected", () => {
      pathSelection.updateIsolateButton();

      expect(btn.style.opacity).toBe("0.5");
      expect(btn.getAttribute("aria-pressed")).toBe("false");
      expect(btn.classList.contains("active")).toBe(false);
      expect(btn.style.borderColor).toBe("var(--color-border)");
    });

    it("sets full opacity but not pressed when paths are selected", () => {
      mockApp.selectedPathIds.add(1);

      pathSelection.updateIsolateButton();

      expect(btn.style.opacity).toBe("1");
      expect(btn.getAttribute("aria-pressed")).toBe("false");
      expect(btn.classList.contains("active")).toBe(false);
    });

    it("sets pressed state when isolate mode is on", () => {
      mockApp.selectedPathIds.add(1);
      mockApp.isolateSelection = true;

      pathSelection.updateIsolateButton();

      expect(btn.style.opacity).toBe("1");
      expect(btn.getAttribute("aria-pressed")).toBe("true");
      expect(btn.classList.contains("active")).toBe(true);
      expect(btn.style.borderColor).toBe("var(--color-accent-blue)");
    });

    it("does nothing when the button is missing", () => {
      btn.remove();
      expect(() => pathSelection.updateIsolateButton()).not.toThrow();
    });
  });
});
