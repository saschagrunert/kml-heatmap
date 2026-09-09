/**
 * State Manager - Handles state persistence (localStorage, URL)
 */
import type { MapApp } from "../mapApp";
import type { StoreState } from "../state/store";
import type { SavedState } from "../types";
import {
  STATE_SCHEMA_VERSION,
  encodeStateToUrl,
  parseUrlParams,
} from "../state/urlState";
import { domCache } from "../utils/domCache";

const STORAGE_KEY = "kml-heatmap-state";

const BOOLEAN_KEYS = [
  "heatmapVisible",
  "altitudeVisible",
  "airspeedVisible",
  "airportsVisible",
  "aviationVisible",
  "buttonsHidden",
  "isolateSelection",
  "statsPanelVisible",
  "wrappedVisible",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Pick the known, correctly typed fields of a candidate state object.
 * Unknown keys and values of the wrong type are dropped.
 */
export function sanitizeSavedState(candidate: unknown): SavedState {
  const result: SavedState = {};
  if (!isRecord(candidate)) return result;

  if (typeof candidate["selectedYear"] === "string") {
    result.selectedYear = candidate["selectedYear"];
  }
  if (typeof candidate["selectedAircraft"] === "string") {
    result.selectedAircraft = candidate["selectedAircraft"];
  }
  const zoom = candidate["zoom"];
  if (typeof zoom === "number" && isFinite(zoom)) {
    result.zoom = zoom;
  }
  const center = candidate["center"];
  if (
    isRecord(center) &&
    typeof center["lat"] === "number" &&
    isFinite(center["lat"]) &&
    typeof center["lng"] === "number" &&
    isFinite(center["lng"])
  ) {
    result.center = { lat: center["lat"], lng: center["lng"] };
  }
  for (const key of BOOLEAN_KEYS) {
    const value = candidate[key];
    if (typeof value === "boolean") {
      result[key] = value;
    }
  }
  // Path ids are only meaningful when they were written with the current
  // id scheme; older payloads refer to different flights (see urlState)
  const pathIds = candidate["selectedPathIds"];
  if (
    Array.isArray(pathIds) &&
    candidate["schemaVersion"] === STATE_SCHEMA_VERSION
  ) {
    result.selectedPathIds = pathIds.filter(
      (id: unknown): id is number => typeof id === "number" && isFinite(id),
    );
  }
  return result;
}

export class StateManager {
  private app: MapApp;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(app: MapApp) {
    this.app = app;

    // Pre-cache state-related elements
    domCache.cacheElements(["stats-panel", "wrapped-modal"]);

    const persistKeys: (keyof StoreState)[] = [
      "selectedYear",
      "selectedAircraft",
      "selectedPathIds",
      "isolateSelection",
      "heatmapVisible",
      "altitudeVisible",
      "airspeedVisible",
      "airportsVisible",
      "aviationVisible",
      "buttonsHidden",
      "statsPanelVisible",
      "wrappedVisible",
    ];
    for (const key of persistKeys) {
      app.store.subscribe(key, () => this.scheduleSave());
    }
  }

  scheduleSave(): void {
    if (this.saveTimer !== null) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveMapState();
    }, 300);
  }

  /**
   * Wrapped visibility from the store; falls back to the DOM while the
   * wrapped manager does not yet publish its state to the store.
   */
  private isWrappedVisible(): boolean {
    const fromStore = this.app.store.get("wrappedVisible");
    if (fromStore !== undefined) return fromStore;
    const wrappedModalEl = domCache.get("wrapped-modal");
    return wrappedModalEl ? wrappedModalEl.style.display === "flex" : false;
  }

  saveMapState(): void {
    if (!this.app.map) return;

    const state: SavedState = {
      schemaVersion: STATE_SCHEMA_VERSION,
      center: this.app.map.getCenter(),
      zoom: this.app.map.getZoom(),
      heatmapVisible: this.app.heatmapVisible,
      altitudeVisible: this.app.altitudeVisible,
      airspeedVisible: this.app.airspeedVisible,
      airportsVisible: this.app.airportsVisible,
      aviationVisible: this.app.aviationVisible,
      selectedYear: this.app.selectedYear,
      selectedAircraft: this.app.selectedAircraft,
      selectedPathIds: Array.from(this.app.selectedPathIds),
      statsPanelVisible: this.app.store.get("statsPanelVisible"),
      wrappedVisible: this.isWrappedVisible(),
      buttonsHidden: this.app.buttonsHidden,
      isolateSelection: this.app.isolateSelection,
      // Note: replay state is NOT persisted - too complex to restore reliably
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (_e) {
      // Silently fail if localStorage is not available
    }

    // Update URL to reflect current state (for shareable links)
    this.updateUrl(state);
  }

  loadMapState(): SavedState | null {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed: unknown = JSON.parse(saved);
        const state = sanitizeSavedState(parsed);
        // A persisted map state always carries a view; treat anything else
        // as corrupt
        if (state.center && state.zoom !== undefined) {
          return state;
        }
        return null;
      }
    } catch (_e) {
      // Silently fail if localStorage is not available or data is corrupt
    }
    return null;
  }

  /**
   * Update browser URL without reloading page
   * @param state - Current state object
   */
  updateUrl(state: SavedState): void {
    const urlParams = encodeStateToUrl(state);
    const newUrl = urlParams ? "?" + urlParams : window.location.pathname;

    // Use replaceState to avoid adding to browser history on every change
    try {
      history.replaceState(null, "", newUrl);
    } catch (_e) {
      // Silently fail if history API is not available
    }
  }

  /**
   * Load state with priority: URL params > localStorage > defaults
   * @returns State object to restore, or null
   */
  loadState(): SavedState | null {
    // Priority 1: URL parameters
    const urlState = parseUrlParams(
      new URLSearchParams(window.location.search),
    );
    if (urlState && Object.keys(urlState).length > 0) {
      const validated = sanitizeSavedState({
        ...urlState,
        // parseUrlParams only returns path ids that carried a current sv
        schemaVersion: STATE_SCHEMA_VERSION,
      });
      if (Object.keys(validated).length > 0) {
        return validated;
      }
    }

    // Priority 2: localStorage
    return this.loadMapState();
  }
}
