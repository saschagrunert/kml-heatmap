/**
 * Shared TypeScript type definitions for the KML Heatmap application
 */

import type { Coordinate } from "./utils/geometry";

/**
 * Path information from KML data.
 * Keys with null values are omitted by the exporter, so every optional field
 * is either absent or has a value (never null).
 */
export interface PathInfo {
  id: number;
  aircraft_registration?: string;
  aircraft_type?: string;
  year?: number;
  start_airport?: string;
  end_airport?: string;
  start_coords?: number[];
  end_coords?: number[];
  segment_count?: number;
  /** Exact altitude range; segment altitudes are rounded to 100 ft */
  min_altitude_ft?: number;
  max_altitude_ft?: number;
}

/**
 * Path segment (in-memory shape expanded by the DataLoader), representing a
 * line between two points with associated altitude, speed, and timing data.
 */
export interface PathSegment {
  path_id: number;
  coords?: [Coordinate, Coordinate];
  altitude_ft?: number;
  groundspeed_knots?: number;
  time?: number;
}

/**
 * Raw segment tuple as written by the exporter:
 * [lat1, lon1, lat2, lon2, altitude_ft, groundspeed_knots, time?]
 */
export type RawSegment =
  | [number, number, number, number, number, number]
  | [number, number, number, number, number, number, number];

/**
 * Per-year data file contents (window.KML_DATA_<YEAR>)
 */
export interface RawYearData {
  year: number;
  original_points: number;
  path_info: PathInfo[];
  segments: Record<string, RawSegment[]>;
}

/**
 * Aircraft aggregate data
 */
export interface AircraftAggregate {
  registration: string;
  type?: string;
  model?: string;
  flights: number;
  flight_time_seconds?: number;
  flight_time_str?: string;
  flight_distance_km?: number;
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
 * Comprehensive flight statistics.
 * Optional fields may be absent but are never null.
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
  cruise_speed_knots?: number;
  longest_flight_km?: number;
  longest_flight_nm?: number;
  total_flight_time_seconds?: number;
  total_flight_time_str?: string;
  most_common_cruise_altitude_ft?: number;
  most_common_cruise_altitude_m?: number;
}

/**
 * Airport information (airports.js)
 */
export interface Airport {
  name: string;
  lat: number;
  lon: number;
  country?: string;
  flight_count?: number;
}

/**
 * Metadata exported by the backend (metadata.js)
 */
export interface Metadata {
  stats: FilteredStatistics;
  min_alt_m: number;
  max_alt_m: number;
  min_groundspeed_knots: number;
  max_groundspeed_knots: number;
  available_years: number[];
  year_file_bytes?: Record<string, number>;
}

/**
 * In-memory KML dataset (one year or all years combined)
 */
export interface KMLDataset {
  coordinates: Coordinate[];
  path_segments: PathSegment[];
  path_info: PathInfo[];
  original_points: number;
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
  /** Schema version of selectedPathIds; see STATE_SCHEMA_VERSION */
  schemaVersion?: number;
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
  /**
   * Legacy control-visibility flag. The control chrome no longer hides, so
   * the value is parsed and then dropped; the slot stays in the URL string
   * to keep older shared links readable.
   */
  buttonsHidden?: boolean;
  isolateSelection?: boolean;
  center?: MapCenter;
  zoom?: number;
}

/**
 * Persisted state (localStorage / URL). All fields are optional because a
 * restored state may contain any subset of them.
 */
export type SavedState = AppState;

/**
 * Fun fact for wrapped/year-in-review feature
 */
export interface FunFact {
  category: string;
  icon: string;
  text: string;
  priority: number;
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
 * What is being loaded (for the loading indicator text)
 */
export interface LoadingInfo {
  /** Year being loaded or 'all' */
  year: string;
  /** Size of the file(s) in bytes when known from metadata.year_file_bytes */
  bytes?: number;
}

/**
 * DataLoader constructor options
 */
export interface DataLoaderOptions {
  dataDir?: string;
  scriptLoader?: (url: string) => Promise<void>;
  showLoading?: (info: LoadingInfo) => void;
  hideLoading?: () => void;
  getWindow?: () => Window & typeof globalThis;
  /**
   * Invoked once per top-level load when one or more year files failed to
   * load, with the list of failed years.
   */
  onLoadError?: (failedYears: string[]) => void;
}

/**
 * Global window extensions for data files
 */
declare global {
  interface Window {
    [key: `KML_DATA_${string}`]: RawYearData | undefined;
    KML_AIRPORTS?: {
      airports: Airport[];
    };
    KML_METADATA?: Metadata;
  }
}
