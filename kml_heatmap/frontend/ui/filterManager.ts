/**
 * Filter Manager - Handles year/aircraft filtering
 */
import type { MapApp } from "../mapApp";
import { aggregateAircraft, filterPaths } from "../calculations/statistics";
import { domCache } from "../utils/domCache";
import { showToast } from "../utils/toast";

export class FilterManager {
  private app: MapApp;
  /** Monotonic id of the latest filter change; stale completions are dropped */
  private requestId = 0;
  /** Request id of the latest year change */
  private yearRequestId = 0;

  constructor(app: MapApp) {
    this.app = app;
  }

  updateAircraftDropdown(): void {
    const pathInfo = this.app.fullPathInfo;
    if (!pathInfo) return;

    const aircraftSelect = domCache.get("aircraft-select", HTMLSelectElement);
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
    for (const aircraft of aircraftList) {
      const option = document.createElement("option");
      option.value = aircraft.registration;
      const typeStr = aircraft.type ? " (" + aircraft.type + ")" : "";
      option.textContent = aircraft.registration + typeStr;
      aircraftSelect.appendChild(option);

      if (aircraft.registration === currentSelection) {
        selectedAircraftExists = true;
      }
    }

    // If current selection doesn't exist in filtered list, reset to 'all'
    if (!selectedAircraftExists && currentSelection !== "all") {
      // Said out loud, like a year that is not available: the recipient of
      // a shared link would otherwise see every aircraft without knowing
      // that the filter in the link was dropped
      const year = this.app.selectedYear;
      showToast(
        currentSelection +
          " has no flights in " +
          (year === "all" ? "the loaded years" : year) +
          ", showing all aircraft",
        "info",
      );
      this.app.selectedAircraft = "all";
      aircraftSelect.value = "all";
    } else {
      aircraftSelect.value = currentSelection;
    }
  }

  /**
   * Switch to the year the dropdown shows. The store only changes once the
   * year has loaded: a failed load puts the dropdown back to the year that
   * is still on the map instead of leaving the two disagreeing.
   */
  async filterByYear(): Promise<void> {
    const yearSelect = domCache.get("year-select", HTMLSelectElement);
    if (!yearSelect) return;

    const previousYear = this.app.selectedYear;
    const requestedYear = yearSelect.value;
    const requestId = ++this.requestId;
    this.yearRequestId = requestId;

    // 1. Load the new year's data first so the aircraft list is based on it
    const data = await this.app.dataManager.loadData(requestedYear);
    if (requestId !== this.requestId) {
      // Superseded. A newer year change owns the dropdown; an aircraft
      // change does not touch it, so it would keep showing a year that is
      // never applied, and picking that year again would fire no change
      if (
        this.yearRequestId === requestId &&
        yearSelect.value === requestedYear
      ) {
        yearSelect.value = this.app.selectedYear;
      }
      return;
    }
    if (!data) {
      // The loader has already reported the failure. The Filter sheet
      // mirrors the dropdown, not the store, and the store did not change,
      // so it is told to read the dropdown again.
      yearSelect.value = previousYear;
      this.app.mobileBar?.sheet.refresh();
      return;
    }

    // 2. Publish the year, the data and the aircraft list together, so the
    //    statistics and the airports see the final combination once. The
    //    dropdown may reset a registration that did not fly in the new year
    //    back to "all".
    this.app.store.batch(() => {
      this.app.selectedYear = requestedYear;
      this.app.currentData = data;
      this.updateAircraftDropdown();
      this.clearSelectionUnlessInitializing();
    });

    // 3. Redraw with the final year/aircraft combination
    await this.app.dataManager.updateLayers(data);
  }

  async filterByAircraft(): Promise<void> {
    const aircraftSelect = domCache.get("aircraft-select", HTMLSelectElement);
    if (!aircraftSelect) return;

    // A pending year change must not land on top of this one
    ++this.requestId;

    this.app.store.batch(() => {
      this.app.selectedAircraft = aircraftSelect.value;
      this.clearSelectionUnlessInitializing();
    });

    await this.app.dataManager.updateLayers();
  }

  /**
   * A filter change drops the selection, except while restoring state.
   * Isolate mode goes with it: left on over an empty selection, the button
   * stays pressed but cannot be released, and the next click on a flight
   * would hide every other flight at once.
   */
  private clearSelectionUnlessInitializing(): void {
    if (this.app.isInitializing) return;
    this.app.selectedPathIds.clear();
    this.app.store.notifyMutation("selectedPathIds");
    this.app.isolateSelection = false;
  }
}
