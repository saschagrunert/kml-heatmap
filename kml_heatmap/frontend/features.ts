/**
 * Entry point of the lazily loaded feature bundle.
 *
 * Replay and Wrapped are a quarter of the code and most visits never open
 * either, so they are an entry point of their own that the app imports the
 * first time one of them is used (see services/featureLoader.ts). Everything
 * they share with the app lives in shared.bundle.js, which both import, so
 * this bundle adds only the two features themselves, the flight list of
 * the airport popups, which the first of them fetches, the relief of the
 * 3D view, which the layer manager fetches as it is first wanted, and the
 * satellite imagery, which its switch fetches.
 */
import { listFlights } from "./ui/airportFlights";
import { ReplayManager } from "./ui/replayManager";
import { WrappedManager } from "./ui/wrappedManager";
import { followTerrain } from "./ui/terrain";
import { followSatellite } from "./ui/satellite";

export interface FeatureModule {
  ReplayManager: typeof ReplayManager;
  WrappedManager: typeof WrappedManager;
  listFlights: typeof listFlights;
  followTerrain: typeof followTerrain;
  followSatellite: typeof followSatellite;
}

export {
  ReplayManager,
  WrappedManager,
  listFlights,
  followTerrain,
  followSatellite,
};
