/**
 * Coordinate utility functions
 */

import { REPLAY_CONFIG } from "../constants";

/**
 * Convert decimal degrees to degrees, minutes, seconds format
 */
export function ddToDms(dd: number, isLat: boolean): string {
  const direction = dd >= 0 ? (isLat ? "N" : "E") : isLat ? "S" : "W";
  const abs = Math.abs(dd);
  const degrees = Math.floor(abs);
  const minutes = Math.floor((abs - degrees) * 60);
  const seconds = ((abs - degrees) * 60 - minutes) * 60;
  return `${degrees}°${minutes}'${seconds.toFixed(1)}"${direction}`;
}

/**
 * Calculate bearing between two points in degrees
 */
export function calculateBearing(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const lat1Rad = (lat1 * Math.PI) / 180;
  const lat2Rad = (lat2 * Math.PI) / 180;

  const y = Math.sin(dLon) * Math.cos(lat2Rad);
  const x =
    Math.cos(lat1Rad) * Math.sin(lat2Rad) -
    Math.sin(lat1Rad) * Math.cos(lat2Rad) * Math.cos(dLon);

  const bearing = Math.atan2(y, x);
  return ((bearing * 180) / Math.PI + 360) % 360;
}

/**
 * Calculate smoothed bearing using look-ahead
 */
export function calculateSmoothedBearing(
  segments: Array<{ coords: [number, number][] }>,
  currentIdx: number,
  lookAhead: number = REPLAY_CONFIG.DEFAULT_LOOK_AHEAD,
): number | null {
  if (currentIdx >= segments.length) {
    return null;
  }

  const currentSegment = segments[currentIdx];
  if (
    !currentSegment ||
    !currentSegment.coords ||
    currentSegment.coords.length < 2
  ) {
    return null;
  }

  const startCoord = currentSegment.coords[0];
  let endCoord = currentSegment.coords[currentSegment.coords.length - 1];

  // Look ahead to smooth bearing
  const targetIdx = Math.min(currentIdx + lookAhead, segments.length - 1);
  if (targetIdx > currentIdx) {
    const targetSegment = segments[targetIdx];
    if (
      targetSegment &&
      targetSegment.coords &&
      targetSegment.coords.length >= 1
    ) {
      endCoord = targetSegment.coords[targetSegment.coords.length - 1];
    }
  }

  return calculateBearing(
    startCoord[0],
    startCoord[1],
    endCoord[0],
    endCoord[1],
  );
}
