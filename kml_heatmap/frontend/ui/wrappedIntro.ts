/**
 * Wrapped's intro - the camera flies in over the year before the cards
 *
 * Opened from its button, Wrapped starts on the globe, far out and dark.
 * The heat cloud fades in as the camera flies to the home base, tilting on
 * the way down and turning slowly once there, while every flight of the
 * overview plays underneath at a few hundred times its speed, so the year
 * blooms out of home (ReplayAllPlayer, ui/replayAll.ts); then it settles
 * on the overview Wrapped has always shown, the flights stop, and the
 * cards come in one after another. About six seconds. Skip, or a touch of the map, ends it at once
 * with Wrapped as it opens without it: not under reduced motion, nor when
 * the heat cloud's code does not arrive in time (INTRO_WAIT_MS).
 *
 * The cloud is drawn without switching the 3D view on (forcedHeatCloud),
 * over the globe; both stay while Wrapped is open after the intro and go
 * back as it closes (WrappedManager.closeWrapped). Neither reaches the link
 * or the saved state, which keep the user's switches while Wrapped holds
 * the user's view (StateManager.saveMapState).
 *
 * The flight and the turn carry REPLAY_CAMERA_MOVE, so what the app does
 * as the map comes to rest waits for the settle, which does not: the
 * ribbons of the 3D view, the relief level of the cloud, the saved view.
 */
import type {
  FitBoundsOptions,
  LngLatBoundsLike,
  Map as MapLibreMap,
} from "maplibre-gl";
import type { MapApp } from "../mapApp";
import type { FeatureModule } from "../features";
import type { ReplayAllPlayer } from "./replayAll";
import { datasetIndex } from "../calculations/datasetIndex";
import { reliefLevel } from "../calculations/lift";
import { loadFeatures } from "../services/featureLoader";
import { domCache } from "../utils/domCache";
import { logError } from "../utils/logger";
import { segmentBounds, type Coordinate } from "../utils/geometry";
import { REPLAY_CAMERA_MOVE, toBounds, toLngLat } from "../utils/mapHelpers";
import { prefersReducedMotion } from "../utils/motion";

/** Padding in pixels around the data when the dialog fits the map to it */
export const FIT_PADDING = 80;

/**
 * Where the intro opens: the globe whole in the panel, turned so the home
 * base comes up from the south west as the camera flies in
 */
const FAR = { zoom: 1.2, west: 50, south: 15 };

/** How the camera comes down over the home base */
const HOME = { zoom: 9, pitch: 60, bearing: -20 };

/** How far the camera turns once over the home base, in degrees */
const TURN_DEG = 15;

/** The steps of the intro, in milliseconds */
export const INTRO_FLY_MS = 3000;
export const INTRO_TURN_MS = 1400;
export const INTRO_SETTLE_MS = 1500;

/**
 * Longest the intro waits for the heat cloud's code once the map is in the
 * dialog. It is fetched as the Wrapped button is pointed at or focused
 * (prepareWrappedIntro), so this is for a click that came first on a slow
 * line: rather than hold the dialog, Wrapped opens without its intro.
 */
export const INTRO_WAIT_MS = 1000;

/**
 * How long the pointer rests on a destination before the map flies there,
 * or off the list before it flies back: a pointer on its way through the
 * list does not send the map along every row it crosses
 */
const DESTINATION_HOVER_MS = 250;

/** The map zoom a destination is shown at */
const DESTINATION_ZOOM = 10;

/** How much faster than real time replay-all plays under the intro */
const INTRO_REPLAY_SPEED = 300;

/**
 * The player of each app's intro, made the first time the intro plays and
 * kept for the next: each listens to its map for as long as the map lives
 */
const introPlayers = new WeakMap<MapApp, ReplayAllPlayer>();

/**
 * Step 3 of the storyboard: the flights of the overview start to play from
 * their first second, all at once, at INTRO_REPLAY_SPEED times real speed,
 * as the camera sets off for the home base, so they bloom out of it
 * underneath; the intro stops them as the cards come in, is skipped or is
 * closed. The player changes nothing of the app: no replay of the map
 * (replayActive), no filter, no link. Returns what stops it, or null when
 * nothing plays: a replay of the map runs already (Wrapped does not open
 * then, and the two would share the map), motion is unwelcome, or no
 * flight of the overview has a clock to play by.
 */
function startIntroReplay(
  app: MapApp,
  features: FeatureModule,
): ReplayAllPlayer | null {
  const data = app.currentData;
  if (!data || app.replayActive || prefersReducedMotion()) return null;
  let player = introPlayers.get(app);
  if (!player) {
    player = new features.ReplayAllPlayer(app);
    introPlayers.set(app, player);
  }
  const { pathIds } = datasetIndex(data).filter(
    app.selectedYear,
    app.selectedAircraft,
  );
  // Cut ahead for the view over home the camera flies to, as well as for
  // the far one it sets off from (see ReplayAllRun.zoom). Settles as the
  // last flight lands or the intro stops it: nothing waits.
  void player.start({ pathIds, speed: INTRO_REPLAY_SPEED, zoom: HOME.zoom });
  return player.active ? player : null;
}

/**
 * What the dialog fits the map to: the flights it describes. The exported
 * bounds cover the whole dataset, so a single year or aircraft used to be
 * shown as a speck in the middle of every flight ever made.
 */
export function overviewBounds(app: MapApp): LngLatBoundsLike {
  const { selectedYear, selectedAircraft, currentData } = app;
  if ((selectedYear === "all" && selectedAircraft === "all") || !currentData) {
    return toBounds(app.config.bounds);
  }
  const view = datasetIndex(currentData).filter(selectedYear, selectedAircraft);
  return toBounds(segmentBounds(view.segments()) ?? app.config.bounds);
}

/**
 * Get the intro ready ahead of the click: the heat cloud's code, and its
 * points for the overview. They took 50 to 90 ms per level of relief for
 * two years of flights, which the first frames of the intro would stall
 * on. The overview fits the dialog's map panel, narrower than the page's
 * map, so its level is the page's or one less.
 */
export function prepareWrappedIntro(app: MapApp): void {
  const map = app.map;
  if (
    !map ||
    !app.currentData ||
    app.wrappedVisible ||
    app.replayActive ||
    prefersReducedMotion()
  ) {
    return;
  }
  loadFeatures()
    .then((features) => {
      if (!features || app.signal.aborted) return;
      features.followHeatCloud(app);
      const camera = map.cameraForBounds(overviewBounds(app), {
        padding: FIT_PADDING,
      });
      if (!camera?.zoom) return;
      const level = reliefLevel(camera.zoom);
      features.prepareHeatCloud(app, [level]);
      // The other one in a task of its own, as the pointer may be on its way
      setTimeout(() => {
        if (!app.wrappedVisible) {
          features.prepareHeatCloud(app, [Math.max(level - 1, 0), level]);
        }
      }, 0);
    })
    .catch(logError);
}

/** Where the camera comes to rest after the intro, and how it gets there */
export interface IntroOverview {
  bounds: LngLatBoundsLike;
  options: FitBoundsOptions;
}

/**
 * One playing of the intro, made as the dialog opens. `begin` sets the
 * scene once the map is in the dialog and measured, and says whether the
 * intro plays; `fly` starts the camera once the far view is drawn. `skip`
 * ends it with Wrapped as it opens without it, `stop` where it is, for a
 * close.
 */
export interface WrappedIntro {
  begin(): Promise<boolean>;
  fly(): void;
  skip(): void;
  stop(): void;
}

/**
 * The dialog while the intro plays: the cards held back and the map dark
 * (wrapped.css), and the Skip button
 */
function showIntroChrome(on: boolean): void {
  const modal = domCache.get("wrapped-modal");
  modal?.classList.toggle("is-intro", on);
  domCache.get("wrapped-map-container")?.classList.toggle("is-dark", on);
  const skip = domCache.get("wrapped-skip-btn");
  if (!skip) return;
  // A button that hides drops its focus to <body>
  if (!on && document.activeElement === skip) {
    modal?.querySelector<HTMLElement>(".close-btn")?.focus();
  }
  skip.hidden = !on;
}

/**
 * Start the intro for a dialog that has just opened: `home` is where the
 * camera flies, `overview` where it comes to rest, and `onEnd` is told
 * once, however it ends.
 */
export function startWrappedIntro(
  app: MapApp,
  home: Coordinate,
  overview: IntroOverview,
  onEnd: () => void,
): WrappedIntro {
  let playing = true;
  /** The feature bundle, once `begin` has it */
  let features: FeatureModule | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let replay: ReplayAllPlayer | null = null;
  /** Takes the listeners for a touch of the map off again */
  const listening = new AbortController();
  /** The globe switch as the intro found it, for a skip to put back */
  const globeBefore = app.globeVisible;
  const loading = loadFeatures()
    .then((module) => {
      module?.followHeatCloud(app);
      return module;
    })
    // Wrapped opens without its intro, as it does when the code is late
    .catch((error: unknown) => {
      logError(error);
      return null;
    });

  const fit = (options: FitBoundsOptions): void => {
    app.map?.fitBounds(overview.bounds, { ...overview.options, ...options });
  };
  const after = (ms: number, step: () => void): void => {
    timer = setTimeout(() => {
      if (playing) step();
    }, ms);
  };
  const end = (): void => {
    playing = false;
    clearTimeout(timer);
    listening.abort();
    replay?.stop();
    replay = null;
    showIntroChrome(false);
    onEnd();
  };
  const skip = (): void => {
    if (!playing) return;
    app.store.batch(() => {
      app.globeVisible = globeBefore;
      app.forcedHeatCloud = false;
    });
    end();
    const map = app.map;
    map?.stop();
    // Stacked, the map had the dialog to itself and is a square card below
    // the others again: the overview is fitted to that
    map?.resize();
    fit({ animate: false });
  };

  showIntroChrome(true);
  return {
    async begin() {
      let waited: ReturnType<typeof setTimeout> | undefined;
      const found = await Promise.race([
        loading,
        new Promise<null>((resolve) => {
          waited = setTimeout(() => resolve(null), INTRO_WAIT_MS);
        }),
      ]);
      clearTimeout(waited);
      const map = app.map;
      if (!playing || !map) return false;
      if (!found) {
        skip();
        return false;
      }
      features = found;
      // The overview first, untagged: the cloud is cut for the zoom the
      // map comes to rest at (ui/heatCloud.ts)
      fit({ animate: false });
      app.store.batch(() => {
        app.globeVisible = true;
        app.forcedHeatCloud = true;
      });
      const [lat, lng] = home;
      map.jumpTo(
        {
          center: toLngLat([Math.max(lat - FAR.south, -60), lng - FAR.west]),
          zoom: FAR.zoom,
          bearing: 0,
          pitch: 0,
        },
        REPLAY_CAMERA_MOVE,
      );
      // The user takes over: a press, a wheel or a key on the map. The map
      // stops the camera for them, and the intro makes way.
      for (const type of ["pointerdown", "wheel", "keydown"]) {
        map.getContainer().addEventListener(type, skip, {
          passive: true,
          signal: listening.signal,
        });
      }
      return true;
    },

    fly() {
      const map = app.map;
      if (!playing || !features || timer !== undefined || !map) return;
      // The dark fades away over the flight (wrapped.css)
      domCache.get("wrapped-map-container")?.classList.remove("is-dark");
      // The flights first: their curves are cut as they start, which the
      // camera would otherwise lose its first frames to
      replay = startIntroReplay(app, features);
      map.flyTo(
        {
          center: toLngLat(home),
          zoom: HOME.zoom,
          pitch: HOME.pitch,
          bearing: HOME.bearing,
          duration: INTRO_FLY_MS,
        },
        REPLAY_CAMERA_MOVE,
      );
      after(INTRO_FLY_MS, () => {
        map.easeTo(
          {
            bearing: HOME.bearing + TURN_DEG,
            duration: INTRO_TURN_MS,
            easing: (t) => t,
          },
          REPLAY_CAMERA_MOVE,
        );
        // Then to rest on the overview, as the cards come in. Not tagged:
        // the app follows where the map comes to rest from here on.
        after(INTRO_TURN_MS, () => {
          end();
          // Stacked, the map had the dialog to itself and is a square card
          // below the others again: the overview is fitted to that
          map.resize();
          fit({ duration: INTRO_SETTLE_MS });
        });
      });
    },

    skip,

    stop() {
      if (!playing) return;
      end();
      app.map?.stop();
    },
  };
}

/**
 * Fly the map to the destination the pointer comes to rest on, and back
 * to the overview once it has left the list: hovering "Furthest" shows
 * where that is. `airportAt` finds the airport of a row, `overview` says
 * where to fly back to, or null while the map is not free to move (the
 * intro plays, the dialog is closed). Not for a finger, whose tap passes
 * over a row and leaves it at once, nor under reduced motion. A view the
 * user moved to is theirs: the map only flies back from a destination, and
 * a press or a wheel on the map drops a flight still waiting. Returns what
 * drops such a flight.
 */
export function followDestinationHover(
  app: MapApp,
  grid: HTMLElement,
  airportAt: (row: Element) => Coordinate | undefined,
  overview: () => IntroOverview | null,
  signal: AbortSignal,
): () => void {
  let hovered: Element | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Whether the map is at a destination it flew to, not the user's view */
  let away = false;
  const cancel = (): void => {
    clearTimeout(timer);
    hovered = null;
  };
  const later = (fly: (map: MapLibreMap, to: IntroOverview) => void): void => {
    clearTimeout(timer);
    if (!overview() || prefersReducedMotion()) return;
    timer = setTimeout(() => {
      const to = overview();
      if (app.map && to) fly(app.map, to);
    }, DESTINATION_HOVER_MS);
  };
  // The user takes the map over
  const container = app.map?.getContainer();
  for (const type of ["pointerdown", "wheel"]) {
    container?.addEventListener(
      type,
      () => {
        cancel();
        away = false;
      },
      { passive: true, signal },
    );
  }
  grid.addEventListener(
    "pointerover",
    (event) => {
      const row = (event.target as Element).closest(".destination");
      if (!row || row === hovered || event.pointerType === "touch") return;
      hovered = row;
      const at = airportAt(row);
      if (at) {
        later((map) => {
          away = true;
          map.flyTo({ center: toLngLat(at), zoom: DESTINATION_ZOOM });
        });
      }
    },
    { signal },
  );
  grid.addEventListener(
    "pointerleave",
    (event) => {
      hovered = null;
      if (event.pointerType === "touch") return;
      if (!away) {
        // Nothing flown yet: nothing to fly back from
        clearTimeout(timer);
        return;
      }
      later((map, to) => {
        away = false;
        map.fitBounds(to.bounds, to.options);
      });
    },
    { signal },
  );
  return () => {
    cancel();
    away = false;
  };
}
