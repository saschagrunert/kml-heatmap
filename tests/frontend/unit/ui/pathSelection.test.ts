import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PathSelection } from "../../../../kml_heatmap/frontend/ui/pathSelection";
import {
  createMockApp,
  createDataset,
  asMapApp,
  type MockApp,
} from "../../testHelpers";
import { domCache } from "../../../../kml_heatmap/frontend/utils/domCache";

const mapHelpers = vi.hoisted(() => ({
  invalidateMapAfterTransition: vi.fn(),
}));
vi.mock("../../../../kml_heatmap/frontend/utils/mapHelpers", () => mapHelpers);

describe("PathSelection", () => {
  let pathSelection: PathSelection;
  let mockApp: MockApp;
  let btn: HTMLButtonElement;
  let chip: HTMLElement;
  let chipCount: HTMLElement;
  let clearBtn: HTMLButtonElement;

  beforeEach(() => {
    vi.clearAllMocks();
    btn = document.createElement("button");
    btn.id = "isolate-btn";
    document.body.appendChild(btn);

    chip = document.createElement("div");
    chip.id = "selection-chip";
    chip.hidden = true;
    chipCount = document.createElement("span");
    chipCount.id = "selection-chip-count";
    clearBtn = document.createElement("button");
    clearBtn.id = "selection-clear-btn";
    chip.append(chipCount, clearBtn);
    document.body.appendChild(chip);

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
    chip.remove();
    domCache.clear();
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
    });

    it("removes path when already selected", () => {
      mockApp.selectedPathIds.add(1);

      pathSelection.togglePathSelection(1);

      expect(mockApp.selectedPathIds.has(1)).toBe(false);
    });

    it("restyles polylines in place and leaves the rest to the store", () => {
      mockApp.altitudeVisible = true;
      const listener = vi.fn();
      mockApp.store.subscribe("selectedPathIds", listener);

      pathSelection.togglePathSelection(1);

      expect(mockApp.layerManager.updateSelectionStyles).toHaveBeenCalledTimes(
        1,
      );
      expect(mockApp.layerManager.redrawAltitudePaths).not.toHaveBeenCalled();
      expect(mapHelpers.invalidateMapAfterTransition).toHaveBeenCalledWith(
        mockApp.map,
      );
      expect(mockApp.dataManager.updateLayers).not.toHaveBeenCalled();
      // Statistics, airports and the replay button subscribe to this
      expect(listener).toHaveBeenCalledTimes(1);
      expect(
        mockApp.statsManager.updateStatsForSelection,
      ).not.toHaveBeenCalled();
      expect(
        mockApp.airportManager.updateAirportOpacity,
      ).not.toHaveBeenCalled();
      expect(
        mockApp.replayManager.updateReplayButtonState,
      ).not.toHaveBeenCalled();
    });

    it("does not invalidate the map when no colour layer is visible", () => {
      pathSelection.togglePathSelection(1);

      expect(mapHelpers.invalidateMapAfterTransition).not.toHaveBeenCalled();
    });

    it("rebuilds layers in isolate mode", () => {
      mockApp.selectedPathIds.add(1);
      mockApp.isolateSelection = true;

      pathSelection.togglePathSelection(2);

      expect(mockApp.dataManager.updateLayers).toHaveBeenCalledTimes(1);
      expect(mockApp.layerManager.updateSelectionStyles).not.toHaveBeenCalled();
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

    it("lets listeners see the final state of both keys at once", () => {
      mockApp.selectedPathIds.add(1);
      mockApp.isolateSelection = true;
      const seen: [number, boolean][] = [];
      mockApp.store.subscribe("selectedPathIds", () => {
        seen.push([mockApp.selectedPathIds.size, mockApp.isolateSelection]);
      });

      pathSelection.togglePathSelection(1);

      // Never an empty selection that is still isolating
      expect(seen).toEqual([[0, false]]);
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
      expect(mockApp.layerManager.updateSelectionStyles).toHaveBeenCalled();
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
      expect(mockApp.layerManager.updateSelectionStyles).toHaveBeenCalled();
    });

    it("rebuilds layers when isolate mode is active", () => {
      mockApp.selectedPathIds.add(4);
      mockApp.isolateSelection = true;

      pathSelection.selectPathsByAirport("EDDF");

      expect(mockApp.dataManager.updateLayers).toHaveBeenCalledTimes(1);
    });

    it("selects only the flights the aircraft filter keeps (regression)", () => {
      const app = createMockApp({
        currentData: createDataset([
          {
            id: 1,
            aircraft_registration: "D-ABCD",
            start_airport: "EDDF",
            end_airport: "EDDM",
          },
          {
            id: 2,
            aircraft_registration: "D-EFGH",
            start_airport: "EDDF",
            end_airport: "EDDK",
          },
        ]),
        selectedAircraft: "D-ABCD",
      });
      const selection = new PathSelection(asMapApp(app));

      selection.selectPathsByAirport("EDDF");

      // The panel read "2 selected paths" beside the one flight on the map
      expect([...app.selectedPathIds]).toEqual([1]);
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

  describe("selection chip", () => {
    it("stays out of the way while nothing is selected", () => {
      expect(chip.hidden).toBe(true);
      expect(chipCount.textContent).toBe("");
    });

    it("counts the selection", () => {
      // A selection is only drawn where the paths are, so at the zoom
      // levels that show the heat bloom alone this is all there is to see
      pathSelection.togglePathSelection(1);

      expect(chip.hidden).toBe(false);
      expect(chipCount.textContent).toBe("1 flight selected");

      pathSelection.togglePathSelection(2);

      expect(chipCount.textContent).toBe("2 flights selected");
    });

    it("goes away with the selection", () => {
      pathSelection.togglePathSelection(1);
      pathSelection.togglePathSelection(1);

      expect(chip.hidden).toBe(true);
    });

    it("clears the selection from its own control", () => {
      pathSelection.togglePathSelection(1);

      clearBtn.click();

      expect(mockApp.selectedPathIds.size).toBe(0);
      expect(chip.hidden).toBe(true);
    });
  });

  describe("isolate button", () => {
    it("is dimmed and not pressed at construction without a selection", () => {
      expect(btn.style.opacity).toBe("0.5");
      expect(btn.getAttribute("aria-pressed")).toBe("false");
      expect(btn.classList.contains("active")).toBe(false);
      // Colours come from the stylesheet, not from inline styles
      expect(btn.style.borderColor).toBe("");
      expect(btn.style.backgroundColor).toBe("");
    });

    it("reflects a restored selection and mode at construction", () => {
      const app = createMockApp({
        selectedPathIds: new Set([1]),
        isolateSelection: true,
      });

      new PathSelection(asMapApp(app));

      expect(btn.style.opacity).toBe("1");
      expect(btn.getAttribute("aria-pressed")).toBe("true");
      expect(btn.classList.contains("active")).toBe(true);
    });

    it("lights up when paths are selected and stays unpressed", () => {
      mockApp.selectedPathIds.add(1);
      mockApp.store.notifyMutation("selectedPathIds");

      expect(btn.style.opacity).toBe("1");
      expect(btn.getAttribute("aria-pressed")).toBe("false");
      expect(btn.classList.contains("active")).toBe(false);
    });

    it("follows isolate mode through the store", () => {
      mockApp.selectedPathIds.add(1);
      mockApp.store.notifyMutation("selectedPathIds");

      mockApp.isolateSelection = true;
      expect(btn.getAttribute("aria-pressed")).toBe("true");
      expect(btn.classList.contains("active")).toBe(true);
      expect(btn.style.opacity).toBe("1");

      mockApp.isolateSelection = false;
      expect(btn.getAttribute("aria-pressed")).toBe("false");
      expect(btn.style.opacity).toBe("1");
    });

    it("dims again once the selection is cleared", () => {
      mockApp.selectedPathIds.add(1);
      mockApp.store.notifyMutation("selectedPathIds");
      expect(btn.style.opacity).toBe("1");

      pathSelection.clearSelection();

      expect(btn.style.opacity).toBe("0.5");
      expect(btn.getAttribute("aria-pressed")).toBe("false");
    });

    it("does nothing when the button is missing", () => {
      btn.remove();
      expect(() => pathSelection.updateIsolateButton()).not.toThrow();
      expect(() =>
        mockApp.store.notifyMutation("selectedPathIds"),
      ).not.toThrow();
    });
  });
});
