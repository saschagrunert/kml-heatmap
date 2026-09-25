/**
 * The flight under the pointer, found among the layers and runs the layer
 * manager hands over (DrawnRuns), without a layer manager
 */
import { describe, it, expect, afterEach } from "vitest";
import type { Map as MapLibreMap, Point } from "maplibre-gl";
import {
  PathHover,
  type HoverRun,
  type RunsOnLayer,
} from "../../../../kml_heatmap/frontend/ui/pathHover";
import type {
  PathRunProperties,
  PathSegment,
} from "../../../../kml_heatmap/frontend/types";
import { createMapLibreMock, segmentOf } from "../../testHelpers";
import { resetMapLibreMock } from "../../../mocks/maplibre-gl";

describe("PathHover", () => {
  afterEach(() => resetMapLibreMock());

  /** Three segments east from 16 degrees at 48 north, 0.01 degrees each */
  const segments: PathSegment[] = [0, 1, 2].map((i) =>
    segmentOf({
      path_id: i < 2 ? 1 : 2,
      coords: [
        [48, 16 + i * 0.01],
        [48, 16 + (i + 1) * 0.01],
      ],
    }),
  );
  const runs: HoverRun[] = [
    { start: 0, end: 2, pathId: 1 },
    { start: 2, end: 3, pathId: 2 },
  ];

  /** A layer's runs, as the layer manager describes them */
  const onLayer = (fields: Partial<RunsOnLayer> = {}): RunsOnLayer => ({
    table: { runs, g: 1 },
    segments,
    selected: false,
    ribbon: false,
    only: null,
    ...fields,
  });

  function setup(
    layers: Record<string, RunsOnLayer>,
    stale = false,
  ): { hover: PathHover; map: ReturnType<typeof createMapLibreMock> } {
    const map = createMapLibreMock();
    map.jumpTo({ center: [16.015, 48], zoom: 12 });
    const hover = new PathHover(
      {
        map: map as unknown as MapLibreMap,
        wrappedVisible: false,
        reliefLevel: 0,
      },
      {
        readyMap: () => map as unknown as MapLibreMap,
        drawnRuns: () => ({ layers: new Map(Object.entries(layers)), stale }),
        describe: (segment) => `segment ${segments.indexOf(segment)}`,
      },
    );
    return { hover, map };
  }

  const pointAt = (
    map: ReturnType<typeof createMapLibreMock>,
    lat: number,
    lng: number,
  ): Point => map.project([lng, lat]) as unknown as Point;

  const rendered = (
    layer: string,
    properties: Partial<PathRunProperties>,
  ): unknown => ({ layer: { id: layer }, properties });

  it("finds the segment nearest to the pointer, of the run of the feature", () => {
    const { hover, map } = setup({ lines: onLayer() });
    map.renderedFeatures = [rendered("lines", { r: 0, g: 1 })];

    expect(hover.hitTest(pointAt(map, 48, 16.015))).toEqual({
      pathId: 1,
      segment: segments[1],
    });
  });

  it("finds nothing beside every flight, or stale while the tiles cannot tell", () => {
    expect(
      setup({ lines: onLayer() }).hover.hitTest({ x: 0, y: 0 } as Point),
    ).toBeNull();
    expect(
      setup({ lines: onLayer() }, true).hover.hitTest({ x: 0, y: 0 } as Point),
    ).toBe("stale");
    // No layer to look in at all
    expect(setup({}, true).hover.hitTest({ x: 0, y: 0 } as Point)).toBeNull();
  });

  it("takes a feature of an older generation for stale, not for a flight", () => {
    const { hover, map } = setup({ lines: onLayer() });
    map.renderedFeatures = [rendered("lines", { r: 0, g: 0 })];

    expect(hover.hitTest(pointAt(map, 48, 16.015))).toBe("stale");
  });

  it("leaves out a path an isolated selection does not show", () => {
    const { hover, map } = setup({ lines: onLayer({ only: new Set([2]) }) });
    map.renderedFeatures = [
      rendered("lines", { r: 0, g: 1 }),
      rendered("lines", { r: 1, g: 1 }),
    ];

    expect(hover.hitTest(pointAt(map, 48, 16.015))).toMatchObject({
      pathId: 2,
    });
  });

  it("gives a tie to the selection's layer, which is on top", () => {
    // The selection's layer draws the same flight, from runs and segments
    // of its own
    const copies = segments.map((segment) => ({ ...segment }));
    const { hover, map } = setup({
      lines: onLayer(),
      selection: onLayer({
        selected: true,
        segments: copies,
        table: { runs: runs.map((run) => ({ ...run })), g: 1 },
      }),
    });
    const point = pointAt(map, 48, 16.015);
    map.renderedFeatures = [
      rendered("lines", { r: 0, g: 1 }),
      rendered("selection", { r: 0, g: 1 }),
    ];

    const segmentHit = (): unknown => {
      const hit = hover.hitTest(point);
      return hit !== null && hit !== "stale" && hit.segment;
    };
    expect(segmentHit()).toBe(copies[1]);
    map.renderedFeatures.reverse();
    expect(segmentHit()).toBe(copies[1]);
  });
});
