/**
 * State Manager - Handles state persistence (localStorage, URL)
 */
import type { MapApp } from "../mapApp";
import { domCache } from "../utils/domCache";

interface SavedState {
  center: { lat: number; lng: number };
  zoom: number;
  heatmapVisible: boolean;
  altitudeVisible: boolean;
  airspeedVisible: boolean;
  airportsVisible: boolean;
  aviationVisible: boolean;
  selectedYear: string;
  selectedAircraft: string;
  selectedPathIds: number[];
  statsPanelVisible: boolean;
  wrappedVisible: boolean;
  buttonsHidden: boolean;
}

export class StateManager {
  private app: MapApp;

  constructor(app: MapApp) {
    this.app = app;

    // Pre-cache state-related elements
    domCache.cacheElements(["stats-panel", "wrapped-modal"]);
  }

  saveMapState(): void {
    if (!this.app.map) return;

    const statsPanelEl = domCache.get("stats-panel");
    const wrappedModalEl = domCache.get("wrapped-modal");
    const state: SavedState = {
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
      statsPanelVisible: statsPanelEl
        ? statsPanelEl.classList.contains("visible")
        : false,
      wrappedVisible: wrappedModalEl
        ? wrappedModalEl.style.display === "flex"
        : false,
      buttonsHidden: this.app.buttonsHidden,
      // Note: replay state is NOT persisted - too complex to restore reliably
    };
    try {
      localStorage.setItem("kml-heatmap-state", JSON.stringify(state));
    } catch (_e) {
      // Silently fail if localStorage is not available
    }

    // Update URL to reflect current state (for shareable links)
    this.updateUrl(state);
  }

  loadMapState(): SavedState | null {
    try {
      const saved = localStorage.getItem("kml-heatmap-state");
      if (saved) {
        return JSON.parse(saved) as SavedState;
      }
    } catch (_e) {
      // Silently fail if localStorage is not available or data is corrupt
    }
    return null;
  }

  /**
   * Update browser URL without reloading page
   * @param {Object} state - Current state object
   */
  updateUrl(state: SavedState): void {
    const urlParams = window.KMLHeatmap.encodeStateToUrl(state);
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
   * @returns {Object|null} State object to restore
   */
  loadState(): SavedState | null {
    // Priority 1: URL parameters
    const urlState = window.KMLHeatmap.parseUrlParams(
      new URLSearchParams(window.location.search)
    );
    if (urlState && Object.keys(urlState).length > 0) {
      return urlState as SavedState;
    }

    // Priority 2: localStorage
    return this.loadMapState();
  }
}
