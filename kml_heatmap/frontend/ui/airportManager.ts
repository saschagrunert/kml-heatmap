/**
 * Airport Manager - Handles airport markers and popups
 */
import type { MapApp } from "../mapApp";
import {
  calculateAirportFlightCounts,
  calculateVisibleAirports,
  findHomeBase,
} from "../features/airports";
import type { AirportCounts } from "../features/airports";
import { ddToDms } from "../utils/geometry";
import { generateAirportPopupHtml } from "../utils/htmlGenerators";
import { createAirportIcon } from "../appInitializer";

export class AirportManager {
  private app: MapApp;
  /** Home-base icon state per airport marker (icons are recreated on change) */
  private homeIconState: Map<string, boolean> = new Map();

  constructor(app: MapApp) {
    this.app = app;
  }

  // Calculate airport flight counts based on current filters
  calculateAirportFlightCounts(): AirportCounts {
    return calculateAirportFlightCounts(
      this.app.fullPathInfo ?? [],
      this.app.selectedYear,
      this.app.selectedAircraft,
    );
  }

  /**
   * Update popup content and home-base marker class with the counts of the
   * current year/aircraft filter
   */
  updateAirportPopups(): void {
    if (!this.app.allAirportsData || !this.app.airportMarkers) return;

    const airportCounts = this.calculateAirportFlightCounts();

    // Home base: airport with most flights in the current filter
    const homeBaseName = findHomeBase(airportCounts);

    for (const airport of this.app.allAirportsData) {
      const marker = this.app.airportMarkers[airport.name];
      if (!marker) continue;

      const flightCount = airportCounts[airport.name] || 0;
      const isHomeBase = airport.name === homeBaseName;

      const popup = generateAirportPopupHtml({
        name: airport.name,
        lat: airport.lat,
        lon: airport.lon,
        latDms: ddToDms(airport.lat, true),
        lonDms: ddToDms(airport.lon, false),
        flightCount,
        isHomeBase,
      });

      marker.setPopupContent(popup);

      if ((this.homeIconState.get(airport.name) ?? false) !== isHomeBase) {
        marker.setIcon(createAirportIcon(airport.name, isHomeBase));
        this.homeIconState.set(airport.name, isHomeBase);
      }
    }
  }

  updateAirportOpacity(): void {
    const visibleAirports = calculateVisibleAirports({
      pathInfo: this.app.fullPathInfo ?? [],
      selectedYear: this.app.selectedYear,
      selectedAircraft: this.app.selectedAircraft,
      selectedPathIds: this.app.selectedPathIds,
      isolateSelection: this.app.isolateSelection,
      pathInfoById: this.app.layerManager.getPathInfoMap(),
    });

    for (const [airportName, marker] of Object.entries(
      this.app.airportMarkers,
    )) {
      if (!marker) continue;

      if (visibleAirports === null || visibleAirports.has(airportName)) {
        marker.setOpacity(1.0);
        if (!this.app.airportLayer.hasLayer(marker)) {
          marker.addTo(this.app.airportLayer);
        }
      } else if (this.app.airportLayer.hasLayer(marker)) {
        this.app.airportLayer.removeLayer(marker);
      }
    }
  }

  updateAirportMarkerSizes(): void {
    if (!this.app.map) return;

    const zoom = this.app.map.getZoom();
    const mapContainer = document.getElementById("map");
    if (!mapContainer) return;

    let sizeClass = "";
    if (zoom >= 14) sizeClass = "xlarge";
    else if (zoom >= 12) sizeClass = "large";
    else if (zoom >= 10) sizeClass = "medium";
    else if (zoom >= 8) sizeClass = "medium-small";
    else if (zoom >= 6) sizeClass = "small";

    mapContainer.dataset["zoomSize"] = sizeClass;
    mapContainer.classList.toggle("zoom-hide-labels", zoom < 5);
  }
}
