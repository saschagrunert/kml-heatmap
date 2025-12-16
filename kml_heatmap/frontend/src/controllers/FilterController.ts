/**
 * Filter controller for handling data filtering logic
 */

import type { FlightData, PathInfo, PathSegment } from "../types";
import { matchesFilters, hasNoActiveFilters } from "../utils/filters";

export interface FilterCriteria {
  year: string;
  aircraft: string;
  selectedPathIds: Set<string>;
}

export class FilterController {
  /**
   * Apply filters to flight data
   */
  applyFilters(data: FlightData, filters: FilterCriteria): FlightData {
    if (hasNoActiveFilters(filters)) {
      return data;
    }

    const filteredPathIds = this.getFilteredPathIds(data.path_info, filters);
    const filteredSegments = this.filterSegments(
      data.path_segments,
      filteredPathIds,
    );
    const filteredCoordinates = this.extractCoordinates(filteredSegments);

    return {
      ...data,
      coordinates: filteredCoordinates,
      path_segments: filteredSegments,
    };
  }

  /**
   * Get filtered path IDs based on criteria
   */
  private getFilteredPathIds(
    pathInfo: PathInfo[] | undefined,
    filters: FilterCriteria,
  ): Set<string> {
    const filteredPathIds = new Set<string>();

    pathInfo?.forEach((path) => {
      if (matchesFilters(path, filters)) {
        filteredPathIds.add(path.id);
      }
    });

    return filteredPathIds;
  }

  /**
   * Filter segments by path IDs
   */
  private filterSegments(
    segments: PathSegment[] | undefined,
    filteredPathIds: Set<string>,
  ): PathSegment[] | undefined {
    return segments?.filter((seg) => filteredPathIds.has(seg.path_id));
  }

  /**
   * Extract unique coordinates from segments
   */
  private extractCoordinates(
    segments: PathSegment[] | undefined,
  ): [number, number][] {
    const coordSet = new Set<string>();

    segments?.forEach((seg) => {
      if (seg.coords && seg.coords.length === 2) {
        coordSet.add(JSON.stringify([seg.coords[0].lat, seg.coords[0].lon]));
        coordSet.add(JSON.stringify([seg.coords[1].lat, seg.coords[1].lon]));
      }
    });

    return Array.from(coordSet).map((str) => JSON.parse(str));
  }
}
