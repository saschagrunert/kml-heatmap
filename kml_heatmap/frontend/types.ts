/**
 * Shared TypeScript type definitions for the KML Heatmap application
 */

import type { Coordinate } from "./utils/geometry";
import type { IconName } from "./utils/icons";

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
 * Encoded columns of one path, as written by the exporter
 * (kml_heatmap/segment_codec.py): latitude, longitude, altitude in hundreds
 * of feet and groundspeed in tenths of a knot, then the relative time in
 * tenths of a second when any row has one (null for a row without). Each
 * entry is the difference to the row before, as a scaled integer.
 *
 * Row i is the segment that ENDS at the i-th coordinate. Its start is the
 * end of the row before, and the first row continues from
 * `RawPathSegments.start`.
 */
export type RawColumns =
  | [number[], number[], number[], number[]]
  | [number[], number[], number[], number[], (number | null)[]];

/**
 * Exported segments of one path: the scaled first point and the columns of
 * the rows after it.
 */
export interface RawPathSegments {
  start: number[];
  columns: RawColumns;
}

/**
 * Per-year data file contents (<year>/data.json)
 */
export interface RawYearData {
  /** Wire format of the rows, DATA_FORMAT_VERSION in services/dataLoader.ts */
  format: number;
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
 * Airport information (airports.json)
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
 * Metadata exported by the backend (metadata.json). The exporter writes every
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
  /**
   * ISO codes of the countries this site carries a flag for. A site built
   * without the flag files (a pip install, which leaves them out) publishes
   * none, and the country code is shown instead. Missing from older exports.
   */
  available_flags?: string[];
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
interface MapCenter {
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
  /** The diversity bucket, and the icon when the fact names none */
  category: string;
  /**
   * The mark drawn beside the text. Several facts share a category (three
   * of them are about distance), so the category alone would draw the same
   * icon three times in one card.
   */
  icon?: IconName;
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
  fetchJson?: (url: string) => Promise<unknown>;
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
 * Where the data loader publishes airports.json and metadata.json
 */
declare global {
  interface Window {
    KML_AIRPORTS?: {
      airports: Airport[];
    };
    KML_METADATA?: Metadata;
  }
}
