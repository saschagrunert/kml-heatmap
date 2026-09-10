/**
 * App Initializer - Handles initial data loading and airport marker creation
 * Extracted from MapApp to reduce file size and improve modularity
 */

import * as L from "leaflet";
import { domCache } from "./utils/domCache";
import { ddToDms } from "./utils/geometry";
import { generateAirportPopupHtml } from "./utils/htmlGenerators";
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
  const yearSelect = domCache.get("year-select");
  const select = yearSelect instanceof HTMLSelectElement ? yearSelect : null;

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
  // path_info and path_segments for all managers
  const data = await app.dataManager.loadData(app.selectedYear);
  if (data) {
    app.currentData = data;
  }

  // Populate aircraft dropdown
  app.filterManager.updateAircraftDropdown();

  // Update airport popups (and home-base marker) with initial filter counts
  app.airportManager.updateAirportPopups();

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
  const airspeedBtn = domCache.get("airspeed-btn") as HTMLButtonElement | null;
  if (airspeedBtn) {
    if (!hasTimingData) {
      airspeedBtn.disabled = true;
      airspeedBtn.style.opacity = "0.3";
    } else {
      airspeedBtn.disabled = false;
      // Set opacity based on visibility state (0.5 = off, 1.0 = on)
      airspeedBtn.style.opacity = app.airspeedVisible ? "1.0" : "0.5";
    }
  }

  // Initial layer build (heatmap, visible colour layers, stats, airports)
  await app.dataManager.updateLayers();

  // Set initial airport marker sizes
  app.airportManager.updateAirportMarkerSizes();

  // Restore layer visibility
  if (app.map) {
    if (app.altitudeVisible) {
      app.map.addLayer(app.altitudeLayer);
      const legend = domCache.get("altitude-legend");
      if (legend) legend.style.display = "block";
    }
    if (app.airspeedVisible) {
      app.map.addLayer(app.airspeedLayer);
      const legend = domCache.get("airspeed-legend");
      if (legend) legend.style.display = "block";
    }
    if (
      app.aviationVisible &&
      app.config.openaipApiKey &&
      app.openaipLayers["Aviation Data"]
    ) {
      app.map.addLayer(app.openaipLayers["Aviation Data"]);
    }
  }

  // Update replay button state if paths were restored
  if (app.selectedPathIds.size > 0) {
    app.replayManager.updateReplayButtonState();
  }

  // Restore stats panel visibility
  if (app.savedState && app.savedState.statsPanelVisible) {
    app.statsManager.setStatsPanelVisible(true, false);
  }
}

/**
 * Build the divIcon for an airport marker
 * @param name - Airport name (ICAO code is extracted from it)
 * @param isHomeBase - Whether the airport is the current home base
 */
export function createAirportIcon(
  name: string,
  isHomeBase: boolean,
): L.DivIcon {
  const icaoMatch = name ? name.match(/\b([A-Z]{4})\b/) : null;
  const icao = icaoMatch ? icaoMatch[1] : "APT";
  const homeClass = isHomeBase ? " airport-marker-home" : "";
  const homeLabelClass = isHomeBase ? " airport-label-home" : "";

  const markerHtml =
    '<div class="airport-marker-container"><div class="airport-marker' +
    homeClass +
    '"></div><div class="airport-label' +
    homeLabelClass +
    '">' +
    icao +
    "</div></div>";

  return L.divIcon({
    html: markerHtml,
    iconSize: [12, 12],
    iconAnchor: [6, 6],
    popupAnchor: [0, -6],
    className: "",
  });
}

/**
 * Create airport markers and add them to the airport layer.
 * The home-base class and the popup badge are applied by
 * AirportManager.updateAirportPopups() so both follow the current filter.
 * @param app - The MapApp instance to operate on
 * @param airports - Array of airports to create markers for
 */
export function createAirportMarkers(app: MapApp, airports: Airport[]): void {
  for (const airport of airports) {
    const popup = generateAirportPopupHtml({
      name: airport.name,
      lat: airport.lat,
      lon: airport.lon,
      latDms: ddToDms(airport.lat, true),
      lonDms: ddToDms(airport.lon, false),
      flightCount: airport.flight_count || 0,
      isHomeBase: false,
    });

    const marker = L.marker([airport.lat, airport.lon], {
      icon: createAirportIcon(airport.name, false),
      title: airport.name,
      alt: airport.name,
    }).bindPopup(popup, { autoPanPadding: [50, 50] });

    marker.on("click", (_e: L.LeafletMouseEvent) => {
      if (!app.replayManager.state.active) {
        app.pathSelection.selectPathsByAirport(airport.name);
      }
    });

    marker.addTo(app.airportLayer);
    app.airportMarkers[airport.name] = marker;
  }
}
