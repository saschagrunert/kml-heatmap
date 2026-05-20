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
  lastDrawnIndex = -1;
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

  resetDrawState(): void {
    this.currentTime = 0;
    this.lastDrawnIndex = -1;
    this.lastBearing = null;
    this.recenterTimestamps = [];
  }
}
