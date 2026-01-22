import type { MockMapApp } from "../../testHelpers";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { PathSelection } from "../../../../kml_heatmap/frontend/ui/pathSelection";

describe("PathSelection", () => {
  let pathSelection: PathSelection;
  let mockApp: MockMapApp;

  beforeEach(() => {
    // Create mock app with all required properties
    mockApp = {
      selectedPathIds: new Set<number>(),
      altitudeVisible: false,
      airspeedVisible: false,
      airportToPaths: {},
      map: {
        invalidateSize: vi.fn(),
      },
      layerManager: {
        redrawAltitudePaths: vi.fn(),
        redrawAirspeedPaths: vi.fn(),
      },
      replayManager: {
        updateReplayButtonState: vi.fn(),
      },
      stateManager: {
        saveMapState: vi.fn(),
      },
    };

    pathSelection = new PathSelection(mockApp);
  });

  describe("togglePathSelection", () => {
    it("adds path to selection if not selected", () => {
      pathSelection.togglePathSelection(1);

      expect(mockApp.selectedPathIds.has(1)).toBe(true);
      expect(mockApp.replayManager.updateReplayButtonState).toHaveBeenCalled();
      expect(mockApp.stateManager.saveMapState).toHaveBeenCalled();
    });

    it("removes path from selection if already selected", () => {
      mockApp.selectedPathIds.add(1);

      pathSelection.togglePathSelection(1);

      expect(mockApp.selectedPathIds.has(1)).toBe(false);
      expect(mockApp.replayManager.updateReplayButtonState).toHaveBeenCalled();
      expect(mockApp.stateManager.saveMapState).toHaveBeenCalled();
    });

    it("redraws altitude paths when altitude visible", () => {
      mockApp.altitudeVisible = true;

      pathSelection.togglePathSelection(1);

      expect(mockApp.layerManager.redrawAltitudePaths).toHaveBeenCalled();
      expect(mockApp.map.invalidateSize).not.toHaveBeenCalled(); // Not called immediately
    });

    it("redraws airspeed paths when airspeed visible", () => {
      mockApp.airspeedVisible = true;

      pathSelection.togglePathSelection(1);

      expect(mockApp.layerManager.redrawAirspeedPaths).toHaveBeenCalled();
      expect(mockApp.map.invalidateSize).not.toHaveBeenCalled(); // Not called immediately
    });

    it("does not redraw paths when layers not visible", () => {
      mockApp.altitudeVisible = false;
      mockApp.airspeedVisible = false;

      pathSelection.togglePathSelection(1);

      expect(mockApp.layerManager.redrawAltitudePaths).not.toHaveBeenCalled();
      expect(mockApp.layerManager.redrawAirspeedPaths).not.toHaveBeenCalled();
    });
  });

  describe("selectPathsByAirport", () => {
    it("selects all paths associated with an airport", () => {
      mockApp.airportToPaths["EDDF"] = new Set([1, 2, 3]);

      pathSelection.selectPathsByAirport("EDDF");

      expect(mockApp.selectedPathIds.has(1)).toBe(true);
      expect(mockApp.selectedPathIds.has(2)).toBe(true);
      expect(mockApp.selectedPathIds.has(3)).toBe(true);
      expect(mockApp.replayManager.updateReplayButtonState).toHaveBeenCalled();
      expect(mockApp.stateManager.saveMapState).toHaveBeenCalled();
    });

    it("does nothing if airport has no paths", () => {
      pathSelection.selectPathsByAirport("NONEXISTENT");

      expect(mockApp.selectedPathIds.size).toBe(0);
      expect(mockApp.replayManager.updateReplayButtonState).toHaveBeenCalled();
      expect(mockApp.stateManager.saveMapState).toHaveBeenCalled();
    });

    it("redraws altitude paths when altitude visible", () => {
      mockApp.altitudeVisible = true;
      mockApp.airportToPaths["EDDF"] = new Set([1]);

      pathSelection.selectPathsByAirport("EDDF");

      expect(mockApp.layerManager.redrawAltitudePaths).toHaveBeenCalled();
    });

    it("redraws airspeed paths when airspeed visible", () => {
      mockApp.airspeedVisible = true;
      mockApp.airportToPaths["EDDF"] = new Set([1]);

      pathSelection.selectPathsByAirport("EDDF");

      expect(mockApp.layerManager.redrawAirspeedPaths).toHaveBeenCalled();
    });
  });

  describe("clearSelection", () => {
    it("clears all selected paths", () => {
      mockApp.selectedPathIds.add(1);
      mockApp.selectedPathIds.add(2);
      mockApp.selectedPathIds.add(3);

      pathSelection.clearSelection();

      expect(mockApp.selectedPathIds.size).toBe(0);
      expect(mockApp.replayManager.updateReplayButtonState).toHaveBeenCalled();
      expect(mockApp.stateManager.saveMapState).toHaveBeenCalled();
    });

    it("redraws altitude paths when altitude visible", () => {
      mockApp.altitudeVisible = true;
      mockApp.selectedPathIds.add(1);

      pathSelection.clearSelection();

      expect(mockApp.layerManager.redrawAltitudePaths).toHaveBeenCalled();
    });

    it("redraws airspeed paths when airspeed visible", () => {
      mockApp.airspeedVisible = true;
      mockApp.selectedPathIds.add(1);

      pathSelection.clearSelection();

      expect(mockApp.layerManager.redrawAirspeedPaths).toHaveBeenCalled();
    });

    it("handles empty selection", () => {
      pathSelection.clearSelection();

      expect(mockApp.selectedPathIds.size).toBe(0);
      expect(mockApp.replayManager.updateReplayButtonState).toHaveBeenCalled();
      expect(mockApp.stateManager.saveMapState).toHaveBeenCalled();
    });
  });
});
