/**
 * Fetch the lazily loaded feature bundle.
 *
 * Replay and Wrapped are a quarter of the frontend and most visits open
 * neither, so they are built into features.bundle.js and loaded the first
 * time one of them is used. The same pattern as loadDomToImage() in
 * ui/uiToggles.ts: a script tag, one shared promise, and a failure that
 * resolves rather than throws so the caller can say something useful.
 */
import { loadScript } from "./dataLoader";
import { logError } from "../utils/logger";
import type { FeatureModule } from "../features";

/** Next to the page, like every other file the site ships */
export const FEATURES_URL = "./features.bundle.js";

/** A feature bundle is a fraction of a year file, so it gets less time */
export const FEATURES_LOAD_TIMEOUT_MS = 30_000;

let pending: Promise<FeatureModule | null> | null = null;

/**
 * The feature bundle's exports, or null when it could not be loaded.
 * Concurrent callers share one request; a failure is not cached, so the next
 * attempt tries again.
 */
export function loadFeatures(): Promise<FeatureModule | null> {
  if (window.KMLFeatures) return Promise.resolve(window.KMLFeatures);
  if (pending) return pending;

  pending = loadScript(FEATURES_URL, FEATURES_LOAD_TIMEOUT_MS)
    .then(() => window.KMLFeatures ?? null)
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
}
