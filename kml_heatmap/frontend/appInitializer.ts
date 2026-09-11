/**
 * App Initializer - Handles initial data loading and airport marker creation
 * Extracted from MapApp to reduce file size and improve modularity
 */

import * as L from "leaflet";
import { createAirportIcon } from "./features/airports";
import { domCache } from "./utils/domCache";
import { showToast } from "./utils/toast";
import type { MapApp } from "./mapApp";
import type { Airport } from "./types";

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
  // Load airports
  const airports = await app.dataManager.loadAirports();
  app.allAirportsData = airports;

  // Load metadata
  const metadata = await app.dataManager.loadMetadata();

  // Populate year filter dropdown and validate the selected year
  if (metadata && metadata.available_years) {
    resolveYearSelection(app, metadata.available_years);
  }

  // Add airport markers
  createAirportMarkers(app, airports);

  // Load and store full statistics
  if (metadata && metadata.stats) {
    app.fullStats = metadata.stats;
  }

  // Load the selected year's data; currentData is the single source of
  // path_info and path_segments for all managers. The statistics panel and
  // the airport markers follow it through their store subscriptions.
  const data = await app.dataManager.loadData(app.selectedYear);
  if (data) {
    app.currentData = data;
  }

  // Populate aircraft dropdown
  app.filterManager.updateAircraftDropdown();

  // Load groundspeed range from metadata
  const hasTimingData =
    metadata !== null &&
    metadata.max_groundspeed_knots !== undefined &&
    metadata.max_groundspeed_knots > 0;

  if (hasTimingData) {
    const minSpeed = metadata.min_groundspeed_knots ?? 0;
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

  // Initial layer build (heatmap, visible colour layers, stats, airports)
  await app.dataManager.updateLayers();

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
    if (
      app.aviationVisible &&
      app.config.openaipApiKey &&
      app.openaipLayers["Aviation Data"]
    ) {
      app.map.addLayer(app.openaipLayers["Aviation Data"]);
    }
  }

  // Restore stats panel visibility
  if (app.savedState && app.savedState.statsPanelVisible) {
    app.statsManager.setStatsPanelVisible(true);
  }
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

    marker.on("click", (_e: L.LeafletMouseEvent) => {
      if (!app.replayManager.state.active) {
        app.pathSelection.selectPathsByAirport(airport.name);
      }
    });

    marker.addTo(app.airportLayer);
    app.airportMarkers[airport.name] = marker;
  }
}
