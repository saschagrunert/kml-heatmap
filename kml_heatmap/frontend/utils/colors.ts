/**
 * Color calculation utilities for altitude and speed visualization
 */

/**
 * Get RGB color for a given altitude using gradient mapping
 * @param altitude - Altitude value
 * @param minAlt - Minimum altitude in range
 * @param maxAlt - Maximum altitude in range
 * @returns RGB color string (e.g., "rgb(255, 128, 0)")
 */
export function getColorForAltitude(
  altitude: number,
  minAlt: number,
  maxAlt: number
): string {
  // Normalize altitude to 0-1 range
  let normalized = (altitude - minAlt) / Math.max(maxAlt - minAlt, 1);
  normalized = Math.max(0, Math.min(1, normalized)); // Clamp to 0-1

  // Color gradient: light blue → cyan → green → yellow → orange → light red
  // Lighter terminal colors for better visibility on dark background
  let r: number, g: number, b: number;

  if (normalized < 0.2) {
    // Light Blue to Cyan (0.0 - 0.2)
    const t = normalized / 0.2;
    r = Math.round(80 * (1 - t)); // Start at 80, go to 0
    g = Math.round(160 + 95 * t); // 160 to 255
    b = 255;
  } else if (normalized < 0.4) {
    // Cyan to Green (0.2 - 0.4)
    const t = (normalized - 0.2) / 0.2;
    r = 0;
    g = 255;
    b = Math.round(255 * (1 - t));
  } else if (normalized < 0.6) {
    // Green to Yellow (0.4 - 0.6)
    const t = (normalized - 0.4) / 0.2;
    r = Math.round(255 * t);
    g = 255;
    b = 0;
  } else if (normalized < 0.8) {
    // Yellow to Orange (0.6 - 0.8)
    const t = (normalized - 0.6) / 0.2;
    r = 255;
    g = Math.round(255 * (1 - t * 0.35)); // ~165 at t=1
    b = 0;
  } else {
    // Orange to Light Red (0.8 - 1.0)
    const t = (normalized - 0.8) / 0.2;
    r = 255;
    g = Math.round(165 * (1 - t * 0.6)); // End at ~66 instead of 0
    b = Math.round(66 * t); // Add some blue component for lighter red
  }

  return "rgb(" + r + "," + g + "," + b + ")";
}

/**
 * Get RGB color for a given airspeed using gradient mapping
 * Similar to altitude but with different color scheme optimized for speed
 * @param speed - Speed value in knots
 * @param minSpeed - Minimum speed in range
 * @param maxSpeed - Maximum speed in range
 * @returns RGB color string (e.g., "rgb(255, 128, 0)")
 */
export function getColorForAirspeed(
  speed: number,
  minSpeed: number,
  maxSpeed: number
): string {
  // Normalize speed to 0-1 range
  let normalized = (speed - minSpeed) / Math.max(maxSpeed - minSpeed, 1);
  normalized = Math.max(0, Math.min(1, normalized)); // Clamp to 0-1

  // Color gradient: blue → cyan → green → yellow → orange → red
  // Optimized for speed visualization (slower = cooler colors, faster = warmer colors)
  let r: number, g: number, b: number;

  if (normalized < 0.2) {
    // Blue to Cyan (0.0 - 0.2)
    const t = normalized / 0.2;
    r = 0;
    g = Math.round(128 + 127 * t); // 128 to 255
    b = 255;
  } else if (normalized < 0.4) {
    // Cyan to Green (0.2 - 0.4)
    const t = (normalized - 0.2) / 0.2;
    r = 0;
    g = 255;
    b = Math.round(255 * (1 - t));
  } else if (normalized < 0.6) {
    // Green to Yellow (0.4 - 0.6)
    const t = (normalized - 0.4) / 0.2;
    r = Math.round(255 * t);
    g = 255;
    b = 0;
  } else if (normalized < 0.8) {
    // Yellow to Orange (0.6 - 0.8)
    const t = (normalized - 0.6) / 0.2;
    r = 255;
    g = Math.round(255 * (1 - t * 0.5)); // 255 to ~128
    b = 0;
  } else {
    // Orange to Red (0.8 - 1.0)
    const t = (normalized - 0.8) / 0.2;
    r = 255;
    g = Math.round(128 * (1 - t)); // 128 to 0
    b = 0;
  }

  return "rgb(" + r + "," + g + "," + b + ")";
}

/**
 * RGB color components
 */
export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

/**
 * Parse RGB string to component values
 * @param rgbString - RGB color string (e.g., "rgb(255, 128, 0)")
 * @returns RGB components
 */
export function parseRgb(rgbString: string): RgbColor {
  const match = rgbString.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
  if (!match || !match[1] || !match[2] || !match[3]) {
    return { r: 0, g: 0, b: 0 };
  }
  return {
    r: parseInt(match[1], 10),
    g: parseInt(match[2], 10),
    b: parseInt(match[3], 10),
  };
}
