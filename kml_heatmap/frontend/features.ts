/**
 * Entry point of the lazily loaded feature bundle.
 *
 * Replay is a large part of the code and most visits never open it, so it
 * is an entry point of its own that the app imports the first time it is
 * used (see services/featureLoader.ts). Everything it shares with the app
 * lives in shared.bundle.js, so this bundle adds only replay itself, the
 * relief and the heat cloud of the 3D view, which the layer manager
 * fetches as they are first wanted, and the satellite imagery, which its
 * switch fetches. Wrapped has
 * a bundle of its own (wrapped.ts).
 *
 * The app is imported for the bundler's sake. esbuild puts every module in
 * a chunk by the set of entry points that reach it, so with three of them a
 * module the app shares with replay and not with Wrapped would get a chunk
 * of its own, and each such chunk would be one more file on the first visit
 * under the same fixed name. Reaching the app from both lazy entry points
 * gives all of it the same set, so the app is one chunk (shared.bundle.js)
 * and each lazy bundle is left with only its own code. The module runs once
 * all the same: by the time this bundle is imported, the page has run it.
 */
import "./mapApp";
import { ReplayManager } from "./ui/replayManager";
import { followTerrain } from "./ui/terrain";
import { followSatellite } from "./ui/satellite";
import { followHeatCloud } from "./ui/heatCloud";

export interface FeatureModule {
  ReplayManager: typeof ReplayManager;
  followTerrain: typeof followTerrain;
  followSatellite: typeof followSatellite;
  followHeatCloud: typeof followHeatCloud;
}

export { ReplayManager, followTerrain, followSatellite, followHeatCloud };
