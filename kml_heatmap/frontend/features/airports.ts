/**
 * Airport management functionality
 * Pure helpers for airport data, flight counting and visibility
 */

import * as L from "leaflet";
import type { Airport, PathInfo } from "../types";
import { filterPaths } from "../calculations/statistics";

/**
 * Build the divIcon for an airport marker
 * @param name - Airport name (ICAO code is extracted from it)
 * @param isHomeBase - Whether the airport is the current home base
 */
/** Side of the square a marker offers a pointer, in pixels */
const MARKER_TARGET_PX = 24;

export function createAirportIcon(
  name: string,
  isHomeBase: boolean,
): L.DivIcon {
  const icaoMatch = name ? name.match(/\b([A-Z]{4})\b/) : null;
  const icao = icaoMatch ? icaoMatch[1] : "APT";
  const homeClass = isHomeBase ? " airport-marker-home" : "";
  const homeLabelClass = isHomeBase ? " airport-label-home" : "";

  const markerHtml =
    '<div class="airport-marker-container"><div class="airport-marker' +
    homeClass +
    '"></div><div class="airport-label' +
    homeLabelClass +
    '">' +
    icao +
    "</div></div>";

  // 24px square around a dot a third that size: the dot is what is drawn,
  // the square is what a finger has to hit. WCAG asks for 24, and at these
  // zoom levels neighbouring airports are nowhere near far enough apart to
  // earn the spacing exemption.
  return L.divIcon({
    html: markerHtml,
    iconSize: [MARKER_TARGET_PX, MARKER_TARGET_PX],
    iconAnchor: [MARKER_TARGET_PX / 2, MARKER_TARGET_PX / 2],
    popupAnchor: [0, -MARKER_TARGET_PX / 2],
    className: "",
  });
}

let _countryByAirport: Map<string, string> | null = null;
/** The airport list the map was built from */
let _countrySource: readonly Airport[] | undefined;

/**
 * Country per airport name, from the airport list the page holds. The map
 * follows the list: airports.json may arrive after the first lookup (the
 * loader fetches it while the app starts), and a list loaded later replaces
 * an earlier one.
 */
function getCountryByAirportMap(): Map<string, string> {
  const kmlAirports = window.KML_AIRPORTS?.airports;
  if (_countryByAirport && kmlAirports === _countrySource) {
    return _countryByAirport;
  }
  _countryByAirport = new Map();
  _countrySource = kmlAirports;
  if (kmlAirports) {
    for (const a of kmlAirports) {
      if (a.country) _countryByAirport.set(a.name, a.country);
    }
  }
  return _countryByAirport;
}

const _displayNames =
  typeof Intl !== "undefined"
    ? new Intl.DisplayNames(["en"], { type: "region" })
    : null;

export function countryDisplayName(code: string): string {
  try {
    return _displayNames?.of(code) || code;
  } catch {
    return code;
  }
}

/**
 * Path to a country's flag, relative to the page, or null when this site
 * does not carry it.
 *
 * The export lists what it published: the flags are copied per site for the
 * countries actually visited, and a build without them (the wheel leaves
 * them out) lists none, which is the caller's cue to fall back to the code.
 */
export function countryFlagSrc(code: string): string | null {
  const available = window.KML_METADATA?.available_flags;
  const lower = code.toLowerCase();
  return available?.includes(lower) ? `flags/${lower}.svg` : null;
}

export function countCountries(airportNames: string[]): Set<string> {
  const countries = new Set<string>();
  const map = getCountryByAirportMap();

  for (const name of airportNames) {
    const country = map.get(name);
    if (country) countries.add(country);
  }
  return countries;
}

export function groupByCountry(airportNames: string[]): Map<string, string[]> {
  const map = getCountryByAirportMap();
  const groups = new Map<string, string[]>();

  for (const name of airportNames) {
    const key = map.get(name) || "Other";
    const list = groups.get(key);
    if (list) {
      list.push(name);
    } else {
      groups.set(key, [name]);
    }
  }

  return groups;
}

/**
 * Airport flight counts
 */
export interface AirportCounts {
  [airportName: string]: number;
}

/**
 * Calculate airport flight counts based on filtered paths
 * @param pathInfo - Array of path info objects
 * @param year - Year filter
 * @param aircraft - Aircraft filter
 * @returns Map of airport name to flight count
 */
export function calculateAirportFlightCounts(
  pathInfo: PathInfo[],
  year: string = "all",
  aircraft: string = "all",
): AirportCounts {
  const counts: AirportCounts = {};
  const filteredPaths = filterPaths(pathInfo, year, aircraft);

  // Count unique airports per flight (avoid double-counting round trips)
  for (const path of filteredPaths) {
    const uniqueAirports = new Set<string>();
    if (path.start_airport) {
      uniqueAirports.add(path.start_airport);
    }
    if (path.end_airport) {
      uniqueAirports.add(path.end_airport);
    }
    for (const airport of uniqueAirports) {
      counts[airport] = (counts[airport] || 0) + 1;
    }
  }

  return counts;
}

/**
 * Find the home base airport (most visited)
 * @param airportCounts - Map of airport name to count
 * @returns Home base airport name or null
 */
export function findHomeBase(airportCounts: AirportCounts): string | null {
  let homeBaseName: string | null = null;
  let maxCount = 0;

  for (const [name, count] of Object.entries(airportCounts)) {
    if (count > maxCount) {
      maxCount = count;
      homeBaseName = name;
    }
  }

  return homeBaseName;
}

/**
 * Determine which airports are visible for the current filter and selection.
 *
 * - no filter and no isolation: every airport (returns null)
 * - year/aircraft filter: airports touched by matching paths
 * - selection: airports of the selected paths are added, so a selection
 *   never hides an airport the filter shows (with or without a filter)
 * - isolate mode: only airports of the selected paths
 * @returns Set of visible airport names, or null when all are visible
 */
export function calculateVisibleAirports(options: {
  pathInfo: PathInfo[];
  selectedYear?: string;
  selectedAircraft?: string;
  selectedPathIds?: Set<number>;
  isolateSelection?: boolean;
  pathInfoById?: Map<number, PathInfo>;
}): Set<string> | null {
  const {
    pathInfo,
    selectedYear = "all",
    selectedAircraft = "all",
    selectedPathIds = new Set<number>(),
    isolateSelection = false,
  } = options;

  const hasFilters = selectedYear !== "all" || selectedAircraft !== "all";
  const hasSelection = selectedPathIds.size > 0;
  const hasIsolation = isolateSelection && hasSelection;

  if (!hasFilters && !hasIsolation) {
    return null;
  }

  const visible = new Set<string>();

  // Isolate mode ignores filter-only airports
  if (hasFilters && !hasIsolation) {
    for (const info of filterPaths(pathInfo, selectedYear, selectedAircraft)) {
      if (info.start_airport) visible.add(info.start_airport);
      if (info.end_airport) visible.add(info.end_airport);
    }
  }

  if (hasSelection) {
    const byId =
      options.pathInfoById ?? new Map(pathInfo.map((p) => [p.id, p]));
    selectedPathIds.forEach((pathId) => {
      const info = byId.get(pathId);
      if (!info) return;
      if (info.start_airport) visible.add(info.start_airport);
      if (info.end_airport) visible.add(info.end_airport);
    });
  }

  return visible;
}
