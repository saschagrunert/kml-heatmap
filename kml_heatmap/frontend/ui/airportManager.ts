/**
 * Airport Manager - Handles airport markers and popups
 */
import type { MapApp } from "../mapApp";

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
                    <span style="font-size: 16px; font-weight: bold; color: #4facfe;">${flightCount}</span>
                </div>
            </div>`;

      marker.setPopupContent(popup);
    });
  }

  updateAirportOpacity(): void {
    // Check if filters are active
    const hasFilters =
      this.app.selectedYear !== "all" || this.app.selectedAircraft !== "all";
    const hasSelection = this.app.selectedPathIds.size > 0;

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

    // If paths are selected, collect airports from selected paths (overrides filter)
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
    let sizeClass = "";

    if (zoom >= 14) {
      sizeClass = "xlarge";
    } else if (zoom >= 12) {
      sizeClass = "large";
    } else if (zoom >= 10) {
      sizeClass = "medium";
    } else if (zoom >= 8) {
      sizeClass = "medium-small";
    } else if (zoom >= 6) {
      sizeClass = "small";
    }

    // Update all airport markers
    document
      .querySelectorAll(".airport-marker-container")
      .forEach((container) => {
        const marker = container.querySelector(".airport-marker");
        const label = container.querySelector(".airport-label");

        if (!marker || !label) return;

        // Hide labels when zoomed out below level 5, but keep dots visible
        if (zoom < 5) {
          (label as HTMLElement).style.display = "none";
        } else {
          (label as HTMLElement).style.display = "";
        }

        // Remove all size classes
        container.classList.remove(
          "airport-marker-container-small",
          "airport-marker-container-medium-small",
          "airport-marker-container-medium",
          "airport-marker-container-large",
          "airport-marker-container-xlarge"
        );
        marker.classList.remove(
          "airport-marker-small",
          "airport-marker-medium-small",
          "airport-marker-medium",
          "airport-marker-large",
          "airport-marker-xlarge"
        );
        label.classList.remove(
          "airport-label-small",
          "airport-label-medium-small",
          "airport-label-medium",
          "airport-label-large",
          "airport-label-xlarge"
        );

        // Add appropriate size class
        if (sizeClass) {
          container.classList.add("airport-marker-container-" + sizeClass);
          marker.classList.add("airport-marker-" + sizeClass);
          label.classList.add("airport-label-" + sizeClass);
        }
      });
  }
}
