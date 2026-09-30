/**
 * Fetch the lazily loaded bundles and the stylesheets that go with them.
 *
 * Replay and Wrapped are a quarter of the frontend and most visits open
 * neither, so each is an entry point of its own that is imported the first
 * time it is used: features.ts (features.bundle.js) for replay, the relief,
 * the heat cloud and the selection ribbons of the 3D view, the satellite
 * imagery, the profile of a single selected flight, the cross-section and
 * the hotspot tour, wrapped.ts (wrapped.bundle.js) for Wrapped and the
 * statistics panel. They are apart because opening one says nothing about
 * the other. Each gets one shared promise, and a failure that resolves
 * rather than throws so the caller can say something useful.
 *
 * Their styles ride along in features.css and wrapped.css for the same
 * reason (see the header of static/styles.css). A bundle and its stylesheet
 * have to arrive before a panel is shown, so they are fetched together and a
 * failure of either is a failure of the load: a Wrapped panel without its
 * stylesheet is worse than the toast.
 *
 * A page opened before a deploy and a bundle first wanted after it do not
 * go together: the host serves the new bundle, which imports the old
 * shared.bundle.js the page already holds (see versioned in
 * services/lazyImport.ts). Each bundle exports the build it belongs to
 * (BUILD), and one of another build is not used: the page says the site
 * was updated and offers to reload, and the callers see the bundle as
 * unavailable, without the toast that says its code could not be loaded.
 * When the two builds' exports no longer match, the import itself fails
 * instead, and that is an ordinary failure.
 */
import { importWithRetry, versioned } from "./lazyImport";
import { loadStylesheet } from "./stylesheet";
import { logError } from "../utils/logger";
import { showToast } from "../utils/toast";
import { withTimeout } from "../utils/withTimeout";
import type { FeatureModule } from "../features";
import type { WrappedModule } from "../wrapped";

/** Next to the page, like every other file the site ships */
export const FEATURES_CSS_URL = "./features.css";
export const WRAPPED_CSS_URL = "./wrapped.css";

/** A lazy bundle is a fraction of a year file, so it gets less time */
const LAZY_LOAD_TIMEOUT_MS = 30_000;

/** Said when a lazy bundle belongs to a newer deploy than the page */
export const SITE_UPDATED_MESSAGE =
  "The site was updated. Reload the page to use this.";

/** Set once a bundle of another build has arrived */
let siteUpdated = false;

/**
 * Whether a lazy bundle of another build than the page's has arrived, so
 * a bundle that is unavailable was not a failure to load it (see
 * loadLazyBundle in ui/lazyBundles.ts)
 */
export function wasSiteUpdated(): boolean {
  return siteUpdated;
}

/**
 * Say the site was updated, with the reload that puts it right. Shown
 * again for every use that finds it: the same message replaces the one on
 * screen, so there is only ever one.
 */
function noticeSiteUpdate(): null {
  siteUpdated = true;
  showToast(SITE_UPDATED_MESSAGE, "info", {
    label: "Reload",
    run: () => location.reload(),
  });
  return null;
}

/** How a bundle is imported; the argument counts the imports that failed */
type Importer<T> = (failedImports: number) => Promise<T>;

/**
 * The imports of the bundles (see services/lazyImport.ts), by the build
 * they belong to. shared.bundle.js is imported under its one URL, so a
 * retried bundle shares the app's modules like the first attempt would.
 */
const importFeatures: Importer<FeatureModule> = (failedImports) =>
  importWithRetry(
    () => import("../features"),
    versioned("./features.bundle.js"),
    failedImports,
  );

const importWrapped: Importer<WrappedModule> = (failedImports) =>
  importWithRetry(
    () => import("../wrapped"),
    versioned("./wrapped.bundle.js"),
    failedImports,
  );

/** One lazy bundle: its loader and what tests use to start it over */
interface LazyBundle<T> {
  load(): Promise<T | null>;
  reset(importer: Importer<T>): void;
}

/**
 * A loader for one bundle and its stylesheet. Concurrent callers share one
 * request. A failure is not cached, here or (see services/lazyImport.ts)
 * by the browser, so the next attempt asks the server again.
 */
function lazyBundle<T extends { BUILD?: string | undefined }>(
  name: string,
  cssUrl: string,
  importer: Importer<T>,
): LazyBundle<T> {
  let importBundle = importer;
  let pending: Promise<T | null> | null = null;
  /** Set once the bundle and its stylesheet have both arrived */
  let loaded: T | null = null;
  /** Set once the bundle arrived from another build, which stays so */
  let stale = false;
  /**
   * Imports that were rejected. One that merely timed out is not counted:
   * it may still finish, and asking for the same URL again then gets the
   * module.
   */
  let failedImports = 0;

  return {
    load() {
      if (loaded) return Promise.resolve(loaded);
      if (stale) return Promise.resolve(noticeSiteUpdate());
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
          // No build in the tests and the sources, where nothing is mixed
          if (typeof __BUILD__ === "string" && module.BUILD !== __BUILD__) {
            stale = true;
            return noticeSiteUpdate();
          }
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
      stale = false;
      siteUpdated = false;
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
