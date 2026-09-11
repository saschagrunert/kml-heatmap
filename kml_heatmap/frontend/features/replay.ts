/**
 * Replay functionality helpers
 * Pure functions for flight replay calculations
 */

import { calculateBearing } from "../utils/geometry";
import { segmentsForPathIds } from "../calculations/statistics";
import type { PathSegment } from "../types";

/**
 * Prepare segments for replay
 * @param segments - All segments
 * @param pathId - Selected path ID
 * @returns Sorted segments with time data
 */
export function prepareReplaySegments(
  segments: PathSegment[],
  pathId: number,
): PathSegment[] {
  // The path's own segments come from the per-path index; only the ones
  // with time data can be replayed
  const replaySegments = segmentsForPathIds(segments, [pathId]).filter(
    (seg) => seg.time !== undefined && seg.time !== null,
  );

  // Sort by time
  return replaySegments.sort((a, b) => a.time! - b.time!);
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
  lookAhead: number = 5,
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
      return calculateBearing(
        coords[0][0],
        coords[0][1],
        coords[1][0],
        coords[1][1],
      );
    }
    return null;
  }

  // Calculate bearing from current position to future position
  if (!currentSeg.coords || !futureSeg.coords) {
    return null;
  }

  return calculateBearing(
    currentSeg.coords[1][0],
    currentSeg.coords[1][1],
    futureSeg.coords[0][0],
    futureSeg.coords[0][1],
  );
}
