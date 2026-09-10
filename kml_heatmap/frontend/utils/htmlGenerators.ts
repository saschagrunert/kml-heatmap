/**
 * HTML generation utilities for UI components
 * Pure functions that generate HTML strings
 *
 * Two spellings, split on purpose: a self-contained block of markup is a
 * template literal so the tags stay indented and readable, and markup
 * assembled a piece at a time from conditionals and loops is concatenated,
 * where a literal would need a `${}` around every fragment.
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
import { formatNumber } from "./formatters";
import { calculateBearing, ddToDms } from "./geometry";
import { icon } from "./icons";

export type { YearStats } from "../types";

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * A count with its noun, pluralised: `pluralize(1, "flight")` is "1 flight",
 * `pluralize(2, "flight")` is "2 flights".
 *
 * @param count - The number to render
 * @param singular - Noun in its singular form
 * @param plural - Plural form when appending an "s" does not produce it
 */
export function pluralize(
  count: number,
  singular: string,
  plural: string = singular + "s",
): string {
  return count + " " + (count === 1 ? singular : plural);
}

/** "1 flight" or "12 flights" for a count */
export function pluralFlights(count: number): string {
  return pluralize(count, "flight");
}

/** An airport label split into its ICAO code and its name */
export interface AirportLabel {
  /** ICAO/IATA style code, empty when the label carries none */
  code: string;
  /** Airport name without the leading code */
  name: string;
}

/**
 * Split a label such as "EDAQ Halle-Oppin" into its code and its name so the
 * two can be typeset differently. Labels without a leading code keep their
 * full text as the name.
 */
export function splitAirportName(label: string): AirportLabel {
  const trimmed = label.trim();
  const spaceIndex = trimmed.indexOf(" ");
  if (spaceIndex > 0) {
    const code = trimmed.slice(0, spaceIndex);
    const name = trimmed.slice(spaceIndex + 1).trim();
    if (name && /^[A-Z0-9]{3,4}$/.test(code)) {
      return { code, name };
    }
  }
  return { code: "", name: trimmed };
}

/** Section heading for a Wrapped card: line icon plus label */
function wrappedSectionTitle(
  className: string,
  iconName: Parameters<typeof icon>[0],
  label: string,
): string {
  return (
    '<h3 class="' +
    className +
    '">' +
    icon(iconName, 20) +
    '<span class="section-title-text">' +
    label +
    "</span></h3>"
  );
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
 * One tile of the Wrapped stat grid. The unit is a separate element so it can
 * be typeset smaller than the display figure it belongs to.
 */
function statCard(value: string, unit: string, label: string): string {
  const unitHtml = unit
    ? ' <span class="stat-unit">' + escapeHtml(unit) + "</span>"
    : "";
  return (
    '<div class="stat-card">' +
    '<div class="stat-value">' +
    escapeHtml(value) +
    unitHtml +
    "</div>" +
    '<div class="stat-label">' +
    label +
    "</div>" +
    "</div>"
  );
}

/** The two surfaces that set a unit in small muted type */
export type UnitClass = "stat-unit" | "kh-stats-lead-unit";

/**
 * Mark the h and m of a flight time as units.
 *
 * Every other lead figure sets its unit in the small muted type ("4,745.5
 * nm"), so "47h 44m" has to do the same rather than shouting both letters at
 * full weight. The class differs per surface, hence the parameter, which is a
 * closed set rather than a string: it lands inside a class attribute, and a
 * caller reaching this with something it read from the data would be writing
 * markup through it.
 *
 * @param flightTime - Formatted time, e.g. "47h 44m"
 * @param unitClass - Class the h and m are wrapped in
 */
export function markFlightTimeUnits(
  flightTime: string,
  unitClass: UnitClass,
): string {
  return escapeHtml(flightTime).replace(
    /(\d+)\s*(h)\s*(\d+)\s*(m)/,
    (_match, hours: string, hourUnit: string, mins: string, minUnit: string) =>
      hours +
      '<span class="' +
      unitClass +
      '">' +
      hourUnit +
      "</span> " +
      mins +
      '<span class="' +
      unitClass +
      '">' +
      minUnit +
      "</span>",
  );
}

function flightTimeCard(flightTime: string): string {
  return (
    '<div class="stat-card">' +
    '<div class="stat-value">' +
    markFlightTimeUnits(flightTime, "stat-unit") +
    "</div>" +
    '<div class="stat-label">Flight Time</div>' +
    "</div>"
  );
}

/**
 * Generate stats grid HTML
 */
export function generateStatsHtml(
  yearStats: YearStats,
  fullStats: FilteredStatistics | null,
  hasTimingData: boolean,
): string {
  const maxAltitudeFt = (fullStats?.max_altitude_m || 0) * METERS_TO_FEET;

  return (
    statCard(formatNumber(yearStats.total_flights), "", "Flights") +
    statCard(formatNumber(yearStats.num_airports), "", "Airports") +
    // One decimal, like the statistics panel: the same figure reading 4746
    // here and 4745.5 there only makes the reader wonder which one is right
    statCard(formatNumber(yearStats.total_distance_nm, 1), "nm", "Distance") +
    (hasTimingData
      ? flightTimeCard(yearStats.flight_time) +
        statCard(
          formatNumber(fullStats?.max_groundspeed_knots || 0),
          "kt",
          "Max Groundspeed",
        )
      : "") +
    statCard(formatNumber(maxAltitudeFt), "ft", "Max Altitude (MSL)")
  );
}

/**
 * Generate fun facts HTML
 */
export function generateFunFactsHtml(funFacts: FunFact[]): string {
  let html = wrappedSectionTitle("fun-facts-title", "wrapped", "Facts");
  for (const fact of funFacts) {
    html += `<div class="fun-fact" data-category="${escapeHtml(fact.category)}"><span class="fun-fact-icon" aria-hidden="true">${fact.icon}</span><span class="fun-fact-text">${fact.text}</span></div>`;
  }
  return html;
}

/**
 * Colour class of one fleet entry, from its flight count relative to the
 * busiest and the quietest aircraft of the same fleet. A fleet whose entries
 * all have the same count is drawn entirely in the warmest colour.
 */
export function calculateAircraftColorClass(
  flights: number,
  maxFlights: number,
  minFlights: number,
): string {
  if (maxFlights === minFlights) return "fleet-aircraft-high";

  const normalized = (flights - minFlights) / (maxFlights - minFlights);
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

  let html = wrappedSectionTitle("aircraft-fleet-title", "aircraft", "Fleet");

  const maxFlights = yearStats.aircraft_list[0]?.flights ?? 0;
  const minFlights =
    yearStats.aircraft_list[yearStats.aircraft_list.length - 1]?.flights ?? 0;

  for (const aircraft of yearStats.aircraft_list) {
    const modelStr = aircraft.model || aircraft.type || "";
    const colorClass = calculateAircraftColorClass(
      aircraft.flights,
      maxFlights,
      minFlights,
    );
    const flightTimeStr = aircraft.flight_time_str || "---";

    html +=
      '<div class="fleet-aircraft ' +
      colorClass +
      '">' +
      '<div class="fleet-aircraft-info">' +
      '<div class="fleet-aircraft-model">' +
      escapeHtml(modelStr) +
      "</div>" +
      '<div class="fleet-aircraft-registration">' +
      escapeHtml(aircraft.registration) +
      "</div>" +
      "</div>" +
      '<div class="fleet-aircraft-stats">' +
      '<div class="fleet-aircraft-flights">' +
      pluralFlights(aircraft.flights) +
      "</div>" +
      '<div class="fleet-aircraft-time">' +
      escapeHtml(flightTimeStr) +
      "</div>" +
      "</div>" +
      "</div>";
  }

  return html;
}

/**
 * Generate home base HTML
 */
export function generateHomeBaseHtml(homeBase: AirportCount): string {
  const { code, name } = splitAirportName(homeBase.name);
  const codeHtml = code
    ? '<span class="top-airport-code">' + escapeHtml(code) + "</span>"
    : "";

  return (
    wrappedSectionTitle("top-airports-title", "airport", "Home Base") +
    '<div class="top-airport">' +
    '<div class="top-airport-name">' +
    codeHtml +
    '<span class="top-airport-place">' +
    escapeHtml(name) +
    "</span>" +
    "</div>" +
    '<div class="top-airport-count">' +
    pluralFlights(homeBase.flight_count) +
    "</div>" +
    "</div>"
  );
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
  const altMRounded = altFtRounded * FEET_TO_METERS;
  const altColor = getColorForAltitude(altFt, params.altMin, params.altMax);
  const altColorBg = rgbToRgba(altColor, 0.15);

  const speedKt = segment.groundspeed_knots || 0;
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
            <span>${escapeHtml(title)}</span>
        </div>
        <div class="popup-coords kh-popup-block">
            ${lat} ${lon}<br><span class="kh-popup-track">Track: ${trackStr}</span>
        </div>
        <div class="kh-popup-block">
            <div class="popup-section-label">Altitude (MSL)</div>
            <div class="popup-metric kh-popup-metric-colored" style="--kh-metric-color: ${altColor}; --kh-metric-bg: ${altColorBg};">
                <span class="popup-metric-value">${formatNumber(altFtRounded)} ft</span>
                <span class="popup-metric-unit">(${formatNumber(altMRounded)} m)</span>
            </div>
        </div>
        <div class="kh-popup-block">
            <div class="popup-section-label">Groundspeed</div>
            <div class="popup-metric kh-popup-metric-colored" style="--kh-metric-color: ${speedColor}; --kh-metric-bg: ${speedColorBg};">
                <span class="popup-metric-value">${formatNumber(speedKt)} kt</span>
                <span class="popup-metric-unit">(${formatNumber(speedKt * NAUTICAL_MILES_TO_KM)} km/h)</span>
            </div>
        </div>
    </div>`;
}

export interface DestinationsOptions {
  /** Resolve a country code to its display name */
  countryName: (code: string) => string;
  /** Resolve a country code to its flag */
  flag: (code: string) => string;
  /** Airport that carries the home base accent */
  homeBase?: string | null;
  /** Airport furthest from the home base; carries the second accent */
  furthest?: string | null;
}

/** One airport row: code, name and at most one accent tag */
function destinationRow(
  name: string,
  isHome: boolean,
  isFurthest: boolean,
): string {
  const { code, name: place } = splitAirportName(name);
  const stateClass = isHome ? " is-home" : isFurthest ? " is-furthest" : "";
  const codeHtml = code
    ? '<span class="destination-code">' + escapeHtml(code) + "</span>"
    : "";
  const tag = isHome ? "Home" : isFurthest ? "Furthest" : "";
  const tagHtml = tag ? '<span class="destination-tag">' + tag + "</span>" : "";

  return (
    '<li class="destination' +
    stateClass +
    '">' +
    codeHtml +
    '<span class="destination-name">' +
    escapeHtml(place) +
    "</span>" +
    tagHtml +
    "</li>"
  );
}

export function generateDestinationsHtml(
  grouped: Map<string, string[]>,
  options: DestinationsOptions,
): string {
  if (grouped.size === 0) return "";

  const { countryName, flag, homeBase, furthest } = options;
  let html = wrappedSectionTitle(
    "airports-grid-title",
    "airport",
    "Destinations",
  );

  let groupIndex = 0;
  for (const [code, airports] of grouped) {
    const f = code !== "Other" ? flag(code) : "";
    const label = code === "Other" ? "Other" : countryName(code);
    const flagHtml = f
      ? '<span class="country-flag" aria-hidden="true">' +
        escapeHtml(f) +
        "</span>"
      : "";
    const delay = (groupIndex * 0.1).toFixed(1);
    html +=
      '<div class="country-group" style="animation-delay: ' +
      delay +
      's">' +
      '<div class="country-group-title">' +
      flagHtml +
      '<span class="country-name">' +
      escapeHtml(label) +
      "</span>" +
      '<span class="country-count">' +
      airports.length +
      "</span>" +
      "</div>" +
      '<ul class="country-airports">';
    groupIndex++;
    for (const name of airports) {
      const isHome = !!homeBase && name === homeBase;
      const isFurthest = !isHome && !!furthest && name === furthest;
      html += destinationRow(name, isHome, isFurthest);
    }
    html += "</ul></div>";
  }

  return html;
}
