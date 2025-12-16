/**
 * Resolution level utilities
 */

import type { ResolutionLevel } from "../types";

/**
 * Get the appropriate data resolution level for a given zoom level
 */
export function getResolutionForZoom(zoom: number): ResolutionLevel {
  if (zoom <= 4) return "z0_4";
  if (zoom <= 7) return "z5_7";
  if (zoom <= 10) return "z8_10";
  if (zoom <= 13) return "z11_13";
  return "z14_plus";
}
