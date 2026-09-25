import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { FilterManager } from "../../../../kml_heatmap/frontend/ui/filterManager";
import type { KMLDataset } from "../../../../kml_heatmap/frontend/types";
import {
  createMockApp,
  createDataset,
  createSegment,
  asMapApp,
  type MockApp,
} from "../../testHelpers";

const toastMock = vi.hoisted(() => ({
  showToast: vi.fn(),
  dismissToast: vi.fn(),
}));
vi.mock("../../../../kml_heatmap/frontend/utils/toast", () => toastMock);

describe("FilterManager", () => {
  let filterManager: FilterManager;
  let mockApp: MockApp;

  const allYearsData = (): KMLDataset =>
    createDataset(
      [
        {
          id: 1,
          year: 2025,
          aircraft_registration: "D-ABCD",
          aircraft_type: "DA40",
        },
        {
          id: 2,
          year: 2025,
          aircraft_registration: "D-EFGH",
          aircraft_type: "C172",
        },
        {
          id: 3,
          year: 2024,
          aircraft_registration: "D-ABCD",
          aircraft_type: "DA40",
        },
      ],
      [
        createSegment({ path_id: 1 }),
        createSegment({ path_id: 2 }),
        createSegment({ path_id: 3 }),
      ],
    );

  const year2024Data = (): KMLDataset =>
    createDataset(
      [
        {
          id: 3,
          year: 2024,
          aircraft_registration: "D-ABCD",
          aircraft_type: "DA40",
        },
      ],
      [createSegment({ path_id: 3 })],
    );

  function addYearOption(value: string): void {
    const yearSelect = document.getElementById(
      "year-select",
    ) as HTMLSelectElement;
    const option = document.createElement("option");
    option.value = value;
    yearSelect.appendChild(option);
  }

  function aircraftSelect(): HTMLSelectElement {
    return document.getElementById("aircraft-select") as HTMLSelectElement;
  }

  beforeEach(() => {
    const yearSelect = document.createElement("select");
    yearSelect.id = "year-select";
    yearSelect.innerHTML = '<option value="all">All Years</option>';
    document.body.appendChild(yearSelect);

    const select = document.createElement("select");
    select.id = "aircraft-select";
    select.innerHTML = '<option value="all">All Aircraft</option>';
    document.body.appendChild(select);

    mockApp = createMockApp({ currentData: allYearsData() });
    mockApp.dataManager.loadData.mockResolvedValue(allYearsData());
    filterManager = new FilterManager(asMapApp(mockApp));
    toastMock.showToast.mockClear();
  });

  afterEach(() => {
    document.getElementById("year-select")?.remove();
    document.getElementById("aircraft-select")?.remove();
  });

  describe("updateAircraftDropdown", () => {
    it("populates dropdown with aircraft from all years when year is 'all'", () => {
      mockApp.selectedYear = "all";

      filterManager.updateAircraftDropdown();

      const options = [...aircraftSelect().options].map((o) => o.value);
      expect(options).toEqual(["all", "D-ABCD", "D-EFGH"]);
    });

    it("populates dropdown with aircraft from selected year only", () => {
      mockApp.selectedYear = "2024";

      filterManager.updateAircraftDropdown();

      const options = [...aircraftSelect().options].map((o) => o.value);
      expect(options).toEqual(["all", "D-ABCD"]);
    });

    it("sorts aircraft by flight count descending", () => {
      mockApp.currentData = createDataset([
        { id: 1, year: 2025, aircraft_registration: "D-EFGH" },
        { id: 2, year: 2025, aircraft_registration: "D-ABCD" },
        { id: 3, year: 2025, aircraft_registration: "D-ABCD" },
      ]);

      filterManager.updateAircraftDropdown();

      const options = [...aircraftSelect().options].map((o) => o.value);
      expect(options).toEqual(["all", "D-ABCD", "D-EFGH"]);
    });

    it("includes aircraft type in option text if available", () => {
      filterManager.updateAircraftDropdown();

      expect(aircraftSelect().options[1]!.textContent).toBe("D-ABCD (DA40)");
    });

    it("clears previously added options", () => {
      filterManager.updateAircraftDropdown();
      filterManager.updateAircraftDropdown();

      expect(aircraftSelect().options).toHaveLength(3);
    });

    it("resets to 'all' if current selection doesn't exist in filtered list", () => {
      mockApp.selectedAircraft = "D-NONEXISTENT";

      filterManager.updateAircraftDropdown();

      expect(mockApp.selectedAircraft).toBe("all");
      expect(aircraftSelect().value).toBe("all");
      // Said out loud: the recipient of a shared link would otherwise see
      // every aircraft without knowing that the link's filter was dropped
      expect(toastMock.showToast).toHaveBeenCalledWith(
        "D-NONEXISTENT has no flights in the loaded years, showing all aircraft",
        "info",
      );
    });

    it("names the year the aircraft did not fly in", () => {
      mockApp.selectedYear = "2024";
      mockApp.selectedAircraft = "D-EFGH";

      filterManager.updateAircraftDropdown();

      expect(mockApp.selectedAircraft).toBe("all");
      expect(toastMock.showToast).toHaveBeenCalledWith(
        "D-EFGH has no flights in 2024, showing all aircraft",
        "info",
      );
    });

    it("says nothing when the selection is kept or was 'all'", () => {
      filterManager.updateAircraftDropdown();
      mockApp.selectedAircraft = "D-ABCD";
      filterManager.updateAircraftDropdown();

      expect(toastMock.showToast).not.toHaveBeenCalled();
    });

    it("preserves current selection if it exists in filtered list", () => {
      mockApp.selectedAircraft = "D-ABCD";

      filterManager.updateAircraftDropdown();

      expect(mockApp.selectedAircraft).toBe("D-ABCD");
      expect(aircraftSelect().value).toBe("D-ABCD");
    });

    it("does nothing if no data is loaded", () => {
      mockApp.currentData = null;

      filterManager.updateAircraftDropdown();

      expect(aircraftSelect().options).toHaveLength(1);
    });

    it("does nothing if aircraft select element doesn't exist", () => {
      document.getElementById("aircraft-select")?.remove();

      expect(() => filterManager.updateAircraftDropdown()).not.toThrow();
    });
  });

  /** Called once per update of what the layers draw, as DataManager is */
  const followDrawnKeys = (): ReturnType<typeof vi.fn> => {
    const listener = vi.fn();
    mockApp.store.subscribeKeys(
      [
        "currentData",
        "selectedYear",
        "selectedAircraft",
        "selectedPathIds",
        "isolateSelection",
      ],
      listener,
    );
    return listener;
  };

  describe("filterByYear", () => {
    it("updates selected year from dropdown value and loads it first", async () => {
      addYearOption("2024");
      (document.getElementById("year-select") as HTMLSelectElement).value =
        "2024";
      mockApp.dataManager.loadData.mockResolvedValue(year2024Data());

      await filterManager.filterByYear();

      expect(mockApp.selectedYear).toBe("2024");
      expect(mockApp.dataManager.loadData).toHaveBeenCalledWith(
        "2024",
        expect.any(AbortSignal),
        expect.objectContaining({ label: "Retry" }),
      );
      expect(mockApp.currentData).toEqual(year2024Data());
    });

    it("renders the full new year when the selected aircraft did not fly that year (regression)", async () => {
      // 2025 with D-EFGH selected, switch to 2024 where only D-ABCD flew
      mockApp.selectedYear = "2025";
      mockApp.selectedAircraft = "D-EFGH";
      aircraftSelect().innerHTML =
        '<option value="all">All Aircraft</option><option value="D-EFGH">D-EFGH</option>';
      aircraftSelect().value = "D-EFGH";
      addYearOption("2024");
      (document.getElementById("year-select") as HTMLSelectElement).value =
        "2024";
      mockApp.dataManager.loadData.mockResolvedValue(year2024Data());

      const order: string[] = [];
      mockApp.dataManager.loadData.mockImplementation(() => {
        order.push("loadData");
        return Promise.resolve(year2024Data());
      });
      // The layers are drawn when the dataset is published (DataManager
      // follows the store)
      mockApp.store.subscribe("currentData", () => {
        order.push(`draw:${mockApp.selectedAircraft}`);
      });

      await filterManager.filterByYear();

      // Aircraft reset to "all" BEFORE the layers are drawn, so the map is not empty
      expect(mockApp.selectedAircraft).toBe("all");
      expect(aircraftSelect().value).toBe("all");
      expect(order).toEqual(["loadData", "draw:all"]);
    });

    it("publishes the year, the data and the aircraft list in one flush", async () => {
      mockApp.selectedAircraft = "D-EFGH";
      aircraftSelect().innerHTML =
        '<option value="all">All Aircraft</option><option value="D-EFGH">D-EFGH</option>';
      aircraftSelect().value = "D-EFGH";
      addYearOption("2024");
      (document.getElementById("year-select") as HTMLSelectElement).value =
        "2024";
      const newData = year2024Data();
      mockApp.dataManager.loadData.mockResolvedValue(newData);
      // What a listener sees when it is told about the year
      const seen: { data: KMLDataset | null; aircraft: string }[] = [];
      mockApp.store.subscribe("selectedYear", () => {
        seen.push({
          data: mockApp.currentData,
          aircraft: mockApp.selectedAircraft,
        });
      });

      await filterManager.filterByYear();

      // Never a new year with the old data or an aircraft that did not fly
      expect(seen).toEqual([{ data: newData, aircraft: "all" }]);
    });

    it("keeps the aircraft selection when it exists in the new year", async () => {
      mockApp.selectedAircraft = "D-ABCD";
      addYearOption("2024");
      (document.getElementById("year-select") as HTMLSelectElement).value =
        "2024";
      mockApp.dataManager.loadData.mockResolvedValue(year2024Data());

      await filterManager.filterByYear();

      expect(mockApp.selectedAircraft).toBe("D-ABCD");
    });

    it("clears selected paths when not initializing", async () => {
      mockApp.selectedPathIds.add(1);
      const notify = vi.spyOn(mockApp.store, "notifyMutation");

      await filterManager.filterByYear();

      expect(mockApp.selectedPathIds.size).toBe(0);
      expect(notify).toHaveBeenCalledWith("selectedPathIds");
    });

    it("preserves selected paths when initializing", async () => {
      mockApp.isInitializing = true;
      mockApp.selectedPathIds.add(1);
      mockApp.isolateSelection = true;

      await filterManager.filterByYear();

      expect(mockApp.selectedPathIds.size).toBe(1);
      expect(mockApp.isolateSelection).toBe(true);
    });

    it("leaves isolate mode together with the selection", async () => {
      mockApp.selectedPathIds.add(1);
      mockApp.isolateSelection = true;

      await filterManager.filterByYear();

      expect(mockApp.isolateSelection).toBe(false);
    });

    it("picks the year it is given and changes more of the store in the same flush", async () => {
      // What Reset view does: from 2024 and a registration that did not fly
      // in 2025, back to 2025 and every aircraft
      mockApp.selectedYear = "2024";
      mockApp.selectedAircraft = "D-XXXX";
      mockApp.heatmapVisible = false;
      addYearOption("2024");
      addYearOption("2025");
      const yearSelect = document.getElementById(
        "year-select",
      ) as HTMLSelectElement;
      yearSelect.value = "2024";
      const listener = vi.fn();
      mockApp.store.subscribeKeys(
        ["selectedYear", "selectedAircraft", "heatmapVisible"],
        listener,
      );

      const applied = await filterManager.filterByYear("2025", () => {
        mockApp.selectedAircraft = "all";
        mockApp.heatmapVisible = true;
      });

      expect(applied).toBe(true);
      expect(yearSelect.value).toBe("2025");
      // A Reset view is more than the switch; its button is the retry
      expect(mockApp.dataManager.loadData).toHaveBeenCalledWith(
        "2025",
        expect.any(AbortSignal),
        undefined,
      );
      expect(mockApp.selectedYear).toBe("2025");
      expect(mockApp.heatmapVisible).toBe(true);
      expect(listener).toHaveBeenCalledTimes(1);
      // The aircraft went back before the list was rebuilt, so the
      // registration that did not fly is not reported as dropped
      expect(mockApp.selectedAircraft).toBe("all");
      expect(toastMock.showToast).not.toHaveBeenCalled();
    });

    it("changes nothing more when the year it is given fails to load", async () => {
      mockApp.heatmapVisible = false;
      mockApp.dataManager.loadData.mockResolvedValue(null);
      const also = vi.fn();

      const applied = await filterManager.filterByYear("all", also);

      // Reset view relies on this to leave the rest alone too
      expect(applied).toBe(false);
      expect(also).not.toHaveBeenCalled();
      expect(mockApp.heatmapVisible).toBe(false);
    });

    it("puts the dropdown back and leaves the store alone when the year fails to load", async () => {
      const previous = mockApp.currentData;
      mockApp.selectedYear = "2025";
      addYearOption("2025");
      addYearOption("2024");
      const yearSelect = document.getElementById(
        "year-select",
      ) as HTMLSelectElement;
      yearSelect.value = "2024";
      mockApp.dataManager.loadData.mockResolvedValue(null);
      const listener = followDrawnKeys();
      const sheet = { refresh: vi.fn() };
      mockApp.mobileBar = { sheet } as unknown as MockApp["mobileBar"];

      await filterManager.filterByYear();

      // The map still shows 2025, so the dropdown says so too
      expect(mockApp.selectedYear).toBe("2025");
      expect(yearSelect.value).toBe("2025");
      expect(mockApp.currentData).toBe(previous);
      expect(listener).not.toHaveBeenCalled();
      // The Filter sheet mirrors the dropdown, not the store, which did not
      // change; without this it kept showing the year that failed
      expect(sheet.refresh).toHaveBeenCalledTimes(1);
    });

    it("discards stale completions when a newer year change arrives", async () => {
      addYearOption("2024");
      addYearOption("2025");
      const yearSelect = document.getElementById(
        "year-select",
      ) as HTMLSelectElement;
      let resolveFirst: (d: KMLDataset) => void = () => {};
      mockApp.dataManager.loadData
        .mockImplementationOnce(
          () =>
            new Promise<KMLDataset>((resolve) => {
              resolveFirst = resolve;
            }),
        )
        .mockResolvedValueOnce(allYearsData());
      const redraws = followDrawnKeys();

      yearSelect.value = "2024";
      const first = filterManager.filterByYear();
      yearSelect.value = "2025";
      const second = filterManager.filterByYear();

      expect(await second).toBe(true);
      resolveFirst(year2024Data());
      // Reset view relies on this to leave the camera to the newer change
      expect(await first).toBe(false);

      expect(mockApp.selectedYear).toBe("2025");
      expect(redraws).toHaveBeenCalledTimes(1);
      // The newer change owns the dropdown
      expect(yearSelect.value).toBe("2025");
    });

    it("abandons the load of a year change that a newer one replaced", async () => {
      addYearOption("2024");
      addYearOption("2025");
      const yearSelect = document.getElementById(
        "year-select",
      ) as HTMLSelectElement;
      mockApp.dataManager.loadData.mockResolvedValue(year2024Data());
      const signalOf = (call: number): AbortSignal =>
        mockApp.dataManager.loadData.mock.calls[call]![1] as AbortSignal;

      yearSelect.value = "2024";
      const first = filterManager.filterByYear();
      yearSelect.value = "2025";
      const second = filterManager.filterByYear();
      await Promise.all([first, second]);

      expect(signalOf(0).aborted).toBe(true);
      expect(signalOf(1).aborted).toBe(false);
    });

    it("leaves the dropdown to a newer year change that is still loading", async () => {
      addYearOption("2024");
      addYearOption("2023");
      const yearSelect = document.getElementById(
        "year-select",
      ) as HTMLSelectElement;
      let resolveFirst: (d: KMLDataset) => void = () => {};
      mockApp.dataManager.loadData
        .mockImplementationOnce(
          () =>
            new Promise<KMLDataset>((resolve) => {
              resolveFirst = resolve;
            }),
        )
        .mockImplementationOnce(() => new Promise<KMLDataset>(() => {}));

      yearSelect.value = "2024";
      const first = filterManager.filterByYear();
      // Back to a year that is still being requested by the first change
      yearSelect.value = "2023";
      void filterManager.filterByYear();
      yearSelect.value = "2024";
      void filterManager.filterByYear();
      resolveFirst(year2024Data());
      await first;

      expect(yearSelect.value).toBe("2024");
    });

    it("retries the switch from the toast of its failure", async () => {
      addYearOption("2024");
      const yearSelect = document.getElementById(
        "year-select",
      ) as HTMLSelectElement;
      yearSelect.value = "2024";
      mockApp.dataManager.loadData.mockResolvedValueOnce(null);
      await filterManager.filterByYear();
      const [, , retry] = mockApp.dataManager.loadData.mock.calls[0] as [
        string,
        AbortSignal,
        { run: () => void },
      ];
      mockApp.dataManager.loadData.mockResolvedValue(year2024Data());

      retry.run();

      await vi.waitFor(() => expect(mockApp.selectedYear).toBe("2024"));
    });

    it("shows no year when a switch fails with nothing loaded", async () => {
      // The first load failed: re-picking the year the dropdown showed was
      // no change and asked for nothing
      mockApp.currentData = null;
      mockApp.selectedYear = "2025";
      addYearOption("2025");
      addYearOption("2024");
      const yearSelect = document.getElementById(
        "year-select",
      ) as HTMLSelectElement;
      yearSelect.value = "2024";
      mockApp.dataManager.loadData.mockResolvedValue(null);

      await filterManager.filterByYear();

      expect(yearSelect.selectedIndex).toBe(-1);
    });

    it("retries the year of the store and keeps the selection it can", async () => {
      // The page was opened with a selection the failed load never checked
      mockApp.currentData = null;
      mockApp.selectedYear = "2024";
      addYearOption("2024");
      mockApp.selectedPathIds.add(3);
      mockApp.selectedPathIds.add(99);
      mockApp.dataManager.loadData.mockResolvedValue(year2024Data());

      expect(await filterManager.retryLoad()).toBe(true);

      expect(mockApp.dataManager.loadData.mock.calls[0]![0]).toBe("2024");
      expect(mockApp.currentData).toEqual(year2024Data());
      expect([...mockApp.selectedPathIds]).toEqual([3]);
    });

    it("gives way to a replay that starts while the year loads", async () => {
      // The switch used to land in the middle of the replay: the selection
      // it played went, and the statistics reset under it
      mockApp.selectedYear = "2025";
      addYearOption("2025");
      addYearOption("2024");
      const yearSelect = document.getElementById(
        "year-select",
      ) as HTMLSelectElement;
      mockApp.selectedPathIds.add(1);
      const previous = mockApp.currentData;
      let resolve: (d: KMLDataset) => void = () => {};
      mockApp.dataManager.loadData.mockImplementation(
        () =>
          new Promise<KMLDataset>((r) => {
            resolve = r;
          }),
      );

      yearSelect.value = "2024";
      const pending = filterManager.filterByYear();
      mockApp.replayActive = true;
      const signal = mockApp.dataManager.loadData.mock
        .calls[0]![1] as AbortSignal;

      // The dropdown shows the year the replay plays in again
      expect(yearSelect.value).toBe("2025");
      expect(signal.aborted).toBe(true);
      resolve(year2024Data());
      expect(await pending).toBe(false);
      expect(mockApp.selectedYear).toBe("2025");
      expect(mockApp.currentData).toBe(previous);
      expect([...mockApp.selectedPathIds]).toEqual([1]);
    });

    it("leaves a running replay alone when the toast's Retry is pressed", async () => {
      // The toast of a failed switch stays into a replay, and its Retry
      // swapped the dataset under the flight being played
      addYearOption("2025");
      addYearOption("2024");
      mockApp.selectedYear = "2025";
      const yearSelect = document.getElementById(
        "year-select",
      ) as HTMLSelectElement;
      yearSelect.value = "2024";
      mockApp.dataManager.loadData.mockResolvedValueOnce(null);
      await filterManager.filterByYear();
      const [, , retry] = mockApp.dataManager.loadData.mock.calls[0] as [
        string,
        AbortSignal,
        { run: () => void },
      ];
      const previous = mockApp.currentData;
      mockApp.selectedPathIds.add(1);
      mockApp.replayActive = true;
      mockApp.dataManager.loadData.mockClear();
      mockApp.dataManager.loadData.mockResolvedValue(year2024Data());

      retry.run();
      await Promise.resolve();

      expect(mockApp.dataManager.loadData).not.toHaveBeenCalled();
      expect(yearSelect.value).toBe("2025");
      expect(mockApp.selectedYear).toBe("2025");
      expect(mockApp.currentData).toBe(previous);
      expect([...mockApp.selectedPathIds]).toEqual([1]);
    });

    it("does nothing if year select element doesn't exist", async () => {
      document.getElementById("year-select")?.remove();
      const redraws = followDrawnKeys();

      await filterManager.filterByYear();

      expect(redraws).not.toHaveBeenCalled();
      expect(mockApp.dataManager.loadData).not.toHaveBeenCalled();
    });
  });

  describe("filterByAircraft", () => {
    it("updates selected aircraft from dropdown value, in one update", () => {
      const select = aircraftSelect();
      const option = document.createElement("option");
      option.value = "D-ABCD";
      select.appendChild(option);
      select.value = "D-ABCD";
      mockApp.selectedPathIds.add(1);
      const redraws = followDrawnKeys();

      filterManager.filterByAircraft();

      expect(mockApp.selectedAircraft).toBe("D-ABCD");
      expect(redraws).toHaveBeenCalledTimes(1);
    });

    it("clears the selection in the same flush as the aircraft change", () => {
      const select = aircraftSelect();
      const option = document.createElement("option");
      option.value = "D-ABCD";
      select.appendChild(option);
      select.value = "D-ABCD";
      mockApp.selectedPathIds.add(1);
      const seen: number[] = [];
      mockApp.store.subscribe("selectedAircraft", () => {
        seen.push(mockApp.selectedPathIds.size);
      });

      filterManager.filterByAircraft();

      expect(seen).toEqual([0]);
    });

    it("clears selected paths when not initializing", () => {
      mockApp.selectedPathIds.add(1);

      filterManager.filterByAircraft();

      expect(mockApp.selectedPathIds.size).toBe(0);
    });

    it("preserves selected paths when initializing", () => {
      mockApp.isInitializing = true;
      mockApp.selectedPathIds.add(1);

      filterManager.filterByAircraft();

      expect(mockApp.selectedPathIds.size).toBe(1);
    });

    it("leaves isolate mode in the same flush as the selection (regression)", () => {
      mockApp.selectedPathIds.add(1);
      mockApp.isolateSelection = true;
      const select = aircraftSelect();
      const option = document.createElement("option");
      option.value = "D-ABCD";
      select.appendChild(option);
      select.value = "D-ABCD";
      const seen: [number, boolean][] = [];
      mockApp.store.subscribe("selectedPathIds", () => {
        seen.push([mockApp.selectedPathIds.size, mockApp.isolateSelection]);
      });

      filterManager.filterByAircraft();

      // Isolating an empty selection left the button pressed but stuck, and
      // the next flight click hid every other flight at once
      expect(seen).toEqual([[0, false]]);
    });

    it("supersedes a year change that is still loading", async () => {
      addYearOption("2024");
      const yearSelect = document.getElementById(
        "year-select",
      ) as HTMLSelectElement;
      let resolveYear: (d: KMLDataset) => void = () => {};
      mockApp.dataManager.loadData.mockImplementationOnce(
        () =>
          new Promise<KMLDataset>((resolve) => {
            resolveYear = resolve;
          }),
      );
      const before = mockApp.currentData;
      const redraws = followDrawnKeys();

      yearSelect.value = "2024";
      const pendingYear = filterManager.filterByYear();
      filterManager.filterByAircraft();
      resolveYear(year2024Data());
      await pendingYear;

      // The year that finished loading after the aircraft change is dropped
      expect(mockApp.selectedYear).toBe("all");
      expect(mockApp.currentData).toBe(before);
      expect(redraws).toHaveBeenCalledTimes(1);
      // ... and so is the year the dropdown showed for it (regression)
      expect(yearSelect.value).toBe("all");
    });

    it("does nothing if aircraft select element doesn't exist", () => {
      document.getElementById("aircraft-select")?.remove();
      const redraws = followDrawnKeys();

      filterManager.filterByAircraft();

      expect(redraws).not.toHaveBeenCalled();
    });
  });
});
