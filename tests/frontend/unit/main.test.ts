import { describe, it, expect, vi, beforeEach } from "vitest";

describe("main module", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("assigns KMLHeatmap API to window", async () => {
    const main = await import("../../../kml_heatmap/frontend/main");

    expect(main.getColorForAltitude).toBeDefined();
    expect(main.getColorForAirspeed).toBeDefined();
    expect(main.calculateDistance).toBeDefined();
    expect(main.calculateBearing).toBeDefined();
    expect(main.formatTime).toBeDefined();
    expect(main.formatDistance).toBeDefined();
    expect(main.formatAltitude).toBeDefined();
    expect(main.formatSpeed).toBeDefined();
    expect(main.DataLoader).toBeDefined();
  });

  it("re-exports all expected calculation utilities", async () => {
    const main = await import("../../../kml_heatmap/frontend/main");

    expect(main.filterPaths).toBeDefined();
    expect(main.calculateFilteredStatistics).toBeDefined();
    expect(main.calculateAltitudeRange).toBeDefined();
    expect(main.calculateAirspeedRange).toBeDefined();
  });

  it("re-exports all expected feature utilities", async () => {
    const main = await import("../../../kml_heatmap/frontend/main");

    expect(main.countCountries).toBeDefined();
    expect(main.findHomeBase).toBeDefined();
    expect(main.prepareReplaySegments).toBeDefined();
    expect(main.calculateYearStats).toBeDefined();
    expect(main.generateFunFacts).toBeDefined();
  });

  it("sets window.KMLHeatmap when window is available", async () => {
    await import("../../../kml_heatmap/frontend/main");

    expect(window.KMLHeatmap).toBeDefined();
    expect(typeof window.KMLHeatmap.getColorForAltitude).toBe("function");
    expect(typeof window.KMLHeatmap.getColorForAirspeed).toBe("function");
  });
});
