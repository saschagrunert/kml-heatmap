/**
 * Shared TypeScript type definitions for the KML Heatmap application
 */

import type { Coordinate } from "./utils/geometry";

/**
 * Path information from KML data.
 * Keys with null values are omitted by the exporter, so every optional field
 * is either absent or has a value (never null). Where a path starts and ends
 * and how many segments it has come from its segments.
 */
export interface PathInfo {
  /**
   * Derived from the flight itself, so it survives a re-export: stable in
   * shared links, but neither dense, ordered nor small (up to 2^40)
   */
  id: number;
  aircraft_registration?: string;
  aircraft_type?: string;
  year?: number;
  start_airport?: string;
  end_airport?: string;
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
  coords?: [Coordinate, Coordinate] | undefined;
  altitude_ft?: number | undefined;
  groundspeed_knots?: number | undefined;
  time?: number | undefined;
  /** Great-circle length in km, memoised by `segmentDistance` on first use */
  distance_km?: number | undefined;
}

/**
 * Raw segment row as written by the exporter:
 * [lat, lon, altitude_ft, groundspeed_knots, time?].
 *
 * The coordinate is the segment's END point. Its start is the end of the
 * previous row, and the first row continues from `RawPathSegments.start`.
 */
export type RawSegment =
  [number, number, number, number] | [number, number, number, number, number];

/**
 * Exported segments of one path: the first point and the rows after it.
 */
export interface RawPathSegments {
  start: number[];
  rows: RawSegment[];
}

/**
 * Per-year data file contents (window.KML_DATA_<YEAR>)
 */
export interface RawYearData {
  year: number;
  original_points: number;
  path_info: PathInfo[];
  segments: Record<string, RawPathSegments>;
}

/**
 * Aircraft aggregate data
 */
export interface AircraftAggregate {
  registration: string;
  type?: string | undefined;
  model?: string | undefined;
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
  max_altitude_m?: number | undefined;
  min_altitude_m?: number | undefined;
  total_altitude_gain_m?: number | undefined;
  max_altitude_ft?: number | undefined;
  min_altitude_ft?: number | undefined;
  total_altitude_gain_ft?: number | undefined;
  max_groundspeed_knots?: number | undefined;
  avg_groundspeed_knots?: number | undefined;
  cruise_speed_knots?: number | undefined;
  longest_flight_km?: number | undefined;
  longest_flight_nm?: number | undefined;
  total_flight_time_seconds?: number | undefined;
  total_flight_time_str?: string | undefined;
  most_common_cruise_altitude_ft?: number | undefined;
  most_common_cruise_altitude_m?: number | undefined;
}

/**
 * Airport information (airports.js)
 */
export interface Airport {
  name: string;
  lat: number;
  lon: number;
  country?: string;
}

/** Full aircraft model names by registration, from aircraft.json */
export type AircraftModels = Readonly<Record<string, string>>;

/**
 * Metadata exported by the backend (metadata.js). The exporter writes every
 * field and none is ever null; the statistics are computed from the year
 * files instead.
 */
export interface Metadata {
  /** Lowest positive groundspeed; 0 without timing data */
  min_groundspeed_knots: number;
  /** Highest groundspeed; 0 without timing data */
  max_groundspeed_knots: number;
  available_years: number[];
  /** Size of each year file in bytes, by year */
  year_file_bytes: Record<string, number>;
  /** Only the registrations aircraft.json knows a model for */
  /**
   * Missing from exports made before it was added, which a browser can still
   * hold in its cache next to a newer bundle
   */
  aircraft_models?: AircraftModels;
}

/**
 * In-memory KML dataset (one year or all years combined)
 */
export interface KMLDataset {
  coordinates: Coordinate[];
  path_segments: PathSegment[];
  path_info: PathInfo[];
  original_points: number;
  /** Set on an "all years" dataset that is missing a year that failed to load */
  incomplete?: boolean;
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
  /**
   * Trusted markup, rendered as is. The generator escapes every value it
   * takes from the data (registrations, models) before building the text.
   */
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
  bytes?: number | undefined;
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
