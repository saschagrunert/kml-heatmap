/**
 * The heat cloud's band of heights: its text in a link, its stops, the
 * heights its heat fades in and out at, and how the control reads it out.
 */
import { describe, it, expect } from "vitest";
import {
  FULL_BAND,
  heightBandEdgesFt,
  heightBandLabel,
  heightBandText,
  heightStopLabel,
  OPEN_TOP,
  parseHeightBand,
  type HeightBand,
} from "../../../../kml_heatmap/frontend/calculations/heightBand";
import { HEIGHT_BAND_STOPS_FT } from "../../../../kml_heatmap/frontend/state/urlState";

/** The stop of `feet` */
const stop = (feet: number): number => HEIGHT_BAND_STOPS_FT.indexOf(feet);

/** GLSL's smoothstep */
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
}

/** The part of the heat at `feet` the cloud draws for `band`, as its shader */
function weight(band: HeightBand, feet: number): number {
  const [a, b, c, d] = heightBandEdgesFt(band);
  return smoothstep(a, b, feet) * (1 - smoothstep(c, d, feet));
}

describe("the heat cloud's band of heights", () => {
  it("stops closer together low down than up at a cruise, from the ground", () => {
    expect(HEIGHT_BAND_STOPS_FT[0]).toBe(0);
    const steps = HEIGHT_BAND_STOPS_FT.slice(1).map(
      (feet, i) => feet - HEIGHT_BAND_STOPS_FT[i]!,
    );
    expect(steps.every((step) => step > 0)).toBe(true);
    expect(steps[0]).toBeLessThan(steps[steps.length - 1]!);
    expect(OPEN_TOP).toBe(HEIGHT_BAND_STOPS_FT.length);
  });

  describe("its text", () => {
    it("reads the stops of the bottom and the top, the top left out for none", () => {
      expect(parseHeightBand("500-3000")).toEqual({
        low: stop(500),
        high: stop(3000),
      });
      expect(parseHeightBand("1000-")).toEqual({
        low: stop(1000),
        high: OPEN_TOP,
      });
      expect(parseHeightBand("0-1500")).toEqual({ low: 0, high: stop(1500) });
    });

    it("is every height where it is none of the control's bands", () => {
      for (const text of [
        "",
        "0-",
        "450-3000",
        "3000-500",
        "500-500",
        "500",
        "a-b",
        "-3000",
      ]) {
        expect(parseHeightBand(text), text).toEqual(FULL_BAND);
      }
    });

    it("writes every band as it reads it back, and nothing for every height", () => {
      expect(heightBandText(FULL_BAND)).toBe("");
      for (let low = 0; low < OPEN_TOP; low++) {
        for (let high = low + 1; high <= OPEN_TOP; high++) {
          const band = { low, high };
          const text = heightBandText(band);
          expect(parseHeightBand(text), text).toEqual(band);
        }
      }
      expect(heightBandText({ low: stop(500), high: stop(3000) })).toBe(
        "500-3000",
      );
      expect(heightBandText({ low: stop(1000), high: OPEN_TOP })).toBe("1000-");
    });
  });

  describe("its edges", () => {
    it("draw all the heat of every height, the ground's included", () => {
      for (const feet of [0, 1, 500, 10000, 40000]) {
        expect(weight(FULL_BAND, feet), `${feet} ft`).toBe(1);
      }
    });

    it("draw the heat inside the band whole and none well outside it", () => {
      const band = { low: stop(500), high: stop(3000) };
      for (const feet of [500, 1000, 3000]) {
        expect(weight(band, feet), `${feet} ft`).toBe(1);
      }
      for (const feet of [0, 100, 400, 3500, 8000]) {
        expect(weight(band, feet), `${feet} ft`).toBe(0);
      }
    });

    it("fade the heat out softly just past each edge, wider for a higher edge", () => {
      const band = { low: stop(500), high: stop(3000) };
      const [fadeIn, bottom, top, fadeOut] = heightBandEdgesFt(band);
      expect(bottom).toBe(500);
      expect(top).toBe(3000);
      expect(bottom - fadeIn).toBeGreaterThan(0);
      expect(fadeOut - top).toBeGreaterThan(bottom - fadeIn);
      const below = weight(band, (fadeIn + bottom) / 2);
      const above = weight(band, (top + fadeOut) / 2);
      expect(below).toBeCloseTo(0.5);
      expect(above).toBeCloseTo(0.5);
      // Softly: no step anywhere across the fade
      for (let feet = fadeIn; feet < bottom; feet += 5) {
        expect(weight(band, feet + 5) - weight(band, feet)).toBeLessThan(0.1);
      }
    });

    it("fade over some height even at the lowest edge", () => {
      const [fadeIn, bottom] = heightBandEdgesFt({ low: stop(100), high: 5 });
      expect(bottom - fadeIn).toBeGreaterThanOrEqual(50);
    });

    it("keep the ground and everything above in a band from the ground or without a top", () => {
      expect(weight({ low: 0, high: stop(1000) }, 0)).toBe(1);
      expect(weight({ low: stop(5000), high: OPEN_TOP }, 30000)).toBe(1);
    });
  });

  describe("its labels", () => {
    it("say the band in feet", () => {
      expect(heightBandLabel(FULL_BAND)).toBe("All heights");
      expect(heightBandLabel({ low: 0, high: stop(1500) })).toBe(
        "Up to 1,500 ft",
      );
      expect(heightBandLabel({ low: stop(2000), high: OPEN_TOP })).toBe(
        "Above 2,000 ft",
      );
      expect(heightBandLabel({ low: stop(500), high: stop(10000) })).toBe(
        "500 to 10,000 ft",
      );
    });

    it("say the height of each thumb, and no limit past the last stop", () => {
      expect(heightStopLabel(0)).toBe("0 ft");
      expect(heightStopLabel(stop(1500))).toBe("1,500 ft");
      expect(heightStopLabel(OPEN_TOP)).toBe("No limit");
    });
  });
});
