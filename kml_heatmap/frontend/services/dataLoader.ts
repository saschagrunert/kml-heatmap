/**
 * Data loading and caching service
 * Handles loading KML data files, airports, and metadata
 */

import { logDebug, logError } from "../utils/logger";
import type {
  KMLDataset,
  Airport,
  Metadata,
  DataLoaderOptions,
} from "../types";

// Valid resolutions for data loading (security: whitelist)
const VALID_RESOLUTIONS = ["data"] as const;

/**
 * Validate year parameter to prevent path traversal attacks
 * @param year - Year string to validate
 * @returns true if valid
 */
function isValidYear(year: string): boolean {
  // Must be 'all' or a 4-digit year between 2000-2099
  if (year === "all") return true;
  const yearNum = parseInt(year, 10);
  return /^\d{4}$/.test(year) && yearNum >= 2000 && yearNum <= 2099;
}

/**
 * Validate resolution parameter to prevent arbitrary file loading
 * @param resolution - Resolution string to validate
 * @returns true if valid
 */
function isValidResolution(resolution: string): boolean {
  return VALID_RESOLUTIONS.includes(
    resolution as (typeof VALID_RESOLUTIONS)[number]
  );
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
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load script: " + url));
    document.head.appendChild(script);
  });
}

/**
 * Combine multiple year datasets into one
 * @param yearDatasets - Array of year data objects
 * @param resolution - Resolution identifier
 * @returns Combined dataset
 */
export function combineYearData(
  yearDatasets: (KMLDataset | null)[],
  resolution: string
): KMLDataset {
  const combined: KMLDataset = {
    coordinates: [],
    path_segments: [],
    path_info: [],
    resolution: resolution,
    original_points: 0,
  };

  yearDatasets.forEach((data) => {
    if (!data) return;
    // Use concat instead of spread operator to avoid stack overflow with large arrays
    if (data.coordinates) {
      combined.coordinates = combined.coordinates.concat(data.coordinates);
    }
    if (data.path_segments) {
      combined.path_segments = combined.path_segments.concat(
        data.path_segments
      );
    }
    if (data.path_info) {
      combined.path_info = combined.path_info.concat(data.path_info);
    }
    combined.original_points += data.original_points || 0;
  });

  return combined;
}

/**
 * Generate global variable name for data file
 * @param year - Year string
 * @param resolution - Resolution identifier
 * @returns Global variable name
 */
export function getGlobalVarName(year: string, resolution: string): string {
  return "KML_DATA_" + year + "_" + resolution.toUpperCase().replace(/-/g, "_");
}

/**
 * Generate cache key for data
 * @param resolution - Resolution identifier
 * @param year - Year string
 * @returns Cache key
 */
export function getCacheKey(resolution: string, year: string): string {
  return resolution + "_" + year;
}

/**
 * Data loader class with caching
 */
export class DataLoader {
  private dataDir: string;
  private cache: Record<string, KMLDataset>;
  private scriptLoader: (url: string) => Promise<void>;
  private showLoading: () => void;
  private hideLoading: () => void;
  private getWindow: () => Window & typeof globalThis;

  constructor(options: DataLoaderOptions = {}) {
    this.dataDir = options.dataDir || "data";
    this.cache = {};
    this.scriptLoader = options.scriptLoader || loadScript;
    this.showLoading = options.showLoading || (() => {});
    this.hideLoading = options.hideLoading || (() => {});
    this.getWindow = options.getWindow || (() => window);
  }

  /**
   * Load data for a specific resolution and year
   * @param resolution - Resolution identifier (always 'data')
   * @param year - Year string or 'all'
   * @returns Data object or null on error
   */
  async loadData(
    resolution: string,
    year: string = "all"
  ): Promise<KMLDataset | null> {
    // Security: Validate inputs to prevent path traversal and arbitrary file loading
    if (!isValidYear(year)) {
      logError(`Invalid year parameter: ${year}`);
      return null;
    }
    if (!isValidResolution(resolution)) {
      logError(`Invalid resolution parameter: ${resolution}`);
      return null;
    }

    const cacheKey = getCacheKey(resolution, year);

    // Check cache
    if (this.cache[cacheKey]) {
      return this.cache[cacheKey];
    }

    // Handle 'all' years by combining
    if (year === "all") {
      return await this.loadAndCombineAllYears(resolution);
    }

    this.showLoading();
    try {
      const globalVarName = getGlobalVarName(year, resolution);
      const win = this.getWindow();

      if (!win[globalVarName as keyof Window]) {
        logDebug("Loading " + resolution + " (" + year + ")...");
        const filename = this.dataDir + "/" + year + "/" + resolution + ".js";
        await this.scriptLoader(filename);
      }

      const data = win[globalVarName as keyof Window] as KMLDataset;
      this.cache[cacheKey] = data;
      logDebug(
        "✓ Loaded " + resolution + " (" + year + "):",
        data.original_points + " points"
      );
      return data;
    } catch (error) {
      logError("Error loading data for year " + year + ":", error);
      return null;
    } finally {
      this.hideLoading();
    }
  }

  /**
   * Load and combine data from all available years
   * @param resolution - Resolution identifier
   * @returns Combined data object or null on error
   */
  async loadAndCombineAllYears(resolution: string): Promise<KMLDataset | null> {
    const cacheKey = getCacheKey(resolution, "all");

    // Check cache
    if (this.cache[cacheKey]) {
      return this.cache[cacheKey];
    }

    this.showLoading();
    try {
      // Get available years from metadata
      const metadata = await this.loadMetadata();
      if (!metadata || !metadata.available_years) {
        logError("No metadata or available years found");
        return null;
      }

      logDebug(
        "Loading all years for " + resolution + ":",
        metadata.available_years
      );

      // Load all year files in parallel
      const promises = metadata.available_years.map((year) =>
        this.loadData(resolution, year.toString())
      );
      const yearDatasets = await Promise.all(promises);

      // Combine datasets
      const combined = combineYearData(yearDatasets, resolution);

      this.cache[cacheKey] = combined;
      logDebug(
        "Combined all years for " + resolution + ":",
        combined.original_points + " points"
      );
      return combined;
    } catch (error) {
      logError("Error loading and combining all years:", error);
      return null;
    } finally {
      this.hideLoading();
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
    this.cache = {};
  }

  /**
   * Check if data is cached
   * @param resolution - Resolution identifier
   * @param year - Year string
   * @returns True if cached
   */
  isCached(resolution: string, year: string): boolean {
    const cacheKey = getCacheKey(resolution, year);
    return cacheKey in this.cache;
  }
}
