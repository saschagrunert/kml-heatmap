/**
 * Formatting utility functions
 */

/**
 * Format seconds into human-readable time string
 */
export function formatTime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hours > 0) {
    return `${hours}h ${minutes}m ${secs}s`;
  } else if (minutes > 0) {
    return `${minutes}m ${secs}s`;
  } else {
    return `${secs}s`;
  }
}

/**
 * Get color for altitude value based on range
 */
export function getColorForAltitude(
  altitude: number,
  minAlt: number,
  maxAlt: number,
): string {
  // Handle edge case where min equals max
  if (maxAlt === minAlt) {
    return "rgb(0, 128, 255)"; // Return middle color (cyan)
  }

  const normalized = (altitude - minAlt) / (maxAlt - minAlt);
  const clamped = Math.max(0, Math.min(1, normalized));

  // Color gradient from blue (low) to red (high)
  if (clamped < 0.25) {
    const t = clamped / 0.25;
    return `rgb(${Math.round(0 + 0 * t)}, ${Math.round(0 + 100 * t)}, ${Math.round(255 - 55 * t)})`;
  } else if (clamped < 0.5) {
    const t = (clamped - 0.25) / 0.25;
    return `rgb(${Math.round(0 + 0 * t)}, ${Math.round(100 + 155 * t)}, ${Math.round(200 - 200 * t)})`;
  } else if (clamped < 0.75) {
    const t = (clamped - 0.5) / 0.25;
    return `rgb(${Math.round(0 + 255 * t)}, ${Math.round(255 - 0 * t)}, ${Math.round(0 + 0 * t)})`;
  } else {
    const t = (clamped - 0.75) / 0.25;
    return `rgb(${Math.round(255 - 0 * t)}, ${Math.round(255 - 255 * t)}, ${Math.round(0 + 0 * t)})`;
  }
}

/**
 * Get color for airspeed value based on range
 */
export function getColorForAirspeed(
  speed: number,
  minSpeed: number,
  maxSpeed: number,
): string {
  // Handle edge case where min equals max
  if (maxSpeed === minSpeed) {
    return "rgb(192, 0, 64)"; // Return middle color (magenta)
  }

  const normalized = (speed - minSpeed) / (maxSpeed - minSpeed);
  const clamped = Math.max(0, Math.min(1, normalized));

  // Color gradient from purple (slow) to yellow (fast)
  if (clamped < 0.5) {
    const t = clamped / 0.5;
    return `rgb(${Math.round(128 + 127 * t)}, ${Math.round(0 + 0 * t)}, ${Math.round(128 - 128 * t)})`;
  } else {
    const t = (clamped - 0.5) / 0.5;
    return `rgb(${Math.round(255 - 0 * t)}, ${Math.round(0 + 255 * t)}, ${Math.round(0 + 0 * t)})`;
  }
}
