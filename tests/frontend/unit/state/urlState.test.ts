import { describe, it, expect } from "vitest";
import {
  parseUrlParams,
  encodeStateToUrl,
} from "../../../../kml_heatmap/frontend/state/urlState";
import {
  MAX_ZOOM,
  MIN_ZOOM,
} from "../../../../kml_heatmap/frontend/utils/constants";
import type { AppState } from "../../../../kml_heatmap/frontend/types";

/**
 * Small seeded PRNG (mulberry32) so the property test is reproducible
 * without adding a dependency.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomState(rnd: () => number): AppState {
  const bool = (): boolean => rnd() < 0.5;
  const years = ["all", "2020", "2024", "2025"];
  const aircraft = ["D-EAGJ", "N123AB", "OE-XYZ", "HB-1", "G-ABCD"];
  const pathCount = Math.floor(rnd() * 6);
  const pathIds = Array.from({ length: pathCount }, () =>
    Math.floor(rnd() * 5000),
  );
  return {
    selectedYear: years[Math.floor(rnd() * years.length)]!,
    selectedAircraft: aircraft[Math.floor(rnd() * aircraft.length)]!,
    selectedPathIds: pathIds,
    heatmapVisible: bool(),
    altitudeVisible: bool(),
    airspeedVisible: bool(),
    airportsVisible: bool(),
    aviationVisible: bool(),
    statsPanelVisible: bool(),
    wrappedVisible: bool(),
    buttonsHidden: bool(),
    isolateSelection: bool(),
    center: {
      lat: Math.round((rnd() * 180 - 90) * 1e6) / 1e6,
      lng: Math.round((rnd() * 360 - 180) * 1e6) / 1e6,
    },
    zoom: Math.round((MIN_ZOOM + rnd() * (MAX_ZOOM - MIN_ZOOM)) * 100) / 100,
    // Half of the views are north up and flat, like most real ones
    bearing: bool() ? 0 : Math.round((rnd() * 360 - 180) * 10) / 10,
    pitch: bool() ? 0 : Math.round(rnd() * 850) / 10,
    globeVisible: bool(),
    threeDVisible: bool(),
  };
}

describe("URL state management", () => {
  describe("parseUrlParams", () => {
    it("returns null for empty params", () => {
      expect(parseUrlParams("")).toBeNull();
      expect(parseUrlParams(new URLSearchParams())).toBeNull();
    });

    it("parses year parameter", () => {
      expect(parseUrlParams("y=2025")).toEqual({ selectedYear: "2025" });
      expect(parseUrlParams("y=all")).toEqual({ selectedYear: "all" });
    });

    it("ignores empty year and aircraft values", () => {
      expect(parseUrlParams("y=&a=")).toEqual({});
    });

    it("parses aircraft parameter", () => {
      expect(parseUrlParams("a=D-EAGJ")).toEqual({
        selectedAircraft: "D-EAGJ",
      });
    });

    it("parses path IDs when the schema version matches", () => {
      expect(parseUrlParams("p=5&sv=4")).toEqual({ selectedPathIds: [5] });
      expect(parseUrlParams("p=a5,1x&sv=4")).toEqual({
        selectedPathIds: [365, 69],
      });
      // Schema 3 named the same flights in decimal and is still read
      expect(parseUrlParams("p=5&sv=3")).toEqual({ selectedPathIds: [5] });
      expect(parseUrlParams("p=1,5,12,25&sv=3")).toEqual({
        selectedPathIds: [1, 5, 12, 25],
      });
    });

    it("parses content hash ids exactly", () => {
      expect(parseUrlParams("p=840108108563,1099511627775&sv=3")).toEqual({
        selectedPathIds: [840108108563, 1099511627775],
      });
    });

    it("ignores path IDs without a current schema version", () => {
      // Ids from an older release were positions in the export and would
      // select different flights, so they are dropped rather than applied
      expect(parseUrlParams("p=1,5,12")).toEqual({});
      expect(parseUrlParams("p=1,5,12&sv=1")).toEqual({});
      expect(parseUrlParams("p=1,5,12&sv=2")).toEqual({});
      expect(parseUrlParams("y=2025&p=1,5")).toEqual({ selectedYear: "2025" });
    });

    it("filters out invalid path IDs", () => {
      expect(parseUrlParams("p=1,invalid,5,NaN,,12&sv=3")).toEqual({
        selectedPathIds: [1, 5, 12],
      });
    });

    it("parses visibility flags (6-char legacy format)", () => {
      expect(parseUrlParams("v=101010")).toEqual({
        heatmapVisible: true,
        altitudeVisible: false,
        airspeedVisible: true,
        airportsVisible: false,
        aviationVisible: true,
        statsPanelVisible: false,
      });
    });

    it("parses visibility flags (7-char format with wrapped)", () => {
      expect(parseUrlParams("v=1010101")).toEqual({
        heatmapVisible: true,
        altitudeVisible: false,
        airspeedVisible: true,
        airportsVisible: false,
        aviationVisible: true,
        statsPanelVisible: false,
        wrappedVisible: true,
      });
    });

    it("parses visibility flags (8-char format with buttonsHidden)", () => {
      expect(parseUrlParams("v=10101011")).toEqual({
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

    it("parses visibility flags (9-char format with isolateSelection)", () => {
      expect(parseUrlParams("v=101010111")).toEqual({
        heatmapVisible: true,
        altitudeVisible: false,
        airspeedVisible: true,
        airportsVisible: false,
        aviationVisible: true,
        statsPanelVisible: false,
        wrappedVisible: true,
        buttonsHidden: true,
        isolateSelection: true,
      });
    });

    it("ignores visibility string with wrong length", () => {
      expect(parseUrlParams("v=101")).toEqual({});
      expect(parseUrlParams("v=1010101010")).toEqual({});
      expect(parseUrlParams("v=10101")).toEqual({});
    });

    it("parses map center", () => {
      expect(parseUrlParams("lat=51.5&lng=13.4")).toEqual({
        center: { lat: 51.5, lng: 13.4 },
      });
    });

    it("validates latitude and longitude ranges", () => {
      expect(parseUrlParams("lat=45.5&lng=10.0")!.center).toEqual({
        lat: 45.5,
        lng: 10.0,
      });
      expect(parseUrlParams("lat=91&lng=10")!.center).toBeUndefined();
      expect(parseUrlParams("lat=-91&lng=10")!.center).toBeUndefined();
      // A longitude of another copy of the world is the same place
      expect(parseUrlParams("lat=45&lng=181")!.center).toEqual({
        lat: 45,
        lng: -179,
      });
      expect(parseUrlParams("lat=45&lng=-181")!.center).toEqual({
        lat: 45,
        lng: 179,
      });
      expect(parseUrlParams("lat=abc&lng=10")!.center).toBeUndefined();
    });

    it("requires both lat and lng for center", () => {
      expect(parseUrlParams("lat=45")!.center).toBeUndefined();
      expect(parseUrlParams("lng=10")!.center).toBeUndefined();
    });

    it("parses zoom level", () => {
      expect(parseUrlParams("z=12.5")).toEqual({ zoom: 12.5 });
      expect(parseUrlParams("z=abc")).toEqual({});
    });

    it("clamps zoom to the map's zoom range", () => {
      expect(parseUrlParams("z=0.5")!.zoom).toBe(MIN_ZOOM);
      expect(parseUrlParams("z=19.5")!.zoom).toBe(19.5);
      expect(parseUrlParams("z=20")!.zoom).toBe(MAX_ZOOM);
      expect(parseUrlParams("z=25")!.zoom).toBe(MAX_ZOOM);
      expect(parseUrlParams("z=10")!.zoom).toBe(10);
    });

    it("parses complete state", () => {
      const url =
        "y=2025&a=D-EAGJ&p=1,5,12&sv=3&v=010101&lat=51.5&lng=13.4&z=10.5";
      expect(parseUrlParams(url)).toEqual({
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

    it("parses the bearing, the pitch and the globe", () => {
      expect(parseUrlParams("b=-40.5&t=35&g=1")).toEqual({
        bearing: -40.5,
        pitch: 35,
        globeVisible: true,
      });
    });

    it("wraps a bearing and holds a pitch to what the map tilts to", () => {
      expect(parseUrlParams("b=270")!.bearing).toBe(-90);
      expect(parseUrlParams("b=-190")!.bearing).toBe(170);
      expect(parseUrlParams("b=180")!.bearing).toBe(180);
      expect(parseUrlParams("t=89")!.pitch).toBe(85);
      expect(parseUrlParams("t=-10")!.pitch).toBe(0);
    });

    it("ignores an orientation that is no number and a globe that is not 1", () => {
      expect(parseUrlParams("y=2025&b=north&t=&g=yes")).toEqual({
        selectedYear: "2025",
      });
      expect(parseUrlParams("b=Infinity&g=0")).toEqual({});
    });

    it("opens a link from before the map could turn north up and flat", () => {
      const state = parseUrlParams("y=2025&lat=51.5&lng=13.4&z=10.5")!;

      for (const key of ["bearing", "pitch", "globeVisible"]) {
        expect(state).not.toHaveProperty(key);
      }
    });

    it("accepts URLSearchParams object", () => {
      expect(parseUrlParams(new URLSearchParams("y=2025&a=D-EAGJ"))).toEqual({
        selectedYear: "2025",
        selectedAircraft: "D-EAGJ",
      });
    });
  });

  describe("encodeStateToUrl", () => {
    it("encodes year parameter (including 'all')", () => {
      expect(encodeStateToUrl({ selectedYear: "2025" })).toBe("y=2025");
      expect(encodeStateToUrl({ selectedYear: "all" })).toBe("y=all");
    });

    it("encodes aircraft parameter and omits 'all'", () => {
      expect(
        encodeStateToUrl({ selectedYear: "all", selectedAircraft: "D-EAGJ" }),
      ).toBe("y=all&a=D-EAGJ");
      expect(
        encodeStateToUrl({ selectedYear: "2025", selectedAircraft: "all" }),
      ).toBe("y=2025");
    });

    it("encodes path IDs in base 36 and omits an empty list", () => {
      expect(
        encodeStateToUrl({ selectedYear: "all", selectedPathIds: [1, 5, 12] }),
      ).toBe("y=all&p=1%2C5%2Cc&sv=4");
      expect(
        encodeStateToUrl({ selectedYear: "all", selectedPathIds: [] }),
      ).toBe("y=all");
    });

    it("keeps a large selection far shorter than decimal would", () => {
      // 40-bit content hashes: 13 digits each in decimal, 8 in base 36
      const ids = Array.from(
        { length: 200 },
        (_, i) => 2 ** 39 + i * 1234567891,
      );

      const encoded = encodeStateToUrl({ selectedPathIds: ids });

      const decimal = ids.join(",").length;
      const written = new URLSearchParams(encoded).get("p")!.length;
      expect(written).toBeLessThan(decimal * 0.7);
      // and it still round-trips
      expect(parseUrlParams(encoded)?.selectedPathIds).toEqual(ids);
    });

    it("encodes visibility flags", () => {
      expect(
        encodeStateToUrl({
          heatmapVisible: true,
          altitudeVisible: false,
          airspeedVisible: true,
          airportsVisible: false,
          aviationVisible: true,
          statsPanelVisible: false,
        }),
      ).toBe("v=101010000");
    });

    it("omits default visibility (100100000)", () => {
      expect(
        encodeStateToUrl({
          heatmapVisible: true,
          altitudeVisible: false,
          airspeedVisible: false,
          airportsVisible: true,
          aviationVisible: false,
          statsPanelVisible: false,
          wrappedVisible: false,
          buttonsHidden: false,
          isolateSelection: false,
        }),
      ).toBe("");
    });

    it("encodes wrappedVisible, buttonsHidden and isolateSelection flags", () => {
      const base = {
        heatmapVisible: true,
        altitudeVisible: false,
        airspeedVisible: false,
        airportsVisible: true,
        aviationVisible: false,
        statsPanelVisible: false,
      };
      expect(encodeStateToUrl({ ...base, wrappedVisible: true })).toBe(
        "v=100100100",
      );
      expect(encodeStateToUrl({ ...base, buttonsHidden: true })).toBe(
        "v=100100010",
      );
      expect(encodeStateToUrl({ ...base, isolateSelection: true })).toBe(
        "v=100100001",
      );
    });

    it("encodes map center with 6 decimal places and zoom with 2", () => {
      const url = encodeStateToUrl({
        center: { lat: 51.507351, lng: -0.127758 },
        zoom: 12.567,
      });
      expect(url).toBe("lat=51.507351&lng=-0.127758&z=12.57");
    });

    it("preserves the debug parameter of the current URL", () => {
      const original = window.location.search;
      window.history.replaceState(null, "", "/?debug=true&y=1999");
      try {
        expect(encodeStateToUrl({ selectedYear: "2025" })).toBe(
          "debug=true&y=2025",
        );
      } finally {
        window.history.replaceState(null, "", "/" + original);
      }
    });

    it("encodes complete state", () => {
      const params = new URLSearchParams(
        encodeStateToUrl({
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
        }),
      );

      expect(params.get("y")).toBe("2025");
      expect(params.get("a")).toBe("D-EAGJ");
      expect(params.get("p")).toBe("1,5");
      expect(params.get("v")).toBe("010101000");
      expect(params.get("lat")).toBe("51.500000");
      expect(params.get("lng")).toBe("13.400000");
      expect(params.get("z")).toBe("10.50");
    });

    it("encodes the bearing and the pitch to a tenth of a degree", () => {
      expect(encodeStateToUrl({ bearing: -40.26, pitch: 35.04 })).toBe(
        "b=-40.3&t=35",
      );
    });

    it("keeps north up, flat and Mercator out of the link", () => {
      expect(
        encodeStateToUrl({ bearing: 0, pitch: 0, globeVisible: false }),
      ).toBe("");
      // Closer to north than a link tells apart, from either side
      expect(encodeStateToUrl({ bearing: -0.04, pitch: 0.04 })).toBe("");
      expect(encodeStateToUrl({ globeVisible: true })).toBe("g=1");
      expect(encodeStateToUrl({ threeDVisible: false })).toBe("");
      expect(encodeStateToUrl({ threeDVisible: true })).toBe("d=1");
    });

    it("returns an empty string for an empty state", () => {
      expect(encodeStateToUrl({})).toBe("");
    });
  });

  describe("parseUrlParams and encodeStateToUrl round-trip", () => {
    it("maintains a full state through encode/decode cycle", () => {
      const original: AppState = {
        selectedYear: "2025",
        selectedAircraft: "D-EAGJ",
        selectedPathIds: [1, 5, 12],
        heatmapVisible: false,
        altitudeVisible: true,
        airspeedVisible: false,
        airportsVisible: true,
        aviationVisible: false,
        statsPanelVisible: true,
        wrappedVisible: true,
        buttonsHidden: true,
        isolateSelection: true,
        center: { lat: 51.5, lng: 13.4 },
        zoom: 10.5,
        bearing: -135.5,
        pitch: 42.3,
        globeVisible: true,
        threeDVisible: true,
      };

      const decoded = parseUrlParams(encodeStateToUrl(original));

      expect(decoded).toEqual(original);
    });

    it("round-trips 200 pseudo-random states (seeded property test)", () => {
      const rnd = mulberry32(20250909);

      for (let i = 0; i < 200; i++) {
        const state = randomState(rnd);
        const decoded = parseUrlParams(encodeStateToUrl(state));

        expect(decoded, `case ${i}`).not.toBeNull();
        const expected: AppState = { ...state };
        if (state.selectedAircraft === "all") delete expected.selectedAircraft;
        if (state.selectedPathIds!.length === 0)
          delete expected.selectedPathIds;
        // The defaults are not encoded, so nothing is decoded
        if (state.bearing === 0) delete expected.bearing;
        if (state.pitch === 0) delete expected.pitch;
        if (!state.globeVisible) delete expected.globeVisible;
        if (!state.threeDVisible) delete expected.threeDVisible;
        const flags = [
          state.heatmapVisible,
          state.altitudeVisible,
          state.airspeedVisible,
          state.airportsVisible,
          state.aviationVisible,
          state.statsPanelVisible,
          state.wrappedVisible,
          state.buttonsHidden,
          state.isolateSelection,
        ];
        const isDefaultVisibility =
          flags.map((f) => (f ? "1" : "0")).join("") === "100100000";
        if (isDefaultVisibility) {
          // default visibility is not encoded, so nothing is decoded
          for (const key of [
            "heatmapVisible",
            "altitudeVisible",
            "airspeedVisible",
            "airportsVisible",
            "aviationVisible",
            "statsPanelVisible",
            "wrappedVisible",
            "buttonsHidden",
            "isolateSelection",
          ] as const) {
            delete expected[key];
          }
        }
        expect(decoded, `case ${i}`).toEqual(expected);
      }
    });
  });
});
