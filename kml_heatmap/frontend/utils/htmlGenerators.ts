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
import { calculateBearing, ddToDms } from "./geometry";

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
  const altMRounded = Math.round(altFtRounded * 0.3048);
  const altColor = window.KMLHeatmap.getColorForAltitude(
    altFt,
    params.altMin,
    params.altMax
  );
  const altColorBg = rgbToRgba(altColor, 0.15);

  const speedKt = segment.groundspeed_knots || 0;
  const speedKtRounded = Math.round(speedKt);
  const speedKmhRounded = Math.round(speedKt * 1.852);
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
    <div style="
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif;
        min-width: 180px;
        padding: 8px 4px;
        background-color: #2b2b2b;
        color: #ffffff;
    ">
        <div style="
            font-size: 14px;
            font-weight: bold;
            color: #4facfe;
            margin-bottom: 8px;
            padding-bottom: 6px;
            border-bottom: 2px solid #4facfe;
            display: flex;
            align-items: center;
            gap: 6px;
        ">
            <span style="font-size: 16px;">${icon}</span>
            <span>${title}</span>
        </div>
        <div style="margin-bottom: 8px; font-size: 12px; font-family: monospace; color: #ccc; padding: 4px 8px;">
            ${lat} ${lon}<br><span style="display: inline-block; margin-top: 4px;">Track: ${trackStr}</span>
        </div>
        <div style="margin-bottom: 8px;">
            <div style="font-size: 11px; color: #999; margin-bottom: 2px; text-transform: uppercase; letter-spacing: 0.5px;">Altitude (MSL)</div>
            <div style="background: ${altColorBg}; padding: 6px 8px; border-radius: 6px; border-left: 3px solid ${altColor};">
                <span style="font-size: 16px; font-weight: bold; color: ${altColor};">${altFtRounded} ft</span>
                <span style="font-size: 12px; color: #ccc; margin-left: 6px;">(${altMRounded} m)</span>
            </div>
        </div>
        <div style="margin-bottom: 8px;">
            <div style="font-size: 11px; color: #999; margin-bottom: 2px; text-transform: uppercase; letter-spacing: 0.5px;">Groundspeed</div>
            <div style="background: ${speedColorBg}; padding: 6px 8px; border-radius: 6px; border-left: 3px solid ${speedColor};">
                <span style="font-size: 16px; font-weight: bold; color: ${speedColor};">${speedKtRounded} kt</span>
                <span style="font-size: 12px; color: #ccc; margin-left: 6px;">(${speedKmhRounded} km/h)</span>
            </div>
        </div>
    </div>`;
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
