/**
 * Fetch the lazily loaded bundles and the stylesheets that go with them.
 *
 * Replay and Wrapped are a quarter of the frontend and most visits open
 * neither, so each is an entry point of its own that is imported the first
 * time it is used: features.ts (features.bundle.js) for replay, the flight
 * list of the airport popups and the relief of the 3D view, wrapped.ts
 * (wrapped.bundle.js) for Wrapped. They are apart because opening one says
 * nothing about the other. Each gets one shared promise, and a failure that
 * resolves rather than throws so the caller can say something useful.
 *
 * Their styles ride along in features.css and wrapped.css for the same
 * reason (see the header of static/styles.css). A bundle and its stylesheet
 * have to arrive before a panel is shown, so they are fetched together and a
 * failure of either is a failure of the load: a Wrapped panel without its
 * stylesheet is worse than the toast.
 */
import { loadStylesheet } from "./dataLoader";
import { logError } from "../utils/logger";
import { withTimeout } from "../utils/withTimeout";
import type { FeatureModule } from "../features";
import type { WrappedModule } from "../wrapped";

/** Next to the page, like every other file the site ships */
export const FEATURES_CSS_URL = "./features.css";
export const WRAPPED_CSS_URL = "./wrapped.css";

/** A lazy bundle is a fraction of a year file, so it gets less time */
const LAZY_LOAD_TIMEOUT_MS = 30_000;

/** How a bundle is imported; the argument counts the imports that failed */
type Importer<T> = (failedImports: number) => Promise<T>;

/**
 * The import itself, for an importer. The build resolves the literal
 * specifier of the first attempt to the bundle, which shares its modules
 * with the app through shared.bundle.js rather than carrying copies of them.
 *
 * A browser may remember a failed import for as long as the page is open
 * and answer every later import() of that URL with the same failure,
 * without asking the server again. A retry therefore names the file itself
 * under a URL the page has not tried yet. The bundler leaves a computed
 * specifier alone, and shared.bundle.js is still imported under its one
 * URL, so the retried bundle shares the app's modules like the first would.
 */
function retryImport<T>(bundle: string, failedImports: number): Promise<T> {
  return import(
    new URL(`./${bundle}?retry=${failedImports}`, import.meta.url).href
  ) as Promise<T>;
}

const importFeatures: Importer<FeatureModule> = (failedImports) =>
  failedImports === 0
    ? import("../features")
    : retryImport("features.bundle.js", failedImports);

const importWrapped: Importer<WrappedModule> = (failedImports) =>
  failedImports === 0
    ? import("../wrapped")
    : retryImport("wrapped.bundle.js", failedImports);

/** One lazy bundle: its loader and what tests use to start it over */
interface LazyBundle<T> {
  load(): Promise<T | null>;
  reset(importer: Importer<T>): void;
}

/**
 * A loader for one bundle and its stylesheet. Concurrent callers share one
 * request. A failure is not cached, here or (see retryImport) by the
 * browser, so the next attempt asks the server again.
 */
function lazyBundle<T>(
  name: string,
  cssUrl: string,
  importer: Importer<T>,
): LazyBundle<T> {
  let importBundle = importer;
  let pending: Promise<T | null> | null = null;
  /** Set once the bundle and its stylesheet have both arrived */
  let loaded: T | null = null;
  /**
   * Imports that were rejected. One that merely timed out is not counted:
   * it may still finish, and asking for the same URL again then gets the
   * module.
   */
  let failedImports = 0;

  return {
    load() {
      if (loaded) return Promise.resolve(loaded);
      if (pending) return pending;

      const bundle = importBundle(failedImports);
      bundle.catch(() => failedImports++);
      pending = Promise.all([
        // An import cannot be aborted, so a stalled one is only given up
        // on: the caller gets its answer and the next attempt starts over
        withTimeout(
          bundle,
          LAZY_LOAD_TIMEOUT_MS,
          `Timed out loading the ${name} bundle`,
        ),
        loadStylesheet(cssUrl, LAZY_LOAD_TIMEOUT_MS),
      ])
        .then(([module]) => {
          loaded = module;
          return module;
        })
        .catch((error: unknown) => {
          logError(`Could not load the ${name} bundle:`, error);
          return null;
        })
        .finally(() => {
          pending = null;
        });
      return pending;
    },
    reset(next) {
      pending = null;
      loaded = null;
      failedImports = 0;
      importBundle = next;
    },
  };
}

const features = lazyBundle("feature", FEATURES_CSS_URL, importFeatures);
const wrapped = lazyBundle("Wrapped", WRAPPED_CSS_URL, importWrapped);

/** The feature bundle's exports, or null when it could not be loaded */
export function loadFeatures(): Promise<FeatureModule | null> {
  return features.load();
}

/** The Wrapped bundle's exports, or null when it could not be loaded */
export function loadWrapped(): Promise<WrappedModule | null> {
  return wrapped.load();
}

/** Forget the cached request and replace the import (used by tests) */
export function resetFeatureLoader(importer: Importer<FeatureModule>): void {
  features.reset(importer);
}

/** Forget the cached request and replace the import (used by tests) */
export function resetWrappedLoader(importer: Importer<WrappedModule>): void {
  wrapped.reset(importer);
}
