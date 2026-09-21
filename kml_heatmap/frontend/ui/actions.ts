/**
 * Declarative event binding: every `[data-action]` element in the document
 * is wired to the app method of the same name. Buttons get "click", selects
 * get "change", inputs get "input".
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
]);

type ActionHandler = (e: Event) => void;

function actionHandlers(app: MapApp): Record<string, ActionHandler> {
  return {
    toggleHeatmap: () => app.uiToggles.toggleHeatmap(),
    toggleStats: () => app.statsManager.toggleStats(),
    toggleAltitude: () => app.uiToggles.toggleAltitude(),
    toggleAirspeed: () => app.uiToggles.toggleAirspeed(),
    toggleAirports: () => app.uiToggles.toggleAirports(),
    toggleAviation: () => app.uiToggles.toggleAviation(),
    toggleGlobe: () => app.mapOrientation.toggleGlobe(),
    resetNorth: () => app.mapOrientation.resetNorth(),
    // Replay and Wrapped live in the lazily loaded feature bundle. Only
    // these two can be the first thing a visitor touches; the rest are on
    // chrome that exists only once the feature is open, so they find the
    // manager already there.
    toggleReplay: () => app.toggleReplay(),
    filterByYear: () => {
      app.filterManager.filterByYear().catch(logError);
    },
    filterByAircraft: () => {
      app.filterManager.filterByAircraft().catch(logError);
    },
    exportMap: () => app.uiToggles.exportMap(),
    shareLink: () => {
      void app.uiToggles.shareLink();
    },
    showWrapped: () => {
      void app.loadWrapped().then((manager) => manager?.showWrapped());
    },
    closeWrapped: () => app.wrappedManager?.closeWrapped(),
    toggleIsolateSelection: () => app.pathSelection.toggleIsolateSelection(),
    playReplay: () => app.replayManager?.playReplay(),
    pauseReplay: () => app.replayManager?.pauseReplay(),
    stopReplay: () => app.replayManager?.stopReplay(),
    seekReplay: (e) =>
      app.replayManager?.seekReplay((e.target as HTMLInputElement).value),
    changeReplaySpeed: () => app.replayManager?.changeReplaySpeed(),
    toggleAutoZoom: () => app.replayManager?.toggleAutoZoom(),
  };
}

/**
 * Bind data-action attributes to app methods via addEventListener.
 * Handlers are bound before initialization completes; data-dependent
 * actions are ignored while `app.isInitializing` is true.
 */
export function bindActions(app: MapApp): void {
  const actions = actionHandlers(app);

  document.querySelectorAll<HTMLElement>("[data-action]").forEach((el) => {
    const action = el.dataset["action"];
    if (!action) return;
    const fn = actions[action];
    if (!fn) return;

    const handler = (e: Event): void => {
      if (app.isInitializing && DEFERRED_WHILE_INITIALIZING.has(action)) {
        return;
      }
      fn(e);
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
