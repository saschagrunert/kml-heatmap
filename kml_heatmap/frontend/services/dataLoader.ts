/**
 * Data loading and caching service
 * Handles loading KML data files, airports, and metadata
 */

import { logDebug, logError } from "../utils/logger";
import type { Coordinate } from "../utils/geometry";
import type {
  KMLDataset,
  Airport,
  Metadata,
  DataLoaderOptions,
  LoadingInfo,
  PathSegment,
  RawYearData,
} from "../types";

/**
 * Validate year parameter to prevent path traversal attacks
 * @param year - Year string to validate
 * @returns true if valid
 */
export function isValidYear(year: string): boolean {
  // Must be 'all' or a 4-digit year between 2000-2099
  if (year === "all") return true;
  const yearNum = parseInt(year, 10);
  return /^\d{4}$/.test(year) && yearNum >= 2000 && yearNum <= 2099;
}

/**
 * Load JavaScript file dynamically (supports both file:// and https://)
 * @param url - URL to load
 * @returns Promise that resolves when script is loaded
 */
export function loadScript(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = url;
    script.onload = () => {
      script.remove();
      resolve();
    };
    script.onerror = () => {
      script.remove();
      reject(new Error("Failed to load script: " + url));
    };
    document.head.appendChild(script);
  });
}

/**
 * Generate global variable name for a per-year data file
 * @param year - Year string
 * @returns Global variable name (window.KML_DATA_<YEAR>)
 */
export function getGlobalVarName(year: string): string {
  return "KML_DATA_" + year;
}

/**
 * Expand the compact per-year file format into the in-memory dataset shape.
 *
 * The file stores segments as tuples keyed by path id:
 * `[lat1, lon1, lat2, lon2, altitude_ft, groundspeed_knots, time?]`.
 * Heatmap coordinates are derived as every segment's start point plus the
 * last segment's end point of each path. Arrays are preallocated and each
 * segment creates exactly one object.
 * @param raw - Contents of window.KML_DATA_<YEAR>
 * @returns Expanded dataset
 */
export function expandYearData(raw: RawYearData): KMLDataset {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Invalid year data: expected an object");
  }
  const segmentsByPath = raw.segments;
  if (typeof segmentsByPath !== "object" || segmentsByPath === null) {
    throw new Error("Invalid year data: missing 'segments' map");
  }

  // Integer-like object keys are iterated in ascending numeric order, so
  // segments end up sorted by path id and, within a path, in file order.
  const pathIds = Object.keys(segmentsByPath);

  let totalSegments = 0;
  let pathsWithSegments = 0;
  for (const id of pathIds) {
    const count = segmentsByPath[id]?.length ?? 0;
    totalSegments += count;
    if (count > 0) pathsWithSegments++;
  }

  const path_segments: PathSegment[] = new Array<PathSegment>(totalSegments);
  const coordinates: Coordinate[] = new Array<Coordinate>(
    totalSegments + pathsWithSegments,
  );

  let segmentIndex = 0;
  let coordinateIndex = 0;
  for (const id of pathIds) {
    const tuples = segmentsByPath[id];
    if (!tuples || tuples.length === 0) continue;
    const pathId = Number(id);

    for (let i = 0; i < tuples.length; i++) {
      const t = tuples[i]!;
      const start: Coordinate = [t[0], t[1]];
      const end: Coordinate = [t[2], t[3]];
      const segment: PathSegment = {
        path_id: pathId,
        coords: [start, end],
        altitude_ft: t[4],
        groundspeed_knots: t[5],
      };
      if (t.length > 6) {
        segment.time = t[6];
      }
      path_segments[segmentIndex++] = segment;
      coordinates[coordinateIndex++] = start;
    }

    const last = tuples[tuples.length - 1]!;
    coordinates[coordinateIndex++] = [last[2], last[3]];
  }

  return {
    coordinates,
    path_segments,
    path_info: Array.isArray(raw.path_info) ? raw.path_info : [],
    original_points:
      typeof raw.original_points === "number" ? raw.original_points : 0,
  };
}

/**
 * Combine multiple year datasets into one.
 * Path ids are globally unique across years, so this is a plain
 * concatenation: segment and path info objects are shared, not copied.
 * @param yearDatasets - Array of year datasets (null entries are skipped)
 * @returns Combined dataset
 */
export function combineYearData(
  yearDatasets: (KMLDataset | null | undefined)[],
): KMLDataset {
  let coordinateCount = 0;
  let segmentCount = 0;
  let pathInfoCount = 0;
  let originalPoints = 0;

  for (const data of yearDatasets) {
    if (!data) continue;
    coordinateCount += data.coordinates.length;
    segmentCount += data.path_segments.length;
    pathInfoCount += data.path_info.length;
    originalPoints += data.original_points || 0;
  }

  const combined: KMLDataset = {
    coordinates: new Array<Coordinate>(coordinateCount),
    path_segments: new Array<PathSegment>(segmentCount),
    path_info: new Array<KMLDataset["path_info"][number]>(pathInfoCount),
    original_points: originalPoints,
  };

  let ci = 0;
  let si = 0;
  let pi = 0;
  for (const data of yearDatasets) {
    if (!data) continue;
    const coords = data.coordinates;
    for (let i = 0; i < coords.length; i++) {
      combined.coordinates[ci++] = coords[i]!;
    }
    const segments = data.path_segments;
    for (let i = 0; i < segments.length; i++) {
      combined.path_segments[si++] = segments[i]!;
    }
    const infos = data.path_info;
    for (let i = 0; i < infos.length; i++) {
      combined.path_info[pi++] = infos[i]!;
    }
  }

  return combined;
}

/**
 * Data loader class with caching, in-flight request deduplication and a
 * reference-counted loading indicator.
 */
export class DataLoader {
  private dataDir: string;
  private cache: Map<string, KMLDataset>;
  private inflight: Map<string, Promise<KMLDataset | null>>;
  private loadingDepth: number;
  private scriptLoader: (url: string) => Promise<void>;
  private showLoading: (info: LoadingInfo) => void;
  private hideLoading: () => void;
  private getWindow: () => Window & typeof globalThis;
  private onLoadError: (failedYears: string[]) => void;

  constructor(options: DataLoaderOptions = {}) {
    this.dataDir = options.dataDir || "data";
    this.cache = new Map();
    this.inflight = new Map();
    this.loadingDepth = 0;
    this.scriptLoader = options.scriptLoader || loadScript;
    this.showLoading = options.showLoading || (() => {});
    this.hideLoading = options.hideLoading || (() => {});
    this.getWindow = options.getWindow || (() => window);
    this.onLoadError = options.onLoadError || (() => {});
  }

  /**
   * File size(s) from metadata.year_file_bytes when metadata is available
   */
  private knownBytes(year: string): number | undefined {
    const sizes = this.getWindow().KML_METADATA?.year_file_bytes;
    if (!sizes) return undefined;
    if (year !== "all") return sizes[year];
    let total = 0;
    for (const size of Object.values(sizes)) total += size;
    return total;
  }

  private beginLoading(year: string): void {
    if (this.loadingDepth === 0) {
      this.showLoading({ year, bytes: this.knownBytes(year) });
    }
    this.loadingDepth++;
  }

  private endLoading(): void {
    this.loadingDepth--;
    if (this.loadingDepth <= 0) {
      this.loadingDepth = 0;
      this.hideLoading();
    }
  }

  /**
   * Load data for a year or all years ('all')
   * @param year - Year string or 'all'
   * @returns Data object or null on error
   */
  async loadData(year: string = "all"): Promise<KMLDataset | null> {
    // Security: Validate input to prevent path traversal and arbitrary file loading
    if (!isValidYear(year)) {
      logError(`Invalid year parameter: ${year}`);
      return null;
    }

    if (year === "all") {
      return this.loadAndCombineAllYears();
    }

    const data = await this.getYear(year);
    if (!data) {
      this.onLoadError([year]);
    }
    return data;
  }

  /**
   * Cached and de-duplicated single-year load
   */
  private getYear(year: string): Promise<KMLDataset | null> {
    const cached = this.cache.get(year);
    if (cached) return Promise.resolve(cached);

    const pending = this.inflight.get(year);
    if (pending) return pending;

    const promise = this.loadYear(year).finally(() => {
      this.inflight.delete(year);
    });
    this.inflight.set(year, promise);
    return promise;
  }

  private async loadYear(year: string): Promise<KMLDataset | null> {
    this.beginLoading(year);
    try {
      const globalVarName = getGlobalVarName(year);
      const globals = this.getWindow() as unknown as Record<string, unknown>;

      if (!globals[globalVarName]) {
        logDebug("Loading data (" + year + ")...");
        await this.scriptLoader(this.dataDir + "/" + year + "/data.js");
      }

      const raw = globals[globalVarName] as RawYearData | undefined;
      if (!raw) {
        throw new Error("Global " + globalVarName + " was not defined");
      }

      const data = expandYearData(raw);
      // Drop the raw global so the data is not held twice in memory
      delete globals[globalVarName];

      this.cache.set(year, data);
      logDebug(
        "✓ Loaded data (" + year + "):",
        data.original_points + " points",
      );
      return data;
    } catch (error) {
      logError("Error loading data for year " + year + ":", error);
      return null;
    } finally {
      this.endLoading();
    }
  }

  /**
   * Load and combine data from all available years.
   * Years that fail to load are reported through onLoadError; the remaining
   * years are still combined. Returns null only when nothing could be loaded.
   * @returns Combined data object or null on error
   */
  loadAndCombineAllYears(): Promise<KMLDataset | null> {
    const cached = this.cache.get("all");
    if (cached) return Promise.resolve(cached);

    const pending = this.inflight.get("all");
    if (pending) return pending;

    const promise = this.loadAllYears().finally(() => {
      this.inflight.delete("all");
    });
    this.inflight.set("all", promise);
    return promise;
  }

  private async loadAllYears(): Promise<KMLDataset | null> {
    this.beginLoading("all");
    try {
      const metadata = await this.loadMetadata();
      if (!metadata || !metadata.available_years) {
        logError("No metadata or available years found");
        return null;
      }

      const years = metadata.available_years.map((y) => String(y));
      logDebug("Loading all years:", years);

      // Load all year files in parallel (deduplicated per year)
      const yearDatasets = await Promise.all(
        years.map((year) => this.getYear(year)),
      );

      const failedYears = years.filter((_, i) => !yearDatasets[i]);
      if (failedYears.length > 0) {
        this.onLoadError(failedYears);
      }
      if (years.length > 0 && failedYears.length === years.length) {
        return null;
      }

      const combined = combineYearData(yearDatasets);
      // Caching a partial combination would make the gap permanent for the
      // rest of the session; retry the missing years on the next call
      if (failedYears.length === 0) {
        this.cache.set("all", combined);
      }
      logDebug("Combined all years:", combined.original_points + " points");
      return combined;
    } catch (error) {
      logError("Error loading and combining all years:", error);
      return null;
    } finally {
      this.endLoading();
    }
  }

  /**
   * Load airports data
   * @returns Array of airport objects
   */
  async loadAirports(): Promise<Airport[]> {
    try {
      const win = this.getWindow();
      if (!win.KML_AIRPORTS) {
        await this.scriptLoader(this.dataDir + "/airports.js");
      }
      return win.KML_AIRPORTS?.airports || [];
    } catch (error) {
      logError("Error loading airports:", error);
      return [];
    }
  }

  /**
   * Load metadata
   * @returns Metadata object or null on error
   */
  async loadMetadata(): Promise<Metadata | null> {
    try {
      const win = this.getWindow();
      if (!win.KML_METADATA) {
        await this.scriptLoader(this.dataDir + "/metadata.js");
      }
      return win.KML_METADATA || null;
    } catch (error) {
      logError("Error loading metadata:", error);
      return null;
    }
  }

  /**
   * Clear all cached data
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Check if data is cached
   * @param year - Year string or 'all'
   * @returns True if cached
   */
  isCached(year: string): boolean {
    return this.cache.has(year);
  }
}
