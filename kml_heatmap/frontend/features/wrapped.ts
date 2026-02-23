/**
 * Wrapped/Year-in-Review functionality helpers
 * Generate year-end statistics and fun facts from flight data
 */

import { calculateDistance } from "../utils/geometry";
import { formatFlightTime } from "../utils/formatters";
import {
  calculateFlightTime,
  collectAirports,
  filterSegmentsByPaths,
} from "../calculations/statistics";
import type { PathInfo, PathSegment } from "../types";

/**
 * Year statistics for wrapped feature
 */
interface YearStats {
  total_flights: number;
  total_distance_nm: number;
  num_airports: number;
  airport_names: string[];
  flight_time: string;
  aircraft_list: AircraftStats[];
}

/**
 * Aircraft statistics with flight time
 */
interface AircraftStats {
  registration: string;
  type?: string;
  model?: string;
  flights: number;
  flight_time_seconds?: number;
  flight_time_str?: string;
}

/**
 * Fun fact for wrapped feature
 */
interface FunFact {
  icon: string;
  text: string;
  category: string;
  priority: number;
}

/**
 * Full statistics for enrichment
 */
interface FullStats {
  aircraft_list?: Array<{
    registration: string;
    model?: string;
  }>;
  total_altitude_gain_ft?: number;
  total_flight_time_seconds?: number;
  cruise_speed_knots?: number;
  longest_flight_nm?: number;
  longest_flight_km?: number;
  max_altitude_ft?: number;
  most_common_cruise_altitude_ft?: number;
  most_common_cruise_altitude_m?: number;
}

/**
 * Home base information
 */
interface HomeBase {
  name: string;
  flight_count: number;
}

/**
 * Calculate year statistics from path info and segments
 */
export function calculateYearStats(
  pathInfo: PathInfo[] | null,
  segments: PathSegment[],
  year: number | string,
  fullStats: FullStats | null = null
): YearStats {
  // Handle null or empty pathInfo
  if (!pathInfo || pathInfo.length === 0) {
    return {
      total_flights: 0,
      total_distance_nm: 0,
      num_airports: 0,
      airport_names: [],
      flight_time: "0h 0m",
      aircraft_list: [],
    };
  }

  // Filter paths by year
  // Convert year to number for comparison since path.year is a number
  const yearNum = year === "all" ? "all" : Number(year);
  const filteredPaths =
    yearNum === "all"
      ? pathInfo
      : pathInfo.filter((path) => path.year === yearNum);

  // Handle no matching paths
  if (filteredPaths.length === 0) {
    return {
      total_flights: 0,
      total_distance_nm: 0,
      num_airports: 0,
      airport_names: [],
      flight_time: "0h 0m",
      aircraft_list: [],
    };
  }

  // Collect airports
  const airports = collectAirports(filteredPaths);
  const airportNames = Array.from(airports);

  // Filter segments
  const filteredSegments = filterSegmentsByPaths(segments, filteredPaths);

  // Calculate total distance
  let totalDistanceKm = 0;
  filteredSegments.forEach((segment) => {
    if (segment.coords && segment.coords.length === 2) {
      const distance = calculateDistance(segment.coords[0], segment.coords[1]);
      totalDistanceKm += distance;
    }
  });
  const totalDistanceNm = totalDistanceKm * 0.539957;

  // Calculate flight time
  const totalSeconds = calculateFlightTime(filteredSegments, filteredPaths);
  const flightTime = formatFlightTime(totalSeconds);

  // Aggregate aircraft data
  const aircraftMap: Record<string, AircraftStats> = {};
  filteredPaths.forEach((path) => {
    if (path.aircraft_registration) {
      const reg = path.aircraft_registration;
      if (!aircraftMap[reg]) {
        aircraftMap[reg] = {
          registration: reg,
          type: path.aircraft_type,
          flights: 0,
          flight_time_seconds: 0,
        };
      }
      aircraftMap[reg].flights += 1;
    }
  });

  // Calculate flight time per aircraft
  Object.keys(aircraftMap).forEach((reg) => {
    const aircraftPaths = filteredPaths.filter(
      (p) => p.aircraft_registration === reg
    );
    const aircraftSegments = filterSegmentsByPaths(segments, aircraftPaths);
    const aircraftSeconds = calculateFlightTime(
      aircraftSegments,
      aircraftPaths
    );
    const aircraft = aircraftMap[reg];
    if (aircraft) {
      aircraft.flight_time_seconds = aircraftSeconds;
      aircraft.flight_time_str = formatFlightTime(aircraftSeconds);
    }
  });

  // Enrich with model from fullStats
  if (fullStats && fullStats.aircraft_list) {
    fullStats.aircraft_list.forEach((fullAircraft) => {
      const aircraft = aircraftMap[fullAircraft.registration];
      if (aircraft) {
        aircraft.model = fullAircraft.model;
      }
    });
  }

  // Sort aircraft by flight count descending
  const aircraftList = Object.values(aircraftMap).sort(
    (a, b) => b.flights - a.flights
  );

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
  fullStats: FullStats | null = null
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
      text: `You covered <strong>${Math.round(distanceNm)} nautical miles</strong> this year!`,
      category: "distance",
      priority: 8,
    });
  }

  // Aircraft facts
  const numAircraft = yearStats.aircraft_list.length;
  if (numAircraft === 1) {
    const aircraft = yearStats.aircraft_list[0];
    const model =
      aircraft?.model || aircraft?.type || aircraft?.registration || "Unknown";
    const flights = yearStats.total_flights;
    const registration = aircraft?.registration || "";
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

  // Average distance per flight
  if (yearStats.total_flights > 0 && distanceNm > 0) {
    const avgDistanceNm = Math.round(distanceNm / yearStats.total_flights);
    if (avgDistanceNm > 0) {
      // Only show cruise speed if timing data is available
      if (fullStats?.cruise_speed_knots) {
        facts.push({
          icon: "✈️",
          text: `Cruising at <strong>${Math.round(fullStats.cruise_speed_knots)} kt</strong>, averaging <strong>${avgDistanceNm} nm</strong> per adventure`,
          category: "distance",
          priority: 8,
        });
      } else {
        // Show distance-only fact when speed data unavailable
        facts.push({
          icon: "✈️",
          text: `Averaging <strong>${avgDistanceNm} nm</strong> per adventure`,
          category: "distance",
          priority: 8,
        });
      }
    }
  }

  if (fullStats) {
    // Longest journey fact
    if (fullStats.longest_flight_nm && fullStats.longest_flight_nm > 0) {
      const longestNm = Math.round(fullStats.longest_flight_nm);
      facts.push({
        icon: "🛫",
        text: `Your longest journey: <strong>${longestNm} nm</strong> - that's Berlin to Munich distance!`,
        category: "distance",
        priority: 8,
      });
    }

    // Altitude facts
    if (fullStats.total_altitude_gain_ft) {
      const totalGainFt = Math.round(fullStats.total_altitude_gain_ft);
      facts.push({
        icon: "⬆️",
        text: `Total elevation gain: <strong>${totalGainFt} ft</strong>`,
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
      const cruiseAltFt = Math.round(fullStats.most_common_cruise_altitude_ft);
      const cruiseAltM = Math.round(fullStats.most_common_cruise_altitude_m);
      facts.push({
        icon: "⬆️",
        text: `Most common cruise: <strong>${cruiseAltFt} ft</strong> AGL (<strong>${cruiseAltM} m</strong>)`,
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
        text: `Average cruise speed: <strong>${Math.round(fullStats.cruise_speed_knots)} knots</strong>`,
        category: "speed",
        priority: 3,
      });
    }

    // Achievement facts
    if (fullStats.max_altitude_ft && fullStats.max_altitude_ft > 40000) {
      facts.push({
        icon: "🚀",
        text: `High altitude achievement: <strong>${Math.round(fullStats.max_altitude_ft)} feet</strong>!`,
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

/**
 * Calculate aircraft color class for visualization
 */
export function calculateAircraftColorClass(
  flights: number,
  maxFlights: number,
  minFlights: number
): string {
  // Handle edge case where all aircraft have same flight count
  if (maxFlights === minFlights) {
    return "fleet-aircraft-high";
  }

  // Normalize to 0-1 range
  const normalized = (flights - minFlights) / (maxFlights - minFlights);

  // Classify into quartiles
  if (normalized >= 0.75) {
    return "fleet-aircraft-high";
  } else if (normalized >= 0.5) {
    return "fleet-aircraft-medium-high";
  } else if (normalized >= 0.25) {
    return "fleet-aircraft-medium-low";
  } else {
    return "fleet-aircraft-low";
  }
}

/**
 * Find home base (most visited airport)
 */
export function findHomeBase(
  airportNames: string[] | null,
  airportCounts: Record<string, number>
): HomeBase | null {
  if (!airportNames || airportNames.length === 0) {
    return null;
  }

  let maxCount = 0;
  let homeBaseName = "";

  airportNames.forEach((name) => {
    const count = airportCounts[name] || 0;
    if (count > maxCount) {
      maxCount = count;
      homeBaseName = name;
    }
  });

  if (!homeBaseName) {
    return null;
  }

  return {
    name: homeBaseName,
    flight_count: maxCount,
  };
}

/**
 * Get destinations excluding home base
 */
export function getDestinations(
  airportNames: string[] | null,
  homeBaseName: string | null
): string[] {
  if (!airportNames) {
    return [];
  }

  if (!homeBaseName) {
    return airportNames;
  }

  return airportNames.filter((name) => name !== homeBaseName);
}
