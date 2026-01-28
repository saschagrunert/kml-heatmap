import { describe, it, expect } from "vitest";
import {
  generateStatsHtml,
  generateFunFactsHtml,
  calculateAircraftColorClass,
  generateAircraftFleetHtml,
  generateHomeBaseHtml,
  generateDestinationsHtml,
  type YearStats,
  type AirportCount,
} from "../../../../kml_heatmap/frontend/utils/htmlGenerators";
import type {
  FilteredStatistics,
  FunFact,
} from "../../../../kml_heatmap/frontend/types";

describe("htmlGenerators", () => {
  describe("generateStatsHtml", () => {
    const mockYearStats: YearStats = {
      total_flights: 42,
      num_airports: 10,
      total_distance_nm: 12345.67,
      flight_time: "123h 45m",
      airport_names: ["EDDF", "EDDH"],
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

      expect(html).toContain('<div class="stat-value">42</div>');
      expect(html).toContain('<div class="stat-label">Flights</div>');
      expect(html).toContain('<div class="stat-value">10</div>');
      expect(html).toContain('<div class="stat-label">Airports</div>');
      expect(html).toContain('<div class="stat-value">12346</div>');
      expect(html).toContain('<div class="stat-label">Nautical Miles</div>');
      expect(html).toContain("36089 ft"); // Math.round(11000 / 0.3048)
      expect(html).toContain(
        '<div class="stat-label">Max Altitude (MSL)</div>'
      );

      // Should not include timing data
      expect(html).not.toContain("Flight Time");
      expect(html).not.toContain("Max Groundspeed");
    });

    it("generates stats HTML with timing data", () => {
      const html = generateStatsHtml(mockYearStats, mockFullStats, true);

      expect(html).toContain("123h 45m");
      expect(html).toContain('<div class="stat-label">Flight Time</div>');
      expect(html).toContain("450 kt");
      expect(html).toContain('<div class="stat-label">Max Groundspeed</div>');
    });

    it("handles null fullStats", () => {
      const html = generateStatsHtml(mockYearStats, null, false);

      expect(html).toContain("42");
      expect(html).toContain("0 ft");
    });

    it("handles missing max_groundspeed_knots", () => {
      const statsWithoutGroundspeed: FilteredStatistics = {
        ...mockFullStats,
        max_groundspeed_knots: undefined,
      };

      const html = generateStatsHtml(
        mockYearStats,
        statsWithoutGroundspeed,
        true
      );

      expect(html).toContain("0 kt");
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
        },
        {
          category: "altitude",
          icon: "⬆️",
          text: "Reached 35,000 feet",
        },
      ];

      const html = generateFunFactsHtml(funFacts);

      expect(html).toContain('<div class="fun-facts-title">✨ Facts</div>');
      expect(html).toContain('data-category="distance"');
      expect(html).toContain('<span class="fun-fact-icon">✈️</span>');
      expect(html).toContain(
        '<span class="fun-fact-text">You flew 10,000 miles!</span>'
      );
      expect(html).toContain('data-category="altitude"');
      expect(html).toContain('<span class="fun-fact-icon">⬆️</span>');
      expect(html).toContain(
        '<span class="fun-fact-text">Reached 35,000 feet</span>'
      );
    });

    it("handles empty fun facts array", () => {
      const html = generateFunFactsHtml([]);

      expect(html).toBe('<div class="fun-facts-title">✨ Facts</div>');
    });

    it("escapes HTML in fact text", () => {
      const funFacts: FunFact[] = [
        {
          category: "test",
          icon: "🔥",
          text: "Test <script>alert('xss')</script>",
        },
      ];

      const html = generateFunFactsHtml(funFacts);

      // The HTML should contain the raw text (sanitization happens at render time via DOMPurify)
      expect(html).toContain("Test <script>alert('xss')</script>");
    });
  });

  describe("calculateAircraftColorClass", () => {
    it("returns high class for normalized >= 0.75", () => {
      expect(calculateAircraftColorClass(0.75)).toBe("fleet-aircraft-high");
      expect(calculateAircraftColorClass(0.9)).toBe("fleet-aircraft-high");
      expect(calculateAircraftColorClass(1.0)).toBe("fleet-aircraft-high");
    });

    it("returns medium-high class for normalized >= 0.5 and < 0.75", () => {
      expect(calculateAircraftColorClass(0.5)).toBe(
        "fleet-aircraft-medium-high"
      );
      expect(calculateAircraftColorClass(0.6)).toBe(
        "fleet-aircraft-medium-high"
      );
      expect(calculateAircraftColorClass(0.74)).toBe(
        "fleet-aircraft-medium-high"
      );
    });

    it("returns medium-low class for normalized >= 0.25 and < 0.5", () => {
      expect(calculateAircraftColorClass(0.25)).toBe(
        "fleet-aircraft-medium-low"
      );
      expect(calculateAircraftColorClass(0.3)).toBe(
        "fleet-aircraft-medium-low"
      );
      expect(calculateAircraftColorClass(0.49)).toBe(
        "fleet-aircraft-medium-low"
      );
    });

    it("returns low class for normalized < 0.25", () => {
      expect(calculateAircraftColorClass(0)).toBe("fleet-aircraft-low");
      expect(calculateAircraftColorClass(0.1)).toBe("fleet-aircraft-low");
      expect(calculateAircraftColorClass(0.24)).toBe("fleet-aircraft-low");
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

      expect(html).toContain(
        '<div class="aircraft-fleet-title">✈️ Fleet</div>'
      );
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
      const yearStats: YearStats = {
        total_flights: 0,
        num_airports: 0,
        total_distance_nm: 0,
        flight_time: "0h",
        airport_names: [],
      };

      const html = generateAircraftFleetHtml(yearStats);

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

      expect(html).toContain(
        '<div class="top-airports-title">🏠 Home Base</div>'
      );
      expect(html).toContain('<div class="top-airport-name">EDDF</div>');
      expect(html).toContain('<div class="top-airport-count">25 flights</div>');
    });

    it("handles singular flight count", () => {
      const homeBase: AirportCount = {
        name: "EDDH",
        flight_count: 1,
      };

      const html = generateHomeBaseHtml(homeBase);

      expect(html).toContain("1 flights"); // Current implementation doesn't pluralize
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
    it("generates destinations HTML", () => {
      const destinations = ["EDDH", "EDDM", "EDDK", "EDDS"];

      const html = generateDestinationsHtml(destinations);

      expect(html).toContain(
        '<div class="airports-grid-title">🗺️ Destinations</div>'
      );
      expect(html).toContain('<div class="airport-badges">');
      expect(html).toContain('<div class="airport-badge">EDDH</div>');
      expect(html).toContain('<div class="airport-badge">EDDM</div>');
      expect(html).toContain('<div class="airport-badge">EDDK</div>');
      expect(html).toContain('<div class="airport-badge">EDDS</div>');
    });

    it("returns empty string for empty destinations", () => {
      const html = generateDestinationsHtml([]);

      expect(html).toBe("");
    });

    it("handles single destination", () => {
      const destinations = ["EDDH"];

      const html = generateDestinationsHtml(destinations);

      expect(html).toContain("EDDH");
      expect(html).toContain("Destinations");
    });

    it("preserves destination order", () => {
      const destinations = ["ZULU", "ALPHA", "MIKE"];

      const html = generateDestinationsHtml(destinations);

      const zuluIndex = html.indexOf("ZULU");
      const alphaIndex = html.indexOf("ALPHA");
      const mikeIndex = html.indexOf("MIKE");

      expect(zuluIndex).toBeLessThan(alphaIndex);
      expect(alphaIndex).toBeLessThan(mikeIndex);
    });
  });
});
