/**
 * Entry point of the lazily loaded Wrapped bundle.
 *
 * Wrapped is only needed once its dialog opens, which says nothing about
 * replay, so it is an entry point of its own rather than part of the
 * feature bundle (see services/featureLoader.ts). Everything it shares with
 * the app lives in shared.bundle.js, so this bundle adds only Wrapped.
 *
 * The statistics panel rides along: most visits never open it either, and
 * it needs most of what Wrapped computes. A bundle of its own would share
 * those modules with Wrapped and not with the app, which makes esbuild
 * write a chunk the site does not publish (assertExpectedOutputs in
 * build.js). The app loads it the first time the panel opens
 * (ui/statsPanel.ts).
 *
 * The app is imported for the bundler's sake: see features.ts.
 */
import "./mapApp";
import { StatsManager } from "./ui/statsManager";
import { WrappedManager } from "./ui/wrappedManager";

export interface WrappedModule {
  StatsManager: typeof StatsManager;
  WrappedManager: typeof WrappedManager;
}

export { StatsManager, WrappedManager };
