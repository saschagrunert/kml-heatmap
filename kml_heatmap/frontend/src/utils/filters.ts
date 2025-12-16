/**
 * Filter utility functions
 */

import type { PathInfo } from "../types";

export interface FilterCriteria {
  year?: string;
  aircraft?: string;
  selectedPathIds?: Set<string>;
}

/**
 * Check if a path matches the given filter criteria
 */
export function matchesFilters(
  pathInfo: PathInfo,
  filters: FilterCriteria,
): boolean {
  const { year, aircraft, selectedPathIds } = filters;

  const matchesYear =
    !year ||
    year === "all" ||
    (!!pathInfo.year && pathInfo.year.toString() === year);

  const matchesAircraft =
    !aircraft ||
    aircraft === "all" ||
    pathInfo.aircraft_registration === aircraft;

  const matchesSelection =
    !selectedPathIds ||
    selectedPathIds.size === 0 ||
    selectedPathIds.has(pathInfo.id);

  return matchesYear && matchesAircraft && matchesSelection;
}

/**
 * Check if no filters are active
 */
export function hasNoActiveFilters(filters: FilterCriteria): boolean {
  const { year, aircraft, selectedPathIds } = filters;

  return (
    (!year || year === "all") &&
    (!aircraft || aircraft === "all") &&
    (!selectedPathIds || selectedPathIds.size === 0)
  );
}
