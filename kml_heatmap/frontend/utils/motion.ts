/**
 * Whether the user asked the system for reduced motion. The stylesheet
 * handles CSS animations on its own. Leaflet's are scripted, so when this is
 * true the map is created without its zoom, fade and inertia animations and
 * the callers that move it pass `animate: false`.
 *
 * The replay asks on every frame it pans. A MediaQueryList follows the
 * setting by itself, so it is created once and read from then on.
 */
let reducedMotion: MediaQueryList | null = null;

export function prefersReducedMotion(): boolean {
  if (typeof window.matchMedia !== "function") return false;
  reducedMotion ??= window.matchMedia("(prefers-reduced-motion: reduce)");
  return reducedMotion.matches;
}
