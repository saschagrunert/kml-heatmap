/**
 * Replay state data class - groups all replay-related properties.
 */
import type * as L from "leaflet";
import type { PathSegment } from "../types";

export class ReplayState {
  active = false;
  playing = false;
  currentTime = 0;
  maxTime = 0;
  speed = 50.0;
  layer: L.LayerGroup | null = null;
  segments: PathSegment[] = [];
  airplaneMarker: L.Marker | null = null;
  /** Index of the last segment drawn on the replay layer */
  lastDrawnIndex = -1;
  /** Polylines drawn so far, in draw order, parallel to the segment indices */
  drawnLayers: L.Polyline[] = [];
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
  lastZoom: number | null = null;
  recenterTimestamps: number[] = [];
  /** Wall-clock time of the last pan triggered by a manual seek */
  lastSeekPanTime = 0;

  resetDrawState(): void {
    this.currentTime = 0;
    this.lastDrawnIndex = -1;
    this.drawnLayers = [];
    this.currentIndex = -1;
    this.lastBearing = null;
    this.recenterTimestamps = [];
    this.lastSeekPanTime = 0;
  }
}
