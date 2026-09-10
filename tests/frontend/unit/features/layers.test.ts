import { describe, it, expect } from "vitest";
import {
  calculateAltitudeRange,
  calculateAirspeedRange,
  calculateSegmentProperties,
  formatAltitudeLabel,
  formatAirspeedLabel,
  formatAltitudeLegendLabels,
  formatAirspeedLegendLabels,
  findNearestSegment,
  DEFAULT_ALTITUDE_RANGE,
  DEFAULT_AIRSPEED_RANGE,
} from "../../../../kml_heatmap/frontend/features/layers";
import type { PathSegment } from "../../../../kml_heatmap/frontend/types";

describe("layers feature", () => {
  const mockSegments: PathSegment[] = [
    { path_id: 1, altitude_ft: 5000, groundspeed_knots: 120 },
    { path_id: 1, altitude_ft: 7000, groundspeed_knots: 130 },
    { path_id: 2, altitude_ft: 3000, groundspeed_knots: 100 },
    { path_id: 2, altitude_ft: 9000, groundspeed_knots: 150 },
  ];

  describe("calculateAltitudeRange", () => {
    it("calculates range from all segments", () => {
      expect(calculateAltitudeRange(mockSegments)).toEqual({
        min: 3000,
        max: 9000,
      });
    });

    it("calculates range from selected paths only", () => {
      expect(calculateAltitudeRange(mockSegments, new Set([1]))).toEqual({
        min: 5000,
        max: 7000,
      });
    });

    it("returns default range for empty segments", () => {
      expect(calculateAltitudeRange([])).toEqual(DEFAULT_ALTITUDE_RANGE);
    });

    it("returns the given fallback when no selected paths match", () => {
      expect(
        calculateAltitudeRange(mockSegments, new Set([999]), {
          min: 1,
          max: 2,
        }),
      ).toEqual({ min: 1, max: 2 });
    });

    it("ignores segments without altitude", () => {
      expect(
        calculateAltitudeRange([
          { path_id: 1 },
          { path_id: 1, altitude_ft: 42 },
        ]),
      ).toEqual({ min: 42, max: 42 });
    });

    it("clamps the lower bound of the colour scale at 0 for negative altitudes", () => {
      expect(
        calculateAltitudeRange([
          { path_id: 1, altitude_ft: -420 },
          { path_id: 1, altitude_ft: 3000 },
        ]),
      ).toEqual({ min: 0, max: 3000 });
      expect(
        calculateAltitudeRange([
          { path_id: 1, altitude_ft: -420 },
          { path_id: 1, altitude_ft: -100 },
        ]),
      ).toEqual({ min: 0, max: 0 });
    });
  });

  describe("calculateAltitudeRange with exact path ranges", () => {
    it("widens the rounded segment range to the exact per-path values", () => {
      // Segments carry 100 ft steps; path_info carries what was measured
      const range = calculateAltitudeRange(
        [{ path_id: 1, altitude_ft: 10400 }],
        null,
        { min: 0, max: 10000 },
        [{ id: 1, min_altitude_ft: 343.7, max_altitude_ft: 10419.2 }],
      );
      expect(range.max).toBe(10419.2);
      expect(range.min).toBe(343.7);
    });

    it("only considers the selected paths", () => {
      const range = calculateAltitudeRange(
        [
          { path_id: 1, altitude_ft: 3000 },
          { path_id: 2, altitude_ft: 9000 },
        ],
        new Set([1]),
        { min: 0, max: 10000 },
        [
          { id: 1, max_altitude_ft: 3050 },
          { id: 2, max_altitude_ft: 20000 },
        ],
      );
      expect(range.max).toBe(3050);
    });

    it("only lets paths that are in the range widen it", () => {
      // Path 2 has an exact altitude far above anything drawn, but none of
      // its segments are in the set, so it must not stretch the legend
      const range = calculateAltitudeRange(
        [{ path_id: 1, altitude_ft: 3000 }],
        null,
        { min: 0, max: 10000 },
        [
          { id: 1, max_altitude_ft: 3050 },
          { id: 2, max_altitude_ft: 41000 },
        ],
      );
      expect(range.max).toBe(3050);
    });

    it("returns the fallback untouched when no segment matches", () => {
      // Widening the fallback with real altitudes would report a range that
      // is half invented: a real minimum against a made-up maximum
      const fallback = { min: 0, max: 10000 };
      const range = calculateAltitudeRange([], null, fallback, [
        { id: 1, min_altitude_ft: 500, max_altitude_ft: 900 },
      ]);
      expect(range).toEqual(fallback);
    });
  });

  describe("calculateAirspeedRange", () => {
    it("calculates range from all segments", () => {
      expect(calculateAirspeedRange(mockSegments)).toEqual({
        min: 100,
        max: 150,
      });
    });

    it("calculates range from selected paths only", () => {
      expect(calculateAirspeedRange(mockSegments, new Set([2]))).toEqual({
        min: 100,
        max: 150,
      });
    });

    it("returns default range for empty segments", () => {
      expect(calculateAirspeedRange([])).toEqual(DEFAULT_AIRSPEED_RANGE);
    });

    it("filters out zero, negative and missing speeds", () => {
      const segments: PathSegment[] = [
        { path_id: 1, groundspeed_knots: 0 },
        { path_id: 1, groundspeed_knots: -5 },
        { path_id: 1 },
        { path_id: 1, groundspeed_knots: 80 },
      ];
      expect(calculateAirspeedRange(segments)).toEqual({ min: 80, max: 80 });
    });
  });

  describe("calculateSegmentProperties", () => {
    const colorFunction = (value: number, min: number, max: number): string =>
      `rgb(${value},${min},${max})`;

    it("styles a selected segment", () => {
      expect(
        calculateSegmentProperties({
          pathId: 1,
          selectedPathIds: new Set([1]),
          colorFunction,
          colorMin: 0,
          colorMax: 10,
          value: 5,
        }),
      ).toEqual({
        weight: 6,
        opacity: 1.0,
        color: "rgb(5,0,10)",
        isSelected: true,
      });
    });

    it("dims an unselected segment while a selection exists", () => {
      const props = calculateSegmentProperties({
        pathId: 2,
        selectedPathIds: new Set([1]),
      });
      expect(props.weight).toBe(4);
      expect(props.opacity).toBe(0.1);
      expect(props.isSelected).toBe(false);
    });

    it("uses normal styling without a selection", () => {
      const props = calculateSegmentProperties({ pathId: 1 });
      expect(props).toEqual({
        weight: 4,
        opacity: 0.85,
        color: "#3388ff",
        isSelected: false,
      });
    });

    it("draws selected paths at normal weight in isolate mode", () => {
      const props = calculateSegmentProperties({
        pathId: 1,
        selectedPathIds: new Set([1]),
        isolateSelection: true,
      });
      expect(props.weight).toBe(4);
      expect(props.opacity).toBe(0.85);
      expect(props.isSelected).toBe(true);
    });
  });

  describe("legend labels", () => {
    it("formats altitude with meters", () => {
      expect(formatAltitudeLabel(1000)).toBe("1,000 ft (305 m)");
      expect(formatAltitudeLabel(1234.6)).toBe("1,235 ft (376 m)");
      expect(formatAltitudeLabel(0)).toBe("0 ft (0 m)");
    });

    it("formats airspeed with km/h", () => {
      expect(formatAirspeedLabel(100)).toBe("100 kt (185 km/h)");
      expect(formatAirspeedLabel(123.4)).toBe("123 kt (229 km/h)");
      expect(formatAirspeedLabel(0)).toBe("0 kt (0 km/h)");
    });

    it("builds min/max label pairs", () => {
      expect(formatAltitudeLegendLabels(0, 5000)).toEqual({
        min: "0 ft (0 m)",
        max: "5,000 ft (1,524 m)",
      });
      expect(formatAirspeedLegendLabels(0, 200)).toEqual({
        min: "0 kt (0 km/h)",
        max: "200 kt (370 km/h)",
      });
    });
  });

  describe("findNearestSegment", () => {
    const segments: PathSegment[] = [
      {
        path_id: 1,
        coords: [
          [50.0, 8.0],
          [50.1, 8.0],
        ],
      },
      {
        path_id: 1,
        coords: [
          [50.1, 8.0],
          [50.2, 8.0],
        ],
      },
      { path_id: 1 },
      {
        path_id: 1,
        coords: [
          [50.2, 8.0],
          [50.2, 8.5],
        ],
      },
    ];

    it("returns the segment closest to the point", () => {
      expect(findNearestSegment(segments, 50.05, 8.01)).toBe(segments[0]);
      expect(findNearestSegment(segments, 50.15, 8.01)).toBe(segments[1]);
      expect(findNearestSegment(segments, 50.21, 8.3)).toBe(segments[3]);
    });

    it("measures distance to the segment, not only its end points", () => {
      // Point exactly beside the middle of the last (east-west) segment
      expect(findNearestSegment(segments, 50.19, 8.25)).toBe(segments[3]);
    });

    it("skips segments without coords and returns undefined for an empty list", () => {
      expect(findNearestSegment([{ path_id: 1 }], 50, 8)).toBeUndefined();
      expect(findNearestSegment([], 50, 8)).toBeUndefined();
    });

    it("handles zero-length segments", () => {
      const point: PathSegment = {
        path_id: 1,
        coords: [
          [50.0, 8.0],
          [50.0, 8.0],
        ],
      };
      expect(findNearestSegment([point], 50.0, 8.0)).toBe(point);
    });
  });
});
