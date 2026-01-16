/**
 * Path Selection - Handles path selection logic
 */
import type { MapApp } from "../mapApp";

export class PathSelection {
  private app: MapApp;

  constructor(app: MapApp) {
    this.app = app;
  }

  togglePathSelection(pathId: string): void {
    if (this.app.selectedPathIds.has(pathId)) {
      this.app.selectedPathIds.delete(pathId);
    } else {
      this.app.selectedPathIds.add(pathId);
    }

    // Redraw paths with delay for mobile Safari
    if (this.app.altitudeVisible) {
      this.app.layerManager!.redrawAltitudePaths();
      setTimeout(() => {
        this.app.map!.invalidateSize();
      }, 50);
    }
    if (this.app.airspeedVisible) {
      this.app.layerManager!.redrawAirspeedPaths();
      setTimeout(() => {
        this.app.map!.invalidateSize();
      }, 50);
    }

    this.app.replayManager!.updateReplayButtonState();
    this.app.stateManager!.saveMapState();
  }

  selectPathsByAirport(airportName: string): void {
    const pathIds = this.app.airportToPaths[airportName];
    if (pathIds) {
      pathIds.forEach((pathId) => {
        this.app.selectedPathIds.add(pathId);
      });
    }

    // Redraw paths with delay for mobile Safari
    if (this.app.altitudeVisible) {
      this.app.layerManager!.redrawAltitudePaths();
      setTimeout(() => {
        this.app.map!.invalidateSize();
      }, 50);
    }
    if (this.app.airspeedVisible) {
      this.app.layerManager!.redrawAirspeedPaths();
      setTimeout(() => {
        this.app.map!.invalidateSize();
      }, 50);
    }

    this.app.replayManager!.updateReplayButtonState();
    this.app.stateManager!.saveMapState();
  }

  clearSelection(): void {
    this.app.selectedPathIds.clear();

    // Redraw paths with a small delay for mobile Safari touch event handling
    if (this.app.altitudeVisible) {
      this.app.layerManager!.redrawAltitudePaths();
      // Force map to recognize new interactive elements on mobile Safari
      setTimeout(() => {
        this.app.map!.invalidateSize();
      }, 50);
    }
    if (this.app.airspeedVisible) {
      this.app.layerManager!.redrawAirspeedPaths();
      // Force map to recognize new interactive elements on mobile Safari
      setTimeout(() => {
        this.app.map!.invalidateSize();
      }, 50);
    }

    this.app.replayManager!.updateReplayButtonState();
    this.app.stateManager!.saveMapState();
  }
}
