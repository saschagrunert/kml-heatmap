/**
 * Shared TypeScript type definitions for the KML Heatmap application
 */

import type { Coordinate } from "./utils/geometry";

/**
 * Path information from KML data
 */
export interface PathInfo {
  id: number;
  aircraft?: string;
  aircraft_registration?: string;
  aircraft_type?: string;
  year?: number;
  start_time?: number;
  end_time?: number;
  start_airport?: string;
  end_airport?: string;
  distance?: number;
}

/**
 * Path segment with altitude and speed data
 */
export interface PathSegment {
  path_id: number;
  coords?: [Coordinate, Coordinate];
  coordinates?: Coordinate;
  altitude?: number;
  altitude_m?: number;
  altitude_ft?: number;
  speed?: number;
  groundspeed_knots?: number;
  time?: number;
  timestamp?: number;
}

/**
 * Aircraft aggregate data
 */
export interface AircraftAggregate {
  registration: string;
  type?: string;
  model?: string;
  flights: number;
  flight_time_str?: string;
}

/**
 * Altitude statistics
 */
export interface AltitudeStats {
  min: number;
  max: number;
  gain: number;
}

/**
 * Speed statistics
 */
export interface SpeedStats {
  max: number;
  avg: number;
}

/**
 * Comprehensive flight statistics
 */
export interface FilteredStatistics {
  total_points: number;
  num_paths: number;
  num_airports: number;
  airport_names: string[];
  num_aircraft: number;
  aircraft_list: AircraftAggregate[];
  total_distance_km: number;
  total_distance_nm: number;
  max_altitude_m?: number;
  min_altitude_m?: number;
  total_altitude_gain_m?: number;
  max_altitude_ft?: number;
  min_altitude_ft?: number;
  total_altitude_gain_ft?: number;
  max_groundspeed_knots?: number;
  avg_groundspeed_knots?: number;
  average_groundspeed_knots?: number; // Alias for avg_groundspeed_knots
  cruise_speed_knots?: number;
  longest_flight_km?: number;
  longest_flight_nm?: number;
  total_flight_time_seconds?: number;
  total_flight_time_str?: string;
  most_common_cruise_altitude_ft?: number;
  most_common_cruise_altitude_m?: number;
}

/**
 * Airport information
 */
export interface Airport {
  icao: string;
  name: string;
  lat: number;
  lon: number;
  elevation?: number;
  type?: string;
}

/**
 * Metadata about available data
 */
export interface Metadata {
  available_years: number[];
  available_aircraft: string[];
  total_paths: number;
  total_points: number;
}

/**
 * KML dataset loaded from file
 */
export interface KMLDataset {
  coordinates: Coordinate[];
  path_segments: PathSegment[];
  path_info: PathInfo[];
  resolution: string;
  original_points: number;
}

/**
 * Flight statistics
 */
export interface FlightStats {
  totalDistance: number;
  totalTime: number;
  maxAltitude: number;
  maxSpeed: number;
  avgAltitude: number;
  avgSpeed: number;
  numFlights: number;
}

/**
 * Airport flight counts
 */
export interface AirportFlightCounts {
  [icao: string]: {
    departures: number;
    arrivals: number;
    total: number;
  };
}

/**
 * Map center coordinates
 */
export interface MapCenter {
  lat: number;
  lng: number;
}

/**
 * Application state (used for URL encoding and state management)
 */
export interface AppState {
  selectedYear?: string;
  selectedAircraft?: string;
  selectedPathIds?: number[];
  heatmapVisible?: boolean;
  altitudeVisible?: boolean;
  airspeedVisible?: boolean;
  airportsVisible?: boolean;
  aviationVisible?: boolean;
  statsPanelVisible?: boolean;
  wrappedVisible?: boolean;
  buttonsHidden?: boolean;
  center?: MapCenter;
  zoom?: number;
}

/**
 * Fun fact for wrapped/year-in-review feature
 */
export interface FunFact {
  category: string;
  icon: string;
  text: string;
}

/**
 * Year statistics for wrapped feature
 */
export interface YearStats {
  total_flights: number;
  num_airports: number;
  total_distance_nm: number;
  flight_time: string;
  airport_names: string[];
  aircraft_list: AircraftAggregate[];
}

/**
 * DataLoader constructor options
 */
export interface DataLoaderOptions {
  dataDir?: string;
  scriptLoader?: (url: string) => Promise<void>;
  showLoading?: () => void;
  hideLoading?: () => void;
  getWindow?: () => Window & typeof globalThis;
}

/**
 * Global window extensions for data files
 */
declare global {
  interface Window {
    [key: `KML_DATA_${string}`]: KMLDataset;
    KML_AIRPORTS?: {
      airports: Airport[];
    };
    KML_METADATA?: Metadata;
  }
}
