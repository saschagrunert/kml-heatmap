/**
 * Color calculation utilities for altitude and speed visualization
 */

interface ColorStop {
  r: number;
  g: number;
  b: number;
}

function interpolateGradient(
  normalized: number,
  stops: [ColorStop, ColorStop, ColorStop, ColorStop, ColorStop, ColorStop],
): string {
  const clamped = Math.max(0, Math.min(1, normalized));

  const segmentIndex = Math.min(Math.floor(clamped * 5), 4);
  const t = clamped * 5 - segmentIndex;

  const from = stops[segmentIndex as 0 | 1 | 2 | 3 | 4];
  const to = stops[Math.min(segmentIndex + 1, 5) as 0 | 1 | 2 | 3 | 4 | 5];

  const r = Math.round(from.r + (to.r - from.r) * t);
  const g = Math.round(from.g + (to.g - from.g) * t);
  const b = Math.round(from.b + (to.b - from.b) * t);

  return "rgb(" + r + "," + g + "," + b + ")";
}

const ALTITUDE_STOPS: [
  ColorStop,
  ColorStop,
  ColorStop,
  ColorStop,
  ColorStop,
  ColorStop,
] = [
  { r: 80, g: 160, b: 255 },
  { r: 0, g: 255, b: 255 },
  { r: 0, g: 255, b: 0 },
  { r: 255, g: 255, b: 0 },
  { r: 255, g: 165, b: 0 },
  { r: 255, g: 66, b: 66 },
];

const AIRSPEED_STOPS: [
  ColorStop,
  ColorStop,
  ColorStop,
  ColorStop,
  ColorStop,
  ColorStop,
] = [
  { r: 0, g: 128, b: 255 },
  { r: 0, g: 255, b: 255 },
  { r: 0, g: 255, b: 0 },
  { r: 255, g: 255, b: 0 },
  { r: 255, g: 128, b: 0 },
  { r: 255, g: 0, b: 0 },
];

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
  maxAlt: number,
): string {
  const normalized = (altitude - minAlt) / Math.max(maxAlt - minAlt, 1);
  return interpolateGradient(normalized, ALTITUDE_STOPS);
}

/**
 * Get RGB color for a given airspeed using gradient mapping
 * @param speed - Speed value in knots
 * @param minSpeed - Minimum speed in range
 * @param maxSpeed - Maximum speed in range
 * @returns RGB color string (e.g., "rgb(255, 128, 0)")
 */
export function getColorForAirspeed(
  speed: number,
  minSpeed: number,
  maxSpeed: number,
): string {
  const normalized = (speed - minSpeed) / Math.max(maxSpeed - minSpeed, 1);
  return interpolateGradient(normalized, AIRSPEED_STOPS);
}

/**
 * Convert an RGB color string to RGBA with the given alpha
 */
export function rgbToRgba(rgb: string, alpha: number): string {
  return rgb.replace("rgb(", "rgba(").replace(")", `, ${alpha})`);
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
