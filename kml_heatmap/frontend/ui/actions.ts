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
    toggleReplay: () => app.replayManager.toggleReplay(),
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
    showWrapped: () => app.wrappedManager.showWrapped(),
    closeWrapped: () => app.wrappedManager.closeWrapped(),
    closeWrappedBackdrop: (e) =>
      app.wrappedManager.closeWrapped(e as MouseEvent),
    toggleIsolateSelection: () => app.pathSelection.toggleIsolateSelection(),
    playReplay: () => app.replayManager.playReplay(),
    pauseReplay: () => app.replayManager.pauseReplay(),
    stopReplay: () => app.replayManager.stopReplay(),
    seekReplay: (e) =>
      app.replayManager.seekReplay((e.target as HTMLInputElement).value),
    changeReplaySpeed: () => app.replayManager.changeReplaySpeed(),
    toggleAutoZoom: () => app.replayManager.toggleAutoZoom(),
    stopPropagation: (e) => e.stopPropagation(),
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
    if (el.tagName === "SELECT") {
      el.addEventListener("change", handler);
    } else if (el.tagName === "INPUT") {
      el.addEventListener("input", handler);
    } else {
      el.addEventListener("click", handler);
    }
  });
}
