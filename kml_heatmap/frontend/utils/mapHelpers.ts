/**
 * Map utility helpers
 * Pure functions for common map operations
 */
import type L from "leaflet";

/**
 * Invalidate map size with delay for mobile Safari
 * Mobile Safari needs a small delay for touch event handling
 */
export function invalidateMapWithDelay(map: L.Map | null, delay = 50): void {
  if (!map) return;

  setTimeout(() => {
    map.invalidateSize();
  }, delay);
}
