/**
 * Airport management functionality
 * Pure helpers for airport data, flight counting and visibility
 */

import * as L from "leaflet";
import type { PathInfo } from "../types";
import { filterPaths } from "../calculations/statistics";

/**
 * Build the divIcon for an airport marker
 * @param name - Airport name (ICAO code is extracted from it)
 * @param isHomeBase - Whether the airport is the current home base
 */
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

  return L.divIcon({
    html: markerHtml,
    iconSize: [12, 12],
    iconAnchor: [6, 6],
    popupAnchor: [0, -6],
    className: "",
  });
}

let _countryByAirport: Map<string, string> | null = null;

function getCountryByAirportMap(): Map<string, string> {
  if (_countryByAirport) return _countryByAirport;
  _countryByAirport = new Map();
  const kmlAirports = window.KML_AIRPORTS?.airports;
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

export function countryFlag(code: string): string {
  if (code.length !== 2) return "";
  const offset = 0x1f1e6 - 65;
  const first = code.charCodeAt(0);
  const second = code.charCodeAt(1);
  if (first < 65 || first > 90 || second < 65 || second > 90) return "";
  return String.fromCodePoint(first + offset, second + offset);
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
 * - no filter and no selection: every airport (returns null)
 * - year/aircraft filter: airports touched by matching paths
 * - selection: airports of the selected paths are added
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

  if (!hasFilters && !hasSelection) {
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
