/**
 * Map utility helpers
 * Pure functions for common map operations
 */
import type L from "leaflet";

/**
 * Invalidate map size after a CSS transition completes on the given element.
 * Falls back to a timeout matching --duration-base (300ms) when no element
 * is provided or the transitionend event does not fire.
 */
export function invalidateMapAfterTransition(
  map: L.Map | null,
  transitionTarget?: HTMLElement | null,
): void {
  if (!map) return;

  const FALLBACK_MS = 350;

  if (transitionTarget) {
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      transitionTarget.removeEventListener("transitionend", onEnd);
      map.invalidateSize();
    };
    const onEnd = (e: TransitionEvent): void => {
      if (e.target === transitionTarget) done();
    };
    transitionTarget.addEventListener("transitionend", onEnd);
    setTimeout(done, FALLBACK_MS);
  } else {
    setTimeout(() => map.invalidateSize(), FALLBACK_MS);
  }
}
