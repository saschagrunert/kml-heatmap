/**
 * Fetch the lazily loaded feature bundle and the stylesheet that goes with it.
 *
 * Replay and Wrapped are a quarter of the frontend and most visits open
 * neither, so they are built into features.bundle.js and loaded the first
 * time one of them is used. The same pattern as loadDomToImage() in
 * ui/uiToggles.ts: a script tag, one shared promise, and a failure that
 * resolves rather than throws so the caller can say something useful.
 *
 * Their styles ride along in features.css for the same reason (see the header
 * of static/styles.css). Both have to arrive before a panel is shown, so they
 * are fetched together and a failure of either is a failure of the load: a
 * Wrapped panel without its stylesheet is worse than the toast.
 */
import { loadScript, loadStylesheet } from "./dataLoader";
import { logError } from "../utils/logger";
import type { FeatureModule } from "../features";

/** Next to the page, like every other file the site ships */
export const FEATURES_URL = "./features.bundle.js";
export const FEATURES_CSS_URL = "./features.css";

/** A feature bundle is a fraction of a year file, so it gets less time */
const FEATURES_LOAD_TIMEOUT_MS = 30_000;

let pending: Promise<FeatureModule | null> | null = null;
/** Set once the bundle and its stylesheet have both arrived */
let loaded = false;

/**
 * The feature bundle's exports, or null when it could not be loaded.
 * Concurrent callers share one request; a failure is not cached, so the next
 * attempt tries again.
 */
export function loadFeatures(): Promise<FeatureModule | null> {
  // Not `window.KMLFeatures` on its own: the script can have run while the
  // stylesheet failed, and that attempt must not count as loaded
  if (loaded && window.KMLFeatures) return Promise.resolve(window.KMLFeatures);
  if (pending) return pending;

  pending = Promise.all([
    loadScript(FEATURES_URL, FEATURES_LOAD_TIMEOUT_MS),
    loadStylesheet(FEATURES_CSS_URL, FEATURES_LOAD_TIMEOUT_MS),
  ])
    .then(() => {
      loaded = window.KMLFeatures !== undefined;
      return window.KMLFeatures ?? null;
    })
    .catch((error: unknown) => {
      logError("Could not load the feature bundle:", error);
      return null;
    })
    .finally(() => {
      pending = null;
    });
  return pending;
}

/** Forget the cached request (used by tests) */
export function resetFeatureLoader(): void {
  pending = null;
  loaded = false;
}
