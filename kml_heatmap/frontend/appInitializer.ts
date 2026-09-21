/**
 * App Initializer - Handles initial data loading and airport marker creation
 * Extracted from MapApp to reduce file size and improve modularity
 */

import * as L from "leaflet";
import { createAirportIcon } from "./features/airports";
import { domCache } from "./utils/domCache";
import { applyMetricColors } from "./utils/htmlGenerators";
import { showToast } from "./utils/toast";
import { datasetIndex } from "./calculations/datasetIndex";
import type { MapApp } from "./mapApp";
import type { Airport, KMLDataset } from "./types";

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

  if (app.selectedYear === "all") {
    // Default to the latest year only if no saved state exists
    if (!app.restoredYearFromState) {
      app.selectedYear = latestValue;
    }
  } else if (
    !availableYears.some((year) => year.toString() === app.selectedYear)
  ) {
    showToast(
      "Year " +
        app.selectedYear +
        " is not available, showing " +
        (availableYears.length > 0 ? latestValue : "all years"),
      "info",
    );
    app.selectedYear = latestValue;
  }

  if (select) {
    select.value = app.selectedYear;
  }
}

/**
 * Load initial data including airports, metadata, and path data
 * @param app - The MapApp instance to operate on
 */
export async function loadInitialData(app: MapApp): Promise<void> {
  colorSegmentPopups();

  // Load airports
  const airports = await app.dataManager.loadAirports();
  app.allAirportsData = airports;

  // Load metadata
  const metadata = await app.dataManager.loadMetadata();

  // Populate year filter dropdown and validate the selected year
  if (metadata && metadata.available_years) {
    resolveYearSelection(app, metadata.available_years);
  } else if (app.selectedYear !== "all") {
    // Without the index there is no year to offer, so a restored year
    // would show as "All years" in the dropdown while the map loads it
    showToast("The list of years is unavailable, showing all years", "error");
    app.selectedYear = "all";
    const select = domCache.get("year-select", HTMLSelectElement);
    if (select) select.value = "all";
  }

  // Add airport markers
  createAirportMarkers(app, airports);

  // The statistics are computed from the loaded paths; the metadata only
  // adds the model names that aircraft.json knows
  if (metadata) {
    app.aircraftModels = metadata.aircraft_models ?? {};
  }

  // Load the selected year's data; currentData is the single source of
  // path_info and path_segments for all managers. The statistics panel and
  // the airport markers follow it through their store subscriptions.
  const data = await app.dataManager.loadData(app.selectedYear);
  if (data) {
    // One flush, so nobody sees the dataset with a selection it does not have
    app.store.batch(() => {
      dropUnknownPathIds(app, data);
      app.currentData = data;
    });
  }

  // Populate aircraft dropdown
  app.filterManager.updateAircraftDropdown();

  // Load groundspeed range from metadata; exports without timestamps have
  // no groundspeeds at all, and then no speed layer and no replay
  const hasTimingData = metadata !== null && metadata.max_groundspeed_knots > 0;
  app.hasTimingData = hasTimingData;

  // A restored speed layer has no speeds to draw. Its button is disabled
  // below, and a disabled button cannot be released, so the store is put
  // right here rather than restoring an empty layer that shows as pressed
  // over a legend with placeholder labels.
  if (!hasTimingData && app.airspeedVisible) app.airspeedVisible = false;

  if (hasTimingData) {
    const minSpeed = metadata.min_groundspeed_knots;
    const maxSpeed = metadata.max_groundspeed_knots;
    app.airspeedRange = { min: minSpeed, max: maxSpeed };
    app.layerManager.updateAirspeedLegend(minSpeed, maxSpeed);
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

  // Initial layer build (heatmap, visible colour layers, stats, airports).
  // The dataset is handed over: a year that failed to load above would be
  // fetched and reported a second time otherwise.
  await app.dataManager.updateLayers(data);

  // Set initial airport marker sizes
  app.airportManager.updateAirportMarkerSizes();

  // Restore layer visibility; the legends follow the store
  if (app.map) {
    if (app.altitudeVisible) {
      app.map.addLayer(app.altitudeLayer);
    }
    if (app.airspeedVisible) {
      app.map.addLayer(app.airspeedLayer);
    }
    if (app.aviationVisible && app.aviationLayer) {
      app.map.addLayer(app.aviationLayer);
    }
  }

  // Restore stats panel visibility
  if (app.savedState && app.savedState.statsPanelVisible) {
    app.statsManager.setStatsPanelVisible(true);
  }
}

/**
 * Colour the segment popups and tooltips as Leaflet writes them into the
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
 * Create airport markers and add them to the airport layer.
 * The popup itself, the home-base class and the badge are all filled in by
 * AirportManager.updateAirportPopups() once the path data is loaded, so no
 * marker ever shows a flight count that the current filter contradicts.
 * @param app - The MapApp instance to operate on
 * @param airports - Array of airports to create markers for
 */
export function createAirportMarkers(app: MapApp, airports: Airport[]): void {
  for (const airport of airports) {
    const marker = L.marker([airport.lat, airport.lon], {
      icon: createAirportIcon(airport.name, false),
      title: airport.name,
      alt: airport.name,
    });

    const select = (): void => {
      if (!app.replayState.active) {
        app.pathSelection.selectPathsByAirport(airport.name);
      }
    };
    marker.on("click", select);
    // Enter on the focused marker: Leaflet reports it as keypress, not as
    // click, and opened the popup without selecting the flights
    marker.on("keypress", (e: L.LeafletKeyboardEvent) => {
      if (e.originalEvent.key === "Enter") select();
    });

    marker.addTo(app.airportLayer);
    app.airportMarkers[airport.name] = marker;
  }
}
