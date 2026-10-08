/**
 * Replay of all flights: every flight the filters keep starts from its own
 * first fix at once and plays at a hundred to a thousand times its speed,
 * each a bright head with a trail fading behind it at its height, so the
 * year blooms out of the home field. The only clock is the one each flight
 * carries (see calculations/flightClock.ts): the panel reads "0:42 into
 * every flight", and its slider moves along the same clock, never a date
 * or an hour.
 *
 * ReplayAllPlayer (ui/replayAllPlayer.ts) plays and draws
 * (ui/replayAllLayer.ts), and nothing else:
 * Wrapped's intro plays it under its own camera. ReplayAllControls is the
 * "Replay all" control and its panel: it runs the player as a replay of the
 * map (replayActive), which hides the heatmap and the colour layers and
 * holds the selection, the filters and Wrapped as the replay of one flight
 * does, fits the camera to the flights north up, tilted as the 3D view
 * tilts it, and turns it slowly round them on request. The heat builds up
 * behind the flights instead of the heatmap, as far as the clock has come
 * (see replayAllTime) and at the height of the flights, unless the
 * Heatmap switch is off.
 *
 * The same panel plays a selection of several flights one after another,
 * from the Replay control (toggleSequence): in the order of their files,
 * each from where the one before has landed and a short pause
 * (LEG_PAUSE_S), at the speeds and with the slider of the replay of all
 * flights, for a quick look at a day of several. Its clock reads which of
 * them flies and the time into it ("2 of 3, EDDS → EDTF: 0:42 in"), never
 * a date or an hour; its trails stay to the end, and no heat builds up
 * behind them, which would be of every flight at once.
 */
import type { LngLat } from "maplibre-gl";
import type { MapApp } from "../mapApp";
import type { PathSegment } from "../types";
import { fitTilted, sequenceLeg } from "../calculations/replayAll";
import { flightOrder } from "../calculations/flightProfile";
import { flightClockOf } from "../calculations/flightClock";
import { datasetIndex, shownSelection } from "../calculations/datasetIndex";
import {
  segmentRangesFor,
  segmentsForPathIds,
} from "../calculations/statistics";
import { flightRoute } from "./airportFlights";
import { pluralFlights } from "../utils/htmlGenerators";
import { REPLAY_PRECONDITION_MESSAGE } from "./replayButton";
import { MAP_MAX_ZOOM } from "../utils/constants";
import { applyToggleButtonState } from "../utils/buttonState";
import {
  focusModeControl,
  focusWasIn,
  holdControls,
  REPLAY_HELD_CONTROL_IDS,
} from "./heldControls";
import { domCache } from "../utils/domCache";
import { setControlIcon } from "../utils/icons";
import { FIELDS, isPageEscape } from "../utils/mapHelpers";
import { prefersReducedMotion } from "../utils/motion";
import { announceInRegion, announceStatus, showToast } from "../utils/toast";
import { nameButton } from "./crossSectionElements";
import { followPanelHeight } from "./replayManager";
import { restingPitch } from "./replayState";
import { mapChromePadding } from "./pathSelection";
import { REPLAY_ALL_SPEED, ReplayAllPlayer } from "./replayAllPlayer";

/** The speeds the panel offers, in seconds of flight per second */
const REPLAY_ALL_SPEEDS = [100, 200, 300, 500, 1000] as const;

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
 * the Heatmap switch, which says as the replay opens whether the heat
 * builds up behind the flights.
 */
const HELD_CONTROL_IDS = [
  ...REPLAY_HELD_CONTROL_IDS,
  "altitude-btn",
  "airspeed-btn",
];

/** The control that opens and closes the replay of all flights */
const REPLAY_ALL_BUTTON_ID = "replay-all-btn";

/**
 * The control that opens and closes the replay of the selected flights
 * one after another, which holds the other, as the other holds it
 */
const REPLAY_BUTTON_ID = "replay-btn";

/**
 * The tilt a flatter map is turned to while the flights play at their
 * height, and what is flat enough to need it: those of the 3D view
 * (THREE_D_PITCH and THREE_D_MIN_PITCH in ui/mapOrientation.ts). Written
 * out rather than shared: two more exports of the shared chunk cost every
 * bundle that imports from it some bytes for nothing to share.
 */
const TILT_PITCH = 50;
const TILT_MIN_PITCH = 20;

/**
 * Degrees a gesture has to tilt the map by to be a tilt of the user's: a
 * right drag that turns the map tilts it by as much as the pointer strays
 * up or down, a degree for every two pixels
 */
const TILT_BY_HAND_DEG = 5;

/** Pixels kept free between the flights and the panel below them */
const FIT_MARGIN_PX = 24;

/**
 * The seconds of flight a step of the slider moves the clock by, with the
 * arrow keys: a minute, a third of a second at 200 times
 */
const SLIDER_STEP_S = 60;

/** "0:42": hours and minutes */
function hoursMinutes(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  return `${hours}:${String(minutes % 60).padStart(2, "0")}`;
}

/** "0:42 into every flight": hours and minutes into every flight */
export function replayAllClock(seconds: number): string {
  return `${hoursMinutes(seconds)} into every flight`;
}

/**
 * "2 of 3, EDDS → EDTF: 0:42 in": which of the flights played one after
 * another flies at `time` (the last to have started, and still the one
 * that landed during the pause after it), named by `route`, and the hours
 * and minutes into it
 */
function sequenceClock(
  player: ReplayAllPlayer,
  time: number,
  route: (pathId: number) => string,
): string {
  const legs = player.legs!;
  const [pathId, start] = sequenceLeg(legs, time)!;
  const into = Math.min(time, player.legTime(pathId)) - start;
  const place = [...legs.keys()].indexOf(pathId) + 1;
  return `${place} of ${legs.size}, ${route(pathId)}: ${hoursMinutes(into)} in`;
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

/**
 * The "Replay all" control and its panel: play and pause, the clock and
 * its slider, the speed, the orbit and the way out
 */
export class ReplayAllControls {
  readonly player: ReplayAllPlayer;
  private readonly app: MapApp;
  private panel: HTMLElement | null = null;
  /** The parts of the panel every frame writes, found as it is built */
  private playButton: HTMLElement | null = null;
  private clock: HTMLElement | null = null;
  private slider: HTMLInputElement | null = null;
  private open = false;
  /**
   * The control of what plays: the replay of all flights', or Replay's for
   * the selected flights one after another
   */
  private control = REPLAY_ALL_BUTTON_ID;
  /** What plays, as the panel's names say it */
  private what = "all flights";
  /** The clock as last written, so a frame writes it only when it changes */
  private shown = "";
  private stopWatchingUser: (() => void) | null = null;
  /** Gives the held controls back as they were (see holdControls) */
  private release: (() => void) | null = null;
  /** Ends followPanelHeight of the open panel */
  private unfollowPanel: (() => void) | null = null;

  constructor(app: MapApp) {
    this.app = app;
    this.player = new ReplayAllPlayer(app);
    this.player.onChange = () => this.sync();
    // Each play-through, also from the start again after the end
    this.player.onLanded = () => {
      if (this.open) this.announce("Every flight has landed");
    };
    // Escape leaves it, as it leaves the replay of one flight; not from the
    // speed picker, whose own list it closes, nor from a text field, nor
    // from a popup or a marker
    document.addEventListener(
      "keydown",
      (event) => {
        if (!this.open || !isPageEscape(event, FIELDS)) return;
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

  /**
   * Start every flight the filters keep, or the flights `sequence` one
   * after another in its order, and hold the rest of the page
   */
  show(sequence?: readonly number[]): void {
    const app = this.app;
    const map = app.map;
    // Not while another has the map, the hotspot tour among them: its
    // control is held then, and this covers a click whose bundle came late
    if (this.open || !map || app.mapHeld) return;
    const panel = this.panelOf();
    const speed = Number(
      panel.querySelector<HTMLSelectElement>("select")?.value,
    );
    void this.player.start(
      sequence ? { speed, pathIds: sequence, sequence: true } : { speed },
    );
    if (this.player.flights === 0) {
      if (this.player.unavailable) {
        showToast(REPLAY_ALL_UNAVAILABLE_MESSAGE, "error");
      } else {
        // The selected flights say it as the replay of one does
        showToast(
          sequence ? REPLAY_PRECONDITION_MESSAGE : REPLAY_ALL_NOTHING_MESSAGE,
          "info",
        );
      }
      return;
    }
    // A popup left open on the map, a tapped flight's or an airport's,
    // would stay over the replay, as for the replay of one flight
    // (ReplayManager): before replayActive, which a popup closing reads
    app.airportManager.closePopup();
    app.layerManager.closeSegmentPopup();
    this.open = true;
    const control = (this.control = sequence
      ? REPLAY_BUTTON_ID
      : REPLAY_ALL_BUTTON_ID);
    const what = (this.what = sequence
      ? "the selected flights"
      : "all flights");
    panel.setAttribute("aria-label", "Replay of " + what);
    nameButton(
      panel.querySelector("#replay-all-close-btn")!,
      "Close the replay of " + what,
    );
    const slider = this.slider!;
    slider.setAttribute(
      "aria-label",
      sequence ? "Time into the selected flights" : "Time into every flight",
    );
    slider.max = String(
      Math.ceil(this.player.duration / SLIDER_STEP_S) * SLIDER_STEP_S,
    );
    this.setOrbit(false);
    app.replayState.all = true;
    app.replayActive = true;
    this.release?.();
    this.release = holdControls(
      [...HELD_CONTROL_IDS, sequence ? REPLAY_ALL_BUTTON_ID : REPLAY_BUTTON_ID],
      "the replay of " + what,
      this.app.signal,
    );
    document.body.classList.add("replay-all-active");
    panel.hidden = false;
    this.shown = "";
    this.sync();
    // The toasts stack above the panel (see features.css), measured with
    // its clock, which on a phone takes a row of its own
    this.unfollowPanel?.();
    this.unfollowPanel = followPanelHeight(panel, this.app.signal);
    const button = domCache.get(control);
    if (button) {
      setControlIcon(button, "stop");
      applyToggleButtonState(button, true);
    }
    panel.querySelector<HTMLElement>("button")?.focus();

    // The flights fly at their height, which a map seen from straight
    // above does not show: a flatter one is tilted as the 3D view tilts
    // it, and laid back as the replay closes
    const pitch = restingPitch(app);
    const before = pitch < TILT_MIN_PITCH ? pitch : null;
    app.replayState.pitchBefore = before;
    const fit = this.fit(before === null ? pitch : TILT_PITCH, panel);
    if (fit) {
      const { flat, ...camera } = fit;
      map.easeTo({
        ...camera,
        animate: !prefersReducedMotion(),
      });
      this.player.thinOut(camera.zoom - flat);
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
      `Replaying ${pluralFlights(this.player.flights)}${sequence ? " one after another" : ""} at ${this.player.speed} times their speed`,
    );
  }

  /** Stop, and give the page back as it was */
  close(): void {
    if (!this.open) return;
    this.open = false;
    const hadFocus = focusWasIn(this.panel);
    this.stopWatchingUser?.();
    this.stopWatchingUser = null;
    this.player.stop();
    if (this.panel) this.panel.hidden = true;
    this.unfollowPanel?.();
    this.unfollowPanel = null;
    document.body.classList.remove("replay-all-active");
    const button = domCache.get(this.control);
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
    const state = this.app.replayState;
    const pitch = state.pitchBefore;
    const map = this.app.map;
    state.pitchBefore = null;
    if (pitch !== null && map) {
      map.easeTo({ pitch });
      // Until the map gets there: a tilt the user gives it later is theirs
      // (see restingPitch). Registered after the ease, whose start ends the
      // move before it.
      state.layingBack = pitch;
      map.once("moveend", () => {
        state.layingBack = null;
      });
    }
    if (hadFocus) focusModeControl(this.app, this.control);
    announceStatus(`Replay of ${this.what} closed`);
  }

  /**
   * Where the camera shows the flights of the run as large as the map
   * allows, north up and tilted by `pitch`: clear of the panels along its
   * edges (mapChromePadding) and of the replay's own, `panel`, below them.
   * The fit of their bounds is where it starts from (see fitTilted), and
   * its zoom, `flat`, the one of a flat map.
   */
  private fit(pitch: number, panel: HTMLElement) {
    const map = this.app.map!;
    const run = this.player.run;
    const bounds = run?.bounds;
    if (!run || !bounds) return null;
    const box = map.getContainer().getBoundingClientRect();
    const padding = mapChromePadding(map);
    padding.bottom = Math.max(
      padding.bottom,
      box.bottom - panel.getBoundingClientRect().top + FIT_MARGIN_PX,
    );
    const start = map.cameraForBounds(
      [
        [bounds[0], bounds[1]],
        [bounds[2], bounds[3]],
      ],
      { padding, bearing: 0 },
    );
    if (!start) return null;
    const { lng, lat } = start.center as LngLat;
    const camera = fitTilted(
      run,
      { center: [lng, lat], zoom: start.zoom! },
      {
        width: box.width,
        height: box.height,
        padding,
        pitch,
        fov: map.getVerticalFieldOfView(),
      },
      MAP_MAX_ZOOM,
    );
    return { ...camera, bearing: 0, pitch, flat: start.zoom! };
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
    const play = this.playButton;
    if (play && play.dataset["icon"] !== (player.playing ? "pause" : "play")) {
      setControlIcon(play, player.playing ? "pause" : "play");
      nameButton(
        play,
        `${player.playing ? "Pause" : "Play"} the replay of ${this.what}`,
      );
    }
    const time = Math.min(player.time, player.duration);
    const slider = this.slider!;
    slider.value = String(time);
    const data = this.app.currentData;
    const text =
      player.legs && data
        ? sequenceClock(player, time, (pathId) =>
            flightRoute(datasetIndex(data).pathInfoById.get(pathId)!),
          )
        : replayAllClock(time);
    if (text !== this.shown) {
      this.shown = text;
      if (this.clock) this.clock.textContent = text;
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
    // Named, as its slider and close button are, by what plays (see show)
    panel.setAttribute("role", "region");
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

    this.playButton = play;
    const clock = document.createElement("div");
    clock.id = "replay-all-clock";
    this.clock = clock;

    // The clock as a slider: a drag holds it where the thumb is, and lets
    // it play on as the pointer lets go if it played; a click jumps, and
    // the keys step a minute, Home and End to either end
    const slider = document.createElement("input");
    slider.type = "range";
    slider.id = "replay-all-time";
    slider.min = "0";
    slider.step = String(SLIDER_STEP_S);
    slider.addEventListener("input", () => {
      this.player.seek(Number(slider.value));
    });
    slider.addEventListener("pointerdown", () => {
      if (!this.player.playing) return;
      this.player.pause();
      // Not from the end, where it would start again from the first flight:
      // the flights one after another end as the last lands, and a drag or
      // a click there stays with it, paused. Every flight at once plays on
      // from there while the trails fade.
      const letGo = (): void => {
        removeEventListener("pointerup", letGo);
        removeEventListener("pointercancel", letGo);
        if (this.open && !this.player.finished) this.player.resume();
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

/** The controls of `app`, made the first time they are wanted */
function controlsFor(app: MapApp): ReplayAllControls {
  let controls = controlsOf.get(app);
  if (!controls) {
    controls = new ReplayAllControls(app);
    controlsOf.set(app, controls);
  }
  return controls;
}

/**
 * The seconds into every flight while the replay of all flights of `app`
 * is open, which the heat is drawn up to (see ui/heatCloud.ts), and null
 * otherwise: Wrapped's intro plays its own player under the whole year.
 * Null as well while the selected flights play one after another, whose
 * clock is not the one of every flight the heat is of.
 */
export function replayAllTime(app: MapApp): number | null {
  const controls = controlsOf.get(app);
  return controls?.isOpen && !controls.player.legs
    ? controls.player.time
    : null;
}

/**
 * Open or close the replay of all flights of `app`; not the selected flights
 * one after another, which hold its control, and which a click whose bundle
 * came late found playing
 */
export function toggleReplayAll(app: MapApp): void {
  const controls = controlsFor(app);
  if (!controls.player.legs) controls.toggle();
}

/**
 * Play the flights selected in `app` one after another, in the order of
 * their files (flightOrder), or close their replay, as the Replay control
 * does with more than one selected. Flights without timing data are left
 * out, and a toast says how many. With `at`, it opens paused at that
 * `fraction` of the dataset's segment `segment` on its flight's clock
 * (FlightClock), which shortens breaks in the log: a click on the profile
 * of the flights (ui/flightProfile.ts), which runs along the logged times.
 * The replay of all flights, which a click whose bundle came late found
 * open, stays open.
 */
export function toggleSequence(
  app: MapApp,
  at?: { segment: PathSegment; fraction: number },
): void {
  const controls = controlsFor(app);
  const data = app.currentData;
  if (controls.isOpen) {
    if (controls.player.legs) controls.close();
    return;
  }
  if (!data) return;
  // Decided again: a click whose bundle came late found another selection,
  // of one flight, or of more than play one after another. Replay takes it
  // as it is now: one flight replays, and too many are said to be.
  if (!app.canReplay() || !app.playsInSequence()) {
    app.toggleReplay();
    return;
  }
  // Of those the filter shows: share mode keeps flights it hides, which
  // the map does not draw (shownSelection)
  const order = flightOrder(data.path_info, shownSelection(app));
  const timed = order.filter((pathId) =>
    segmentsForPathIds(data.path_segments, [pathId]).some(
      (segment) => (segment.time ?? 0) > 0,
    ),
  );
  controls.show(timed);
  if (!controls.isOpen) return;
  // The player leaves out as well a flight whose clock is too short to
  // play by (sequenceStarts): its times are all within a second
  const left = order.length - controls.player.flights;
  if (left > 0) {
    showToast(
      `Left out ${left} of the ${order.length} selected flights: not enough timing data`,
      "info",
    );
  }
  if (at) {
    const { segment, fraction } = at;
    const segments = data.path_segments;
    // Looked for among its flight's own segments, which are side by side
    const i = segments.indexOf(
      segment,
      segmentRangesFor(segments)?.get(segment.path_id)?.[0],
    );
    const clock = flightClockOf(segments);
    const player = controls.player;
    player.pause();
    player.seek(
      player.legTime(
        segment.path_id,
        (clock.start[i] ?? 0) + fraction * (clock.spent[i] ?? 0),
      ),
    );
  }
}
