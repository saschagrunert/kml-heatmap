/**
 * Replay Camera - What follows the airplane of a replay: the pan and the
 * auto zoom that keep it in view, the user's hand on the map that they
 * give way to, and the turn and the lift of its icon as the map moves
 * under it. Apart from the renderer, so a chase view (#300) has a home.
 */
import type { Map as MapLibreMap } from "maplibre-gl";
import type { MapApp } from "../mapApp";
import type { ReplayAirplane, ReplayState } from "./replayState";
import { AUTO_ZOOM_MIN } from "../utils/constants";
import { isBehindGlobe, toLngLat } from "../utils/mapHelpers";
import {
  airplaneLiftPx,
  isLiftedAt,
  ribbonWidthZoom,
} from "../calculations/lift";
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

/** Fraction of the viewport used as the "near edge" margin for auto-panning */
const EDGE_MARGIN_FRACTION = 0.1;

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

/**
 * Where the airplane is and where it heads, for the turns and the lift
 * that follow the map. `heightFt` is its height above the flight's
 * ground, null while the trail is flat.
 */
interface AirplaneHeading {
  marker: ReplayAirplane;
  /** Where the airplane is on the line of its segment */
  position: [number, number];
  /** And on its ribbon's curve, in the 3D view (see pointOnFlight) */
  onCurve: [number, number] | null;
  track: number;
  heightFt: number | null;
  /** The replay's, whose trail's ribbons are as wide as the zoom asks */
  state: ReplayState;
}

export class ReplayCamera {
  /** The marker element whose rotating icon is cached, and that icon */
  private iconRoot: HTMLElement | null = null;
  private iconDiv: HTMLElement | null = null;
  private lastTransform = "";
  /** Unwrapped rotation of the icon in degrees (see unwrapRotation) */
  private rotation: number | null = null;
  /** Wall-clock time before which auto-zoom does not zoom out again */
  private autoZoomSettlesAt = 0;
  /** Follows the user's hand on the map while a replay follows the airplane */
  private userMovement: UserMapMovement | null = null;
  /** The airplane, where it is and the track it flies, as last displayed */
  private heading: AirplaneHeading | null = null;
  /** The map whose moves turn the icon, while a replay shows one */
  private turningWith: MapLibreMap | null = null;

  /**
   * A map that turns under a paused airplane changes where its track
   * points on screen, and no frame of the replay comes to say so
   */
  private readonly onMapMove = (): void => this.turnIcon();

  /**
   * @param onTrailStale - The trail's ribbons were cut for another zoom
   *   level and are to be written again
   */
  constructor(
    private readonly app: MapApp,
    private readonly onTrailStale: (state: ReplayState) => void,
  ) {}

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

  /** Put the airplane where it is and turn it to where it heads */
  follow(heading: AirplaneHeading): void {
    this.heading = heading;
    this.turnIcon();
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
    marker.setLift(airplaneLiftPx(map, map.getCenter().lat, heightFt));
    // The ribbons are as wide as the zoom they were cut for (see lift.ts)
    if (
      state.trailWidthZoom !== null &&
      ribbonWidthZoom(map.getZoom()) !== state.trailWidthZoom
    ) {
      this.onTrailStale(state);
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

  /**
   * Pan the map when the airplane approaches the viewport edge. During
   * slider drags pans are throttled and not animated; auto zoom-out only
   * happens while playing.
   */
  keepAirplaneInView(
    state: ReplayState,
    currentPos: [number, number],
    isManualSeek: boolean,
  ): void {
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
    const lift = airplaneLiftPx(
      map,
      map.getCenter().lat,
      state.airplaneHeightFt,
    );
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
