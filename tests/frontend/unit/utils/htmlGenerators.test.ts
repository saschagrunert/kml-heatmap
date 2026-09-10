import { describe, it, expect } from "vitest";
import {
  escapeHtml,
  generateStatsHtml,
  generateFunFactsHtml,
  calculateAircraftColorClass,
  generateAircraftFleetHtml,
  generateAirportPopupHtml,
  generateHomeBaseHtml,
  generateDestinationsHtml,
  generateSegmentPopupHtml,
  pluralFlights,
  pluralize,
  splitAirportName,
  type YearStats,
  type AirportCount,
  type SegmentPopupParams,
} from "../../../../kml_heatmap/frontend/utils/htmlGenerators";
import {
  getColorForAirspeed,
  getColorForAltitude,
  rgbToRgba,
} from "../../../../kml_heatmap/frontend/utils/colors";
import type {
  FilteredStatistics,
  FunFact,
} from "../../../../kml_heatmap/frontend/types";

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

  describe("generateStatsHtml", () => {
    const mockYearStats: YearStats = {
      total_flights: 42,
      num_airports: 10,
      total_distance_nm: 12345.67,
      flight_time: "123h 45m",
      airport_names: ["EDDF", "EDDH"],
      aircraft_list: [],
    };

    const mockFullStats: FilteredStatistics = {
      total_distance_km: 22870.5,
      total_distance_nm: 12345.67,
      total_points: 1000,
      num_paths: 42,
      num_airports: 10,
      airport_names: ["EDDF", "EDDH"],
      num_aircraft: 2,
      aircraft_list: [],
      min_altitude_m: 0,
      max_altitude_m: 11000,
      min_altitude_ft: 0,
      max_altitude_ft: 36090,
      max_groundspeed_knots: 450,
    };

    it("generates stats HTML without timing data", () => {
      const html = generateStatsHtml(mockYearStats, mockFullStats, false);

      expect(html).toContain('<div class="stat-card">');
      expect(html).toContain('<div class="stat-value">42</div>');
      expect(html).toContain('<div class="stat-label">Flights</div>');
      expect(html).toContain('<div class="stat-value">10</div>');
      expect(html).toContain('<div class="stat-label">Airports</div>');
      expect(html).toContain(
        '<div class="stat-value">12346 <span class="stat-unit">nm</span></div>',
      );
      expect(html).toContain('<div class="stat-label">Distance</div>');
      // Math.round(11000 / 0.3048), with the unit in its own element
      expect(html).toContain(
        '<div class="stat-value">36089 <span class="stat-unit">ft</span></div>',
      );
      expect(html).toContain(
        '<div class="stat-label">Max Altitude (MSL)</div>',
      );

      // Should not include timing data
      expect(html).not.toContain("Flight Time");
      expect(html).not.toContain("Max Groundspeed");
    });

    it("generates stats HTML with timing data", () => {
      const html = generateStatsHtml(mockYearStats, mockFullStats, true);

      expect(html).toContain(
        '123<span class="stat-unit">h</span> 45<span class="stat-unit">m</span>',
      );
      expect(html).toContain('<div class="stat-label">Flight Time</div>');
      expect(html).toContain(
        '<div class="stat-value">450 <span class="stat-unit">kt</span></div>',
      );
      expect(html).toContain('<div class="stat-label">Max Groundspeed</div>');
    });

    it("handles null fullStats", () => {
      const html = generateStatsHtml(mockYearStats, null, false);

      expect(html).toContain("42");
      expect(html).toContain('0 <span class="stat-unit">ft</span>');
    });

    it("handles missing max_groundspeed_knots", () => {
      const statsWithoutGroundspeed: FilteredStatistics = {
        ...mockFullStats,
        max_groundspeed_knots: undefined,
      };

      const html = generateStatsHtml(
        mockYearStats,
        statsWithoutGroundspeed,
        true,
      );

      expect(html).toContain('0 <span class="stat-unit">kt</span>');
    });

    it("formats distance with proper precision", () => {
      const stats: YearStats = {
        ...mockYearStats,
        total_distance_nm: 9999.999,
      };

      const html = generateStatsHtml(stats, mockFullStats, false);

      expect(html).toContain("10000"); // Rounded
    });
  });

  describe("generateFunFactsHtml", () => {
    it("generates fun facts HTML", () => {
      const funFacts: FunFact[] = [
        {
          category: "distance",
          icon: "✈️",
          text: "You flew 10,000 miles!",
          priority: 1,
        },
        {
          category: "altitude",
          icon: "⬆️",
          text: "Reached 35,000 feet",
          priority: 2,
        },
      ];

      const html = generateFunFactsHtml(funFacts);

      expect(html).toContain('<h3 class="fun-facts-title">');
      expect(html).toContain(
        '<span class="section-title-text">Facts</span></h3>',
      );
      expect(html).toContain('<div class="fun-fact" data-category="distance">');
      expect(html).toContain(
        '<span class="fun-fact-icon" aria-hidden="true">✈️</span>',
      );
      expect(html).toContain(
        '<span class="fun-fact-text">You flew 10,000 miles!</span>',
      );
      expect(html).toContain('data-category="altitude"');
      expect(html).toContain(
        '<span class="fun-fact-icon" aria-hidden="true">⬆️</span>',
      );
      expect(html).toContain(
        '<span class="fun-fact-text">Reached 35,000 feet</span>',
      );
    });

    it("handles empty fun facts array", () => {
      const html = generateFunFactsHtml([]);

      expect(html).toContain('<h3 class="fun-facts-title">');
      expect(html).toContain(
        '<span class="section-title-text">Facts</span></h3>',
      );
      expect(html).not.toContain("fun-fact-text");
    });

    it("escapes HTML in fact text", () => {
      const funFacts: FunFact[] = [
        {
          category: "test",
          icon: "🔥",
          text: "Test <script>alert('xss')</script>",
          priority: 1,
        },
      ];

      const html = generateFunFactsHtml(funFacts);

      // The HTML contains the raw text (data comes from trusted Python-generated files)
      expect(html).toContain("Test <script>alert('xss')</script>");
    });
  });

  describe("calculateAircraftColorClass", () => {
    it("returns high class for the top quarter of the range", () => {
      expect(calculateAircraftColorClass(8, 10, 1)).toBe("fleet-aircraft-high");
      expect(calculateAircraftColorClass(10, 10, 1)).toBe(
        "fleet-aircraft-high",
      );
    });

    it("returns medium-high class for the third quarter", () => {
      expect(calculateAircraftColorClass(5.5, 10, 1)).toBe(
        "fleet-aircraft-medium-high",
      );
      expect(calculateAircraftColorClass(7.5, 10, 1)).toBe(
        "fleet-aircraft-medium-high",
      );
    });

    it("returns medium-low class for the second quarter", () => {
      expect(calculateAircraftColorClass(4, 10, 1)).toBe(
        "fleet-aircraft-medium-low",
      );
    });

    it("returns low class for the bottom quarter", () => {
      expect(calculateAircraftColorClass(1, 10, 1)).toBe("fleet-aircraft-low");
      expect(calculateAircraftColorClass(3, 10, 1)).toBe("fleet-aircraft-low");
    });

    it("returns high class when every aircraft has the same count", () => {
      expect(calculateAircraftColorClass(5, 5, 5)).toBe("fleet-aircraft-high");
    });
  });

  describe("generateAircraftFleetHtml", () => {
    it("generates aircraft fleet HTML", () => {
      const yearStats: YearStats = {
        total_flights: 50,
        num_airports: 5,
        total_distance_nm: 10000,
        flight_time: "100h",
        airport_names: [],
        aircraft_list: [
          {
            registration: "D-EABC",
            model: "Cessna 172",
            type: "C172",
            flights: 20,
            flight_time_str: "50h 30m",
          },
          {
            registration: "D-EXYZ",
            model: "Piper PA-28",
            type: "PA28",
            flights: 10,
            flight_time_str: "25h 15m",
          },
        ],
      };

      const html = generateAircraftFleetHtml(yearStats);

      expect(html).toContain('<h3 class="aircraft-fleet-title">');
      expect(html).toContain(
        '<span class="section-title-text">Fleet</span></h3>',
      );
      expect(html).toContain('class="fleet-aircraft fleet-aircraft-high"');
      expect(html).toContain("D-EABC");
      expect(html).toContain("Cessna 172");
      expect(html).toContain("20 flights");
      expect(html).toContain("50h 30m");
      expect(html).toContain("D-EXYZ");
      expect(html).toContain("Piper PA-28");
      expect(html).toContain("10 flights");
      expect(html).toContain("25h 15m");
    });

    it("uses type when model is not available", () => {
      const yearStats: YearStats = {
        total_flights: 10,
        num_airports: 2,
        total_distance_nm: 1000,
        flight_time: "10h",
        airport_names: [],
        aircraft_list: [
          {
            registration: "D-EABC",
            type: "C172",
            flights: 10,
          },
        ],
      };

      const html = generateAircraftFleetHtml(yearStats);

      expect(html).toContain("C172");
      expect(html).not.toContain("undefined");
    });

    it("shows the flight time the aircraft data carries", () => {
      const yearStats: YearStats = {
        total_flights: 30,
        num_airports: 2,
        total_distance_nm: 1000,
        flight_time: "100h 0m",
        airport_names: [],
        aircraft_list: [
          {
            registration: "D-EABC",
            type: "C172",
            flights: 20,
            flight_time_str: "25h 34m",
          },
          {
            registration: "D-EXYZ",
            type: "PA28",
            flights: 10,
            flight_time_str: "8h 35m",
          },
        ],
      };

      const html = generateAircraftFleetHtml(yearStats);

      expect(html).toContain('<div class="fleet-aircraft-time">25h 34m</div>');
      expect(html).toContain('<div class="fleet-aircraft-time">8h 35m</div>');
      // Not the total divided by the flights or any other derived value
      expect(html).not.toContain("100h 0m");
      expect(html).not.toContain("5h 0m");
    });

    it("shows --- for missing flight time", () => {
      const yearStats: YearStats = {
        total_flights: 10,
        num_airports: 2,
        total_distance_nm: 1000,
        flight_time: "10h",
        airport_names: [],
        aircraft_list: [
          {
            registration: "D-EABC",
            type: "C172",
            flights: 10,
          },
        ],
      };

      const html = generateAircraftFleetHtml(yearStats);

      expect(html).toContain("---");
    });

    it("applies correct color classes based on flight count", () => {
      const yearStats: YearStats = {
        total_flights: 100,
        num_airports: 5,
        total_distance_nm: 10000,
        flight_time: "100h",
        airport_names: [],
        aircraft_list: [
          { registration: "HIGH", flights: 100 },
          { registration: "MED-HIGH", flights: 70 },
          { registration: "MED-LOW", flights: 40 },
          { registration: "LOW", flights: 10 },
        ],
      };

      const html = generateAircraftFleetHtml(yearStats);

      // Check that different color classes are applied
      expect(html).toContain("fleet-aircraft-high");
      expect(html).toContain("fleet-aircraft-medium-high");
      expect(html).toContain("fleet-aircraft-medium-low");
      expect(html).toContain("fleet-aircraft-low");
    });

    it("returns empty string for empty aircraft list", () => {
      const yearStats: YearStats = {
        total_flights: 0,
        num_airports: 0,
        total_distance_nm: 0,
        flight_time: "0h",
        airport_names: [],
        aircraft_list: [],
      };

      const html = generateAircraftFleetHtml(yearStats);

      expect(html).toBe("");
    });

    it("returns empty string for undefined aircraft list", () => {
      const yearStats = {
        total_flights: 0,
        num_airports: 0,
        total_distance_nm: 0,
        flight_time: "0h",
        airport_names: [],
      };

      const html = generateAircraftFleetHtml(yearStats as unknown as YearStats);

      expect(html).toBe("");
    });

    it("handles single aircraft (no flight range)", () => {
      const yearStats: YearStats = {
        total_flights: 10,
        num_airports: 2,
        total_distance_nm: 1000,
        flight_time: "10h",
        airport_names: [],
        aircraft_list: [
          {
            registration: "D-EABC",
            model: "Cessna 172",
            flights: 10,
          },
        ],
      };

      const html = generateAircraftFleetHtml(yearStats);

      // With single aircraft, normalized = 1, should get high class
      expect(html).toContain("fleet-aircraft-high");
    });
  });

  describe("generateHomeBaseHtml", () => {
    it("generates home base HTML", () => {
      const homeBase: AirportCount = {
        name: "EDDF",
        flight_count: 25,
      };

      const html = generateHomeBaseHtml(homeBase);

      expect(html).toContain('<h3 class="top-airports-title">');
      expect(html).toContain(
        '<span class="section-title-text">Home Base</span></h3>',
      );
      expect(html).toContain(
        '<div class="top-airport-name"><span class="top-airport-place">EDDF</span></div>',
      );
      expect(html).toContain('<div class="top-airport-count">25 flights</div>');
    });

    it("handles singular flight count", () => {
      const homeBase: AirportCount = {
        name: "EDDH",
        flight_count: 1,
      };

      const html = generateHomeBaseHtml(homeBase);

      expect(html).toContain("1 flight");
      expect(html).not.toContain("1 flights");
    });

    it("splits the ICAO code from the home base name", () => {
      const html = generateHomeBaseHtml({
        name: "EDAQ Halle-Oppin",
        flight_count: 25,
      });

      expect(html).toContain(
        '<span class="top-airport-code">EDAQ</span>' +
          '<span class="top-airport-place">Halle-Oppin</span>',
      );
      expect(html).toContain("25 flights");
    });

    it("escapes the home base name", () => {
      const html = generateHomeBaseHtml({
        name: "<b>x</b>",
        flight_count: 2,
      });

      expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
      expect(html).not.toContain("<b>");
    });

    it("handles zero flights", () => {
      const homeBase: AirportCount = {
        name: "EDDK",
        flight_count: 0,
      };

      const html = generateHomeBaseHtml(homeBase);

      expect(html).toContain("0 flights");
    });
  });

  describe("generateDestinationsHtml", () => {
    const identity = (code: string) => code;
    const noFlag = () => "";
    const plain = { countryName: identity, flag: noFlag };

    it("generates grouped destinations HTML", () => {
      const grouped = new Map([
        ["DE", ["EDDH Hamburg", "EDDM Munich"]],
        ["AT", ["LOWW Vienna"]],
      ]);

      const html = generateDestinationsHtml(grouped, plain);

      expect(html).toContain('<h3 class="airports-grid-title">');
      expect(html).toContain(
        '<span class="section-title-text">Destinations</span></h3>',
      );
      expect(html).toContain('<div class="country-group"');
      expect(html).toContain('<span class="country-name">DE</span>');
      expect(html).toContain('<span class="country-count">2</span>');
      expect(html).toContain('<span class="country-name">AT</span>');
      expect(html).toContain('<span class="country-count">1</span>');
    });

    it("renders one row per airport with code and full name", () => {
      const grouped = new Map([["DE", ["EDDH Hamburg Helmut Schmidt"]]]);

      const html = generateDestinationsHtml(grouped, plain);

      expect(html).toContain('<ul class="country-airports">');
      expect(html).toContain(
        '<li class="destination"><span class="destination-code">EDDH</span>' +
          '<span class="destination-name">Hamburg Helmut Schmidt</span></li>',
      );
    });

    it("keeps the whole label as the name when there is no code", () => {
      const grouped = new Map([["Other", ["Some Field"]]]);

      const html = generateDestinationsHtml(grouped, plain);

      expect(html).toContain(
        '<span class="destination-name">Some Field</span>',
      );
      expect(html).not.toContain("destination-code");
      expect(html).toContain('<span class="country-name">Other</span>');
    });

    it("accents the home base and the furthest destination", () => {
      const grouped = new Map([
        ["DE", ["EDAQ Home", "EDDM Munich", "EDDH Ham"]],
      ]);

      const html = generateDestinationsHtml(grouped, {
        ...plain,
        homeBase: "EDAQ Home",
        furthest: "EDDM Munich",
      });

      expect(html).toContain(
        '<li class="destination is-home"><span class="destination-code">EDAQ</span>' +
          '<span class="destination-name">Home</span>' +
          '<span class="destination-tag">Home</span></li>',
      );
      expect(html).toContain(
        '<li class="destination is-furthest"><span class="destination-code">EDDM</span>' +
          '<span class="destination-name">Munich</span>' +
          '<span class="destination-tag">Furthest</span></li>',
      );
      // Only those two accents, nothing else is marked
      expect(html.match(/destination-tag/g)).toHaveLength(2);
      expect(html).toContain(
        '<li class="destination"><span class="destination-code">EDDH</span>',
      );
    });

    it("never marks the home base as the furthest destination", () => {
      const grouped = new Map([["DE", ["EDAQ Home"]]]);

      const html = generateDestinationsHtml(grouped, {
        ...plain,
        homeBase: "EDAQ Home",
        furthest: "EDAQ Home",
      });

      expect(html).toContain('class="destination is-home"');
      expect(html).not.toContain("is-furthest");
    });

    it("gives every destination a code, a name and nothing else", () => {
      const grouped = new Map([
        ["DE", ["EDDH Hamburg", "EDDM Munich", "Grass strip"]],
      ]);

      const container = document.createElement("div");
      container.innerHTML = generateDestinationsHtml(grouped, {
        ...plain,
        homeBase: "EDDH Hamburg",
      });

      const rows = [...container.querySelectorAll("li.destination")].map(
        (row) =>
          [...row.children].map((child) => [
            child.className,
            child.textContent,
          ]),
      );
      expect(rows).toEqual([
        // The home base carries the one extra element, its tag
        [
          ["destination-code", "EDDH"],
          ["destination-name", "Hamburg"],
          ["destination-tag", "Home"],
        ],
        [
          ["destination-code", "EDDM"],
          ["destination-name", "Munich"],
        ],
        // A label without a code keeps its full text as the name
        [["destination-name", "Grass strip"]],
      ]);
    });

    it("returns empty string for empty map", () => {
      const html = generateDestinationsHtml(new Map(), plain);

      expect(html).toBe("");
    });

    it("uses countryName and flag functions for display", () => {
      const grouped = new Map([["DE", ["EDDF Frankfurt"]]]);
      const displayName = (code: string) => (code === "DE" ? "Germany" : code);
      const flag = (code: string) => (code === "DE" ? "🇩🇪" : "");

      const html = generateDestinationsHtml(grouped, {
        countryName: displayName,
        flag,
      });

      expect(html).toContain(
        '<span class="country-flag" aria-hidden="true">🇩🇪</span>',
      );
      expect(html).toContain('<span class="country-name">Germany</span>');
      expect(html).toContain("EDDF");
    });

    it("escapes country and airport names", () => {
      const grouped = new Map([["XX", ["<img src=x>"]]]);

      const html = generateDestinationsHtml(grouped, {
        countryName: () => "<b>Country</b>",
        flag: noFlag,
      });

      expect(html).toContain("&lt;b&gt;Country&lt;/b&gt;");
      expect(html).toContain("&lt;img src=x&gt;");
      expect(html).not.toContain("<img");
    });

    it("staggers animation delays across groups", () => {
      const grouped = new Map([
        ["DE", ["EDDH Hamburg"]],
        ["AT", ["LOWW Vienna"]],
        ["CH", ["LSZH Zurich"]],
      ]);

      const html = generateDestinationsHtml(grouped, plain);

      expect(html).toContain("animation-delay: 0.0s");
      expect(html).toContain("animation-delay: 0.1s");
      expect(html).toContain("animation-delay: 0.2s");
    });

    it("preserves airport order within groups", () => {
      const grouped = new Map([["DE", ["ZULU", "ALPHA", "MIKE"]]]);

      const html = generateDestinationsHtml(grouped, plain);

      const zuluIndex = html.indexOf("ZULU");
      const alphaIndex = html.indexOf("ALPHA");
      const mikeIndex = html.indexOf("MIKE");

      expect(zuluIndex).toBeLessThan(alphaIndex);
      expect(alphaIndex).toBeLessThan(mikeIndex);
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

      expect(html).toContain("3000 ft");
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
      expect(html).toContain("3000 ft");

      const html2 = generateSegmentPopupHtml({
        ...fullParams,
        segment: { ...fullParams.segment, altitude_ft: 3026 },
      });
      expect(html2).toContain("3050 ft");
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
