/**
 * Lazy bundles - what the app says when one cannot be fetched
 *
 * Replay, the relief, the cross-section and the hotspot tour come with the
 * feature bundle, Wrapped and the statistics panel with the Wrapped bundle
 * (services/featureLoader.ts fetches both). MapApp fetches them the first
 * time one of their controls is used (MapApp.loadReplay, loadWrapped,
 * loadStats and toggleFeature); this module holds what those share: the
 * message each part of the app shows when its code could not be loaded,
 * `loadLazyBundle`, which shows it and takes back the one of an earlier
 * failure once a later try has worked, and the fetch of the Wrapped bundle
 * ahead of a click on its button (`prepareWrappedOnIntent`), so its intro
 * is ready to play. It is part of the first visit, like the app: nothing
 * here may reach into the lazy bundles other than through featureLoader.
 */
import type { MapApp } from "../mapApp";
import type { FeatureModule } from "../features";
import {
  loadWrapped,
  noticeSiteUpdate,
  wasSiteUpdated,
} from "../services/featureLoader";
import { TRY_AGAIN } from "../services/lazyImport";
import { logError } from "../utils/logger";
import { prefersReducedMotion } from "../utils/motion";
import { dismissToast, showToast } from "../utils/toast";
import { whenIdle } from "../utils/whenIdle";

/**
 * Said when the feature bundle or the Wrapped bundle cannot be fetched.
 * Without it a click on Replay or Wrapped would do nothing at all and look
 * like a dead control; the export button says the same kind of thing when
 * html-to-image is missing.
 */
export const REPLAY_UNAVAILABLE_MESSAGE =
  "Replay is unavailable: its code could not be loaded" + TRY_AGAIN;
export const TOUR_UNAVAILABLE_MESSAGE =
  "The hotspot tour is unavailable: its code could not be loaded" + TRY_AGAIN;
export const WRAPPED_UNAVAILABLE_MESSAGE =
  "Wrapped is unavailable: its code could not be loaded" + TRY_AGAIN;
export const STATS_UNAVAILABLE_MESSAGE =
  "Statistics are unavailable: their code could not be loaded" + TRY_AGAIN;
export const CROSS_SECTION_UNAVAILABLE_MESSAGE =
  "The cross-section is unavailable: its code could not be loaded" + TRY_AGAIN;

/** What a control starts in the feature bundle once it has arrived */
export type FeatureToggle = keyof Pick<
  FeatureModule,
  | "toggleReplayAll"
  | "toggleSequence"
  | "toggleHotspotTour"
  | "toggleCrossSection"
>;

/** The messages of the one file that carries Wrapped and the statistics */
export const WRAPPED_BUNDLE_MESSAGES = [
  WRAPPED_UNAVAILABLE_MESSAGE,
  STATS_UNAVAILABLE_MESSAGE,
] as const;

/**
 * A lazy bundle, or null when it could not be fetched. A failure is
 * reported here rather than at each call site, so every way into Replay,
 * Wrapped or the statistics says the same thing instead of doing nothing.
 * `messages` are those of every part of the app the file carries, which
 * stand or fall with it: one toast says it failed, the one of the part
 * that asked last.
 */
export async function loadLazyBundle<T>(
  load: () => Promise<T | null>,
  unavailable: string,
  messages: readonly string[] = [unavailable],
): Promise<T | null> {
  const bundle = await load();
  // The failure of an earlier try stays until dismissed, and would say
  // the code is unavailable over the panel it has just opened
  for (const message of messages) {
    if (bundle || message !== unavailable) dismissToast(message);
  }
  // A bundle of a newer deploy has said so (services/featureLoader.ts).
  // Any other failure after it is most likely the deploy's as well: the
  // reload it offers, said again rather than nothing, puts both right.
  if (!bundle) {
    if (wasSiteUpdated()) noticeSiteUpdate();
    else showToast(unavailable, "error");
  }
  return bundle;
}

/**
 * Get Wrapped and its intro ready while its button is pointed at or
 * focused, on either layout (see prepareWrappedIntro), once the page has
 * a moment (whenIdle) rather than in the task of the pointer's move. Not
 * under reduced motion, where no intro plays: Wrapped's code comes with
 * the click, as it always has.
 */
export function prepareWrappedOnIntent(app: MapApp): void {
  const prepare = (event: Event): void => {
    const id = (event.target as Partial<Element>).id;
    if (
      (id === "wrapped-btn" || id === "mobile-tab-wrapped") &&
      !prefersReducedMotion()
    ) {
      whenIdle(() => {
        if (app.signal.aborted) return;
        loadWrapped()
          .then((wrapped) => wrapped?.prepareWrappedIntro(app))
          .catch(logError);
      });
    }
  };
  // Neither event bubbles; both reach a listener that captures
  for (const type of ["pointerenter", "focus"]) {
    document.addEventListener(type, prepare, {
      capture: true,
      signal: app.signal,
    });
  }
}
