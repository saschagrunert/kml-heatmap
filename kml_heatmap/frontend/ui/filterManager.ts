/**
 * Filter Manager - Handles year/aircraft filtering
 */
import type { MapApp } from "../mapApp";

export class FilterManager {
  private app: MapApp;

  constructor(app: MapApp) {
    this.app = app;
  }

  updateAircraftDropdown(): void {
    if (!this.app.fullPathInfo) return;

    const aircraftSelect = document.getElementById(
      "aircraft-select"
    ) as HTMLSelectElement;
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
    const yearSelect = document.getElementById(
      "year-select"
    ) as HTMLSelectElement;
    if (!yearSelect) return;

    this.app.selectedYear = yearSelect.value;

    // Clear data cache to force reload for new year
    this.app.dataManager!.loadedData = {};
    this.app.currentResolution = null;

    // Clear current paths (but preserve selectedPathIds during initialization)
    this.app.altitudeLayer.clearLayers();
    this.app.pathSegments = {};
    if (!this.app.isInitializing) {
      this.app.selectedPathIds.clear();
    }

    // Reload current resolution data for new year
    await this.app.dataManager!.updateLayers();

    // Reload full resolution data for filtering/stats
    const fullResData = await this.app.dataManager!.loadData(
      "z14_plus",
      this.app.selectedYear
    );
    if (fullResData) {
      this.app.fullPathInfo = fullResData.path_info || [];
      this.app.fullPathSegments = fullResData.path_segments || [];
    }

    // Update aircraft dropdown to show only aircraft with flights in selected year
    this.updateAircraftDropdown();

    // Update stats based on filter
    const filteredStats = (
      window as any
    ).KMLHeatmap.calculateFilteredStatistics({
      pathInfo: this.app.fullPathInfo,
      segments: this.app.fullPathSegments,
      year: this.app.selectedYear,
      aircraft: this.app.selectedAircraft,
    });
    this.app.statsManager!.updateStatsPanel(filteredStats, false);

    // Update airport visibility based on filter
    this.app.airportManager!.updateAirportOpacity();

    // Update airport popups with current filter counts
    this.app.airportManager!.updateAirportPopups();

    // Don't save state during initialization (will be saved after path restoration)
    if (!this.app.isInitializing) {
      this.app.stateManager!.saveMapState();
    }
  }

  async filterByAircraft(): Promise<void> {
    const aircraftSelect = document.getElementById(
      "aircraft-select"
    ) as HTMLSelectElement;
    if (!aircraftSelect) return;

    this.app.selectedAircraft = aircraftSelect.value;

    // Clear current paths and reload (but preserve selectedPathIds during initialization)
    this.app.altitudeLayer.clearLayers();
    this.app.pathSegments = {};
    if (!this.app.isInitializing) {
      this.app.selectedPathIds.clear();
    }

    // Reload current resolution data to apply filter
    this.app.currentResolution = null; // Force reload
    await this.app.dataManager!.updateLayers();

    // Update stats based on filter
    const filteredStats = (
      window as any
    ).KMLHeatmap.calculateFilteredStatistics({
      pathInfo: this.app.fullPathInfo,
      segments: this.app.fullPathSegments,
      year: this.app.selectedYear,
      aircraft: this.app.selectedAircraft,
    });
    this.app.statsManager!.updateStatsPanel(filteredStats, false);

    // Update airport visibility based on filter
    this.app.airportManager!.updateAirportOpacity();

    // Update airport popups with current filter counts
    this.app.airportManager!.updateAirportPopups();

    // Don't save state during initialization (will be saved after path restoration)
    if (!this.app.isInitializing) {
      this.app.stateManager!.saveMapState();
    }
  }
}
