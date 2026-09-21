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
  // Must be 'all' or a four-digit year. The shape is what keeps the value out
  // of the path; which years actually exist is metadata.available_years, so no
  // numeric range is imposed here.
  if (year === "all") return true;
  return /^\d{4}$/.test(year);
}

/**
 * How long a data file may take to load. The largest year file is a few MB,
 * so this leaves room for a slow connection; a request that neither loads
 * nor errors within it (a stalled connection) is aborted, so the year can be
 * requested again instead of staying in flight forever.
 */
const LOAD_TIMEOUT_MS = 120_000;

/**
 * Fetch and parse a JSON file of the site
 * @param url - URL to load
 * @param timeoutMs - Time after which the request is aborted
 * @returns The parsed contents
 */
export async function fetchJson(
  url: string,
  timeoutMs: number = LOAD_TIMEOUT_MS,
): Promise<unknown> {
  const controller = new AbortController();
  // The timer spans the body as well: a response whose headers arrived can
  // still stall halfway through a year file
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    const reason = controller.signal.aborted
      ? "Timed out loading"
      : "Failed to load";
    throw new Error(`${reason} ${url}`, { cause: error });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The request per stylesheet URL, so that callers share one rather than
 * racing. Keyed on the URL as given; a failed one is dropped so the next
 * attempt starts over.
 */
const stylesheetRequests = new Map<string, Promise<void>>();

/**
 * Load a stylesheet, and leave it in the document.
 *
 * A link keeps applying only as long as it is in the head, so this one is
 * not removed once it has loaded. Callers asking for the same
 * URL share one request: dedupe on the link already being in the head was
 * wrong twice over, because a link that is still in flight had not applied
 * yet, and because the attempt that appended it removes it on its own
 * failure. A first attempt that had already been given up on could take the
 * stylesheet of a later, successful one back out of the page with it.
 *
 * @param url - URL to load
 * @param timeoutMs - Time after which the load is given up on
 * @returns Promise that resolves once the stylesheet applies
 */
export function loadStylesheet(
  url: string,
  timeoutMs: number = LOAD_TIMEOUT_MS,
): Promise<void> {
  const inFlight = stylesheetRequests.get(url);
  if (inFlight) return inFlight;

  const request = new Promise<void>((resolve, reject) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = url;
    // Tests and debugging match on this rather than on href, which the
    // browser resolves to an absolute URL
    link.dataset["href"] = url;
    const settle = (): void => {
      clearTimeout(timer);
      link.onload = null;
      link.onerror = null;
    };
    const giveUp = (reason: string): void => {
      settle();
      link.remove();
      reject(new Error(reason + ": " + url));
    };
    link.onload = () => {
      settle();
      resolve();
    };
    link.onerror = () => giveUp("Failed to load stylesheet");
    const timer = setTimeout(
      () => giveUp("Timed out loading stylesheet"),
      timeoutMs,
    );
    document.head.appendChild(link);
  });

  stylesheetRequests.set(url, request);
  // A failure is not cached, so the next attempt tries again; the rejection
  // is handled by the caller, and this handler must not become one itself
  request.catch(() => stylesheetRequests.delete(url));
  return request;
}

/** Forget every stylesheet request (used by tests) */
export function resetStylesheetLoader(): void {
  stylesheetRequests.clear();
}

/**
 * Wire format of the year files this build reads (kml_heatmap/segment_codec.py).
 * A file written by another release is refused rather than misread.
 */
export const DATA_FORMAT_VERSION = 3;

/**
 * How the encoded columns become values again, the mirror of
 * segment_codec.py. Every value the exporter writes is rounded to a fixed
 * step, so the columns hold exact integers counted in that step.
 */
const COORDINATE_SCALE = 1e5;
const ALTITUDE_STEP = 100;
const SPEED_SCALE = 10;
const TIME_SCALE = 10;

/**
 * Expand the compact per-year file format into the in-memory dataset shape.
 *
 * Each path stores a start point and, column by column, the rows of
 * `[lat, lon, altitude_ft, groundspeed_knots, time?]`, where the coordinate
 * is the row's END point: consecutive rows are contiguous, so the start of a
 * row is the end of the one before it. Heatmap coordinates are every
 * segment's start point plus the last end point of each path, and
 * neighbouring segments share the very same coordinate array: each segment
 * creates exactly one object.
 *
 * Every column holds integers scaled to the step the exporter rounded to,
 * stored as differences to the row before (the start point seeds the two
 * coordinate columns). A path without a time column carries no relative
 * times, and a null in it marks a row without one; the running time then
 * stays where the last row that had one left it.
 *
 * A value that is not a finite number would turn into a NaN coordinate,
 * which the map cannot draw. Since every value is a difference, nothing after
 * it can be trusted either, so the path is cut short there with a warning
 * instead, and left out when that is its first row.
 * @param raw - Contents of <year>/data.json
 * @returns Expanded dataset
 */
export function expandYearData(raw: RawYearData): KMLDataset {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Invalid year data: expected an object");
  }
  if (raw.format !== DATA_FORMAT_VERSION) {
    throw new Error(
      `Invalid year data: format ${String(raw.format)}, expected ` +
        `${DATA_FORMAT_VERSION}; the data was written by another release`,
    );
  }
  const segmentsByPath = raw.segments;
  if (typeof segmentsByPath !== "object" || segmentsByPath === null) {
    throw new Error("Invalid year data: missing 'segments' map");
  }

  // Paths in path_info order, which is the order of the input. The keys of
  // the segments object are no substitute: ids are content hashes, and
  // JavaScript iterates the ones below 2^32 in numeric order first.
  const pathInfo = Array.isArray(raw.path_info) ? raw.path_info : [];
  // A Set keeps a path listed twice from being expanded twice
  const listed = new Set(pathInfo.map((info) => String(info.id)));
  for (const id of Object.keys(segmentsByPath)) listed.add(id);
  const pathIds = [...listed];

  // Filled with push: arrays preallocated with new Array(n) have holes
  // until they are full, which V8 keeps treating as the slower kind
  const path_segments: PathSegment[] = [];
  const coordinates: Coordinate[] = [];

  for (const id of pathIds) {
    const entry = segmentsByPath[id];
    // A listed path without segments is legal, and has nothing to draw
    if (!entry) continue;
    // Columns that are missing altogether read as one row that is not
    // numeric, so the path is reported like any other broken one
    const [lats = [NaN], lons, altitudes, speeds, times] = Array.isArray(
      entry.columns,
    )
      ? entry.columns
      : [];
    const pathId = Number(id);

    // Running totals of the encoded columns; the coordinates start at the
    // path's start point, the rest at zero
    let latScaled = entry.start?.[0] ?? NaN;
    let lonScaled = entry.start?.[1] ?? NaN;
    let altitudeScaled = 0;
    let speedScaled = 0;
    let timeScaled = 0;

    let previous: Coordinate = [
      latScaled / COORDINATE_SCALE,
      lonScaled / COORDINATE_SCALE,
    ];
    let row = 0;
    for (; row < lats.length; row++) {
      latScaled += lats[row]!;
      lonScaled += lons?.[row] as number;
      altitudeScaled += altitudes?.[row] as number;
      speedScaled += speeds?.[row] as number;
      const timeDelta = times?.[row] ?? null;
      // A missing value makes the sum NaN and a string makes it a string,
      // so one check covers every column, the start point included
      if (
        !Number.isFinite(
          latScaled +
            lonScaled +
            altitudeScaled +
            speedScaled +
            (timeDelta ?? 0),
        )
      ) {
        console.warn(`Path ${id}: row ${row} is not numeric, dropped the rest`);
        break;
      }
      const end: Coordinate = [
        latScaled / COORDINATE_SCALE,
        lonScaled / COORDINATE_SCALE,
      ];
      const segment: PathSegment = {
        path_id: pathId,
        coords: [previous, end],
        altitude_ft: altitudeScaled * ALTITUDE_STEP,
        groundspeed_knots: speedScaled / SPEED_SCALE,
      };
      if (timeDelta !== null) {
        timeScaled += timeDelta;
        segment.time = timeScaled / TIME_SCALE;
      }
      path_segments.push(segment);
      coordinates.push(previous);
      previous = end;
    }

    if (row > 0) coordinates.push(previous);
  }

  return {
    coordinates,
    path_segments,
    path_info: pathInfo,
    original_points:
      typeof raw.original_points === "number" ? raw.original_points : 0,
  };
}

/**
 * Combine multiple year datasets into one.
 * Path ids are unique across years, so this is a plain concatenation:
 * segment and path info objects are shared, not copied.
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
  private fetchJson: (url: string) => Promise<unknown>;
  /** The request in flight, so that concurrent callers share it */
  private airportsRequest: Promise<{ airports: Airport[] }> | null = null;
  private metadataRequest: Promise<Metadata> | null = null;
  private showLoading: (info: LoadingInfo) => void;
  private hideLoading: () => void;
  private getWindow: () => Window & typeof globalThis;
  private onLoadError: (failedYears: string[]) => void;

  constructor(options: DataLoaderOptions = {}) {
    this.dataDir = options.dataDir || "data";
    this.cache = new Map();
    this.inflight = new Map();
    this.loadingDepth = 0;
    this.fetchJson = options.fetchJson || fetchJson;
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
    return this.shared(year, () => this.loadYear(year));
  }

  /** The cached dataset of `key`, or else the one request for it in flight */
  private shared(
    key: string,
    load: () => Promise<KMLDataset | null>,
  ): Promise<KMLDataset | null> {
    const cached = this.cache.get(key);
    if (cached) return Promise.resolve(cached);

    let promise = this.inflight.get(key);
    if (!promise) {
      promise = load().finally(() => this.inflight.delete(key));
      this.inflight.set(key, promise);
    }
    return promise;
  }

  private async loadYear(year: string): Promise<KMLDataset | null> {
    this.beginLoading(year);
    try {
      logDebug("Loading data (" + year + ")...");
      // The template preloads the latest year, so this request is usually
      // answered by one that is already under way
      const raw = await this.fetchJson(
        this.dataDir + "/" + year + "/data.json",
      );
      const data = expandYearData(raw as RawYearData);

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
    return this.shared("all", () => this.loadAllYears());
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
      } else {
        combined.incomplete = true;
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
   * Load airports data. The list is published on window.KML_AIRPORTS, which
   * is where the code that needs it without a loader at hand reads it from
   * (features/airports.ts, the Wrapped card).
   * @returns Array of airport objects
   */
  async loadAirports(): Promise<Airport[]> {
    try {
      const win = this.getWindow();
      if (!win.KML_AIRPORTS) {
        this.airportsRequest ??= this.fetchJson(
          this.dataDir + "/airports.json",
        ) as Promise<{ airports: Airport[] }>;
        win.KML_AIRPORTS = await this.airportsRequest;
      }
      return win.KML_AIRPORTS?.airports || [];
    } catch (error) {
      logError("Error loading airports:", error);
      return [];
    } finally {
      this.airportsRequest = null;
    }
  }

  /**
   * Load metadata, published on window.KML_METADATA like the airports
   * @returns Metadata object or null on error
   */
  async loadMetadata(): Promise<Metadata | null> {
    try {
      const win = this.getWindow();
      if (!win.KML_METADATA) {
        this.metadataRequest ??= this.fetchJson(
          this.dataDir + "/metadata.json",
        ) as Promise<Metadata>;
        win.KML_METADATA = await this.metadataRequest;
      }
      return win.KML_METADATA || null;
    } catch (error) {
      logError("Error loading metadata:", error);
      return null;
    } finally {
      this.metadataRequest = null;
    }
  }
}
