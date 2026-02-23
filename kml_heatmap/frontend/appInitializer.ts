/**
 * App Initializer - Handles initial data loading and airport marker creation
 * Extracted from MapApp to reduce file size and improve modularity
 */

import * as L from "leaflet";
import { logError } from "./utils/logger";
import { domCache } from "./utils/domCache";
import type { MapApp, AirportWithFlightCount } from "./mapApp";
import type { Airport } from "./types";

/**
 * Load initial data including airports, metadata, and path data
 * @param app - The MapApp instance to operate on
 */
export async function loadInitialData(app: MapApp): Promise<void> {
  // Load airports
  const airports = await app.dataManager!.loadAirports();
  app.allAirportsData = airports;

  // Load metadata
  const metadata = await app.dataManager!.loadMetadata();

  // Populate year filter dropdown
  if (metadata && metadata.available_years) {
    const yearSelect = document.getElementById(
      "year-select"
    ) as HTMLSelectElement;
    metadata.available_years.forEach((year) => {
      const option = document.createElement("option");
      option.value = year.toString();
      option.textContent = "📅 " + year;
      yearSelect.appendChild(option);
    });

    // Default to current year only if no saved state exists
    if (app.selectedYear === "all" && !app.restoredYearFromState) {
      const currentYear =
        metadata.available_years[metadata.available_years.length - 1];
      if (currentYear !== undefined) {
        app.selectedYear = currentYear.toString();
      }
    }

    // Sync dropdown with the selected year
    if (app.selectedYear && app.selectedYear !== "all") {
      yearSelect.value = app.selectedYear;
    }
  }

  // Add airport markers
  createAirportMarkers(app, airports);

  // Load and store full statistics
  if (metadata && metadata.stats) {
    app.fullStats = metadata.stats;
  }

  // Load full resolution path_info and path_segments
  try {
    const fullResData = await app.dataManager!.loadData(
      "data",
      app.selectedYear
    );
    if (fullResData && fullResData.path_info) {
      app.fullPathInfo = fullResData.path_info;
    }
    if (fullResData && fullResData.path_segments) {
      app.fullPathSegments = fullResData.path_segments;
    }
  } catch (error) {
    logError("Failed to load full path data:", error);
  }

  // Populate aircraft dropdown
  app.filterManager!.updateAircraftDropdown();

  // Update airport popups with initial filter counts
  app.airportManager!.updateAirportPopups();

  // Initialize stats panel
  if (app.fullStats) {
    const initialStats = window.KMLHeatmap.calculateFilteredStatistics({
      pathInfo: app.fullPathInfo ?? [],
      segments: app.fullPathSegments ?? [],
      year: app.selectedYear,
      aircraft: app.selectedAircraft,
      coordinateCount: app.currentData?.original_points,
    });
    app.statsManager!.updateStatsPanel(initialStats, false);
  }

  // Update airport opacity based on restored filters
  app.airportManager!.updateAirportOpacity();

  // Load groundspeed range from metadata
  const hasTimingData =
    metadata &&
    metadata.max_groundspeed_knots !== undefined &&
    metadata.max_groundspeed_knots > 0;

  if (hasTimingData) {
    app.airspeedRange.min = metadata.min_groundspeed_knots!;
    app.airspeedRange.max = metadata.max_groundspeed_knots!;
    app.layerManager!.updateAirspeedLegend(
      app.airspeedRange.min,
      app.airspeedRange.max
    );
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

  // Initial data load
  await app.dataManager!.updateLayers();

  // Set initial airport marker sizes
  app.airportManager!.updateAirportMarkerSizes();

  // Restore layer visibility
  if (app.altitudeVisible) {
    app.map!.addLayer(app.altitudeLayer);
    (document.getElementById("altitude-legend") as HTMLElement).style.display =
      "block";
  }
  if (app.airspeedVisible) {
    app.map!.addLayer(app.airspeedLayer);
    (document.getElementById("airspeed-legend") as HTMLElement).style.display =
      "block";
  }
  if (
    app.aviationVisible &&
    app.config.openaipApiKey &&
    app.openaipLayers["Aviation Data"]
  ) {
    app.map!.addLayer(app.openaipLayers["Aviation Data"]);
  }

  // Update replay button state if paths were restored
  if (app.selectedPathIds.size > 0) {
    app.replayManager!.updateReplayButtonState();
  }

  // Restore stats panel visibility
  if (app.savedState && app.savedState.statsPanelVisible) {
    const panel = document.getElementById("stats-panel") as HTMLElement;
    panel.style.display = "block";
    panel.offsetHeight;
    panel.classList.add("visible");
  }
}

/**
 * Create airport markers and add them to the airport layer
 * @param app - The MapApp instance to operate on
 * @param airports - Array of airports to create markers for
 */
export function createAirportMarkers(app: MapApp, airports: Airport[]): void {
  // Find home base
  let homeBaseAirport: Airport | null = null;
  if (airports.length > 0) {
    homeBaseAirport = airports.reduce((max, airport) => {
      const airportExt = airport as AirportWithFlightCount;
      const maxExt = max as AirportWithFlightCount;
      const airportCount = airportExt.flight_count ?? 0;
      const maxCount = maxExt?.flight_count ?? 0;
      return airportCount > maxCount ? airport : max;
    });
  }

  // Create markers for each airport
  airports.forEach((airport) => {
    const icaoMatch = airport.name
      ? airport.name.match(/\b([A-Z]{4})\b/)
      : null;
    const icao = icaoMatch ? icaoMatch[1] : "APT";
    const isHomeBase = homeBaseAirport && airport.name === homeBaseAirport.name;
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

    const latDms = window.KMLHeatmap.ddToDms(airport.lat, true);
    const lonDms = window.KMLHeatmap.ddToDms(airport.lon, false);
    const googleMapsLink = `https://www.google.com/maps?q=${airport.lat},${airport.lon}`;

    const popup = `
          <div style="
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif;
              min-width: 220px;
              padding: 8px 4px;
              background-color: #2b2b2b;
              color: #ffffff;
          ">
              <div style="
                  font-size: 15px;
                  font-weight: bold;
                  color: #28a745;
                  margin-bottom: 10px;
                  padding-bottom: 8px;
                  border-bottom: 2px solid #28a745;
                  display: flex;
                  align-items: center;
                  gap: 6px;
              ">
                  <span style="font-size: 18px;">🛫</span>
                  <span>${airport.name || "Unknown"}</span>
                  ${isHomeBase ? '<span style="font-size: 12px; background: #007bff; color: white; padding: 2px 6px; border-radius: 3px; margin-left: 4px;">HOME</span>' : ""}
              </div>
              <div style="margin-bottom: 8px;">
                  <div style="font-size: 11px; color: #999; margin-bottom: 2px; text-transform: uppercase; letter-spacing: 0.5px;">Coordinates</div>
                  <a href="${googleMapsLink}"
                     target="_blank"
                     style="
                         color: #4facfe;
                         text-decoration: none;
                         font-size: 12px;
                         font-family: monospace;
                         display: flex;
                         align-items: center;
                         gap: 4px;
                     "
                     onmouseover="this.style.textDecoration='underline'"
                     onmouseout="this.style.textDecoration='none'">
                      <span>📍</span>
                      <span>${latDms}<br>${lonDms}</span>
                  </a>
              </div>
              <div style="
                  background: linear-gradient(135deg, rgba(79, 172, 254, 0.15) 0%, rgba(0, 242, 254, 0.15) 100%);
                  padding: 8px 10px;
                  border-radius: 6px;
                  border-left: 3px solid #4facfe;
                  display: flex;
                  justify-content: space-between;
                  align-items: center;
              ">
                  <span style="font-size: 12px; color: #ccc; font-weight: 500;">Total Flights</span>
                  <span style="font-size: 16px; font-weight: bold; color: #4facfe;">${(airport as AirportWithFlightCount).flight_count || 0}</span>
              </div>
          </div>`;

    const marker = L.marker([airport.lat, airport.lon], {
      icon: L.divIcon({
        html: markerHtml,
        iconSize: [12, 12],
        iconAnchor: [6, 6],
        popupAnchor: [0, -6],
        className: "",
      }),
    }).bindPopup(popup, { autoPanPadding: [50, 50] });

    // Add click handler to select paths connected to this airport
    marker.on("click", (_e: L.LeafletMouseEvent) => {
      if (!app.replayManager!.replayActive) {
        app.pathSelection!.selectPathsByAirport(airport.name);
      }
    });

    marker.addTo(app.airportLayer);
    app.airportMarkers[airport.name] = marker;
  });
}
