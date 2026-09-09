/**
 * Path Selection - Handles path selection logic
 */
import type { MapApp } from "../mapApp";
import { applyToggleButtonState } from "../utils/buttonState";
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
    const wasIsolating = this.app.isolateSelection;
    if (this.app.selectedPathIds.size === 0 && this.app.isolateSelection) {
      this.app.isolateSelection = false;
    }

    this.afterSelectionChange(wasIsolating);
  }

  selectPathsByAirport(airportName: string): void {
    const pathIds = this.app.airportToPaths[airportName];
    if (pathIds) {
      pathIds.forEach((pathId) => {
        this.app.selectedPathIds.add(pathId);
      });
      this.app.store.notifyMutation("selectedPathIds");
    }

    this.afterSelectionChange();
  }

  clearSelection(): void {
    this.app.selectedPathIds.clear();
    this.app.store.notifyMutation("selectedPathIds");

    // Disable isolate mode when selection is cleared
    const wasIsolating = this.app.isolateSelection;
    if (this.app.isolateSelection) {
      this.app.isolateSelection = false;
    }

    this.afterSelectionChange(wasIsolating);
  }

  toggleIsolateSelection(): void {
    if (this.app.selectedPathIds.size === 0) return;

    this.app.isolateSelection = !this.app.isolateSelection;
    this.updateIsolateButton();

    // Isolate mode changes which paths/coordinates are drawn: rebuild
    this.app.dataManager.updateLayers().catch(logError);
  }

  /**
   * Apply a selection change: when isolate mode is active before or after the
   * change the layers are rebuilt (isolate mode draws only the selected
   * paths, so both entering and leaving it changes which paths exist),
   * otherwise the drawn polylines are restyled in place. Statistics and
   * airport visibility are refreshed in both cases.
   */
  private afterSelectionChange(wasIsolating = this.app.isolateSelection): void {
    this.updateIsolateButton();
    this.app.replayManager.updateReplayButtonState();

    if (this.app.isolateSelection || wasIsolating) {
      // updateLayers refreshes stats and airport visibility itself
      this.app.dataManager.updateLayers().catch(logError);
      return;
    }

    this.app.layerManager.updateSelectionStyles();
    if (this.app.altitudeVisible || this.app.airspeedVisible) {
      invalidateMapWithDelay(this.app.map);
    }
    this.app.statsManager.updateStatsForSelection();
    this.app.airportManager.updateAirportOpacity();
  }

  updateIsolateButton(): void {
    const btn = domCache.get("isolate-btn");
    if (!btn) return;

    const hasSelection = this.app.selectedPathIds.size > 0;
    applyToggleButtonState(btn, this.app.isolateSelection);

    if (this.app.isolateSelection) {
      btn.style.borderColor = "var(--color-accent-blue)";
    } else {
      btn.style.opacity = hasSelection ? "1.0" : "0.5";
      btn.style.borderColor = "var(--color-border)";
    }
    btn.style.backgroundColor = "var(--color-bg-secondary)";
  }
}
