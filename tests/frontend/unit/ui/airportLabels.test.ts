import { describe, it, expect, afterEach } from "vitest";
import type { Map as MapLibreMap } from "maplibre-gl";
import {
  addAirportLabelImages,
  airportLabelFeatures,
  airportLabelLayer,
  airportLabelSize,
  chipImage,
  icaoCode,
  setAirportLabelHover,
} from "../../../../kml_heatmap/frontend/ui/airportLabels";
import {
  AIRPORT_HIDE_LABELS_BELOW_ZOOM,
  MAP_LAYERS,
  MAP_SOURCES,
} from "../../../../kml_heatmap/frontend/utils/constants";
import { resetMapLibreMock } from "../../../mocks/maplibre-gl";
import { createMapLibreMock } from "../../testHelpers";

describe("airport labels", () => {
  afterEach(() => resetMapLibreMock());

  describe("icaoCode", () => {
    it("takes the four capitals of the name", () => {
      expect(icaoCode("Frankfurt EDDF")).toBe("EDDF");
      expect(icaoCode("EDAQ Halle-Oppin")).toBe("EDAQ");
    });

    it("falls back to APT for a name without one", () => {
      expect(icaoCode("Small Airfield 123")).toBe("APT");
      expect(icaoCode("")).toBe("APT");
    });
  });

  describe("airportLabelSize", () => {
    /** The size the step expression gives at a zoom */
    function sizeAt(expression: unknown[], zoom: number): number {
      let size = expression[2] as number;
      for (let i = 3; i < expression.length; i += 2) {
        if (zoom >= (expression[i] as number)) {
          size = expression[i + 1] as number;
        }
      }
      return size;
    }

    it("grows with the markers, from 10 to 13 pixels", () => {
      const size = airportLabelSize() as unknown[];

      expect(size.slice(0, 2)).toEqual(["step", ["zoom"]]);
      expect(sizeAt(size, 4)).toBe(10);
      expect(sizeAt(size, 5)).toBe(10.5);
      expect(sizeAt(size, 7)).toBe(11);
      expect(sizeAt(size, 9)).toBe(12);
      expect(sizeAt(size, 13)).toBe(13);
      // Stops of a step expression have to rise
      const stops = size.filter((_, i) => i >= 3 && i % 2 === 1) as number[];
      expect(stops).toEqual([...stops].sort((a, b) => a - b));
    });

    it("never goes under the smallest size a phone shows", () => {
      const size = airportLabelSize(12) as unknown[];

      expect(sizeAt(size, 4)).toBe(12);
      expect(sizeAt(size, 13)).toBe(13);
    });
  });

  describe("airportLabelLayer", () => {
    it("draws the code of each airport, hidden until the handle shows it", () => {
      const layer = airportLabelLayer();

      expect(layer.id).toBe(MAP_LAYERS.airportLabels);
      expect(layer.source).toBe(MAP_SOURCES.airportLabels);
      expect(layer.minzoom).toBe(AIRPORT_HIDE_LABELS_BELOW_ZOOM);
      expect(layer.layout).toMatchObject({
        visibility: "none",
        "text-field": ["get", "icao"],
        // Always above the dot
        "text-anchor": "bottom",
      });
    });

    it("asks the glyph server for the base style's font, with a local fallback", () => {
      const font = airportLabelLayer().layout!["text-font"] as string[];

      expect(font[0]).toBe("Roboto Medium");
      expect(font.at(-1)).toBe("sans-serif");
    });

    it("places the home base first, then the busiest airports", () => {
      const key = airportLabelLayer().layout!["symbol-sort-key"];

      expect(key).toEqual([
        "-",
        ["case", ["get", "home"], Number.MAX_SAFE_INTEGER, ["get", "count"]],
      ]);
    });
  });

  describe("airportLabelFeatures", () => {
    const airports = [
      { name: "EDDF Frankfurt", lat: 50.1, lon: 8.67 },
      { name: "EDDM Munich", lat: 48.35, lon: 11.78 },
    ];

    it("makes a point per airport, longitude first, with what places it", () => {
      const labels = airportLabelFeatures(
        airports,
        { "EDDF Frankfurt": 5 },
        "EDDF Frankfurt",
        null,
      );

      expect(labels.features).toEqual([
        {
          type: "Feature",
          properties: {
            name: "EDDF Frankfurt",
            icao: "EDDF",
            count: 5,
            home: true,
          },
          geometry: { type: "Point", coordinates: [8.67, 50.1] },
        },
        {
          type: "Feature",
          properties: {
            name: "EDDM Munich",
            icao: "EDDM",
            count: 0,
            home: false,
          },
          geometry: { type: "Point", coordinates: [11.78, 48.35] },
        },
      ]);
    });

    it("leaves out the airports that are not shown", () => {
      const labels = airportLabelFeatures(
        airports,
        {},
        null,
        new Set(["EDDM Munich"]),
      );

      expect(labels.features.map((f) => f.properties.name)).toEqual([
        "EDDM Munich",
      ]);
    });
  });

  describe("chipImage", () => {
    const chip = chipImage();
    /** The alpha of the pixel at CSS pixel `x`, `y` of the image */
    const alpha = (x: number, y: number): number =>
      chip.data[(y * 2 * chip.width + x * 2) * 4 + 3]!;

    it("is a distance field of a rounded rectangle, at twice the resolution", () => {
      // 20 by 16 with 4 of room on each side, at a pixel ratio of 2
      expect(chip.width).toBe(56);
      expect(chip.height).toBe(48);
      expect(chip.data).toHaveLength(56 * 48 * 4);
      // Deep inside, well past the edge value of 3/4; far outside, nothing
      expect(alpha(14, 12)).toBe(255);
      expect(alpha(0, 0)).toBe(0);
      // Rising towards the middle across the edge
      expect(alpha(4, 12)).toBeGreaterThan(alpha(3, 12));
      expect(alpha(5, 12)).toBeGreaterThan(alpha(4, 12));
    });

    it("rounds its corners: a corner point lies further out than a side", () => {
      // Both one pixel inside the box, one at a corner, one mid side
      expect(alpha(5, 5)).toBeLessThan(alpha(14, 5));
    });
  });

  describe("addAirportLabelImages", () => {
    it("gives the map the chip as a stretchable distance field", () => {
      const map = createMapLibreMock();

      addAirportLabelImages(map as unknown as MapLibreMap);

      expect([...map.images.keys()]).toEqual(["airport-label-chip"]);
      const options = (map.addImage.mock.calls[0] as unknown[])[2] as {
        sdf: boolean;
        pixelRatio: number;
        stretchX: number[][];
        content: number[];
      };
      expect(options.sdf).toBe(true);
      expect(options.pixelRatio).toBe(2);
      expect(options.stretchX).toHaveLength(1);
      expect(options.content).toHaveLength(4);
    });

    it("gives the chip back when a new style dropped it, and no other image", () => {
      const map = createMapLibreMock();
      addAirportLabelImages(map as unknown as MapLibreMap);
      map.images.clear();

      map.emit("styleimagemissing", { id: "some-sprite-icon" });
      expect(map.images.size).toBe(0);

      map.emit("styleimagemissing", { id: "airport-label-chip" });
      expect([...map.images.keys()]).toEqual(["airport-label-chip"]);
    });
  });

  describe("setAirportLabelHover", () => {
    it("sets the hover state of the airport's label, by its name", () => {
      const map = createMapLibreMock();

      setAirportLabelHover(map as unknown as MapLibreMap, "EDDF", true);

      expect(map.setFeatureState).toHaveBeenCalledWith(
        { source: MAP_SOURCES.airportLabels, id: "EDDF" },
        { hover: true },
      );
    });

    it("does nothing before the map has the source", () => {
      const map = createMapLibreMock();
      map.removeSource(MAP_SOURCES.airportLabels);

      setAirportLabelHover(map as unknown as MapLibreMap, "EDDF", true);

      expect(map.setFeatureState).not.toHaveBeenCalled();
    });
  });
});
