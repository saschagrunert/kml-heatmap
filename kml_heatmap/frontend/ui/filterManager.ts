/**
 * Filter Manager - Handles year/aircraft filtering
 */
import type { MapApp } from "../mapApp";
import type { KMLDataset } from "../types";
import { aggregateAircraft, filterPaths } from "../calculations/statistics";
import { datasetIndex } from "../calculations/datasetIndex";
import { calculateAirspeedRange } from "../features/layers";
import { domCache } from "../utils/domCache";
import { pluralFlights } from "../utils/htmlGenerators";
import { logError } from "../utils/logger";
import { announceStatus, showToast } from "../utils/toast";

/**
 * How long a pick in the year dropdown waits for the next one. The arrow
 * keys on a closed dropdown change it at every step, and each step loaded
 * its year: from 2026 down to 2020 six year files downloaded and decoded,
 * and stayed in memory, for the one that was wanted.
 */
export const YEAR_PICK_DELAY_MS = 250;

export class FilterManager {
  private app: MapApp;
  /** Monotonic id of the latest filter change; stale completions are dropped */
  private requestId = 0;
  /** Request id of the latest year change */
  private yearRequestId = 0;
  /**
   * The year switch that is loading, aborted by the next one: this one has
   * been replaced. Null once it is over.
   */
  private yearLoad: AbortController | null = null;
  /**
   * An aircraft picked while a year switch loads, applied with that switch
   * (see filterByAircraft). Null when there is none.
   */
  private pendingAircraft: string | null = null;
  /** The pick of the year dropdown that waits (see pickYear) */
  private yearPick: ReturnType<typeof setTimeout> | undefined;
  /**
   * Told when a year switch begins or ends; the note on an empty map
   * stays out of the way of one (see followLoadFailure)
   */
  onLoadChange: (() => void) | null = null;

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
    this.dropYearPick();
    this.yearLoad?.abort();
    this.yearLoad = null;
    this.pendingAircraft = null;
    const yearSelect = domCache.get("year-select", HTMLSelectElement);
    if (yearSelect) this.showLoadedYear(yearSelect);
    const aircraftSelect = domCache.get("aircraft-select", HTMLSelectElement);
    if (aircraftSelect) aircraftSelect.value = this.app.selectedAircraft;
    this.onLoadChange?.();
  }

  /** Whether a year switch is loading */
  get loading(): boolean {
    return this.yearLoad !== null;
  }

  /**
   * Switch to the year the dropdown shows once it has stopped changing
   * (see YEAR_PICK_DELAY_MS). Any other switch replaces a pick that waits.
   */
  pickYear(): void {
    this.dropYearPick();
    this.yearPick = setTimeout(() => {
      this.yearPick = undefined;
      if (!this.app.signal.aborted) this.filterByYear().catch(logError);
    }, YEAR_PICK_DELAY_MS);
  }

  private dropYearPick(): void {
    clearTimeout(this.yearPick);
    this.yearPick = undefined;
  }

  /**
   * Show the year whose data is loaded. With none loaded, the dropdown
   * keeps the year that failed, which the note on the empty map names and
   * offers to load again (see loadShownYear): it showed an empty "Year"
   * instead, so that picking the year it showed again was a change.
   */
  private showLoadedYear(select: HTMLSelectElement): void {
    if (this.app.currentData) select.value = this.app.selectedYear;
  }

  /**
   * Load the year of the dropdown while the map has no flights: the first
   * load of the page, and the Retry of the note on the map after it failed
   * (the year the page opened on, or one picked since that failed as well,
   * which the dropdown keeps showing). Unlike a switch it keeps the
   * selection, which is the one the page was opened with and has not been
   * checked against any dataset yet.
   */
  loadShownYear(): Promise<boolean> {
    return this.filterByYear(undefined, undefined, true);
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
   * `also` has not run either. `keepSelection` is for loadShownYear.
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
    this.dropYearPick();

    this.yearLoad?.abort();
    const yearLoad = new AbortController();
    this.yearLoad = yearLoad;
    this.onLoadChange?.();
    // Reset view puts the aircraft back to all; one picked before it is
    // overruled, one picked while it loads is applied after it
    if (also) this.pendingAircraft = null;

    // 1. Load the new year's data first so the aircraft list is based on it
    const data = await this.app.dataManager.loadData(
      requestedYear,
      yearLoad.signal,
      // Reset view is more than this switch, and its button stays there to
      // be pressed again. A retry of the first load has the panel on the
      // map to be tried again from, and a second Retry on the toast next to
      // it only made two ways of doing one thing.
      also || keepSelection
        ? undefined
        : {
            label: "Retry",
            run: () => {
              // A replay holds the filters (see above); the toast stays,
              // so the failure is not lost to a press that did nothing
              if (this.app.replayActive) {
                showToast(
                  "Stop the replay to load " + requestedYear + " again",
                  "info",
                );
                return false;
              }
              void this.filterByYear(requestedYear);
              return true;
            },
          },
    );
    if (this.yearLoad === yearLoad) this.yearLoad = null;
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
    const aircraft = this.pendingAircraft;
    this.pendingAircraft = null;
    if (!data) {
      // The loader has already reported the failure. The Filter sheet
      // mirrors the dropdown, not the store, and the store did not change,
      // so it is told to read the dropdown again.
      this.showLoadedYear(yearSelect);
      this.app.mobileBar?.sheet.refresh();
      // An aircraft picked meanwhile was one of the year still shown
      if (aircraft !== null) this.applyAircraft(aircraft);
      this.onLoadChange?.();
      return false;
    }

    // 2. Publish the year, the data and the aircraft list together, so the
    //    layers, the statistics and the airports see the final combination
    //    once. The dropdown may reset a registration that did not fly in
    //    the new year back to "all".
    //    An aircraft picked while the year loaded goes in with it, and the
    //    rebuilt list says so if the year has no flights of it.
    this.app.store.batch(() => {
      this.app.selectedYear = requestedYear;
      publishDataset(this.app, data);
      also?.();
      if (aircraft !== null) this.app.selectedAircraft = aircraft;
      this.updateAircraftDropdown();
      if (keepSelection && aircraft === null) {
        // A Retry of the first year: what its link named is said there
        dropUnknownPathIds(this.app, data, true);
      } else {
        this.clearSelectionUnlessInitializing();
      }
    });
    announceDataset(requestedYear);
    return true;
  }

  filterByAircraft(): void {
    const aircraftSelect = domCache.get("aircraft-select", HTMLSelectElement);
    if (!aircraftSelect) return;

    // A year switch that is loading, or waiting to (pickYear), is not
    // thrown away: that silently lost the year someone had just picked.
    // The aircraft goes in with it.
    if (this.yearLoad || this.yearPick !== undefined) {
      this.pendingAircraft = aircraftSelect.value;
      return;
    }
    this.applyAircraft(aircraftSelect.value);
  }

  private applyAircraft(aircraft: string): void {
    this.app.store.batch(() => {
      this.app.selectedAircraft = aircraft;
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

/**
 * Make a dataset the one the page shows. The speed scale is stretched over
 * the speeds of its flights (see calculateAirspeedRange), the way the
 * altitude scale follows the altitudes of the dataset it draws. Runs in the
 * batch that publishes the rest.
 * @param app - The MapApp instance to operate on
 * @param data - The dataset to show
 */
export function publishDataset(app: MapApp, data: KMLDataset): void {
  if (app.hasTimingData) {
    const range = calculateAirspeedRange(
      data.path_segments,
      app.metadataAirspeedRange,
    );
    // A dataset whose flights all went one speed has no scale to stretch,
    // and takes the one of the metadata: the range of the year before
    // belongs to other flights
    app.airspeedRange =
      range.max > range.min ? range : app.metadataAirspeedRange;
  }
  app.currentData = data;
}

/**
 * Say which year the map shows once its flights are there. The loading
 * indicator's region said what was loading and then went quiet, so the end
 * of a load, a retry's included, was never heard. After the batch that
 * published it: this replaces what its listeners said about the dataset,
 * such as a selection it cleared.
 * @param year - The year that was published, or "all"
 */
function announceDataset(year: string): void {
  announceStatus("Showing " + (year === "all" ? "all years" : year));
}

/**
 * Drop the restored path ids that are not in the loaded dataset.
 *
 * Ids are derived from the flights, so a shared link or a saved state keeps
 * pointing at the same flight after a re-export; one whose flight is gone
 * is dropped, which `say` tells the visitor (the first load, of the link
 * they opened). Isolation goes with the last id: the controls cannot leave
 * isolate mode on over an empty selection. A dataset missing a year that
 * failed to load cannot tell a deleted flight from an unloaded one, so it
 * drops nothing.
 * @param app - The MapApp instance to operate on
 * @param data - The dataset the selection has to refer to
 * @param say - Whether a toast says how many were left out
 */
export function dropUnknownPathIds(
  app: MapApp,
  data: KMLDataset,
  say = false,
): void {
  const selected = app.selectedPathIds;
  if (selected.size === 0 || data.incomplete) return;

  const known = datasetIndex(data).pathInfoById;
  const unknown = [...selected].filter((pathId) => !known.has(pathId));
  if (unknown.length === 0) return;

  app.store.batch(() => {
    for (const pathId of unknown) selected.delete(pathId);
    app.store.notifyMutation("selectedPathIds");
    if (selected.size === 0) app.isolateSelection = false;
  });
  if (say) {
    showToast(`Left out ${pluralFlights(unknown.length)} not on this site`);
  }
}
