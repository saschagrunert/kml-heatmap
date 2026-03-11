import { describe, it, expect, beforeEach, vi } from "vitest";
import { PathSelection } from "../../../../kml_heatmap/frontend/ui/pathSelection";
import type { MockMapApp } from "../../testHelpers";

describe("PathSelection", () => {
  let pathSelection: PathSelection;
  let mockApp: MockMapApp;

  beforeEach(() => {
    // Create isolate button element for DOM tests
    const btn = document.createElement("button");
    btn.id = "isolate-btn";
    btn.style.opacity = "0.5";
    btn.style.borderColor = "#555";
    btn.style.backgroundColor = "#2b2b2b";
    document.body.appendChild(btn);

    // Create mock app with all required dependencies
    mockApp = {
      selectedPathIds: new Set<number>(),
      altitudeVisible: false,
      airspeedVisible: false,
      isolateSelection: false,
      map: {
        invalidateSize: vi.fn(),
      } as any,
      layerManager: {
        redrawAltitudePaths: vi.fn(),
        redrawAirspeedPaths: vi.fn(),
      },
      replayManager: {
        updateReplayButtonState: vi.fn(),
        replayActive: false,
      },
      stateManager: {
        saveMapState: vi.fn(),
      },
      dataManager: {
        updateLayers: vi.fn().mockResolvedValue(undefined),
      },
      airportToPaths: {
        EDDF: new Set([1, 2, 3]),
        EDDM: new Set([4, 5]),
      },
    } as MockMapApp;

    pathSelection = new PathSelection(mockApp as any);
  });

  describe("togglePathSelection", () => {
    it("adds path when not selected", () => {
      pathSelection.togglePathSelection(1);

      expect(mockApp.selectedPathIds.has(1)).toBe(true);
      expect(mockApp.replayManager!.updateReplayButtonState).toHaveBeenCalled();
      expect(mockApp.stateManager!.saveMapState).toHaveBeenCalled();
    });

    it("removes path when already selected", () => {
      mockApp.selectedPathIds.add(1);

      pathSelection.togglePathSelection(1);

      expect(mockApp.selectedPathIds.has(1)).toBe(false);
      expect(mockApp.replayManager!.updateReplayButtonState).toHaveBeenCalled();
      expect(mockApp.stateManager!.saveMapState).toHaveBeenCalled();
    });

    it("redraws altitude paths when altitude layer is visible", () => {
      mockApp.altitudeVisible = true;

      pathSelection.togglePathSelection(1);

      expect(mockApp.layerManager!.redrawAltitudePaths).toHaveBeenCalled();
    });

    it("redraws airspeed paths when airspeed layer is visible", () => {
      mockApp.airspeedVisible = true;

      pathSelection.togglePathSelection(1);

      expect(mockApp.layerManager!.redrawAirspeedPaths).toHaveBeenCalled();
    });

    it("updates replay button state after selection change", () => {
      pathSelection.togglePathSelection(1);

      expect(
        mockApp.replayManager!.updateReplayButtonState
      ).toHaveBeenCalledTimes(1);
    });
  });

  describe("selectPathsByAirport", () => {
    it("selects all paths for an airport", () => {
      pathSelection.selectPathsByAirport("EDDF");

      expect(mockApp.selectedPathIds.has(1)).toBe(true);
      expect(mockApp.selectedPathIds.has(2)).toBe(true);
      expect(mockApp.selectedPathIds.has(3)).toBe(true);
      expect(mockApp.selectedPathIds.size).toBe(3);
    });

    it("updates replay button state after airport selection", () => {
      pathSelection.selectPathsByAirport("EDDF");

      expect(mockApp.replayManager!.updateReplayButtonState).toHaveBeenCalled();
      expect(mockApp.stateManager!.saveMapState).toHaveBeenCalled();
    });

    it("handles airport with no paths gracefully", () => {
      pathSelection.selectPathsByAirport("NONEXISTENT");

      expect(mockApp.selectedPathIds.size).toBe(0);
      expect(mockApp.replayManager!.updateReplayButtonState).toHaveBeenCalled();
    });

    it("redraws paths when layers are visible", () => {
      mockApp.altitudeVisible = true;
      mockApp.airspeedVisible = true;

      pathSelection.selectPathsByAirport("EDDM");

      expect(mockApp.layerManager!.redrawAltitudePaths).toHaveBeenCalled();
      expect(mockApp.layerManager!.redrawAirspeedPaths).toHaveBeenCalled();
    });
  });

  describe("clearSelection", () => {
    beforeEach(() => {
      mockApp.selectedPathIds.add(1);
      mockApp.selectedPathIds.add(2);
      mockApp.selectedPathIds.add(3);
    });

    it("clears all selected paths", () => {
      pathSelection.clearSelection();

      expect(mockApp.selectedPathIds.size).toBe(0);
    });

    it("updates replay button state after clearing", () => {
      pathSelection.clearSelection();

      expect(mockApp.replayManager!.updateReplayButtonState).toHaveBeenCalled();
      expect(mockApp.stateManager!.saveMapState).toHaveBeenCalled();
    });

    it("redraws altitude paths when visible", () => {
      mockApp.altitudeVisible = true;

      pathSelection.clearSelection();

      expect(mockApp.layerManager!.redrawAltitudePaths).toHaveBeenCalled();
    });

    it("redraws airspeed paths when visible", () => {
      mockApp.airspeedVisible = true;

      pathSelection.clearSelection();

      expect(mockApp.layerManager!.redrawAirspeedPaths).toHaveBeenCalled();
    });

    it("disables isolate mode when clearing selection", () => {
      mockApp.isolateSelection = true;

      pathSelection.clearSelection();

      expect(mockApp.isolateSelection).toBe(false);
      expect(mockApp.dataManager!.updateLayers).toHaveBeenCalled();
      expect(mockApp.replayManager!.updateReplayButtonState).toHaveBeenCalled();
      expect(mockApp.stateManager!.saveMapState).toHaveBeenCalled();
    });
  });

  describe("toggleIsolateSelection", () => {
    it("enables isolate mode when paths are selected", () => {
      mockApp.selectedPathIds.add(1);

      pathSelection.toggleIsolateSelection();

      expect(mockApp.isolateSelection).toBe(true);
      expect(mockApp.dataManager!.updateLayers).toHaveBeenCalled();
      expect(mockApp.stateManager!.saveMapState).toHaveBeenCalled();
    });

    it("disables isolate mode when toggled again", () => {
      mockApp.selectedPathIds.add(1);
      mockApp.isolateSelection = true;

      pathSelection.toggleIsolateSelection();

      expect(mockApp.isolateSelection).toBe(false);
      expect(mockApp.dataManager!.updateLayers).toHaveBeenCalled();
    });

    it("does nothing when no paths are selected", () => {
      pathSelection.toggleIsolateSelection();

      expect(mockApp.isolateSelection).toBe(false);
      expect(mockApp.dataManager!.updateLayers).not.toHaveBeenCalled();
    });
  });

  describe("updateIsolateButton", () => {
    it("sets dimmed state when no paths selected", () => {
      pathSelection.updateIsolateButton();

      const btn = document.getElementById("isolate-btn")!;
      expect(btn.style.opacity).toBe("0.5");
      expect(btn.style.borderColor).toBe("rgb(85, 85, 85)");
    });

    it("sets active state when paths selected", () => {
      mockApp.selectedPathIds.add(1);

      pathSelection.updateIsolateButton();

      const btn = document.getElementById("isolate-btn")!;
      expect(btn.style.opacity).toBe("1");
      expect(btn.style.borderColor).toBe("rgb(85, 85, 85)");
      expect(btn.style.backgroundColor).toBe("rgb(43, 43, 43)");
    });

    it("sets highlighted state when isolate mode is on", () => {
      mockApp.selectedPathIds.add(1);
      mockApp.isolateSelection = true;

      pathSelection.updateIsolateButton();

      const btn = document.getElementById("isolate-btn")!;
      expect(btn.style.opacity).toBe("1");
      expect(btn.style.borderColor).toBe("rgb(79, 172, 254)");
      expect(btn.style.backgroundColor).toBe("rgb(26, 58, 92)");
    });
  });

  describe("isolate mode interactions", () => {
    it("disables isolate mode when last path is deselected", () => {
      mockApp.selectedPathIds.add(1);
      mockApp.isolateSelection = true;

      pathSelection.togglePathSelection(1);

      expect(mockApp.isolateSelection).toBe(false);
      expect(mockApp.dataManager!.updateLayers).toHaveBeenCalled();
      expect(mockApp.replayManager!.updateReplayButtonState).toHaveBeenCalled();
      expect(mockApp.stateManager!.saveMapState).toHaveBeenCalled();
    });

    it("rebuilds heatmap when toggling path in isolate mode", () => {
      mockApp.selectedPathIds.add(1);
      mockApp.isolateSelection = true;

      pathSelection.togglePathSelection(2);

      expect(mockApp.dataManager!.updateLayers).toHaveBeenCalled();
      expect(mockApp.stateManager!.saveMapState).toHaveBeenCalled();
    });

    it("rebuilds heatmap when selecting airport paths in isolate mode", () => {
      mockApp.selectedPathIds.add(1);
      mockApp.isolateSelection = true;

      pathSelection.selectPathsByAirport("EDDM");

      expect(mockApp.dataManager!.updateLayers).toHaveBeenCalled();
      expect(mockApp.stateManager!.saveMapState).toHaveBeenCalled();
    });
  });
});
