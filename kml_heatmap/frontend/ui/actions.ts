/**
 * Declarative event binding: every `[data-action]` element in the document
 * is wired to the app method of the same name. Buttons get "click", selects
 * get "change", inputs get "input". The mobile bar and its sheets run the
 * same actions through `runAction`, so both ways in obey the same rules.
 */
import type { MapApp } from "../mapApp";
import { logError } from "../utils/logger";

/**
 * Actions that need loaded data. They are ignored while the app is still
 * initializing; pending filter changes are applied afterwards.
 */
export const DEFERRED_WHILE_INITIALIZING: ReadonlySet<string> = new Set([
  "filterByYear",
  "filterByAircraft",
  "toggleReplay",
  "playReplay",
  "pauseReplay",
  "stopReplay",
  "seekReplay",
  "changeReplaySpeed",
  "toggleAutoZoom",
  "showWrapped",
  "exportMap",
  "toggleIsolateSelection",
  "resetView",
]);

type ActionHandler = (e?: Event) => void;

function actionHandlers(app: MapApp): Record<string, ActionHandler> {
  return {
    toggleHeatmap: () => app.uiToggles.toggleHeatmap(),
    toggleStats: () => app.statsManager.toggleStats(),
    toggleAltitude: () => app.uiToggles.toggleAltitude(),
    toggleAirspeed: () => app.uiToggles.toggleAirspeed(),
    toggleAirports: () => app.uiToggles.toggleAirports(),
    toggleAviation: () => app.uiToggles.toggleAviation(),
    toggleGlobe: () => app.mapOrientation.toggleGlobe(),
    toggleThreeD: () => app.mapOrientation.toggleThreeD(),
    toggleSatellite: () => app.uiToggles.toggleSatellite(),
    resetNorth: () => app.mapOrientation.resetNorth(),
    resetView: () => {
      app.resetView().catch(logError);
    },
    // Replay and Wrapped live in lazily loaded bundles. Only
    // these two can be the first thing a visitor touches; the rest are on
    // chrome that exists only once the feature is open, so they find the
    // manager already there.
    toggleReplay: () => app.toggleReplay(),
    filterByYear: () => {
      app.filterManager.filterByYear().catch(logError);
    },
    filterByAircraft: () => app.filterManager.filterByAircraft(),
    exportMap: () => app.uiToggles.exportMap(),
    shareLink: () => {
      void app.uiToggles.shareLink();
    },
    showWrapped: () => {
      void app
        .loadWrapped()
        .then((manager) => manager?.showWrapped())
        .catch(logError);
    },
    closeWrapped: () => app.wrappedManager?.closeWrapped(),
    toggleIsolateSelection: () => app.pathSelection.toggleIsolateSelection(),
    playReplay: () => app.replayManager?.playReplay(),
    pauseReplay: () => app.replayManager?.pauseReplay(),
    stopReplay: () => app.replayManager?.stopReplay(),
    seekReplay: (e) =>
      app.replayManager?.seekReplay((e?.target as HTMLInputElement).value),
    changeReplaySpeed: () => app.replayManager?.changeReplaySpeed(),
    toggleAutoZoom: () => app.replayManager?.toggleAutoZoom(),
  };
}

/**
 * Run an action by name, the way a click on its control does. Data-dependent
 * actions are ignored while `app.isInitializing` is true: the phone's bar
 * called the app directly and skipped this, and a Reset view during the
 * first load switched the year under the load that was still running.
 * Returns whether the action ran.
 */
export function runAction(app: MapApp, action: string, e?: Event): boolean {
  // Built for the one call: a click is rare enough, and nothing has to
  // keep the handlers of an app that is gone
  const fn = actionHandlers(app)[action];
  if (!fn) return false;
  if (app.isInitializing && DEFERRED_WHILE_INITIALIZING.has(action)) {
    return false;
  }
  fn(e);
  return true;
}

/**
 * Bind data-action attributes to app methods via addEventListener.
 * Handlers are bound before initialization completes; see runAction for
 * the ones that wait for it.
 */
export function bindActions(app: MapApp): void {
  document.querySelectorAll<HTMLElement>("[data-action]").forEach((el) => {
    const action = el.dataset["action"];
    if (!action) return;
    const handler = (e: Event): void => {
      runAction(app, action, e);
    };
    const type =
      el.tagName === "SELECT"
        ? "change"
        : el.tagName === "INPUT"
          ? "input"
          : "click";
    el.addEventListener(type, handler, { signal: app.signal });
  });
}
