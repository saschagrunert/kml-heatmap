/**
 * Replay state data class - groups all replay-related properties.
 */
import type { Marker, Popup } from "maplibre-gl";
import type { PathSegment, PopupHost, TrailRun } from "../types";
import type { RibbonPiece, SmoothedFlights } from "../calculations/lift";

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
  /**
   * Draw the airplane, and its popup, `px` above its position: at its
   * height in the 3D view (see airplaneLiftPx)
   */
  setLift(px: number): void;
  /** The marker's element: a real button, so it takes focus and Enter */
  getElement(): HTMLButtonElement;
  setPopupContent(html: string): void;
  /** Take the marker and its popup off the map */
  remove(): void;
}

/** Whether a replay runs is the store's `replayActive` */
export class ReplayState {
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
  /** The ground under each segment of the flight, in feet (groundProfileFt) */
  groundFt: Float64Array = new Float64Array(0);
  /** Whether the trail and the airplane are lifted: the 3D view is on */
  lifted = false;
  /**
   * The flight smoothed at its height, which the trail's ribbons are cut
   * from in the 3D view (see lift.ts); null while it is flat
   */
  smoothed: SmoothedFlights | null = null;
  /**
   * The ribbon pieces of each run of the trail, as last cut: a run that has
   * not grown since, at the same width, is not cut again (see
   * trailFeatureCollection)
   */
  trailPieces = new WeakMap<
    TrailRun,
    { lastIndex: number; widthZoom: number; pieces: RibbonPiece[] }
  >();
  /** The zoom the trail's ribbons were last written for, null for none */
  trailWidthZoom: number | null = null;
  /** The source the trail was last written to, its line's or its ribbons' */
  trailWrittenTo: string | null = null;
  /**
   * The airplane's height above the flight's ground where it is now, null
   * while it is not lifted; the camera follows it up there
   */
  airplaneHeightFt: number | null = null;
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
