/**
 * Airport marker management service
 */

import L from "leaflet";
import type { Airport, PathInfo } from "../types";

export class AirportManager {
  private map: any; // L.Map - using any to avoid Leaflet type resolution issues
  private airportLayer: any; // L.LayerGroup - using any to avoid Leaflet type resolution issues
  private airportMarkers: Map<string, any> = new Map(); // L.Marker - using any to avoid Leaflet type resolution issues
  private pathToAirports: Map<string, { start?: string; end?: string }> =
    new Map();
  private airportToPaths: Map<string, Set<string>> = new Map();

  constructor(map: any, airportLayer: any) {
    this.map = map;
    this.airportLayer = airportLayer;
  }

  /**
   * Create and display airport markers
   */
  createAirportMarkers(
    airports: Airport[],
    onAirportClick?: (airportName: string) => void,
  ): void {
    // Clear existing markers
    this.airportMarkers.clear();
    this.airportLayer.clearLayers();

    airports.forEach((airport) => {
      // Extract ICAO code from name (format: "ICAO Name")
      const icao = airport.name.split(" ")[0];

      // Create custom icon for airport
      const icon = L.divIcon({
        className: "airport-marker",
        html: `
          <div style="
            background: rgba(255, 165, 0, 0.8);
            border: 2px solid white;
            border-radius: 50%;
            width: 12px;
            height: 12px;
            position: relative;
          "></div>
          <div style="
            position: absolute;
            top: 14px;
            left: 50%;
            transform: translateX(-50%);
            background: rgba(0, 0, 0, 0.7);
            color: white;
            padding: 2px 4px;
            border-radius: 3px;
            font-size: 10px;
            white-space: nowrap;
            font-weight: bold;
          ">${icao}</div>
        `,
        iconSize: [12, 12],
        iconAnchor: [6, 6],
      });

      const marker = L.marker([airport.lat, airport.lon], { icon });

      // Create popup with airport info
      const popupContent = `
        <div style="min-width: 150px;">
          <strong>${airport.name}</strong><br>
          <strong>Visits:</strong> ${airport.flight_count}
        </div>
      `;
      marker.bindPopup(popupContent);

      // Add click handler if provided
      if (onAirportClick) {
        marker.on("click", () => onAirportClick(airport.name));
      }

      marker.addTo(this.airportLayer);
      this.airportMarkers.set(airport.name, marker);
    });
  }

  /**
   * Build path-to-airport and airport-to-path relationships
   */
  buildAirportRelationships(pathInfo: PathInfo[]): void {
    this.pathToAirports.clear();
    this.airportToPaths.clear();

    pathInfo.forEach((path) => {
      const airports: { start?: string; end?: string } = {};

      if (path.start_airport) {
        airports.start = path.start_airport;
        if (!this.airportToPaths.has(path.start_airport)) {
          this.airportToPaths.set(path.start_airport, new Set());
        }
        this.airportToPaths.get(path.start_airport)!.add(path.id);
      }

      if (path.end_airport) {
        airports.end = path.end_airport;
        if (!this.airportToPaths.has(path.end_airport)) {
          this.airportToPaths.set(path.end_airport, new Set());
        }
        this.airportToPaths.get(path.end_airport)!.add(path.id);
      }

      if (airports.start || airports.end) {
        this.pathToAirports.set(path.id, airports);
      }
    });
  }

  /**
   * Update airport marker opacity based on filters and selection
   */
  updateAirportOpacity(
    visibleAirports: Set<string>,
    hasFiltersOrSelection: boolean,
  ): void {
    if (!hasFiltersOrSelection) {
      // Show all airports
      this.airportMarkers.forEach((marker) => {
        marker.setOpacity(1.0);
      });
      return;
    }

    // Show only visible airports
    this.airportMarkers.forEach((marker, airportName) => {
      if (visibleAirports.has(airportName)) {
        marker.setOpacity(1.0);
      } else {
        marker.setOpacity(0.0);
      }
    });
  }

  /**
   * Get paths associated with an airport
   */
  getPathsForAirport(airportName: string): Set<string> {
    return this.airportToPaths.get(airportName) || new Set();
  }

  /**
   * Get airports for a path
   */
  getAirportsForPath(
    pathId: string,
  ): { start?: string; end?: string } | undefined {
    return this.pathToAirports.get(pathId);
  }

  /**
   * Clear all airport markers
   */
  clear(): void {
    this.airportMarkers.clear();
    this.airportLayer.clearLayers();
    this.pathToAirports.clear();
    this.airportToPaths.clear();
  }
}
