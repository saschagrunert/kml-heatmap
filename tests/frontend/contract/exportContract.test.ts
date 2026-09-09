/**
 * Contract test for the data files written by the Python exporter.
 *
 * Validates `docs/data/metadata.js`, `docs/data/airports.js` and each
 * `docs/data/<year>/data.js` against hand-written runtime guards derived from
 * `kml_heatmap/frontend/types.ts` (decisions D1/D2/D3). A second test runs the
 * same guards against an inline sample so the guards are verified on their own.
 *
 * NOTE: this suite requires `docs/` to contain files in the new format; it
 * fails against exports made with the old format.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cwd } from "node:process";
import { expandYearData } from "../../../kml_heatmap/frontend/services/dataLoader";
import type {
  Airport,
  FilteredStatistics,
  Metadata,
  PathInfo,
  RawSegment,
  RawYearData,
} from "../../../kml_heatmap/frontend/types";

// vitest runs with the repository root as working directory
const DATA_DIR = join(cwd(), "docs", "data");

type Json = Record<string, unknown>;

/**
 * Strip the `window.X = ` prefix and trailing `;` and parse the JSON body
 */
export function parseDataFile(source: string, globalName: string): unknown {
  const prefix = `window.${globalName} = `;
  const trimmed = source.trim();
  if (!trimmed.startsWith(prefix)) {
    throw new Error(`Expected file to start with "${prefix}"`);
  }
  let body = trimmed.slice(prefix.length);
  if (body.endsWith(";")) body = body.slice(0, -1);
  return JSON.parse(body) as unknown;
}

// ---- runtime guards ----

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isInteger(value: unknown): value is number {
  return Number.isInteger(value);
}

function optional<T>(
  value: unknown,
  guard: (v: unknown) => v is T,
): value is T | undefined {
  return value === undefined || guard(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isCoordinatePair(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    isFiniteNumber(value[0]) &&
    isFiniteNumber(value[1]) &&
    value[0] >= -90 &&
    value[0] <= 90 &&
    value[1] >= -180 &&
    value[1] <= 180
  );
}

export function isPathInfo(value: unknown): value is PathInfo {
  if (!isRecord(value)) return false;
  if (!isInteger(value["id"]) || value["id"] < 0) return false;
  // null values are omitted by the exporter: optional means absent or typed
  return (
    optional(value["aircraft_registration"], isString) &&
    optional(value["aircraft_type"], isString) &&
    optional(value["year"], isInteger) &&
    optional(value["start_airport"], isString) &&
    optional(value["end_airport"], isString) &&
    optional(value["start_coords"], isCoordinatePair) &&
    optional(value["end_coords"], isCoordinatePair) &&
    optional(value["segment_count"], isInteger)
  );
}

export function isRawSegment(value: unknown): value is RawSegment {
  if (!Array.isArray(value)) return false;
  if (value.length !== 6 && value.length !== 7) return false;
  if (!value.every(isFiniteNumber)) return false;
  const [lat1, lon1, lat2, lon2, , groundspeed] = value;
  return (
    isCoordinatePair([lat1, lon1]) &&
    isCoordinatePair([lat2, lon2]) &&
    groundspeed !== undefined &&
    groundspeed >= 0
  );
}

export function isRawYearData(value: unknown): value is RawYearData {
  if (!isRecord(value)) return false;
  if (!isInteger(value["year"])) return false;
  if (!isInteger(value["original_points"]) || value["original_points"] < 0)
    return false;
  const pathInfo = value["path_info"];
  if (!Array.isArray(pathInfo) || !pathInfo.every(isPathInfo)) return false;
  const segments = value["segments"];
  if (!isRecord(segments)) return false;
  for (const [key, list] of Object.entries(segments)) {
    if (!/^\d+$/.test(key)) return false;
    if (!Array.isArray(list) || !list.every(isRawSegment)) return false;
  }
  return true;
}

export function isAirport(value: unknown): value is Airport {
  return (
    isRecord(value) &&
    isString(value["name"]) &&
    isCoordinatePair([value["lat"], value["lon"]]) &&
    optional(value["country"], isString) &&
    optional(value["flight_count"], isInteger) &&
    !("icao" in value)
  );
}

export function isAirportsFile(
  value: unknown,
): value is { airports: Airport[] } {
  return (
    isRecord(value) &&
    Array.isArray(value["airports"]) &&
    value["airports"].every(isAirport)
  );
}

function isAircraftAggregate(value: unknown): boolean {
  return (
    isRecord(value) &&
    isString(value["registration"]) &&
    isInteger(value["flights"]) &&
    optional(value["type"], isString) &&
    optional(value["model"], isString) &&
    optional(value["flight_time_seconds"], isFiniteNumber) &&
    optional(value["flight_time_str"], isString) &&
    optional(value["flight_distance_km"], isFiniteNumber)
  );
}

export function isFilteredStatistics(
  value: unknown,
): value is FilteredStatistics {
  if (!isRecord(value)) return false;
  const required: [string, (v: unknown) => boolean][] = [
    ["total_points", isInteger],
    ["num_paths", isInteger],
    ["num_airports", isInteger],
    ["num_aircraft", isInteger],
    ["total_distance_km", isFiniteNumber],
    ["total_distance_nm", isFiniteNumber],
  ];
  for (const [key, guard] of required) {
    if (!guard(value[key])) return false;
  }
  if (
    !Array.isArray(value["airport_names"]) ||
    !value["airport_names"].every(isString)
  )
    return false;
  if (
    !Array.isArray(value["aircraft_list"]) ||
    !value["aircraft_list"].every(isAircraftAggregate)
  )
    return false;
  // D3: optional numeric fields may be absent, never null
  const optionalNumbers = [
    "max_altitude_m",
    "min_altitude_m",
    "total_altitude_gain_m",
    "max_altitude_ft",
    "min_altitude_ft",
    "total_altitude_gain_ft",
    "max_groundspeed_knots",
    "avg_groundspeed_knots",
    "cruise_speed_knots",
    "longest_flight_km",
    "longest_flight_nm",
    "total_flight_time_seconds",
    "most_common_cruise_altitude_ft",
    "most_common_cruise_altitude_m",
  ];
  for (const key of optionalNumbers) {
    if (!optional(value[key], isFiniteNumber)) return false;
  }
  return optional(value["total_flight_time_str"], isString);
}

export function isMetadata(value: unknown): value is Metadata {
  if (!isRecord(value)) return false;
  if (!isFilteredStatistics(value["stats"])) return false;
  if (
    !isFiniteNumber(value["min_alt_m"]) ||
    !isFiniteNumber(value["max_alt_m"]) ||
    !isFiniteNumber(value["min_groundspeed_knots"]) ||
    !isFiniteNumber(value["max_groundspeed_knots"])
  )
    return false;
  const years = value["available_years"];
  if (!Array.isArray(years) || !years.every(isInteger)) return false;
  const bytes = value["year_file_bytes"];
  if (!isRecord(bytes)) return false;
  for (const [year, size] of Object.entries(bytes)) {
    if (!/^\d{4}$/.test(year) || !isInteger(size) || size < 0) {
      return false;
    }
  }
  // D2: removed keys must not come back
  return !("gradient" in value) && !("file_structure" in value);
}

// ---- inline sample (new format) ----

const sampleMetadata = {
  stats: {
    total_points: 3,
    num_paths: 2,
    num_airports: 2,
    airport_names: ["EDDF Frankfurt", "EDDM Munich"],
    num_aircraft: 1,
    aircraft_list: [
      {
        registration: "D-EAGJ",
        type: "DA20",
        model: "Diamond DA-20",
        flights: 2,
        flight_time_seconds: 3600,
        flight_time_str: "1h 0m",
        flight_distance_km: 300,
      },
    ],
    total_distance_km: 300,
    total_distance_nm: 162,
    max_altitude_m: 1500,
    min_altitude_m: 0,
    max_altitude_ft: 4921,
    min_altitude_ft: 0,
    max_groundspeed_knots: 120,
    avg_groundspeed_knots: 100,
    total_flight_time_seconds: 3600,
    total_flight_time_str: "1h 0m",
  },
  min_alt_m: 0,
  max_alt_m: 1500,
  min_groundspeed_knots: 0,
  max_groundspeed_knots: 120,
  available_years: [2024, 2025],
  year_file_bytes: { "2024": 1234, "2025": 5678 },
};

const sampleAirports = {
  airports: [
    {
      name: "EDDF Frankfurt",
      lat: 50.03,
      lon: 8.57,
      country: "DE",
      flight_count: 2,
    },
    { name: "EDDM Munich", lat: 48.35, lon: 11.79 },
  ],
};

const sampleYear2025: RawYearData = {
  year: 2025,
  original_points: 3,
  path_info: [
    {
      id: 4,
      year: 2025,
      aircraft_registration: "D-EAGJ",
      aircraft_type: "DA20",
      start_airport: "EDDF Frankfurt",
      end_airport: "EDDM Munich",
      start_coords: [50.03, 8.57],
      end_coords: [48.35, 11.79],
      segment_count: 2,
    },
    { id: 5, year: 2025 },
  ],
  segments: {
    "4": [
      [50.03, 8.57, 49.5, 9.5, 3000, 110, 0],
      [49.5, 9.5, 48.35, 11.79, 4000, 120, 1800],
    ],
    "5": [[48.35, 11.79, 48.4, 11.8, 1000, 60]],
  },
};

function serialize(globalName: string, value: unknown): string {
  return `window.${globalName} = ${JSON.stringify(value)};\n`;
}

describe("export contract (inline new-format sample)", () => {
  it("parses the window.X = ...; file format", () => {
    expect(
      parseDataFile(serialize("KML_METADATA", { a: 1 }), "KML_METADATA"),
    ).toEqual({ a: 1 });
    expect(() => parseDataFile("var x = 1;", "KML_METADATA")).toThrow(
      "Expected file",
    );
  });

  it("accepts a valid metadata.js", () => {
    expect(
      isMetadata(
        parseDataFile(
          serialize("KML_METADATA", sampleMetadata),
          "KML_METADATA",
        ),
      ),
    ).toBe(true);
  });

  it("rejects metadata with removed keys or null stats fields", () => {
    expect(isMetadata({ ...sampleMetadata, gradient: {} })).toBe(false);
    expect(isMetadata({ ...sampleMetadata, file_structure: {} })).toBe(false);
    expect(
      isMetadata({
        ...sampleMetadata,
        stats: { ...sampleMetadata.stats, total_flight_time_str: null },
      }),
    ).toBe(false);
    expect(
      isMetadata({
        ...sampleMetadata,
        stats: { ...sampleMetadata.stats, max_altitude_ft: null },
      }),
    ).toBe(false);
    expect(isMetadata({ ...sampleMetadata, available_years: ["2025"] })).toBe(
      false,
    );
    expect(isMetadata({ ...sampleMetadata, year_file_bytes: { abc: 1 } })).toBe(
      false,
    );
  });

  it("accepts a valid airports.js and rejects icao", () => {
    expect(isAirportsFile(sampleAirports)).toBe(true);
    expect(
      isAirportsFile({
        airports: [{ ...sampleAirports.airports[0], icao: "EDDF" }],
      }),
    ).toBe(false);
    expect(isAirportsFile({ airports: [{ name: "X", lat: 91, lon: 0 }] })).toBe(
      false,
    );
  });

  it("accepts a valid per-year data.js", () => {
    const parsed = parseDataFile(
      serialize("KML_DATA_2025", sampleYear2025),
      "KML_DATA_2025",
    );
    expect(isRawYearData(parsed)).toBe(true);
  });

  it("rejects legacy or malformed per-year files", () => {
    expect(
      isRawYearData({
        ...sampleYear2025,
        segments: undefined,
        path_segments: [],
      }),
    ).toBe(false);
    expect(isRawYearData({ ...sampleYear2025, coordinates: [] })).toBe(true);
    expect(
      isRawYearData({
        ...sampleYear2025,
        segments: { "4": [[1, 2, 3, 4, 5]] },
      }),
    ).toBe(false);
    expect(
      isRawYearData({
        ...sampleYear2025,
        segments: { x: [[1, 2, 3, 4, 5, 6]] },
      }),
    ).toBe(false);
    expect(
      isRawYearData({
        ...sampleYear2025,
        path_info: [{ id: 1, aircraft_registration: null }],
      }),
    ).toBe(false);
  });

  it("expands the sample into the in-memory dataset shape", () => {
    const data = expandYearData(sampleYear2025);
    expect(data.path_segments).toHaveLength(3);
    expect(data.coordinates).toHaveLength(5);
    expect(data.path_segments[0]).toEqual({
      path_id: 4,
      coords: [
        [50.03, 8.57],
        [49.5, 9.5],
      ],
      altitude_ft: 3000,
      groundspeed_knots: 110,
      time: 0,
    });
    expect(data.path_segments[2]!.time).toBeUndefined();
  });
});

describe("export contract (docs/data)", () => {
  const available = existsSync(join(DATA_DIR, "metadata.js"));

  it.skipIf(!available)("metadata.js matches the Metadata contract", () => {
    const parsed = parseDataFile(
      readFileSync(join(DATA_DIR, "metadata.js"), "utf8"),
      "KML_METADATA",
    );
    expect(isMetadata(parsed)).toBe(true);
    const metadata = parsed as Metadata;
    expect(metadata.available_years).toEqual(
      [...metadata.available_years].sort((a, b) => a - b),
    );
    for (const year of metadata.available_years) {
      expect(metadata.year_file_bytes).toHaveProperty(String(year));
      expect(existsSync(join(DATA_DIR, String(year), "data.js"))).toBe(true);
    }
  });

  it.skipIf(!available)("airports.js matches the Airport contract", () => {
    const parsed = parseDataFile(
      readFileSync(join(DATA_DIR, "airports.js"), "utf8"),
      "KML_AIRPORTS",
    );
    expect(isAirportsFile(parsed)).toBe(true);
  });

  it.skipIf(!available)(
    "every <year>/data.js matches the per-year contract with globally unique path ids",
    () => {
      const years = readdirSync(DATA_DIR, { withFileTypes: true })
        .filter((e) => e.isDirectory() && /^\d{4}$/.test(e.name))
        .map((e) => e.name)
        .sort();
      expect(years.length).toBeGreaterThan(0);

      const seenIds = new Set<number>();
      let previousMaxId = -1;
      for (const year of years) {
        const parsed = parseDataFile(
          readFileSync(join(DATA_DIR, year, "data.js"), "utf8"),
          `KML_DATA_${year}`,
        );
        expect(isRawYearData(parsed), `docs/data/${year}/data.js`).toBe(true);
        const raw = parsed as RawYearData;
        expect(raw.year).toBe(Number(year));
        expect("coordinates" in raw).toBe(false);

        const ids = raw.path_info.map((p) => p.id);
        for (const id of ids) {
          expect(seenIds.has(id), `duplicate path id ${id} in ${year}`).toBe(
            false,
          );
          seenIds.add(id);
          // ids are assigned in ascending year order with cumulative offsets
          expect(id).toBeGreaterThan(previousMaxId);
        }
        previousMaxId = Math.max(previousMaxId, ...ids);

        // every segment list belongs to a known path of this year
        const idSet = new Set(ids);
        for (const key of Object.keys(raw.segments)) {
          expect(idSet.has(Number(key)), `orphan segments for ${key}`).toBe(
            true,
          );
        }
        for (const info of raw.path_info) {
          expect(info.year, `path ${info.id} year`).toBe(Number(year));
          if (info.segment_count !== undefined) {
            expect(raw.segments[String(info.id)]?.length ?? 0).toBe(
              info.segment_count,
            );
          }
        }

        // the loader can expand it
        const data = expandYearData(raw);
        expect(data.path_segments.length).toBe(
          Object.values(raw.segments).reduce((n, list) => n + list.length, 0),
        );
      }
    },
  );
});
