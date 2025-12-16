/**
 * Statistics calculation service
 */

import type { Statistics, PathInfo, PathSegment } from "../types";
import { UNIT_CONVERSIONS } from "../constants";
import { matchesFilters, hasNoActiveFilters } from "../utils/filters";

export class StatisticsCalculator {
  /**
   * Calculate filtered statistics based on year, aircraft, or path selection
   */
  calculateFilteredStats(
    fullStats: Statistics,
    fullPathInfo: PathInfo[],
    fullPathSegments: PathSegment[],
    filters: {
      year?: string;
      aircraft?: string;
      selectedPathIds?: Set<string>;
    },
  ): Statistics {
    // If no filters, return full stats
    if (hasNoActiveFilters(filters)) {
      return fullStats;
    }

    // Filter path info using shared filter logic
    const filteredPathInfo = fullPathInfo.filter((path) =>
      matchesFilters(path, filters),
    );

    // Calculate totals from filtered paths
    let totalDistance = 0;
    let totalFlightTime = 0;
    const visitedAirports = new Set<string>();

    filteredPathInfo.forEach((path) => {
      if (path.distance_km) {
        totalDistance += path.distance_km;
      }
      if (path.duration_seconds) {
        totalFlightTime += path.duration_seconds;
      }
      if (path.start_airport) {
        visitedAirports.add(path.start_airport);
      }
      if (path.end_airport) {
        visitedAirports.add(path.end_airport);
      }
    });

    // Get altitude range from filtered segments
    const filteredPathIds = new Set(filteredPathInfo.map((p) => p.id));
    const filteredSegments = fullPathSegments.filter((seg) =>
      filteredPathIds.has(seg.path_id),
    );

    let minAltitude = Infinity;
    let maxAltitude = -Infinity;

    filteredSegments.forEach((seg) => {
      if (seg.altitude) {
        const [alt1, alt2] = seg.altitude;
        minAltitude = Math.min(minAltitude, alt1, alt2);
        maxAltitude = Math.max(maxAltitude, alt1, alt2);
      }
    });

    // Convert to feet
    const minAltitudeFt =
      minAltitude !== Infinity
        ? minAltitude * UNIT_CONVERSIONS.METERS_TO_FEET
        : 0;
    const maxAltitudeFt =
      maxAltitude !== -Infinity
        ? maxAltitude * UNIT_CONVERSIONS.METERS_TO_FEET
        : 0;

    return {
      total_distance_km: totalDistance,
      total_distance_nm: totalDistance * UNIT_CONVERSIONS.KM_TO_NAUTICAL_MILES,
      min_altitude_ft: minAltitudeFt,
      max_altitude_ft: maxAltitudeFt,
      airports_visited: visitedAirports.size,
      total_flight_time_seconds: totalFlightTime,
      paths: filteredPathInfo,
    };
  }

  /**
   * Get visible airports based on filters and selection
   */
  getVisibleAirports(
    fullPathInfo: PathInfo[],
    filters: {
      year?: string;
      aircraft?: string;
      selectedPathIds?: Set<string>;
    },
  ): Set<string> {
    const visibleAirports = new Set<string>();

    fullPathInfo.forEach((path) => {
      if (matchesFilters(path, filters)) {
        if (path.start_airport) visibleAirports.add(path.start_airport);
        if (path.end_airport) visibleAirports.add(path.end_airport);
      }
    });

    return visibleAirports;
  }

  /**
   * Calculate year-based statistics
   */
  calculateYearStats(
    pathInfo: PathInfo[],
  ): Map<
    number,
    { distance: number; time: number; airports: Set<string>; paths: number }
  > {
    const yearStats = new Map<
      number,
      { distance: number; time: number; airports: Set<string>; paths: number }
    >();

    pathInfo.forEach((path) => {
      if (!path.year) return;

      if (!yearStats.has(path.year)) {
        yearStats.set(path.year, {
          distance: 0,
          time: 0,
          airports: new Set(),
          paths: 0,
        });
      }

      const stats = yearStats.get(path.year)!;
      stats.distance += path.distance_km || 0;
      stats.time += path.duration_seconds || 0;
      stats.paths++;

      if (path.start_airport) stats.airports.add(path.start_airport);
      if (path.end_airport) stats.airports.add(path.end_airport);
    });

    return yearStats;
  }

  /**
   * Get unique years from path info
   */
  getUniqueYears(pathInfo: PathInfo[]): number[] {
    const years = new Set<number>();
    pathInfo.forEach((path) => {
      if (path.year) years.add(path.year);
    });
    return Array.from(years).sort((a, b) => b - a);
  }

  /**
   * Get unique aircraft from path info
   */
  getUniqueAircraft(pathInfo: PathInfo[]): string[] {
    const aircraft = new Set<string>();
    pathInfo.forEach((path) => {
      if (path.aircraft_registration) {
        aircraft.add(path.aircraft_registration);
      }
    });
    return Array.from(aircraft).sort();
  }
}
