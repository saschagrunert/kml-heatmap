/**
 * State Manager - Handles state persistence (localStorage, URL)
 */
import type { MapApp } from "../mapApp";

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
  }

  saveMapState(): void {
    if (!this.app.map) return;

    const statsPanelEl = document.getElementById("stats-panel");
    const wrappedModalEl = document.getElementById("wrapped-modal");
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
        return JSON.parse(saved);
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
    const urlParams = (window as any).KMLHeatmap.encodeStateToUrl(state);
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
    const urlState = (window as any).KMLHeatmap.parseUrlParams(
      new URLSearchParams(window.location.search)
    );
    if (urlState && Object.keys(urlState).length > 0) {
      return urlState;
    }

    // Priority 2: localStorage
    return this.loadMapState();
  }
}
