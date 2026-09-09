import { describe, it, expect, beforeEach, vi } from "vitest";
import type { PathInfo } from "../../../../kml_heatmap/frontend/types";

type AirportsModule =
  typeof import("../../../../kml_heatmap/frontend/features/airports");

describe("airports feature", () => {
  let mod: AirportsModule;

  beforeEach(async () => {
    vi.resetModules();
    mod = await import("../../../../kml_heatmap/frontend/features/airports");
  });

  const mockPathInfo: PathInfo[] = [
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
      expect(
        mod.calculateAirportFlightCounts(mockPathInfo, "all", "all"),
      ).toEqual({ EDAV: 3, EDDF: 2, EDDM: 1, EDDK: 1 });
    });

    it("filters by year", () => {
      expect(
        mod.calculateAirportFlightCounts(mockPathInfo, "2025", "all"),
      ).toEqual({ EDAV: 3, EDDF: 2 });
    });

    it("filters by aircraft", () => {
      expect(
        mod.calculateAirportFlightCounts(mockPathInfo, "all", "D-EAGJ"),
      ).toEqual({ EDAV: 2, EDDF: 2 });
    });

    it("filters by both year and aircraft", () => {
      expect(
        mod.calculateAirportFlightCounts(mockPathInfo, "2025", "D-EXYZ"),
      ).toEqual({ EDAV: 1 });
    });

    it("counts round trips only once per airport", () => {
      expect(
        mod.calculateAirportFlightCounts([
          { id: 1, start_airport: "EDAV", end_airport: "EDAV" },
        ]),
      ).toEqual({ EDAV: 1 });
    });

    it("handles paths without airports", () => {
      expect(
        mod.calculateAirportFlightCounts([
          { id: 1, year: 2025 },
          { id: 2, year: 2025, start_airport: "EDAV" },
        ]),
      ).toEqual({ EDAV: 1 });
    });

    it("returns empty object when no paths match filters", () => {
      expect(
        mod.calculateAirportFlightCounts(mockPathInfo, "2023", "all"),
      ).toEqual({});
    });
  });

  describe("findHomeBase", () => {
    it("finds airport with most flights", () => {
      expect(mod.findHomeBase({ EDAV: 10, EDDF: 5, EDDM: 3 })).toBe("EDAV");
    });

    it("returns null for empty counts", () => {
      expect(mod.findHomeBase({})).toBeNull();
    });

    it("returns the first airport when counts are tied", () => {
      expect(mod.findHomeBase({ EDAV: 5, EDDF: 5 })).toBe("EDAV");
    });
  });

  describe("calculateVisibleAirports", () => {
    it("returns null (all visible) without filters or selection", () => {
      expect(
        mod.calculateVisibleAirports({ pathInfo: mockPathInfo }),
      ).toBeNull();
    });

    it("returns airports of paths matching the year filter", () => {
      const visible = mod.calculateVisibleAirports({
        pathInfo: mockPathInfo,
        selectedYear: "2024",
      });
      expect([...visible!].sort()).toEqual(["EDDK", "EDDM"]);
    });

    it("returns airports of paths matching the aircraft filter", () => {
      const visible = mod.calculateVisibleAirports({
        pathInfo: mockPathInfo,
        selectedAircraft: "D-EAGJ",
      });
      expect([...visible!].sort()).toEqual(["EDAV", "EDDF"]);
    });

    it("adds airports of selected paths to the filtered set", () => {
      const visible = mod.calculateVisibleAirports({
        pathInfo: mockPathInfo,
        selectedYear: "2025",
        selectedPathIds: new Set([3]),
      });
      expect([...visible!].sort()).toEqual(["EDAV", "EDDF", "EDDK", "EDDM"]);
    });

    it("only returns airports of selected paths in isolate mode", () => {
      const visible = mod.calculateVisibleAirports({
        pathInfo: mockPathInfo,
        selectedYear: "2025",
        selectedPathIds: new Set([3]),
        isolateSelection: true,
      });
      expect([...visible!].sort()).toEqual(["EDDK", "EDDM"]);
    });

    it("ignores isolate mode without a selection", () => {
      const visible = mod.calculateVisibleAirports({
        pathInfo: mockPathInfo,
        selectedYear: "2024",
        isolateSelection: true,
      });
      expect([...visible!].sort()).toEqual(["EDDK", "EDDM"]);
    });

    it("uses the provided path info map for selected paths", () => {
      const byId = new Map<number, PathInfo>([
        [99, { id: 99, start_airport: "LOWW" }],
      ]);
      const visible = mod.calculateVisibleAirports({
        pathInfo: mockPathInfo,
        selectedPathIds: new Set([99, 1]),
        pathInfoById: byId,
      });
      // path 1 is unknown to the map, so only LOWW is visible
      expect([...visible!]).toEqual(["LOWW"]);
    });

    it("ignores unknown selected path ids", () => {
      const visible = mod.calculateVisibleAirports({
        pathInfo: mockPathInfo,
        selectedPathIds: new Set([999]),
      });
      expect(visible!.size).toBe(0);
    });
  });

  describe("countryDisplayName", () => {
    it("converts ISO code to full country name", () => {
      expect(mod.countryDisplayName("DE")).toBe("Germany");
      expect(mod.countryDisplayName("US")).toBe("United States");
      expect(mod.countryDisplayName("FR")).toBe("France");
    });

    it("returns a non-empty string for unknown codes and the input for invalid ones", () => {
      const unknown = mod.countryDisplayName("ZZ");
      expect(typeof unknown).toBe("string");
      expect(unknown.length).toBeGreaterThan(0);
      // Intl throws on malformed region codes; the input is returned as is
      expect(mod.countryDisplayName("not a code")).toBe("not a code");
    });
  });

  describe("countryFlag", () => {
    it("converts ISO code to flag emoji", () => {
      expect(mod.countryFlag("DE")).toBe("🇩🇪");
      expect(mod.countryFlag("US")).toBe("🇺🇸");
      expect(mod.countryFlag("CH")).toBe("🇨🇭");
    });

    it("returns empty string for invalid codes", () => {
      expect(mod.countryFlag("")).toBe("");
      expect(mod.countryFlag("X")).toBe("");
      expect(mod.countryFlag("abc")).toBe("");
      expect(mod.countryFlag("d1")).toBe("");
    });
  });

  describe("country lookups", () => {
    beforeEach(() => {
      window.KML_AIRPORTS = {
        airports: [
          { name: "EDAV Halle-Oppin", lat: 51, lon: 12, country: "DE" },
          { name: "EDDF Frankfurt", lat: 50, lon: 8, country: "DE" },
          { name: "LSZH Zurich", lat: 47, lon: 8, country: "CH" },
          { name: "LKPR Prague", lat: 50, lon: 14, country: "CZ" },
          { name: "NOCOUNTRY", lat: 0, lon: 0 },
        ],
      };
    });

    it("countCountries returns unique country codes for given airports", () => {
      const countries = mod.countCountries([
        "EDAV Halle-Oppin",
        "EDDF Frankfurt",
        "LSZH Zurich",
      ]);
      expect([...countries].sort()).toEqual(["CH", "DE"]);
    });

    it("countCountries skips unknown airports and airports without country", () => {
      expect(mod.countCountries([]).size).toBe(0);
      expect([
        ...mod.countCountries(["EDAV Halle-Oppin", "UNKNOWN", "NOCOUNTRY"]),
      ]).toEqual(["DE"]);
    });

    it("groupByCountry groups airports by country code in first-seen order", () => {
      const grouped = mod.groupByCountry([
        "LSZH Zurich",
        "EDAV Halle-Oppin",
        "EDDF Frankfurt",
        "LKPR Prague",
      ]);
      expect([...grouped.entries()]).toEqual([
        ["CH", ["LSZH Zurich"]],
        ["DE", ["EDAV Halle-Oppin", "EDDF Frankfurt"]],
        ["CZ", ["LKPR Prague"]],
      ]);
    });

    it("groupByCountry puts unknown airports under 'Other'", () => {
      expect(mod.groupByCountry(["UNKNOWN Airport"]).get("Other")).toEqual([
        "UNKNOWN Airport",
      ]);
      expect(mod.groupByCountry([]).size).toBe(0);
    });

    it("caches the country map per module instance", () => {
      expect(mod.countCountries(["EDAV Halle-Oppin"]).size).toBe(1);
      window.KML_AIRPORTS = { airports: [] };
      expect(mod.countCountries(["EDAV Halle-Oppin"]).size).toBe(1);
    });

    it("handles missing KML_AIRPORTS", () => {
      delete window.KML_AIRPORTS;
      expect(mod.countCountries(["EDAV Halle-Oppin"]).size).toBe(0);
    });
  });
});
