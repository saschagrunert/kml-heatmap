import { describe, it, expect, beforeEach, vi } from "vitest";

describe("airports feature", () => {
  let calculateAirportFlightCounts: typeof import("../../../../kml_heatmap/frontend/features/airports").calculateAirportFlightCounts;
  let countCountries: typeof import("../../../../kml_heatmap/frontend/features/airports").countCountries;
  let countryDisplayName: typeof import("../../../../kml_heatmap/frontend/features/airports").countryDisplayName;
  let countryFlag: typeof import("../../../../kml_heatmap/frontend/features/airports").countryFlag;
  let findHomeBase: typeof import("../../../../kml_heatmap/frontend/features/airports").findHomeBase;
  let groupByCountry: typeof import("../../../../kml_heatmap/frontend/features/airports").groupByCountry;
  let calculateAirportOpacity: typeof import("../../../../kml_heatmap/frontend/features/airports").calculateAirportOpacity;
  let calculateAirportMarkerSize: typeof import("../../../../kml_heatmap/frontend/features/airports").calculateAirportMarkerSize;
  let calculateAirportVisibility: typeof import("../../../../kml_heatmap/frontend/features/airports").calculateAirportVisibility;

  beforeEach(async () => {
    vi.resetModules();
    const mod =
      await import("../../../../kml_heatmap/frontend/features/airports");
    calculateAirportFlightCounts = mod.calculateAirportFlightCounts;
    countCountries = mod.countCountries;
    countryDisplayName = mod.countryDisplayName;
    countryFlag = mod.countryFlag;
    findHomeBase = mod.findHomeBase;
    groupByCountry = mod.groupByCountry;
    calculateAirportOpacity = mod.calculateAirportOpacity;
    calculateAirportMarkerSize = mod.calculateAirportMarkerSize;
    calculateAirportVisibility = mod.calculateAirportVisibility;
  });

  const mockPathInfo = [
    {
      id: 1,
      year: 2025,
      aircraft_registration: "D-EAGJ",
      start_airport: "EDAV",
      end_airport: "EDDF",
    },
    {
      id: 2,
      year: 2025,
      aircraft_registration: "D-EAGJ",
      start_airport: "EDDF",
      end_airport: "EDAV",
    },
    {
      id: 3,
      year: 2024,
      aircraft_registration: "D-EXYZ",
      start_airport: "EDDM",
      end_airport: "EDDK",
    },
    {
      id: 4,
      year: 2025,
      aircraft_registration: "D-EXYZ",
      start_airport: "EDAV",
      end_airport: "EDAV",
    },
  ];

  describe("calculateAirportFlightCounts", () => {
    it("counts flights to all airports with no filters", () => {
      const counts = calculateAirportFlightCounts(mockPathInfo, "all", "all");

      expect(counts.EDAV).toBe(3); // id 1, 2, 4
      expect(counts.EDDF).toBe(2); // id 1, 2
      expect(counts.EDDM).toBe(1); // id 3
      expect(counts.EDDK).toBe(1); // id 3
    });

    it("filters by year", () => {
      const counts = calculateAirportFlightCounts(mockPathInfo, "2025", "all");

      expect(counts.EDAV).toBe(3);
      expect(counts.EDDF).toBe(2);
      expect(counts.EDDM).toBeUndefined();
      expect(counts.EDDK).toBeUndefined();
    });

    it("filters by aircraft", () => {
      const counts = calculateAirportFlightCounts(
        mockPathInfo,
        "all",
        "D-EAGJ"
      );

      expect(counts.EDAV).toBe(2);
      expect(counts.EDDF).toBe(2);
      expect(counts.EDDM).toBeUndefined();
    });

    it("filters by both year and aircraft", () => {
      const counts = calculateAirportFlightCounts(
        mockPathInfo,
        "2025",
        "D-EXYZ"
      );

      expect(counts.EDAV).toBe(1); // Only id 4
      expect(counts.EDDF).toBeUndefined();
    });

    it("counts round trips only once per airport", () => {
      const pathInfo = [{ id: 1, start_airport: "EDAV", end_airport: "EDAV" }];
      const counts = calculateAirportFlightCounts(pathInfo, "all", "all");

      expect(counts.EDAV).toBe(1); // Not 2, even though start and end are same
    });

    it("handles paths without airports", () => {
      const pathInfo = [
        { id: 1, year: 2025 },
        { id: 2, year: 2025, start_airport: "EDAV" },
      ];
      const counts = calculateAirportFlightCounts(pathInfo, "all", "all");

      expect(counts.EDAV).toBe(1);
      expect(Object.keys(counts)).toHaveLength(1);
    });

    it("returns empty object for null pathInfo", () => {
      const counts = calculateAirportFlightCounts(null, "all", "all");
      expect(counts).toEqual({});
    });

    it("returns empty object when no paths match filters", () => {
      const counts = calculateAirportFlightCounts(mockPathInfo, "2023", "all");
      expect(counts).toEqual({});
    });
  });

  describe("findHomeBase", () => {
    it("finds airport with most flights", () => {
      const counts = {
        EDAV: 10,
        EDDF: 5,
        EDDM: 3,
      };

      expect(findHomeBase(counts)).toBe("EDAV");
    });

    it("returns null for empty counts", () => {
      expect(findHomeBase({})).toBeNull();
    });

    it("handles single airport", () => {
      const counts = { EDAV: 1 };
      expect(findHomeBase(counts)).toBe("EDAV");
    });

    it("returns first airport when counts are tied", () => {
      const counts = {
        EDAV: 5,
        EDDF: 5,
      };
      // JavaScript object iteration order - will return one of them
      const homeBase = findHomeBase(counts);
      expect(["EDAV", "EDDF"]).toContain(homeBase);
    });
  });

  describe("calculateAirportOpacity", () => {
    it("returns 1.0 for maximum count", () => {
      expect(calculateAirportOpacity(10, 10)).toBe(1.0);
    });

    it("returns 0.3 for zero count", () => {
      expect(calculateAirportOpacity(0, 10)).toBe(0.3);
    });

    it("returns intermediate value for mid-range count", () => {
      const opacity = calculateAirportOpacity(5, 10);
      expect(opacity).toBeGreaterThan(0.3);
      expect(opacity).toBeLessThan(1.0);
      expect(opacity).toBeCloseTo(0.65, 2); // 0.3 + 0.5 * (1.0 - 0.3)
    });

    it("handles zero maxCount", () => {
      expect(calculateAirportOpacity(0, 0)).toBe(1.0);
    });

    it("scales linearly", () => {
      const opacity1 = calculateAirportOpacity(2, 10);
      const opacity2 = calculateAirportOpacity(5, 10);
      const opacity3 = calculateAirportOpacity(8, 10);

      expect(opacity2).toBeGreaterThan(opacity1);
      expect(opacity3).toBeGreaterThan(opacity2);
    });
  });

  describe("calculateAirportMarkerSize", () => {
    it("returns maxSize for maximum count", () => {
      expect(calculateAirportMarkerSize(10, 10)).toBe(8);
    });

    it("returns minSize for zero count", () => {
      expect(calculateAirportMarkerSize(0, 10)).toBe(3);
    });

    it("returns intermediate value for mid-range count", () => {
      const size = calculateAirportMarkerSize(5, 10);
      expect(size).toBeGreaterThan(3);
      expect(size).toBeLessThan(8);
      expect(size).toBeCloseTo(5.5, 2); // 3 + 0.5 * (8 - 3)
    });

    it("accepts custom size options", () => {
      const size = calculateAirportMarkerSize(5, 10, {
        minSize: 5,
        maxSize: 15,
      });
      expect(size).toBeCloseTo(10, 2); // 5 + 0.5 * (15 - 5)
    });

    it("handles zero maxCount", () => {
      expect(calculateAirportMarkerSize(0, 0)).toBe(3);
    });
  });

  describe("calculateAirportVisibility", () => {
    const airportCounts = {
      EDAV: 10,
      EDDF: 5,
      EDDM: 0,
    };

    const pathToAirports = {
      1: { start: "EDAV", end: "EDDF" },
      2: { start: "EDDF", end: "EDAV" },
    };

    it("shows all airports with no filters or selection", () => {
      const visibility = calculateAirportVisibility({
        airportCounts,
        selectedYear: "all",
        selectedAircraft: "all",
        selectedPathIds: new Set(),
        pathToAirports,
      });

      expect(visibility.EDAV).toEqual({ show: true, opacity: 1.0 });
      expect(visibility.EDDF).toEqual({ show: true, opacity: 1.0 });
      expect(visibility.EDDM).toEqual({ show: true, opacity: 1.0 });
    });

    it("hides airports with zero count when filters active", () => {
      const visibility = calculateAirportVisibility({
        airportCounts,
        selectedYear: "2025",
        selectedAircraft: "all",
        selectedPathIds: new Set(),
        pathToAirports,
      });

      expect(visibility.EDAV.show).toBe(true);
      expect(visibility.EDDF.show).toBe(true);
      expect(visibility.EDDM.show).toBe(false);
    });

    it("highlights selected airports during path selection", () => {
      const visibility = calculateAirportVisibility({
        airportCounts,
        selectedYear: "all",
        selectedAircraft: "all",
        selectedPathIds: new Set([1]),
        pathToAirports,
      });

      expect(visibility.EDAV.opacity).toBe(1.0); // Selected
      expect(visibility.EDDF.opacity).toBe(1.0); // Selected
      expect(visibility.EDDM.opacity).toBe(0.2); // Not selected
    });

    it("shows all airports during selection even with zero count", () => {
      const visibility = calculateAirportVisibility({
        airportCounts,
        selectedYear: "all",
        selectedAircraft: "all",
        selectedPathIds: new Set([1]),
        pathToAirports,
      });

      expect(visibility.EDAV.show).toBe(true);
      expect(visibility.EDDF.show).toBe(true);
      expect(visibility.EDDM.show).toBe(true);
    });

    it("handles aircraft filter", () => {
      const visibility = calculateAirportVisibility({
        airportCounts: { EDAV: 5, EDDF: 0 },
        selectedYear: "all",
        selectedAircraft: "D-EAGJ",
        selectedPathIds: new Set(),
        pathToAirports,
      });

      expect(visibility.EDAV.show).toBe(true);
      expect(visibility.EDDF.show).toBe(false);
    });

    it("handles empty selection", () => {
      const visibility = calculateAirportVisibility({
        airportCounts,
        selectedPathIds: new Set(),
        pathToAirports,
      });

      Object.values(visibility).forEach((v) => {
        expect(v.show).toBe(true);
        expect(v.opacity).toBe(1.0);
      });
    });
  });

  describe("countryDisplayName", () => {
    it("converts ISO code to full country name", () => {
      expect(countryDisplayName("DE")).toBe("Germany");
      expect(countryDisplayName("US")).toBe("United States");
      expect(countryDisplayName("FR")).toBe("France");
    });

    it("returns a string for unknown codes", () => {
      const result = countryDisplayName("ZZ");
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    });
  });

  describe("countryFlag", () => {
    it("converts ISO code to flag emoji", () => {
      expect(countryFlag("DE")).toBe("🇩🇪");
      expect(countryFlag("US")).toBe("🇺🇸");
      expect(countryFlag("CH")).toBe("🇨🇭");
    });

    it("returns empty string for invalid codes", () => {
      expect(countryFlag("")).toBe("");
      expect(countryFlag("X")).toBe("");
      expect(countryFlag("abc")).toBe("");
    });
  });

  describe("countCountries", () => {
    beforeEach(() => {
      vi.stubGlobal("KML_AIRPORTS", {
        airports: [
          { name: "EDAV Halle-Oppin", country: "DE" },
          { name: "EDDF Frankfurt", country: "DE" },
          { name: "LSZH Zurich", country: "CH" },
          { name: "LKPR Prague", country: "CZ" },
        ],
      });
    });

    it("returns unique country codes for given airports", () => {
      const countries = countCountries([
        "EDAV Halle-Oppin",
        "EDDF Frankfurt",
        "LSZH Zurich",
      ]);
      expect(countries.size).toBe(2);
      expect(countries.has("DE")).toBe(true);
      expect(countries.has("CH")).toBe(true);
    });

    it("returns empty set for empty input", () => {
      expect(countCountries([]).size).toBe(0);
    });

    it("skips airports not found in KML_AIRPORTS", () => {
      const countries = countCountries(["EDAV Halle-Oppin", "UNKNOWN Airport"]);
      expect(countries.size).toBe(1);
      expect(countries.has("DE")).toBe(true);
    });
  });

  describe("groupByCountry", () => {
    beforeEach(() => {
      vi.stubGlobal("KML_AIRPORTS", {
        airports: [
          { name: "EDAV Halle-Oppin", country: "DE" },
          { name: "EDDF Frankfurt", country: "DE" },
          { name: "LSZH Zurich", country: "CH" },
          { name: "LKPR Prague", country: "CZ" },
        ],
      });
    });

    it("groups airports by country code", () => {
      const grouped = groupByCountry([
        "EDAV Halle-Oppin",
        "EDDF Frankfurt",
        "LSZH Zurich",
        "LKPR Prague",
      ]);
      expect(grouped.get("DE")).toEqual(["EDAV Halle-Oppin", "EDDF Frankfurt"]);
      expect(grouped.get("CH")).toEqual(["LSZH Zurich"]);
      expect(grouped.get("CZ")).toEqual(["LKPR Prague"]);
    });

    it("puts unknown airports under 'Other'", () => {
      const grouped = groupByCountry(["UNKNOWN Airport"]);
      expect(grouped.get("Other")).toEqual(["UNKNOWN Airport"]);
    });

    it("returns empty map for empty input", () => {
      expect(groupByCountry([]).size).toBe(0);
    });
  });
});
