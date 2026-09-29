/**
 * Replay of all flights: every flight the filters keep starts from its own
 * first fix at once and plays at a hundred to a thousand times its speed,
 * each a bright head with a trail fading behind it at its height, so the
 * year blooms out of the home field. The only clock is the one each flight
 * carries (see calculations/flightClock.ts): the panel reads "0:42 into
 * every flight", and its slider moves along the same clock, never a date
 * or an hour.
 *
 * ReplayAllPlayer plays and draws (ui/replayAllLayer.ts), and nothing else:
 * Wrapped's intro plays it under its own camera. ReplayAllControls is the
 * "Replay all" control and its panel: it runs the player as a replay of the
 * map (replayActive), which hides the heatmap and the colour layers and
 * holds the selection, the filters and Wrapped as the replay of one flight
 * does, fits the camera to the flights north up, tilted as the 3D view
 * tilts it, and turns it slowly round them on request. The heat builds up
 * behind the flights instead of the heatmap, as far as the clock has come
 * (see replayAllTime) and at the height of the flights, unless the
 * Heatmap switch is off.
 */
import type { MapApp } from "../mapApp";
import type { KMLDataset } from "../types";
import { datasetIndex } from "../calculations/datasetIndex";
import { flightClockOf } from "../calculations/flightClock";
import {
  groundedFlights,
  releaseGroundedFlights,
} from "../calculations/groundProfile";
import { isLiftedAt, liftExaggeration } from "../calculations/lift";
import {
  replayAllPoints,
  type ReplayAllPoints,
} from "../calculations/replayAll";
import { FEET_TO_METERS, MAP_LAYERS } from "../utils/constants";
import { applyToggleButtonState } from "../utils/buttonState";
import { holdControls } from "./heldControls";
import { domCache } from "../utils/domCache";
import { setControlIcon } from "../utils/icons";
import { logError } from "../utils/logger";
import {
  hasLostContext,
  REPLAY_CAMERA_MOVE,
  whenContextRestored,
} from "../utils/mapHelpers";
import { prefersReducedMotion } from "../utils/motion";
import { announceInRegion, announceStatus, showToast } from "../utils/toast";
import { followHeatCloud, heatCloudLevel } from "./heatCloud";
import {
  REPLAY_ALL_LAYER,
  ReplayAllLayer,
  type ReplayAllStyle,
} from "./replayAllLayer";
import { REPLAY_PANEL_HEIGHT_VAR } from "./replayManager";

/** The speeds the panel offers, in seconds of flight per second */
const REPLAY_ALL_SPEEDS = [100, 200, 300, 500, 1000] as const;

/** The speed a replay of all flights starts at */
export const REPLAY_ALL_SPEED = 200;

/**
 * Seconds on the wall a trail takes to fade, up to TRAIL_MOST_S of flight:
 * at a thousand times its speed a trail of 3 s was 50 minutes of flight,
 * most of a flight behind every head, where the heat built up behind them
 * shows the way flown already
 */
const TRAIL_FADE_S = 3;
const TRAIL_MOST_S = 1500;

/** The longest step one frame moves the clock by, as for one flight */
const MAX_FRAME_S = 0.1;

/** Degrees a second the orbit turns the camera by: two minutes a round */
const ORBIT_DEG_PER_S = 3;

/** The deepest zoom level the curves are thinned for */
const MAX_DETAIL = 16;

/** Cuts of the curves kept, the last ones drawn, as for the heat cloud */
const CUTS_KEPT = 3;

/**
 * How many zoom levels short of a run's zoom (ReplayAllRun.zoom) a camera
 * on its way switches to the curves cut for it: the trails of a few
 * hundred times real speed are some tens of pixels long there, where a cut
 * for far out starts to show its corners
 */
const ZOOM_AHEAD_LEVELS = 2;

/**
 * The layer the replay is drawn below: the first of the ribbons, right
 * over the heat cloud (see CLOUD_BEFORE in ui/heatCloud.ts), so it does not
 * cut the run of flat layers the relief draws into a texture of it, and
 * the trails are drawn over the heat that builds up behind them
 */
const REPLAY_ALL_BEFORE = MAP_LAYERS.pathsAltitudeRibbons;

/** What to play, see ReplayAllPlayer.start */
export interface ReplayAllRun {
  /** The flights to play; by default those the filters and Isolate keep */
  pathIds?: Iterable<number>;
  /** Seconds of flight a second; REPLAY_ALL_SPEED by default */
  speed?: number;
  /**
   * The zoom a camera that is on its way sets out for (Wrapped's intro,
   * from far out). The curves cut for where it sets off would be straight
   * spokes by the time it comes down, and those cut for where it comes to
   * rest too many to draw far out: both are cut as the run starts, and the
   * second drawn from ZOOM_AHEAD_LEVELS short of this zoom, until the map
   * first comes to the end of a zoom. By default the map's zoom only.
   */
  zoom?: number;
  /**
   * How many times their size the heads and trails are drawn: 1 by
   * default. Under Wrapped's intro, over a view of the whole year, they
   * were specks.
   */
  scale?: number;
}

/**
 * Plays every flight of a run at once on the map of `app`. It needs no
 * panel and changes no state of the app, so another part of it (Wrapped's
 * intro) can play it under its own camera; ReplayAllControls is the one
 * that makes it a replay of the map.
 */
export class ReplayAllPlayer {
  /** The seconds into every flight */
  time = 0;
  /** Seconds of flight a second */
  speed: number = REPLAY_ALL_SPEED;
  /** The size the flights are drawn at (ReplayAllRun.scale) */
  private scale = 1;
  /** Whether the clock runs */
  playing = false;
  /** Whether the camera turns round the middle of the map while it plays */
  orbit = false;
  /** Told on every frame the clock moved, and as it starts, stops or pauses */
  onChange: (() => void) | null = null;
  private readonly app: MapApp;
  private readonly layer: ReplayAllLayer;
  private points: ReplayAllPoints | null = null;
  private keep: ((pathId: number) => boolean) | null = null;
  /**
   * The zoom the camera is on its way to (ReplayAllRun.zoom), until the
   * map comes to the end of a zoom, and whether it is near enough to draw
   * the curves cut for it
   */
  private zoomAhead: number | null = null;
  private aheadDrawn = false;
  /** The cuts of the curves by what they were cut for, the last at the end */
  private readonly cuts = new Map<string, ReplayAllPoints>();
  private frame: number | null = null;
  private lastFrame: number | null = null;
  /** Settles the promise of the run with whether it played to the end */
  private settle: ((ended: boolean) => void) | null = null;
  private readonly stopFollowing: (() => void)[] = [];
  private broken = false;
  /** Whether the orbit has turned the camera since it last came to rest */
  private orbited = false;
  /**
   * Whether the flights are lifted: as the heat cloud and the ribbons,
   * which are handed to the flat lines from LIFT_MAX_ZOOM on once a zoom
   * has ended, not while it goes on
   */
  private lifted = true;

  constructor(app: MapApp) {
    this.app = app;
    // The heat that builds up behind the flights is the heat cloud's, on
    // the flat map as well, and the flights are lifted as it is (see
    // level and ui/heatCloud.ts)
    followHeatCloud(app);
    this.layer = new ReplayAllLayer(this.style, (error) => {
      if (this.broken) return;
      this.broken = true;
      logError("The replay of all flights cannot be drawn:", error);
      // Out of the frame it failed in
      setTimeout(() => this.stop(), 0);
    });
    // The style that comes back after a lost context has no custom layers,
    // and the shaders are tried again in the new context
    if (app.map) {
      whenContextRestored(app.map, () => {
        this.broken = false;
        this.place();
      });
    }
    // A destroyed app leaves the map as it is, but no frame runs on for it
    app.signal.addEventListener("abort", () => {
      this.pause();
      for (const stop of this.stopFollowing.splice(0)) stop();
    });
  }

  /** Whether its shaders did not work in the map's context */
  get unavailable(): boolean {
    return this.broken;
  }

  /** Whether a run is on the map */
  get active(): boolean {
    return this.keep !== null;
  }

  /** The seconds of the longest flight of the run */
  get duration(): number {
    return this.points?.duration ?? 0;
  }

  /** How many flights the run plays */
  get flights(): number {
    return this.points?.flights ?? 0;
  }

  /** West, south, east and north of the flights in degrees, or null */
  get bounds(): [number, number, number, number] | null {
    return this.points?.bounds ?? null;
  }

  /**
   * Play the flights of `run` from their first fixes. Resolves with true
   * once the last of them has landed, and with false when the run is
   * stopped before that or has no flight to play (`flights` is 0 then).
   */
  start(run: ReplayAllRun = {}): Promise<boolean> {
    this.stop();
    const app = this.app;
    const map = app.map;
    const data = app.currentData;
    if (!map || !data || this.broken) return Promise.resolve(false);
    this.keep = keepOf(app, data, run.pathIds);
    this.speed = run.speed ?? REPLAY_ALL_SPEED;
    this.scale = run.scale ?? 1;
    this.zoomAhead = run.zoom ?? null;
    this.aheadDrawn = this.nearAhead();
    this.lifted = isLiftedAt(map.getZoom());
    this.time = 0;
    this.cut();
    if (this.flights === 0) {
      this.stop();
      return Promise.resolve(false);
    }
    const ahead = this.zoomAhead;
    if (ahead !== null && !this.aheadDrawn) {
      // Cut now, so that the camera's frames do not wait for it
      this.pointsFor(ahead);
      const zooming = map.on("zoom", () => {
        if (this.zoomAhead === null || this.aheadDrawn || !this.nearAhead()) {
          return;
        }
        this.aheadDrawn = true;
        this.cut();
      });
      this.stopFollowing.push(() => zooming.unsubscribe());
    }
    const store = app.store;
    this.stopFollowing.push(
      store.subscribeKeys(
        ["threeDVisible", "terrainActive", "reliefLevel"],
        () => this.cut(),
      ),
      // Another dataset is not what was asked to play
      store.subscribe("currentData", () => this.stop()),
    );
    const zoomed = map.on("zoomend", () => {
      // The map's zoom is the one to follow from here on
      this.zoomAhead = null;
      this.aheadDrawn = false;
      this.lifted = isLiftedAt(map.getZoom());
      this.cut();
    });
    const styled = map.on("styledata", () => this.place());
    this.stopFollowing.push(
      () => zoomed.unsubscribe(),
      () => styled.unsubscribe(),
    );
    this.place();
    const ended = new Promise<boolean>((resolve) => {
      this.settle = resolve;
    });
    this.resume();
    return ended;
  }

  /** Let the clock run, from the start again once every trail has faded */
  resume(): void {
    if (!this.active || this.playing) return;
    if (this.time >= this.duration + this.fade()) this.time = 0;
    this.playing = true;
    this.lastFrame = null;
    this.frame = requestAnimationFrame(this.tick);
    this.onChange?.();
  }

  /** Hold the clock where it is */
  pause(): void {
    if (!this.playing) return;
    this.playing = false;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.rest();
    this.onChange?.();
  }

  /** Take the run off the map, and let go of its points */
  stop(): void {
    const wasActive = this.active;
    this.pause();
    for (const stop of this.stopFollowing.splice(0)) stop();
    this.keep = null;
    this.zoomAhead = null;
    this.aheadDrawn = false;
    this.points = null;
    this.cuts.clear();
    this.layer.setPoints(null);
    // On the flat map nothing else draws along the smoothed flights, which
    // for all years are tens of megabytes (see releaseGroundedFlights)
    if (wasActive && !this.app.threeDVisible) releaseGroundedFlights();
    const map = this.app.map;
    if (map && !hasLostContext(map) && map.getLayer(REPLAY_ALL_LAYER)) {
      map.removeLayer(REPLAY_ALL_LAYER);
    }
    this.settle?.(false);
    this.settle = null;
    if (wasActive) this.onChange?.();
  }

  /** The seconds of flight a trail fades over at the speed played */
  private fade(): number {
    return Math.min(TRAIL_FADE_S * this.speed, TRAIL_MOST_S);
  }

  /**
   * Move the clock to `seconds` into every flight, between the start and
   * the landing of the last, playing on from there if it plays. The layer
   * draws from the clock alone, so the trails are the ones flown up to
   * there, backwards as well as forwards.
   */
  seek(seconds: number): void {
    if (!this.active) return;
    this.time = Math.min(Math.max(seconds, 0), this.duration);
    this.app.map?.triggerRepaint();
    this.onChange?.();
  }

  /**
   * Tell the map's listeners the camera has come to rest once the orbit no
   * longer turns it. Its jumps are tagged (REPLAY_CAMERA_MOVE), so what the
   * app does at the end of a move, the saved view and the link among it,
   * waits for this `moveend`, as for the camera of the replay of one
   * flight. A move still going on ends with one of its own.
   */
  private rest(): void {
    if (!this.orbited) return;
    this.orbited = false;
    const map = this.app.map;
    if (!map || this.app.signal.aborted || hasLostContext(map)) return;
    if (!map.isMoving()) map.fire("moveend");
  }

  private readonly tick = (now: number): void => {
    this.frame = null;
    const map = this.app.map;
    if (!this.playing || !map) return;
    if (!this.orbit) this.rest();
    const step =
      this.lastFrame === null
        ? 0
        : Math.min(Math.max(now - this.lastFrame, 0) / 1000, MAX_FRAME_S);
    this.lastFrame = now;
    this.time += step * this.speed;
    if (this.time >= this.duration) {
      this.settle?.(true);
      this.settle = null;
    }
    // Played to the end once the last trail has faded
    const end = this.duration + this.fade();
    if (this.time >= end) {
      this.time = end;
      this.playing = false;
    }
    // Not while the camera moves: a jump would end the fit's animation, or
    // turn the map under a finger; nor on a map without its WebGL context
    if (
      this.orbit &&
      step > 0 &&
      !prefersReducedMotion() &&
      !map.isMoving() &&
      !hasLostContext(map)
    ) {
      map.jumpTo(
        { bearing: map.getBearing() + ORBIT_DEG_PER_S * step },
        REPLAY_CAMERA_MOVE,
      );
      this.orbited = true;
    }
    map.triggerRepaint();
    if (this.playing) this.frame = requestAnimationFrame(this.tick);
    else this.rest();
    this.onChange?.();
  };

  /**
   * The relief level the flights are lifted as: the 3D view's, and outside
   * it the heat cloud's (heatCloudLevel), which is at its height there as
   * well while they play, so the heads fly in the heat
   */
  private level(): number {
    const app = this.app;
    return app.threeDVisible ? app.reliefLevel : (heatCloudLevel(app) ?? 0);
  }

  /**
   * What the layer draws with in the frame, as the heat cloud is drawn:
   * the flights at their height, on the relief where it is drawn. Outside
   * the 3D view as well, where under a camera that flies and tilts over
   * them (Wrapped's intro, the replay's own tilt) they were lines on the
   * ground.
   */
  private readonly style = (): ReplayAllStyle | null => {
    const app = this.app;
    const map = app.map;
    if (!map || !this.active) return null;
    const exaggeration =
      map.getTerrain()?.exaggeration ?? liftExaggeration(this.level());
    const metres = exaggeration * FEET_TO_METERS;
    return {
      groundM: app.terrainActive ? metres : 0,
      liftM: this.lifted ? metres : 0,
      time: this.time,
      fade: this.fade(),
      scale: this.scale,
    };
  };

  /** Whether the camera is near enough the zoom of the run to draw its cut */
  private nearAhead(): boolean {
    const map = this.app.map;
    return (
      this.zoomAhead !== null &&
      !!map &&
      map.getZoom() >= this.zoomAhead - ZOOM_AHEAD_LEVELS
    );
  }

  /** Draw the curves cut for the view (see pointsFor) */
  private cut(): void {
    const map = this.app.map;
    if (!map) return;
    const zoom =
      this.zoomAhead !== null && this.aheadDrawn
        ? this.zoomAhead
        : map.getZoom();
    const points = this.pointsFor(zoom);
    if (!points || points === this.points) return;
    this.points = points;
    this.layer.setPoints(points);
  }

  /**
   * The curves cut for the view: on the ground of the 3D view and the
   * relief level they are lifted as (see level), as the heat cloud's, and
   * thinned for the map zoom `zoom`. Those cut last are kept, and handed
   * out again as long as nothing they were cut for changed.
   */
  private pointsFor(zoom: number): ReplayAllPoints | null {
    const app = this.app;
    const data = app.currentData;
    const keep = this.keep;
    if (!data || !keep) return null;
    const detail = Math.min(Math.max(Math.floor(zoom), 0), MAX_DETAIL);
    const level = this.level();
    const key = `${app.terrainActive}/${level}/${detail}`;
    let points = this.cuts.get(key);
    if (points) {
      this.cuts.delete(key);
    } else {
      const segments = data.path_segments;
      const flights = groundedFlights(
        segments,
        app.terrainActive,
        app.reliefLevel,
      );
      points = replayAllPoints(
        segments,
        flights,
        flightClockOf(segments),
        keep,
        detail,
        level,
      );
      const oldest = this.cuts.keys().next();
      if (!oldest.done && this.cuts.size >= CUTS_KEPT) {
        this.cuts.delete(oldest.value);
      }
    }
    this.cuts.set(key, points);
    return points;
  }

  /**
   * Put the layer on the map, below the flights in the air and the labels
   * and over the heat cloud (REPLAY_ALL_BEFORE), or back there
   */
  private place(): void {
    const map = this.app.map;
    if (!map || !this.active || this.app.signal.aborted) return;
    if (hasLostContext(map)) return;
    const before = map.getLayer(REPLAY_ALL_BEFORE)
      ? REPLAY_ALL_BEFORE
      : undefined;
    if (!map.getLayer(REPLAY_ALL_LAYER)) {
      map.addLayer(this.layer, before);
      return;
    }
    // A new base style keeps the layer, which is none it knows of, but not
    // necessarily where it was. The heat cloud puts itself right below it.
    if (!before) return;
    const order = map.getLayersOrder();
    if (order.indexOf(REPLAY_ALL_LAYER) !== order.indexOf(before) - 1) {
      map.moveLayer(REPLAY_ALL_LAYER, before);
    }
  }
}

/**
 * Whether a flight is one to play: one of `pathIds`, or where none are
 * given one the filters keep and, while the selection is isolated, one of
 * it, as the heatmap shows them
 */
function keepOf(
  app: MapApp,
  data: KMLDataset,
  pathIds: Iterable<number> | undefined,
): (pathId: number) => boolean {
  if (pathIds) {
    const chosen = new Set(pathIds);
    return (pathId) => chosen.has(pathId);
  }
  const kept = datasetIndex(data).filter(
    app.selectedYear,
    app.selectedAircraft,
  ).pathIds;
  const selected = app.selectedPathIds;
  return app.isolateSelection && selected.size > 0
    ? (pathId) => kept.has(pathId) && selected.has(pathId)
    : (pathId) => kept.has(pathId);
}

/** Said when the filters keep no flight with a clock to play by */
export const REPLAY_ALL_NOTHING_MESSAGE =
  "No flight in this view has timing or speed data to replay";

/** Said when the layer's shaders did not work in the map's context */
export const REPLAY_ALL_UNAVAILABLE_MESSAGE =
  "The replay of all flights cannot be drawn in this browser";

/** Why the orbit does not start with reduced motion on */
export const REPLAY_ALL_ORBIT_REDUCED_MOTION_MESSAGE =
  "The orbit turns the map, so it stays off while reduced motion is on";

/**
 * Controls held while every flight replays, as for the replay of one
 * (REPLAY_DISABLED_CONTROL_IDS in ui/replayManager.ts): the filters, the
 * selection and Wrapped would change or take the map under it. The colour
 * layers too, which colour the trail of one flight and nothing here, and
 * the Heatmap switch: the heat is not the replay's to count.
 */
const HELD_CONTROL_IDS = [
  "heatmap-btn",
  "altitude-btn",
  "airspeed-btn",
  "airports-btn",
  "aviation-btn",
  "wrapped-btn",
  "year-select",
  "aircraft-select",
  "isolate-btn",
  "selection-clear-btn",
  "reset-view-btn",
  "replay-btn",
  "cross-section-btn",
  "hotspot-tour-btn",
];

/** The control that opens and closes the replay of all flights */
const REPLAY_ALL_BUTTON_ID = "replay-all-btn";

/**
 * The tilt a flatter map is turned to while the flights play at their
 * height, and what is flat enough to need it: those of the 3D view
 * (THREE_D_PITCH and THREE_D_MIN_PITCH in ui/mapOrientation.ts). Written
 * out rather than shared: two more exports of the shared chunk renamed
 * those Wrapped's bundle imports, 6 of the 7 bytes it had left.
 */
const TILT_PITCH = 50;
const TILT_MIN_PITCH = 20;

/**
 * Degrees a gesture has to tilt the map by to be a tilt of the user's: a
 * right drag that turns the map tilts it by as much as the pointer strays
 * up or down, a degree for every two pixels
 */
const TILT_BY_HAND_DEG = 5;

/** Pixels kept free around the flights by the fit, the panel below them */
const FIT_PADDING = { top: 40, right: 40, bottom: 110, left: 40 };

/**
 * The seconds of flight a step of the slider moves the clock by, with the
 * arrow keys: a minute, a third of a second at 200 times
 */
const SLIDER_STEP_S = 60;

/** "0:42 into every flight": hours and minutes into every flight */
export function replayAllClock(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  return `${hours}:${String(minutes % 60).padStart(2, "0")} into every flight`;
}

/** An icon-only button of the panel, named by its title */
function panelButton(id: string, iconName: "play" | "reset" | "close") {
  const button = document.createElement("button");
  button.type = "button";
  button.id = id;
  button.className = "btn-surface replay-btn";
  setControlIcon(button, iconName, 20);
  return button;
}

/** Name an icon-only button the same to the eye and the ear */
function nameButton(button: HTMLElement, name: string): void {
  button.title = name;
  button.setAttribute("aria-label", name);
}

/**
 * The "Replay all" control and its panel: play and pause, the clock and
 * its slider, the speed, the orbit and the way out
 */
export class ReplayAllControls {
  readonly player: ReplayAllPlayer;
  private readonly app: MapApp;
  private panel: HTMLElement | null = null;
  private slider: HTMLInputElement | null = null;
  private open = false;
  /** The clock as last written, so a frame writes it only when it changes */
  private shown = "";
  private stopWatchingUser: (() => void) | null = null;
  /**
   * The tilt the close lays the map back to (ReplayState.pitchBefore),
   * which a replay opened again before the map is there starts from
   */
  private layingBack: number | null = null;
  /** Gives the held controls back as they were (see holdControls) */
  private release: (() => void) | null = null;

  constructor(app: MapApp) {
    this.app = app;
    this.player = new ReplayAllPlayer(app);
    this.player.onChange = () => this.sync();
    // Escape leaves it, as it leaves the replay of one flight; not from the
    // speed picker, whose own list it closes, nor from a popup or a marker
    document.addEventListener(
      "keydown",
      (event) => {
        if (!this.open || event.key !== "Escape" || event.defaultPrevented) {
          return;
        }
        const target = event.target;
        if (
          target instanceof Element &&
          target.closest(
            "#replay-all-speed, .maplibregl-popup, .maplibregl-marker",
          )
        ) {
          return;
        }
        event.preventDefault();
        this.close();
      },
      { signal: app.signal },
    );
  }

  /** Whether it is open */
  get isOpen(): boolean {
    return this.open;
  }

  toggle(): void {
    if (this.open) this.close();
    else this.show();
  }

  /** Start every flight the filters keep, and hold the rest of the page */
  show(): void {
    const app = this.app;
    const map = app.map;
    // Not while another has the map, the hotspot tour among them: its
    // control is held then, and this covers a click whose bundle came late
    if (
      this.open ||
      !map ||
      app.replayActive ||
      app.wrappedVisible ||
      app.tourView
    ) {
      return;
    }
    const panel = this.panelOf();
    const speed = Number(
      panel.querySelector<HTMLSelectElement>("select")?.value,
    );
    const ended = this.player.start({ speed });
    if (this.player.flights === 0) {
      if (this.player.unavailable) {
        showToast(REPLAY_ALL_UNAVAILABLE_MESSAGE, "error");
      } else showToast(REPLAY_ALL_NOTHING_MESSAGE, "info");
      return;
    }
    this.open = true;
    const slider = this.slider!;
    slider.max = String(
      Math.ceil(this.player.duration / SLIDER_STEP_S) * SLIDER_STEP_S,
    );
    void ended.then((landed) => {
      if (landed && this.open) this.announce("Every flight has landed");
    });
    this.setOrbit(false);
    app.replayState.all = true;
    app.replayActive = true;
    this.release?.();
    this.release = holdControls(HELD_CONTROL_IDS);
    document.body.classList.add("replay-all-active");
    panel.hidden = false;
    this.shown = "";
    this.sync();
    // The toasts stack above the panel (see features.css), measured with
    // its clock, which on a phone takes a row of its own
    document.body.style.setProperty(
      REPLAY_PANEL_HEIGHT_VAR,
      panel.offsetHeight + "px",
    );
    const button = domCache.get(REPLAY_ALL_BUTTON_ID);
    if (button) {
      setControlIcon(button, "stop");
      applyToggleButtonState(button, true);
    }
    panel.querySelector<HTMLElement>("button")?.focus();

    // The flights fly at their height, which a map seen from straight
    // above does not show: a flatter one is tilted as the 3D view tilts
    // it, and laid back as the replay closes
    const pitch =
      this.layingBack !== null && map.isMoving()
        ? this.layingBack
        : map.getPitch();
    this.layingBack = null;
    const before = pitch < TILT_MIN_PITCH ? pitch : null;
    app.replayState.pitchBefore = before;
    const bounds = this.player.bounds;
    if (bounds) {
      map.fitBounds(
        [
          [bounds[0], bounds[1]],
          [bounds[2], bounds[3]],
        ],
        {
          padding: FIT_PADDING,
          bearing: 0,
          pitch: before === null ? pitch : TILT_PITCH,
          animate: !prefersReducedMotion(),
        },
      );
    }
    // A camera the user moves is theirs: the orbit stops turning it, and
    // a tilt of theirs stays as they leave it, as does the 3D view's
    type UserEvent = { originalEvent?: unknown };
    const moved = map.on("movestart", (event: UserEvent) => {
      if (event.originalEvent && this.player.orbit) this.setOrbit(false);
    });
    let from = 0;
    const tilting = map.on("pitchstart", () => {
      from = map.getPitch();
    });
    const tilted = map.on("pitchend", (event: UserEvent) => {
      if (
        event.originalEvent &&
        Math.abs(map.getPitch() - from) > TILT_BY_HAND_DEG
      ) {
        app.replayState.pitchBefore = null;
      }
    });
    const threeD = app.store.subscribe("threeDVisible", (on) => {
      if (on) app.replayState.pitchBefore = null;
    });
    this.stopWatchingUser = () => {
      moved.unsubscribe();
      tilting.unsubscribe();
      tilted.unsubscribe();
      threeD();
    };
    announceStatus(
      `Replaying ${this.player.flights} flights at ${this.player.speed} times their speed`,
    );
  }

  /** Stop, and give the page back as it was */
  close(): void {
    if (!this.open) return;
    this.open = false;
    this.stopWatchingUser?.();
    this.stopWatchingUser = null;
    this.player.stop();
    if (this.panel) this.panel.hidden = true;
    document.body.style.removeProperty(REPLAY_PANEL_HEIGHT_VAR);
    document.body.classList.remove("replay-all-active");
    const button = domCache.get(REPLAY_ALL_BUTTON_ID);
    if (button) {
      setControlIcon(button, "play");
      applyToggleButtonState(button, false);
    }
    this.release?.();
    this.release = null;
    this.app.replayState.all = false;
    // The layers come back as they were, and the phone's bar with them
    this.app.replayActive = false;
    // As flat as it was, unless the user or the 3D view took the tilt over
    const pitch = this.app.replayState.pitchBefore;
    this.app.replayState.pitchBefore = null;
    if (pitch !== null) {
      this.layingBack = pitch;
      this.app.map?.easeTo({ pitch });
    }
    const target = this.app.mobileBar?.isVisible()
      ? document.getElementById("mobile-tab-more")
      : button;
    target?.focus();
    announceStatus("Replay of all flights closed");
  }

  private setOrbit(on: boolean): void {
    this.player.orbit = on;
    const button = this.panel?.querySelector<HTMLElement>(
      "#replay-all-orbit-btn",
    );
    if (button) applyToggleButtonState(button, on);
  }

  /** The panel as the player stands: stopped from elsewhere, it closes */
  private sync(): void {
    const panel = this.panel;
    if (!panel || !this.open) return;
    const player = this.player;
    if (!player.active) {
      this.close();
      // Its shaders failed in the first frame of this run: said now, and
      // not only at the next click, which finds the player unavailable
      if (player.unavailable) {
        showToast(REPLAY_ALL_UNAVAILABLE_MESSAGE, "error");
      }
      return;
    }
    const play = panel.querySelector<HTMLElement>("#replay-all-play-btn");
    if (play && play.dataset["icon"] !== (player.playing ? "pause" : "play")) {
      setControlIcon(play, player.playing ? "pause" : "play");
      nameButton(
        play,
        player.playing
          ? "Pause the replay of all flights"
          : "Play the replay of all flights",
      );
    }
    const time = Math.min(player.time, player.duration);
    const slider = this.slider!;
    slider.value = String(time);
    const text = replayAllClock(time);
    if (text !== this.shown) {
      this.shown = text;
      const clock = panel.querySelector("#replay-all-clock");
      if (clock) clock.textContent = text;
      slider.setAttribute("aria-valuetext", text);
    }
  }

  private announce(message: string): void {
    const live = this.panel?.querySelector<HTMLElement>("#replay-all-live");
    if (live) announceInRegion(live, message);
  }

  /** The panel, built the first time it is opened */
  private panelOf(): HTMLElement {
    if (this.panel) return this.panel;
    const panel = document.createElement("div");
    panel.id = "replay-all-controls";
    panel.setAttribute("role", "region");
    panel.setAttribute("aria-label", "Replay of all flights");
    panel.hidden = true;

    const play = panelButton("replay-all-play-btn", "play");
    play.addEventListener("click", () => {
      if (this.player.playing) {
        this.player.pause();
        this.announce("Paused");
      } else {
        this.player.resume();
        this.announce("Playing");
      }
    });

    const clock = document.createElement("div");
    clock.id = "replay-all-clock";

    // The clock as a slider: a drag holds it where the thumb is, and lets
    // it play on as the pointer lets go if it played; a click jumps, and
    // the keys step a minute, Home and End to either end
    const slider = document.createElement("input");
    slider.type = "range";
    slider.id = "replay-all-time";
    slider.min = "0";
    slider.step = String(SLIDER_STEP_S);
    slider.setAttribute("aria-label", "Time into every flight");
    slider.addEventListener("input", () => {
      this.player.seek(Number(slider.value));
    });
    slider.addEventListener("pointerdown", () => {
      if (!this.player.playing) return;
      this.player.pause();
      const letGo = (): void => {
        removeEventListener("pointerup", letGo);
        removeEventListener("pointercancel", letGo);
        if (this.open) this.player.resume();
      };
      addEventListener("pointerup", letGo);
      addEventListener("pointercancel", letGo);
    });
    this.slider = slider;

    const speed = document.createElement("select");
    speed.id = "replay-all-speed";
    speed.className = "btn-surface replay-btn";
    speed.setAttribute("aria-label", "Replay speed multiplier");
    for (const value of REPLAY_ALL_SPEEDS) {
      speed.add(new Option(`${value}x`, String(value)));
    }
    speed.value = String(REPLAY_ALL_SPEED);
    speed.addEventListener("change", () => {
      this.player.speed = Number(speed.value);
    });

    // Not disabled under reduced motion, which is asked as it is pressed:
    // a press says why, as the chase view's does
    const orbit = panelButton("replay-all-orbit-btn", "reset");
    nameButton(orbit, "Orbit: turn the map slowly round the flights");
    orbit.setAttribute("aria-pressed", "false");
    orbit.addEventListener("click", () => {
      if (!this.player.orbit && prefersReducedMotion()) {
        showToast(REPLAY_ALL_ORBIT_REDUCED_MOTION_MESSAGE, "info");
        return;
      }
      this.setOrbit(!this.player.orbit);
    });

    const exit = panelButton("replay-all-close-btn", "close");
    nameButton(exit, "Close the replay of all flights");
    exit.addEventListener("click", () => this.close());

    const live = document.createElement("div");
    live.id = "replay-all-live";
    live.className = "visually-hidden";
    live.setAttribute("aria-live", "polite");
    live.setAttribute("aria-atomic", "true");

    panel.append(play, clock, slider, speed, orbit, exit, live);
    document.body.append(panel);
    this.panel = panel;
    return panel;
  }
}

/** The controls of each app, made the first time they are used */
const controlsOf = new WeakMap<MapApp, ReplayAllControls>();

/**
 * The seconds into every flight while the replay of all flights of `app`
 * is open, which the heat is drawn up to (see ui/heatCloud.ts), and null
 * otherwise: Wrapped's intro plays its own player under the whole year
 */
export function replayAllTime(app: MapApp): number | null {
  const controls = controlsOf.get(app);
  return controls?.isOpen ? controls.player.time : null;
}

/** Open or close the replay of all flights of `app` */
export function toggleReplayAll(app: MapApp): void {
  let controls = controlsOf.get(app);
  if (!controls) {
    controls = new ReplayAllControls(app);
    controlsOf.set(app, controls);
  }
  controls.toggle();
}
