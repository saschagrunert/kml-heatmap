/**
 * URL state management utilities
 * Handles encoding/decoding application state to/from URL parameters
 */

import type { AppState } from "../types";

/**
 * Parse URL parameters into state object
 * URL parameter schema:
 *   y - selectedYear (string: 'all' or year like '2024')
 *   a - selectedAircraft (string: 'all' or aircraft identifier)
 *   p - selectedPathIds (comma-separated integers: '1,5,12')
 *   v - layer visibility (6-char binary string: '101010')
 *   lat, lng - map center coordinates
 *   z - map zoom level
 * @param params - URLSearchParams object or search string
 * @returns Parsed state or null if no params
 */
export function parseUrlParams(
  params: URLSearchParams | string
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

  // Selected paths
  if (urlParams.has("p")) {
    const pathStr = urlParams.get("p");
    if (pathStr) {
      state.selectedPathIds = pathStr
        .split(",")
        .filter((id) => id.trim().length > 0);
    }
  }

  // Layer visibility (6 flags: heatmap, altitude, airspeed, airports, aviation, stats)
  if (urlParams.has("v")) {
    const vis = urlParams.get("v");
    if (vis && vis.length === 6) {
      state.heatmapVisible = vis[0] === "1";
      state.altitudeVisible = vis[1] === "1";
      state.airspeedVisible = vis[2] === "1";
      state.airportsVisible = vis[3] === "1";
      state.aviationVisible = vis[4] === "1";
      state.statsPanelVisible = vis[5] === "1";
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
        // Clamp zoom to reasonable range
        state.zoom = Math.max(1, Math.min(18, zoom));
      }
    }
  }

  return state;
}

/**
 * Encode current state to URL parameters
 * @param state - Current state object
 * @returns URL search params string (without leading '?')
 */
export function encodeStateToUrl(state: AppState): string {
  const params = new URLSearchParams();

  // Always include year parameter (including 'all') because default is current year
  if (state.selectedYear) {
    params.set("y", state.selectedYear);
  }

  // Only add aircraft if not 'all' (default is 'all')
  if (state.selectedAircraft && state.selectedAircraft !== "all") {
    params.set("a", state.selectedAircraft);
  }

  if (state.selectedPathIds && state.selectedPathIds.length > 0) {
    params.set("p", state.selectedPathIds.join(","));
  }

  // Build visibility string (6 characters: heatmap, altitude, airspeed, airports, aviation, stats)
  // Only include if visibility properties are actually defined
  const hasVisibility =
    state.heatmapVisible !== undefined ||
    state.altitudeVisible !== undefined ||
    state.airspeedVisible !== undefined ||
    state.airportsVisible !== undefined ||
    state.aviationVisible !== undefined ||
    state.statsPanelVisible !== undefined;

  if (hasVisibility) {
    const vis = [
      state.heatmapVisible ? "1" : "0",
      state.altitudeVisible ? "1" : "0",
      state.airspeedVisible ? "1" : "0",
      state.airportsVisible ? "1" : "0",
      state.aviationVisible ? "1" : "0",
      state.statsPanelVisible ? "1" : "0",
    ].join("");

    // Only add if not default (100100 = heatmap+airports on, rest off, stats hidden)
    if (vis !== "100100") {
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

/**
 * Build default state object
 * @returns Default state with all flags
 */
export function getDefaultState(): AppState {
  return {
    selectedYear: "all",
    selectedAircraft: "all",
    selectedPathIds: [],
    heatmapVisible: true,
    altitudeVisible: false,
    airspeedVisible: false,
    airportsVisible: true,
    aviationVisible: false,
    statsPanelVisible: false,
  };
}

/**
 * Merge state objects with priority (urlState overrides defaultState)
 * @param defaultState - Default state values
 * @param urlState - State from URL (takes priority)
 * @returns Merged state
 */
export function mergeState(
  defaultState: AppState,
  urlState: AppState | null
): AppState {
  if (!urlState) {
    return { ...defaultState };
  }
  return { ...defaultState, ...urlState };
}
