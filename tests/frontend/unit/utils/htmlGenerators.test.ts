import { describe, it, expect } from "vitest";
import {
  escapeHtml,
  generateAirportPopupHtml,
  generateSegmentPopupHtml,
  pluralFlights,
  pluralize,
  splitAirportName,
  type SegmentPopupParams,
} from "../../../../kml_heatmap/frontend/utils/htmlGenerators";
import {
  getColorForAirspeed,
  getColorForAltitude,
  rgbToRgba,
} from "../../../../kml_heatmap/frontend/utils/colors";

describe("htmlGenerators", () => {
  describe("escapeHtml", () => {
    it("escapes ampersands", () => {
      expect(escapeHtml("A&B")).toBe("A&amp;B");
    });

    it("escapes angle brackets", () => {
      expect(escapeHtml("<div>")).toBe("&lt;div&gt;");
    });

    it("escapes double quotes", () => {
      expect(escapeHtml('a"b')).toBe("a&quot;b");
    });

    it("escapes single quotes", () => {
      expect(escapeHtml("a'b")).toBe("a&#39;b");
    });

    it("escapes all entities in a single string", () => {
      expect(escapeHtml(`<img src="x" onerror='alert(1)'>&`)).toBe(
        "&lt;img src=&quot;x&quot; onerror=&#39;alert(1)&#39;&gt;&amp;",
      );
    });

    it("returns strings without special characters unchanged", () => {
      expect(escapeHtml("Cessna 172")).toBe("Cessna 172");
    });

    it("handles empty string", () => {
      expect(escapeHtml("")).toBe("");
    });
  });

  describe("splitAirportName", () => {
    it("splits an ICAO code from the airport name", () => {
      expect(splitAirportName("EDAQ Halle-Oppin")).toEqual({
        code: "EDAQ",
        name: "Halle-Oppin",
      });
    });

    it("keeps multi-word names intact", () => {
      expect(splitAirportName("LFGA Colmar Houssen airport")).toEqual({
        code: "LFGA",
        name: "Colmar Houssen airport",
      });
    });

    it("keeps the whole label when there is no code", () => {
      expect(splitAirportName("Halle Oppin")).toEqual({
        code: "",
        name: "Halle Oppin",
      });
      expect(splitAirportName("EDAQ")).toEqual({ code: "", name: "EDAQ" });
      expect(splitAirportName("")).toEqual({ code: "", name: "" });
    });
  });

  describe("pluralize", () => {
    it("uses the singular for one", () => {
      expect(pluralize(1, "data point")).toBe("1 data point");
    });

    it("uses the plural otherwise", () => {
      expect(pluralize(0, "data point")).toBe("0 data points");
      expect(pluralize(2, "selected path")).toBe("2 selected paths");
    });

    it("takes an irregular plural", () => {
      expect(pluralize(1, "country", "countries")).toBe("1 country");
      expect(pluralize(3, "country", "countries")).toBe("3 countries");
    });
  });

  describe("pluralFlights", () => {
    it("uses the singular for one flight", () => {
      expect(pluralFlights(1)).toBe("1 flight");
    });

    it("uses the plural otherwise", () => {
      expect(pluralFlights(0)).toBe("0 flights");
      expect(pluralFlights(12)).toBe("12 flights");
    });
  });

  describe("generateAirportPopupHtml", () => {
    const params = {
      name: "Frankfurt EDDF",
      lat: 50.1,
      lon: 8.67,
      latDms: "50°6'0.0\"N",
      lonDms: "8°40'12.0\"E",
      flightCount: 20,
      isHomeBase: false,
    };

    it("renders name, coordinates link and flight count with classes only", () => {
      const html = generateAirportPopupHtml(params);

      expect(html).toContain('class="popup-container kh-popup-airport"');
      expect(html).toContain('class="popup-header kh-popup-header-airport"');
      expect(html).toContain("Frankfurt EDDF");
      expect(html).toContain('href="https://www.google.com/maps?q=50.1,8.67"');
      expect(html).toContain('class="airport-popup-link kh-popup-link"');
      expect(html).toContain(params.latDms);
      expect(html).toContain('class="kh-popup-metric-label">Total Flights');
      expect(html).toContain('class="popup-metric-value kh-popup-accent">20');
      expect(html).not.toContain("style=");
      expect(html).not.toContain("HOME");
    });

    it("renders the home badge for the home base", () => {
      const html = generateAirportPopupHtml({ ...params, isHomeBase: true });
      expect(html).toContain('<span class="kh-popup-home-badge">HOME</span>');
    });

    it("escapes the name and falls back to Unknown", () => {
      expect(generateAirportPopupHtml({ ...params, name: "<b>" })).toContain(
        "&lt;b&gt;",
      );
      expect(generateAirportPopupHtml({ ...params, name: "" })).toContain(
        "Unknown",
      );
    });
  });

  describe("generateSegmentPopupHtml", () => {
    const fullParams: SegmentPopupParams = {
      segment: {
        path_id: 1,
        altitude_ft: 3000,
        groundspeed_knots: 120,
        coords: [
          [48.0, 11.0],
          [49.0, 12.0],
        ],
      },
      altMin: 0,
      altMax: 5000,
      speedMin: 0,
      speedMax: 200,
    };

    it("renders altitude and groundspeed with colour custom properties", () => {
      const html = generateSegmentPopupHtml(fullParams);

      expect(html).toContain("3,000 ft");
      expect(html).toContain("(914 m)");
      expect(html).toContain("120 kt");
      expect(html).toContain("222 km/h");
      expect(html).toContain("Altitude (MSL)");
      expect(html).toContain("Groundspeed");

      const altColor = getColorForAltitude(3000, 0, 5000);
      const speedColor = getColorForAirspeed(120, 0, 200);
      expect(html).toContain(
        `class="popup-metric kh-popup-metric-colored" style="--kh-metric-color: ${altColor}; --kh-metric-bg: ${rgbToRgba(altColor, 0.15)};"`,
      );
      expect(html).toContain(
        `class="popup-metric kh-popup-metric-colored" style="--kh-metric-color: ${speedColor}; --kh-metric-bg: ${rgbToRgba(speedColor, 0.15)};"`,
      );
      // No other inline styles
      expect(html.match(/style="/g)).toHaveLength(2);
      expect(html).toContain('class="popup-header kh-popup-header-segment"');
    });

    it("rounds altitude to 50 ft steps", () => {
      const html = generateSegmentPopupHtml({
        ...fullParams,
        segment: { ...fullParams.segment, altitude_ft: 3024 },
      });
      expect(html).toContain("3,000 ft");

      const html2 = generateSegmentPopupHtml({
        ...fullParams,
        segment: { ...fullParams.segment, altitude_ft: 3026 },
      });
      expect(html2).toContain("3,050 ft");
    });

    it("uses default title and icon", () => {
      const html = generateSegmentPopupHtml(fullParams);

      expect(html).toContain("Segment Data");
      expect(html).toContain("📍");
    });

    it("uses custom title and icon when provided", () => {
      const html = generateSegmentPopupHtml({
        ...fullParams,
        title: "Current Position",
        icon: "✈️",
      });

      expect(html).toContain("Current Position");
      expect(html).toContain("✈️");
      expect(html).not.toContain("Segment Data");
      expect(html).not.toContain("📍");
    });

    it("defaults altitude and groundspeed to 0 when missing", () => {
      const html = generateSegmentPopupHtml({
        ...fullParams,
        segment: { path_id: 1, coords: fullParams.segment.coords },
      });

      expect(html).toContain("0 ft");
      expect(html).toContain("(0 m)");
      expect(html).toContain("0 kt");
      expect(html).toContain("0 km/h");
      expect(html).toContain(
        `--kh-metric-color: ${getColorForAltitude(0, 0, 5000)}`,
      );
    });

    it("computes track from segment coordinates", () => {
      const html = generateSegmentPopupHtml(fullParams);

      expect(html).toContain('<span class="kh-popup-track">Track: 033°</span>');
      expect(html).not.toContain("N/A");
    });

    it("shows N/A for track and position when coords are missing", () => {
      const html = generateSegmentPopupHtml({
        ...fullParams,
        segment: { path_id: 1 },
      });

      expect(html).toContain("Track: N/A");
      expect(html).toMatch(/N\/A N\/A/);
    });

    it("formats the end position in DMS", () => {
      const html = generateSegmentPopupHtml(fullParams);

      expect(html).toContain("49°0'0.0\"N 12°0'0.0\"E");
    });
  });
});
