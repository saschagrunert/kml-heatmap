/**
 * A few flights smoothed on their ground, each on its own: the selection
 * drawn as ribbons (ui/selectionRibbons.ts) and the heat cloud of a
 * selection (ui/heatCloud.ts). Only the feature bundle asks, so this is
 * kept out of groundProfile.ts, which smooths every flight of the dataset
 * for the first visit's 3D view.
 */
import type { PathSegment } from "../types";
import type { SmoothedFlights } from "./smoothing";
import { groundProfilesFt, onGround, smoothAltitudes } from "./groundProfile";

/**
 * The flights of `segments` smoothed as groundedFlights smooths them, each
 * on its own, without holding them: for a few flights, such as the
 * selected ones (ui/selectionRibbons.ts), it takes a fraction of the time
 * of every flight of the dataset.
 */
export function smoothGrounded(
  segments: readonly PathSegment[],
  sampled: boolean,
  level: number,
): SmoothedFlights {
  // Each flight stands on its own fields (groundProfileFt), and on the
  // relief where it is drawn, as coarse as the level draws it, with the
  // ground of the levels around it
  return onGround(
    smoothAltitudes(segments),
    groundProfilesFt(segments, sampled, level),
  );
}
