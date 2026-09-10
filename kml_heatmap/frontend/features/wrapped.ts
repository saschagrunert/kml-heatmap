/**
 * Wrapped/Year-in-Review functionality helpers
 * Generate year-end statistics and fun facts from flight data
 */

import { KM_TO_NAUTICAL_MILES } from "../utils/constants";
import { formatFlightTime, formatNumber } from "../utils/formatters";
import { escapeHtml } from "../utils/htmlGenerators";
import {
  aggregateAircraft,
  calculateTotalDistance,
  collectAirports,
  filterPaths,
  filterSegmentsByPaths,
  perPathSeconds,
} from "../calculations/statistics";
import { countCountries } from "./airports";
import { calculateDistance, type Coordinate } from "../utils/geometry";
import type { FunFact, PathInfo, PathSegment, YearStats } from "../types";

/**
 * Find the airport furthest from the home base. Airports without known
 * coordinates are skipped; ties keep the first airport in the list.
 *
 * @param homeBase - Name of the home base airport
 * @param airportNames - Airports to consider
 * @param coordinates - Airport name to [lat, lon]
 * @returns Name of the furthest airport, or null when it cannot be determined
 */
export function findFurthestAirport(
  homeBase: string | null,
  airportNames: string[],
  coordinates: Map<string, Coordinate>,
): string | null {
  if (!homeBase) return null;
  const home = coordinates.get(homeBase);
  if (!home) return null;

  let furthest: string | null = null;
  let maxDistanceKm = 0;
  for (const name of airportNames) {
    if (name === homeBase) continue;
    const coords = coordinates.get(name);
    if (!coords) continue;
    const distanceKm = calculateDistance(home, coords);
    if (distanceKm > maxDistanceKm) {
      maxDistanceKm = distanceKm;
      furthest = name;
    }
  }

  return furthest;
}

/**
 * Full statistics for enrichment
 */
interface FullStats {
  aircraft_list?: Array<{
    registration: string;
    model?: string | undefined;
  }>;
  total_altitude_gain_ft?: number | undefined;
  total_flight_time_seconds?: number | undefined;
  cruise_speed_knots?: number | undefined;
  longest_flight_nm?: number | undefined;
  longest_flight_km?: number | undefined;
  max_altitude_ft?: number | undefined;
  most_common_cruise_altitude_ft?: number | null | undefined;
  most_common_cruise_altitude_m?: number | null | undefined;
}

/**
 * Well-known city pairs used to put the longest flight into perspective.
 * Distances are approximate great-circle distances in nautical miles.
 */
export const REFERENCE_DISTANCES: ReadonlyArray<{
  nm: number;
  label: string;
}> = [
  { nm: 83, label: "Frankfurt to Stuttgart" },
  { nm: 138, label: "Hamburg to Berlin" },
  { nm: 185, label: "London to Paris" },
  { nm: 274, label: "Berlin to Munich" },
  { nm: 475, label: "Paris to Berlin" },
  { nm: 620, label: "New York to Chicago" },
  { nm: 776, label: "London to Rome" },
  { nm: 1250, label: "Lisbon to Berlin" },
  { nm: 2140, label: "New York to Los Angeles" },
  { nm: 3010, label: "London to New York" },
];

/** Only compare when the reference is reasonably close to the actual value */
const REFERENCE_TOLERANCE = 0.25;

/**
 * Find the reference distance closest to the given distance, or null when
 * no reference is within the tolerance.
 */
export function findClosestReferenceDistance(
  distanceNm: number,
): { nm: number; label: string } | null {
  if (!(distanceNm > 0)) return null;

  let closest: { nm: number; label: string } | null = null;
  let closestDiff = Infinity;
  for (const ref of REFERENCE_DISTANCES) {
    const diff = Math.abs(ref.nm - distanceNm);
    if (diff < closestDiff) {
      closest = ref;
      closestDiff = diff;
    }
  }

  if (!closest || closestDiff / distanceNm > REFERENCE_TOLERANCE) return null;
  return closest;
}

export function calculateYearStats(
  pathInfo: PathInfo[] | null,
  segments: PathSegment[],
  year: number | string,
  fullStats: FullStats | null = null,
  aircraft: string = "all",
  preFiltered?: { paths: PathInfo[]; segments: PathSegment[] },
): YearStats {
  const emptyResult: YearStats = {
    total_flights: 0,
    total_distance_nm: 0,
    num_airports: 0,
    airport_names: [],
    flight_time: "0h 0m",
    aircraft_list: [],
  };

  if (!pathInfo || pathInfo.length === 0) {
    return emptyResult;
  }

  const filteredPaths =
    preFiltered?.paths ?? filterPaths(pathInfo, String(year), aircraft);

  if (filteredPaths.length === 0) {
    return emptyResult;
  }

  const filteredSegments =
    preFiltered?.segments ?? filterSegmentsByPaths(segments, filteredPaths);

  // Collect airports
  const airports = collectAirports(filteredPaths);
  const airportNames = Array.from(airports);

  // Calculate total distance
  const totalDistanceKm = calculateTotalDistance(filteredSegments);
  const totalDistanceNm = totalDistanceKm * KM_TO_NAUTICAL_MILES;

  // One grouping pass feeds both the total flight time and the per-aircraft
  // times inside aggregateAircraft
  const secondsByPath = perPathSeconds(
    filteredSegments,
    new Set(filteredPaths.map((p) => p.id)),
  );
  let totalSeconds = 0;
  for (const secs of secondsByPath.values()) totalSeconds += secs;
  const flightTime = formatFlightTime(totalSeconds);

  const aircraftList = aggregateAircraft(
    filteredPaths,
    filteredSegments,
    secondsByPath,
  );

  // Enrich with model from fullStats
  if (fullStats?.aircraft_list) {
    const modelMap = new Map(
      fullStats.aircraft_list.map((a) => [a.registration, a.model]),
    );
    for (const ac of aircraftList) {
      const model = modelMap.get(ac.registration);
      if (model) ac.model = model;
    }
  }

  return {
    total_flights: filteredPaths.length,
    total_distance_nm: totalDistanceNm,
    num_airports: airports.size,
    airport_names: airportNames,
    flight_time: flightTime,
    aircraft_list: aircraftList,
  };
}

/**
 * Generate fun facts from year statistics
 */
export function generateFunFacts(
  yearStats: YearStats,
  fullStats: FullStats | null = null,
): FunFact[] {
  const facts: FunFact[] = [];

  // Distance facts
  const distanceNm = yearStats.total_distance_nm;
  const earthCircumferenceNm = 21639; // Nautical miles

  if (distanceNm > earthCircumferenceNm * 0.5) {
    const ratio = (distanceNm / earthCircumferenceNm).toFixed(1);
    facts.push({
      icon: "🌍",
      text: `You flew <strong>${ratio}x</strong> around the Earth!`,
      category: "distance",
      priority: 10,
    });
  } else if (distanceNm > 1000) {
    facts.push({
      icon: "✈️",
      text: `You covered <strong>${formatNumber(distanceNm, 1)} nautical miles</strong> this year!`,
      category: "distance",
      priority: 8,
    });
  }

  // Aircraft facts
  const numAircraft = yearStats.aircraft_list.length;
  if (numAircraft === 1) {
    const aircraft = yearStats.aircraft_list[0];
    const model = escapeHtml(
      aircraft?.model || aircraft?.type || aircraft?.registration || "Unknown",
    );
    const flights = yearStats.total_flights;
    const registration = aircraft?.registration
      ? escapeHtml(aircraft.registration)
      : "";
    if (registration) {
      facts.push({
        icon: "✈️",
        text: `Loyal to <strong>${registration}</strong> - all ${flights} flight${flights !== 1 ? "s" : ""} in this ${model}!`,
        category: "aircraft",
        priority: 9,
      });
    } else {
      facts.push({
        icon: "💙",
        text: `Loyal to one aircraft: ${model}`,
        category: "aircraft",
        priority: 7,
      });
    }
  } else if (numAircraft === 2) {
    facts.push({
      icon: "✈️",
      text: `You flew <strong>${numAircraft} different aircraft</strong> this year.`,
      category: "aircraft",
      priority: 7,
    });
  } else if (numAircraft >= 3) {
    facts.push({
      icon: "🛩️",
      text: `Aircraft explorer! You flew <strong>${numAircraft} different aircraft</strong>.`,
      category: "aircraft",
      priority: 8,
    });
  }

  // Country facts
  const numCountries = yearStats.airport_names
    ? countCountries(yearStats.airport_names).size
    : 0;
  if (numCountries >= 3) {
    facts.push({
      icon: "🌍",
      text: `You flew to airports in <strong>${numCountries} countries</strong>.`,
      category: "countries",
      priority: 9,
    });
  } else if (numCountries === 2) {
    facts.push({
      icon: "🌍",
      text: `You crossed borders, visiting <strong>2 countries</strong>.`,
      category: "countries",
      priority: 7,
    });
  }

  // Average distance per flight
  if (yearStats.total_flights > 0 && distanceNm > 0) {
    const avgDistanceNm = distanceNm / yearStats.total_flights;
    if (avgDistanceNm > 0) {
      // Only show cruise speed if timing data is available
      if (fullStats?.cruise_speed_knots) {
        facts.push({
          icon: "✈️",
          text: `Cruising at <strong>${formatNumber(fullStats.cruise_speed_knots)} kt</strong>, averaging <strong>${formatNumber(avgDistanceNm, 1)} nm</strong> per trip`,
          category: "distance",
          priority: 8,
        });
      } else {
        // Show distance-only fact when speed data unavailable
        facts.push({
          icon: "✈️",
          text: `Averaging <strong>${formatNumber(avgDistanceNm, 1)} nm</strong> per trip`,
          category: "distance",
          priority: 8,
        });
      }
    }
  }

  if (fullStats) {
    // Longest journey fact
    if (fullStats.longest_flight_nm && fullStats.longest_flight_nm > 0) {
      const longestNm = fullStats.longest_flight_nm;
      const reference = findClosestReferenceDistance(longestNm);
      const comparison = reference
        ? ` - about the distance from ${reference.label}!`
        : "";
      facts.push({
        icon: "🛫",
        text: `Your longest journey: <strong>${formatNumber(longestNm, 1)} nm</strong>${comparison}`,
        category: "distance",
        priority: 8,
      });
    }

    // Altitude facts
    if (fullStats.total_altitude_gain_ft) {
      const totalGainFt = fullStats.total_altitude_gain_ft;
      facts.push({
        icon: "⬆️",
        text: `Total elevation gain: <strong>${formatNumber(totalGainFt)} ft</strong>`,
        category: "altitude",
        priority: 8,
      });

      const everestFt = 29029;
      if (fullStats.total_altitude_gain_ft > everestFt) {
        const ratio = (fullStats.total_altitude_gain_ft / everestFt).toFixed(1);
        facts.push({
          icon: "🏔️",
          text: `You climbed <strong>${ratio}x</strong> Mount Everest in altitude!`,
          category: "altitude",
          priority: 9,
        });
      }
    }

    // Most common cruise altitude
    if (
      fullStats.most_common_cruise_altitude_ft &&
      fullStats.most_common_cruise_altitude_m
    ) {
      const cruiseAltFt = fullStats.most_common_cruise_altitude_ft;
      const cruiseAltM = fullStats.most_common_cruise_altitude_m;
      facts.push({
        icon: "⬆️",
        text: `Most common cruise: <strong>${formatNumber(cruiseAltFt)} ft</strong> AGL (<strong>${formatNumber(cruiseAltM)} m</strong>)`,
        category: "altitude",
        priority: 7,
      });
    }

    // Time facts (lower priority - time is shown in stats cards above)
    if (fullStats.total_flight_time_seconds) {
      const hours = Math.floor(fullStats.total_flight_time_seconds / 3600);
      facts.push({
        icon: "⏱️",
        text: `Total flight time: <strong>${hours} hours</strong> in the air!`,
        category: "time",
        priority: 4,
      });
    }

    // Speed facts (lower priority - speed is included in other facts)
    if (fullStats.cruise_speed_knots) {
      facts.push({
        icon: "⚡",
        text: `Average cruise speed: <strong>${formatNumber(fullStats.cruise_speed_knots)} knots</strong>`,
        category: "speed",
        priority: 3,
      });
    }

    // Achievement facts
    if (fullStats.max_altitude_ft && fullStats.max_altitude_ft > 40000) {
      facts.push({
        icon: "🚀",
        text: `High altitude achievement: <strong>${formatNumber(fullStats.max_altitude_ft)} feet</strong>!`,
        category: "achievement",
        priority: 9,
      });
    }
  }

  // Select diverse facts
  return selectDiverseFacts(facts);
}

/**
 * Select diverse facts with priority and category limits
 */
export function selectDiverseFacts(allFacts: FunFact[]): FunFact[] {
  if (allFacts.length === 0) {
    return [];
  }

  // Sort by priority descending
  const sortedFacts = [...allFacts].sort((a, b) => b.priority - a.priority);

  // Select facts with category limit
  const selected: FunFact[] = [];
  const categoryCount: Record<string, number> = {};
  const maxPerCategory = 3; // Allow up to 3 facts per category
  const minFacts = 4;
  const maxFacts = 6;

  for (const fact of sortedFacts) {
    const count = categoryCount[fact.category] || 0;
    if (count < maxPerCategory) {
      selected.push(fact);
      categoryCount[fact.category] = count + 1;
    }

    if (selected.length >= maxFacts) {
      break;
    }
  }

  // Ensure at least minFacts if available
  if (selected.length < minFacts && allFacts.length >= minFacts) {
    // Add more facts without category limit to reach minimum
    for (const fact of sortedFacts) {
      if (!selected.includes(fact)) {
        selected.push(fact);
        if (selected.length >= minFacts) {
          break;
        }
      }
    }
  }

  return selected;
}
