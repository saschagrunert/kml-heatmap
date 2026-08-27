/**
 * Layer rendering helpers
 * Pure functions for calculating layer properties
 */

import type { PathInfo, PathSegment } from "../types";
import type { Range } from "../state/store";

/**
 * Segment rendering properties
 */
export interface SegmentProperties {
  weight: number;
  opacity: number;
  color: string;
  isSelected: boolean;
}

/**
 * Legend labels
 */
export interface LegendLabels {
  min: string;
  max: string;
}

/**
 * Layer statistics
 */
export interface LayerStats {
  totalSegments: number;
  uniquePaths: number;
  altitudeRange: Range;
  speedRange: Range;
}

function calculateRange(
  segments: PathSegment[],
  getValue: (seg: PathSegment) => number | undefined,
  filterValue: (v: number) => boolean,
  defaultRange: Range,
  selectedPathIds: Set<number> | null = null
): Range {
  let segmentsToUse = segments;
  if (selectedPathIds && selectedPathIds.size > 0) {
    segmentsToUse = segments.filter((seg) => selectedPathIds.has(seg.path_id));
  }
  if (segmentsToUse.length === 0) return defaultRange;

  const values = segmentsToUse
    .map(getValue)
    .filter((v): v is number => v !== undefined && filterValue(v));

  if (values.length === 0) return defaultRange;

  let min = values[0] ?? 0;
  let max = values[0] ?? 0;
  for (let i = 1; i < values.length; i++) {
    const v = values[i] ?? 0;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max };
}

export function calculateAltitudeRange(
  segments: PathSegment[],
  selectedPathIds: Set<number> | null = null
): Range {
  return calculateRange(
    segments,
    (s) => s.altitude_ft,
    () => true,
    { min: 0, max: 10000 },
    selectedPathIds
  );
}

export function calculateAirspeedRange(
  segments: PathSegment[],
  selectedPathIds: Set<number> | null = null
): Range {
  return calculateRange(
    segments,
    (s) => s.groundspeed_knots,
    (v) => v > 0,
    { min: 0, max: 200 },
    selectedPathIds
  );
}

/**
 * Determine if a segment should be rendered based on filters
 * @param segment - Segment object
 * @param pathInfo - Path info object
 * @param filters - Filter object {year, aircraft}
 * @returns True if segment should be rendered
 */
export function shouldRenderSegment(
  _segment: PathSegment,
  pathInfo: PathInfo | undefined,
  filters: { year?: string; aircraft?: string } = {}
): boolean {
  const { year = "all", aircraft = "all" } = filters;

  // Filter by year
  if (year !== "all") {
    if (!pathInfo || !pathInfo.year || pathInfo.year.toString() !== year) {
      return false;
    }
  }

  // Filter by aircraft
  if (aircraft !== "all") {
    if (!pathInfo || pathInfo.aircraft_registration !== aircraft) {
      return false;
    }
  }

  return true;
}

/**
 * Calculate segment rendering properties
 * @param _segment - Segment object
 * @param options - Rendering options
 * @returns Rendering properties {weight, opacity, color}
 */
export function calculateSegmentProperties(
  _segment: PathSegment,
  options: {
    pathId: number;
    selectedPathIds?: Set<number>;
    hasSelection?: boolean;
    colorFunction?: (value: number, min: number, max: number) => string;
    colorMin?: number;
    colorMax?: number;
    value?: number; // altitude_ft or groundspeed_knots
  } = { pathId: 0 }
): SegmentProperties {
  const {
    pathId,
    selectedPathIds = new Set(),
    hasSelection = false,
    colorFunction,
    colorMin = 0,
    colorMax = 0,
    value = 0,
  } = options;

  const isSelected = selectedPathIds.has(pathId);

  return {
    weight: isSelected ? 6 : 4,
    opacity: isSelected ? 1.0 : hasSelection ? 0.1 : 0.85,
    color: colorFunction ? colorFunction(value, colorMin, colorMax) : "#3388ff",
    isSelected,
  };
}

/**
 * Format legend labels for altitude
 * @param min - Minimum altitude in feet
 * @param max - Maximum altitude in feet
 * @returns Formatted labels
 */
export function formatAltitudeLegendLabels(
  min: number,
  max: number
): LegendLabels {
  return {
    min: Math.round(min) + " ft",
    max: Math.round(max) + " ft",
  };
}

/**
 * Format legend labels for airspeed
 * @param min - Minimum speed in knots
 * @param max - Maximum speed in knots
 * @returns Formatted labels
 */
export function formatAirspeedLegendLabels(
  min: number,
  max: number
): LegendLabels {
  return {
    min: Math.round(min) + " kt",
    max: Math.round(max) + " kt",
  };
}

/**
 * Filter segments by criteria
 * @param segments - All segments
 * @param pathInfo - All path info
 * @param filters - Filter criteria
 * @returns Filtered segments
 */
export function filterSegmentsForRendering(
  segments: PathSegment[],
  pathInfo: PathInfo[],
  filters: { year?: string; aircraft?: string } = {}
): PathSegment[] {
  const pathInfoMap = new Map(pathInfo.map((p) => [p.id, p]));

  return segments.filter((segment) => {
    const info = pathInfoMap.get(segment.path_id);
    // If no pathInfo found for this segment, don't render it
    if (!info) return false;
    return shouldRenderSegment(segment, info, filters);
  });
}

/**
 * Group segments by path ID
 * @param segments - Array of segments
 * @returns Map of path_id to array of segments
 */
export function groupSegmentsByPath(
  segments: PathSegment[]
): Map<number, PathSegment[]> {
  const grouped = new Map<number, PathSegment[]>();

  segments.forEach((segment) => {
    const pathId = segment.path_id;
    if (!grouped.has(pathId)) {
      grouped.set(pathId, []);
    }
    grouped.get(pathId)!.push(segment);
  });

  return grouped;
}

/**
 * Calculate layer statistics
 * @param segments - Segments being rendered
 * @returns Layer statistics
 */
export function calculateLayerStats(segments: PathSegment[]): LayerStats {
  return {
    totalSegments: segments.length,
    uniquePaths: new Set(segments.map((s) => s.path_id)).size,
    altitudeRange: calculateAltitudeRange(segments),
    speedRange: calculateAirspeedRange(segments),
  };
}
