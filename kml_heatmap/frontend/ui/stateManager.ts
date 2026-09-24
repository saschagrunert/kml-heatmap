/**
 * State Manager - Handles state persistence (localStorage, URL)
 */
import type { MapApp } from "../mapApp";
import type { StoreState } from "../state/store";
import type { MapCenter, SavedState } from "../types";
import {
  isPathId,
  isSupportedSchemaVersion,
  STATE_SCHEMA_VERSION,
  encodeStateToUrl,
  parseUrlParams,
} from "../state/urlState";
import { toMapBearing, toMapCenter, toMapPitch } from "../utils/geometry";
import { mapZoomToState } from "../utils/mapHelpers";

const STORAGE_KEY = "kml-heatmap-state";

/**
 * Storage key of the map at this location. Every page of an origin shares
 * one localStorage, so two maps published side by side (user.github.io/a/
 * and /b/) would otherwise restore each other's year, view and selection.
 * The key names the page's directory, which index.html and its folder share;
 * a map at the root of its origin keeps the key it has always used.
 */
export function storageKey(
  pathname: string = window.location.pathname,
): string {
  const directory = pathname.slice(0, pathname.lastIndexOf("/") + 1);
  return directory === "/" ? STORAGE_KEY : STORAGE_KEY + ":" + directory;
}

/**
 * The flags a session keeps. All of them start off but the heatmap and the
 * airports, and Reset view puts them back (MapApp.resetView).
 */
export const BOOLEAN_KEYS = [
  "heatmapVisible",
  "altitudeVisible",
  "airspeedVisible",
  "airportsVisible",
  "aviationVisible",
  "globeVisible",
  "threeDVisible",
  "satelliteVisible",
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
  // The rule of the links (parseUrlParams): a centre the map cannot take is
  // dropped and the rest of the state kept, here and in `loadMapState`
  const center = candidate["center"];
  if (isRecord(center)) {
    const point = toMapCenter({ lat: center["lat"], lng: center["lng"] });
    if (point) result.center = point;
  }
  // Absent from every state saved before the map could turn, which leaves
  // those north up and flat
  const bearing = toMapBearing(candidate["bearing"]);
  if (bearing !== null) result.bearing = bearing;
  const pitch = toMapPitch(candidate["pitch"]);
  if (pitch !== null) result.pitch = pitch;
  for (const key of BOOLEAN_KEYS) {
    const value = candidate[key];
    if (typeof value === "boolean") {
      result[key] = value;
    }
  }
  // Path ids are only meaningful when they were written with an id scheme
  // this build reads; older payloads refer to different flights. Schema 4
  // only changed how a link spells the ids, so a selection saved as 3 still
  // names the same flights and is kept (see urlState).
  const pathIds = candidate["selectedPathIds"];
  if (
    Array.isArray(pathIds) &&
    isSupportedSchemaVersion(candidate["schemaVersion"])
  ) {
    result.selectedPathIds = pathIds.filter(isPathId);
  }
  return result;
}

export class StateManager {
  private app: MapApp;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** Store keys that changed since the state was restored */
  private changed = new Set<keyof StoreState>();

  constructor(app: MapApp) {
    this.app = app;

    // A change made just before the page goes away would still be waiting
    // for the debounce, and nothing runs once the page is gone
    window.addEventListener(
      "pagehide",
      () => {
        if (this.saveTimer !== null) this.flush();
      },
      { signal: app.signal },
    );

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
      "globeVisible",
      "threeDVisible",
      "satelliteVisible",
      "statsPanelVisible",
      "wrappedVisible",
    ];
    for (const key of persistKeys) {
      app.store.subscribe(key, () => {
        this.changed.add(key);
        this.scheduleSave();
      });
    }
  }

  /** Drop the pending save, if any */
  cancelSave(): void {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
  }

  /**
   * A panel flag as it is to be saved. The statistics reopen once the data
   * has loaded and Wrapped half a second after that, while the restore
   * itself already schedules a save: until the store has a say, a save (or
   * a share, which flushes one) writes what was restored, not "closed".
   * MapApp drops a restored flag it gave up on.
   */
  private panelVisible(key: "statsPanelVisible" | "wrappedVisible"): boolean {
    return (
      (!this.changed.has(key) && this.app.savedState?.[key] === true) ||
      this.app.store.get(key)
    );
  }

  scheduleSave(): void {
    if (this.saveTimer !== null) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveMapState();
    }, 300);
  }

  /**
   * Save right now instead of after the debounce. Only the share action
   * needs this: it reads the URL the moment the user asks for it.
   */
  flush(): void {
    this.cancelSave();
    this.saveMapState();
  }

  saveMapState(): void {
    if (!this.app.map) return;

    // While Wrapped has the map fitted to all the data, the view worth
    // keeping is the one the user had before, and so it is while the
    // replay's chase view flies the map along a flight. The `?.` is for
    // both living in lazily loaded bundles: before one has ever been opened
    // there is no saved view either way.
    const view = this.app.wrappedManager?.userMapView() ??
      this.app.replayManager?.userMapView() ?? {
        center: this.app.map.getCenter(),
        zoom: this.app.map.getZoom(),
        bearing: this.app.map.getBearing(),
        pitch: this.app.map.getPitch(),
      };
    // Panning across the antimeridian takes the longitude past 180. The
    // wrapped one is the same place, and what a link is expected to carry;
    // wrapped by the rule a saved centre is read back with. The map's own
    // centre always passes it.
    const center: MapCenter = toMapCenter(view.center) ?? view.center;
    const state: SavedState = {
      schemaVersion: STATE_SCHEMA_VERSION,
      center,
      // Saved state and links keep the zoom unit they have always had, one
      // above the map's, so a link shared before the map library changed
      // still shows the same area. MapApp converts back on restore.
      zoom: mapZoomToState(view.zoom),
      bearing: view.bearing,
      pitch: view.pitch,
      globeVisible: this.app.globeVisible,
      threeDVisible: this.app.threeDVisible,
      satelliteVisible: this.app.satelliteVisible,
      heatmapVisible: this.app.heatmapVisible,
      altitudeVisible: this.app.altitudeVisible,
      airspeedVisible: this.app.airspeedVisible,
      airportsVisible: this.app.airportsVisible,
      aviationVisible: this.app.aviationVisible,
      selectedYear: this.app.selectedYear,
      selectedAircraft: this.app.selectedAircraft,
      selectedPathIds: Array.from(this.app.selectedPathIds),
      statsPanelVisible: this.panelVisible("statsPanelVisible"),
      wrappedVisible: this.panelVisible("wrappedVisible"),
      isolateSelection: this.app.isolateSelection,
      // Replay state is not persisted: too complex to restore reliably
    };
    try {
      localStorage.setItem(storageKey(), JSON.stringify(state));
    } catch (_e) {
      // Silently fail if localStorage is not available
    }

    // Update URL to reflect current state (for shareable links)
    this.updateUrl(state);
  }

  loadMapState(): SavedState | null {
    try {
      const key = storageKey();
      let saved = localStorage.getItem(key);
      if (!saved && key !== STORAGE_KEY) {
        // Releases before the per-directory key saved every map under the
        // plain key; the first map to find it there adopts it once
        saved = localStorage.getItem(STORAGE_KEY);
        if (saved) {
          localStorage.setItem(key, saved);
          localStorage.removeItem(STORAGE_KEY);
        }
      }
      if (saved) {
        const parsed: unknown = JSON.parse(saved);
        const state = sanitizeSavedState(parsed);
        // A view that did not survive the check is no reason to lose the
        // year, the selection and the layers saved with it: without a centre
        // the map opens on the bounds of the data, as it does without any
        // saved state. Only an entry nothing is left of counts as corrupt.
        return Object.keys(state).length > 0 ? state : null;
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
