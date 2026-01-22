/**
 * Replay functionality helpers
 * Pure functions for flight replay calculations
 */

import { calculateBearing as geometryCalculateBearing } from "../utils/geometry";
import type { PathSegment } from "../types";

// Re-export calculateBearing for backward compatibility
export { calculateBearing } from "../utils/geometry";

/**
 * Interpolated position
 */
export interface InterpolatedPosition {
  lat: number;
  lon: number;
  altitude: number;
  speed: number;
}

/**
 * Segment info at current time
 */
export interface SegmentInfo {
  current: PathSegment | null;
  next: PathSegment | null;
  index: number;
}

/**
 * Map bounds
 */
export interface MapBounds {
  north: number;
  south: number;
  east: number;
  west: number;
}

/**
 * Validation result
 */
export interface ValidationResult {
  valid: boolean;
  message: string;
}

/**
 * Prepare segments for replay
 * @param segments - All segments
 * @param pathId - Selected path ID
 * @returns Sorted segments with time data
 */
export function prepareReplaySegments(
  segments: PathSegment[],
  pathId: number
): PathSegment[] {
  // Filter segments that belong to selected path and have time data
  const replaySegments = segments.filter(
    (seg) =>
      seg.path_id === pathId && seg.time !== undefined && seg.time !== null
  );

  // Sort by time
  return replaySegments.sort((a, b) => a.time! - b.time!);
}

/**
 * Calculate time range from segments
 * @param segments - Replay segments
 * @returns Time range
 */
export function calculateTimeRange(segments: PathSegment[]): {
  min: number;
  max: number;
} {
  if (segments.length === 0) {
    return { min: 0, max: 0 };
  }

  const times = segments.map((s) => s.time!);

  // Use iterative approach to avoid stack overflow with large arrays
  let min = times[0] ?? 0;
  let max = times[0] ?? 0;
  for (let i = 1; i < times.length; i++) {
    const time = times[i] ?? 0;
    if (time < min) min = time;
    if (time > max) max = time;
  }

  return { min, max };
}

/**
 * Find segments at current replay time
 * @param segments - Sorted replay segments
 * @param currentTime - Current replay time
 * @returns Segment info
 */
export function findSegmentsAtTime(
  segments: PathSegment[],
  currentTime: number
): SegmentInfo {
  if (segments.length === 0) {
    return { current: null, next: null, index: -1 };
  }

  // Find the segment we're currently at
  let currentIndex = 0;
  for (let i = 0; i < segments.length; i++) {
    if (segments[i]!.time! <= currentTime) {
      currentIndex = i;
    } else {
      break;
    }
  }

  return {
    current: segments[currentIndex] || null,
    next: segments[currentIndex + 1] || null,
    index: currentIndex,
  };
}

/**
 * Interpolate position between two segments
 * @param seg1 - First segment
 * @param seg2 - Second segment
 * @param currentTime - Current time
 * @returns Interpolated position
 */
export function interpolatePosition(
  seg1: PathSegment,
  seg2: PathSegment | null,
  currentTime: number
): InterpolatedPosition {
  if (!seg2 || !seg1.coords) {
    // At end of path, use last segment's end point
    return {
      lat: seg1.coords![1][0],
      lon: seg1.coords![1][1],
      altitude: seg1.altitude_ft || 0,
      speed: seg1.groundspeed_knots || 0,
    };
  }

  // Interpolate between seg1 end and seg2 start
  const t1 = seg1.time!;
  const t2 = seg2.time!;
  const progress = (currentTime - t1) / Math.max(t2 - t1, 0.001);

  const startLat = seg1.coords[1][0];
  const startLon = seg1.coords[1][1];
  const endLat = seg2.coords![0][0];
  const endLon = seg2.coords![0][1];

  return {
    lat: startLat + (endLat - startLat) * progress,
    lon: startLon + (endLon - startLon) * progress,
    altitude:
      (seg1.altitude_ft || 0) +
      ((seg2.altitude_ft || 0) - (seg1.altitude_ft || 0)) * progress,
    speed:
      (seg1.groundspeed_knots || 0) +
      ((seg2.groundspeed_knots || 0) - (seg1.groundspeed_knots || 0)) *
        progress,
  };
}

/**
 * Calculate smoothed bearing from multiple future segments
 * @param segments - All segments
 * @param currentIdx - Current segment index
 * @param lookAhead - Number of segments to look ahead
 * @returns Bearing in degrees or null
 */
export function calculateSmoothedBearing(
  segments: PathSegment[],
  currentIdx: number,
  lookAhead: number = 5
): number | null {
  if (currentIdx < 0 || currentIdx >= segments.length) {
    return null;
  }

  const currentSeg = segments[currentIdx]!;
  const futureIdx = Math.min(currentIdx + lookAhead, segments.length - 1);
  const futureSeg = segments[futureIdx]!;

  if (currentIdx === futureIdx) {
    // At end, use current segment's direction
    const coords = currentSeg.coords;
    if (coords && coords.length === 2) {
      return geometryCalculateBearing(
        coords[0][0],
        coords[0][1],
        coords[1][0],
        coords[1][1]
      );
    }
    return null;
  }

  // Calculate bearing from current position to future position
  if (!currentSeg.coords || !futureSeg.coords) {
    return null;
  }

  return geometryCalculateBearing(
    currentSeg.coords[1][0],
    currentSeg.coords[1][1],
    futureSeg.coords[0][0],
    futureSeg.coords[0][1]
  );
}

/**
 * Calculate appropriate zoom level based on altitude and speed
 * @param altitude - Altitude in feet
 * @param speed - Speed in knots
 * @param options - Options
 * @returns Zoom level
 */
export function calculateAutoZoom(
  altitude: number,
  speed: number,
  options: {
    minZoom?: number;
    maxZoom?: number;
    cruiseAltitude?: number;
    cruiseSpeed?: number;
  } = {}
): number {
  const {
    minZoom = 10,
    maxZoom = 16,
    cruiseAltitude = 5000,
    cruiseSpeed = 100,
  } = options;

  // Base zoom on altitude (higher altitude = zoom out)
  const altitudeFactor = Math.min(altitude / cruiseAltitude, 2);

  // Base zoom on speed (higher speed = zoom out)
  const speedFactor = Math.min(speed / cruiseSpeed, 2);

  // Combined factor (average of both)
  const combinedFactor = (altitudeFactor + speedFactor) / 2;

  // Scale from maxZoom (low altitude/speed) to minZoom (high altitude/speed)
  const zoomLevel = maxZoom - (combinedFactor * (maxZoom - minZoom)) / 2;

  return Math.max(minZoom, Math.min(maxZoom, Math.round(zoomLevel)));
}

/**
 * Check if recenter is needed based on position and map bounds
 * @param position - Current position {lat, lon}
 * @param bounds - Map bounds {north, south, east, west}
 * @param margin - Margin factor (0-1)
 * @returns True if recenter needed
 */
export function shouldRecenter(
  position: { lat: number; lon: number },
  bounds: MapBounds,
  margin: number = 0.2
): boolean {
  const latRange = bounds.north - bounds.south;
  const lonRange = bounds.east - bounds.west;

  const latMargin = latRange * margin;
  const lonMargin = lonRange * margin;

  // Check if position is outside the inner bounds
  if (position.lat < bounds.south + latMargin) return true;
  if (position.lat > bounds.north - latMargin) return true;
  if (position.lon < bounds.west + lonMargin) return true;
  if (position.lon > bounds.east - lonMargin) return true;

  return false;
}

/**
 * Calculate replay progress percentage
 * @param currentTime - Current time
 * @param maxTime - Maximum time
 * @returns Progress percentage (0-100)
 */
export function calculateReplayProgress(
  currentTime: number,
  maxTime: number
): number {
  if (maxTime === 0) return 0;
  return Math.min(100, (currentTime / maxTime) * 100);
}

/**
 * Validate replay data
 * @param segments - Segments to validate
 * @returns Validation result
 */
export function validateReplayData(segments: PathSegment[]): ValidationResult {
  if (!segments || segments.length === 0) {
    return {
      valid: false,
      message: "No segments available for replay",
    };
  }

  const segmentsWithTime = segments.filter(
    (s) => s.time !== undefined && s.time !== null
  );

  if (segmentsWithTime.length === 0) {
    return {
      valid: false,
      message:
        "No timestamp data available. The flight may not have timing information.",
    };
  }

  return {
    valid: true,
    message: "Replay data is valid",
  };
}
