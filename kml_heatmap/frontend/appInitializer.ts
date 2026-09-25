/**
 * App Initializer - Handles initial data loading and airport marker creation
 * Extracted from MapApp to reduce file size and improve modularity
 */

import { Marker } from "maplibre-gl";
import {
  createAirportElement,
  setAirportElementHome,
} from "./features/airports";
import { domCache } from "./utils/domCache";
import { applyMetricColors } from "./utils/htmlGenerators";
import { createActivationFilter, toLngLat } from "./utils/mapHelpers";
import { announceStatus, showToast } from "./utils/toast";
import { setAirportLabelHover } from "./ui/airportLabels";
import { datasetIndex } from "./calculations/datasetIndex";
import { calculateAirspeedRange } from "./features/layers";
import type { MapApp } from "./mapApp";
import type { Airport, AirportMarker, KMLDataset } from "./types";

/**
 * Populate the year dropdown and make sure the selected year exists.
 * A restored/URL year that is not available falls back to the latest year
 * (with a toast) so the select never ends up blank.
 * @param app - The MapApp instance to operate on
 * @param availableYears - Years listed in the metadata
 */
export function resolveYearSelection(
  app: MapApp,
  availableYears: number[],
): void {
  const select = domCache.get("year-select", HTMLSelectElement);

  if (select) {
    for (const year of availableYears) {
      const option = document.createElement("option");
      option.value = year.toString();
      option.textContent = String(year);
      select.appendChild(option);
    }
  }

  const latestValue =
    availableYears.length > 0 ? Math.max(...availableYears).toString() : "all";
  app.defaultYear = latestValue;

  let year = app.selectedYear;
  if (year === "all") {
    // Default to the latest year only if no saved state exists
    if (!app.restoredYearFromState) year = latestValue;
  } else if (!availableYears.some((known) => known.toString() === year)) {
    showToast(
      "Year " +
        year +
        " is not available, showing " +
        (availableYears.length > 0 ? latestValue : "all years"),
      "info",
    );
    year = latestValue;
  }

  // The dropdown before the store: the Filter sheet mirrors the dropdown
  // and reads it as soon as the store announces the year
  if (select) select.value = year;
  app.selectedYear = year;
}

/** What the year dropdown says while no year is loaded */
export const NO_YEAR_LABEL = "Year";

/**
 * Show no year in the dropdown: a placeholder that cannot be picked, so
 * that picking the year that failed is a change and asks for it again. With
 * no option selected the control showed no text at all.
 */
export function showNoYear(select: HTMLSelectElement): void {
  let placeholder = Array.from(select.options).find(
    (option) => option.value === "",
  );
  if (!placeholder) {
    placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = NO_YEAR_LABEL;
    placeholder.disabled = true;
    placeholder.hidden = true;
    select.prepend(placeholder);
  }
  placeholder.selected = true;
}

/**
 * Load initial data including airports, metadata, and path data
 * @param app - The MapApp instance to operate on
 */
export async function loadInitialData(app: MapApp): Promise<void> {
  colorSegmentPopups();

  // Both are preloaded by the template; asked for together so that neither
  // waits for the other when they are not
  const [airports, metadata] = await Promise.all([
    app.dataManager.loadAirports(),
    app.dataManager.loadMetadata(),
  ]);

  // Populate year filter dropdown and validate the selected year
  if (metadata && metadata.available_years) {
    resolveYearSelection(app, metadata.available_years);
  } else if (app.selectedYear !== "all") {
    // Without the index there is no year to offer, so a restored year
    // would show as "All years" in the dropdown while the map loads it
    showToast("The list of years is unavailable, showing all years", "error");
    const select = domCache.get("year-select", HTMLSelectElement);
    if (select) select.value = "all";
    app.selectedYear = "all";
  }

  // Add airport markers. None shows until the dataset says which airports
  // its flights used: a first load that failed left the dots of every year
  // on the map, unlabelled.
  createAirportMarkers(app, airports);
  app.airportManager.updateAirportOpacity();

  // The statistics are computed from the loaded paths; the metadata only
  // adds the model names that aircraft.json knows
  if (metadata) {
    app.aircraftModels = metadata.aircraft_models ?? {};
  }

  // Load groundspeed range from metadata; exports without timestamps have
  // no groundspeeds at all, and then no speed layer and no replay. Settled
  // before the dataset is published, which draws the layers.
  const hasTimingData = metadata !== null && metadata.max_groundspeed_knots > 0;
  app.hasTimingData = hasTimingData;

  // A restored speed layer has no speeds to draw. Its button is disabled
  // below, and a disabled button cannot be released, so the store is put
  // right here rather than restoring an empty layer that shows as pressed
  // over a legend with placeholder labels.
  if (!hasTimingData && app.airspeedVisible) app.airspeedVisible = false;

  if (hasTimingData) {
    app.airspeedRange = {
      min: metadata.min_groundspeed_knots,
      max: metadata.max_groundspeed_knots,
    };
  }

  // Enable/disable airspeed button based on timing data availability
  // (e.g., Charterware files without per-point timestamps won't have speed data)
  // Note: Altitude visualization still works (altitude data is in coordinates)
  // The pressed state and the opacity follow the store (see setupButtonSync);
  // only the disabled flag is owned here.
  const airspeedBtn = domCache.get("airspeed-btn", HTMLButtonElement);
  if (airspeedBtn) {
    airspeedBtn.disabled = !hasTimingData;
  }

  // Load the selected year's data; currentData is the single source of
  // path_info and path_segments for all managers. The layers, the
  // statistics panel and the airport markers follow it through their store
  // subscriptions; one flush, so nobody sees the dataset with a selection
  // it does not have or an aircraft filter it has no flights for.
  const failure = followLoadFailure(app);
  const year = app.selectedYear;
  // The toast of a failure offers no Retry: the panel on the map does, and
  // two of them at once, styled apart, were two ways of doing one thing
  const data = await app.dataManager.loadData(year);
  // A year switch that went ahead during the load has published its own
  // dataset, and this one would replace it under a store and a dropdown
  // that name the other year
  if (app.selectedYear === year) {
    app.store.batch(() => {
      if (data) {
        dropUnknownPathIds(app, data);
        publishDataset(app, data);
      }
      app.filterManager.updateAircraftDropdown();
    });
    if (data) announceDataset(year);
    // No year is loaded, so the dropdown shows none: picking the one that
    // failed is then a change, and asks for it again. Unless someone has
    // picked another one meanwhile, which is applied once the load is over.
    // The Filter sheet mirrors the dropdown, and the store has not changed
    // to tell it, so it is told to read the dropdown again (a sheet opened
    // during the load kept showing the year).
    const select = domCache.get("year-select", HTMLSelectElement);
    if (!data && select?.value === year) {
      showNoYear(select);
      app.mobileBar?.sheet.refresh();
    }
  }
  failure.settle();

  // Set initial airport marker sizes
  app.airportManager.updateAirportMarkerSizes();

  // Restore stats panel visibility
  if (app.savedState && app.savedState.statsPanelVisible) {
    app.statsPanelVisible = true;
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
    const range = calculateAirspeedRange(data.path_segments, app.airspeedRange);
    // A dataset whose flights all went one speed has no scale to stretch,
    // and keeps the one of the metadata
    if (range.max > range.min) app.airspeedRange = range;
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
export function announceDataset(year: string): void {
  announceStatus("Showing " + (year === "all" ? "all years" : year));
}

/**
 * Say on the map itself that the first load left it without flights, and
 * offer to load them again. Otherwise the page was an empty map whose
 * dropdown named the year, with a toast that went after four seconds.
 * @param app - The MapApp instance to operate on
 * @returns `settle` says the first load is over, before which nothing is
 *   shown
 */
function followLoadFailure(app: MapApp): { settle: () => void } {
  const panel = domCache.get("map-empty");
  const retryButton = domCache.get("map-empty-retry");
  let settled = false;
  let retrying = false;
  const sync = (): void => {
    if (!panel) return;
    const hide = !settled || retrying || app.currentData !== null;
    // Its own Retry is what hides it, and would take the focus with it
    if (hide && panel.contains(document.activeElement)) {
      app.map?.getCanvas().focus();
    }
    const appears = panel.hidden && !hide;
    panel.hidden = hide;
    // The one thing to do on the page then, so the keyboard is taken to
    // it, unless the focus was put somewhere else meanwhile: the map's
    // canvas is where the Retry left it
    const focused = document.activeElement;
    if (
      appears &&
      (focused === null ||
        focused === document.body ||
        focused === app.map?.getCanvas())
    ) {
      retryButton?.focus();
    }
  };
  const retry = (): void => {
    if (retrying) return;
    // What they said is being acted on; a new failure says so again. Only
    // the failures of loads: another error on screen is still true.
    app.dataManager.dismissFailures();
    retrying = true;
    sync();
    void app.filterManager.retryLoad().finally(() => {
      retrying = false;
      sync();
    });
  };
  retryButton?.addEventListener("click", retry, { signal: app.signal });
  app.store.subscribe("currentData", sync);
  return {
    settle: () => {
      settled = true;
      sync();
    },
  };
}

/**
 * Colour the segment popups and tooltips as they are written into the
 * map. They carry their colours as data, since the CSP allows no style
 * attribute (see applyMetricColors); the observer runs before the next
 * paint, so they never show uncoloured.
 */
export function colorSegmentPopups(): void {
  const container = domCache.get("map");
  if (!container) return;
  new MutationObserver((records) => {
    for (const { target } of records) applyMetricColors(target as Element);
  }).observe(container, { childList: true, subtree: true });
}

/**
 * Drop the restored path ids that are not in the loaded dataset.
 *
 * Ids are derived from the flights, so a shared link or a saved state keeps
 * pointing at the same flight after a re-export; one whose flight is gone
 * is dropped quietly. Isolation goes with the last id: the controls cannot
 * leave isolate mode on over an empty selection. A dataset missing a year
 * that failed to load cannot tell a deleted flight from an unloaded one, so
 * it drops nothing.
 * @param app - The MapApp instance to operate on
 * @param data - The dataset the selection has to refer to
 */
export function dropUnknownPathIds(app: MapApp, data: KMLDataset): void {
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
}

/**
 * Create the airport markers and put them on the map.
 * The popup content and the home-base class are filled in by AirportManager
 * once the path data is loaded, so no marker ever shows a flight count that
 * the current filter contradicts.
 * @param app - The MapApp instance to operate on
 * @param airports - Array of airports to create markers for
 */
export function createAirportMarkers(app: MapApp, airports: Airport[]): void {
  const map = app.map;
  if (!map) return;

  for (const airport of airports) {
    const name = airport.name;
    const element = createAirportElement(name);
    const marker = new Marker({ element, anchor: "center" })
      .setLngLat(toLngLat([airport.lat, airport.lon]))
      .addTo(map);

    // The popup is the one AirportManager shares between all airports
    const airportMarker: AirportMarker = {
      marker,
      getLatLng: () => {
        const { lat, lng } = marker.getLngLat();
        return { lat, lng };
      },
      getElement: () => element,
      openPopup: () => app.airportManager.openPopup(name),
      closePopup: () => app.airportManager.closePopup(name),
      isPopupOpen: () => app.airportManager.isPopupOpen(name),
      // `hidden` rather than taking the marker off the map: a hidden
      // element leaves the tab order
      setVisible: (visible) => {
        element.hidden = !visible;
      },
      setHome: (home) => setAirportElementHome(element, home),
    };

    // A button reports Enter and Space as a click, so this one listener is
    // the mouse, the finger and the keyboard. A second activation closes the
    // popup again, as the airplane's does. The second click of a double
    // click or a double tap is not one: it would close what the first
    // opened (see createActivationFilter).
    const isActivation = createActivationFilter();
    element.addEventListener("click", (event) => {
      if (isActivation(event)) app.airportManager.activateAirport(name);
    });
    // The dot under the pointer lights its label up too (see airportLabels)
    element.addEventListener("mouseenter", () =>
      setAirportLabelHover(map, name, true),
    );
    element.addEventListener("mouseleave", () =>
      setAirportLabelHover(map, name, false),
    );
    // Escape reaches the popup itself only while focus is inside it
    element.addEventListener("keydown", (event) => {
      if (event.key === "Escape") airportMarker.closePopup();
    });

    app.airportMarkers[name] = airportMarker;
  }
}
