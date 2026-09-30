/**
 * The controls of the page while Wrapped has the map: hidden as the dialog
 * opens and put back as it closes (ui/wrappedManager.ts). Only the Wrapped
 * bundle does this, so it is kept out of utils/domCache.ts, which is part
 * of the first visit.
 */
import { HIDEABLE_CONTROL_IDS } from "../utils/constants";
import { domCache } from "../utils/domCache";

/**
 * Hide the controls that must not show while Wrapped has the map, and
 * return their inline display to put back with restoreControls
 */
export function hideControls(): Map<HTMLElement, string> {
  const savedDisplays = new Map<HTMLElement, string>();
  for (const id of HIDEABLE_CONTROL_IDS) {
    const el = domCache.get(id);
    if (el) {
      savedDisplays.set(el, el.style.display);
      el.style.display = "none";
    }
  }
  return savedDisplays;
}

export function restoreControls(savedDisplays: Map<HTMLElement, string>): void {
  savedDisplays.forEach((display, el) => {
    el.style.display = display;
  });
}
