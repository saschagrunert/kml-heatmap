/**
 * Replay state data class - groups all replay-related properties.
 */
import type { Marker, Popup } from "maplibre-gl";
import type { PathSegment, PopupHost, TrailRun } from "../types";

/**
 * The airplane on the map. MapLibre's marker knows nothing of popups the way
 * the app uses them (`setPopup` toggles a second time on the same click), so
 * the marker and its popup are wrapped, like the airports are. Only the
 * shape lives here: this file is part of the main bundle, the airplane
 * itself comes with the feature bundle (see ReplayRenderer).
 */
export interface ReplayAirplane extends PopupHost {
  readonly marker: Marker;
  readonly popup: Popup;
  /** Latitude first, like the rest of the app */
  getLatLng(): [lat: number, lon: number];
  /** Move the airplane, and its popup with it while that is open */
  setLatLng(position: readonly [lat: number, lon: number]): void;
  /** The marker's element: a real button, so it takes focus and Enter */
  getElement(): HTMLButtonElement;
  setPopupContent(html: string): void;
  /** Take the marker and its popup off the map */
  remove(): void;
}

export class ReplayState {
  active = false;
  playing = false;
  currentTime = 0;
  maxTime = 0;
  speed = 50.0;
  /** Whether the replay sources hold this replay's route and trail */
  layerActive = false;
  segments: PathSegment[] = [];
  airplaneMarker: ReplayAirplane | null = null;
  /** Index of the last segment drawn on the trail */
  lastDrawnIndex = -1;
  /** The trail flown so far as runs of one colour, in flight order */
  trailRuns: TrailRun[] = [];
  /** Set when the trail changed and the map has not been told yet */
  trailDirty = false;
  /** Index of the segment the airplane is currently on (-1 before start) */
  currentIndex = -1;
  lastBearing: number | null = null;
  animationFrameId: number | null = null;
  lastFrameTime: number | null = null;
  colorMinAlt = 0;
  colorMaxAlt = 10000;
  colorMinSpeed = 0;
  colorMaxSpeed = 200;
  autoZoom = false;
  recenterTimestamps: number[] = [];
  /** Wall-clock time before which pans count as the same recenter */
  recenterPanEndsAt = 0;
  /** Wall-clock time of the last pan triggered by a manual seek */
  lastSeekPanTime = 0;

  resetDrawState(): void {
    this.currentTime = 0;
    // An emptied trail is a change the map has to hear of
    if (this.trailRuns.length > 0) this.trailDirty = true;
    this.lastDrawnIndex = -1;
    this.trailRuns = [];
    this.currentIndex = -1;
    this.lastBearing = null;
    this.recenterTimestamps = [];
    this.recenterPanEndsAt = 0;
    this.lastSeekPanTime = 0;
  }
}
