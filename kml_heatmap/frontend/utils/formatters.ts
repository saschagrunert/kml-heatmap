/**
 * Formatting utility functions
 */

/**
 * Format seconds into human-readable time string
 * @param seconds - Total seconds
 * @returns Formatted time (e.g., "2:30:45" or "5:30")
 */
export function formatTime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hours > 0) {
    return (
      hours +
      ":" +
      minutes.toString().padStart(2, "0") +
      ":" +
      secs.toString().padStart(2, "0")
    );
  }

  return minutes + ":" + secs.toString().padStart(2, "0");
}

/**
 * Format distance in kilometers to human-readable string
 * @param km - Distance in kilometers
 * @param decimals - Number of decimal places (default: 0)
 * @returns Formatted distance (e.g., "1,234 km")
 */
export function formatDistance(km: number, decimals = 0): string {
  return (
    km.toLocaleString("en-US", {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }) + " km"
  );
}

/**
 * Format altitude in meters to feet string
 * @param meters - Altitude in meters
 * @returns Formatted altitude (e.g., "10,000 ft")
 */
export function formatAltitude(meters: number): string {
  const feet = Math.round(meters * 3.28084);
  return feet.toLocaleString("en-US") + " ft";
}

/**
 * Format speed in knots to human-readable string
 * @param knots - Speed in knots
 * @returns Formatted speed (e.g., "120 kt")
 */
export function formatSpeed(knots: number): string {
  return Math.round(knots).toLocaleString("en-US") + " kt";
}

/**
 * Get zoom resolution name for a given zoom level
 * @param zoom - Map zoom level
 * @returns Resolution identifier (e.g., 'z14_plus')
 */
export function getResolutionForZoom(zoom: number): string {
  if (zoom <= 4) return "z0_4";
  if (zoom <= 7) return "z5_7";
  if (zoom <= 10) return "z8_10";
  if (zoom <= 13) return "z11_13";
  return "z14_plus";
}
