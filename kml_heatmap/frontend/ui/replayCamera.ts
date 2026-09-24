/**
 * Replay Camera - What follows the airplane of a replay: the pan and the
 * auto zoom that keep it in view, or the chase view (see chaseCamera.ts),
 * the user's hand on the map that they give way to, and the turn and the
 * lift of its icon as the map moves under it.
 */
import type { LngLatLike, Map as MapLibreMap } from "maplibre-gl";
import type { MapApp } from "../mapApp";
import type { ReplayAirplane, ReplayState } from "./replayState";
import { AUTO_ZOOM_MIN } from "../utils/constants";
import { isBehindGlobe, toLngLat, unwrapLng } from "../utils/mapHelpers";
import {
  airplaneLiftPx,
  liftExaggeration,
  ribbonWidthZoom,
} from "../calculations/lift";
import { prefersReducedMotion } from "../utils/motion";
import { ChaseCamera, dampStep, type SavedCamera } from "./chaseCamera";

/** Minimum interval between map pans triggered by slider drags */
export const SEEK_PAN_THROTTLE_MS = 250;

/**
 * Time the frames the airplane spends near the edge count as one recenter
 * for auto zoom (ms)
 */
export const RECENTER_PAN_DURATION_MS = 500;

/**
 * About the time the camera takes to catch up with the airplane once it
 * follows it (s). The camera follows it as a critically damped spring: it
 * speeds up and slows down smoothly, and never overshoots.
 */
const FOLLOW_TIME_S = 0.6;

/** Longest frame the follow is worked out over (s), as the replay's */
const FOLLOW_MAX_STEP_S = 0.1;

/** Time the view takes back to where it was before a chase (ms) */
const CHASE_RESTORE_MS = 800;

/**
 * One frame of the camera following the airplane: `offset` is where the
 * airplane is from the middle of the map, `velocity` the camera's speed
 * from the frame before, both in pixels (per second), and `dt` the time of
 * the frame. Returns how far the camera moves, and its speed now (see
 * dampStep).
 */
export function followStep(
  offset: { x: number; y: number },
  velocity: { x: number; y: number },
  dt: number,
): { move: { x: number; y: number }; velocity: { x: number; y: number } } {
  const [mx, vx] = dampStep(offset.x, velocity.x, dt, FOLLOW_TIME_S);
  const [my, vy] = dampStep(offset.y, velocity.y, dt, FOLLOW_TIME_S);
  return { move: { x: mx, y: my }, velocity: { x: vx, y: vy } };
}

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
 * The camera lets go of the airplane once it is this many pixels from the
 * middle of the map, and moves slower than this many pixels per second
 */
const SETTLED_PX = 1;

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
 * foreshorten it a second time. An `upright` marker (the chase view's)
 * stands in the screen and takes the angle the track is drawn at.
 */
export function iconHeading(
  map: MapLibreMap,
  position: readonly [lat: number, lon: number],
  track: number,
  upright = false,
): number {
  if (upright) {
    // The chase keeps the airplane in the middle of a view along its track,
    // where a direction in the air is drawn as the tilt foreshortens it.
    // Measured on the ground it turned nose down over a slope that falls
    // away faster than the view looks down it.
    const turn = ((track - map.getBearing()) * Math.PI) / 180;
    return (
      (Math.atan2(
        Math.sin(turn),
        Math.cos(turn) * Math.cos((map.getPitch() * Math.PI) / 180),
      ) *
        180) /
      Math.PI
    );
  }
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
  /** Where the airplane is on its flight's curve (see replayPoint) */
  position: [number, number];
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
   * While the camera follows the airplane: its speed in pixels per second,
   * where the airplane was left on the screen, and the wall-clock time and
   * the zoom of the frame before. Null while it leaves the map alone.
   */
  private following: {
    velocity: { x: number; y: number };
    left: { x: number; y: number };
    at: number;
    zoom: number;
  } | null = null;
  /** The chase view while it has the camera (see chaseAirplane) */
  private chase: ChaseCamera | null = null;
  /** Whether the user's hand held the chase on the frame before */
  private chaseHeld = false;
  /** The frame a paused chase settles in, while one is pending */
  private chaseFrame: number | null = null;

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
    this.endChase();
    this.userMovement?.stop();
    this.userMovement = null;
    this.turningWith?.off("move", this.onMapMove);
    this.turningWith = null;
    this.heading = null;
    this.following = null;
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
    const { marker, track, heightFt, state, position } = this.heading;
    const [lat, lon] = marker.getLatLng();
    if (lat !== position[0] || lon !== position[1]) marker.setLatLng(position);
    const chase = this.chase;
    // Chased, the airplane stands up in the screen at a size to read, and
    // is drawn where the camera sees it (see ChaseCamera.offsetOf)
    marker.setUpright(chase !== null);
    if (chase) {
      const [x, y] = chase.offsetOf(this.heading);
      marker.setLift(-y, x);
    } else {
      // Exaggerated as the trail is drawn, which keeps its level until a
      // zoom ends
      marker.setLift(
        airplaneLiftPx(
          map,
          map.getCenter().lat,
          heightFt,
          liftExaggeration(this.app.reliefLevel),
        ),
      );
    }
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
      iconHeading(map, position, track, chase !== null),
    );
    const transform = "translate3d(0,0,0) rotate(" + this.rotation + "deg)";
    if (transform !== this.lastTransform) {
      this.lastTransform = transform;
      iconDiv.style.transform = transform;
    }
  }

  /**
   * Chase the airplane while the replay's chase view is on (see
   * ChaseCamera), from behind and above, turning with it. Returns whether
   * the chase has the camera, so the follow pan keeps away from it. A
   * finished replay starts none, and reduced motion none at all: a camera
   * that turns with the airplane is what that setting asks to be spared.
   * The user's hand on the map holds it, as it does the follow pan, and it
   * picks up from where they left the map once they let go.
   */
  chaseAirplane(heading: AirplaneHeading, isManualSeek: boolean): boolean {
    const map = this.app.map;
    const state = heading.state;
    if (
      !map ||
      !state.chase ||
      prefersReducedMotion() ||
      (!this.chase && state.currentTime >= state.maxTime)
    ) {
      this.endChase();
      return false;
    }
    if (this.userMovement?.isActive()) {
      this.chaseHeld = true;
      return true;
    }
    if (!this.chase) {
      this.chase = new ChaseCamera(map, () =>
        this.chaseAgain(this.heading?.state.playing ?? true),
      );
    } else if (this.chaseHeld) this.chase.resume();
    this.chaseHeld = false;
    const settled = this.chase.step(
      heading,
      state.speed,
      performance.now(),
      isManualSeek,
    );
    if (!settled) this.chaseAgain(state.playing);
    return true;
  }

  /** Move a paused chase on: no frame of a paused replay comes to do it */
  private chaseAgain(playing: boolean): void {
    if (playing || this.chaseFrame !== null) return;
    this.chaseFrame = requestAnimationFrame(() => {
      this.chaseFrame = null;
      const last = this.heading;
      if (last && !last.state.playing) this.chaseAirplane(last, false);
    });
  }

  /**
   * Give the camera back from the chase, if it has it, and with `restore`
   * the view from before it: all of it as the replay closes (`"all"`), and
   * otherwise its zoom, turn and tilt over the airplane where it is now.
   * Returns the camera from before the chase, for a view of its own.
   */
  endChase(restore?: "all" | "view"): SavedCamera | null {
    const chase = this.chase;
    if (this.chaseFrame !== null) cancelAnimationFrame(this.chaseFrame);
    this.chaseFrame = null;
    this.chaseHeld = false;
    const map = this.app.map;
    if (!chase || !map) return null;
    this.chase = null;
    chase.release();
    const saved = chase.saved;
    const position = this.heading?.position;
    if (restore) {
      map.easeTo({
        ...saved,
        ...(restore === "view" && position
          ? { center: toLngLat(position) }
          : {}),
        duration: CHASE_RESTORE_MS,
        animate: !prefersReducedMotion(),
      });
    }
    this.turnIcon();
    return saved;
  }

  /** The camera from before the chase, while one has the map */
  chaseView(): SavedCamera | null {
    return this.chase?.saved ?? null;
  }

  /**
   * Follow the airplane once it approaches the viewport edge, until it is
   * back in the middle (see trackAirplane). During slider drags the map
   * jumps to it, throttled; auto zoom-out only happens while playing.
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
    // The same goes for the user's hand on the map: a camera move resets
    // every gesture, so a pan on each frame would end a drag or a pinch the
    // moment it starts. The follow picks up again once the airplane nears
    // the edge after they let go, and so it does after the compass on its
    // way north, which is a move of the app.
    if (map.isZooming() || this.userMovement?.isActive()) {
      this.following = null;
      return;
    }

    const container = map.getContainer();
    const mapSize = { x: container.clientWidth, y: container.clientHeight };
    // Where the airplane is drawn: in the 3D view up at its height, where
    // the camera has to keep it and not at the ground under it
    const ground = map.project(toLngLat(currentPos));
    const lift = airplaneLiftPx(
      map,
      map.getCenter().lat,
      state.airplaneHeightFt,
      liftExaggeration(this.app.reliefLevel),
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
    if (!nearEdge && !this.following) return;

    const outsideViewport =
      behind ||
      point.x < 0 ||
      point.x > mapSize.x ||
      point.y < 0 ||
      point.y > mapSize.y;

    const now = Date.now();
    if (isManualSeek) {
      this.following = null;
      if (!nearEdge) return;
      const throttled = now - state.lastSeekPanTime < SEEK_PAN_THROTTLE_MS;
      if (throttled && !outsideViewport) return;
      state.lastSeekPanTime = now;
      map.jumpTo({ center });
      return;
    }

    this.trackAirplane(
      map,
      point,
      ground,
      currentPos,
      mapSize,
      center,
      behind ? null : outsideViewport,
      now,
    );
    if (!nearEdge) return;

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
      animate: !prefersReducedMotion(),
    });
    this.following = null;
    state.recenterTimestamps = [];
    this.autoZoomSettlesAt = now + AUTO_ZOOM_SETTLE_MS;
  }

  /**
   * Move the camera one frame after the airplane, which is at `point` on
   * the screen, by a jump rather than an animation: an animation asked for
   * on every frame starts from rest on every frame, and stuttered between
   * steps of a few metres and of a hundred at 100x. The camera follows as a
   * damped spring (see followStep) and keeps the airplane off the edge of
   * the map, whatever the speed; it lets go once the airplane is back in
   * the middle and at rest there. Without motion, with the airplane behind
   * a globe (`outside` null), or off the map (`outside`) further than a
   * spring could follow or before it followed, it jumps to the airplane's
   * `center` instead. `point` is where the airplane is drawn, `ground`
   * where the ground under it `position` is.
   */
  private trackAirplane(
    map: MapLibreMap,
    point: { x: number; y: number },
    ground: { x: number; y: number },
    position: [lat: number, lon: number],
    mapSize: { x: number; y: number },
    center: LngLatLike,
    outside: boolean | null,
    now: number,
  ): void {
    const zoom = map.getZoom();
    // Pixels mean other metres at another zoom
    const before = this.following?.zoom === zoom ? this.following : null;
    // The middle of the map, on the screen
    const middle = map.project(map.getCenter());
    const offset = { x: point.x - middle.x, y: point.y - middle.y };
    // A frame that took long may have taken it off the edge; one that is
    // further off than the map is wide is lost to a spring
    const lost =
      Math.abs(offset.x) > mapSize.x || Math.abs(offset.y) > mapSize.y;
    if (
      outside === null ||
      (outside && (lost || !before)) ||
      prefersReducedMotion()
    ) {
      this.following = null;
      map.jumpTo({ center });
      return;
    }
    const velocity = before?.velocity ?? { x: 0, y: 0 };
    const dt = before
      ? Math.min(Math.max((now - before.at) / 1000, 1e-3), FOLLOW_MAX_STEP_S)
      : 1 / 60;
    // The spring aims as far ahead of the airplane as it flies in the time
    // the spring takes, and so keeps up with it at any speed rather than
    // trail it by that far
    const flying = before
      ? {
          x: (point.x - before.left.x) / dt,
          y: (point.y - before.left.y) / dt,
        }
      : { x: 0, y: 0 };
    const step = followStep(
      {
        x: offset.x + flying.x * FOLLOW_TIME_S,
        y: offset.y + flying.y * FOLLOW_TIME_S,
      },
      velocity,
      dt,
    );
    // However far behind the spring is, the airplane stays on the map: a
    // fast replay drags the camera along at its own speed. Half the margin
    // the follow starts at, so the spring has the room to pick up speed.
    const marginX = (mapSize.x * EDGE_MARGIN_FRACTION) / 2;
    const marginY = (mapSize.y * EDGE_MARGIN_FRACTION) / 2;
    const keep = (move: number, at: number, low: number, high: number) =>
      Math.min(Math.max(move, at - high), at - low);
    const move = {
      x: keep(step.move.x, point.x, marginX, mapSize.x - marginX),
      y: keep(step.move.y, point.y, marginY, mapSize.y - marginY),
    };
    const left = { x: point.x - move.x, y: point.y - move.y };
    const settled =
      Math.hypot(left.x - middle.x, left.y - middle.y) < SETTLED_PX &&
      Math.hypot(step.velocity.x, step.velocity.y) < SETTLED_PX &&
      Math.hypot(flying.x, flying.y) < SETTLED_PX;
    this.following = settled
      ? null
      : {
          // Held back by the margins, the camera went at the airplane's pace
          velocity:
            move.x === step.move.x && move.y === step.move.y
              ? step.velocity
              : { x: move.x / dt, y: move.y / dt },
          left,
          at: now,
          zoom,
        };
    // Moved over the ground by as much as it takes to bring the ground
    // under the airplane to where it is to be on the screen: a move of the
    // middle by the same pixels would not do on a tilted map, whose far
    // side has more ground to a pixel than its near one
    const target = map.unproject([ground.x - move.x, ground.y - move.y]);
    const middleNow = map.getCenter();
    map.jumpTo({
      center: [
        middleNow.lng + unwrapLng(position[1], target.lng) - target.lng,
        middleNow.lat + position[0] - target.lat,
      ],
    });
  }
}
