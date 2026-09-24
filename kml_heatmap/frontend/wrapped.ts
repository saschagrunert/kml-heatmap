/**
 * Entry point of the lazily loaded Wrapped bundle.
 *
 * Wrapped is only needed once its dialog opens, which says nothing about
 * replay, so it is an entry point of its own rather than part of the
 * feature bundle (see services/featureLoader.ts). Everything it shares with
 * the app lives in shared.bundle.js, so this bundle adds only Wrapped.
 *
 * The app is imported for the bundler's sake: see features.ts.
 */
import "./mapApp";
import { WrappedManager } from "./ui/wrappedManager";

export interface WrappedModule {
  WrappedManager: typeof WrappedManager;
}

export { WrappedManager };
