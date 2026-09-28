/**
 * The hotspot tour: a short flight over the busiest places of the heat,
 * a way into the 3D view that explains itself.
 *
 * It finds the places where the heat the map shows is strongest
 * (calculations/hotspots.ts: the filters and Isolate count, and the heat
 * is weighed by the By distance switch, as for the heatmap),
 * turns the 3D view and the heatmap on, and flies to each in turn,
 * tilted, turning slowly over it while a caption names the place and the
 * time spent there, or by distance the distance flown there. Pause, the
 * previous and the next place and Stop are in its panel; Escape stops it
 * too. The 3D view is turned on as the switch of the store, not by its
 * control, which turns the altitude colours on for a map without a layer
 * of the flights: the heatmap is on here, and the cloud is what is looked
 * at.
 *
 * How it ends decides where the user is left. Played to the end, stopped
 * or Escaped, it flies back to the view it started from with the switches
 * as they were: it was a look round, and the user's view, the link and
 * the saved state are what they had. A press, a wheel or a key on the map
 * ends it where it is instead, in the 3D view: the user has taken the map
 * over there, which is what the tour is the way into. Until then the state
 * manager saves the view the tour started from (tourView in the store), as
 * it saves the one Wrapped holds.
 *
 * Under reduced motion nothing flies or turns: the camera cuts to each
 * place, and the tour stays there until the user steps on, with nothing to
 * pause.
 *
 * It holds the filters, the weighing switches, the selection and the
 * features that would take the map (Replay, Replay all, Wrapped, the
 * cross-section, which it closes) while it runs, as the replay does, and
 * none of those starts it. On a phone, the bar under it waits, inert. The
 * readout of the cloud under the pointer hides meanwhile (features.css):
 * the camera moves under a pointer resting on the map.
 *
 * The cloud shows every height while it runs, as in Wrapped: the heat of
 * a caption is all of the heat there, and a band of heights that leaves
 * out the ground would leave the home field dark. The band's
 * control hides (features.css), and the user's band comes back as the
 * tour ends, however it ends; the state manager saves it meanwhile.
 */
import type { Map as MapLibreMap } from "maplibre-gl";
import type { MapApp } from "../mapApp";
import type { UserMapView } from "./wrappedManager";
import { datasetIndex } from "../calculations/datasetIndex";
import {
  findHotspots,
  hotspotDetail,
  hotspotName,
  type Hotspot,
} from "../calculations/hotspots";
import { heatWeight } from "../calculations/heatLines";
import { findHomeBase } from "../features/airports";
import { siteData } from "../state/siteData";
import { applyToggleButtonState } from "../utils/buttonState";
import { domCache } from "../utils/domCache";
import {
  DEGREES_TO_RADIANS,
  EARTH_CIRCUMFERENCE_M,
  TILE_SIZE_PX,
} from "../utils/geometry";
import { setControlIcon, type IconName } from "../utils/icons";
import { mapSize, toLngLat } from "../utils/mapHelpers";
import { prefersReducedMotion } from "../utils/motion";
import { announceInRegion, announceStatus, showToast } from "../utils/toast";
import {
  flyToStop,
  followTakeover,
  jumpToStop,
  restCamera,
  turnTo,
  type CameraStop,
} from "./cameraScript";
import { crossSectionOpen, toggleCrossSection } from "./crossSection";

/** How long the camera flies from one place to the next, in ms */
export const TOUR_FLY_MS = 4000;

/** How long it stays over a place, turning, in ms */
export const TOUR_DWELL_MS = 7000;

/** How far it turns over a place, in degrees: under 4 a second */
export const TOUR_TURN_DEG = 25;

/** How long the flight back to the user's view takes, in ms */
export const TOUR_RETURN_MS = 2500;

/** The shortest flight a resumed leg takes, however little of it was left */
const TOUR_MIN_LEG_MS = 600;

/** How far the camera is tilted over a place, as Wrapped's intro over home */
const TOUR_PITCH = 60;

/**
 * How much of the ground the smaller side of the map spans over a place:
 * this many times the place's radius (Hotspot.radiusM), and at least
 * TOUR_MIN_SPAN_M, within the zooms of TOUR_ZOOM
 */
const TOUR_SPAN_RADII = 8;
const TOUR_MIN_SPAN_M = 12000;
const TOUR_ZOOM = { min: 9, max: 13 };

/** The control that starts and stops the tour */
const TOUR_BUTTON_ID = "hotspot-tour-btn";

/** The class of the body while the tour runs (features.css) */
const TOUR_ACTIVE_CLASS = "hotspot-tour-active";

/** The panel's height, which the toasts stack above (features.css) */
const TOUR_PANEL_HEIGHT_VAR = "--tour-panel-h";

/** Said when the view has no time logged anywhere to tour */
export const TOUR_NOTHING_MESSAGE =
  "No flight in this view has logged time to tour";

/**
 * Controls held while the tour runs: the filters and the selection, which
 * would change what it tours; the switches it turns on; and what would
 * take the map from it
 */
const HELD_CONTROL_IDS = [
  "heatmap-btn",
  "three-d-btn",
  "compass-btn",
  "compass-float-btn",
  "year-select",
  "aircraft-select",
  "by-distance-btn",
  "isolate-btn",
  "selection-clear-btn",
  "reset-view-btn",
  "replay-btn",
  "replay-all-btn",
  "wrapped-btn",
  "cross-section-btn",
];

/** Keys pressed on the map that do not take it over */
const KEYS_NOT_TAKING_OVER = new Set([
  "Escape",
  "Tab",
  "Shift",
  "Control",
  "Alt",
  "Meta",
]);

/**
 * The view the tour started from, which it goes back to and the state
 * manager saves while it runs: Wrapped's, the heatmap switch and the band
 * of heights of the cloud
 */
export interface TourView extends UserMapView {
  heatmapVisible: boolean;
  heightBand: string;
}

/** Where the camera of a view is */
type TourCamera = Pick<UserMapView, "center" | "zoom" | "bearing" | "pitch">;

/** A place of the tour, as it is shown */
export interface TourStop {
  /** "Home field EDAQ Halle-Oppin" */
  name: string;
  /** "32 h, 22% of the time" */
  detail: string;
  camera: CameraStop;
}

/**
 * The map zoom over a place: its ground as TOUR_SPAN_RADII says across
 * the smaller side of a map of `width` by `height` pixels
 */
export function tourZoom(
  hotspot: Hotspot,
  width: number,
  height: number,
): number {
  const span = Math.max(hotspot.radiusM * TOUR_SPAN_RADII, TOUR_MIN_SPAN_M);
  const metresPerPixel = span / Math.max(Math.min(width, height), 1);
  const cos = Math.cos(hotspot.center[0] * DEGREES_TO_RADIANS);
  const zoom = Math.log2(
    (EARTH_CIRCUMFERENCE_M * cos) / (TILE_SIZE_PX * metresPerPixel),
  );
  return Math.min(Math.max(zoom, TOUR_ZOOM.min), TOUR_ZOOM.max);
}

/**
 * The places of the tour of what the heatmap of `app` shows on `map`,
 * busiest first, the camera over the first facing as the map does and
 * turned on by TOUR_TURN_DEG over each one after it, where the turn over
 * the one before ended
 */
function tourStops(app: MapApp, map: MapLibreMap): TourStop[] {
  const data = app.currentData;
  if (!data) return [];
  const view = datasetIndex(data).filter(
    app.selectedYear,
    app.selectedAircraft,
  );
  const kept = view.pathIds;
  const selected = app.selectedPathIds;
  const keep =
    app.isolateSelection && selected.size > 0
      ? (pathId: number) => kept.has(pathId) && selected.has(pathId)
      : (pathId: number) => kept.has(pathId);
  const home = findHomeBase(view.airportCounts());
  const airports = siteData.airports ?? [];
  const { width, height } = mapSize(map);
  const bearing = map.getBearing();
  const route = app.routeWeighting;
  const weigh = heatWeight(route);
  return findHotspots(data.path_segments, keep, weigh).map(
    (hotspot, index) => ({
      name: hotspotName(hotspot.center, airports, home),
      detail: hotspotDetail(hotspot, route),
      camera: {
        center: hotspot.center,
        zoom: tourZoom(hotspot, width, height),
        pitch: TOUR_PITCH,
        bearing: bearing + index * TOUR_TURN_DEG,
      },
    }),
  );
}

/** An icon-only button of the panel */
function tourButton(id: string, icon: IconName, onClick: () => void) {
  const button = document.createElement("button");
  button.type = "button";
  button.id = id;
  button.className = "btn-surface replay-btn";
  setControlIcon(button, icon, 20);
  button.addEventListener("click", onClick);
  return button;
}

/** Name an icon-only button, for the eye and the ear */
function nameButton(button: HTMLElement, name: string): void {
  button.title = name;
  button.setAttribute("aria-label", name);
}

/** How the tour ends, see the module's comment */
type TourEnd =
  /** Back to the view and the switches it started from */
  | "return"
  /** Left where it is: the user has taken the map over */
  | "takeover"
  /** The switches back, the camera left to what took the map */
  | "abandon";

/** The parts of the panel the tour writes to */
interface TourPanel {
  root: HTMLElement;
  count: HTMLElement;
  name: HTMLElement;
  detail: HTMLElement;
  previous: HTMLButtonElement;
  play: HTMLButtonElement;
  next: HTMLButtonElement;
  live: HTMLElement;
}

/** The tour of one app, and its panel */
export class HotspotTour {
  private readonly app: MapApp;
  /** The map of the app, while the tour runs */
  private map: MapLibreMap | null = null;
  private stops: TourStop[] = [];
  private index = 0;
  /** Whether it moves on by itself; never under reduced motion */
  private playing = false;
  /** Whether it only steps on as asked: reduced motion, as it started */
  private stepping = false;
  /** What the camera is doing at the place of `index` */
  private phase: "fly" | "dwell" = "fly";
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** When the phase ends, by Date.now() */
  private due = 0;
  /** What was left of the phase as the tour paused, in ms */
  private left = 0;
  /**
   * Whether the camera flies to the place of a step taken while the tour
   * is paused, which goes on as asked: a pause stops only the flight that
   * was under way as it was pressed
   */
  private flying = false;
  /** The user's view, while it runs */
  private saved: TourView | null = null;
  /**
   * Whether a move of the tour's own is under way: one the map has not
   * ended, as it ends a move for another that starts (see end)
   */
  private moving = false;
  /**
   * The view the camera flies back to after the tour, until it gets
   * there or is stopped: a tour started again on the way goes back to it,
   * not to wherever the flight back had come to
   */
  private returning: TourCamera | null = null;
  /** The held controls, and whether each was disabled before */
  private readonly held = new Map<
    HTMLButtonElement | HTMLSelectElement,
    boolean
  >();
  /** Ends what follows the map and the store while it runs */
  private listening: AbortController | null = null;
  private panel: TourPanel | null = null;

  constructor(app: MapApp) {
    this.app = app;
    // Escape stops it, as it closes the replay; not from a popup or a
    // marker, which it closes first
    document.addEventListener(
      "keydown",
      (event) => {
        if (!this.map || event.key !== "Escape" || event.defaultPrevented) {
          return;
        }
        const target = event.target;
        if (
          target instanceof Element &&
          target.closest(".maplibregl-popup, .maplibregl-marker")
        ) {
          return;
        }
        event.preventDefault();
        this.stop();
      },
      { signal: app.signal },
    );
    // An app made anew on the page builds a panel of its own
    app.signal.addEventListener("abort", () => {
      this.end("abandon");
      this.panel?.root.remove();
    });
  }

  /** Whether it runs */
  get isOpen(): boolean {
    return this.map !== null;
  }

  /** Whether it moves on by itself */
  get isPlaying(): boolean {
    return this.playing;
  }

  /** The place it is at or on its way to, from 0 */
  get current(): number {
    return this.index;
  }

  /** How many places it has */
  get length(): number {
    return this.stops.length;
  }

  toggle(): void {
    if (this.map) this.stop();
    else this.start();
  }

  /**
   * Start at the busiest place of what the heatmap shows. Not while a
   * replay runs or Wrapped is open, which have the map, nor for a view
   * without time logged anywhere, which says so.
   */
  start(): void {
    const app = this.app;
    const map = app.map;
    if (this.map || !map || app.replayActive || app.wrappedVisible) return;
    const stops = tourStops(app, map);
    if (stops.length === 0) {
      showToast(TOUR_NOTHING_MESSAGE, "info");
      return;
    }
    // Its line is drawn on the map the camera flies from, as for a replay
    if (crossSectionOpen(app)) toggleCrossSection(app);
    this.map = map;
    this.stops = stops;
    const center = map.getCenter();
    const saved: TourView = {
      center: { lat: center.lat, lng: center.lng },
      zoom: map.getZoom(),
      bearing: map.getBearing(),
      pitch: map.getPitch(),
      // On the way back from a tour before, the view that one started from
      ...this.returning,
      globeVisible: app.globeVisible,
      threeDVisible: app.threeDVisible,
      heatmapVisible: app.heatmapVisible,
      heightBand: app.heightBand,
    };
    this.returning = null;
    this.saved = saved;
    // Before the switches, whose change the state manager saves
    app.tourView = saved;
    app.store.batch(() => {
      app.threeDVisible = true;
      app.heatmapVisible = true;
      app.heightBand = "";
    });
    this.hold(true);
    this.showRunning(true);

    const listening = new AbortController();
    this.listening = listening;
    // The map ends a move as it comes to rest, is stopped, or another
    // starts, and the script's rest (restCamera) ends it too
    const moved = map.on("moveend", () => {
      this.moving = false;
    });
    followTakeover(
      map,
      () => this.end("takeover"),
      listening.signal,
      (event) =>
        event instanceof KeyboardEvent && KEYS_NOT_TAKING_OVER.has(event.key),
    );
    const store = app.store;
    const unsubscribe = [
      // Other flights are not what it was asked to tour
      store.subscribe("currentData", () => this.end("return")),
      // Nor is the map its own any more once either comes on
      store.subscribeKeys(["replayActive", "wrappedVisible"], () =>
        this.end("abandon"),
      ),
    ];
    listening.signal.addEventListener("abort", () => {
      for (const stop of unsubscribe) stop();
      moved.unsubscribe();
    });

    this.stepping = prefersReducedMotion();
    this.playing = !this.stepping;
    const panel = this.panelOf();
    panel.root.hidden = false;
    this.goTo(0);
    (this.stepping ? panel.next : panel.play).focus();
  }

  /** Stop, and fly back to the view it started from */
  stop(): void {
    this.end("return");
  }

  /** Hold it where it is */
  pause(): void {
    if (!this.map || !this.playing) return;
    this.playing = false;
    clearTimeout(this.timer);
    this.left = Math.max(this.due - Date.now(), 0);
    this.flying = false;
    this.moving = false;
    this.map.stop();
    restCamera(this.map);
    this.sync();
    this.announce("Tour paused");
  }

  /** Go on from where it was held */
  resume(): void {
    const map = this.map;
    if (!map || this.playing || this.stepping) return;
    this.playing = true;
    if (this.phase === "dwell") {
      this.turn(this.left);
    } else if (this.flying) {
      // Lands as it would have: no new flight from half way
      this.after(Math.max(this.due - Date.now(), 0), () => this.dwell());
    } else {
      const left = Math.max(this.left, TOUR_MIN_LEG_MS);
      flyToStop(map, this.stops[this.index]!.camera, left);
      this.moving = true;
      this.after(left, () => this.dwell());
    }
    this.flying = false;
    this.sync();
    this.announce("Tour playing");
  }

  /** The next place, or the end after the last */
  next(): void {
    if (!this.map) return;
    if (this.index + 1 >= this.stops.length) this.stop();
    else this.goTo(this.index + 1);
  }

  /** The place before; none before the first */
  previous(): void {
    if (this.map && this.index > 0) this.goTo(this.index - 1);
  }

  /**
   * Go to the place of `index`: fly there and turn over it while it plays,
   * fly there and wait while it is paused, cut to it under reduced motion
   */
  private goTo(index: number): void {
    const map = this.map!;
    const stop = this.stops[index]!;
    this.index = index;
    clearTimeout(this.timer);
    this.sync();
    this.announce(
      `${index + 1} of ${this.stops.length}: ${stop.name}, ${stop.detail}`,
    );
    if (this.stepping) {
      this.phase = "dwell";
      jumpToStop(map, stop.camera);
      restCamera(map);
      return;
    }
    this.phase = "fly";
    this.due = Date.now() + TOUR_FLY_MS;
    this.flying = !this.playing;
    flyToStop(map, stop.camera, TOUR_FLY_MS);
    // After the move, which ends the one before
    this.moving = true;
    if (this.playing) this.after(TOUR_FLY_MS, () => this.dwell());
  }

  /**
   * Arrived: the app follows the view it came to (the relief level and its
   * exaggeration above all, which stays the one of where the flight set
   * off until then), and the camera turns over the place, then moves on
   */
  private dwell(): void {
    this.phase = "dwell";
    restCamera(this.map!);
    this.turn(TOUR_DWELL_MS);
  }

  /** Turn to where the turn over this place ends, in `ms`, then move on */
  private turn(ms: number): void {
    const bearing = this.stops[this.index]!.camera.bearing + TOUR_TURN_DEG;
    turnTo(this.map!, bearing, ms);
    this.moving = true;
    this.after(ms, () => this.next());
  }

  /** Take the next step in `ms`; a pause, a step or the end cancel it */
  private after(ms: number, step: () => void): void {
    clearTimeout(this.timer);
    this.due = Date.now() + ms;
    this.timer = setTimeout(step, ms);
  }

  private end(how: TourEnd): void {
    const map = this.map;
    if (!map) return;
    const app = this.app;
    const saved = this.saved!;
    const panel = this.panel!;
    const hadFocus = panel.root.contains(document.activeElement);
    this.map = null;
    this.saved = null;
    this.playing = false;
    clearTimeout(this.timer);
    this.listening?.abort();
    this.listening = null;
    app.tourView = null;
    this.hold(false);
    this.showRunning(false);
    panel.root.hidden = true;
    document.body.style.removeProperty(TOUR_PANEL_HEIGHT_VAR);
    if (app.signal.aborted) return;
    if (how === "takeover") {
      // A click or a key that moves nothing does not stop the camera, which
      // would fly and turn on to where the script put it, out of the app's
      // sight: it stops here. A press comes before MapLibre's mouse and
      // touch events, so the drag it starts goes on. The view and the
      // switches are the user's now, saved as they are.
      map.stop();
      restCamera(map);
    } else if (how === "abandon" && this.moving) {
      // A flight or a turn of the tour's own would go on under what took
      // the map, out of the app's sight. Only its own: a move of what took
      // the map has ended it already (see `moving`).
      map.stop();
    }
    this.moving = false;
    // The band of heights is the user's whichever way it ends; the view
    // and the switches the user took the map over with are theirs too
    app.store.batch(() => {
      app.heightBand = saved.heightBand;
      if (how === "takeover") return;
      app.threeDVisible = saved.threeDVisible;
      app.heatmapVisible = saved.heatmapVisible;
    });
    if (how === "takeover") app.stateManager.scheduleSave();
    if (how === "return") {
      const { center, zoom, bearing, pitch } = saved;
      const returning: TourCamera = { center, zoom, bearing, pitch };
      // Not a scripted move: the app follows it as it comes to rest
      const view = {
        ...returning,
        center: toLngLat([center.lat, center.lng]),
      };
      if (prefersReducedMotion()) map.jumpTo(view);
      else {
        map.flyTo({ ...view, duration: TOUR_RETURN_MS });
        // Until it gets there or is stopped: registered after the flight,
        // whose start ended the move before it
        this.returning = returning;
        map.once("moveend", () => {
          if (this.returning === returning) this.returning = null;
        });
      }
    }
    // A button that hides drops its focus to <body>
    if (hadFocus) {
      const target = app.mobileBar?.isVisible()
        ? document.getElementById("mobile-tab-more")
        : domCache.get(TOUR_BUTTON_ID);
      target?.focus();
    }
    announceStatus(
      how === "takeover" ? "Hotspot tour ended here" : "Hotspot tour ended",
    );
  }

  /** The page as the tour runs or not: its control, the body, the bar */
  private showRunning(running: boolean): void {
    document.body.classList.toggle(TOUR_ACTIVE_CLASS, running);
    document.getElementById("mobile-bar")?.toggleAttribute("inert", running);
    const button = domCache.get(TOUR_BUTTON_ID);
    if (button) {
      setControlIcon(button, running ? "stop" : "trophy");
      applyToggleButtonState(button, running);
    }
  }

  /** Hold the controls, or give them back as they were */
  private hold(held: boolean): void {
    if (!held) {
      for (const [control, disabled] of this.held) control.disabled = disabled;
      this.held.clear();
      return;
    }
    for (const id of HELD_CONTROL_IDS) {
      const control = domCache.get(id);
      if (
        control instanceof HTMLButtonElement ||
        control instanceof HTMLSelectElement
      ) {
        this.held.set(control, control.disabled);
        control.disabled = true;
      }
    }
  }

  /** The panel as the tour stands */
  private sync(): void {
    const panel = this.panel!;
    const stop = this.stops[this.index]!;
    const last = this.index + 1 >= this.stops.length;
    panel.count.textContent = `${this.index + 1} of ${this.stops.length}`;
    panel.name.textContent = stop.name;
    panel.detail.textContent = stop.detail;
    panel.play.hidden = this.stepping;
    setControlIcon(panel.play, this.playing ? "pause" : "play", 20);
    nameButton(panel.play, this.playing ? "Pause the tour" : "Play the tour");
    // Not disabled, which would drop its focus: said, and a press ignored
    panel.previous.setAttribute("aria-disabled", String(this.index === 0));
    nameButton(panel.next, last ? "End the tour" : "Next hotspot");
    // A long name takes a second line on a phone
    document.body.style.setProperty(
      TOUR_PANEL_HEIGHT_VAR,
      panel.root.offsetHeight + "px",
    );
  }

  /** Speak a message through the panel's own live region */
  private announce(message: string): void {
    announceInRegion(this.panel!.live, message);
  }

  /** The panel, built the first time the tour starts */
  private panelOf(): TourPanel {
    if (this.panel) return this.panel;
    const root = document.createElement("div");
    root.id = "hotspot-tour";
    root.setAttribute("role", "region");
    root.setAttribute("aria-label", "Hotspot tour");

    // Read out through the live region below, with the count, in one go
    const caption = document.createElement("div");
    caption.id = "hotspot-tour-caption";
    const line = (part: string): HTMLElement => {
      const element = document.createElement("span");
      element.id = "hotspot-tour-" + part;
      caption.append(element);
      return element;
    };
    const count = line("count");
    const name = line("name");
    const detail = line("detail");

    const previous = tourButton("hotspot-tour-previous-btn", "collapse", () =>
      this.previous(),
    );
    nameButton(previous, "Previous hotspot");
    const play = tourButton("hotspot-tour-play-btn", "pause", () => {
      if (this.playing) this.pause();
      else this.resume();
    });
    const next = tourButton("hotspot-tour-next-btn", "chevronRight", () =>
      this.next(),
    );
    const exit = tourButton("hotspot-tour-stop-btn", "close", () =>
      this.stop(),
    );
    nameButton(exit, "Stop the tour and go back");
    const buttons = document.createElement("div");
    buttons.id = "hotspot-tour-buttons";
    buttons.append(previous, play, next, exit);

    const live = document.createElement("div");
    live.id = "hotspot-tour-live";
    live.className = "visually-hidden";
    live.setAttribute("aria-live", "polite");
    live.setAttribute("aria-atomic", "true");

    root.append(caption, buttons, live);
    document.body.append(root);
    this.panel = { root, count, name, detail, previous, play, next, live };
    return this.panel;
  }
}

/** The tour of each app, made the first time it is started */
const tours = new WeakMap<MapApp, HotspotTour>();

/** Start or stop the hotspot tour of `app` */
export function toggleHotspotTour(app: MapApp): void {
  let tour = tours.get(app);
  if (!tour) {
    tour = new HotspotTour(app);
    tours.set(app, tour);
  }
  tour.toggle();
}
