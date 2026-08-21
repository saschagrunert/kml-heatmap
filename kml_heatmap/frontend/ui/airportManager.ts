/**
 * Airport Manager - Handles airport markers and popups
 */
import type { MapApp } from "../mapApp";
import { generateAirportPopupHtml } from "../utils/htmlGenerators";

export class AirportManager {
  private app: MapApp;

  constructor(app: MapApp) {
    this.app = app;
  }

  // Calculate airport flight counts based on current filters
  calculateAirportFlightCounts(): { [airportName: string]: number } {
    // Use KMLHeatmap library function
    return window.KMLHeatmap.calculateAirportFlightCounts(
      this.app.fullPathInfo ?? [],
      this.app.selectedYear,
      this.app.selectedAircraft
    );
  }

  // Update airport popup content with current filter-based counts
  updateAirportPopups(): void {
    if (!this.app.allAirportsData || !this.app.airportMarkers) return;

    const airportCounts = this.calculateAirportFlightCounts();

    // Find home base (airport with most flights in current filter)
    let homeBaseName: string | null = null;
    let maxCount = 0;
    Object.keys(airportCounts).forEach((name) => {
      const count = airportCounts[name];
      if (count !== undefined && count > maxCount) {
        maxCount = count;
        homeBaseName = name;
      }
    });

    // Update each airport marker's popup
    this.app.allAirportsData.forEach((airport) => {
      const marker = this.app.airportMarkers[airport.name];
      if (!marker) return;

      const flightCount = airportCounts[airport.name] || 0;
      const isHomeBase = airport.name === homeBaseName;

      const popup = generateAirportPopupHtml({
        name: airport.name,
        lat: airport.lat,
        lon: airport.lon,
        latDms: window.KMLHeatmap.ddToDms(airport.lat, true),
        lonDms: window.KMLHeatmap.ddToDms(airport.lon, false),
        flightCount,
        isHomeBase,
      });

      marker.setPopupContent(popup);
    });
  }

  updateAirportOpacity(): void {
    // Check if filters are active
    const hasFilters =
      this.app.selectedYear !== "all" || this.app.selectedAircraft !== "all";
    const hasSelection = this.app.selectedPathIds.size > 0;
    const hasIsolation = this.app.isolateSelection && hasSelection;

    if (!hasFilters && !hasSelection) {
      // No filters or selection - show all airports
      Object.keys(this.app.airportMarkers).forEach((airportName) => {
        const marker = this.app.airportMarkers[airportName];
        if (!marker) return;

        marker.setOpacity(1.0);
        // Ensure marker is on the map
        if (!this.app.airportLayer.hasLayer(marker)) {
          marker.addTo(this.app.airportLayer);
        }
      });
      return;
    }

    const visibleAirports = new Set<string>();

    // If filters are active, collect airports from filtered paths
    if (hasFilters && this.app.fullPathInfo) {
      this.app.fullPathInfo.forEach((pathInfo) => {
        // Check if path matches filters
        const matchesYear =
          this.app.selectedYear === "all" ||
          (pathInfo.year && pathInfo.year.toString() === this.app.selectedYear);
        const matchesAircraft =
          this.app.selectedAircraft === "all" ||
          pathInfo.aircraft_registration === this.app.selectedAircraft;

        if (matchesYear && matchesAircraft) {
          if (pathInfo.start_airport)
            visibleAirports.add(pathInfo.start_airport);
          if (pathInfo.end_airport) visibleAirports.add(pathInfo.end_airport);
        }
      });
    }

    // In isolate mode, only show airports from selected paths (ignore filter-only airports)
    if (hasIsolation) {
      visibleAirports.clear();
    }

    // If paths are selected, collect airports from selected paths
    if (hasSelection) {
      this.app.selectedPathIds.forEach((pathId) => {
        // Use fullPathInfo for reliable path-to-airport mapping (not affected by zoom level)
        if (this.app.fullPathInfo) {
          const pathInfo = this.app.fullPathInfo.find((p) => p.id === pathId);
          if (pathInfo) {
            if (pathInfo.start_airport)
              visibleAirports.add(pathInfo.start_airport);
            if (pathInfo.end_airport) visibleAirports.add(pathInfo.end_airport);
          }
        } else {
          // Fallback to pathToAirports if fullPathInfo not loaded yet
          const airports = this.app.pathToAirports[pathId];
          if (airports) {
            if (airports.start) visibleAirports.add(airports.start);
            if (airports.end) visibleAirports.add(airports.end);
          }
        }
      });
    }

    // Update visibility for all airport markers
    Object.keys(this.app.airportMarkers).forEach((airportName) => {
      const marker = this.app.airportMarkers[airportName];
      if (!marker) return;

      if (visibleAirports.has(airportName)) {
        // Show visited airports - add to map if not already present
        marker.setOpacity(1.0);
        if (!this.app.airportLayer.hasLayer(marker)) {
          marker.addTo(this.app.airportLayer);
        }
      } else {
        // Hide non-visited airports - completely remove from map to prevent clicks
        if (this.app.airportLayer.hasLayer(marker)) {
          this.app.airportLayer.removeLayer(marker);
        }
      }
    });
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

    mapContainer.dataset.zoomSize = sizeClass;
    mapContainer.classList.toggle("zoom-hide-labels", zoom < 5);
  }
}
