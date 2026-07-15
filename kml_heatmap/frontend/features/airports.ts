/**
 * Airport management functionality
 * Handles airport data, popups, markers, and flight counting
 */

import type { PathInfo } from "../types";

/**
 * Airport flight counts
 */
export interface AirportCounts {
  [airportName: string]: number;
}

/**
 * Airport visibility state
 */
export interface AirportVisibility {
  show: boolean;
  opacity: number;
}

/**
 * Path to airports mapping
 */
export interface PathToAirports {
  [pathId: number]: {
    start?: string;
    end?: string;
  };
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
  aircraft: string = "all"
): AirportCounts {
  if (!pathInfo) return {};

  const counts: AirportCounts = {};
  const filteredPaths = pathInfo.filter(function (path) {
    // Apply year filter
    if (year !== "all") {
      if (!path.year || path.year.toString() !== year) {
        return false;
      }
    }

    // Apply aircraft filter
    if (aircraft !== "all") {
      if (
        !path.aircraft_registration ||
        path.aircraft_registration !== aircraft
      ) {
        return false;
      }
    }

    return true;
  });

  // Count unique airports per flight (avoid double-counting round trips)
  filteredPaths.forEach(function (path) {
    const uniqueAirports = new Set<string>();
    if (path.start_airport) {
      uniqueAirports.add(path.start_airport);
    }
    if (path.end_airport) {
      uniqueAirports.add(path.end_airport);
    }
    // Increment count for each unique airport in this flight
    uniqueAirports.forEach(function (airport) {
      counts[airport] = (counts[airport] || 0) + 1;
    });
  });

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

  Object.keys(airportCounts).forEach(function (name) {
    if (airportCounts[name]! > maxCount) {
      maxCount = airportCounts[name]!;
      homeBaseName = name;
    }
  });

  return homeBaseName;
}

/**
 * Calculate airport marker opacity based on flight count
 * @param flightCount - Number of flights
 * @param maxCount - Maximum flight count across all airports
 * @returns Opacity value between 0.3 and 1.0
 */
export function calculateAirportOpacity(
  flightCount: number,
  maxCount: number
): number {
  if (maxCount === 0) return 1.0;

  // Scale opacity from 0.3 (minimum) to 1.0 (maximum)
  const minOpacity = 0.3;
  const maxOpacity = 1.0;
  const normalized = flightCount / maxCount;

  return minOpacity + normalized * (maxOpacity - minOpacity);
}

/**
 * Calculate airport marker size based on flight count
 * @param flightCount - Number of flights
 * @param maxCount - Maximum flight count across all airports
 * @param options - Size options
 * @returns Marker radius
 */
export function calculateAirportMarkerSize(
  flightCount: number,
  maxCount: number,
  options: { minSize?: number; maxSize?: number } = {}
): number {
  const minSize = options.minSize || 3;
  const maxSize = options.maxSize || 8;

  if (maxCount === 0) return minSize;

  const normalized = flightCount / maxCount;
  return minSize + normalized * (maxSize - minSize);
}

/**
 * Determine if airports should be shown/hidden based on filters and selection
 * @param options - Options object
 * @returns Visibility state for each airport
 */
export function calculateAirportVisibility(options: {
  airportCounts: AirportCounts;
  selectedYear?: string;
  selectedAircraft?: string;
  selectedPathIds?: Set<number>;
  pathToAirports?: PathToAirports;
}): Record<string, AirportVisibility> {
  const {
    airportCounts,
    selectedYear = "all",
    selectedAircraft = "all",
    selectedPathIds = new Set(),
    pathToAirports = {},
  } = options;

  const hasFilters = selectedYear !== "all" || selectedAircraft !== "all";
  const hasSelection = selectedPathIds.size > 0;

  // Get airports from selected paths
  const selectedAirports = new Set<string>();
  if (hasSelection) {
    selectedPathIds.forEach((pathId) => {
      const airports = pathToAirports[pathId];
      if (airports) {
        if (airports.start) selectedAirports.add(airports.start);
        if (airports.end) selectedAirports.add(airports.end);
      }
    });
  }

  const visibility: Record<string, AirportVisibility> = {};

  Object.keys(airportCounts).forEach((airportName) => {
    const flightCount = airportCounts[airportName] || 0;

    if (hasSelection) {
      // During selection: show selected airports at full opacity, dim others
      visibility[airportName] = {
        show: true,
        opacity: selectedAirports.has(airportName) ? 1.0 : 0.2,
      };
    } else if (hasFilters) {
      // With filters active: show only airports matching filter
      visibility[airportName] = {
        show: flightCount > 0,
        opacity: 1.0,
      };
    } else {
      // No filters or selection: show all airports
      visibility[airportName] = {
        show: true,
        opacity: 1.0,
      };
    }
  });

  return visibility;
}
