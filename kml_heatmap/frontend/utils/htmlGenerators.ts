/**
 * HTML generation utilities for UI components
 * Pure functions that generate HTML strings
 */
import type {
  FilteredStatistics,
  FunFact,
  PathSegment,
  YearStats,
} from "../types";
import { getColorForAirspeed, getColorForAltitude, rgbToRgba } from "./colors";
import {
  FEET_TO_METERS,
  METERS_TO_FEET,
  NAUTICAL_MILES_TO_KM,
} from "./constants";
import { calculateBearing, ddToDms } from "./geometry";

export type { YearStats } from "../types";

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

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
    ? '<span class="kh-popup-home-badge">HOME</span>'
    : "";

  return `
    <div class="popup-container kh-popup-airport">
        <div class="popup-header kh-popup-header-airport">
            <span class="popup-header-icon kh-popup-icon-lg">&#x1F6EB;</span>
            <span>${escapeHtml(params.name || "Unknown")}</span>
            ${homeBadge}
        </div>
        <div class="kh-popup-block">
            <div class="popup-section-label">Coordinates</div>
            <a href="${googleMapsLink}"
               target="_blank"
               rel="noopener noreferrer"
               class="airport-popup-link kh-popup-link">
                <span>&#x1F4CD;</span>
                <span>${params.latDms}<br>${params.lonDms}</span>
            </a>
        </div>
        <div class="popup-metric kh-popup-metric-flights">
            <span class="kh-popup-metric-label">Total Flights</span>
            <span class="popup-metric-value kh-popup-accent">${params.flightCount}</span>
        </div>
    </div>`;
}

/**
 * Generate stats grid HTML
 */
export function generateStatsHtml(
  yearStats: YearStats,
  fullStats: FilteredStatistics | null,
  hasTimingData: boolean,
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
                <div class="stat-value">${Math.round((fullStats?.max_altitude_m || 0) * METERS_TO_FEET)} ft</div>
                <div class="stat-label">Max Altitude (MSL)</div>
            </div>
        `;

  return statsHtml;
}

/**
 * Generate fun facts HTML
 */
export function generateFunFactsHtml(funFacts: FunFact[]): string {
  let html = '<h3 class="fun-facts-title">✨ Facts</h3>';
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

  let html = '<h3 class="aircraft-fleet-title">✈️ Fleet</h3>';

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
                            <div class="fleet-aircraft-model">${escapeHtml(modelStr)}</div>
                            <div class="fleet-aircraft-registration">${escapeHtml(aircraft.registration)}</div>
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
  let html = '<h3 class="top-airports-title">🏠 Home Base</h3>';
  html += `
                <div class="top-airport">
                    <div class="top-airport-name">${escapeHtml(homeBase.name)}</div>
                    <div class="top-airport-count">${homeBase.flight_count} flights</div>
                </div>
            `;
  return html;
}

export interface SegmentPopupParams {
  segment: PathSegment;
  altMin: number;
  altMax: number;
  speedMin: number;
  speedMax: number;
  title?: string;
  icon?: string;
}

/**
 * Generate path segment popup HTML with position, altitude, and groundspeed.
 * The data-driven altitude/speed colours are passed as CSS custom properties
 * (`--kh-metric-color`, `--kh-metric-bg`) consumed by `.kh-popup-metric-colored`.
 */
export function generateSegmentPopupHtml(params: SegmentPopupParams): string {
  const { segment } = params;
  const title = params.title || "Segment Data";
  const icon = params.icon || "📍";

  const altFt = segment.altitude_ft || 0;
  const altFtRounded = Math.round(altFt / 50) * 50;
  const altMRounded = Math.round(altFtRounded * FEET_TO_METERS);
  const altColor = getColorForAltitude(altFt, params.altMin, params.altMax);
  const altColorBg = rgbToRgba(altColor, 0.15);

  const speedKt = segment.groundspeed_knots || 0;
  const speedKtRounded = Math.round(speedKt);
  const speedKmhRounded = Math.round(speedKt * NAUTICAL_MILES_TO_KM);
  const speedColor = getColorForAirspeed(
    speedKt,
    params.speedMin,
    params.speedMax,
  );
  const speedColorBg = rgbToRgba(speedColor, 0.15);

  const startCoord = segment.coords?.[0];
  const endCoord = segment.coords?.[1];
  const lat = endCoord?.[0] != null ? ddToDms(endCoord[0], true) : "N/A";
  const lon = endCoord?.[1] != null ? ddToDms(endCoord[1], false) : "N/A";

  let trackStr = "N/A";
  if (startCoord && endCoord) {
    const trk = Math.round(
      calculateBearing(startCoord[0], startCoord[1], endCoord[0], endCoord[1]),
    );
    trackStr = String(trk).padStart(3, "0") + "°";
  }

  return `
    <div class="popup-container">
        <div class="popup-header kh-popup-header-segment">
            <span class="popup-header-icon">${icon}</span>
            <span>${title}</span>
        </div>
        <div class="popup-coords kh-popup-block">
            ${lat} ${lon}<br><span class="kh-popup-track">Track: ${trackStr}</span>
        </div>
        <div class="kh-popup-block">
            <div class="popup-section-label">Altitude (MSL)</div>
            <div class="popup-metric kh-popup-metric-colored" style="--kh-metric-color: ${altColor}; --kh-metric-bg: ${altColorBg};">
                <span class="popup-metric-value">${altFtRounded} ft</span>
                <span class="popup-metric-unit">(${altMRounded} m)</span>
            </div>
        </div>
        <div class="kh-popup-block">
            <div class="popup-section-label">Groundspeed</div>
            <div class="popup-metric kh-popup-metric-colored" style="--kh-metric-color: ${speedColor}; --kh-metric-bg: ${speedColorBg};">
                <span class="popup-metric-value">${speedKtRounded} kt</span>
                <span class="popup-metric-unit">(${speedKmhRounded} km/h)</span>
            </div>
        </div>
    </div>`;
}

export function generateDestinationsHtml(
  grouped: Map<string, string[]>,
  countryName: (code: string) => string,
  flag: (code: string) => string,
): string {
  if (grouped.size === 0) return "";

  let html = '<h3 class="airports-grid-title">🗺️ Destinations</h3>';

  let groupIndex = 0;
  for (const [code, airports] of grouped) {
    const f = code !== "Other" ? flag(code) : "";
    const label = code === "Other" ? "Other" : countryName(code);
    const title = f ? `${escapeHtml(label)} &ensp;${f}` : escapeHtml(label);
    const delay = (groupIndex * 0.1).toFixed(1);
    html += `<div class="country-group" style="animation-delay: ${delay}s"><div class="country-group-title">${title}</div><div class="airport-badges">`;
    groupIndex++;
    for (const name of airports) {
      html += `<div class="airport-badge">${escapeHtml(name)}</div>`;
    }
    html += "</div></div>";
  }

  return html;
}
