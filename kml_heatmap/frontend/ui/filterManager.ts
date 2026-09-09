/**
 * Filter Manager - Handles year/aircraft filtering
 */
import type { MapApp } from "../mapApp";
import type { KMLDataset } from "../types";
import { aggregateAircraft, filterPaths } from "../calculations/statistics";
import { domCache } from "../utils/domCache";

export class FilterManager {
  private app: MapApp;
  /** Monotonic id of the latest filter change; stale completions are dropped */
  private requestId = 0;

  constructor(app: MapApp) {
    this.app = app;

    // Pre-cache filter elements
    domCache.cacheElements(["aircraft-select", "year-select"]);
  }

  updateAircraftDropdown(): void {
    const pathInfo = this.app.fullPathInfo;
    if (!pathInfo) return;

    const aircraftSelect = domCache.get(
      "aircraft-select",
    ) as HTMLSelectElement | null;
    if (!aircraftSelect) return;

    const currentSelection = this.app.selectedAircraft;

    // Clear existing options except "All"
    while (aircraftSelect.options.length > 1) {
      aircraftSelect.remove(1);
    }

    // Aircraft for the current year filter, sorted by flight count
    const aircraftList = aggregateAircraft(
      filterPaths(pathInfo, this.app.selectedYear, "all"),
    );

    // Populate dropdown
    let selectedAircraftExists = false;
    aircraftList.forEach((aircraft) => {
      const option = document.createElement("option");
      option.value = aircraft.registration;
      const typeStr = aircraft.type ? " (" + aircraft.type + ")" : "";
      option.textContent = aircraft.registration + typeStr;
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
    const yearSelect = domCache.get("year-select") as HTMLSelectElement | null;
    if (!yearSelect) return;

    this.app.selectedYear = yearSelect.value;
    const requestId = ++this.requestId;

    // 1. Load the new year's data first so the aircraft list is based on it
    const data = await this.app.dataManager.loadData(this.app.selectedYear);
    if (requestId !== this.requestId) return; // superseded by a newer change
    if (data) {
      this.app.currentData = data;
    }

    // 2. Rebuild the aircraft dropdown; this may reset a registration that
    //    did not fly in the new year back to "all"
    this.updateAircraftDropdown();

    // 3. Redraw with the final year/aircraft combination (stats included)
    await this.applyFilter(data);
    if (requestId !== this.requestId) return;

    // 4. Airport popups follow the filter
    this.app.airportManager.updateAirportPopups();
  }

  async filterByAircraft(): Promise<void> {
    const aircraftSelect = domCache.get(
      "aircraft-select",
    ) as HTMLSelectElement | null;
    if (!aircraftSelect) return;

    this.app.selectedAircraft = aircraftSelect.value;
    const requestId = ++this.requestId;

    await this.applyFilter();
    if (requestId !== this.requestId) return;

    this.app.airportManager.updateAirportPopups();
  }

  private async applyFilter(preloaded?: KMLDataset | null): Promise<void> {
    if (!this.app.isInitializing) {
      this.app.selectedPathIds.clear();
      this.app.store.notifyMutation("selectedPathIds");
    }

    await this.app.dataManager.updateLayers(preloaded);
  }
}
