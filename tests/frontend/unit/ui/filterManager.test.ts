import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { FilterManager } from "../../../../kml_heatmap/frontend/ui/filterManager";
import type { MockMapApp } from "../../testHelpers";

describe("FilterManager", () => {
  let filterManager: FilterManager;
  let mockApp: MockMapApp;

  beforeEach(() => {
    // Mock window.KMLHeatmap
    window.KMLHeatmap = {
      calculateFilteredStatistics: vi.fn(() => ({
        total_points: 1000,
        num_paths: 10,
        total_distance_km: 500,
        num_airports: 0,
        airport_names: [],
        num_aircraft: 0,
        aircraft_list: [],
        total_distance_nm: 0,
      })),
    } as typeof window.KMLHeatmap;

    // Create year select element
    const yearSelect = document.createElement("select");
    yearSelect.id = "year-select";
    yearSelect.innerHTML = '<option value="all">All Years</option>';
    document.body.appendChild(yearSelect);

    // Create aircraft select element
    const aircraftSelect = document.createElement("select");
    aircraftSelect.id = "aircraft-select";
    aircraftSelect.innerHTML = '<option value="all">All Aircraft</option>';
    document.body.appendChild(aircraftSelect);

    // Create mock app
    mockApp = {
      selectedYear: "all",
      selectedAircraft: "all",
      isInitializing: false,
      fullPathInfo: [
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
      fullPathSegments: [],
      _unused_currentResolution: null,
      selectedPathIds: new Set<number>(),
      pathSegments: {},
      altitudeLayer: {
        clearLayers: vi.fn(),
      },
      dataManager: {
        loadedData: {},
        updateLayers: vi.fn().mockResolvedValue(undefined),
        loadData: vi.fn().mockResolvedValue({
          path_info: [{ id: 1, year: 2025, aircraft_registration: "D-ABCD" }],
          path_segments: [],
        }),
      },
      statsManager: {
        updateStatsPanel: vi.fn(),
      },
      airportManager: {
        updateAirportOpacity: vi.fn(),
        updateAirportPopups: vi.fn(),
      },
      stateManager: {
        saveMapState: vi.fn(),
      },
    };

    filterManager = new FilterManager(mockApp);
  });

  afterEach(() => {
    const yearSelect = document.getElementById("year-select");
    if (yearSelect) document.body.removeChild(yearSelect);
    const aircraftSelect = document.getElementById("aircraft-select");
    if (aircraftSelect) document.body.removeChild(aircraftSelect);
  });

  describe("updateAircraftDropdown", () => {
    it("populates dropdown with aircraft from all years when year is 'all'", () => {
      mockApp.selectedYear = "all";

      filterManager.updateAircraftDropdown();

      const aircraftSelect = document.getElementById(
        "aircraft-select"
      ) as HTMLSelectElement;
      expect(aircraftSelect.options.length).toBe(3); // All + 2 aircraft
      expect(aircraftSelect.options[1].value).toBe("D-ABCD");
      expect(aircraftSelect.options[2].value).toBe("D-EFGH");
    });

    it("populates dropdown with aircraft from selected year only", () => {
      mockApp.selectedYear = "2024";

      filterManager.updateAircraftDropdown();

      const aircraftSelect = document.getElementById(
        "aircraft-select"
      ) as HTMLSelectElement;
      expect(aircraftSelect.options.length).toBe(2); // All + 1 aircraft
      expect(aircraftSelect.options[1].value).toBe("D-ABCD");
    });

    it("sorts aircraft by flight count descending", () => {
      mockApp.fullPathInfo = [
        {
          id: 1,
          year: 2025,
          aircraft_registration: "D-ABCD",
          aircraft_type: "DA40",
        },
        {
          id: 2,
          year: 2025,
          aircraft_registration: "D-ABCD",
          aircraft_type: "DA40",
        },
        {
          id: 3,
          year: 2025,
          aircraft_registration: "D-EFGH",
          aircraft_type: "C172",
        },
      ];
      mockApp.selectedYear = "all";

      filterManager.updateAircraftDropdown();

      const aircraftSelect = document.getElementById(
        "aircraft-select"
      ) as HTMLSelectElement;
      expect(aircraftSelect.options[1].value).toBe("D-ABCD"); // 2 flights
      expect(aircraftSelect.options[2].value).toBe("D-EFGH"); // 1 flight
    });

    it("includes aircraft type in option text if available", () => {
      filterManager.updateAircraftDropdown();

      const aircraftSelect = document.getElementById(
        "aircraft-select"
      ) as HTMLSelectElement;
      expect(aircraftSelect.options[1].textContent).toContain("D-ABCD");
      expect(aircraftSelect.options[1].textContent).toContain("DA40");
    });

    it("resets to 'all' if current selection doesn't exist in filtered list", () => {
      mockApp.selectedAircraft = "D-NONEXISTENT";
      mockApp.selectedYear = "all";

      filterManager.updateAircraftDropdown();

      expect(mockApp.selectedAircraft).toBe("all");
      const aircraftSelect = document.getElementById(
        "aircraft-select"
      ) as HTMLSelectElement;
      expect(aircraftSelect.value).toBe("all");
    });

    it("preserves current selection if it exists in filtered list", () => {
      mockApp.selectedAircraft = "D-ABCD";

      filterManager.updateAircraftDropdown();

      const aircraftSelect = document.getElementById(
        "aircraft-select"
      ) as HTMLSelectElement;
      expect(aircraftSelect.value).toBe("D-ABCD");
    });

    it("does nothing if fullPathInfo is not set", () => {
      mockApp.fullPathInfo = null;

      expect(() => filterManager.updateAircraftDropdown()).not.toThrow();
    });

    it("does nothing if aircraft select element doesn't exist", () => {
      const aircraftSelect = document.getElementById("aircraft-select");
      if (aircraftSelect) document.body.removeChild(aircraftSelect);

      expect(() => filterManager.updateAircraftDropdown()).not.toThrow();
    });
  });

  describe("filterByYear", () => {
    it("updates selected year from dropdown value", async () => {
      const yearSelect = document.getElementById(
        "year-select"
      ) as HTMLSelectElement;
      // Add the option first
      const option = document.createElement("option");
      option.value = "2025";
      yearSelect.appendChild(option);
      yearSelect.value = "2025";

      await filterManager.filterByYear();

      expect(mockApp.selectedYear).toBe("2025");
    });

    it("clears data cache to force reload", async () => {
      mockApp.dataManager.loadedData = { some: "data" };

      await filterManager.filterByYear();

      expect(mockApp.dataManager.loadedData).toEqual({});
    });

    it("clears altitude layer", async () => {
      await filterManager.filterByYear();

      expect(mockApp.altitudeLayer.clearLayers).toHaveBeenCalled();
    });

    it("clears path segments", async () => {
      mockApp.pathSegments = { some: "data" };

      await filterManager.filterByYear();

      expect(mockApp.pathSegments).toEqual({});
    });

    it("clears selected paths when not initializing", async () => {
      mockApp.isInitializing = false;
      mockApp.selectedPathIds.add(1);

      await filterManager.filterByYear();

      expect(mockApp.selectedPathIds.size).toBe(0);
    });

    it("preserves selected paths when initializing", async () => {
      mockApp.isInitializing = true;
      mockApp.selectedPathIds.add(1);

      await filterManager.filterByYear();

      expect(mockApp.selectedPathIds.size).toBe(1);
    });

    it("reloads current resolution data", async () => {
      await filterManager.filterByYear();

      expect(mockApp.dataManager.updateLayers).toHaveBeenCalled();
    });

    it("loads full resolution data for filtering", async () => {
      const yearSelect = document.getElementById(
        "year-select"
      ) as HTMLSelectElement;
      // Add the option first
      const option = document.createElement("option");
      option.value = "2025";
      yearSelect.appendChild(option);
      yearSelect.value = "2025";

      await filterManager.filterByYear();

      expect(mockApp.dataManager.loadData).toHaveBeenCalledWith("data", "2025");
    });

    it("updates fullPathInfo from loaded data", async () => {
      const mockData = {
        path_info: [
          { id: "new1", year: 2025 },
          { id: "new2", year: 2025 },
        ],
        path_segments: [{ path_id: "new1" }],
      };
      mockApp.dataManager.loadData.mockResolvedValue(mockData);

      await filterManager.filterByYear();

      expect(mockApp.fullPathInfo).toBe(mockData.path_info);
      expect(mockApp.fullPathSegments).toBe(mockData.path_segments);
    });

    it("updates aircraft dropdown", async () => {
      vi.spyOn(filterManager, "updateAircraftDropdown");

      await filterManager.filterByYear();

      expect(filterManager.updateAircraftDropdown).toHaveBeenCalled();
    });

    it("calculates and updates statistics", async () => {
      await filterManager.filterByYear();

      expect(
        window.KMLHeatmap.calculateFilteredStatistics
      ).toHaveBeenCalledWith({
        pathInfo: mockApp.fullPathInfo,
        segments: mockApp.fullPathSegments,
        year: mockApp.selectedYear,
        aircraft: mockApp.selectedAircraft,
      });
      expect(mockApp.statsManager.updateStatsPanel).toHaveBeenCalled();
    });

    it("updates airport visibility", async () => {
      await filterManager.filterByYear();

      expect(mockApp.airportManager.updateAirportOpacity).toHaveBeenCalled();
      expect(mockApp.airportManager.updateAirportPopups).toHaveBeenCalled();
    });

    it("saves map state when not initializing", async () => {
      mockApp.isInitializing = false;

      await filterManager.filterByYear();

      expect(mockApp.stateManager.saveMapState).toHaveBeenCalled();
    });

    it("does not save state when initializing", async () => {
      mockApp.isInitializing = true;

      await filterManager.filterByYear();

      expect(mockApp.stateManager.saveMapState).not.toHaveBeenCalled();
    });

    it("does nothing if year select element doesn't exist", async () => {
      const yearSelect = document.getElementById("year-select");
      if (yearSelect) document.body.removeChild(yearSelect);

      await filterManager.filterByYear();

      expect(mockApp.dataManager.updateLayers).not.toHaveBeenCalled();
    });
  });

  describe("filterByAircraft", () => {
    it("updates selected aircraft from dropdown value", async () => {
      const aircraftSelect = document.getElementById(
        "aircraft-select"
      ) as HTMLSelectElement;
      const option = document.createElement("option");
      option.value = "D-ABCD";
      aircraftSelect.appendChild(option);
      aircraftSelect.value = "D-ABCD";

      await filterManager.filterByAircraft();

      expect(mockApp.selectedAircraft).toBe("D-ABCD");
    });

    it("clears altitude layer", async () => {
      await filterManager.filterByAircraft();

      expect(mockApp.altitudeLayer.clearLayers).toHaveBeenCalled();
    });

    it("clears path segments", async () => {
      mockApp.pathSegments = { some: "data" };

      await filterManager.filterByAircraft();

      expect(mockApp.pathSegments).toEqual({});
    });

    it("clears selected paths when not initializing", async () => {
      mockApp.isInitializing = false;
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

    it("reloads current resolution data", async () => {
      await filterManager.filterByAircraft();

      expect(mockApp.dataManager.updateLayers).toHaveBeenCalled();
    });

    it("calculates and updates statistics", async () => {
      await filterManager.filterByAircraft();

      expect(
        window.KMLHeatmap.calculateFilteredStatistics
      ).toHaveBeenCalledWith({
        pathInfo: mockApp.fullPathInfo,
        segments: mockApp.fullPathSegments,
        year: mockApp.selectedYear,
        aircraft: mockApp.selectedAircraft,
      });
      expect(mockApp.statsManager.updateStatsPanel).toHaveBeenCalled();
    });

    it("updates airport visibility", async () => {
      await filterManager.filterByAircraft();

      expect(mockApp.airportManager.updateAirportOpacity).toHaveBeenCalled();
      expect(mockApp.airportManager.updateAirportPopups).toHaveBeenCalled();
    });

    it("saves map state when not initializing", async () => {
      mockApp.isInitializing = false;

      await filterManager.filterByAircraft();

      expect(mockApp.stateManager.saveMapState).toHaveBeenCalled();
    });

    it("does not save state when initializing", async () => {
      mockApp.isInitializing = true;

      await filterManager.filterByAircraft();

      expect(mockApp.stateManager.saveMapState).not.toHaveBeenCalled();
    });

    it("does nothing if aircraft select element doesn't exist", async () => {
      const aircraftSelect = document.getElementById("aircraft-select");
      if (aircraftSelect) document.body.removeChild(aircraftSelect);

      await filterManager.filterByAircraft();

      expect(mockApp.dataManager.updateLayers).not.toHaveBeenCalled();
    });
  });
});
