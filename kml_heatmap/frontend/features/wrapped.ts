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
import type {
  AircraftModels,
  FilteredStatistics,
  FunFact,
  PathInfo,
  PathSegment,
  YearStats,
} from "../types";

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

/** The statistics of the selected year and aircraft the fun facts draw on */
type FunFactStats = Pick<
  FilteredStatistics,
  | "total_altitude_gain_ft"
  | "total_flight_time_seconds"
  | "cruise_speed_knots"
  | "longest_flight_nm"
  | "max_altitude_ft"
  | "most_common_cruise_altitude_ft"
  | "most_common_cruise_altitude_m"
>;

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
  aircraftModels: AircraftModels = {},
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

  // The full model name only comes from aircraft.json. An own-key lookup, so
  // a registration can never read something off the object prototype
  for (const ac of aircraftList) {
    const model = Object.hasOwn(aircraftModels, ac.registration)
      ? aircraftModels[ac.registration]
      : undefined;
    if (model) ac.model = model;
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
 * The span of the latitudes and longitudes the segments touch, as Leaflet
 * bounds, or null when none of them has coordinates.
 */
export function segmentBounds(
  segments: PathSegment[],
): [Coordinate, Coordinate] | null {
  let minLat = Infinity;
  let minLon = Infinity;
  let maxLat = -Infinity;
  let maxLon = -Infinity;
  for (const segment of segments) {
    for (const [lat, lon] of segment.coords ?? []) {
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
    }
  }
  if (minLat === Infinity) return null;
  return [
    [minLat, minLon],
    [maxLat, maxLon],
  ];
}

/**
 * The period a fact talks about: the selected year, or all of them. "This
 * year" read wrong in the All Years view and for any year but the current.
 */
function periodPhrase(year: string): string {
  return year === "all" ? "in total" : "in " + escapeHtml(year);
}

/**
 * Generate fun facts from year statistics
 * @param yearStats - The Wrapped summary of the selected year and aircraft
 * @param filteredStats - The statistics of the same selection
 * @param year - The selected year, or "all"
 */
export function generateFunFacts(
  yearStats: YearStats,
  filteredStats: FunFactStats | null = null,
  year: string = "all",
): FunFact[] {
  const facts: FunFact[] = [];
  const period = periodPhrase(year);

  // Distance facts
  const distanceNm = yearStats.total_distance_nm;
  const earthCircumferenceNm = 21639; // Nautical miles

  if (distanceNm > earthCircumferenceNm * 0.5) {
    const ratio = (distanceNm / earthCircumferenceNm).toFixed(1);
    facts.push({
      icon: "earth",
      text: `You flew <strong>${ratio}x</strong> around the Earth!`,
      category: "distance",
      priority: 10,
    });
  } else if (distanceNm > 1000) {
    facts.push({
      icon: "distance",
      text: `You covered <strong>${formatNumber(distanceNm, 1)} nautical miles</strong> ${period}!`,
      category: "distance",
      priority: 8,
    });
  }

  // Aircraft facts
  const numAircraft = yearStats.aircraft_list.length;
  const [onlyAircraft] = yearStats.aircraft_list;
  if (numAircraft === 1 && onlyAircraft) {
    // The list only has registered aircraft; flights without a registration
    // (some exports carry none) count in the year total but not here
    const model = escapeHtml(
      onlyAircraft.model || onlyAircraft.type || onlyAircraft.registration,
    );
    const registration = escapeHtml(onlyAircraft.registration);
    const flights = onlyAircraft.flights;
    const plural = flights !== 1 ? "s" : "";
    if (flights === yearStats.total_flights) {
      facts.push({
        icon: "aircraft",
        text: `Loyal to <strong>${registration}</strong>, all ${flights} flight${plural} in this ${model}!`,
        category: "aircraft",
        priority: 9,
      });
    } else {
      facts.push({
        icon: "aircraft",
        text: `<strong>${registration}</strong> took you on ${flights} flight${plural} in this ${model}.`,
        category: "aircraft",
        priority: 7,
      });
    }
  } else if (numAircraft === 2) {
    facts.push({
      icon: "aircraft",
      text: `You flew <strong>${numAircraft} different aircraft</strong> ${period}.`,
      category: "aircraft",
      priority: 7,
    });
  } else if (numAircraft >= 3) {
    facts.push({
      icon: "aircraft",
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
      icon: "globe",
      text: `You flew to airports in <strong>${numCountries} countries</strong>.`,
      category: "countries",
      priority: 9,
    });
  } else if (numCountries === 2) {
    facts.push({
      icon: "globe",
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
      if (filteredStats?.cruise_speed_knots) {
        facts.push({
          icon: "speed",
          text: `Cruising at <strong>${formatNumber(filteredStats.cruise_speed_knots)} kt</strong>, averaging <strong>${formatNumber(avgDistanceNm, 1)} nm</strong> per trip.`,
          category: "distance",
          priority: 8,
        });
      } else {
        // Show distance-only fact when speed data unavailable
        facts.push({
          icon: "ruler",
          text: `Averaging <strong>${formatNumber(avgDistanceNm, 1)} nm</strong> per trip.`,
          category: "distance",
          priority: 8,
        });
      }
    }
  }

  if (filteredStats) {
    // Longest journey fact
    if (
      filteredStats.longest_flight_nm &&
      filteredStats.longest_flight_nm > 0
    ) {
      const longestNm = filteredStats.longest_flight_nm;
      const reference = findClosestReferenceDistance(longestNm);
      const comparison = reference
        ? `, about the distance from ${reference.label}`
        : "";
      facts.push({
        icon: "milestone",
        text: `Your longest journey: <strong>${formatNumber(longestNm, 1)} nm</strong>${comparison}.`,
        category: "distance",
        priority: 8,
      });
    }

    // Altitude facts
    if (filteredStats.total_altitude_gain_ft) {
      const totalGainFt = filteredStats.total_altitude_gain_ft;
      facts.push({
        icon: "climb",
        text: `Total elevation gain: <strong>${formatNumber(totalGainFt)} ft</strong>.`,
        category: "altitude",
        priority: 8,
      });

      const everestFt = 29029;
      if (filteredStats.total_altitude_gain_ft > everestFt) {
        const ratio = (
          filteredStats.total_altitude_gain_ft / everestFt
        ).toFixed(1);
        facts.push({
          icon: "altitude",
          text: `You climbed <strong>${ratio}x</strong> Mount Everest in altitude!`,
          category: "altitude",
          priority: 9,
        });
      }
    }

    // Most common cruise altitude
    if (
      filteredStats.most_common_cruise_altitude_ft &&
      filteredStats.most_common_cruise_altitude_m
    ) {
      const cruiseAltFt = filteredStats.most_common_cruise_altitude_ft;
      const cruiseAltM = filteredStats.most_common_cruise_altitude_m;
      facts.push({
        icon: "ruler",
        text: `Most common cruise: <strong>${formatNumber(cruiseAltFt)} ft</strong> AGL (<strong>${formatNumber(cruiseAltM)} m</strong>).`,
        category: "altitude",
        priority: 7,
      });
    }

    // Time facts (lower priority - time is shown in stats cards above)
    if (filteredStats.total_flight_time_seconds) {
      const seconds = filteredStats.total_flight_time_seconds;
      // Under an hour, whole hours would read "0 hours in the air"
      const duration =
        seconds >= 3600
          ? `${formatNumber(Math.floor(seconds / 3600))} hours`
          : formatFlightTime(seconds);
      facts.push({
        icon: "clock",
        text: `Total flight time: <strong>${duration}</strong> in the air!`,
        category: "time",
        priority: 4,
      });
    }

    // Speed facts (lower priority - speed is included in other facts)
    if (filteredStats.cruise_speed_knots) {
      facts.push({
        icon: "speed",
        text: `Average cruise speed: <strong>${formatNumber(filteredStats.cruise_speed_knots)} knots</strong>.`,
        category: "speed",
        priority: 3,
      });
    }

    // Achievement facts
    if (
      filteredStats.max_altitude_ft &&
      filteredStats.max_altitude_ft > 40000
    ) {
      facts.push({
        icon: "trophy",
        text: `High altitude achievement: <strong>${formatNumber(filteredStats.max_altitude_ft)} feet</strong>!`,
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
