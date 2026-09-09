/**
 * Replay Renderer - Handles rendering concerns for flight replay
 */
import * as L from "leaflet";
import type { MapApp } from "../mapApp";
import type { ReplayManager } from "./replayManager";
import type { PathSegment } from "../types";
import { domCache } from "../utils/domCache";
import { generateSegmentPopupHtml } from "../utils/htmlGenerators";
import { formatTime } from "../utils/formatters";
import { getColorForAirspeed, getColorForAltitude } from "../utils/colors";
import { calculateBearing } from "../utils/geometry";
import { calculateSmoothedBearing } from "../features/replay";

/** Minimum interval between map pans triggered by slider drags */
export const SEEK_PAN_THROTTLE_MS = 250;

/** Fraction of the viewport used as the "near edge" margin for auto-panning */
const EDGE_MARGIN_FRACTION = 0.1;

/**
 * Find the index of the last segment whose time is at or before currentTime.
 * Returns -1 when no segment has started yet.
 */
export function findSegmentIndexAtTime(
  segments: PathSegment[],
  currentTime: number,
): number {
  let lo = 0;
  let hi = segments.length - 1;
  let result = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if ((segments[mid]?.time ?? 0) <= currentTime) {
      result = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return result;
}

export class ReplayRenderer {
  private app: MapApp;

  constructor(app: MapApp) {
    this.app = app;
  }

  /**
   * Update (or create) the airplane popup with the data of the segment at
   * the current replay time. Pass the already known segment index to avoid
   * a second lookup when called from the frame loop.
   */
  updateAirplanePopup(replayManager: ReplayManager, index?: number): void {
    const state = replayManager.state;
    if (!state.airplaneMarker || !state.active) return;

    const segments = state.segments;
    if (segments.length === 0) return;

    const idx = index ?? findSegmentIndexAtTime(segments, state.currentTime);
    const currentSegment = segments[idx] ?? segments[0];
    if (!currentSegment) return;

    const popupContent = generateSegmentPopupHtml({
      segment: currentSegment,
      altMin: state.colorMinAlt,
      altMax: state.colorMaxAlt,
      speedMin: state.colorMinSpeed,
      speedMax: state.colorMaxSpeed,
      title: "Current Position",
      icon: "✈️",
    });

    const popup = state.airplaneMarker.getPopup();
    if (!popup) {
      state.airplaneMarker.bindPopup(popupContent, {
        autoPanPadding: [50, 50],
      });
    } else {
      popup.setContent(popupContent);
    }

    state.airplaneMarker.openPopup();
  }

  updateDisplay(
    replayManager: ReplayManager,
    isManualSeek: boolean = false,
  ): void {
    const state = replayManager.state;
    const segments = state.segments;
    const currentTime = state.currentTime;
    const currentLabel = formatTime(currentTime);
    const maxLabel = formatTime(state.maxTime);

    // Update time display
    const timeDisplay = domCache.get("replay-time-display");
    if (timeDisplay) {
      timeDisplay.textContent = currentLabel + " / " + maxLabel;
    }

    // Update slider position and its spoken value
    const slider = domCache.get("replay-slider") as HTMLInputElement | null;
    if (slider) {
      slider.value = currentTime.toString();
      // Rewriting this every frame would make screen readers announce
      // continuously, so only do it when the spoken value changes
      const valueText = currentLabel + " of " + maxLabel;
      if (slider.getAttribute("aria-valuetext") !== valueText) {
        slider.setAttribute("aria-valuetext", valueText);
      }
    }

    const sliderStart = domCache.get("replay-slider-start");
    if (sliderStart) sliderStart.textContent = currentLabel;

    // Find current position in replay timeline (for airplane positioning)
    const currentIndex = this.locateCurrentIndex(state, isManualSeek);
    state.currentIndex = currentIndex;
    const lastSegment =
      currentIndex >= 0 ? (segments[currentIndex] ?? null) : null;
    const nextSegment =
      currentIndex >= 0 ? (segments[currentIndex + 1] ?? null) : null;

    this.drawNewSegments(replayManager);

    // Update airplane marker position and rotation
    const marker = state.airplaneMarker;
    const map = this.app.map;
    if (!marker || !map) return;

    // Ensure marker is on the map (in case it was removed during seeking/zooming)
    if (!map.hasLayer(marker)) {
      marker.addTo(map);
    }

    if (!lastSegment) {
      const startCoords = segments[0]?.coords?.[0];
      if (startCoords) marker.setLatLng([startCoords[0], startCoords[1]]);
      return;
    }

    let currentPos: [number, number];
    let bearing: number;

    if (nextSegment && (lastSegment.time ?? 0) < currentTime) {
      // Interpolate between last and next segment
      const timeFraction =
        (currentTime - (lastSegment.time ?? 0)) /
        ((nextSegment.time ?? 0) - (lastSegment.time ?? 0));
      const lat1 = lastSegment.coords?.[1]?.[0] ?? 0;
      const lon1 = lastSegment.coords?.[1]?.[1] ?? 0;
      const lat2 = nextSegment.coords?.[0]?.[0] ?? 0;
      const lon2 = nextSegment.coords?.[0]?.[1] ?? 0;

      currentPos = [
        lat1 + (lat2 - lat1) * timeFraction,
        lon1 + (lon2 - lon1) * timeFraction,
      ];
      bearing = calculateBearing(lat1, lon1, lat2, lon2);
    } else {
      // Use end of last segment
      currentPos = lastSegment.coords?.[1] ?? [0, 0];
      const lat1 = lastSegment.coords?.[0]?.[0] ?? 0;
      const lon1 = lastSegment.coords?.[0]?.[1] ?? 0;
      const lat2 = lastSegment.coords?.[1]?.[0] ?? 0;
      const lon2 = lastSegment.coords?.[1]?.[1] ?? 0;
      bearing = calculateBearing(lat1, lon1, lat2, lon2);
    }

    // Smooth the heading by looking ahead several segments
    const smoothedBearing = calculateSmoothedBearing(segments, currentIndex, 5);
    if (smoothedBearing !== null) {
      bearing = smoothedBearing;
      state.lastBearing = bearing;
    } else if (state.lastBearing !== null) {
      bearing = state.lastBearing;
    }

    marker.setLatLng(currentPos);

    if (state.playing || isManualSeek) {
      this.keepAirplaneInView(replayManager, currentPos, isManualSeek);
    }

    // Update rotation using hardware-accelerated transforms
    const iconDiv = marker.getElement()?.querySelector(".replay-airplane-icon");
    if (iconDiv instanceof HTMLElement) {
      iconDiv.style.transform =
        "translate3d(0,0,0) rotate(" + (bearing - 45) + "deg)";
    }

    // Update popup content if it is open
    if (marker.getPopup() && marker.isPopupOpen()) {
      this.updateAirplanePopup(replayManager, currentIndex);
    }
  }

  /**
   * Determine the segment index for the current time. Uses an incremental
   * forward scan from the previous index while playing and a binary search
   * for seeks or when the time moved backwards.
   */
  private locateCurrentIndex(
    state: ReplayManager["state"],
    isManualSeek: boolean,
  ): number {
    const segments = state.segments;
    const currentTime = state.currentTime;
    const previous = state.currentIndex;
    const canScan =
      !isManualSeek &&
      previous >= 0 &&
      previous < segments.length &&
      (segments[previous]?.time ?? 0) <= currentTime;

    if (!canScan) return findSegmentIndexAtTime(segments, currentTime);

    let index = previous;
    for (let i = previous + 1; i < segments.length; i++) {
      if ((segments[i]?.time ?? 0) <= currentTime) {
        index = i;
      } else {
        break;
      }
    }
    return index;
  }

  /** Draw segments that became visible since the last frame */
  private drawNewSegments(replayManager: ReplayManager): void {
    const state = replayManager.state;
    const layer = state.layer;
    if (!layer) return;

    // Nothing is drawn at time 0 (stopped/reset state)
    if (state.currentTime <= 0) return;

    const useAirspeedColors =
      this.app.airspeedVisible && !this.app.altitudeVisible;

    const segments = state.segments;
    for (let i = state.lastDrawnIndex + 1; i < segments.length; i++) {
      const seg = segments[i];
      if (!seg) continue;
      if ((seg.time ?? 0) > state.currentTime) break;

      const color =
        useAirspeedColors && (seg.groundspeed_knots ?? 0) > 0
          ? getColorForAirspeed(
              seg.groundspeed_knots ?? 0,
              state.colorMinSpeed,
              state.colorMaxSpeed,
            )
          : getColorForAltitude(
              seg.altitude_ft ?? 0,
              state.colorMinAlt,
              state.colorMaxAlt,
            );

      const polyline = L.polyline(seg.coords ?? [], {
        color,
        weight: 3,
        opacity: 0.8,
      }).addTo(layer);

      state.drawnLayers.push(polyline);
      state.lastDrawnIndex = i;
    }
  }

  /**
   * Remove the polylines drawn past the given time. Seeking backwards this
   * way costs one removal per undrawn segment instead of a full redraw.
   */
  removeSegmentsAfter(replayManager: ReplayManager, time: number): void {
    const state = replayManager.state;
    const layer = state.layer;
    while (state.lastDrawnIndex >= 0) {
      const seg = state.segments[state.lastDrawnIndex];
      if (seg && (seg.time ?? 0) <= time) break;
      const polyline = state.drawnLayers.pop();
      if (polyline && layer) layer.removeLayer(polyline);
      state.lastDrawnIndex--;
    }
  }

  /**
   * Pan the map when the airplane approaches the viewport edge. During
   * slider drags pans are throttled and not animated; auto zoom-out only
   * reacts to recenters that happen while playing.
   */
  private keepAirplaneInView(
    replayManager: ReplayManager,
    currentPos: [number, number],
    isManualSeek: boolean,
  ): void {
    const state = replayManager.state;
    const map = this.app.map;
    if (!map) return;

    const mapSize = map.getSize();
    const point = map.latLngToContainerPoint(currentPos);
    const marginX = mapSize.x * EDGE_MARGIN_FRACTION;
    const marginY = mapSize.y * EDGE_MARGIN_FRACTION;

    const nearEdge =
      point.x < marginX ||
      point.x > mapSize.x - marginX ||
      point.y < marginY ||
      point.y > mapSize.y - marginY;
    if (!nearEdge) return;

    const now = Date.now();
    if (isManualSeek) {
      const outsideViewport =
        point.x < 0 ||
        point.x > mapSize.x ||
        point.y < 0 ||
        point.y > mapSize.y;
      const throttled = now - state.lastSeekPanTime < SEEK_PAN_THROTTLE_MS;
      if (throttled && !outsideViewport) return;
      state.lastSeekPanTime = now;
      map.panTo(currentPos, { animate: false });
      return;
    }

    map.panTo(currentPos, {
      animate: true,
      duration: 0.5,
      easeLinearity: 0.25,
      noMoveStart: true,
    });

    const cutoffTime = now - 30000;
    state.recenterTimestamps = state.recenterTimestamps.filter(
      (ts) => ts > cutoffTime,
    );
    state.recenterTimestamps.push(now);

    // Zoom out when the map had to recenter frequently in a short time
    if (!state.autoZoom || state.recenterTimestamps.length <= 2) return;
    const fiveSecondsAgo = now - 5000;
    const recentRecenters = state.recenterTimestamps.filter(
      (ts) => ts >= fiveSecondsAgo,
    );
    if (recentRecenters.length <= 2) return;
    if (state.lastZoom === null || state.lastZoom <= 9) return;

    const newZoom = Math.max(9, state.lastZoom - 1);
    map.setZoom(newZoom, { animate: true, duration: 0.5 });
    state.lastZoom = newZoom;
    state.recenterTimestamps = [];
  }
}
