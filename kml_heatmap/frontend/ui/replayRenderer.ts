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
  AUTO_ZOOM_MIN,
  FEET_TO_METERS,
  MAP_SOURCES,
  NAUTICAL_MILES_TO_KM,
} from "../utils/constants";
import { icon } from "../utils/icons";
import {
  closeWhenBehindGlobe,
  createActivationFilter,
  fromLngLat,
  isBehindGlobe,
  panPopupIntoView,
  toLngLat,
} from "../utils/mapHelpers";
import { getColorForAirspeed, getColorForAltitude } from "../utils/colors";
import { calculateBearing } from "../utils/geometry";
import {
  airplaneLiftPx,
  isLiftedAt,
  pointOnFlight,
  ribbonOf,
  ribbonWidthZoom,
} from "../calculations/lift";
import { calculateSmoothedBearing } from "../features/replay";
import { prefersReducedMotion } from "../utils/motion";

/** Minimum interval between map pans triggered by slider drags */
export const SEEK_PAN_THROTTLE_MS = 250;

/** Duration of the pan that brings the airplane back into view (ms) */
export const RECENTER_PAN_DURATION_MS = 500;

/**
 * The pan is asked for again on every frame the airplane is near the edge,
 * and each request starts a new animation from rest. MapLibre's default
 * easing starts slowly, so restarted sixty times a second it hardly moved;
 * this one covers most of the way at once and then settles.
 */
const recenterEasing = (t: number): number => 1 - Math.pow(1 - t, 4);

/** Most levels one auto zoom-out takes; beyond that the jump disorients */
const AUTO_ZOOM_MAX_STEP = 4;

/** Duration of one auto zoom-out (ms) */
export const AUTO_ZOOM_DURATION_MS = 250;

/**
 * Time before auto-zoom may zoom out again (ms): the zoom-out above has to
 * end first, or the next one is measured on a map that is still moving.
 */
export const AUTO_ZOOM_SETTLE_MS = 300;

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

/** Pixels between the two points a heading on screen is measured from */
const HEADING_PROBE_PX = 16;

/**
 * The angle the airplane is drawn at inside its marker, clockwise from the
 * marker's top, for a track over the ground. The marker lies on the map
 * (see AirplaneMarker): MapLibre tilts it back with the map, so the icon
 * is foreshortened like the ground under it, and the angle it needs is the
 * one on the ground, seen from straight above.
 *
 * On a flat map that is north up the two are the same. Turned, the map's
 * bearing comes off; and on a globe north is not up anywhere but on the
 * centre meridian. Measuring between the position and a point a few pixels
 * further along the track answers for both at once. On a tilted map that
 * measures the track foreshortened, as it runs on screen: the part up the
 * screen is stretched back by the tilt, or the marker's own tilt would
 * foreshorten it a second time.
 */
export function iconHeading(
  map: MapLibreMap,
  position: readonly [lat: number, lon: number],
  track: number,
): number {
  const globe = map.getProjection()?.type === "globe";
  if (!globe && map.getBearing() === 0 && map.getPitch() === 0) return track;

  const [lat, lon] = position;
  // Degrees of latitude the probe spans at this zoom (512 px tiles)
  const step = (HEADING_PROBE_PX * 360) / (512 * 2 ** map.getZoom());
  const radians = (track * Math.PI) / 180;
  // A degree of longitude shrinks with the latitude; held off the poles
  const shrink = Math.max(Math.cos((lat * Math.PI) / 180), 0.01);
  const from = map.project([lon, lat]);
  const to = map.project([
    lon + (step * Math.sin(radians)) / shrink,
    Math.max(-89, Math.min(89, lat + step * Math.cos(radians))),
  ]);
  const dx = to.x - from.x;
  const dy = (to.y - from.y) / Math.cos((map.getPitch() * Math.PI) / 180);
  if (dx === 0 && dy === 0) return track - map.getBearing();
  // Screen y grows downwards
  return (Math.atan2(dx, -dy) * 180) / Math.PI;
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
  const continues =
    last !== undefined &&
    tail !== undefined &&
    last.color === color &&
    last.lastIndex === index - 1 &&
    tail[0] === start[0] &&
    tail[1] === start[1];

  if (continues) {
    last.coords.push(toLngLat(to));
    last.lastIndex = index;
  } else {
    state.trailRuns.push({
      color,
      coords: [start, toLngLat(to)],
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

/**
 * Whether the user moves the map right now, told from the map's own events.
 *
 * The gesture handlers cannot be asked: `isActive()` of a drag or a pinch
 * only turns true past the click tolerance, and nothing answers for an
 * arrow key or the glide after a drag. Every movement the user causes
 * starts with a `movestart` that carries the DOM event behind it, the
 * glide and the keys included, and the app's own camera moves carry none.
 * The press itself is followed as well, for the time before the first move.
 */
class UserMapMovement {
  private pressed = false;
  private moving = false;
  /** A turn or a tilt is under way, the compass's included */
  private turning = false;
  /** Removes the DOM listeners */
  private readonly listening = new AbortController();

  /**
   * A start that carries a DOM event is the user's. One that carries none
   * is a camera move of the app, and every camera move of MapLibre resets
   * the gesture handlers first: whatever the user was doing has ended with
   * it. That is the only word of it for a drag or a pinch, which MapLibre
   * ends without a `moveend` when it is cut short this way.
   */
  private readonly onMoveStart = (e: { originalEvent?: unknown }): void => {
    this.moving = e.originalEvent !== undefined;
  };

  /**
   * Only the end of a movement of the user ends it: a gesture let go, a
   * key's pan or a glide that ran out, each with the DOM event behind it.
   * The `moveend` of a camera move of the app carries none and says nothing
   * about the user.
   */
  private readonly onMoveEnd = (e: { originalEvent?: unknown }): void => {
    if (e.originalEvent) this.moving = false;
    this.turning = false;
  };

  /**
   * The compass turns the map with a camera move of the app, which carries
   * no DOM event. A follow pan would end it in its first frame all the same,
   * and the click would seem to do nothing. No follow pan turns or tilts, so
   * whatever does is left to finish.
   */
  private readonly onTurnStart = (): void => {
    this.turning = true;
  };

  constructor(private readonly map: MapLibreMap) {
    const container = map.getCanvasContainer();
    const signal = this.listening.signal;
    const press = (e: Event): void => {
      // The primary button only. The right one turns the map, which the
      // `movestart` of the turn says, and the context menu of a right click swallows the `mouseup` on
      // Linux and macOS, which would leave the press on for good.
      if (e instanceof MouseEvent && e.button !== 0) return;
      this.pressed = true;
    };
    const release = (e: Event): void => {
      // One finger of a pinch that lifts leaves the other on the map
      // (asked by property: desktop browsers may not define TouchEvent)
      if ("touches" in e && (e as TouchEvent).touches.length > 0) return;
      this.pressed = false;
    };
    container.addEventListener("mousedown", press, { signal });
    container.addEventListener("touchstart", press, { signal, passive: true });
    // A button let go beside the map is still let go. A `contextmenu` is no
    // release: a long press on Android fires it with the finger still down.
    for (const type of ["mouseup", "touchend", "touchcancel", "blur"]) {
      window.addEventListener(type, release, { signal });
    }
    // A `mouseup` that went missing (a menu that opened over the press)
    // shows in the next move of the mouse, which knows its buttons
    window.addEventListener(
      "mousemove",
      (e) => {
        if (this.pressed && e.buttons === 0) this.pressed = false;
      },
      { signal, passive: true },
    );
    map.on("movestart", this.onMoveStart);
    map.on("zoomstart", this.onMoveStart);
    map.on("rotatestart", this.onTurnStart);
    map.on("pitchstart", this.onTurnStart);
    map.on("moveend", this.onMoveEnd);
  }

  isActive(): boolean {
    // Should an end ever go missing, a map at rest is proof enough
    if (!this.map.isMoving()) this.moving = this.turning = false;
    // The wheel has neither a press nor, before the frame that follows its
    // first event, a move; its handler is active from that event on
    return (
      this.pressed ||
      this.moving ||
      this.turning ||
      this.map.scrollZoom.isActive()
    );
  }

  stop(): void {
    this.listening.abort();
    this.map.off("movestart", this.onMoveStart);
    this.map.off("zoomstart", this.onMoveStart);
    this.map.off("rotatestart", this.onTurnStart);
    this.map.off("pitchstart", this.onTurnStart);
    this.map.off("moveend", this.onMoveEnd);
  }
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
  /** The frame the trail is written to the map in, while one is pending */
  private readonly trailFrame = frameCoalescer<ReplayState>((state) =>
    this.flushTrail(state),
  );
  /** Follows the user's hand on the map while a replay follows the airplane */
  private userMovement: UserMapMovement | null = null;
  /** The airplane, where it is and the track it flies, as last displayed */
  /**
   * Where the airplane is and where it heads, for the turns and the lift
   * that follow the map. `heightFt` is its height above the flight's
   * ground, null while the trail is flat.
   */
  private heading: {
    marker: ReplayAirplane;
    /** Where the airplane is on the line of its segment */
    position: [number, number];
    /** And on its ribbon's curve, in the 3D view (see pointOnFlight) */
    onCurve: [number, number] | null;
    track: number;
    heightFt: number | null;
    /** The replay's, whose trail's ribbons are as wide as the zoom asks */
    state: ReplayState;
  } | null = null;
  /** The map whose moves turn the icon, while a replay shows one */
  private turningWith: MapLibreMap | null = null;

  /**
   * A map that turns under a paused airplane changes where its track
   * points on screen, and no frame of the replay comes to say so
   */
  private readonly onMapMove = (): void => this.turnIcon();

  constructor(app: MapApp) {
    this.app = app;
  }

  /**
   * The rotating icon inside the airplane marker. Every activation builds a
   * new marker, so the lookup is keyed on its element and only runs when
   * that changes, not once per frame.
   */
  private airplaneIcon(marker: ReplayAirplane): HTMLElement | null {
    const root = marker.getElement();
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
   * Fill the airplane popup with the data of the segment at the current
   * replay time, and open it. Pass the already known segment index to avoid
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
    const map = this.app.map;
    if (map) this.userMovement ??= new UserMapMovement(map);
  }

  /** Stop listening to the map and to the user's hand on it; the replay is closing */
  stopWatchingMap(): void {
    this.userMovement?.stop();
    this.userMovement = null;
    this.turningWith?.off("move", this.onMapMove);
    this.turningWith = null;
    this.heading = null;
  }

  /**
   * Turn the icon to the track (see iconHeading). Hardware-accelerated
   * transforms; the same angle as last time is not written again. The
   * marker is drawn nose up, so the rotation is the heading itself: the old
   * emoji pointed north-east and needed the difference taken out.
   */
  private turnIcon(): void {
    const map = this.app.map;
    if (!map || !this.heading) return;
    const { marker, track, heightFt, state, onCurve } = this.heading;
    // On its ribbon in the 3D view, and up at its height; zoomed in so far
    // that the trail is its line again, on the line
    const position =
      onCurve && isLiftedAt(map.getZoom()) ? onCurve : this.heading.position;
    const [lat, lon] = marker.getLatLng();
    if (lat !== position[0] || lon !== position[1]) marker.setLatLng(position);
    marker.setLift(airplaneLiftPx(map, position[0], heightFt));
    // The ribbons are as wide as the zoom they were cut for (see lift.ts)
    if (
      state.trailWidthZoom !== null &&
      ribbonWidthZoom(map.getZoom()) !== state.trailWidthZoom
    ) {
      state.trailDirty = true;
      this.scheduleTrailFlush(state);
    }
    const iconDiv = this.airplaneIcon(marker);
    if (!iconDiv) return;
    if (this.turningWith !== map) {
      this.turningWith?.off("move", this.onMapMove);
      map.on("move", this.onMapMove);
      this.turningWith = map;
    }
    this.rotation = unwrapRotation(
      this.rotation,
      iconHeading(map, position, track),
    );
    const transform = "translate3d(0,0,0) rotate(" + this.rotation + "deg)";
    if (transform !== this.lastTransform) {
      this.lastTransform = transform;
      iconDiv.style.transform = transform;
    }
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
      this.keepAirplaneInView(replayManager, currentPos, isManualSeek);
    }

    // After the camera, which may have moved the map under the airplane
    this.heading = {
      marker,
      position: onLine,
      onCurve: onCurve?.position ?? null,
      track: bearing,
      heightFt: state.airplaneHeightFt,
      state,
    };
    this.turnIcon();

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

    // A zoom in flight, auto-zoom's own or the user's, is left to finish:
    // a camera move of MapLibre ends the one before it, and the pan would
    // freeze the zoom half way
    if (map.isZooming()) return;
    // The same goes for the user's hand on the map: a camera move resets
    // every gesture, so a pan on each frame would end a drag or a pinch the
    // moment it starts. The follow pan picks up again once they let go.
    // and so does the compass on its way north, which is a move of the app
    if (this.userMovement?.isActive()) return;

    const container = map.getContainer();
    const mapSize = { x: container.clientWidth, y: container.clientHeight };
    // Where the airplane is drawn: in the 3D view up at its height, where
    // the camera has to keep it and not at the ground under it
    const ground = map.project(toLngLat(currentPos));
    const lift = airplaneLiftPx(map, currentPos[0], state.airplaneHeightFt);
    const point = { x: ground.x, y: ground.y - lift };
    // The centre that brings the airplane itself to the middle of the map
    const center = lift
      ? map.unproject([point.x, point.y])
      : toLngLat(currentPos);
    const marginX = mapSize.x * EDGE_MARGIN_FRACTION;
    const marginY = mapSize.y * EDGE_MARGIN_FRACTION;

    // Behind the globe the airplane projects into the disc, never off the
    // map, while the marker is hidden: a long flight would fly over the rim
    // and leave an empty globe behind
    const behind = isBehindGlobe(map, {
      lat: currentPos[0],
      lng: currentPos[1],
    });
    const nearEdge =
      behind ||
      point.x < marginX ||
      point.x > mapSize.x - marginX ||
      point.y < marginY ||
      point.y > mapSize.y - marginY;
    if (!nearEdge) return;

    const outsideViewport =
      behind ||
      point.x < 0 ||
      point.x > mapSize.x ||
      point.y < 0 ||
      point.y > mapSize.y;

    const now = Date.now();
    if (isManualSeek) {
      const throttled = now - state.lastSeekPanTime < SEEK_PAN_THROTTLE_MS;
      if (throttled && !outsideViewport) return;
      state.lastSeekPanTime = now;
      map.jumpTo({ center });
      return;
    }

    // The pan follows the airplane on every frame it is near the edge, which
    // keeps a fast replay in view
    const animate = !prefersReducedMotion();
    map.easeTo({
      center,
      duration: RECENTER_PAN_DURATION_MS,
      easing: recenterEasing,
      animate,
    });

    // Those frames are one recenter, though, until a pan had its time to
    // move the map. Counted per frame, three frames in a row fired a burst
    // of zoom-outs.
    const newRecenter = now >= state.recenterPanEndsAt;
    if (newRecenter) {
      state.recenterPanEndsAt = now + RECENTER_PAN_DURATION_MS;
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
    // Onto the airplane, not around the centre: no pan runs while the map
    // zooms (see above), and the old centre had lost the airplane by then
    map.easeTo({
      center: toLngLat(currentPos),
      zoom: Math.max(AUTO_ZOOM_MIN, zoom - steps),
      duration: AUTO_ZOOM_DURATION_MS,
      animate,
    });
    state.recenterTimestamps = [];
    this.autoZoomSettlesAt = now + AUTO_ZOOM_SETTLE_MS;
  }
}
