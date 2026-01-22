import { describe, it, expect } from "vitest";
import {
  parseUrlParams,
  encodeStateToUrl,
  getDefaultState,
  mergeState,
} from "../../../../kml_heatmap/frontend/state/urlState";

describe("URL state management", () => {
  describe("parseUrlParams", () => {
    it("returns null for empty params", () => {
      expect(parseUrlParams("")).toBeNull();
      expect(parseUrlParams(new URLSearchParams())).toBeNull();
    });

    it("parses year parameter", () => {
      const result = parseUrlParams("y=2025");
      expect(result).toEqual({ selectedYear: "2025" });
    });

    it('parses "all" year parameter', () => {
      const result = parseUrlParams("y=all");
      expect(result).toEqual({ selectedYear: "all" });
    });

    it("parses aircraft parameter", () => {
      const result = parseUrlParams("a=D-EAGJ");
      expect(result).toEqual({ selectedAircraft: "D-EAGJ" });
    });

    it("parses single path ID", () => {
      const result = parseUrlParams("p=5");
      expect(result).toEqual({ selectedPathIds: [5] });
    });

    it("parses multiple path IDs", () => {
      const result = parseUrlParams("p=1,5,12,25");
      expect(result).toEqual({ selectedPathIds: [1, 5, 12, 25] });
    });

    it("filters out invalid path IDs", () => {
      const result = parseUrlParams("p=1,invalid,5,NaN,12");
      expect(result).toEqual({
        selectedPathIds: [1, 5, 12],
      });
    });

    it("parses visibility flags (6-char legacy format)", () => {
      const result = parseUrlParams("v=101010");
      expect(result).toEqual({
        heatmapVisible: true,
        altitudeVisible: false,
        airspeedVisible: true,
        airportsVisible: false,
        aviationVisible: true,
        statsPanelVisible: false,
      });
    });

    it("parses visibility flags (7-char format with wrapped)", () => {
      const result = parseUrlParams("v=1010101");
      expect(result).toEqual({
        heatmapVisible: true,
        altitudeVisible: false,
        airspeedVisible: true,
        airportsVisible: false,
        aviationVisible: true,
        statsPanelVisible: false,
        wrappedVisible: true,
      });
    });

    it("parses visibility flags (8-char format with wrapped and buttonsHidden)", () => {
      const result = parseUrlParams("v=10101011");
      expect(result).toEqual({
        heatmapVisible: true,
        altitudeVisible: false,
        airspeedVisible: true,
        airportsVisible: false,
        aviationVisible: true,
        statsPanelVisible: false,
        wrappedVisible: true,
        buttonsHidden: true,
      });
    });

    it("ignores visibility string with wrong length", () => {
      const result = parseUrlParams("v=101");
      expect(result).toEqual({});
    });

    it("parses map center", () => {
      const result = parseUrlParams("lat=51.5&lng=13.4");
      expect(result).toEqual({
        center: { lat: 51.5, lng: 13.4 },
      });
    });

    it("validates latitude range", () => {
      const valid = parseUrlParams("lat=45.5&lng=10.0");
      expect(valid.center).toEqual({ lat: 45.5, lng: 10.0 });

      const tooHigh = parseUrlParams("lat=91&lng=10");
      expect(tooHigh.center).toBeUndefined();

      const tooLow = parseUrlParams("lat=-91&lng=10");
      expect(tooLow.center).toBeUndefined();
    });

    it("validates longitude range", () => {
      const valid = parseUrlParams("lat=45&lng=170");
      expect(valid.center).toEqual({ lat: 45, lng: 170 });

      const tooHigh = parseUrlParams("lat=45&lng=181");
      expect(tooHigh.center).toBeUndefined();

      const tooLow = parseUrlParams("lat=45&lng=-181");
      expect(tooLow.center).toBeUndefined();
    });

    it("requires both lat and lng for center", () => {
      const onlyLat = parseUrlParams("lat=45");
      expect(onlyLat.center).toBeUndefined();

      const onlyLng = parseUrlParams("lng=10");
      expect(onlyLng.center).toBeUndefined();
    });

    it("parses zoom level", () => {
      const result = parseUrlParams("z=12.5");
      expect(result).toEqual({ zoom: 12.5 });
    });

    it("clamps zoom to 1-18 range", () => {
      expect(parseUrlParams("z=0.5").zoom).toBe(1);
      expect(parseUrlParams("z=20").zoom).toBe(18);
      expect(parseUrlParams("z=10").zoom).toBe(10);
    });

    it("parses complete state", () => {
      const url = "y=2025&a=D-EAGJ&p=1,5,12&v=010101&lat=51.5&lng=13.4&z=10.5";
      const result = parseUrlParams(url);

      expect(result).toEqual({
        selectedYear: "2025",
        selectedAircraft: "D-EAGJ",
        selectedPathIds: [1, 5, 12],
        heatmapVisible: false,
        altitudeVisible: true,
        airspeedVisible: false,
        airportsVisible: true,
        aviationVisible: false,
        statsPanelVisible: true,
        center: { lat: 51.5, lng: 13.4 },
        zoom: 10.5,
      });
    });

    it("accepts URLSearchParams object", () => {
      const params = new URLSearchParams("y=2025&a=D-EAGJ");
      const result = parseUrlParams(params);
      expect(result).toEqual({
        selectedYear: "2025",
        selectedAircraft: "D-EAGJ",
      });
    });
  });

  describe("encodeStateToUrl", () => {
    it("encodes year parameter", () => {
      const url = encodeStateToUrl({ selectedYear: "2025" });
      expect(url).toBe("y=2025");
    });

    it('encodes "all" year', () => {
      const url = encodeStateToUrl({ selectedYear: "all" });
      expect(url).toBe("y=all");
    });

    it("encodes aircraft parameter", () => {
      const url = encodeStateToUrl({
        selectedYear: "all",
        selectedAircraft: "D-EAGJ",
      });
      expect(url).toContain("a=D-EAGJ");
    });

    it('omits aircraft if "all"', () => {
      const url = encodeStateToUrl({
        selectedYear: "2025",
        selectedAircraft: "all",
      });
      expect(url).not.toContain("a=");
    });

    it("encodes path IDs", () => {
      const url = encodeStateToUrl({
        selectedYear: "all",
        selectedPathIds: [1, 5, 12],
      });
      expect(url).toContain("p=1%2C5%2C12"); // %2C is comma
    });

    it("omits empty path IDs", () => {
      const url = encodeStateToUrl({
        selectedYear: "all",
        selectedPathIds: [],
      });
      expect(url).not.toContain("p=");
    });

    it("encodes visibility flags", () => {
      const url = encodeStateToUrl({
        heatmapVisible: true,
        altitudeVisible: false,
        airspeedVisible: true,
        airportsVisible: false,
        aviationVisible: true,
        statsPanelVisible: false,
      });
      expect(url).toContain("v=101010");
    });

    it("omits default visibility (10010000)", () => {
      const url = encodeStateToUrl({
        heatmapVisible: true,
        altitudeVisible: false,
        airspeedVisible: false,
        airportsVisible: true,
        aviationVisible: false,
        statsPanelVisible: false,
        wrappedVisible: false,
        buttonsHidden: false,
      });
      expect(url).not.toContain("v=");
    });

    it("encodes wrappedVisible flag", () => {
      const url = encodeStateToUrl({
        heatmapVisible: true,
        altitudeVisible: false,
        airspeedVisible: false,
        airportsVisible: true,
        aviationVisible: false,
        statsPanelVisible: false,
        wrappedVisible: true,
        buttonsHidden: false,
      });
      expect(url).toContain("v=10010010");
    });

    it("encodes buttonsHidden flag", () => {
      const url = encodeStateToUrl({
        heatmapVisible: true,
        altitudeVisible: false,
        airspeedVisible: false,
        airportsVisible: true,
        aviationVisible: false,
        statsPanelVisible: false,
        wrappedVisible: false,
        buttonsHidden: true,
      });
      expect(url).toContain("v=10010001");
    });

    it("encodes map center with 6 decimal places", () => {
      const url = encodeStateToUrl({
        center: { lat: 51.507351, lng: -0.127758 },
      });
      expect(url).toContain("lat=51.507351");
      expect(url).toContain("lng=-0.127758");
    });

    it("encodes zoom with 2 decimal places", () => {
      const url = encodeStateToUrl({
        zoom: 12.567,
      });
      expect(url).toContain("z=12.57");
    });

    it("encodes complete state", () => {
      const state = {
        selectedYear: "2025",
        selectedAircraft: "D-EAGJ",
        selectedPathIds: [1, 5],
        heatmapVisible: false,
        altitudeVisible: true,
        airspeedVisible: false,
        airportsVisible: true,
        aviationVisible: false,
        statsPanelVisible: true,
        wrappedVisible: false,
        buttonsHidden: false,
        center: { lat: 51.5, lng: 13.4 },
        zoom: 10.5,
      };

      const url = encodeStateToUrl(state);
      const params = new URLSearchParams(url);

      expect(params.get("y")).toBe("2025");
      expect(params.get("a")).toBe("D-EAGJ");
      expect(params.get("p")).toBe("1,5");
      expect(params.get("v")).toBe("01010100");
      expect(params.get("lat")).toBe("51.500000");
      expect(params.get("lng")).toBe("13.400000");
      expect(params.get("z")).toBe("10.50");
    });

    it("handles partial state", () => {
      const url = encodeStateToUrl({
        selectedYear: "2025",
      });
      expect(url).toBe("y=2025");
    });
  });

  describe("parseUrlParams and encodeStateToUrl round-trip", () => {
    it("maintains state through encode/decode cycle", () => {
      const original = {
        selectedYear: "2025",
        selectedAircraft: "D-EAGJ",
        selectedPathIds: [1, 5, 12],
        heatmapVisible: false,
        altitudeVisible: true,
        airspeedVisible: false,
        airportsVisible: true,
        aviationVisible: false,
        statsPanelVisible: true,
        center: { lat: 51.5, lng: 13.4 },
        zoom: 10.5,
      };

      const encoded = encodeStateToUrl(original);
      const decoded = parseUrlParams(encoded);

      expect(decoded.selectedYear).toBe(original.selectedYear);
      expect(decoded.selectedAircraft).toBe(original.selectedAircraft);
      expect(decoded.selectedPathIds).toEqual(original.selectedPathIds);
      expect(decoded.heatmapVisible).toBe(original.heatmapVisible);
      expect(decoded.altitudeVisible).toBe(original.altitudeVisible);
      expect(decoded.center.lat).toBeCloseTo(original.center.lat, 6);
      expect(decoded.center.lng).toBeCloseTo(original.center.lng, 6);
      expect(decoded.zoom).toBeCloseTo(original.zoom, 2);
    });
  });

  describe("getDefaultState", () => {
    it("returns default state object", () => {
      const defaults = getDefaultState();

      expect(defaults).toEqual({
        selectedYear: "all",
        selectedAircraft: "all",
        selectedPathIds: [],
        heatmapVisible: true,
        altitudeVisible: false,
        airspeedVisible: false,
        airportsVisible: true,
        aviationVisible: false,
        statsPanelVisible: false,
        wrappedVisible: false,
        buttonsHidden: false,
      });
    });

    it("returns new object each time", () => {
      const defaults1 = getDefaultState();
      const defaults2 = getDefaultState();

      expect(defaults1).not.toBe(defaults2);
      expect(defaults1).toEqual(defaults2);
    });
  });

  describe("mergeState", () => {
    it("returns default state when URL state is null", () => {
      const defaults = getDefaultState();
      const merged = mergeState(defaults, null);

      expect(merged).toEqual(defaults);
      expect(merged).not.toBe(defaults); // Should be a copy
    });

    it("merges URL state over defaults", () => {
      const defaults = getDefaultState();
      const urlState = {
        selectedYear: "2025",
        heatmapVisible: false,
      };

      const merged = mergeState(defaults, urlState);

      expect(merged.selectedYear).toBe("2025");
      expect(merged.heatmapVisible).toBe(false);
      expect(merged.selectedAircraft).toBe("all"); // From defaults
      expect(merged.airportsVisible).toBe(true); // From defaults
    });

    it("URL state takes priority over defaults", () => {
      const defaults = {
        selectedYear: "all",
        selectedAircraft: "all",
        heatmapVisible: true,
      };

      const urlState = {
        selectedYear: "2025",
        heatmapVisible: false,
      };

      const merged = mergeState(defaults, urlState);

      expect(merged.selectedYear).toBe("2025");
      expect(merged.heatmapVisible).toBe(false);
    });

    it("handles empty URL state object", () => {
      const defaults = getDefaultState();
      const merged = mergeState(defaults, {});

      expect(merged).toEqual(defaults);
    });
  });
});
