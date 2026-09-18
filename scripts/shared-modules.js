/**
 * The frontend modules that both bundles use.
 *
 * mapApp.bundle.js carries them and publishes them on a global; the lazily
 * loaded features.bundle.js resolves its imports of them to that global
 * instead of bundling a second copy (see build.js). That is not only about
 * size: several of these modules hold state that has to be the same object
 * on both sides. `utils/domCache` is a cache of DOM lookups the app
 * invalidates, `utils/toast` owns the live region screen readers announce
 * through, and two copies of either would quietly disagree.
 *
 * kml_heatmap/frontend/shared.ts publishes exactly this list;
 * tests/frontend/unit/shared.test.ts checks that the two agree, and the
 * bundle test checks that no copy leaks into features.bundle.js.
 */

/** Property of `window` the shared modules are published on */
export const SHARED_GLOBAL = "__kmlShared";

/** Module paths relative to kml_heatmap/frontend, without the extension */
export const SHARED_MODULES = [
  "calculations/datasetIndex",
  "calculations/statistics",
  "features/airports",
  "ui/replayButton",
  "ui/replayState",
  "utils/arrayHelpers",
  "utils/buttonState",
  "utils/colors",
  "utils/constants",
  "utils/domCache",
  "utils/formatters",
  "utils/geometry",
  "utils/htmlGenerators",
  "utils/icons",
  "utils/logger",
  "utils/motion",
  "utils/scrollFade",
  "utils/toast",
];
