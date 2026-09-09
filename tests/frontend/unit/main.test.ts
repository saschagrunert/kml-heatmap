import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Public API surface of the KMLHeatmap library bundle (window.KMLHeatmap).
 * Update this list deliberately when exports change.
 */
const PUBLIC_API = [
  "DataLoader",
  "aggregateAircraft",
  "calculateAirportFlightCounts",
  "calculateAirspeedRange",
  "calculateAircraftColorClass",
  "calculateAltitudeRange",
  "calculateAltitudeStats",
  "calculateAutoZoom",
  "calculateBearing",
  "calculateDistance",
  "calculateFilteredStatistics",
  "calculateFlightTime",
  "calculateLongestFlight",
  "calculateReplayProgress",
  "calculateSegmentProperties",
  "calculateSmoothedBearing",
  "calculateSpeedStats",
  "calculateTimeRange",
  "calculateTotalDistance",
  "calculateVisibleAirports",
  "calculateYearStats",
  "collectAirports",
  "combineYearData",
  "countCountries",
  "countryDisplayName",
  "countryFlag",
  "ddToDms",
  "encodeStateToUrl",
  "expandYearData",
  "filterPaths",
  "filterSegmentsByPaths",
  "findHomeBase",
  "findMax",
  "findMin",
  "findMinMax",
  "findNearestSegment",
  "findSegmentsAtTime",
  "formatAirspeedLegendLabels",
  "formatAltitude",
  "formatAltitudeLegendLabels",
  "formatDistance",
  "formatSpeed",
  "formatTime",
  "generateFunFacts",
  "getColorForAirspeed",
  "getColorForAltitude",
  "getDefaultState",
  "groupByCountry",
  "interpolatePosition",
  "mergeState",
  "parseUrlParams",
  "prepareReplaySegments",
  "selectDiverseFacts",
  "shouldRecenter",
  "shouldRenderSegment",
  "validateReplayData",
].sort();

describe("main module", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("exposes exactly the documented API surface", async () => {
    const main = await import("../../../kml_heatmap/frontend/main");

    expect(Object.keys(main).sort()).toEqual(PUBLIC_API);
    expect(Object.keys(window.KMLHeatmap).sort()).toEqual(PUBLIC_API);
  });

  it("sets window.KMLHeatmap with callable functions", async () => {
    const main = await import("../../../kml_heatmap/frontend/main");

    expect(window.KMLHeatmap.getColorForAltitude).toBe(
      main.getColorForAltitude,
    );
    expect(window.KMLHeatmap.getColorForAltitude(0, 0, 1)).toBe(
      "rgb(80,160,255)",
    );
    expect(window.KMLHeatmap.calculateDistance([0, 0], [0, 1])).toBeCloseTo(
      111.19,
      1,
    );
    expect(new window.KMLHeatmap.DataLoader().isCached("2025")).toBe(false);
  });
});
