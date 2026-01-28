import { describe, it, expect } from "vitest";
import {
  calculateAltitudeRange,
  calculateAirspeedRange,
  shouldRenderSegment,
  calculateSegmentProperties,
  formatAltitudeLegendLabels,
  formatAirspeedLegendLabels,
  filterSegmentsForRendering,
  groupSegmentsByPath,
  calculateLayerStats,
} from "../../../../kml_heatmap/frontend/features/layers";

describe("layers feature", () => {
  const mockSegments = [
    { path_id: 1, altitude_ft: 5000, groundspeed_knots: 120 },
    { path_id: 1, altitude_ft: 7000, groundspeed_knots: 130 },
    { path_id: 2, altitude_ft: 3000, groundspeed_knots: 100 },
    { path_id: 2, altitude_ft: 9000, groundspeed_knots: 150 },
  ];

  describe("calculateAltitudeRange", () => {
    it("calculates range from all segments", () => {
      const range = calculateAltitudeRange(mockSegments);

      expect(range.min).toBe(3000);
      expect(range.max).toBe(9000);
    });

    it("calculates range from selected paths only", () => {
      const selectedPathIds = new Set([1]);
      const range = calculateAltitudeRange(mockSegments, selectedPathIds);

      expect(range.min).toBe(5000);
      expect(range.max).toBe(7000);
    });

    it("returns default range for empty segments", () => {
      const range = calculateAltitudeRange([]);

      expect(range.min).toBe(0);
      expect(range.max).toBe(10000);
    });

    it("returns default range when no selected paths match", () => {
      const selectedPathIds = new Set([999]);
      const range = calculateAltitudeRange(mockSegments, selectedPathIds);

      expect(range.min).toBe(0);
      expect(range.max).toBe(10000);
    });

    it("handles single segment", () => {
      const segments = [{ path_id: 1, altitude_ft: 5000 }];
      const range = calculateAltitudeRange(segments);

      expect(range.min).toBe(5000);
      expect(range.max).toBe(5000);
    });
  });

  describe("calculateAirspeedRange", () => {
    it("calculates range from all segments", () => {
      const range = calculateAirspeedRange(mockSegments);

      expect(range.min).toBe(100);
      expect(range.max).toBe(150);
    });

    it("calculates range from selected paths only", () => {
      const selectedPathIds = new Set([1]);
      const range = calculateAirspeedRange(mockSegments, selectedPathIds);

      expect(range.min).toBe(120);
      expect(range.max).toBe(130);
    });

    it("returns default range for empty segments", () => {
      const range = calculateAirspeedRange([]);

      expect(range.min).toBe(0);
      expect(range.max).toBe(200);
    });

    it("filters out zero and negative speeds", () => {
      const segments = [
        { path_id: 1, groundspeed_knots: 0 },
        { path_id: 1, groundspeed_knots: -10 },
        { path_id: 1, groundspeed_knots: 100 },
        { path_id: 1, groundspeed_knots: 200 },
      ];
      const range = calculateAirspeedRange(segments);

      expect(range.min).toBe(100);
      expect(range.max).toBe(200);
    });

    it("handles segments without speed data", () => {
      const segments = [
        { path_id: 1, altitude_ft: 5000 },
        { path_id: 1, groundspeed_knots: undefined },
      ];
      const range = calculateAirspeedRange(segments);

      expect(range.min).toBe(0);
      expect(range.max).toBe(200);
    });
  });

  describe("shouldRenderSegment", () => {
    const segment = { path_id: 1 };
    const pathInfo = {
      id: 1,
      year: 2025,
      aircraft_registration: "D-EAGJ",
    };

    it("returns true with no filters", () => {
      expect(shouldRenderSegment(segment, pathInfo, {})).toBe(true);
    });

    it("filters by year correctly", () => {
      expect(shouldRenderSegment(segment, pathInfo, { year: "2025" })).toBe(
        true
      );
      expect(shouldRenderSegment(segment, pathInfo, { year: "2024" })).toBe(
        false
      );
    });

    it("filters by aircraft correctly", () => {
      expect(
        shouldRenderSegment(segment, pathInfo, { aircraft: "D-EAGJ" })
      ).toBe(true);
      expect(
        shouldRenderSegment(segment, pathInfo, { aircraft: "D-EXYZ" })
      ).toBe(false);
    });

    it("filters by both year and aircraft", () => {
      expect(
        shouldRenderSegment(segment, pathInfo, {
          year: "2025",
          aircraft: "D-EAGJ",
        })
      ).toBe(true);

      expect(
        shouldRenderSegment(segment, pathInfo, {
          year: "2024",
          aircraft: "D-EAGJ",
        })
      ).toBe(false);
    });

    it("handles missing pathInfo", () => {
      expect(shouldRenderSegment(segment, null, { year: "2025" })).toBe(false);
    });

    it("handles pathInfo without year", () => {
      const info = { id: 1, aircraft_registration: "D-EAGJ" };
      expect(shouldRenderSegment(segment, info, { year: "2025" })).toBe(false);
    });

    it("handles pathInfo without aircraft", () => {
      const info = { id: 1, year: 2025 };
      expect(shouldRenderSegment(segment, info, { aircraft: "D-EAGJ" })).toBe(
        false
      );
    });
  });

  describe("calculateSegmentProperties", () => {
    const colorFunc = (_val, _min, _max) => "#ff0000";

    it("calculates properties for selected segment", () => {
      const props = calculateSegmentProperties(
        {},
        {
          pathId: 1,
          selectedPathIds: new Set([1]),
          hasSelection: true,
          colorFunction: colorFunc,
          colorMin: 0,
          colorMax: 100,
          value: 50,
        }
      );

      expect(props.weight).toBe(6);
      expect(props.opacity).toBe(1.0);
      expect(props.isSelected).toBe(true);
    });

    it("calculates properties for non-selected segment with selection active", () => {
      const props = calculateSegmentProperties(
        {},
        {
          pathId: 2,
          selectedPathIds: new Set([1]),
          hasSelection: true,
        }
      );

      expect(props.weight).toBe(4);
      expect(props.opacity).toBe(0.1);
      expect(props.isSelected).toBe(false);
    });

    it("calculates properties with no selection", () => {
      const props = calculateSegmentProperties(
        {},
        {
          pathId: 1,
          selectedPathIds: new Set(),
          hasSelection: false,
        }
      );

      expect(props.weight).toBe(4);
      expect(props.opacity).toBe(0.85);
      expect(props.isSelected).toBe(false);
    });

    it("applies color function", () => {
      const props = calculateSegmentProperties(
        {},
        {
          pathId: 1,
          colorFunction: colorFunc,
          value: 50,
        }
      );

      expect(props.color).toBe("#ff0000");
    });

    it("uses default color when no color function provided", () => {
      const props = calculateSegmentProperties(
        {},
        {
          pathId: 1,
        }
      );

      expect(props.color).toBe("#3388ff");
    });
  });

  describe("formatAltitudeLegendLabels", () => {
    it("formats altitude labels", () => {
      const labels = formatAltitudeLegendLabels(1000, 15000);

      expect(labels.min).toBe("1000 ft");
      expect(labels.max).toBe("15000 ft");
    });

    it("rounds altitudes", () => {
      const labels = formatAltitudeLegendLabels(1234.5, 5678.9);

      expect(labels.min).toBe("1235 ft");
      expect(labels.max).toBe("5679 ft");
    });

    it("handles zero altitude", () => {
      const labels = formatAltitudeLegendLabels(0, 1000);

      expect(labels.min).toBe("0 ft");
    });
  });

  describe("formatAirspeedLegendLabels", () => {
    it("formats speed labels", () => {
      const labels = formatAirspeedLegendLabels(100, 200);

      expect(labels.min).toBe("100 kt");
      expect(labels.max).toBe("200 kt");
    });

    it("rounds speeds", () => {
      const labels = formatAirspeedLegendLabels(123.4, 234.6);

      expect(labels.min).toBe("123 kt");
      expect(labels.max).toBe("235 kt");
    });

    it("handles zero speed", () => {
      const labels = formatAirspeedLegendLabels(0, 100);

      expect(labels.min).toBe("0 kt");
    });
  });

  describe("filterSegmentsForRendering", () => {
    const segments = [{ path_id: 1 }, { path_id: 2 }, { path_id: 3 }];

    const pathInfo = [
      { id: 1, year: 2025, aircraft_registration: "D-EAGJ" },
      { id: 2, year: 2024, aircraft_registration: "D-EAGJ" },
      { id: 3, year: 2025, aircraft_registration: "D-EXYZ" },
    ];

    it("returns all segments with no filters", () => {
      const filtered = filterSegmentsForRendering(segments, pathInfo, {});

      expect(filtered).toHaveLength(3);
    });

    it("filters by year", () => {
      const filtered = filterSegmentsForRendering(segments, pathInfo, {
        year: "2025",
      });

      expect(filtered).toHaveLength(2);
      expect(filtered.map((s) => s.path_id)).toEqual([1, 3]);
    });

    it("filters by aircraft", () => {
      const filtered = filterSegmentsForRendering(segments, pathInfo, {
        aircraft: "D-EAGJ",
      });

      expect(filtered).toHaveLength(2);
      expect(filtered.map((s) => s.path_id)).toEqual([1, 2]);
    });

    it("filters by both criteria", () => {
      const filtered = filterSegmentsForRendering(segments, pathInfo, {
        year: "2025",
        aircraft: "D-EAGJ",
      });

      expect(filtered).toHaveLength(1);
      expect(filtered[0].path_id).toBe(1);
    });

    it("handles segments without matching pathInfo", () => {
      const segs = [{ path_id: 999 }];
      const filtered = filterSegmentsForRendering(segs, pathInfo, {});

      expect(filtered).toHaveLength(0);
    });
  });

  describe("groupSegmentsByPath", () => {
    it("groups segments by path ID", () => {
      const grouped = groupSegmentsByPath(mockSegments);

      expect(grouped.size).toBe(2);
      expect(grouped.get(1)).toHaveLength(2);
      expect(grouped.get(2)).toHaveLength(2);
    });

    it("handles empty array", () => {
      const grouped = groupSegmentsByPath([]);

      expect(grouped.size).toBe(0);
    });

    it("handles single path", () => {
      const segments = [{ path_id: 1 }, { path_id: 1 }, { path_id: 1 }];
      const grouped = groupSegmentsByPath(segments);

      expect(grouped.size).toBe(1);
      expect(grouped.get(1)).toHaveLength(3);
    });

    it("preserves segment order within path", () => {
      const segments = [
        { path_id: 1, order: 1 },
        { path_id: 1, order: 2 },
        { path_id: 1, order: 3 },
      ];
      const grouped = groupSegmentsByPath(segments);

      expect(grouped.get(1)[0].order).toBe(1);
      expect(grouped.get(1)[1].order).toBe(2);
      expect(grouped.get(1)[2].order).toBe(3);
    });
  });

  describe("calculateLayerStats", () => {
    it("calculates comprehensive layer statistics", () => {
      const stats = calculateLayerStats(mockSegments);

      expect(stats.totalSegments).toBe(4);
      expect(stats.uniquePaths).toBe(2);
      expect(stats.altitudeRange).toEqual({ min: 3000, max: 9000 });
      expect(stats.speedRange).toEqual({ min: 100, max: 150 });
    });

    it("handles empty segments", () => {
      const stats = calculateLayerStats([]);

      expect(stats.totalSegments).toBe(0);
      expect(stats.uniquePaths).toBe(0);
      expect(stats.altitudeRange).toEqual({ min: 0, max: 10000 });
      expect(stats.speedRange).toEqual({ min: 0, max: 200 });
    });

    it("handles single segment", () => {
      const segments = [
        { path_id: 1, altitude_ft: 5000, groundspeed_knots: 120 },
      ];
      const stats = calculateLayerStats(segments);

      expect(stats.totalSegments).toBe(1);
      expect(stats.uniquePaths).toBe(1);
      expect(stats.altitudeRange).toEqual({ min: 5000, max: 5000 });
      expect(stats.speedRange).toEqual({ min: 120, max: 120 });
    });
  });
});
