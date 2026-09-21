/**
 * Fetch the lazily loaded feature bundle and the stylesheet that goes with it.
 *
 * Replay and Wrapped are a quarter of the frontend and most visits open
 * neither, so features.ts is an entry point of its own (features.bundle.js)
 * that is imported the first time one of them is used. One shared promise,
 * and a failure that resolves rather than throws so the caller can say
 * something useful.
 *
 * Their styles ride along in features.css for the same reason (see the header
 * of static/styles.css). Both have to arrive before a panel is shown, so they
 * are fetched together and a failure of either is a failure of the load: a
 * Wrapped panel without its stylesheet is worse than the toast.
 */
import { loadStylesheet } from "./dataLoader";
import { logError } from "../utils/logger";
import { withTimeout } from "../utils/withTimeout";
import type { FeatureModule } from "../features";

/** Next to the page, like every other file the site ships */
export const FEATURES_CSS_URL = "./features.css";

/** A feature bundle is a fraction of a year file, so it gets less time */
const FEATURES_LOAD_TIMEOUT_MS = 30_000;

/** What build.js names the bundle of ../features, next to this one */
const FEATURES_BUNDLE = "./features.bundle.js";

/**
 * The import itself, replaceable by tests. The build resolves the specifier
 * to features.bundle.js, which shares its modules with the app through
 * shared.bundle.js rather than carrying copies of them.
 *
 * A browser may remember a failed import for as long as the page is open
 * and answer every later import() of that URL with the same failure,
 * without asking the server again. A retry therefore names the file itself
 * under a URL the page has not tried yet. The bundler leaves a computed
 * specifier alone, and shared.bundle.js is still imported under its one
 * URL, so the retried bundle shares the app's modules like the first would.
 */
let importFeatures = (failedImports: number): Promise<FeatureModule> =>
  failedImports === 0
    ? import("../features")
    : (import(
        new URL(`${FEATURES_BUNDLE}?retry=${failedImports}`, import.meta.url)
          .href
      ) as Promise<FeatureModule>);

let pending: Promise<FeatureModule | null> | null = null;
/** Set once the bundle and its stylesheet have both arrived */
let loaded: FeatureModule | null = null;
/**
 * Imports that were rejected. One that merely timed out is not counted: it
 * may still finish, and asking for the same URL again then gets the module.
 */
let failedImports = 0;

/**
 * The feature bundle's exports, or null when it could not be loaded.
 * Concurrent callers share one request. A failure is not cached, here or (see
 * importFeatures) by the browser, so the next attempt asks the server again.
 */
export function loadFeatures(): Promise<FeatureModule | null> {
  if (loaded) return Promise.resolve(loaded);
  if (pending) return pending;

  const bundle = importFeatures(failedImports);
  bundle.catch(() => failedImports++);
  pending = Promise.all([
    // An import cannot be aborted, so a stalled one is only given up on:
    // the caller gets its answer and the next attempt starts over
    withTimeout(
      bundle,
      FEATURES_LOAD_TIMEOUT_MS,
      "Timed out loading the feature bundle",
    ),
    loadStylesheet(FEATURES_CSS_URL, FEATURES_LOAD_TIMEOUT_MS),
  ])
    .then(([features]) => {
      loaded = features;
      return features;
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

/** Forget the cached request and replace the import (used by tests) */
export function resetFeatureLoader(
  importer: (failedImports: number) => Promise<FeatureModule>,
): void {
  pending = null;
  loaded = null;
  failedImports = 0;
  importFeatures = importer;
}
