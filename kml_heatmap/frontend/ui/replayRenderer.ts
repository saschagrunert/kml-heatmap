/**
 * Replay Renderer - Handles rendering concerns for flight replay
 */
import type {
  Feature,
  FeatureCollection,
  LineString,
  MultiPolygon,
} from "geojson";
import {
  Marker,
  Popup,
  type GeoJSONSource,
  type Map as MapLibreMap,
  type PositionAnchor,
} from "maplibre-gl";
import type { MapApp } from "../mapApp";
import type { ReplayManager } from "./replayManager";
import type { ReplayAirplane, ReplayState } from "./replayState";
import type { PathSegment } from "../types";
import { domCache } from "../utils/domCache";
import { frameCoalescer } from "../utils/frameCoalescer";
import { generateSegmentPopupHtml } from "../utils/htmlGenerators";
import {
  formatNumber,
  formatSpeed,
  formatTime,
  formatTrack,
} from "../utils/formatters";
import {
  FEET_TO_METERS,
  MAP_SOURCES,
  NAUTICAL_MILES_TO_KM,
} from "../utils/constants";
import { icon } from "../utils/icons";
import {
  closeWhenBehindGlobe,
  createActivationFilter,
  fromLngLat,
  panPopupIntoView,
  toLngLat,
  toLngLatAfter,
  unwrapLng,
} from "../utils/mapHelpers";
import { getColorForAirspeed, getColorForAltitude } from "../utils/colors";
import { calculateBearing } from "../utils/geometry";
import {
  isLiftedAt,
  pointOnFlight,
  ribbonOf,
  ribbonWidthZoom,
} from "../calculations/lift";
import { calculateSmoothedBearing } from "../features/replay";
import { prefersReducedMotion } from "../utils/motion";
import { ReplayCamera } from "./replayCamera";

/** Pixels between the airplane's position and the tip of its popup */
const AIRPLANE_POPUP_OFFSET = 16;

/**
 * The popup's offset for each side it may open on, as MapLibre makes of
 * AIRPLANE_POPUP_OFFSET, with the whole of it moved up by `lift` pixels to
 * where the airplane is drawn
 */
function liftedPopupOffset(
  lift: number,
): Record<PositionAnchor, [number, number]> {
  const o = AIRPLANE_POPUP_OFFSET;
  const corner = Math.round(Math.sqrt(0.5 * o * o));
  const sides: Record<PositionAnchor, [number, number]> = {
    center: [0, 0],
    top: [0, o],
    "top-left": [corner, corner],
    "top-right": [-corner, corner],
    bottom: [0, -o],
    "bottom-left": [corner, -corner],
    "bottom-right": [-corner, -corner],
    left: [o, 0],
    right: [-o, 0],
  };
  for (const offset of Object.values(sides)) offset[1] -= lift;
  return sides;
}

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
 * Colour of one replay segment. Segments without a groundspeed fall back to
 * the altitude colour, so both draw paths cover exactly the same segments.
 */
function replaySegmentColor(
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
 * Add the segment at `index` to the trail. Consecutive segments of one
 * colour extend the last run, so the trail stays a handful of features
 * rather than one per segment. A run holds one vertex more than it has
 * segments, which is what lets a backward seek cut it (see truncateTrail).
 */
export function appendTrailSegment(
  state: ReplayState,
  index: number,
  useAirspeedColors: boolean,
): void {
  const segment = state.segments[index];
  if (!segment) return;
  state.lastDrawnIndex = index;

  const from = segment.coords?.[0];
  const to = segment.coords?.[1];
  if (!from || !to) return;

  const color = replaySegmentColor(state, segment, useAirspeedColors);
  const start = toLngLat(from);
  const last = state.trailRuns[state.trailRuns.length - 1];
  const tail = last?.coords[last.coords.length - 1];
  // A run goes on across the antimeridian in the next copy of the world
  const continues =
    last !== undefined &&
    tail !== undefined &&
    last.color === color &&
    last.lastIndex === index - 1 &&
    unwrapLng(start[0], tail[0]) === tail[0] &&
    tail[1] === start[1];

  if (continues) {
    last.coords.push(toLngLatAfter(to, tail));
    last.lastIndex = index;
  } else {
    state.trailRuns.push({
      color,
      coords: [start, toLngLatAfter(to, start)],
      firstIndex: index,
      lastIndex: index,
    });
  }
  state.trailDirty = true;
}

/**
 * Cut the trail back to the segments flown at `time`. Seeking backwards
 * this way drops whole runs and shortens one, instead of colouring the
 * flight again from its start.
 */
export function truncateTrail(state: ReplayState, time: number): void {
  const before = state.lastDrawnIndex;
  while (state.lastDrawnIndex >= 0) {
    const seg = state.segments[state.lastDrawnIndex];
    if (seg && (seg.time ?? 0) <= time) break;
    state.lastDrawnIndex--;
  }
  if (state.lastDrawnIndex === before) return;

  const runs = state.trailRuns;
  while ((runs[runs.length - 1]?.firstIndex ?? -1) > state.lastDrawnIndex) {
    runs.pop();
  }
  const last = runs[runs.length - 1];
  if (last && last.lastIndex > state.lastDrawnIndex) {
    last.lastIndex = state.lastDrawnIndex;
    last.coords.length = last.lastIndex - last.firstIndex + 2;
  }
  state.trailDirty = true;
}

/** What a feature of the trail carries: its colour, and a ribbon its height */
interface TrailProperties {
  color: string;
  h?: number;
}

type TrailFeature = Feature<LineString | MultiPolygon, TrailProperties>;

/**
 * The trail as the data of its source: one line per colour run, or in the
 * 3D view, with the flight smoothed (`state.smoothed`), the runs as ribbons
 * at their height, as wide as `widthZoom` asks, for the ribbons' source;
 * zoomed in as far as LIFT_MAX_ZOOM, the lines again.
 * Only a run that has grown or changed its width is cut again: the others
 * keep their pieces, so the trail costs no more to write than its line.
 */
export function trailFeatureCollection(
  state: Pick<ReplayState, "trailRuns" | "smoothed" | "trailPieces">,
  widthZoom: number,
): FeatureCollection<LineString | MultiPolygon, TrailProperties> {
  const smoothed = isLiftedAt(widthZoom) ? state.smoothed : null;
  return {
    type: "FeatureCollection",
    features: state.trailRuns.flatMap((run): TrailFeature[] => {
      if (!smoothed) {
        return [
          {
            type: "Feature" as const,
            properties: { color: run.color },
            geometry: { type: "LineString" as const, coordinates: run.coords },
          },
        ];
      }
      let cut = state.trailPieces.get(run);
      if (cut?.lastIndex !== run.lastIndex || cut.widthZoom !== widthZoom) {
        // Cut from the flight's smoothed curve, so the runs of the trail
        // meet without a seam
        cut = {
          lastIndex: run.lastIndex,
          widthZoom,
          pieces: ribbonOf(
            smoothed,
            run.firstIndex,
            run.lastIndex + 1,
            widthZoom,
          ),
        };
        state.trailPieces.set(run, cut);
      }
      return cut.pieces.map((piece) => ({
        type: "Feature" as const,
        properties: { color: run.color, h: piece.h },
        geometry: piece.geometry,
      }));
    }),
  };
}

/**
 * The airplane: a marker whose element is a real button, and the popup that
 * a click on it, or Enter and Space while it has focus, opens and closes.
 * The browser turns those keys into a click on a button, so one listener
 * serves both.
 */
export class AirplaneMarker implements ReplayAirplane {
  readonly marker: Marker;
  readonly popup: Popup;
  /** Pixels the airplane is drawn above its position (see setLift) */
  private lift = 0;
  private readonly map: MapLibreMap;
  private readonly element: HTMLButtonElement;

  /**
   * @param onActivate - Called for a click that finds the popup closed; the
   *   caller fills the popup with the current position and opens it
   */
  constructor(
    map: MapLibreMap,
    position: readonly [lat: number, lon: number],
    onActivate: () => void,
  ) {
    this.map = map;

    const element = document.createElement("button");
    element.type = "button";
    element.className = "replay-airplane-root";
    element.title = "Aircraft position";
    element.setAttribute("aria-label", "Aircraft position");
    element.setAttribute("aria-expanded", "false");
    // The rotation transition lives on the inner icon (see features.css);
    // MapLibre positions the root with transforms, which must not animate
    element.innerHTML =
      '<div class="replay-airplane-icon">' +
      icon("aircraftTop", 24, undefined, "solid") +
      "</div>";
    // MapLibre fires a map click for a click on a marker as well; the
    // app's handler tells it by its target and leaves the popup alone. The
    // second click of a double click or tap would close what the first
    // opened (see createActivationFilter).
    const isActivation = createActivationFilter();
    element.addEventListener("click", (event) => {
      if (!isActivation(event)) return;
      if (this.isPopupOpen()) this.closePopup();
      else onActivate();
    });
    this.element = element;

    // Opened by hand and not through setPopup, which toggles on the same
    // click a second time. A click on the map closes it through the app's
    // click handler, and the popup never takes focus from the marker.
    this.popup = new Popup({
      maxWidth: "none",
      closeOnClick: false,
      focusAfterOpen: false,
      offset: AIRPLANE_POPUP_OFFSET,
    });
    closeWhenBehindGlobe(map, this.popup);
    this.popup.on("open", () => element.setAttribute("aria-expanded", "true"));
    this.popup.on("close", () =>
      element.setAttribute("aria-expanded", "false"),
    );
    // Laid on the map: the icon is a view from above, and upright on a
    // tilted map it looked down on the aircraft while the ground under it
    // was seen at a slant. The heading is turned inside the marker, so its
    // own rotation stays with the viewport (see iconHeading).
    this.marker = new Marker({
      element,
      anchor: "center",
      pitchAlignment: "map",
      rotationAlignment: "viewport",
    })
      .setLngLat(toLngLat(position))
      .addTo(map);
  }

  getLatLng(): [lat: number, lon: number] {
    return fromLngLat(this.marker.getLngLat());
  }

  setLatLng(position: readonly [lat: number, lon: number]): void {
    const lngLat = toLngLat(position);
    this.marker.setLngLat(lngLat);
    // The popup is not bound to the marker, so it is taken along
    if (this.popup.isOpen()) this.popup.setLngLat(lngLat);
  }

  setLift(px: number): void {
    if (px === this.lift) return;
    this.lift = px;
    this.marker.setOffset([0, -px]);
    // The popup points at the airplane where it is drawn, whichever side
    // of it the popup opens on
    this.popup.setOffset(liftedPopupOffset(px));
  }

  getElement(): HTMLButtonElement {
    return this.element;
  }

  setPopupContent(html: string): void {
    this.popup.setHTML(html);
  }

  openPopup(): void {
    if (this.popup.isOpen()) return;
    this.popup.setLngLat(this.marker.getLngLat()).addTo(this.map);
  }

  closePopup(): void {
    this.popup.remove();
  }

  isPopupOpen(): boolean {
    return this.popup.isOpen();
  }

  remove(): void {
    this.popup.remove();
    this.marker.remove();
  }
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
  /** Segment index the airplane popup content was last built for */
  private popupIndex = -1;
  /** The frame the trail is written to the map in, while one is pending */
  private readonly trailFrame = frameCoalescer<ReplayState>((state) =>
    this.flushTrail(state),
  );
  /**
   * What follows the airplane: the camera, the turn of its icon and its
   * lift. A trail whose ribbons are cut for another zoom is written again.
   */
  private readonly camera: ReplayCamera;

  constructor(app: MapApp) {
    this.app = app;
    this.camera = new ReplayCamera(app, (state) => {
      state.trailDirty = true;
      this.scheduleTrailFlush(state);
    });
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
   * Fill the airplane popup with the data of the segment at the current
   * replay time, and open it. Pass the already known segment index to avoid
   * a second lookup when called from the frame loop.
   */
  updateAirplanePopup(replayManager: ReplayManager, index?: number): void {
    const state = replayManager.state;
    if (!state.airplaneMarker || !this.app.replayActive) return;

    const segments = state.segments;
    if (segments.length === 0) return;

    const idx = index ?? findSegmentIndexAtTime(segments, state.currentTime);
    const currentSegment = segments[idx] ?? segments[0];
    if (!currentSegment) return;
    this.popupIndex = idx;

    // The marker is where the aircraft is now, part way along the segment;
    // the segment's own end point is where it will be
    const airplane = state.airplaneMarker;
    const position = airplane.getLatLng();
    const popupContent = generateSegmentPopupHtml({
      segment: currentSegment,
      position,
      altMin: state.colorMinAlt,
      altMax: state.colorMaxAlt,
      speedMin: state.colorMinSpeed,
      speedMax: state.colorMaxSpeed,
      title: "Current Position",
      icon: "aircraftTop",
    });

    // Filled before it opens, so it opens at its final size
    airplane.setPopupContent(popupContent);
    if (!airplane.isPopupOpen()) airplane.openPopup();

    // The popup pans the map only while the replay is paused. While playing
    // the pan would stop the one that follows the airplane each time, and
    // the map never caught up with it. Without it when paused, though, a
    // click on an airplane near the top edge opened the popup off the map.
    const map = this.app.map;
    if (map && !state.playing) {
      panPopupIntoView(map, airplane.popup, undefined, !prefersReducedMotion());
    }
  }

  /**
   * Hand the trail to the map in the next frame, if it changed. A drag of
   * the slider reports many positions per frame and every `setData` sends
   * the whole trail to the worker, so the writes are collected: one per
   * frame at most, and none for a frame that drew nothing new.
   */
  scheduleTrailFlush(state: ReplayState): void {
    if (state.trailDirty) this.trailFrame.schedule(state);
  }

  private flushTrail(state: ReplayState): void {
    if (!state.trailDirty) return;
    state.trailDirty = false;
    // A replay that has ended meanwhile has emptied the source itself
    if (!state.layerActive) return;
    // The whole trail on every write, which measured cheap enough to keep:
    // the longest flight of the sample data (2800 segments) replayed at 500x
    // in Chrome grew from 90 runs and 1000 vertices a third of the way in to
    // 250 runs and 3000 vertices (87 KB) at the end, and the write went from
    // 0.5 to 0.9 ms of main thread, with no dropped frames. Sending only
    // the changed runs through `updateData` measured worse on the same
    // replay: more main thread per frame, and dropped frames.
    const map = this.app.map;
    if (!map) return;
    const widthZoom = ribbonWidthZoom(map.getZoom());
    state.trailWidthZoom = state.lifted ? widthZoom : null;
    const id =
      state.lifted && isLiftedAt(widthZoom)
        ? MAP_SOURCES.replayTrailRibbons
        : MAP_SOURCES.replayTrail;
    // Lifted or flat, the trail is in one source, and leaves the other
    if (state.trailWrittenTo !== null && state.trailWrittenTo !== id) {
      void map
        .getSource<GeoJSONSource>(state.trailWrittenTo)
        ?.setData({ type: "FeatureCollection", features: [] });
    }
    state.trailWrittenTo = id;
    void map
      .getSource<GeoJSONSource>(id)
      ?.setData(trailFeatureCollection(state, widthZoom));
  }

  /** Drop a write that is still pending; the replay layer is going away */
  cancelTrailFlush(): void {
    this.trailFrame.cancel();
  }

  /**
   * Start following the user's hand on the map. Called as a replay opens
   * and not on the first frame that pans: a press that began before that
   * frame would never be seen.
   */
  watchUser(): void {
    this.camera.watchUser();
  }

  /** Stop listening to the map and to the user's hand on it; the replay is closing */
  stopWatchingMap(): void {
    this.camera.stopWatchingMap();
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
    if (!marker || !this.app.map) return;

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
    // In the 3D view on the trail's ribbon, which follows the curve through
    // the flight's points rather than the straight segment, at its height
    // there. Known before the camera moves, which follows the airplane up.
    const onCurve = state.smoothed
      ? pointOnFlight(state.smoothed, currentIndex, fraction)
      : null;
    const onLine: [number, number] = [
      lat1 + (lat2 - lat1) * fraction,
      lon1 + (lon2 - lon1) * fraction,
    ];
    const currentPos =
      onCurve && isLiftedAt(this.app.map.getZoom()) ? onCurve.position : onLine;
    state.airplaneHeightFt = onCurve?.heightFt ?? null;
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
      this.camera.keepAirplaneInView(state, currentPos, isManualSeek);
    }

    // After the camera, which may have moved the map under the airplane
    this.camera.follow({
      marker,
      position: onLine,
      onCurve: onCurve?.position ?? null,
      track: bearing,
      heightFt: state.airplaneHeightFt,
      state,
    });

    // The popup describes a segment, so an open one is rebuilt only once the
    // airplane has reached another segment, not on every frame
    if (marker.isPopupOpen() && currentIndex !== this.popupIndex) {
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

  /** Add the segments flown since the last frame to the trail */
  private drawNewSegments(replayManager: ReplayManager): void {
    const state = replayManager.state;
    if (!state.layerActive) return;

    // Whatever emptied or cut the trail before this call is written too
    this.scheduleTrailFlush(state);

    // Nothing is drawn at time 0 (stopped/reset state)
    if (state.currentTime <= 0) return;

    const useAirspeedColors =
      this.app.airspeedVisible && !this.app.altitudeVisible;

    const segments = state.segments;
    for (let i = state.lastDrawnIndex + 1; i < segments.length; i++) {
      const seg = segments[i];
      if (!seg) continue;
      if ((seg.time ?? 0) > state.currentTime) break;
      appendTrailSegment(state, i, useAirspeedColors);
    }
    this.scheduleTrailFlush(state);
  }

  /** Take the segments flown after the given time off the trail */
  removeSegmentsAfter(replayManager: ReplayManager, time: number): void {
    truncateTrail(replayManager.state, time);
    this.scheduleTrailFlush(replayManager.state);
  }
}
