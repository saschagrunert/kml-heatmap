import { describe, it, expect, afterEach } from "vitest";
import type { Map as MapLibreMap } from "maplibre-gl";
import {
  LIFT_MAX_ZOOM,
  LIFT_STEP_FT,
  TERRAIN_EXAGGERATION,
  TERRAIN_MIN_ZOOM,
  airplaneLiftPx,
  groundProfileFt,
  isLiftedAt,
  isTerrainAt,
  liftFt,
  liftOffsetPx,
  pointOnFlight,
  ribbonHeights,
  ribbonOf,
  ribbonPieces,
  smoothFlights,
  smoothLine,
} from "../../../../kml_heatmap/frontend/calculations/lift";
import { resetMapLibreMock } from "../../../mocks/maplibre-gl";
import {
  FEET_TO_METERS,
  METERS_TO_FEET,
} from "../../../../kml_heatmap/frontend/utils/constants";
import type { PathSegment } from "../../../../kml_heatmap/frontend/types";
import { createMapLibreMock } from "../../testHelpers";

const METRES_PER_DEGREE = 111320;

/** The zoom the ribbons of these tests are cut for */
const Z = 12;

/**
 * How wide a ribbon cut for Z is on the ground at `lat`, in metres: three
 * pixels in the middle of the level, of 512 pixel tiles
 */
const widthM = (lat: number): number =>
  ((3 * 40075016.686) / (512 * 2 ** (Z + 0.5))) *
  Math.cos((lat * Math.PI) / 180);

describe("lift", () => {
  afterEach(() => resetMapLibreMock());

  describe("groundProfileFt", () => {
    /** A segment of path 1 heading east from `lng`, 0.01 degrees long */
    const at = (
      lng: number,
      altitude_ft: number,
      groundspeed_knots: number | undefined,
      path_id = 1,
    ): PathSegment => ({
      path_id,
      altitude_ft,
      groundspeed_knots,
      coords: [
        [50, lng],
        [50, lng + 0.01],
      ],
    });
    /** A flight from a field at `from` ft to one at `to` ft, with a dip */
    const flight = (from: number, to: number): PathSegment[] => [
      at(8, from + 100, 5),
      at(8.01, from, 10),
      at(8.02, from, 8),
      at(8.03, 3000, 110),
      // A glitch of the recorder, far below both fields
      at(8.04, -600, 115),
      at(8.05, 3000, 110),
      at(8.06, to, 12),
      at(8.07, to, 6),
      at(8.08, to, 3),
    ];

    it("stands a flight on both of its fields, and slopes between them", () => {
      const ground = groundProfileFt(flight(400, 2000));

      // Taxiing on the map at both ends: the middle of the taxi altitudes
      expect(ground[0]).toBeCloseTo(400 + 1600 / 9, 6);
      expect(ground[8]).toBe(2000);
      expect(liftFt(2000, ground[8]!)).toBe(0);
      // In proportion to the distance flown, whatever the altitudes did
      for (let i = 1; i < 9; i++) {
        expect(ground[i]! - ground[i - 1]!).toBeCloseTo(1600 / 9, 6);
      }
    });

    it("keeps a glitch below the fields from taking the flight up", () => {
      const segments = flight(400, 400);
      const ground = groundProfileFt(segments);

      // The lowest part of its time would have been the glitch
      expect([...ground]).toEqual(segments.map(() => 400));
      expect(liftFt(segments[3]!.altitude_ft!, ground[3]!)).toBe(2600);
    });

    it("stands a flight that starts in the air on the field it landed on", () => {
      const ground = groundProfileFt(flight(400, 1200).slice(3));

      expect([...ground]).toEqual([1200, 1200, 1200, 1200, 1200, 1200]);
    });

    it("falls back to the lowest part of its time without speeds to tell", () => {
      const segments = [800, 800, 3000, 5000].map((altitude, i) =>
        at(8 + i / 100, altitude, undefined),
      );

      expect([...groundProfileFt(segments)]).toEqual([800, 800, 800, 800]);
    });

    it("measures the way flown across the antimeridian the short way", () => {
      // Taxiing at both fields, then two legs of the same length, the second
      // across the antimeridian: the ground slopes evenly along them
      const segment = (
        from: number,
        to: number,
        altitude_ft: number,
        groundspeed_knots: number,
      ): PathSegment => ({
        path_id: 1,
        altitude_ft,
        groundspeed_knots,
        coords: [
          [50, from],
          [50, to],
        ],
      });
      const segments = [
        segment(179.96, 179.97, 400, 5),
        segment(179.97, 179.98, 400, 5),
        segment(179.98, 179.99, 400, 5),
        segment(179.99, -179.99, 3000, 110),
        segment(-179.99, -179.98, 800, 5),
        segment(-179.98, -179.97, 800, 5),
        segment(-179.97, -179.96, 800, 5),
      ];

      const ground = groundProfileFt(segments);

      // Six legs of 0.01 degrees and one of 0.02: not one round the world
      for (const i of [1, 2, 4, 5, 6]) {
        expect(ground[i]! - ground[i - 1]!).toBeCloseTo(400 / 8, 6);
      }
      expect(ground[3]! - ground[2]!).toBeCloseTo(800 / 8, 6);
    });

    it("works out every flight on its own", () => {
      const segments = [
        ...flight(400, 400),
        ...flight(1000, 1000).map((segment) => ({ ...segment, path_id: 2 })),
      ];
      const ground = groundProfileFt(segments);

      expect(ground[0]).toBe(400);
      expect(ground[9]).toBe(1000);
    });

    it("takes the ground the build sampled where a flight has it", () => {
      const sampled = [420, 430, 400, 900, 1500, 1100, 2000, 2010, 2000];
      const segments = [
        ...flight(400, 2000).map((segment, i) => ({
          ...segment,
          ground_ft: sampled[i],
        })),
        ...flight(400, 400).map((segment) => ({ ...segment, path_id: 2 })),
      ];

      const ground = groundProfileFt(segments);

      // The relief under the first flight, the line between its fields
      // under the second
      expect([...ground.slice(0, 9)]).toEqual(sampled);
      expect([...ground.slice(9)]).toEqual(segments.slice(9).map(() => 400));
    });

    it("leaves the sampled ground out where the relief is not drawn", () => {
      const segments = flight(400, 2000).map((segment) => ({
        ...segment,
        ground_ft: 5000,
      }));

      expect([...groundProfileFt(segments, false)]).toEqual([
        ...groundProfileFt(flight(400, 2000)),
      ]);
    });

    it("falls back to its fields where the sampled ground has a gap", () => {
      const segments = flight(400, 2000).map((segment, i) =>
        i === 4 ? segment : { ...segment, ground_ft: 5000 },
      );

      expect([...groundProfileFt(segments)]).toEqual([
        ...groundProfileFt(flight(400, 2000)),
      ]);
    });
  });

  describe("liftFt", () => {
    it("is the height above the flight's ground", () => {
      expect(liftFt(1500, 300)).toBe(1200);
    });

    it("keeps a fix below the ground on it", () => {
      // A barometric glitch or a field lower than the one of the ground
      expect(liftFt(200, 300)).toBe(0);
    });
  });

  describe("ribbonPieces", () => {
    /** The quads of a flat ribbon along `points`, in order */
    const flat = (
      points: [number, number][],
      before?: [number, number],
      after?: [number, number],
    ): GeoJSON.MultiPolygon => {
      const pieces = ribbonPieces(
        points,
        points.map(() => 1000),
        Z,
        before,
        after,
      );
      expect(pieces).toHaveLength(1);
      return pieces[0]!.geometry;
    };
    /** The corners of the quad of segment `i`: left, left, right, right */
    const quad = (geometry: GeoJSON.MultiPolygon, i: number): number[][] =>
      geometry.coordinates[i]![0]!;
    const metresPerLng = (lat: number): number =>
      METRES_PER_DEGREE * Math.cos((lat * Math.PI) / 180);

    it("widens a straight segment to a closed quad a few pixels across", () => {
      const geometry = flat([
        [50, 8],
        [50, 8.01],
      ]);

      expect(geometry.type).toBe("MultiPolygon");
      const ring = quad(geometry, 0);
      expect(ring).toHaveLength(5);
      expect(ring[0]).toEqual(ring[4]);
      // Due east: widened north and south, to the left first
      const [left, , , right] = ring;
      expect(left![0]).toBeCloseTo(8, 9);
      expect((left![1]! - right![1]!) * METRES_PER_DEGREE).toBeCloseTo(
        widthM(50),
        6,
      );
    });

    it("widens a segment due north east and west, by the width in metres", () => {
      const [left, , , right] = quad(
        flat([
          [50, 8],
          [50.01, 8],
        ]),
        0,
      );

      expect(left![1]).toBeCloseTo(50, 9);
      expect((right![0]! - left![0]!) * metresPerLng(50)).toBeCloseTo(
        widthM(50),
        6,
      );
    });

    it("is as many pixels wide at every latitude, as Mercator draws it", () => {
      const across = (lat: number): number => {
        const [left, , , right] = quad(
          flat([
            [lat, 8],
            [lat, 8.01],
          ]),
          0,
        );
        return (left![1]! - right![1]!) * METRES_PER_DEGREE;
      };

      // Narrower on the ground by as much as Mercator enlarges it there
      expect(across(60) / across(0)).toBeCloseTo(Math.cos(Math.PI / 3), 3);
    });

    it("shares the corners of neighbouring quads, so a bend has no gap", () => {
      const geometry = flat([
        [50, 8],
        [50, 8.01],
        [50.01, 8.01],
      ]);

      expect(geometry.coordinates).toHaveLength(2);
      // The end of the first quad is the start of the second, on both sides
      expect(quad(geometry, 0)[1]).toEqual(quad(geometry, 1)[0]);
      expect(quad(geometry, 0)[2]).toEqual(quad(geometry, 1)[3]);
    });

    it("mitres a right angle: the corner lies √2 half widths out", () => {
      const geometry = flat([
        [50, 8],
        [50, 8.01],
        [50.01, 8.01],
      ]);
      const [, corner] = quad(geometry, 0);
      const dx = (corner![0]! - 8.01) * metresPerLng(50);
      const dy = (corner![1]! - 50) * METRES_PER_DEGREE;

      expect(Math.hypot(dx, dy)).toBeCloseTo((widthM(50) / 2) * Math.SQRT2, 3);
    });

    it("caps the corner of a hairpin", () => {
      const geometry = flat([
        [50, 8],
        [50, 8.01],
        [50.0001, 8],
      ]);
      const [, corner] = quad(geometry, 0);
      const dx = (corner![0]! - 8.01) * metresPerLng(50);
      const dy = (corner![1]! - 50) * METRES_PER_DEGREE;

      expect(Math.hypot(dx, dy)).toBeLessThanOrEqual(1.5 * widthM(50) + 1e-6);
    });

    it("mitres its ends into the line it continues from and to", () => {
      const alone = flat([
        [50, 8.01],
        [50.01, 8.01],
      ]);
      const joined = flat(
        [
          [50, 8.01],
          [50.01, 8.01],
        ],
        [50, 8],
      );
      const onItsOwn = flat([
        [50, 8],
        [50, 8.01],
        [50.01, 8.01],
      ]);

      expect(quad(joined, 0)[0]).not.toEqual(quad(alone, 0)[0]);
      // The same corner the whole line gives the bend
      expect(quad(joined, 0)[0]).toEqual(quad(onItsOwn, 1)[0]);
    });

    it("keeps a level stretch in one piece at its height", () => {
      const pieces = ribbonPieces(
        [
          [50, 8],
          [50, 8.01],
          [50, 8.02],
        ],
        [1000, 1000, 1000],
        Z,
      );

      expect(pieces.map((piece) => piece.h)).toEqual([1000]);
      expect(pieces[0]!.geometry.coordinates).toHaveLength(2);
    });

    it("cuts a climb into pieces a step apart that slope with it", () => {
      const pieces = ribbonPieces(
        [
          [50, 8],
          [50, 8.01],
        ],
        [1000, 1100],
        Z,
      );

      // 100 ft in steps of 20: five pieces, each at the height of its middle
      expect(pieces.map((piece) => piece.h)).toEqual([
        1010, 1030, 1050, 1070, 1090,
      ]);
      // Laid end to end along the segment, without a gap
      const quads = pieces.flatMap((piece) => piece.geometry.coordinates);
      for (let i = 1; i < quads.length; i++) {
        expect(quads[i]![0]![0]).toEqual(quads[i - 1]![0]![1]);
      }
      expect(quads[0]![0]![0]![0]).toBeCloseTo(8, 9);
      expect(quads[quads.length - 1]![0]![1]![0]).toBeCloseTo(8.01, 9);
    });

    it("cuts a slope into no piece taller than a step", () => {
      const heights = ribbonPieces(
        [
          [50, 8],
          [50, 8.01],
        ],
        [0, 30],
        Z,
      ).map((piece) => piece.h);

      expect(heights).toEqual([7.5, 22.5]);
      expect(30 / heights.length).toBeLessThanOrEqual(LIFT_STEP_FT);
    });

    it("gives a segment without length a quad instead of dividing by zero", () => {
      const geometry = flat([
        [50, 8],
        [50, 8],
      ]);

      for (const point of quad(geometry, 0)) {
        expect(Number.isFinite(point[0])).toBe(true);
        expect(Number.isFinite(point[1])).toBe(true);
      }
    });
  });

  describe("smoothLine", () => {
    /** Three points with a right angle in the middle, level at 1000 ft */
    const corner: [number, number][] = [
      [50, 8],
      [50, 8.01],
      [50.01, 8.01],
    ];

    it("keeps the logged points, and a straight line as it is", () => {
      const line = smoothLine(
        [
          [50, 8],
          [50, 8.01],
          [50, 8.02],
        ],
        [0, 100, 200],
      );

      expect(line.points).toEqual([
        [50, 8],
        [50, 8.01],
        [50, 8.02],
      ]);
      expect(line.vertex).toEqual([0, 1, 2]);
      expect(line.heights).toEqual([0, 100, 200]);
    });

    it("spreads a height that jumps over a few metres into a slope", () => {
      // 600 ft between two fixes 7 m apart: the altitude settling while
      // the aircraft rolls, which would stand as a tower of pieces
      const line = smoothLine(
        [
          [50, 8],
          [50, 8.0001],
          [50, 8.01],
        ],
        [0, 600, 600],
      );

      // No steeper than 0.3 ft per ft, and at the top by the next fix
      const metres = 0.0001 * 111320 * Math.cos((50 * Math.PI) / 180);
      expect(line.heights[1]).toBeCloseTo(metres * METERS_TO_FEET * 0.3, 6);
      expect(line.heights[2]).toBe(600);
    });

    it("leaves a real climb as it is", () => {
      // 500 ft over 2.4 km, like a light aircraft after takeoff
      const heights = smoothLine(
        [
          [50, 8],
          [50, 8.0333],
        ],
        [0, 500],
      ).heights;

      expect(heights).toEqual([0, 500]);
    });

    it("rounds a turn with points along a curve through the logged ones", () => {
      const line = smoothLine(corner, [1000, 1000, 1000]);

      expect(line.points.length).toBeGreaterThan(3);
      // The logged points are where they were, in order
      expect(line.vertex.map((v) => line.points[v])).toEqual(corner);
      expect(line.vertex).toEqual([...line.vertex].sort((a, b) => a - b));
      // A curve through the corner itself swings out a little before and
      // after it, here less than 100 m on legs of 716 m and 1,113 m: it
      // does not loop
      const outside = (value: number, low: number, high: number): number =>
        Math.max(low - value, value - high, 0);
      for (const [lat, lng] of line.points) {
        expect(outside(lat, 50, 50.01) * 111320).toBeLessThan(100);
        expect(
          outside(lng, 8, 8.01) *
            METRES_PER_DEGREE *
            Math.cos((50 * Math.PI) / 180),
        ).toBeLessThan(100);
      }
    });

    it("cuts a turn a point per so many degrees of it", () => {
      // About 20 degrees of turn at each fix
      const points: [number, number][] = [
        [50, 8],
        [50.001, 8],
        [50.002, 8.0006],
        [50.0028, 8.0014],
      ];
      const coarse = smoothLine(points, [0, 0, 0, 0]);
      const fine = smoothLine(points, [0, 0, 0, 0], {
        turnStepDeg: 4,
      });

      // Twice as many points between the fixes at the flat lines' 4
      // degrees as at the ribbons' 8
      expect(fine.points.length - 4).toBeGreaterThanOrEqual(
        2 * (coarse.points.length - 4),
      );
      // Through the logged points all the same
      expect(fine.vertex.map((v) => fine.points[v])).toEqual(points);
    });

    it("holds altitudes to the slope before it takes the ground off", () => {
      // Level at 3,000 ft over a ridge that rises 2,000 ft between two
      // fixes 700 m apart, far steeper than any climb
      const points: [number, number][] = [
        [50, 8],
        [50, 8.01],
        [50, 8.02],
      ];
      const line = smoothLine(points, [3000, 3000, 3000], {
        ground: [500, 2500, 500],
      });

      // Over the ground the flight has its full height, on the ridge too
      expect(line.heights).toEqual([2500, 500, 2500]);
      // Measured from the ground instead, the slope would hold it up there
      expect(smoothLine(points, [2500, 500, 2500]).heights[1]).toBeGreaterThan(
        500,
      );
    });

    it("never takes a flight below its ground", () => {
      const line = smoothLine(
        [
          [50, 8],
          [50, 8.01],
        ],
        [400, 1000],
        { ground: [600, 600] },
      );

      expect(line.heights).toEqual([0, 400]);
    });

    it("eases a climb in and out without going beyond its heights", () => {
      const line = smoothLine(
        [
          [50, 8],
          [50, 8.01],
          [50.01, 8.01],
          [50.01, 8.02],
        ],
        [0, 0, 300, 300],
      );

      for (const h of line.heights) {
        expect(h).toBeGreaterThanOrEqual(0);
        expect(h).toBeLessThanOrEqual(300);
      }
      const between = line.heights.slice(line.vertex[1], line.vertex[2]! + 1);
      expect(between).toEqual([...between].sort((a, b) => a - b));
    });
  });

  describe("smoothFlights and ribbonOf", () => {
    const segment = (
      path_id: number,
      from: [number, number],
      to: [number, number],
    ): { path_id: number; coords: [[number, number], [number, number]] } => ({
      path_id,
      coords: [from, to],
    });

    it("smooths each flight as one chain and knows each segment's place on it", () => {
      const segments = [
        segment(1, [50, 8], [50, 8.01]),
        segment(1, [50, 8.01], [50.01, 8.01]),
        // Another flight, which is a chain of its own
        segment(2, [52, 10], [52, 10.01]),
      ];

      const flights = smoothFlights(segments, () => 500);

      expect(flights.chains).toHaveLength(2);
      expect([...flights.chainOf]).toEqual([0, 0, 1]);
      // The first segment ends where the second starts
      expect(flights.to[0]).toBe(flights.from[1]);
      expect(flights.from[0]).toBe(0);
    });

    it("carries a flight on across the antimeridian, without a curve round the world", () => {
      const segments = [
        segment(1, [60, 179.98], [60, 179.99]),
        segment(1, [60, 179.99], [60, -179.99]),
        segment(1, [60, -179.99], [60, -179.98]),
      ];

      const [chain] = smoothFlights(segments, () => 500).chains;

      // A straight line: no point is added along it, and the longitudes go
      // on past 180
      expect(chain!.points.map(([, lng]) => lng)).toEqual([
        179.98,
        179.99,
        expect.closeTo(180.01, 9),
        expect.closeTo(180.02, 9),
      ]);
    });

    it("leaves a segment without coordinates out of every chain", () => {
      const flights = smoothFlights(
        [{ path_id: 1 }, segment(1, [50, 8], [50, 8.01])],
        () => 0,
      );

      expect([...flights.chainOf]).toEqual([-1, 0]);
    });

    it("cuts ribbons that meet their neighbours corner to corner", () => {
      const segments = [
        segment(1, [50, 8], [50, 8.01]),
        segment(1, [50, 8.01], [50.01, 8.01]),
        segment(1, [50.01, 8.01], [50.01, 8.02]),
      ];
      const flights = smoothFlights(segments, () => 500);

      const first = ribbonOf(flights, 0, 1, Z);
      const rest = ribbonOf(flights, 1, 3, Z);

      const lastQuad = first.at(-1)!.geometry.coordinates.at(-1)![0]!;
      const firstQuad = rest[0]!.geometry.coordinates[0]![0]!;
      // The end of the one is the start of the other, on both edges
      expect(firstQuad[0]).toEqual(lastQuad[1]);
      expect(firstQuad[3]).toEqual(lastQuad[2]);
    });

    it("finds a place on a segment's curve, at its height there", () => {
      const segments = [
        segment(1, [50, 8], [50, 8.01]),
        segment(1, [50, 8.01], [50.01, 8.01]),
        segment(1, [50.01, 8.01], [50.01, 8.02]),
      ];
      const heights = [0, 100, 100];
      const flights = smoothFlights(segments, (i) => heights[i]!);
      const chain = flights.chains[0]!;

      // The ends of a segment are its logged points
      expect(pointOnFlight(flights, 1, 0)!.position).toEqual([50, 8.01]);
      expect(pointOnFlight(flights, 1, 1)!.position).toEqual([50.01, 8.01]);
      expect(pointOnFlight(flights, 1, 1)!.heightFt).toBe(100);
      // In between it is on the curve the ribbon is cut from, which the
      // turns have cut into more points than the segment has
      expect(flights.to[1]! - flights.from[1]!).toBeGreaterThan(1);
      const middle = pointOnFlight(flights, 1, 0.5)!;
      const onCurve = chain.points.slice(flights.from[1], flights.to[1]! + 1);
      const nearest = Math.min(
        ...onCurve.map(([lat, lng]) =>
          Math.hypot(lat - middle.position[0], lng - middle.position[1]),
        ),
      );
      expect(nearest).toBeLessThan(0.003);
      expect(middle.heightFt).toBeGreaterThanOrEqual(0);
      expect(middle.heightFt).toBeLessThanOrEqual(100);
      // Out of range, it keeps to the segment's ends
      expect(pointOnFlight(flights, 1, 2)).toEqual(
        pointOnFlight(flights, 1, 1),
      );
    });

    it("finds no place on a segment without coordinates", () => {
      const flights = smoothFlights([{ path_id: 1 }], () => 0);

      expect(pointOnFlight(flights, 0, 0.5)).toBeNull();
    });
  });

  describe("ribbonHeights", () => {
    it("interpolates on the zoom at the top, with the height inside every stop", () => {
      const { base, height } = ribbonHeights();

      for (const expression of [base, height]) {
        expect(expression.slice(0, 3)).toEqual([
          "interpolate",
          ["linear"],
          ["zoom"],
        ]);
        // Down to a map of half of Europe
        expect(expression[3]).toBeLessThanOrEqual(4);
        expect(JSON.stringify(expression)).toContain('["get","h"]');
      }
    });

    it("exaggerates the heights more zoomed out, and gives each piece its step and a band", () => {
      const { base, height } = ribbonHeights();
      /** What an expression of one stop comes to for a feature at `h` */
      const evaluate = (expression: unknown, h: number): number => {
        if (typeof expression === "number") return expression;
        const [op, ...args] = expression as [string, ...unknown[]];
        if (op === "get") return h;
        const values = args.map((arg) => evaluate(arg, h));
        if (op === "*") return values[0]! * values[1]!;
        if (op === "+") return values[0]! + values[1]!;
        if (op === "-") return values[0]! - values[1]!;
        if (op === "max") return Math.max(values[0]!, values[1]!);
        throw new Error(`unknown expression "${op}"`);
      };
      const stops = (expression: unknown[]): unknown[] =>
        expression.slice(3).filter((_, i) => i % 2 === 1);

      // 1,000 ft more zoomed out stands taller, and never at true scale
      const bottoms = stops(base).map((stop) => evaluate(stop, 1000));
      expect(bottoms).toEqual([...bottoms].sort((a, b) => b - a));
      expect(bottoms[bottoms.length - 1]).toBeGreaterThan(304.8);
      // A piece reaches half a step below its middle and half above, and
      // a band beyond: the pieces of a slope meet
      stops(base).forEach((stop, i) => {
        const top = evaluate(stops(height)[i], 1000);
        const nextBottom = evaluate(stop, 1000 + LIFT_STEP_FT);
        expect(top).toBeGreaterThan(nextBottom);
      });
      // Never below the ground
      for (const stop of stops(base)) expect(evaluate(stop, 0)).toBe(0);
    });
  });

  describe("isLiftedAt and airplaneLiftPx", () => {
    it("lifts the flights up to the zoom where the camera is lower than a circuit", () => {
      expect(isLiftedAt(3)).toBe(true);
      expect(isLiftedAt(LIFT_MAX_ZOOM - 0.01)).toBe(true);
      expect(isLiftedAt(LIFT_MAX_ZOOM)).toBe(false);
    });

    it("puts the airplane on the ground where the trail is its line again", () => {
      const map = createMapLibreMock() as unknown as MapLibreMap;
      map.jumpTo({ zoom: 12, pitch: 60 });

      expect(airplaneLiftPx(map, 50, 1000)).toBeGreaterThan(0);
      expect(airplaneLiftPx(map, 50, 1000, LIFT_MAX_ZOOM)).toBe(0);
      expect(airplaneLiftPx(map, 50, null)).toBe(0);
    });
  });

  describe("isTerrainAt", () => {
    it("draws the relief from the whole level TERRAIN_MIN_ZOOM in", () => {
      expect(isTerrainAt(TERRAIN_MIN_ZOOM - 0.01)).toBe(false);
      expect(isTerrainAt(TERRAIN_MIN_ZOOM)).toBe(true);
      expect(isTerrainAt(LIFT_MAX_ZOOM + 2)).toBe(true);
    });
  });

  describe("liftOffsetPx", () => {
    const map = (): MapLibreMap =>
      createMapLibreMock() as unknown as MapLibreMap;

    it("takes no room on a flat map", () => {
      const flat = map();
      flat.jumpTo({ zoom: 12, pitch: 0 });

      expect(liftOffsetPx(flat, 51, 1000)).toBe(0);
    });

    it("grows with the height, the tilt and the zoom", () => {
      const tilted = map();
      tilted.jumpTo({ zoom: 12, pitch: 60 });
      const at1000 = liftOffsetPx(tilted, 51, 1000);
      expect(at1000).toBeGreaterThan(0);
      expect(liftOffsetPx(tilted, 51, 2000)).toBeCloseTo(at1000 * 2, 6);

      tilted.jumpTo({ zoom: 12, pitch: 30 });
      expect(liftOffsetPx(tilted, 51, 1000)).toBeLessThan(at1000);

      tilted.jumpTo({ zoom: 14, pitch: 60 });
      expect(liftOffsetPx(tilted, 51, 1000)).toBeGreaterThan(at1000);
    });

    it("holds the exaggeration of the first and the last stop beyond them", () => {
      const tilted = map();
      /** Pixels of 1,000 ft at `zoom`, over those of the same exaggeration */
      const exaggeration = (zoom: number): number => {
        tilted.jumpTo({ zoom, pitch: 90 });
        const metresPerPixel =
          (40075016.686 * Math.cos((51 * Math.PI) / 180)) / (512 * 2 ** zoom);
        return (
          (liftOffsetPx(tilted, 51, 1000) * metresPerPixel) /
          (1000 * FEET_TO_METERS)
        );
      };

      // Below the first stop, at zoom 4, and above the last, at zoom 16
      expect(exaggeration(2)).toBeCloseTo(60, 6);
      expect(exaggeration(4)).toBeCloseTo(60, 6);
      expect(exaggeration(19)).toBeCloseTo(TERRAIN_EXAGGERATION, 6);
      // Between two stops, linear
      expect(exaggeration(5)).toBeCloseTo((60 + 25) / 2, 6);
    });

    it("exaggerates the heights as much as the relief where it is drawn", () => {
      const tilted = map();
      for (const zoom of [TERRAIN_MIN_ZOOM, 11.5, 13, 16]) {
        tilted.jumpTo({ zoom, pitch: 90 });
        const metresPerPixel =
          (40075016.686 * Math.cos((51 * Math.PI) / 180)) / (512 * 2 ** zoom);

        expect(
          (liftOffsetPx(tilted, 51, 1000) * metresPerPixel) /
            (1000 * FEET_TO_METERS),
        ).toBeCloseTo(TERRAIN_EXAGGERATION, 6);
      }
    });

    it("draws 1,000 ft about as the ribbons do at zoom 13", () => {
      const tilted = map();
      tilted.jumpTo({ zoom: 13, pitch: 90 });
      // Twice exaggerated at zoom 13, about 609.6 m, over the metres of a pixel
      const metresPerPixel =
        (40075016.686 * Math.cos((51 * Math.PI) / 180)) / (512 * 2 ** 13);

      expect(liftOffsetPx(tilted, 51, 1000)).toBeCloseTo(
        (2000 * FEET_TO_METERS) / metresPerPixel,
        3,
      );
    });
  });
});
