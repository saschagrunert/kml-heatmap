/**
 * Entry point of the lazily loaded feature bundle.
 *
 * Replay and Wrapped are a quarter of the code and most visits never open
 * either, so they are built into a second IIFE that the app fetches the
 * first time one of them is used (see services/featureLoader.ts). Everything
 * they share with the main bundle is resolved to window.__kmlShared by the
 * build, so this file adds only the two features themselves.
 */
import { ReplayManager } from "./ui/replayManager";
import { WrappedManager } from "./ui/wrappedManager";

export interface FeatureModule {
  ReplayManager: typeof ReplayManager;
  WrappedManager: typeof WrappedManager;
}

declare global {
  interface Window {
    KMLFeatures?: FeatureModule;
  }
}

window.KMLFeatures = { ReplayManager, WrappedManager };
