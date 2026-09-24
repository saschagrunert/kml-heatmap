/**
 * HTML of the Wrapped dialog. Only the lazily loaded Wrapped bundle uses
 * these generators, so they live apart from utils/htmlGenerators, which the
 * main bundle carries and shares.
 */
import type { FilteredStatistics, FunFact, YearStats } from "../types";
import { METERS_TO_FEET } from "./constants";
import { formatNumber } from "./formatters";
import {
  escapeHtml,
  markFlightTimeUnits,
  pluralFlights,
  splitAirportName,
  type AirportCount,
} from "./htmlGenerators";
import { icon, type IconName } from "./icons";

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

/**
 * One tile of the Wrapped stat grid. The unit is a separate element so it can
 * be typeset smaller than the display figure it belongs to.
 *
 * No space between the two in the markup: `.stat-unit` opens the gap with a
 * margin instead, one hairline of `--unit-gap` rather than a word space. The
 * h and m that markFlightTimeUnits marks up carry the same class and so get
 * the same gap, which is the point: "5,118.2 nm" beside "51h 38m" was two
 * treatments of the same thing.
 */
function statCard(value: string, unit: string, label: string): string {
  const unitHtml = unit
    ? '<span class="stat-unit">' + escapeHtml(unit) + "</span>"
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
  filteredStats: FilteredStatistics | null,
  hasTimingData: boolean,
): string {
  const maxAltitudeM = filteredStats?.max_altitude_m;

  return (
    statCard(formatNumber(yearStats.total_flights), "", "Flights") +
    statCard(formatNumber(yearStats.num_airports), "", "Airports") +
    // One decimal, like the statistics panel: the same figure reading 4746
    // here and 4745.5 there only makes the reader wonder which one is right
    statCard(formatNumber(yearStats.total_distance_nm, 1), "nm", "Distance") +
    (hasTimingData
      ? flightTimeCard(yearStats.flight_time) +
        statCard(
          formatNumber(filteredStats?.max_groundspeed_knots || 0),
          "kt",
          "Max Groundspeed",
        )
      : "") +
    // Like the timing cards: no data, no card, rather than a figure of 0 ft
    (maxAltitudeM === undefined
      ? ""
      : statCard(
          formatNumber(maxAltitudeM * METERS_TO_FEET),
          "ft",
          "Max Altitude (MSL)",
        ))
  );
}

/**
 * Generate fun facts HTML. The fact text is trusted markup (see FunFact);
 * only the category, which ends up in an attribute, is escaped here.
 */
/**
 * Icon for a fact that names none of its own. The facts used to carry an
 * emoji each, which put a second icon family (and a platform-dependent one)
 * inside a dialog that is otherwise drawn from `utils/icons`.
 */
const FACT_ICONS: Record<string, IconName> = {
  distance: "distance",
  aircraft: "aircraft",
  countries: "globe",
  altitude: "altitude",
  time: "clock",
  speed: "speed",
  achievement: "trophy",
};

export function generateFunFactsHtml(funFacts: FunFact[]): string {
  let html = wrappedSectionTitle("fun-facts-title", "wrapped", "Facts");
  for (const fact of funFacts) {
    const factIcon = fact.icon ?? FACT_ICONS[fact.category] ?? "wrapped";
    html += `<div class="fun-fact" data-category="${escapeHtml(fact.category)}"><span class="fun-fact-icon">${icon(factIcon, 20)}</span><span class="fun-fact-text">${fact.text}</span></div>`;
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

export interface DestinationsOptions {
  /** Resolve a country code to its display name */
  countryName: (code: string) => string;
  /** Resolve a country code to its flag, or null when the site has none */
  flagSrc: (code: string) => string | null;
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

  const { countryName, flagSrc, homeBase, furthest } = options;
  let html = wrappedSectionTitle(
    "airports-grid-title",
    "airport",
    "Destinations",
  );

  for (const [code, airports] of grouped) {
    const isCountry = code !== "Other";
    const label = isCountry ? countryName(code) : "Other";
    const flag = isCountry ? flagSrc(code) : null;
    // A flag where the site carries one, the ISO code where it does not.
    // Never an emoji flag: Windows ships no glyphs for them.
    const codeHtml = !isCountry
      ? ""
      : flag
        ? '<img class="country-flag" src="' +
          escapeHtml(flag) +
          '" alt="' +
          escapeHtml(code) +
          '" width="18" height="14" loading="lazy">'
        : '<span class="country-code" aria-hidden="true">' +
          escapeHtml(code) +
          "</span>";
    html +=
      '<div class="country-group">' +
      '<div class="country-group-title">' +
      codeHtml +
      '<span class="country-name">' +
      escapeHtml(label) +
      "</span>" +
      '<span class="country-count">' +
      airports.length +
      "</span>" +
      "</div>" +
      '<ul class="country-airports">';
    for (const name of airports) {
      const isHome = !!homeBase && name === homeBase;
      const isFurthest = !isHome && !!furthest && name === furthest;
      html += destinationRow(name, isHome, isFurthest);
    }
    html += "</ul></div>";
  }

  return html;
}
