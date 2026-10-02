/**
 * The controls a mode holds while it runs: the replay of one flight, the
 * replay of all of them and the hotspot tour each disable what would change
 * or take the map under them, and give it back as they end, with the focus
 * their panel had to their own control. Its own module rather than part of
 * utils/buttonState.ts, which the app reaches: only the feature bundle
 * holds controls.
 */
import type { MapApp } from "../mapApp";
import { domCache } from "../utils/domCache";

/**
 * Controls held by the replay of one flight and of all of them alike: the
 * filters, the selection and Wrapped would change or take the map under
 * either, and so would the other modes. Each adds its own (see
 * ui/replayManager.ts and ui/replayAll.ts).
 */
export const REPLAY_HELD_CONTROL_IDS = [
  "heatmap-btn",
  "airports-btn",
  "aviation-btn",
  "wrapped-btn",
  "year-select",
  "aircraft-select",
  "isolate-btn",
  "selection-clear-btn",
  "reset-view-btn",
  "cross-section-btn",
  "hotspot-tour-btn",
] as const;

/**
 * Disable the controls of `ids` for the mode `mode` ("the replay"), each
 * titled with the way to have it back, and return what gives each back as
 * it was. Setting `disabled = false` on the way out instead turned on a
 * control something else had off for a reason of its own, such as the
 * speed layer on a site without timing data. The stylesheet dims what is
 * disabled (see `.control-btn:disabled`); the title says why, where the
 * filters had none at all.
 * @returns What releases the controls
 */
export function holdControls(ids: readonly string[], mode: string): () => void {
  const held = new Map<
    HTMLButtonElement | HTMLSelectElement,
    [disabled: boolean, title: string]
  >();
  for (const id of ids) {
    const control = domCache.get(id);
    if (
      control instanceof HTMLButtonElement ||
      control instanceof HTMLSelectElement
    ) {
      held.set(control, [control.disabled, control.title]);
      control.disabled = true;
      control.title = `End ${mode} to change this`;
    }
  }
  return () => {
    for (const [control, [disabled, title]] of held) {
      control.disabled = disabled;
      control.title = title;
    }
    held.clear();
  };
}

/**
 * Hand the focus to the control `id` of a mode that ends, whose panel had
 * it and hides: a button that hides drops its focus to <body>. On a phone
 * the control columns are hidden, and the bar's More tab, whose sheet
 * stands in for them, takes it.
 */
export function focusModeControl(app: MapApp, id: string): void {
  document
    .getElementById(app.mobileBar?.isVisible() ? "mobile-tab-more" : id)
    ?.focus();
}
