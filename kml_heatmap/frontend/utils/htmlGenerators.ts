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
import { rgbToRgba } from "./colors";
import {
  FEET_TO_METERS,
  METERS_TO_FEET,
  NAUTICAL_MILES_TO_KM,
} from "./constants";
import { calculateBearing, ddToDms } from "./geometry";

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
    ? '<span style="font-size: 12px; background: #007bff; color: white; padding: 2px 6px; border-radius: 3px; margin-left: 4px;">HOME</span>'
    : "";

  return `
    <div class="popup-container" style="min-width: 220px;">
        <div class="popup-header" style="font-size: 15px; color: #28a745; margin-bottom: 10px; padding-bottom: 8px; border-color: #28a745;">
            <span class="popup-header-icon" style="font-size: 18px;">&#x1F6EB;</span>
            <span>${escapeHtml(params.name || "Unknown")}</span>
            ${homeBadge}
        </div>
        <div style="margin-bottom: 8px;">
            <div class="popup-section-label">Coordinates</div>
            <a href="${googleMapsLink}"
               target="_blank"
               rel="noopener noreferrer"
               style="color: #4facfe; text-decoration: none; font-size: 12px; font-family: monospace; display: flex; align-items: center; gap: 4px;"
               class="airport-popup-link">
                <span>&#x1F4CD;</span>
                <span>${params.latDms}<br>${params.lonDms}</span>
            </a>
        </div>
        <div class="popup-metric" style="background: linear-gradient(135deg, rgba(79, 172, 254, 0.15) 0%, rgba(0, 242, 254, 0.15) 100%); border-color: #4facfe; display: flex; justify-content: space-between; align-items: center;">
            <span style="font-size: 12px; color: #ccc; font-weight: 500;">Total Flights</span>
            <span class="popup-metric-value" style="color: #4facfe;">${params.flightCount}</span>
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
  let html = '<div class="top-airports-title">🏠 Home Base</div>';
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
 * Generate path segment popup HTML with position, altitude, and groundspeed
 */
export function generateSegmentPopupHtml(params: SegmentPopupParams): string {
  const { segment } = params;
  const title = params.title || "Segment Data";
  const icon = params.icon || "📍";

  const altFt = segment.altitude_ft || 0;
  const altFtRounded = Math.round(altFt / 50) * 50;
  const altMRounded = Math.round(altFtRounded * FEET_TO_METERS);
  const altColor = window.KMLHeatmap.getColorForAltitude(
    altFt,
    params.altMin,
    params.altMax
  );
  const altColorBg = rgbToRgba(altColor, 0.15);

  const speedKt = segment.groundspeed_knots || 0;
  const speedKtRounded = Math.round(speedKt);
  const speedKmhRounded = Math.round(speedKt * NAUTICAL_MILES_TO_KM);
  const speedColor = window.KMLHeatmap.getColorForAirspeed(
    speedKt,
    params.speedMin,
    params.speedMax
  );
  const speedColorBg = rgbToRgba(speedColor, 0.15);

  const startCoord = segment.coords?.[0];
  const endCoord = segment.coords?.[1];
  const lat = endCoord?.[0] != null ? ddToDms(endCoord[0], true) : "N/A";
  const lon = endCoord?.[1] != null ? ddToDms(endCoord[1], false) : "N/A";

  let trackStr = "N/A";
  if (startCoord && endCoord) {
    const trk = Math.round(
      calculateBearing(startCoord[0], startCoord[1], endCoord[0], endCoord[1])
    );
    trackStr = String(trk).padStart(3, "0") + "°";
  }

  return `
    <div class="popup-container">
        <div class="popup-header" style="color: #4facfe; border-color: #4facfe;">
            <span class="popup-header-icon">${icon}</span>
            <span>${title}</span>
        </div>
        <div class="popup-coords" style="margin-bottom: 8px;">
            ${lat} ${lon}<br><span style="display: inline-block; margin-top: 4px;">Track: ${trackStr}</span>
        </div>
        <div style="margin-bottom: 8px;">
            <div class="popup-section-label">Altitude (MSL)</div>
            <div class="popup-metric" style="background: ${altColorBg}; border-color: ${altColor};">
                <span class="popup-metric-value" style="color: ${altColor};">${altFtRounded} ft</span>
                <span class="popup-metric-unit">(${altMRounded} m)</span>
            </div>
        </div>
        <div style="margin-bottom: 8px;">
            <div class="popup-section-label">Groundspeed</div>
            <div class="popup-metric" style="background: ${speedColorBg}; border-color: ${speedColor};">
                <span class="popup-metric-value" style="color: ${speedColor};">${speedKtRounded} kt</span>
                <span class="popup-metric-unit">(${speedKmhRounded} km/h)</span>
            </div>
        </div>
    </div>`;
}

export function generateDestinationsHtml(
  grouped: Map<string, string[]>,
  countryName: (code: string) => string,
  flag: (code: string) => string
): string {
  if (grouped.size === 0) return "";

  let html = '<div class="airports-grid-title">🗺️ Destinations</div>';

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
