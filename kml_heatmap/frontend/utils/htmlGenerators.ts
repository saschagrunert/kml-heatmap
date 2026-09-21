/**
 * HTML generation utilities for UI components
 * Pure functions that generate HTML strings
 *
 * Two spellings, split on purpose: a self-contained block of markup is a
 * template literal so the tags stay indented and readable, and markup
 * assembled a piece at a time from conditionals and loops is concatenated,
 * where a literal would need a `${}` around every fragment.
 */
import type { PathSegment } from "../types";
import { getColorForAirspeed, getColorForAltitude, rgbToRgba } from "./colors";
import { FEET_TO_METERS, NAUTICAL_MILES_TO_KM } from "./constants";
import { formatNumber, formatTrack } from "./formatters";
import { calculateBearing, ddToDms, type Coordinate } from "./geometry";
import { icon, type IconName } from "./icons";

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
 * Generate airport marker popup HTML. The container takes focus when a
 * keyboard opens the popup; the flight list is added when it is shown (see
 * ui/airportFlights.ts).
 */
export function generateAirportPopupHtml(params: AirportPopupParams): string {
  const googleMapsLink = `https://www.google.com/maps?q=${params.lat},${params.lon}`;
  const homeBadge = params.isHomeBase
    ? '<span class="kh-popup-home-badge">HOME</span>'
    : "";

  return `
    <div class="popup-container kh-popup-airport" tabindex="-1">
        <div class="popup-header kh-popup-header-airport">
            <span class="popup-header-icon">${icon("airport", 20)}</span>
            <span>${escapeHtml(params.name || "Unknown")}</span>
            ${homeBadge}
        </div>
        <div class="kh-popup-block">
            <div class="popup-section-label">Coordinates</div>
            <a href="${googleMapsLink}"
               target="_blank"
               rel="noopener noreferrer"
               class="kh-popup-link">
                <span>${params.latDms}<br>${params.lonDms}</span>
                ${icon("externalLink", 16, "Opens Google Maps in a new tab")}
            </a>
        </div>
        <div class="popup-metric kh-popup-metric-flights">
            <span class="kh-popup-metric-label">Total Flights</span>
            <span class="popup-metric-value kh-popup-accent">${params.flightCount}</span>
        </div>
    </div>`;
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

export interface SegmentPopupParams {
  segment: PathSegment;
  /** Position to show; the segment's end point when not given */
  position?: Coordinate;
  altMin: number;
  altMax: number;
  speedMin: number;
  speedMax: number;
  title?: string;
  icon?: IconName;
}

/**
 * Generate path segment popup HTML with position, altitude, and groundspeed.
 * The data-driven altitude/speed colours travel as `data-metric-color`; the
 * CSP allows no style attribute, so applyMetricColors() carries them into
 * the custom properties `.kh-popup-metric-colored` reads.
 */
export function generateSegmentPopupHtml(params: SegmentPopupParams): string {
  const { segment } = params;
  const title = params.title || "Segment Data";
  const headerIcon = params.icon ?? "airport";

  const altFt = segment.altitude_ft || 0;
  const altFtRounded = Math.round(altFt / 50) * 50;
  const altMRounded = altFtRounded * FEET_TO_METERS;
  const altColor = getColorForAltitude(altFt, params.altMin, params.altMax);

  const speedKt = segment.groundspeed_knots || 0;
  const speedColor = getColorForAirspeed(
    speedKt,
    params.speedMin,
    params.speedMax,
  );

  const startCoord = segment.coords?.[0];
  const endCoord = segment.coords?.[1];
  const shown = params.position ?? endCoord;
  const lat = shown?.[0] != null ? ddToDms(shown[0], true) : "N/A";
  const lon = shown?.[1] != null ? ddToDms(shown[1], false) : "N/A";

  let trackStr = "N/A";
  if (startCoord && endCoord) {
    trackStr = formatTrack(
      calculateBearing(startCoord[0], startCoord[1], endCoord[0], endCoord[1]),
    );
  }

  return `
    <div class="popup-container">
        <div class="popup-header kh-popup-header-segment">
            <span class="popup-header-icon">${icon(headerIcon, 20)}</span>
            <span>${escapeHtml(title)}</span>
        </div>
        <div class="popup-coords kh-popup-block">
            ${lat} ${lon}<br><span class="kh-popup-track">Track: ${trackStr}</span>
        </div>
        <div class="kh-popup-block">
            <div class="popup-section-label">Altitude (MSL)</div>
            <div class="popup-metric kh-popup-metric-colored" data-metric-color="${altColor}">
                <span class="popup-metric-value">${formatNumber(altFtRounded)} ft</span>
                <span class="popup-metric-unit">(${formatNumber(altMRounded)} m)</span>
            </div>
        </div>
        <div class="kh-popup-block">
            <div class="popup-section-label">Groundspeed</div>
            <div class="popup-metric kh-popup-metric-colored" data-metric-color="${speedColor}">
                <span class="popup-metric-value">${formatNumber(speedKt)} kt</span>
                <span class="popup-metric-unit">(${formatNumber(speedKt * NAUTICAL_MILES_TO_KM)} km/h)</span>
            </div>
        </div>
    </div>`;
}

/** Colour the segment metrics below `root`; see generateSegmentPopupHtml() */
export function applyMetricColors(root: ParentNode): void {
  for (const el of root.querySelectorAll<HTMLElement>("[data-metric-color]")) {
    const color = el.dataset["metricColor"]!;
    el.style.setProperty("--kh-metric-color", color);
    el.style.setProperty("--kh-metric-bg", rgbToRgba(color, 0.15));
  }
}
