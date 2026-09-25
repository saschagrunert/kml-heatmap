/**
 * Filter Manager - Handles year/aircraft filtering
 */
import type { MapApp } from "../mapApp";
import { aggregateAircraft, filterPaths } from "../calculations/statistics";
import { dropUnknownPathIds, publishDataset } from "../appInitializer";
import { domCache } from "../utils/domCache";
import { showToast } from "../utils/toast";

export class FilterManager {
  private app: MapApp;
  /** Monotonic id of the latest filter change; stale completions are dropped */
  private requestId = 0;
  /** Request id of the latest year change */
  private yearRequestId = 0;
  /** Aborted by the next year switch: this one has been replaced */
  private yearLoad: AbortController | null = null;

  constructor(app: MapApp) {
    this.app = app;
    // A year switch still loading when a replay starts would land in the
    // middle of it: clear the selection the replay plays, reset the
    // statistics and leave the replay running over nothing. The replay is
    // the later request, so the switch gives way (see cancelPending).
    app.store.subscribe("replayActive", (active) => {
      if (active) this.cancelPending();
    });
  }

  /**
   * Drop the filter change that is still loading, a Reset view's included,
   * and show the filter that is applied in the dropdowns again
   */
  cancelPending(): void {
    ++this.requestId;
    this.yearLoad?.abort();
    this.yearLoad = null;
    const yearSelect = domCache.get("year-select", HTMLSelectElement);
    if (yearSelect) this.showLoadedYear(yearSelect);
    const aircraftSelect = domCache.get("aircraft-select", HTMLSelectElement);
    if (aircraftSelect) aircraftSelect.value = this.app.selectedAircraft;
  }

  /**
   * Show the year whose data is loaded, or no year at all when none is: a
   * dropdown that kept showing the year that failed to load offered no way
   * to ask for it again, as picking the year it shows fires no change
   */
  private showLoadedYear(select: HTMLSelectElement): void {
    if (this.app.currentData) select.value = this.app.selectedYear;
    else select.selectedIndex = -1;
  }

  /**
   * Load the year of the store once more, after its load failed. Unlike a
   * switch it keeps the selection, which is the one the page was opened
   * with and has not been checked against any dataset yet.
   */
  retryLoad(): Promise<boolean> {
    return this.filterByYear(this.app.selectedYear, undefined, true);
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

    // If current selection doesn't exist in filtered list, reset to 'all'.
    // The dropdown first: the Filter sheet mirrors it and reads it as soon
    // as the store says the filter changed.
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
      aircraftSelect.value = "all";
      this.app.selectedAircraft = "all";
    } else {
      aircraftSelect.value = currentSelection;
    }
  }

  /**
   * Switch to the year the dropdown shows. The store only changes once the
   * year has loaded: a failed load puts the dropdown back to the year that
   * is still on the map instead of leaving the two disagreeing. `year`
   * picks the year in the dropdown first, and `also` changes more of the
   * store in the same batch, before the aircraft list is rebuilt (see
   * MapApp.resetView). Resolves to whether the year was applied: false
   * when it failed to load or a newer filter change replaced it, and then
   * `also` has not run either. `keepSelection` is for a retry (retryLoad).
   */
  async filterByYear(
    year?: string,
    also?: () => void,
    keepSelection = false,
  ): Promise<boolean> {
    const yearSelect = domCache.get("year-select", HTMLSelectElement);
    // A replay holds the filters, and gives way to no switch (see the
    // constructor). The Retry of a failed switch stays on its toast into a
    // replay, and swapped the dataset under it.
    if (!yearSelect || this.app.replayActive) return false;
    if (year) yearSelect.value = year;

    const requestedYear = yearSelect.value;
    const requestId = ++this.requestId;
    this.yearRequestId = requestId;

    this.yearLoad?.abort();
    const yearLoad = new AbortController();
    this.yearLoad = yearLoad;

    // 1. Load the new year's data first so the aircraft list is based on it
    const data = await this.app.dataManager.loadData(
      requestedYear,
      yearLoad.signal,
      // Reset view is more than this switch, and its button stays there to
      // be pressed again
      also
        ? undefined
        : {
            label: "Retry",
            run: () => {
              void this.filterByYear(requestedYear, undefined, keepSelection);
            },
          },
    );
    if (requestId !== this.requestId) {
      // Superseded. A newer year change owns the dropdown; an aircraft
      // change does not touch it, so it would keep showing a year that is
      // never applied, and picking that year again would fire no change
      if (
        this.yearRequestId === requestId &&
        yearSelect.value === requestedYear
      ) {
        this.showLoadedYear(yearSelect);
      }
      return false;
    }
    if (!data) {
      // The loader has already reported the failure. The Filter sheet
      // mirrors the dropdown, not the store, and the store did not change,
      // so it is told to read the dropdown again.
      this.showLoadedYear(yearSelect);
      this.app.mobileBar?.sheet.refresh();
      return false;
    }

    // 2. Publish the year, the data and the aircraft list together, so the
    //    layers, the statistics and the airports see the final combination
    //    once. The dropdown may reset a registration that did not fly in
    //    the new year back to "all".
    this.app.store.batch(() => {
      this.app.selectedYear = requestedYear;
      publishDataset(this.app, data);
      also?.();
      this.updateAircraftDropdown();
      if (keepSelection) dropUnknownPathIds(this.app, data);
      else this.clearSelectionUnlessInitializing();
    });
    return true;
  }

  filterByAircraft(): void {
    const aircraftSelect = domCache.get("aircraft-select", HTMLSelectElement);
    if (!aircraftSelect) return;

    // A pending year change must not land on top of this one
    ++this.requestId;

    this.app.store.batch(() => {
      this.app.selectedAircraft = aircraftSelect.value;
      this.clearSelectionUnlessInitializing();
    });
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
