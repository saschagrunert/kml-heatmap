/**
 * Geometry utility functions for coordinate calculations
 */
import { MAP_MAX_PITCH } from "./constants";

/**
 * Coordinate tuple [latitude, longitude]
 */
export type Coordinate = [number, number];

/**
 * The pair as a place a map can be centred on, or null when it is none.
 * Links and saved state both go through here before they reach the map:
 * MapLibre throws for a latitude past the poles, and a saved view that
 * throws would do so on every reload with nothing to clear it. A longitude
 * past 180 is no damage: a pan across the antimeridian leaves one behind,
 * and older builds saved it as it was. It is the same place in another copy
 * of the world, so it is wrapped back into range.
 */
export function toMapCenter(center: {
  lat: unknown;
  lng: unknown;
}): { lat: number; lng: number } | null {
  const { lat, lng } = center;
  if (
    typeof lat !== "number" ||
    typeof lng !== "number" ||
    !isFinite(lat) ||
    !isFinite(lng) ||
    Math.abs(lat) > 90
  ) {
    return null;
  }
  // Only out of range: the wrap adds rounding noise, and turns 180 into -180
  if (Math.abs(lng) <= 180) return { lat, lng };
  return { lat, lng: wrapDegrees(lng) };
}

/** Degrees wrapped into -180 to 180 */
function wrapDegrees(degrees: number): number {
  return ((((degrees + 180) % 360) + 360) % 360) - 180;
}

/**
 * A bearing of a link or of saved state as the map reports its own: any
 * finite number of degrees, wrapped into -180 to 180. Null for anything else.
 */
export function toMapBearing(bearing: unknown): number | null {
  if (typeof bearing !== "number" || !isFinite(bearing)) return null;
  // Only out of range, for the reason given in toMapCenter
  return Math.abs(bearing) <= 180 ? bearing : wrapDegrees(bearing);
}

/** A pitch of a link or of saved state, held to what the map tilts to */
export function toMapPitch(pitch: unknown): number | null {
  if (typeof pitch !== "number" || !isFinite(pitch)) return null;
  return Math.max(0, Math.min(MAP_MAX_PITCH, pitch));
}

/**
 * Calculate distance between two coordinates using Haversine formula
 * @param coords1 - [latitude, longitude] in decimal degrees
 * @param coords2 - [latitude, longitude] in decimal degrees
 * @returns Distance in kilometers
 */
export function calculateDistance(
  coords1: Coordinate,
  coords2: Coordinate,
): number {
  const [lat1Deg, lon1Deg] = coords1;
  const [lat2Deg, lon2Deg] = coords2;

  // Convert to radians
  const lat1 = (lat1Deg * Math.PI) / 180;
  const lon1 = (lon1Deg * Math.PI) / 180;
  const lat2 = (lat2Deg * Math.PI) / 180;
  const lon2 = (lon2Deg * Math.PI) / 180;

  const dlat = lat2 - lat1;
  const dlon = lon2 - lon1;

  const a =
    Math.sin(dlat / 2) * Math.sin(dlat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dlon / 2) * Math.sin(dlon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  // Earth's radius in kilometers
  return 6371 * c;
}

/**
 * Calculate bearing (direction) from one coordinate to another
 * @param lat1 - Starting latitude in decimal degrees
 * @param lon1 - Starting longitude in decimal degrees
 * @param lat2 - Ending latitude in decimal degrees
 * @param lon2 - Ending longitude in decimal degrees
 * @returns Bearing in degrees (0-360)
 */
export function calculateBearing(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  // Convert to radians
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;

  // Calculate bearing
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  const θ = Math.atan2(y, x);

  // Convert to degrees and normalize to 0-360
  return ((θ * 180) / Math.PI + 360) % 360;
}

/**
 * Convert decimal degrees to degrees, minutes, seconds format
 * @param dd - Decimal degrees
 * @param isLat - True for latitude, false for longitude
 * @returns Formatted DMS string (e.g., "51°30'15.6"N")
 */
export function ddToDms(dd: number, isLat: boolean): string {
  const direction = dd >= 0 ? (isLat ? "N" : "E") : isLat ? "S" : "W";
  // Round once, in the unit that is printed, and split afterwards: rounding
  // only the seconds turns 59.96 into "60.0" instead of carrying the minute
  const tenths = Math.round(Math.abs(dd) * 36000);
  const degrees = Math.floor(tenths / 36000);
  const minutes = Math.floor((tenths % 36000) / 600);
  const seconds = (tenths % 600) / 10;
  return degrees + "°" + minutes + "'" + seconds.toFixed(1) + '"' + direction;
}
