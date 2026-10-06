/**
 * App Initializer - Handles initial data loading and airport marker creation
 * Extracted from MapApp to reduce file size and improve modularity
 */

import { Marker, Point } from "maplibre-gl";
import {
  createAirportElement,
  setAirportElementHome,
} from "./features/airports";
import { setUnavailable, setUnavailableFor } from "./utils/buttonState";
import { domCache } from "./utils/domCache";
import { applyMetricColors, pluralFlights } from "./utils/htmlGenerators";
import { createActivationFilter, toLngLat } from "./utils/mapHelpers";
import { announceStatus, showToast } from "./utils/toast";
import { setAirportLabelHover } from "./ui/airportLabels";
import { NO_DATA_MESSAGE, NO_TIMING_MESSAGE } from "./ui/actions";
import { datasetIndex } from "./calculations/datasetIndex";
import { calculateAirspeedRange } from "./features/layers";
import type { MapApp } from "./mapApp";
import type { Airport, AirportMarker, KMLDataset } from "./types";

/**
 * Populate the year dropdown and make sure the selected year exists.
 * A restored/URL year that is not available falls back to the latest year
 * (with a toast) so the select never ends up blank. The page ships with
 * the latest year as an option, and a restored one may have one of its own
 * (see restoreState in ui/stateRestore.ts), which the list replaces: the
 * dropdown named the year it opens on from the start.
 * @param app - The MapApp instance to operate on
 * @param availableYears - Years listed in the metadata
 */
export function resolveYearSelection(
  app: MapApp,
  availableYears: number[],
): void {
  const select = domCache.get("year-select", HTMLSelectElement);

  if (select) {
    select.length = 1;
    // With the value written out: an option's value falls back to its text,
    // but only as a property, and what reads the attribute found none
    for (const year of availableYears) {
      select.add(new Option(String(year), String(year)));
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

/**
 * Load initial data including airports, metadata, and path data
 * @param app - The MapApp instance to operate on
 */
export async function loadInitialData(app: MapApp): Promise<void> {
  colorSegmentPopups(app.signal);
  // From the start, so the legends wait for the first dataset
  const failure = followLoadFailure(app);

  // Both are preloaded by the template; asked for together so that neither
  // waits for the other when they are not
  const [airports, metadata] = await Promise.all([
    app.dataManager.loadAirports(),
    app.dataManager.loadMetadata(),
  ]);

  // Populate year filter dropdown and validate the selected year
  if (metadata && metadata.available_years) {
    resolveYearSelection(app, metadata.available_years);
  } else {
    // Without the index there is no year to offer, so the map loads all of
    // them, which the dropdown says: it named the year the page ships with
    if (app.selectedYear !== "all") {
      showToast("The list of years is unavailable, showing all years", "error");
    }
    const select = domCache.get("year-select", HTMLSelectElement);
    if (select) select.value = "all";
    app.selectedYear = "all";
  }

  // Add airport markers. None shows until the dataset says which airports
  // its flights used: a first load that failed left the dots of every year
  // on the map, unlabelled.
  createAirportMarkers(app, airports);
  app.airportManager.showAirports();

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

  // A restored speed layer has no speeds to draw. Its button is unavailable
  // below, and an unavailable button cannot be released, so the store is
  // put right here rather than restoring an empty layer that shows as
  // pressed over a legend with placeholder labels.
  if (!hasTimingData && app.airspeedVisible) app.airspeedVisible = false;

  if (hasTimingData) {
    app.airspeedRange = app.metadataAirspeedRange = {
      min: metadata.min_groundspeed_knots,
      max: metadata.max_groundspeed_knots,
    };
  }

  // The speed layer is unavailable without timing data (e.g., Charterware
  // files without per-point timestamps won't have speed data); altitude
  // still works, from the coordinates. aria-disabled rather than disabled,
  // so the button stays reachable and says why (#airspeed-reason), and a
  // click on it as well (UIToggles.toggleAirspeed). The pressed state
  // follows the store (see setupButtonSync); only this is owned here.
  const airspeedBtn = domCache.get("airspeed-btn");
  if (airspeedBtn) {
    // Dimmed, its tooltip says why rather than what it would colour
    setUnavailableFor(airspeedBtn, hasTimingData ? null : NO_TIMING_MESSAGE);
    if (hasTimingData) airspeedBtn.removeAttribute("aria-describedby");
    else airspeedBtn.setAttribute("aria-describedby", "airspeed-reason");
  }

  // Load the selected year's data; currentData is the single source of
  // path_info and path_segments for all managers. The layers, the
  // statistics panel and the airport markers follow it through their store
  // subscriptions; one flush, so nobody sees the dataset with a selection
  // it does not have or an aircraft filter it has no flights for.
  const year = app.selectedYear;
  // A failure is said by the panel on the map, with its Retry, and not by
  // a toast as well (see followLoadFailure)
  const data = await app.dataManager.loadData(year);
  // A year switch that went ahead during the load has published its own
  // dataset, and this one would replace it under a store and a dropdown
  // that name the other year
  if (app.selectedYear === year) {
    app.store.batch(() => {
      if (data) {
        dropUnknownPathIds(app, data, true);
        publishDataset(app, data);
      }
      app.filterManager.updateAircraftDropdown();
    });
    if (data) announceDataset(year);
    // No year is loaded, and the dropdown keeps showing the one that
    // failed, which the panel on the map names and loads again. It showed
    // an empty "Year" instead, so that picking the year again was a change
    // and asked for it: the panel's Retry does that.
  }
  failure.settle();

  // Set initial airport marker sizes
  app.airportManager.updateAirportMarkerSizes();

  // Restore stats panel visibility, over flights only: without them the
  // rail opened on zeros (see followLoadFailure)
  if (app.savedState?.statsPanelVisible && app.currentData) {
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
export function announceDataset(year: string): void {
  announceStatus("Showing " + (year === "all" ? "all years" : year));
}

/**
 * The controls of what is made of the flights (NEED_DATA in ui/actions.ts),
 * shown unavailable while a load left the map without any
 */
const NEED_DATA_CONTROL_IDS = [
  "stats-btn",
  "wrapped-btn",
  "replay-all-btn",
  "hotspot-tour-btn",
  "cross-section-btn",
  "export-btn",
];

/**
 * Say on the map itself that the first load left it without flights, and
 * offer to load them again. Otherwise the page was an empty map whose
 * dropdown named the year, with a toast that went after four seconds. What
 * failed is said there, and only there, while the map has no flights (see
 * DataManager.failureNote): a toast beside it said it a second time.
 * @param app - The MapApp instance to operate on
 * @returns `settle` says the first load is over, before which nothing is
 *   shown
 */
function followLoadFailure(app: MapApp): { settle: () => void } {
  const panel = domCache.get("map-empty");
  const retryButton = domCache.get("map-empty-retry");
  const text = panel?.querySelector("p");
  // Heard as the toast's was, which the panel's text is not: when it is
  // written on the panel on screen, or when the panel comes up with it. A
  // load of all years that brings some years hides it unseen, and the
  // data manager puts what failed into a toast, which is heard itself.
  const say = (): void => {
    if (text?.textContent) announceStatus(text.textContent);
  };
  app.dataManager.failureNote = (message) => {
    if (text) text.textContent = message;
    if (panel && !panel.hidden) say();
  };
  let settled = false;
  let retrying = false;
  /** Set while the controls of NEED_DATA_CONTROL_IDS say there is no data */
  let blocked = false;
  /** Their titles from before, given back with the data */
  const titles = new Map<HTMLElement, string>();
  const sync = (): void => {
    // The colour legends stand for nothing while there is none (styles.css)
    document.body.classList.toggle("no-data", !app.currentData);
    // A click on one says so (runAction); a Retry under way still has none
    if (blocked !== (settled && !app.currentData)) {
      blocked = !blocked;
      document.body.classList.toggle("flights-failed", blocked);
      for (const id of NEED_DATA_CONTROL_IDS) {
        const control = domCache.get(id);
        if (!control) continue;
        if (blocked) titles.set(control, control.title);
        setUnavailable(
          control,
          blocked,
          blocked ? NO_DATA_MESSAGE : (titles.get(control) ?? control.title),
        );
      }
      app.mobileBar?.syncTabs();
      app.mobileBar?.refreshSheet();
    }
    if (!panel) return;
    const hide = !settled || retrying || app.currentData !== null;
    // Its own Retry is what hides it, and would take the focus with it
    if (hide && panel.contains(document.activeElement)) {
      app.map?.getCanvas().focus();
    }
    const appears = panel.hidden && !hide;
    panel.hidden = hide;
    if (appears) say();
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
  sync();
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
 * paint, so they never show uncoloured. It stops with `signal`.
 */
export function colorSegmentPopups(signal: AbortSignal): void {
  const container = domCache.get("map");
  if (!container) return;
  const observer = new MutationObserver((records) => {
    for (const { target } of records) applyMetricColors(target as Element);
  });
  observer.observe(container, { childList: true, subtree: true });
  signal.addEventListener("abort", () => observer.disconnect());
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
      if (isActivation(event)) {
        app.airportManager.activateAirport(pressedAirport(event) ?? name);
      }
    });
    // The target reaches past the dot, up over where its code goes, and a
    // code of an airport nearby may have gone below or beside its own dot
    // into it (see ui/airportLabels.ts): a press there on a code is one on
    // that code, which the map tells. On the dot, and from the keyboard,
    // it is this airport.
    const pressedAirport = (event: MouseEvent): string | null => {
      const target = event.target;
      if (
        !(target instanceof Element) ||
        target === element ||
        target.classList.contains("airport-marker")
      ) {
        return null;
      }
      const box = map.getCanvas().getBoundingClientRect();
      return app.airportManager.airportLabelAt(
        new Point(event.clientX - box.left, event.clientY - box.top),
      );
    };
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
