/**
 * Color calculation utilities for altitude and speed visualization
 */

interface ColorStop {
  r: number;
  g: number;
  b: number;
}

/** The one spelling of a colour in this module, shared with the CSS ramps */
function rgb(stop: ColorStop): string {
  return "rgb(" + stop.r + "," + stop.g + "," + stop.b + ")";
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

  return rgb({
    r: Math.round(from.r + (to.r - from.r) * t),
    g: Math.round(from.g + (to.g - from.g) * t),
    b: Math.round(from.b + (to.b - from.b) * t),
  });
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

/** CSS `linear-gradient(...)` spelling of a stop list, evenly spaced */
function gradientCss(stops: readonly ColorStop[]): string {
  const steps = stops
    .map((stop, index) => {
      const percent = (index / (stops.length - 1)) * 100;
      return `${rgb(stop)} ${percent}%`;
    })
    .join(", ");
  return `linear-gradient(to right, ${steps})`;
}

/**
 * Publish both ramps as custom properties so the legend bar and the row chips
 * paint the very same stops the polylines are coloured with. Spelling them
 * out in the stylesheet as well let the legend drift away from the map.
 */
export function applyGradientTokens(root: HTMLElement): void {
  root.style.setProperty("--gradient-altitude", gradientCss(ALTITUDE_STOPS));
  root.style.setProperty("--gradient-speed", gradientCss(AIRSPEED_STOPS));
}

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
