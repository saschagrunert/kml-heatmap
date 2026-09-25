/**
 * HTML generation utilities for UI components
 * Pure functions that generate HTML strings
 *
 * Two spellings, split on purpose: a self-contained block of markup is a
 * template literal so the tags stay indented and readable, and markup
 * assembled a piece at a time from conditionals and loops is concatenated,
 * where a literal would need a `${}` around every fragment.
 */
import type { Range } from "../state/store";
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
 * `pluralize(2, "flight")` is "2 flights", and `pluralize(44143, "point")`
 * is "44,143 points", grouped like every other figure of the page.
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
  return formatNumber(count) + " " + (count === 1 ? singular : plural);
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
 * two can be typeset differently. The code is the airport's own, which the
 * export writes (see airportCode in features/airports.ts) rather than one
 * guessed from the label here. A label that does not lead with it, or is
 * nothing else, keeps its full text as the name.
 */
export function splitAirportName(label: string, code?: string): AirportLabel {
  const trimmed = label.trim();
  if (code && trimmed.startsWith(code + " ")) {
    const name = trimmed.slice(code.length + 1).trim();
    if (name) return { code, name };
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
        <div class="popup-header kh-popup-header-airport${params.isHomeBase ? " kh-popup-header-home" : ""}">
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
  /** The colour ranges the segment is coloured on, as on the map */
  altRange: Range;
  speedRange: Range;
  title?: string;
  icon?: IconName;
}

/**
 * Generate path segment popup HTML with position, altitude, and groundspeed.
 * The data-driven altitude/speed colours travel as `data-metric-color`; the
 * CSP allows no style attribute, so applyMetricColors() carries them into
 * the custom properties `.kh-popup-metric-colored` reads. A segment without
 * a speed (0, a log without timing) shows none rather than 0 kt.
 */
export function generateSegmentPopupHtml(params: SegmentPopupParams): string {
  const { segment } = params;
  const title = params.title || "Segment Data";
  const headerIcon = params.icon ?? "airport";

  const altFt = segment.altitude_ft;
  const altFtRounded = Math.round(altFt / 50) * 50;
  const altMRounded = altFtRounded * FEET_TO_METERS;
  const alt = params.altRange;
  const altColor = getColorForAltitude(altFt, alt.min, alt.max, alt.ranks);

  const [startCoord, endCoord] = segment.coords;
  const shown = params.position ?? endCoord;
  const lat = ddToDms(shown[0], true);
  const lon = ddToDms(shown[1], false);
  const trackStr = formatTrack(
    calculateBearing(startCoord[0], startCoord[1], endCoord[0], endCoord[1]),
  );

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
        </div>${speedBlock(params)}
    </div>`;
}

/** The groundspeed of a segment popup, empty for a segment without one */
function speedBlock(params: SegmentPopupParams): string {
  const speedKt = params.segment.groundspeed_knots;
  if (!(speedKt > 0)) return "";
  const speedColor = getColorForAirspeed(
    speedKt,
    params.speedRange.min,
    params.speedRange.max,
    params.speedRange.ranks,
  );
  return `
        <div class="kh-popup-block">
            <div class="popup-section-label">Groundspeed</div>
            <div class="popup-metric kh-popup-metric-colored" data-metric-color="${speedColor}">
                <span class="popup-metric-value">${formatNumber(speedKt)} kt</span>
                <span class="popup-metric-unit">(${formatNumber(speedKt * NAUTICAL_MILES_TO_KM)} km/h)</span>
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
