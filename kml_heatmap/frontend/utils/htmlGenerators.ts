/**
 * HTML generation utilities for UI components
 * Pure functions that generate HTML strings
 */
import type { FilteredStatistics, FunFact, YearStats } from "../types";

export interface AirportCount {
  name: string;
  flight_count: number;
}

export interface AirportPopupParams {
  name: string;
  lat: number;
  lon: number;
  latDms: string;
  lonDms: string;
  flightCount: number;
  isHomeBase: boolean;
}

/**
 * Generate airport marker popup HTML
 */
export function generateAirportPopupHtml(params: AirportPopupParams): string {
  const googleMapsLink = `https://www.google.com/maps?q=${params.lat},${params.lon}`;
  const homeBadge = params.isHomeBase
    ? '<span style="font-size: 12px; background: #007bff; color: white; padding: 2px 6px; border-radius: 3px; margin-left: 4px;">HOME</span>'
    : "";

  return `
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
            <span style="font-size: 18px;">&#x1F6EB;</span>
            <span>${params.name || "Unknown"}</span>
            ${homeBadge}
        </div>
        <div style="margin-bottom: 8px;">
            <div style="font-size: 11px; color: #999; margin-bottom: 2px; text-transform: uppercase; letter-spacing: 0.5px;">Coordinates</div>
            <a href="${googleMapsLink}"
               target="_blank"
               rel="noopener noreferrer"
               style="
                   color: #4facfe;
                   text-decoration: none;
                   font-size: 12px;
                   font-family: monospace;
                   display: flex;
                   align-items: center;
                   gap: 4px;
               "
               class="airport-popup-link">
                <span>&#x1F4CD;</span>
                <span>${params.latDms}<br>${params.lonDms}</span>
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
            <span style="font-size: 16px; font-weight: bold; color: #4facfe;">${params.flightCount}</span>
        </div>
    </div>`;
}

/**
 * Generate stats grid HTML
 */
export function generateStatsHtml(
  yearStats: YearStats,
  fullStats: FilteredStatistics | null,
  hasTimingData: boolean
): string {
  const statsHtml = `
            <div class="stat-card">
                <div class="stat-value">${yearStats.total_flights}</div>
                <div class="stat-label">Flights</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${yearStats.num_airports}</div>
                <div class="stat-label">Airports</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${yearStats.total_distance_nm.toFixed(0)}</div>
                <div class="stat-label">Nautical Miles</div>
            </div>
            ${
              hasTimingData
                ? `
            <div class="stat-card">
                <div class="stat-value">${yearStats.flight_time}</div>
                <div class="stat-label">Flight Time</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${(fullStats?.max_groundspeed_knots || 0).toFixed(0)} kt</div>
                <div class="stat-label">Max Groundspeed</div>
            </div>
            `
                : ""
            }
            <div class="stat-card">
                <div class="stat-value">${Math.round((fullStats?.max_altitude_m || 0) / 0.3048)} ft</div>
                <div class="stat-label">Max Altitude (MSL)</div>
            </div>
        `;

  return statsHtml;
}

/**
 * Generate fun facts HTML
 */
export function generateFunFactsHtml(funFacts: FunFact[]): string {
  let html = '<div class="fun-facts-title">✨ Facts</div>';
  funFacts.forEach((fact: FunFact) => {
    html += `<div class="fun-fact" data-category="${fact.category}"><span class="fun-fact-icon">${fact.icon}</span><span class="fun-fact-text">${fact.text}</span></div>`;
  });
  return html;
}

/**
 * Calculate color class based on normalized flight count
 */
export function calculateAircraftColorClass(normalized: number): string {
  if (normalized >= 0.75) {
    return "fleet-aircraft-high"; // Most flights - warm color
  } else if (normalized >= 0.5) {
    return "fleet-aircraft-medium-high";
  } else if (normalized >= 0.25) {
    return "fleet-aircraft-medium-low";
  } else {
    return "fleet-aircraft-low"; // Least flights - cool color
  }
}

/**
 * Generate aircraft fleet HTML
 */
export function generateAircraftFleetHtml(yearStats: YearStats): string {
  if (!yearStats.aircraft_list || yearStats.aircraft_list.length === 0) {
    return "";
  }

  let html = '<div class="aircraft-fleet-title">✈️ Fleet</div>';

  const maxFlights = yearStats.aircraft_list[0]?.flights ?? 0;
  const minFlights =
    yearStats.aircraft_list[yearStats.aircraft_list.length - 1]?.flights ?? 0;
  const flightRange = maxFlights - minFlights;

  yearStats.aircraft_list.forEach((aircraft) => {
    const modelStr = aircraft.model || aircraft.type || "";
    const normalized =
      flightRange > 0 ? (aircraft.flights - minFlights) / flightRange : 1;
    const colorClass = calculateAircraftColorClass(normalized);
    const flightTimeStr = aircraft.flight_time_str || "---";

    html += `
                    <div class="fleet-aircraft ${colorClass}">
                        <div class="fleet-aircraft-info">
                            <div class="fleet-aircraft-model">${modelStr}</div>
                            <div class="fleet-aircraft-registration">${aircraft.registration}</div>
                        </div>
                        <div class="fleet-aircraft-stats">
                            <div class="fleet-aircraft-flights">${aircraft.flights} flights</div>
                            <div class="fleet-aircraft-time">${flightTimeStr}</div>
                        </div>
                    </div>
                `;
  });

  return html;
}

/**
 * Generate home base HTML
 */
export function generateHomeBaseHtml(homeBase: AirportCount): string {
  let html = '<div class="top-airports-title">🏠 Home Base</div>';
  html += `
                <div class="top-airport">
                    <div class="top-airport-name">${homeBase.name}</div>
                    <div class="top-airport-count">${homeBase.flight_count} flights</div>
                </div>
            `;
  return html;
}

/**
 * Generate destinations badges HTML
 */
export function generateDestinationsHtml(destinations: string[]): string {
  if (destinations.length === 0) {
    return "";
  }

  let html =
    '<div class="airports-grid-title">🗺️ Destinations</div><div class="airport-badges">';
  destinations.forEach((airportName) => {
    html += `<div class="airport-badge">${airportName}</div>`;
  });
  html += "</div>";

  return html;
}
