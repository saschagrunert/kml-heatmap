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

  describe("filterByYear", () => {
    it("updates selected year from dropdown value and loads it first", async () => {
      addYearOption("2024");
      (document.getElementById("year-select") as HTMLSelectElement).value =
        "2024";
      mockApp.dataManager.loadData.mockResolvedValue(year2024Data());

      await filterManager.filterByYear();

      expect(mockApp.selectedYear).toBe("2024");
      expect(mockApp.dataManager.loadData).toHaveBeenCalledWith("2024");
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
      mockApp.dataManager.updateLayers.mockImplementation(() => {
        order.push(`updateLayers:${mockApp.selectedAircraft}`);
        return Promise.resolve();
      });

      await filterManager.filterByYear();

      // Aircraft reset to "all" BEFORE the layers are drawn, so the map is not empty
      expect(mockApp.selectedAircraft).toBe("all");
      expect(aircraftSelect().value).toBe("all");
      expect(order).toEqual(["loadData", "updateLayers:all"]);
      expect(mockApp.airportManager.updateAirportPopups).toHaveBeenCalled();
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

      await filterManager.filterByYear();

      expect(mockApp.selectedPathIds.size).toBe(1);
    });

    it("still redraws (and toasts through updateLayers) when the year fails to load", async () => {
      const previous = mockApp.currentData;
      mockApp.dataManager.loadData.mockResolvedValue(null);

      await filterManager.filterByYear();

      expect(mockApp.currentData).toBe(previous);
      expect(mockApp.dataManager.updateLayers).toHaveBeenCalled();
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

      yearSelect.value = "2024";
      const first = filterManager.filterByYear();
      yearSelect.value = "2025";
      const second = filterManager.filterByYear();

      await second;
      resolveFirst(year2024Data());
      await first;

      expect(mockApp.selectedYear).toBe("2025");
      expect(mockApp.dataManager.updateLayers).toHaveBeenCalledTimes(1);
      expect(mockApp.airportManager.updateAirportPopups).toHaveBeenCalledTimes(
        1,
      );
    });

    it("does nothing if year select element doesn't exist", async () => {
      document.getElementById("year-select")?.remove();

      await filterManager.filterByYear();

      expect(mockApp.dataManager.updateLayers).not.toHaveBeenCalled();
    });
  });

  describe("filterByAircraft", () => {
    it("updates selected aircraft from dropdown value and redraws", async () => {
      const select = aircraftSelect();
      const option = document.createElement("option");
      option.value = "D-ABCD";
      select.appendChild(option);
      select.value = "D-ABCD";

      await filterManager.filterByAircraft();

      expect(mockApp.selectedAircraft).toBe("D-ABCD");
      expect(mockApp.dataManager.updateLayers).toHaveBeenCalled();
      expect(mockApp.airportManager.updateAirportPopups).toHaveBeenCalled();
    });

    it("clears selected paths when not initializing", async () => {
      mockApp.selectedPathIds.add(1);

      await filterManager.filterByAircraft();

      expect(mockApp.selectedPathIds.size).toBe(0);
    });

    it("preserves selected paths when initializing", async () => {
      mockApp.isInitializing = true;
      mockApp.selectedPathIds.add(1);

      await filterManager.filterByAircraft();

      expect(mockApp.selectedPathIds.size).toBe(1);
    });

    it("discards stale completions when superseded", async () => {
      let resolveFirst: () => void = () => {};
      mockApp.dataManager.updateLayers
        .mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              resolveFirst = resolve;
            }),
        )
        .mockResolvedValueOnce(undefined);

      const first = filterManager.filterByAircraft();
      const second = filterManager.filterByAircraft();
      await second;
      resolveFirst();
      await first;

      expect(mockApp.airportManager.updateAirportPopups).toHaveBeenCalledTimes(
        1,
      );
    });

    it("does nothing if aircraft select element doesn't exist", async () => {
      document.getElementById("aircraft-select")?.remove();

      await filterManager.filterByAircraft();

      expect(mockApp.dataManager.updateLayers).not.toHaveBeenCalled();
    });
  });
});
