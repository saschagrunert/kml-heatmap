/**
 * Path Selection - Handles path selection logic
 */
import type { MapApp } from "../mapApp";
import { invalidateMapWithDelay } from "../utils/mapHelpers";
import { logError } from "../utils/logger";

export class PathSelection {
  private app: MapApp;

  constructor(app: MapApp) {
    this.app = app;
  }

  togglePathSelection(pathId: number): void {
    if (this.app.selectedPathIds.has(pathId)) {
      this.app.selectedPathIds.delete(pathId);
    } else {
      this.app.selectedPathIds.add(pathId);
    }

    // If no paths remain selected, disable isolate mode
    if (this.app.selectedPathIds.size === 0 && this.app.isolateSelection) {
      this.app.isolateSelection = false;
      this.updateIsolateButton();
      // Rebuild heatmap since isolate mode changed
      this.app.dataManager.updateLayers().catch(logError);
    } else {
      this.updateIsolateButton();

      // Redraw paths with delay for mobile Safari
      if (this.app.altitudeVisible) {
        this.app.layerManager.redrawAltitudePaths();
        invalidateMapWithDelay(this.app.map);
      }
      if (this.app.airspeedVisible) {
        this.app.layerManager.redrawAirspeedPaths();
        invalidateMapWithDelay(this.app.map);
      }

      // If isolate mode is active, rebuild heatmap for the new selection
      if (this.app.isolateSelection) {
        this.app.dataManager.updateLayers().catch(logError);
      }
    }

    this.app.replayManager.updateReplayButtonState();
    this.app.stateManager.saveMapState();
  }

  selectPathsByAirport(airportName: string): void {
    const pathIds = this.app.airportToPaths[airportName];
    if (pathIds) {
      pathIds.forEach((pathId) => {
        this.app.selectedPathIds.add(pathId);
      });
    }

    this.updateIsolateButton();

    // Redraw paths with delay for mobile Safari
    if (this.app.altitudeVisible) {
      this.app.layerManager.redrawAltitudePaths();
      invalidateMapWithDelay(this.app.map);
    }
    if (this.app.airspeedVisible) {
      this.app.layerManager.redrawAirspeedPaths();
      invalidateMapWithDelay(this.app.map);
    }

    // If isolate mode is active, rebuild heatmap for the new selection
    if (this.app.isolateSelection) {
      this.app.dataManager.updateLayers().catch(logError);
    }

    this.app.replayManager.updateReplayButtonState();
    this.app.stateManager.saveMapState();
  }

  clearSelection(): void {
    this.app.selectedPathIds.clear();

    // Disable isolate mode when selection is cleared
    if (this.app.isolateSelection) {
      this.app.isolateSelection = false;
      this.updateIsolateButton();
      // Rebuild heatmap since isolate mode changed
      this.app.dataManager.updateLayers().catch(logError);
    } else {
      this.updateIsolateButton();

      // Redraw paths with a small delay for mobile Safari touch event handling
      if (this.app.altitudeVisible) {
        this.app.layerManager.redrawAltitudePaths();
        invalidateMapWithDelay(this.app.map);
      }
      if (this.app.airspeedVisible) {
        this.app.layerManager.redrawAirspeedPaths();
        invalidateMapWithDelay(this.app.map);
      }
    }

    this.app.replayManager.updateReplayButtonState();
    this.app.stateManager.saveMapState();
  }

  toggleIsolateSelection(): void {
    if (this.app.selectedPathIds.size === 0) return;

    this.app.isolateSelection = !this.app.isolateSelection;
    this.updateIsolateButton();

    // Rebuild heatmap to filter coordinates by selection
    this.app.dataManager.updateLayers().catch(logError);

    this.app.stateManager.saveMapState();
  }

  updateIsolateButton(): void {
    const btn = document.getElementById("isolate-btn");
    if (!btn) return;

    const hasSelection = this.app.selectedPathIds.size > 0;

    if (this.app.isolateSelection) {
      btn.style.opacity = "1.0";
      btn.style.borderColor = "#4facfe";
      btn.style.backgroundColor = "#1a3a5c";
    } else if (hasSelection) {
      btn.style.opacity = "1.0";
      btn.style.borderColor = "#555";
      btn.style.backgroundColor = "#2b2b2b";
    } else {
      btn.style.opacity = "0.5";
      btn.style.borderColor = "#555";
      btn.style.backgroundColor = "#2b2b2b";
    }
  }
}
