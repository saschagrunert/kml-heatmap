/**
 * The controls a mode holds while it runs: the replay of one flight, the
 * replay of all of them and the hotspot tour each disable what would change
 * or take the map under them, and give it back as they end. Its own module
 * rather than part of utils/buttonState.ts, which the app reaches: only the
 * feature bundle holds controls.
 */
import { domCache } from "../utils/domCache";

/**
 * Disable the controls of `ids` and return what gives each back as it was.
 * Setting `disabled = false` on the way out instead turned on a control
 * something else had off for a reason of its own, such as the speed layer
 * on a site without timing data. The stylesheet dims what is disabled (see
 * `.control-btn:disabled`).
 * @returns What releases the controls
 */
export function holdControls(ids: readonly string[]): () => void {
  const held = new Map<HTMLButtonElement | HTMLSelectElement, boolean>();
  for (const id of ids) {
    const control = domCache.get(id);
    if (
      control instanceof HTMLButtonElement ||
      control instanceof HTMLSelectElement
    ) {
      held.set(control, control.disabled);
      control.disabled = true;
    }
  }
  return () => {
    for (const [control, disabled] of held) control.disabled = disabled;
    held.clear();
  };
}
