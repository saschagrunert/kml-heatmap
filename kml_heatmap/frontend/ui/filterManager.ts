/**
 * Filter Manager - Handles year/aircraft filtering
 */
import type { MapApp } from "../mapApp";
import { domCache } from "../utils/domCache";

export class FilterManager {
  private app: MapApp;

  constructor(app: MapApp) {
    this.app = app;

    // Pre-cache filter elements
    domCache.cacheElements(["aircraft-select", "year-select"]);
  }

  updateAircraftDropdown(): void {
    if (!this.app.fullPathInfo) return;

    const aircraftSelect = domCache.get("aircraft-select") as HTMLSelectElement;
    if (!aircraftSelect) return;

    const currentSelection = this.app.selectedAircraft;

    // Clear existing options except "All"
    while (aircraftSelect.options.length > 1) {
      aircraftSelect.remove(1);
    }

    // Get aircraft for the current year filter
    let yearFilteredPathInfo;
    if (this.app.selectedYear === "all") {
      yearFilteredPathInfo = this.app.fullPathInfo;
    } else {
      yearFilteredPathInfo = this.app.fullPathInfo.filter((pathInfo) => {
        return (
          pathInfo.year && pathInfo.year.toString() === this.app.selectedYear
        );
      });
    }

    // Collect aircraft from filtered paths
    const aircraftMap: {
      [registration: string]: {
        registration: string;
        type?: string;
        flights: number;
      };
    } = {};
    yearFilteredPathInfo.forEach((pathInfo) => {
      if (pathInfo.aircraft_registration) {
        const reg = pathInfo.aircraft_registration;
        if (!aircraftMap[reg]) {
          aircraftMap[reg] = {
            registration: reg,
            type: pathInfo.aircraft_type,
            flights: 0,
          };
        }
        aircraftMap[reg].flights += 1;
      }
    });

    // Convert to sorted list
    const aircraftList = Object.values(aircraftMap).sort((a, b) => {
      return b.flights - a.flights;
    });

    // Populate dropdown
    let selectedAircraftExists = false;
    aircraftList.forEach((aircraft) => {
      const option = document.createElement("option");
      option.value = aircraft.registration;
      const typeStr = aircraft.type ? " (" + aircraft.type + ")" : "";
      option.textContent = "✈️ " + aircraft.registration + typeStr;
      aircraftSelect.appendChild(option);

      if (aircraft.registration === currentSelection) {
        selectedAircraftExists = true;
      }
    });

    // If current selection doesn't exist in filtered list, reset to 'all'
    if (!selectedAircraftExists && currentSelection !== "all") {
      this.app.selectedAircraft = "all";
      aircraftSelect.value = "all";
    } else {
      aircraftSelect.value = currentSelection;
    }
  }

  async filterByYear(): Promise<void> {
    const yearSelect = domCache.get("year-select") as HTMLSelectElement;
    if (!yearSelect) return;

    this.app.selectedYear = yearSelect.value;
    this.app.dataManager.loadedData = {};

    await this.applyFilter();

    // Reload full resolution data for the new year
    const fullResData = await this.app.dataManager.loadData(
      "data",
      this.app.selectedYear
    );
    if (fullResData) {
      this.app.fullPathInfo = fullResData.path_info || [];
      this.app.fullPathSegments = fullResData.path_segments || [];
    }

    this.updateAircraftDropdown();
    this.updateStatsAndAirports();
  }

  async filterByAircraft(): Promise<void> {
    const aircraftSelect = domCache.get("aircraft-select") as HTMLSelectElement;
    if (!aircraftSelect) return;

    this.app.selectedAircraft = aircraftSelect.value;

    await this.applyFilter();
    this.updateStatsAndAirports();
  }

  private async applyFilter(): Promise<void> {
    this.app.altitudeLayer.clearLayers();
    this.app.pathSegments = {};
    if (!this.app.isInitializing) {
      this.app.selectedPathIds.clear();
      this.app.store.notifyMutation("selectedPathIds");
    }

    await this.app.dataManager.updateLayers();
  }

  private updateStatsAndAirports(): void {
    const filteredStats = window.KMLHeatmap.calculateFilteredStatistics({
      pathInfo: this.app.fullPathInfo ?? [],
      segments: this.app.fullPathSegments ?? [],
      year: this.app.selectedYear,
      aircraft: this.app.selectedAircraft,
      coordinateCount: this.app.currentData?.original_points,
    });
    this.app.statsManager.updateStatsPanel(filteredStats, false);
    this.app.airportManager.updateAirportOpacity();
    this.app.airportManager.updateAirportPopups();
  }
}
