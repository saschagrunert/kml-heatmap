import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mapChromePadding,
  PathSelection,
} from "../../../../kml_heatmap/frontend/ui/pathSelection";
import {
  createMockApp,
  createDataset,
  createSegment,
  asMapApp,
  type MockApp,
} from "../../testHelpers";
import { DataManager } from "../../../../kml_heatmap/frontend/ui/dataManager";
import { AUTO_ZOOM_FOLLOW } from "../../../../kml_heatmap/frontend/utils/constants";

// The data manager is real, so the paths follow the selection the way they
// do in the app; it loads nothing here, and its heat is never drawn
vi.mock("../../../../kml_heatmap/frontend/services/dataLoader", () => ({
  DataLoader: vi.fn(function () {
    return { destroy: vi.fn(), getDecoder: () => new Promise(() => {}) };
  }),
}));

// The profile of a picked flight comes with the feature bundle, which
// the view waits for before it frames the flight
vi.mock("../../../../kml_heatmap/frontend/services/featureLoader", () => ({
  loadFeatures: vi.fn(() => Promise.resolve(null)),
}));

const toastMock = vi.hoisted(() => ({ announceStatus: vi.fn() }));
vi.mock(
  import("../../../../kml_heatmap/frontend/utils/toast"),
  async (importOriginal) => ({ ...(await importOriginal()), ...toastMock }),
);

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
      currentData: createDataset([1, 2, 3, 4, 5].map((id) => ({ id }))),
    });
    new DataManager(asMapApp(mockApp)).updateLayers();
    vi.clearAllMocks();
    pathSelection = new PathSelection(asMapApp(mockApp));
  });

  /** How often the layers were rebuilt, and restyled for the selection */
  const rebuilds = (): number =>
    vi.mocked(mockApp.layerManager.syncModes).mock.calls.length;
  const restyles = (): number =>
    vi.mocked(mockApp.layerManager.updateSelectionStyles).mock.calls.length;
  /** Count from here: a test's own setup goes through the store as well */
  const settle = (): void => {
    vi.mocked(mockApp.layerManager.syncModes).mockClear();
    vi.mocked(mockApp.layerManager.updateSelectionStyles).mockClear();
  };

  afterEach(() => {
    btn.remove();
    chip.remove();
  });

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

    it("restyles the drawn paths in place and leaves the rest to the store", () => {
      mockApp.altitudeVisible = true;
      const listener = vi.fn();
      mockApp.store.subscribe("selectedPathIds", listener);

      pathSelection.togglePathSelection(1);

      expect(restyles()).toBe(1);
      expect(rebuilds()).toBe(0);
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

    it("restyles the paths in isolate mode, which keep their runs", () => {
      mockApp.selectedPathIds.add(1);
      mockApp.isolateSelection = true;
      settle();

      pathSelection.togglePathSelection(2);

      expect(rebuilds()).toBe(0);
      expect(restyles()).toBe(1);
    });

    it("disables isolate mode when the last path is deselected", () => {
      mockApp.selectedPathIds.add(1);
      mockApp.isolateSelection = true;
      settle();

      pathSelection.togglePathSelection(1);

      expect(mockApp.isolateSelection).toBe(false);
      // Isolate mode filtered the other paths out; they come back with
      // the filter, in one restyle for both keys
      expect(rebuilds()).toBe(0);
      expect(restyles()).toBe(1);
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
  });

  describe("selectPathsByAirport", () => {
    it("selects all paths for an airport", () => {
      pathSelection.selectPathsByAirport("EDDF");

      expect([...mockApp.selectedPathIds]).toEqual([1, 2, 3]);
      expect(restyles()).toBe(1);
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
      // Nothing changed, so nothing is drawn again
      expect(restyles()).toBe(0);
    });

    it("restyles the paths when isolate mode is active", () => {
      mockApp.selectedPathIds.add(4);
      mockApp.isolateSelection = true;
      settle();

      pathSelection.selectPathsByAirport("EDDF");

      expect(rebuilds()).toBe(0);
      expect(restyles()).toBe(1);
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
      expect(restyles()).toBe(1);
    });

    it("disables isolate mode when clearing selection", () => {
      mockApp.isolateSelection = true;
      settle();

      pathSelection.clearSelection();

      expect(mockApp.isolateSelection).toBe(false);
      // Leaving isolate mode lifts the filter that hid the other paths
      expect(rebuilds()).toBe(0);
      expect(restyles()).toBe(1);
    });
  });

  describe("toggleIsolateSelection", () => {
    it("enables isolate mode when paths are selected and restyles", () => {
      mockApp.selectedPathIds.add(1);

      pathSelection.toggleIsolateSelection();

      expect(mockApp.isolateSelection).toBe(true);
      expect(rebuilds()).toBe(0);
      expect(restyles()).toBe(1);
    });

    it("disables isolate mode when toggled again", () => {
      mockApp.selectedPathIds.add(1);
      mockApp.isolateSelection = true;
      settle();

      pathSelection.toggleIsolateSelection();

      expect(mockApp.isolateSelection).toBe(false);
      expect(rebuilds()).toBe(0);
      expect(restyles()).toBe(1);
    });

    it("does nothing when no paths are selected", () => {
      pathSelection.toggleIsolateSelection();

      expect(mockApp.isolateSelection).toBe(false);
      expect(rebuilds()).toBe(0);
    });

    it("frames the isolated flights, and leaves the view alone on the way out", () => {
      // An isolated flight could stay half off the screen (regression)
      mockApp.currentData = createDataset(
        [{ id: 1 }, { id: 2 }],
        [
          createSegment({
            path_id: 1,
            coords: [
              [50, 8],
              [51, 9],
            ],
          }),
          createSegment({
            path_id: 2,
            coords: [
              [40, 2],
              [41, 3],
            ],
          }),
        ],
      );
      mockApp.selectedPathIds.add(1);
      const map = mockApp.map!;
      map.getBearing.mockReturnValue(30);

      pathSelection.toggleIsolateSelection();

      expect(map.fitBounds).toHaveBeenCalledTimes(1);
      const [bounds, options] = map.fitBounds.mock.calls[0]!;
      // The selected flight alone, as [lng, lat] corners
      expect(bounds).toEqual([
        [8, 50],
        [9, 51],
      ]);
      expect(options).toMatchObject({ bearing: 30 });

      pathSelection.toggleIsolateSelection();
      expect(map.fitBounds).toHaveBeenCalledTimes(1);
    });
  });

  describe("mapChromePadding", () => {
    const rect = (x: number, y: number, w: number, h: number): DOMRect =>
      ({
        x,
        y,
        left: x,
        top: y,
        width: w,
        height: h,
        right: x + w,
        bottom: y + h,
      }) as DOMRect;

    it("keeps a fit clear of the panels at each edge, and no more than a third", () => {
      const map = mockApp.map!;
      vi.spyOn(map.getContainer(), "getBoundingClientRect").mockReturnValue(
        rect(0, 0, 1200, 800),
      );
      const panels: [string, DOMRect][] = [
        // A column at the right edge, 172px wide
        ["right-buttons", rect(1018, 10, 172, 600)],
        // The chip at the top, 38px tall
        ["selection-chip", rect(500, 8, 180, 38)],
        // A tall column at the left, wider than a third of the map
        ["left-buttons", rect(10, 10, 500, 700)],
      ];
      const made = panels.map(([id, box]) => {
        const element =
          document.getElementById(id) ?? document.createElement("div");
        element.id = id;
        element.hidden = false;
        vi.spyOn(element, "getBoundingClientRect").mockReturnValue(box);
        document.body.append(element);
        return element;
      });

      const padding = mapChromePadding(map as never);

      expect(padding.right).toBe(182 + 24);
      expect(padding.top).toBe(46 + 24);
      expect(padding.left).toBe(400 + 24);
      expect(padding.bottom).toBe(24);
      for (const element of made) if (element !== chip) element.remove();
    });

    it("counts a phone's profile above the bar at the bottom, not at a side", () => {
      // As wide as the map and 81 px up, over the bar and the credit
      const map = mockApp.map!;
      vi.spyOn(map.getContainer(), "getBoundingClientRect").mockReturnValue(
        rect(0, 0, 390, 844),
      );
      const profile = document.createElement("div");
      profile.id = "flight-profile";
      vi.spyOn(profile, "getBoundingClientRect").mockReturnValue(
        rect(8, 635, 374, 128),
      );
      document.body.append(profile);

      const padding = mapChromePadding(map as never);

      expect(padding.bottom).toBe(209 + 24);
      expect(padding.left).toBe(24);
      expect(padding.right).toBe(24);
      profile.remove();
    });
  });

  describe("while replay runs", () => {
    beforeEach(() => {
      mockApp.selectedPathIds.add(1);
      mockApp.replayActive = true;
    });

    it("keeps the selection the replay is playing", () => {
      const onChange = vi.fn();
      mockApp.store.subscribe("selectedPathIds", onChange);

      clearBtn.click();
      pathSelection.clearSelection();

      expect([...mockApp.selectedPathIds]).toEqual([1]);
      expect(onChange).not.toHaveBeenCalled();
      expect(rebuilds()).toBe(0);
      expect(restyles()).toBe(0);
    });

    it("ignores Isolate", () => {
      pathSelection.toggleIsolateSelection();

      expect(mockApp.isolateSelection).toBe(false);
      expect(rebuilds()).toBe(0);
    });

    it("ignores a flight picked from a list, alone or added", () => {
      pathSelection.selectFlight(2);
      pathSelection.selectFlight(3, true);

      expect([...mockApp.selectedPathIds]).toEqual([1]);
    });
  });

  describe("selectFlight", () => {
    it("selects just the flight", () => {
      mockApp.selectedPathIds.add(1);
      mockApp.selectedPathIds.add(2);

      pathSelection.selectFlight(3);

      expect([...mockApp.selectedPathIds]).toEqual([3]);
    });

    it("keeps the flight alone when it is one of several", () => {
      mockApp.selectedPathIds.add(1);
      mockApp.selectedPathIds.add(2);

      pathSelection.selectFlight(2);

      expect([...mockApp.selectedPathIds]).toEqual([2]);
    });

    it("selects nothing when the flight is the whole selection", () => {
      mockApp.selectedPathIds.add(2);
      mockApp.isolateSelection = true;

      pathSelection.selectFlight(2);

      expect(mockApp.selectedPathIds.size).toBe(0);
      expect(mockApp.isolateSelection).toBe(false);
    });

    it("swaps the selection in one update, announced once", () => {
      mockApp.selectedPathIds.add(1);
      mockApp.selectedPathIds.add(3);
      mockApp.store.notifyMutation("selectedPathIds");
      toastMock.announceStatus.mockClear();
      const updates = vi.fn();
      mockApp.store.subscribe("selectedPathIds", updates);

      pathSelection.selectFlight(2);

      expect(updates).toHaveBeenCalledOnce();
      expect(toastMock.announceStatus).toHaveBeenCalledExactlyOnceWith(
        "1 flight selected",
      );
    });

    it("adds the flight to the selection, or takes it out", () => {
      mockApp.selectedPathIds.add(1);

      pathSelection.selectFlight(2, true);
      expect([...mockApp.selectedPathIds]).toEqual([1, 2]);

      pathSelection.selectFlight(1, true);
      expect([...mockApp.selectedPathIds]).toEqual([2]);
    });

    describe("bringing the flight into view", () => {
      const box = (x: number, y: number, w: number, h: number): DOMRect =>
        ({
          x,
          y,
          left: x,
          top: y,
          width: w,
          height: h,
          right: x + w,
          bottom: y + h,
        }) as DOMRect;
      /** Where the map draws the west end of the flights */
      let drawnAt: { x: number; y: number };
      /** How wide the map draws a degree of longitude, in pixels */
      let degreePx: number;
      let profile: HTMLElement;
      /** The bundle, and the two frames the layout takes after it */
      const settled = async (): Promise<void> => {
        for (let i = 0; i < 4; i++) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      };

      beforeEach(() => {
        mockApp.currentData = createDataset(
          [{ id: 1 }, { id: 2 }, { id: 3 }],
          [1, 2, 3].map((id) =>
            createSegment({
              path_id: id,
              coords: [
                [50 + id, 8],
                [51 + id, 9],
              ],
            }),
          ),
        );
        const map = mockApp.map!;
        vi.spyOn(map.getContainer(), "getBoundingClientRect").mockReturnValue(
          box(0, 0, 1200, 800),
        );
        drawnAt = { x: 600, y: 300 };
        degreePx = 400;
        map.project.mockImplementation((lngLat) => ({
          x: drawnAt.x + ((lngLat as [number, number])[0] - 8) * degreePx,
          y: drawnAt.y,
        }));
        // The profile of the picked flight, at the bottom of the map
        profile = document.createElement("div");
        profile.id = "flight-profile";
        vi.spyOn(profile, "getBoundingClientRect").mockReturnValue(
          box(360, 660, 560, 113),
        );
        document.body.append(profile);
        vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation(
          (callback) => setTimeout(() => callback(0), 0) as unknown as number,
        );
      });

      afterEach(() => {
        profile.remove();
        vi.mocked(globalThis.requestAnimationFrame).mockRestore();
      });

      it("frames a flight picked from a list that is off the map", async () => {
        drawnAt = { x: -400, y: 300 };

        pathSelection.selectFlight(2);
        await settled();

        const map = mockApp.map!;
        expect(map.fitBounds).toHaveBeenCalledTimes(1);
        const [bounds, options] = map.fitBounds.mock.calls[0]!;
        expect(bounds).toEqual([
          [8, 52],
          [9, 53],
        ]);
        // Clear of the profile under it
        expect(options).toMatchObject({ padding: { bottom: 140 + 24 } });
      });

      it("frames one under its own profile", async () => {
        drawnAt = { x: 600, y: 700 };

        pathSelection.selectFlight(2);
        await settled();

        expect(mockApp.map!.fitBounds).toHaveBeenCalledTimes(1);
      });

      it("leaves the map alone when all of the flight is in view", async () => {
        pathSelection.selectFlight(2);
        await settled();

        expect(mockApp.map!.fitBounds).not.toHaveBeenCalled();
      });

      it("leaves a flight across the antimeridian alone when all of it is in view", async () => {
        // From 179.9 E to 179.9 W, drawn on the copy of the world east of
        // 180 that the map shows
        mockApp.currentData = createDataset(
          [{ id: 2 }],
          [
            createSegment({
              path_id: 2,
              coords: [
                [52, 179.9],
                [53, -179.9],
              ],
            }),
          ],
        );
        const map = mockApp.map!;
        map.jumpTo({ center: [180, 52.5] });
        map.project.mockImplementation((lngLat) => ({
          x: 600 + ((lngLat as [number, number])[0] - 180) * 2000,
          y: 300,
        }));

        pathSelection.selectFlight(2);
        await settled();

        expect(map.fitBounds).not.toHaveBeenCalled();
      });

      it("frames one in view that is too small to be seen there", async () => {
        // A circuit round the field, a speck in the middle of the heat
        degreePx = 20;

        pathSelection.selectFlight(2);
        await settled();

        expect(mockApp.map!.fitBounds).toHaveBeenCalledTimes(1);
        // A flight of a few fixes on a field is not framed closer than a
        // replay follows one
        expect(mockApp.map!.fitBounds.mock.calls[0]![1]).toMatchObject({
          maxZoom: AUTO_ZOOM_FOLLOW,
        });
      });

      it("hands the map on a phone the flight picked from the statistics or an airport", () => {
        mockApp.statsPanelVisible = true;
        mockApp.mobileBar = {
          isVisible: () => true,
        } as unknown as typeof mockApp.mobileBar;

        pathSelection.selectFlight(2);

        expect(mockApp.statsPanelVisible).toBe(false);
        expect(mockApp.airportManager.closePopup).toHaveBeenCalledOnce();

        // Not for one added, nor on the desktop, where both stand beside it
        mockApp.statsPanelVisible = true;
        pathSelection.selectFlight(3, true);
        mockApp.mobileBar = null;
        pathSelection.selectFlight(1);
        expect(mockApp.statsPanelVisible).toBe(true);
        expect(mockApp.airportManager.closePopup).toHaveBeenCalledOnce();
      });

      it("leaves it alone for a flight added, taken out, or clicked on the map", async () => {
        drawnAt = { x: -400, y: 300 };

        pathSelection.selectFlight(2, true);
        pathSelection.selectFlight(2, true);
        // A click on a path: the user is looking at it
        pathSelection.togglePathSelection(3);
        // The whole selection, picked again: nothing is selected then
        mockApp.selectedPathIds.clear();
        mockApp.selectedPathIds.add(1);
        pathSelection.selectFlight(1);
        await settled();

        expect(mockApp.map!.fitBounds).not.toHaveBeenCalled();
      });

      it("leaves the map to a user who moved it while it waited", async () => {
        drawnAt = { x: -400, y: 300 };
        const map = mockApp.map!;

        pathSelection.selectFlight(2);
        map.emit("movestart", { originalEvent: new MouseEvent("mousedown") });
        await settled();

        expect(map.fitBounds).not.toHaveBeenCalled();

        // A move of the app's own is not the user's
        pathSelection.selectFlight(3);
        map.emit("movestart", {});
        await settled();

        expect(map.fitBounds).toHaveBeenCalledTimes(1);
      });

      it("leaves the map to the hotspot tour and Wrapped", async () => {
        drawnAt = { x: -400, y: 300 };

        mockApp.tourView = {} as never;
        pathSelection.selectFlight(2);
        await settled();
        mockApp.tourView = null;
        mockApp.wrappedVisible = true;
        pathSelection.selectFlight(3);
        await settled();

        expect(mockApp.map!.fitBounds).not.toHaveBeenCalled();
      });

      it("leaves it alone when the selection changed while it waited", async () => {
        drawnAt = { x: -400, y: 300 };

        pathSelection.selectFlight(2);
        pathSelection.togglePathSelection(3);
        await settled();

        expect(mockApp.map!.fitBounds).not.toHaveBeenCalled();
      });
    });
  });

  describe("markSelected", () => {
    it("presses the buttons of the selected flights only", () => {
      mockApp.selectedPathIds.add(2);
      const buttons = [1, 2].map((id) => {
        const button = document.createElement("button");
        button.dataset["pathId"] = String(id);
        return button;
      });

      pathSelection.markSelected(buttons);

      expect(buttons.map((b) => b.getAttribute("aria-pressed"))).toEqual([
        "false",
        "true",
      ]);
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

    it("says the selection is cleared, where its going said nothing", () => {
      pathSelection.togglePathSelection(1);
      expect(toastMock.announceStatus).toHaveBeenLastCalledWith(
        "1 flight selected",
      );

      clearBtn.click();

      expect(toastMock.announceStatus).toHaveBeenLastCalledWith(
        "Selection cleared",
      );
    });

    it("clears the selection from its own control", () => {
      pathSelection.togglePathSelection(1);

      clearBtn.click();

      expect(mockApp.selectedPathIds.size).toBe(0);
      expect(chip.hidden).toBe(true);
    });

    it("hands the focus of its Clear to the map before it hides", () => {
      // Hidden with its own chip, the focused Clear dropped focus to <body>
      const canvas = mockApp.map!.getCanvas();
      canvas.tabIndex = 0;
      document.body.append(canvas);
      pathSelection.togglePathSelection(1);
      clearBtn.focus();

      clearBtn.click();

      expect(document.activeElement).toBe(canvas);
      canvas.remove();
    });

    it("counts in groups of thousands", () => {
      for (let id = 1; id <= 1200; id++) mockApp.selectedPathIds.add(id);
      mockApp.store.notifyMutation("selectedPathIds");

      expect(chipCount.textContent).toBe("1,200 flights selected");
    });
  });

  describe("isolate button", () => {
    it("is announced as unavailable without a selection, and stays focusable", () => {
      expect(btn.getAttribute("aria-disabled")).toBe("true");
      expect(btn.disabled).toBe(false);

      mockApp.selectedPathIds.add(1);
      mockApp.store.notifyMutation("selectedPathIds");
      expect(btn.getAttribute("aria-disabled")).toBe("false");

      mockApp.isolateSelection = true;
      expect(btn.getAttribute("aria-disabled")).toBe("false");
    });

    it("is unavailable and not pressed at construction without a selection", () => {
      expect(btn.getAttribute("aria-disabled")).toBe("true");
      expect(btn.getAttribute("aria-pressed")).toBe("false");
      expect(btn.classList.contains("active")).toBe(false);
      // The look comes from the stylesheet, not from inline styles
      expect(btn.style.opacity).toBe("");
      expect(btn.style.borderColor).toBe("");
      expect(btn.style.backgroundColor).toBe("");
    });

    it("reflects a restored selection and mode at construction", () => {
      const app = createMockApp({
        selectedPathIds: new Set([1]),
        isolateSelection: true,
      });

      new PathSelection(asMapApp(app));

      expect(btn.getAttribute("aria-disabled")).toBe("false");
      expect(btn.getAttribute("aria-pressed")).toBe("true");
      expect(btn.classList.contains("active")).toBe(true);
    });

    it("lights up when paths are selected and stays unpressed", () => {
      mockApp.selectedPathIds.add(1);
      mockApp.store.notifyMutation("selectedPathIds");

      expect(btn.getAttribute("aria-disabled")).toBe("false");
      expect(btn.getAttribute("aria-pressed")).toBe("false");
      expect(btn.classList.contains("active")).toBe(false);
    });

    it("follows isolate mode through the store", () => {
      mockApp.selectedPathIds.add(1);
      mockApp.store.notifyMutation("selectedPathIds");

      mockApp.isolateSelection = true;
      expect(btn.getAttribute("aria-pressed")).toBe("true");
      expect(btn.classList.contains("active")).toBe(true);
      expect(btn.getAttribute("aria-disabled")).toBe("false");

      mockApp.isolateSelection = false;
      expect(btn.getAttribute("aria-pressed")).toBe("false");
      expect(btn.getAttribute("aria-disabled")).toBe("false");
    });

    it("is unavailable again once the selection is cleared", () => {
      mockApp.selectedPathIds.add(1);
      mockApp.store.notifyMutation("selectedPathIds");
      expect(btn.getAttribute("aria-disabled")).toBe("false");

      pathSelection.clearSelection();

      expect(btn.getAttribute("aria-disabled")).toBe("true");
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
