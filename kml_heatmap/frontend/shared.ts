/**
 * Publish the modules both bundles use on a global.
 *
 * features.bundle.js is loaded on demand and resolves its imports of these
 * to this object rather than bundling a second copy, so the two bundles
 * share one `domCache`, one toast live region and one of everything else
 * that holds state. scripts/shared-modules.js holds the list the build
 * resolves against; the two are checked against each other by
 * tests/frontend/unit/shared.test.ts.
 */
import * as calculationsDatasetIndex from "./calculations/datasetIndex";
import * as calculationsStatistics from "./calculations/statistics";
import * as featuresAirports from "./features/airports";
import * as uiReplayButton from "./ui/replayButton";
import * as uiReplayState from "./ui/replayState";
import * as utilsArrayHelpers from "./utils/arrayHelpers";
import * as utilsButtonState from "./utils/buttonState";
import * as utilsColors from "./utils/colors";
import * as utilsConstants from "./utils/constants";
import * as utilsDomCache from "./utils/domCache";
import * as utilsFormatters from "./utils/formatters";
import * as utilsGeometry from "./utils/geometry";
import * as utilsHtmlGenerators from "./utils/htmlGenerators";
import * as utilsIcons from "./utils/icons";
import * as utilsLogger from "./utils/logger";
import * as utilsMotion from "./utils/motion";
import * as utilsToast from "./utils/toast";

/** Keyed by the module path relative to this directory, as the build spells it */
export const sharedModules: Record<string, unknown> = {
  "calculations/datasetIndex": calculationsDatasetIndex,
  "calculations/statistics": calculationsStatistics,
  "features/airports": featuresAirports,
  "ui/replayButton": uiReplayButton,
  "ui/replayState": uiReplayState,
  "utils/arrayHelpers": utilsArrayHelpers,
  "utils/buttonState": utilsButtonState,
  "utils/colors": utilsColors,
  "utils/constants": utilsConstants,
  "utils/domCache": utilsDomCache,
  "utils/formatters": utilsFormatters,
  "utils/geometry": utilsGeometry,
  "utils/htmlGenerators": utilsHtmlGenerators,
  "utils/icons": utilsIcons,
  "utils/logger": utilsLogger,
  "utils/motion": utilsMotion,
  "utils/toast": utilsToast,
};

declare global {
  interface Window {
    __kmlShared?: Record<string, unknown>;
  }
}

window.__kmlShared = sharedModules;
