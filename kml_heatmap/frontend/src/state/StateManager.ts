/**
 * State management for map application
 */

import type { MapState, LayerVisibility, ReplayState } from "../types";

const STORAGE_KEY = "kml-heatmap-state";

export class StateManager {
  private layerVisibility: LayerVisibility = {
    heatmap: true,
    altitude: false,
    airspeed: false,
    airports: true,
    aviation: false,
  };

  private replayState: ReplayState = {
    active: false,
    playing: false,
    currentTime: 0,
    maxTime: 0,
    speed: 50.0,
    interval: null,
    layer: null,
    segments: [],
    airplaneMarker: null,
    lastDrawnIndex: -1,
    lastBearing: null,
    animationFrameId: null,
    lastFrameTime: null,
    colorMinAlt: 0,
    colorMaxAlt: 10000,
    colorMinSpeed: 0,
    colorMaxSpeed: 200,
    autoZoom: false,
    lastZoom: null,
    recenterTimestamps: [],
  };

  private selectedYear = "all";
  private selectedAircraft = "all";
  private selectedPathIds = new Set<string>();

  /**
   * Save current state to localStorage
   */
  saveState(map: L.Map): void {
    const state: MapState = {
      center: map.getCenter(),
      zoom: map.getZoom(),
      heatmapVisible: this.layerVisibility.heatmap,
      altitudeVisible: this.layerVisibility.altitude,
      airspeedVisible: this.layerVisibility.airspeed,
      airportsVisible: this.layerVisibility.airports,
      aviationVisible: this.layerVisibility.aviation,
      selectedYear: this.selectedYear,
      selectedAircraft: this.selectedAircraft,
      selectedPathIds: Array.from(this.selectedPathIds),
      statsPanelVisible:
        document.getElementById("stats-panel")?.classList.contains("visible") ??
        false,
      replayActive: this.replayState.active,
      replayPlaying: this.replayState.playing,
      replayCurrentTime: this.replayState.currentTime,
      replaySpeed: this.replayState.speed,
      replayAutoZoom: this.replayState.autoZoom,
    };

    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // Silently fail if localStorage is not available
    }
  }

  /**
   * Load state from localStorage
   */
  loadState(): MapState | null {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        return JSON.parse(saved) as MapState;
      }
    } catch {
      // Silently fail if localStorage is not available or data is corrupt
    }
    return null;
  }

  /**
   * Restore state from saved data
   */
  restoreState(savedState: MapState | null): void {
    if (!savedState) return;

    this.layerVisibility.heatmap = savedState.heatmapVisible ?? true;
    this.layerVisibility.altitude = savedState.altitudeVisible ?? false;
    this.layerVisibility.airspeed = savedState.airspeedVisible ?? false;
    this.layerVisibility.airports = savedState.airportsVisible ?? true;
    this.layerVisibility.aviation = savedState.aviationVisible ?? false;
    this.selectedYear = savedState.selectedYear ?? "all";
    this.selectedAircraft = savedState.selectedAircraft ?? "all";
    this.selectedPathIds = new Set(savedState.selectedPathIds ?? []);
    this.replayState.currentTime = savedState.replayCurrentTime ?? 0;
    this.replayState.speed = savedState.replaySpeed ?? 50.0;
    this.replayState.autoZoom = savedState.replayAutoZoom ?? false;
  }

  // Getters
  getLayerVisibility(): LayerVisibility {
    return { ...this.layerVisibility };
  }

  getReplayState(): ReplayState {
    return this.replayState;
  }

  getSelectedYear(): string {
    return this.selectedYear;
  }

  getSelectedAircraft(): string {
    return this.selectedAircraft;
  }

  getSelectedPathIds(): Set<string> {
    return new Set(this.selectedPathIds);
  }

  // Setters
  setLayerVisibility(layer: keyof LayerVisibility, visible: boolean): void {
    this.layerVisibility[layer] = visible;
  }

  setSelectedYear(year: string): void {
    this.selectedYear = year;
  }

  setSelectedAircraft(aircraft: string): void {
    this.selectedAircraft = aircraft;
  }

  togglePathSelection(pathId: string): boolean {
    if (this.selectedPathIds.has(pathId)) {
      this.selectedPathIds.delete(pathId);
      return false;
    } else {
      this.selectedPathIds.add(pathId);
      return true;
    }
  }

  clearPathSelection(): void {
    this.selectedPathIds.clear();
  }

  addPathsToSelection(pathIds: string[]): void {
    pathIds.forEach((id) => this.selectedPathIds.add(id));
  }
}
