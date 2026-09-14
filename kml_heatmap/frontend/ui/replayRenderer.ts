/**
 * Replay Renderer - Handles rendering concerns for flight replay
 */
import * as L from "leaflet";
import type { MapApp } from "../mapApp";
import type { ReplayManager } from "./replayManager";
import type { ReplayState } from "./replayState";
import type { PathSegment } from "../types";
import { domCache } from "../utils/domCache";
import { generateSegmentPopupHtml } from "../utils/htmlGenerators";
import { formatNumber, formatSpeed, formatTime } from "../utils/formatters";
import { FEET_TO_METERS, NAUTICAL_MILES_TO_KM } from "../utils/constants";
import { getColorForAirspeed, getColorForAltitude } from "../utils/colors";
import { calculateBearing } from "../utils/geometry";
import { calculateSmoothedBearing } from "../features/replay";
import { prefersReducedMotion } from "../utils/motion";

/** Minimum interval between map pans triggered by slider drags */
export const SEEK_PAN_THROTTLE_MS = 250;

/** Duration of the pan that brings the airplane back into view (seconds) */
export const RECENTER_PAN_DURATION_S = 0.5;

/** Auto-zoom does not zoom out beyond this level */
const AUTO_ZOOM_MIN = 9;

/**
 * Most levels one auto zoom-out takes: Leaflet animates a zoom change of up
 * to four levels (its zoomAnimationThreshold) and jumps beyond that
 */
const AUTO_ZOOM_MAX_STEP = 4;

/**
 * Time before auto-zoom may zoom out again (ms). Leaflet's zoom animation
 * takes 250 ms, and a zoom asked for while it runs is dropped.
 */
export const AUTO_ZOOM_SETTLE_MS = 300;

/** Fraction of the viewport used as the "near edge" margin for auto-panning */
const EDGE_MARGIN_FRACTION = 0.1;

/** Shown in the readout while no segment has been reached */
const READOUT_PLACEHOLDER = "—";

/** Cells of the readout strip, in display order */
const READOUT_CELLS: [id: string, label: string][] = [
  ["replay-readout-altitude", "Altitude"],
  ["replay-readout-speed", "Groundspeed"],
  ["replay-readout-track", "Track"],
];

/** Metric counterpart of each readout cell; the track has no second unit */
const READOUT_ALT_CELLS: (string | null)[] = [
  "replay-readout-altitude-alt",
  "replay-readout-speed-alt",
  null,
];

/** Compass track for a bearing, normalised and zero padded ("072°") */
export function formatTrack(bearing: number): string {
  const normalised = ((Math.round(bearing) % 360) + 360) % 360;
  return String(normalised).padStart(3, "0") + "°";
}

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

/**
 * The rotation that shows `target` degrees after `previous`, turning the
 * short way. A CSS transition tweens the icon's raw angle, so writing the
 * heading as is spun the airplane almost a full turn whenever it crossed
 * north (350 to 10 degrees went back through 180).
 */
export function unwrapRotation(
  previous: number | null,
  target: number,
): number {
  if (previous === null) return target;
  const delta = ((((target - previous) % 360) + 540) % 360) - 180;
  return previous + delta;
}

/**
 * Levels to zoom out by once the airplane has left the map. It left because
 * it outruns the pan at this zoom, and how far outside it got says by how
 * much: each level out halves its speed on screen.
 */
export function zoomOutSteps(
  point: { x: number; y: number },
  size: { x: number; y: number },
): number {
  const halfX = size.x / 2;
  const halfY = size.y / 2;
  const ratio = Math.max(
    Math.abs(point.x - halfX) / halfX,
    Math.abs(point.y - halfY) / halfY,
  );
  if (!(ratio > 1)) return 1;
  return Math.min(AUTO_ZOOM_MAX_STEP, Math.ceil(Math.log2(ratio)));
}

/**
 * Colour of one replay segment. Segments without a groundspeed fall back to
 * the altitude colour, so both draw paths cover exactly the same segments.
 */
export function replaySegmentColor(
  state: ReplayState,
  segment: PathSegment,
  useAirspeedColors: boolean,
): string {
  return useAirspeedColors && (segment.groundspeed_knots ?? 0) > 0
    ? getColorForAirspeed(
        segment.groundspeed_knots ?? 0,
        state.colorMinSpeed,
        state.colorMaxSpeed,
      )
    : getColorForAltitude(
        segment.altitude_ft ?? 0,
        state.colorMinAlt,
        state.colorMaxAlt,
      );
}

/**
 * Draw the segment at `index` on the replay layer and push it onto the trim
 * stack that a backward seek unwinds.
 */
export function drawReplaySegment(
  state: ReplayState,
  index: number,
  useAirspeedColors: boolean,
): void {
  const segment = state.segments[index];
  if (!segment || !state.layer) return;

  const polyline = L.polyline(segment.coords ?? [], {
    color: replaySegmentColor(state, segment, useAirspeedColors),
    weight: 3,
    opacity: 0.8,
  }).addTo(state.layer);

  state.drawnLayers.push(polyline);
  state.lastDrawnIndex = index;
}

/** The last values written to the transport row, so a frame that changes
 * nothing visible writes nothing */
interface TransportCache {
  timeText: string;
  sliderValue: string;
  startText: string;
}

export class ReplayRenderer {
  private app: MapApp;
  private transport: TransportCache = {
    timeText: "",
    sliderValue: "",
    startText: "",
  };
  /** The marker element whose rotating icon is cached, and that icon */
  private iconRoot: HTMLElement | null = null;
  private iconDiv: HTMLElement | null = null;
  private lastTransform = "";
  /** Unwrapped rotation of the icon in degrees (see unwrapRotation) */
  private rotation: number | null = null;
  /** Segment index the airplane popup content was last built for */
  private popupIndex = -1;
  /** Wall-clock time before which auto-zoom does not zoom out again */
  private autoZoomSettlesAt = 0;

  constructor(app: MapApp) {
    this.app = app;
  }

  /**
   * The rotating icon inside the airplane marker. Leaflet builds a new
   * element whenever the marker is (re)added to the map, so the lookup is
   * keyed on that element rather than on the marker and only runs when it
   * changes, not once per frame.
   */
  private airplaneIcon(marker: L.Marker): HTMLElement | null {
    const root = marker.getElement() ?? null;
    if (root !== this.iconRoot) {
      this.iconRoot = root;
      const found = root?.querySelector(".replay-airplane-icon");
      this.iconDiv = found instanceof HTMLElement ? found : null;
      this.lastTransform = "";
      this.rotation = null;
    }
    return this.iconDiv;
  }

  /**
   * Create the readout strip inside the replay panel once. It reports the
   * values of the current position, so it must never be a live region: the
   * frame loop writes it many times a second.
   */
  ensureReadout(panel: HTMLElement): HTMLElement {
    const existing = panel.querySelector<HTMLElement>(".replay-readout");
    if (existing) return existing;

    const strip = document.createElement("div");
    strip.className = "replay-readout";
    strip.id = "replay-readout";

    READOUT_CELLS.forEach(([id, label], index) => {
      const cell = document.createElement("div");
      cell.className = "replay-readout-cell";

      const name = document.createElement("span");
      name.className = "replay-readout-label";
      name.textContent = label;

      const value = document.createElement("span");
      value.className = "replay-readout-value";
      value.id = id;
      value.textContent = READOUT_PLACEHOLDER;

      cell.append(name, value);

      const altId = READOUT_ALT_CELLS[index];
      if (altId) {
        const alt = document.createElement("span");
        alt.className = "replay-readout-alt";
        alt.id = altId;
        alt.textContent = "";
        cell.append(alt);
      }
      strip.append(cell);
    });

    const inner = panel.querySelector("#replay-controls-inner");
    (inner ?? panel).append(strip);
    return strip;
  }

  /**
   * Write the values of the current position. Only changed cells are
   * touched, so a paused replay does not keep dirtying the DOM.
   */
  private updateReadout(segment: PathSegment | null, bearing: number): void {
    const feet = segment?.altitude_ft ?? 0;
    const knots = segment?.groundspeed_knots ?? 0;
    // Grouped digits, like the legends, the statistics panel and the segment
    // tooltip, rather than a fourth style
    const values: string[] = segment
      ? [formatNumber(feet) + " ft", formatSpeed(knots), formatTrack(bearing)]
      : [READOUT_PLACEHOLDER, READOUT_PLACEHOLDER, READOUT_PLACEHOLDER];
    // Every other surface pairs both unit systems, so this one does too
    const alts: string[] = segment
      ? [
          formatNumber(feet * FEET_TO_METERS) + " m",
          formatNumber(knots * NAUTICAL_MILES_TO_KM) + " km/h",
        ]
      : ["", ""];

    READOUT_CELLS.forEach(([id], index) => {
      const cell = domCache.get(id);
      const text = values[index] ?? READOUT_PLACEHOLDER;
      if (cell && cell.textContent !== text) cell.textContent = text;

      const altId = READOUT_ALT_CELLS[index];
      if (!altId) return;
      const altCell = domCache.get(altId);
      const altText = alts[index] ?? "";
      if (altCell && altCell.textContent !== altText) {
        altCell.textContent = altText;
      }
    });
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
    this.popupIndex = idx;

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
        autoPan: !state.playing,
      });
    } else {
      popup.setContent(popupContent);
    }

    if (!state.airplaneMarker.isPopupOpen()) state.airplaneMarker.openPopup();
  }

  /**
   * Let the airplane popup pan the map only while the replay is paused.
   * Leaflet's autoPan runs on every move of the marker the popup is bound
   * to and stops the map's running pan each time, so while playing the map
   * never caught up with the airplane. Without it when paused, though, a
   * click on an airplane near the top edge opened the popup off the map.
   */
  syncPopupAutoPan(replayManager: ReplayManager): void {
    const state = replayManager.state;
    const popup = state.airplaneMarker?.getPopup();
    if (popup) popup.options.autoPan = !state.playing;
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

    // The transport row is written only when its text changes: at 50x the
    // label changes a few times a second, the frame loop runs sixty
    const timeText = currentLabel + " / " + maxLabel;
    if (timeText !== this.transport.timeText) {
      this.transport.timeText = timeText;
      const timeDisplay = domCache.get("replay-time-display");
      if (timeDisplay) timeDisplay.textContent = timeText;
    }

    const slider = domCache.get("replay-slider", HTMLInputElement);
    if (slider) {
      const sliderValue = currentTime.toString();
      if (sliderValue !== this.transport.sliderValue) {
        this.transport.sliderValue = sliderValue;
        slider.value = sliderValue;
      }
      // Rewriting this every frame would make screen readers announce
      // continuously, so only do it when the spoken value changes
      const valueText = currentLabel + " of " + maxLabel;
      if (slider.getAttribute("aria-valuetext") !== valueText) {
        slider.setAttribute("aria-valuetext", valueText);
      }
    }

    if (currentLabel !== this.transport.startText) {
      this.transport.startText = currentLabel;
      const sliderStart = domCache.get("replay-slider-start");
      if (sliderStart) sliderStart.textContent = currentLabel;
    }

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
      this.updateReadout(null, 0);
      return;
    }

    // A segment's time is when it starts, so until the next segment's time
    // the airplane is on this one, moving from its first point to its
    // second. The last segment has no end time and is shown at its end.
    const lat1 = lastSegment.coords?.[0]?.[0] ?? 0;
    const lon1 = lastSegment.coords?.[0]?.[1] ?? 0;
    const lat2 = lastSegment.coords?.[1]?.[0] ?? 0;
    const lon2 = lastSegment.coords?.[1]?.[1] ?? 0;
    let fraction = 1;
    if (nextSegment) {
      const start = lastSegment.time ?? 0;
      const duration = (nextSegment.time ?? 0) - start;
      if (duration > 0) {
        fraction = Math.min(Math.max((currentTime - start) / duration, 0), 1);
      }
    }
    const currentPos: [number, number] = [
      lat1 + (lat2 - lat1) * fraction,
      lon1 + (lon2 - lon1) * fraction,
    ];
    let bearing = calculateBearing(lat1, lon1, lat2, lon2);

    // Smooth the heading by looking ahead several segments
    const smoothedBearing = calculateSmoothedBearing(segments, currentIndex, 5);
    if (smoothedBearing !== null) {
      bearing = smoothedBearing;
      state.lastBearing = bearing;
    } else if (state.lastBearing !== null) {
      bearing = state.lastBearing;
    }

    this.updateReadout(lastSegment, bearing);

    marker.setLatLng(currentPos);

    if (state.playing || isManualSeek) {
      this.keepAirplaneInView(replayManager, currentPos, isManualSeek);
    }

    // Update rotation using hardware-accelerated transforms; the same
    // heading as last frame is not written again
    const iconDiv = this.airplaneIcon(marker);
    if (iconDiv) {
      this.rotation = unwrapRotation(this.rotation, bearing - 45);
      const transform = "translate3d(0,0,0) rotate(" + this.rotation + "deg)";
      if (transform !== this.lastTransform) {
        this.lastTransform = transform;
        iconDiv.style.transform = transform;
      }
    }

    // The popup describes a segment, so an open one is rebuilt only once the
    // airplane has reached another segment, not on every frame
    if (
      marker.getPopup() &&
      marker.isPopupOpen() &&
      currentIndex !== this.popupIndex
    ) {
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
      drawReplaySegment(state, i, useAirspeedColors);
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
   * happens while playing.
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

    const outsideViewport =
      point.x < 0 || point.x > mapSize.x || point.y < 0 || point.y > mapSize.y;

    const now = Date.now();
    if (isManualSeek) {
      const throttled = now - state.lastSeekPanTime < SEEK_PAN_THROTTLE_MS;
      if (throttled && !outsideViewport) return;
      state.lastSeekPanTime = now;
      map.panTo(currentPos, { animate: false });
      return;
    }

    // The pan follows the airplane on every frame it is near the edge, which
    // keeps a fast replay in view
    const animate = !prefersReducedMotion();
    map.panTo(currentPos, {
      animate,
      duration: RECENTER_PAN_DURATION_S,
      easeLinearity: 0.25,
      noMoveStart: true,
    });

    // Those frames are one recenter, though, until a pan had its time to
    // move the map. Counted per frame, three frames in a row fired a burst
    // of zoom-outs that Leaflet dropped during its zoom animation.
    const newRecenter = now >= state.recenterPanEndsAt;
    if (newRecenter) {
      state.recenterPanEndsAt = now + RECENTER_PAN_DURATION_S * 1000;
      const cutoffTime = now - 30000;
      state.recenterTimestamps = state.recenterTimestamps.filter(
        (ts) => ts > cutoffTime,
      );
      state.recenterTimestamps.push(now);
    }
    if (!state.autoZoom) return;

    // Zoom out when the map had to recenter frequently in a short time, or
    // right away once the airplane has left the map: the pan cannot keep up
    // at this zoom, and waiting for more recenters kept it off screen for
    // seconds at 200x
    const fiveSecondsAgo = now - 5000;
    const frequent =
      newRecenter &&
      state.recenterTimestamps.filter((ts) => ts >= fiveSecondsAgo).length > 2;
    if (!frequent && !outsideViewport) return;
    if (now < this.autoZoomSettlesAt) return;

    // From the map's own zoom: a remembered level goes stale as soon as the
    // user zooms, and "zoom out" then zoomed in
    const zoom = map.getZoom();
    if (zoom <= AUTO_ZOOM_MIN) return;
    const steps = outsideViewport ? zoomOutSteps(point, mapSize) : 1;
    // Around the airplane, not the centre: once its animation ends Leaflet
    // puts the view back on the point it zoomed around and drops the pans
    // made meanwhile, and the old centre had lost the airplane by then
    map.setView(currentPos, Math.max(AUTO_ZOOM_MIN, zoom - steps), {
      animate,
    });
    state.recenterTimestamps = [];
    this.autoZoomSettlesAt = now + AUTO_ZOOM_SETTLE_MS;
  }
}
