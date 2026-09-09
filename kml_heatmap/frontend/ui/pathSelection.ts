/**
 * Path Selection - Handles path selection logic
 */
import type { MapApp } from "../mapApp";
import { domCache } from "../utils/domCache";
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
    this.app.store.notifyMutation("selectedPathIds");

    // If no paths remain selected, disable isolate mode
    if (this.app.selectedPathIds.size === 0 && this.app.isolateSelection) {
      this.app.isolateSelection = false;
      this.updateIsolateButton();
      this.app.dataManager.updateLayers().catch(logError);
    } else if (this.app.isolateSelection) {
      this.updateIsolateButton();
      // updateLayers calls redrawPaths, so skip separate redrawVisiblePaths
      this.app.dataManager.updateLayers().catch(logError);
    } else {
      this.updateIsolateButton();
      this.redrawVisiblePaths();
    }

    this.app.replayManager.updateReplayButtonState();
  }

  selectPathsByAirport(airportName: string): void {
    const pathIds = this.app.airportToPaths[airportName];
    if (pathIds) {
      pathIds.forEach((pathId) => {
        this.app.selectedPathIds.add(pathId);
      });
      this.app.store.notifyMutation("selectedPathIds");
    }

    this.updateIsolateButton();

    if (this.app.isolateSelection) {
      this.app.dataManager.updateLayers().catch(logError);
    } else {
      this.redrawVisiblePaths();
    }

    this.app.replayManager.updateReplayButtonState();
  }

  clearSelection(): void {
    this.app.selectedPathIds.clear();
    this.app.store.notifyMutation("selectedPathIds");

    // Disable isolate mode when selection is cleared
    if (this.app.isolateSelection) {
      this.app.isolateSelection = false;
      this.updateIsolateButton();
      this.app.dataManager.updateLayers().catch(logError);
    } else {
      this.updateIsolateButton();
      this.redrawVisiblePaths();
    }

    this.app.replayManager.updateReplayButtonState();
  }

  toggleIsolateSelection(): void {
    if (this.app.selectedPathIds.size === 0) return;

    this.app.isolateSelection = !this.app.isolateSelection;
    this.updateIsolateButton();

    // Rebuild heatmap to filter coordinates by selection
    this.app.dataManager.updateLayers().catch(logError);
  }

  private redrawVisiblePaths(): void {
    if (this.app.altitudeVisible) {
      this.app.layerManager.redrawAltitudePaths();
      invalidateMapWithDelay(this.app.map);
    }
    if (this.app.airspeedVisible) {
      this.app.layerManager.redrawAirspeedPaths();
      invalidateMapWithDelay(this.app.map);
    }
  }

  updateIsolateButton(): void {
    const btn = domCache.get("isolate-btn");
    if (!btn) return;

    const hasSelection = this.app.selectedPathIds.size > 0;

    if (this.app.isolateSelection) {
      btn.style.opacity = "1.0";
      btn.style.borderColor = "var(--color-accent-blue)";
      btn.style.backgroundColor = "var(--color-bg-secondary)";
    } else if (hasSelection) {
      btn.style.opacity = "1.0";
      btn.style.borderColor = "var(--color-border)";
      btn.style.backgroundColor = "var(--color-bg-secondary)";
    } else {
      btn.style.opacity = "0.5";
      btn.style.borderColor = "var(--color-border)";
      btn.style.backgroundColor = "var(--color-bg-secondary)";
    }
  }
}
