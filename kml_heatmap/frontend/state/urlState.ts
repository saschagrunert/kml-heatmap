/**
 * URL state management utilities
 * Handles encoding/decoding application state to/from URL parameters
 */

import type { AppState } from "../types";
import { MAX_ZOOM, MIN_ZOOM } from "../utils/constants";

/**
 * Schema version of the persisted selection. Ids saved by an older release
 * refer to different flights and must be discarded rather than silently
 * applied. Version 3 ids are derived from the flight content instead of its
 * position in the export, so they stay valid across re-exports; an id whose
 * flight was removed is dropped once the data has loaded.
 *
 * Version 4 names the very same flights and only writes them differently: in
 * base 36 rather than in decimal, which takes about a third off a link that
 * carries a large selection. Both versions are therefore still read, so
 * links and saved states from before the change keep working.
 */
export const STATE_SCHEMA_VERSION = 4;

/** The versions whose ids this build understands, newest last */
export const SUPPORTED_SCHEMA_VERSIONS: readonly number[] = [3, 4];

/** The radix each supported version writes its path ids in */
const PATH_ID_RADIX = new Map([
  [3, 10],
  [4, 36],
]);

/** Path ids are 40-bit content hashes (PATH_ID_BITS in data_exporter.py) */
const PATH_ID_LIMIT = 2 ** 40;

/**
 * Whether a saved selection was written by a version this build can read.
 * Used for the URL and for the localStorage copy alike.
 */
export function isSupportedSchemaVersion(version: unknown): boolean {
  return (
    typeof version === "number" && SUPPORTED_SCHEMA_VERSIONS.includes(version)
  );
}

/** A path id as written in a link, or null when it is not one */
export function parsePathId(text: string, radix: number): number | null {
  if (!text) return null;
  // parseInt stops at the first invalid digit, so the shape is checked first
  const valid = radix === 36 ? /^[0-9a-z]+$/ : /^[0-9]+$/;
  if (!valid.test(text)) return null;
  const id = parseInt(text, radix);
  return Number.isInteger(id) && id >= 0 && id < PATH_ID_LIMIT ? id : null;
}

/**
 * Parse URL parameters into state object
 * URL parameter schema:
 *   y - selectedYear (string: 'all' or year like '2024')
 *   a - selectedAircraft (string: 'all' or aircraft identifier)
 *   p - selectedPathIds (comma-separated, base 36 from schema 4 on:
 *       'a5,1x,3kf'; decimal in schema 3)
 *   sv - schema version of p (an unknown one means p is ignored)
 *   v - layer visibility (9-char binary string: '100100000')
 *   lat, lng - map center coordinates
 *   z - map zoom level
 * @param params - URLSearchParams object or search string
 * @returns Parsed state or null if no params
 */
export function parseUrlParams(
  params: URLSearchParams | string,
): AppState | null {
  // Support both URLSearchParams and string input
  let urlParams: URLSearchParams;
  if (typeof params === "string") {
    urlParams = new URLSearchParams(params);
  } else {
    urlParams = params;
  }

  if (urlParams.toString() === "") {
    return null;
  }

  const state: AppState = {};

  // Year filter
  if (urlParams.has("y")) {
    const year = urlParams.get("y");
    if (year) {
      state.selectedYear = year;
    }
  }

  // Aircraft filter
  if (urlParams.has("a")) {
    const aircraft = urlParams.get("a");
    if (aircraft) {
      state.selectedAircraft = aircraft;
    }
  }

  // Selected paths, only when they were written with an id scheme this
  // build reads. The radix follows the version: decimal up to 3, base 36
  // from 4 on.
  const schemaVersion = parseInt(urlParams.get("sv") ?? "", 10);
  const radix = PATH_ID_RADIX.get(schemaVersion);
  if (urlParams.has("p") && radix !== undefined) {
    const pathStr = urlParams.get("p");
    if (pathStr) {
      state.selectedPathIds = pathStr
        .split(",")
        .map((id) => parsePathId(id.trim(), radix))
        .filter((id): id is number => id !== null);
    }
  }

  // Layer visibility (9 flags: heatmap, altitude, airspeed, airports,
  // aviation, stats, wrapped, buttonsHidden, isolateSelection). The 8th flag
  // is legacy: the control chrome no longer hides, so the parsed value is
  // dropped by sanitizeSavedState. The slot stays so older links keep the
  // isolate flag in place.
  if (urlParams.has("v")) {
    const vis = urlParams.get("v");
    // Support old 6-char, 7-char, 8-char, and new 9-char format for backwards compatibility
    if (
      vis &&
      (vis.length === 6 ||
        vis.length === 7 ||
        vis.length === 8 ||
        vis.length === 9)
    ) {
      state.heatmapVisible = vis[0] === "1";
      state.altitudeVisible = vis[1] === "1";
      state.airspeedVisible = vis[2] === "1";
      state.airportsVisible = vis[3] === "1";
      state.aviationVisible = vis[4] === "1";
      state.statsPanelVisible = vis[5] === "1";
      // Only parse wrapped state if 7th character exists
      if (vis.length >= 7) {
        state.wrappedVisible = vis[6] === "1";
      }
      // Only parse buttonsHidden state if 8th character exists
      if (vis.length >= 8) {
        state.buttonsHidden = vis[7] === "1";
      }
      // Only parse isolateSelection state if 9th character exists
      if (vis.length === 9) {
        state.isolateSelection = vis[8] === "1";
      }
    }
  }

  // Map position
  if (urlParams.has("lat") && urlParams.has("lng")) {
    const latStr = urlParams.get("lat");
    const lngStr = urlParams.get("lng");
    if (latStr && lngStr) {
      const lat = parseFloat(latStr);
      const lng = parseFloat(lngStr);
      if (
        !isNaN(lat) &&
        !isNaN(lng) &&
        lat >= -90 &&
        lat <= 90 &&
        lng >= -180 &&
        lng <= 180
      ) {
        state.center = { lat, lng };
      }
    }
  }

  // Zoom level
  if (urlParams.has("z")) {
    const zoomStr = urlParams.get("z");
    if (zoomStr) {
      const zoom = parseFloat(zoomStr);
      if (!isNaN(zoom)) {
        // Clamp zoom to the map's zoom range
        state.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
      }
    }
  }

  return state;
}

/**
 * Encode current state to URL parameters
 * Preserves non-state parameters like debug
 * @param state - Current state object
 * @returns URL search params string (without leading '?')
 */
export function encodeStateToUrl(state: AppState): string {
  const params = new URLSearchParams();

  // Preserve non-state parameters from current URL
  const currentParams = new URLSearchParams(window.location.search);
  const preservedParams = ["debug"];
  for (const param of preservedParams) {
    const value = currentParams.get(param);
    if (value !== null) {
      params.set(param, value);
    }
  }

  // Always include year parameter (including 'all') because default is current year
  if (state.selectedYear) {
    params.set("y", state.selectedYear);
  }

  // Only add aircraft if not 'all' (default is 'all')
  if (state.selectedAircraft && state.selectedAircraft !== "all") {
    params.set("a", state.selectedAircraft);
  }

  if (state.selectedPathIds && state.selectedPathIds.length > 0) {
    // Base 36 keeps a large selection out of the length limits proxies and
    // chat clients put on a link
    params.set(
      "p",
      state.selectedPathIds.map((id) => id.toString(36)).join(","),
    );
    params.set("sv", String(STATE_SCHEMA_VERSION));
  }

  // Build visibility string (9 characters: heatmap, altitude, airspeed,
  // airports, aviation, stats, wrapped, buttonsHidden, isolateSelection).
  // The 8th is the legacy control-visibility slot and is always written as 0.
  // Only include if visibility properties are actually defined
  const hasVisibility =
    state.heatmapVisible !== undefined ||
    state.altitudeVisible !== undefined ||
    state.airspeedVisible !== undefined ||
    state.airportsVisible !== undefined ||
    state.aviationVisible !== undefined ||
    state.statsPanelVisible !== undefined ||
    state.wrappedVisible !== undefined ||
    state.buttonsHidden !== undefined ||
    state.isolateSelection !== undefined;

  if (hasVisibility) {
    const vis = [
      state.heatmapVisible ? "1" : "0",
      state.altitudeVisible ? "1" : "0",
      state.airspeedVisible ? "1" : "0",
      state.airportsVisible ? "1" : "0",
      state.aviationVisible ? "1" : "0",
      state.statsPanelVisible ? "1" : "0",
      state.wrappedVisible ? "1" : "0",
      state.buttonsHidden ? "1" : "0",
      state.isolateSelection ? "1" : "0",
    ].join("");

    // Only add if not default (100100000 = heatmap+airports on, rest off)
    if (vis !== "100100000") {
      params.set("v", vis);
    }
  }

  // Add map position (always include for complete shareable state)
  if (state.center) {
    params.set("lat", state.center.lat.toFixed(6));
    params.set("lng", state.center.lng.toFixed(6));
  }

  if (state.zoom !== undefined) {
    params.set("z", state.zoom.toFixed(2));
  }

  return params.toString();
}
