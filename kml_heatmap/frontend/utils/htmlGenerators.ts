/**
 * HTML generation utilities for wrapped feature
 * Pure functions that generate HTML strings for various UI components
 */
import type { FilteredStatistics, FunFact } from "../types";

export interface YearStats {
  total_flights: number;
  num_airports: number;
  total_distance_nm: number;
  flight_time: string;
  airport_names: string[];
  aircraft_list?: Array<{
    registration: string;
    type?: string;
    model?: string;
    flights: number;
    flight_time_str?: string;
  }>;
}

export interface AirportCount {
  name: string;
  flight_count: number;
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
                <div class="stat-value">${Math.round((fullStats?.max_altitude_m || 0) / 0.3048).toLocaleString()} ft</div>
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
