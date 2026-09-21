/**
 * Replay functionality helpers
 * Pure functions for flight replay calculations
 */

import { calculateBearing } from "../utils/geometry";
import { segmentsForPathIds } from "../calculations/statistics";
import type { Coordinate } from "../utils/geometry";
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
    (seg) => seg.time !== undefined,
  );

  // Sort by time
  return replaySegments.sort((a, b) => a.time! - b.time!);
}

/**
 * Bearing from one point to another, or null when the two are the same
 * point: atan2(0, 0) is 0, which would turn the aircraft to north.
 */
function bearingBetween(from: Coordinate, to: Coordinate): number | null {
  if (from[0] === to[0] && from[1] === to[1]) return null;
  return calculateBearing(from[0], from[1], to[0], to[1]);
}

/**
 * Calculate smoothed bearing from multiple future segments
 * @param segments - All segments
 * @param currentIdx - Current segment index
 * @param lookAhead - Number of segments to look ahead
 * @returns Bearing in degrees, or null when there is no direction to take
 *   (the caller keeps the previous heading then)
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
  if (!currentSeg.coords || !futureSeg.coords) {
    return null;
  }

  // From the start of the current segment to the end of the future one, so
  // the span always covers at least the current segment. Measured from the
  // current segment's end, the segment right before the last one looked
  // ahead to the start of the last, which is the very same point.
  return bearingBetween(currentSeg.coords[0], futureSeg.coords[1]);
}
