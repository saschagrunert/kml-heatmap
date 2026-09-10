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
 * Format speed in knots to human-readable string
 * @param knots - Speed in knots
 * @returns Formatted speed (e.g., "120 kt")
 */
export function formatSpeed(knots: number): string {
  return formatNumber(knots) + " kt";
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
