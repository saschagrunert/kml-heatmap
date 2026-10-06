/**
 * The replay control's resting state.
 *
 * It only depends on whether the current selection could be replayed, which
 * the app knows on its own, so it lives in the main bundle: the button has
 * to explain itself from the first paint, long before anyone opens replay
 * and the feature bundle is fetched.
 */
import { setUnavailableFor } from "../utils/buttonState";
import { domCache } from "../utils/domCache";

export const REPLAY_BUTTON_LABEL = "Replay selected flight";
export const REPLAY_PRECONDITION_MESSAGE =
  "Pick one flight with timing data to replay, under Statistics, Flights";

/**
 * Show whether replay is available for the current selection.
 * @param ready - What MapApp.canReplay() says
 */
export function updateReplayButtonState(ready: boolean): void {
  const btn = domCache.get("replay-btn", HTMLButtonElement);
  if (!btn) return;

  // The button stays enabled so it can explain why replay is unavailable:
  // aria-disabled says so without taking it out of the tab order, which
  // the disabled attribute would, and the stylesheet dims it. A mode that
  // holds the button keeps its own title until it ends
  setUnavailableFor(btn, ready ? null : REPLAY_PRECONDITION_MESSAGE);
}
