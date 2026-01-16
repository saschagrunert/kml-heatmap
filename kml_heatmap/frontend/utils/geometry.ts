/**
 * Geometry utility functions for coordinate calculations
 */

/**
 * Coordinate tuple [latitude, longitude]
 */
export type Coordinate = [number, number];

/**
 * Calculate distance between two coordinates using Haversine formula
 * @param coords1 - [latitude, longitude] in decimal degrees
 * @param coords2 - [latitude, longitude] in decimal degrees
 * @returns Distance in kilometers
 */
export function calculateDistance(
  coords1: Coordinate,
  coords2: Coordinate
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
  lon2: number
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
  dd = Math.abs(dd);
  const degrees = Math.floor(dd);
  const minutes = Math.floor((dd - degrees) * 60);
  const seconds = ((dd - degrees) * 60 - minutes) * 60;
  return degrees + "°" + minutes + "'" + seconds.toFixed(1) + '"' + direction;
}
