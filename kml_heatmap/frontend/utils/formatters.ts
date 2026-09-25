/**
 * Formatting utility functions
 */

/**
 * A measurement with grouped digits, so five- and six-figure values stay
 * readable ("264,400" rather than "264400"). Every surface that prints a
 * number goes through this, so the panel, the legends, the tooltips and the
 * replay readout all group the same way.
 *
 * @param value - The number to render
 * @param decimals - Fixed number of decimals (default: none)
 */
export function formatNumber(value: number, decimals = 0): string {
  if (!Number.isFinite(value)) return "0";
  return value.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/**
 * Format seconds into human-readable time string
 * @param seconds - Total seconds
 * @param span - A time the result is to line up with: from an hour on,
 *   hours are shown even when `seconds` has none ("0:05:30")
 * @returns Formatted time (e.g., "2:30:45" or "5:30")
 */
export function formatTime(seconds: number, span: number = seconds): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hours > 0 || span >= 3600) {
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
 * Format speed in knots to human-readable string
 * @param knots - Speed in knots
 * @returns Formatted speed (e.g., "120 kt")
 */
export function formatSpeed(knots: number): string {
  return formatNumber(knots) + " kt";
}

/**
 * Compass track for a bearing, normalised and zero padded ("072°"). The
 * rounding comes first, so 359.6 degrees reads 000, never 360.
 * @param bearing - Bearing in degrees, any range
 */
export function formatTrack(bearing: number): string {
  const normalised = ((Math.round(bearing) % 360) + 360) % 360;
  return String(normalised).padStart(3, "0") + "°";
}

/**
 * Format seconds into flight time string (e.g., "2h 30m")
 * @param seconds - Total seconds
 * @returns Formatted flight time
 */
export function formatFlightTime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

/**
 * Format a byte count into a human-readable file size (e.g., "1.1 MB")
 * @param bytes - Size in bytes
 * @returns Formatted size
 */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = units[0]!;
  for (let i = 1; i < units.length && value >= 1024; i++) {
    value /= 1024;
    unit = units[i]!;
  }
  const text = value < 10 ? value.toFixed(1) : String(Math.round(value));
  return `${text} ${unit}`;
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/**
 * Format the build time map_config.js carries (e.g., "21 Sep 2026, 14:03
 * UTC"). Always in UTC and in English, so every viewer reads the same text.
 * @param iso - "YYYY-MM-DDTHH:MMZ"
 * @returns Formatted time, or null when the value is not one
 */
export function formatBuildTime(iso: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})Z$/.exec(iso);
  if (!match) return null;
  const [, year, month, day, hours, minutes] = match;
  const monthName = MONTHS[Number(month) - 1];
  if (!monthName) return null;
  return `${Number(day)} ${monthName} ${year}, ${hours}:${minutes} UTC`;
}
