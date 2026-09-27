/**
 * The custom layer of the heat cloud, with the WebGL context mocked: what it
 * makes, when, what it draws, and what it lets go of; its shadow, its
 * pulses and its exposure.
 */
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type Mock,
} from "vitest";
import type { CustomRenderMethodInput, Map as MapLibreMap } from "maplibre-gl";
import {
  CLOUD_STOPS,
  cloudExposure,
  cloudLook,
  HEAT_CLOUD_LAYER,
  HeatCloudLayer,
  type HeatCloudStyle,
} from "../../../../kml_heatmap/frontend/ui/heatCloudLayer";
import { cloudMatrix } from "../../../../kml_heatmap/frontend/ui/glLayer";
import {
  cloudPoints,
  type CloudPoints,
} from "../../../../kml_heatmap/frontend/calculations/heatCloud";
import { smoothFlights } from "../../../../kml_heatmap/frontend/calculations/smoothing";
import type { PathSegment } from "../../../../kml_heatmap/frontend/types";

const motion = vi.hoisted(() => ({ reduced: false }));
vi.mock("../../../../kml_heatmap/frontend/utils/motion", () => ({
  prefersReducedMotion: () => motion.reduced,
}));

/** A WebGL2 context that records what is asked of it */
function mockGl(compiles = true) {
  let objects = 0;
  const made = (kind: string) => vi.fn(() => ({ kind, n: objects++ }));
  const gl = {
    drawingBufferWidth: 800,
    drawingBufferHeight: 600,
    VERTEX_SHADER: 1,
    FRAGMENT_SHADER: 2,
    COMPILE_STATUS: 3,
    LINK_STATUS: 4,
    ARRAY_BUFFER: 5,
    STATIC_DRAW: 6,
    FLOAT: 7,
    BLEND: 8,
    ONE: 9,
    ONE_MINUS_SRC_COLOR: 10,
    ONE_MINUS_SRC_ALPHA: 11,
    DEPTH_TEST: 12,
    CULL_FACE: 13,
    STENCIL_TEST: 14,
    TRIANGLE_STRIP: 15,
    createBuffer: made("buffer"),
    createVertexArray: made("vao"),
    createProgram: made("program"),
    createShader: made("shader"),
    shaderSource: vi.fn(),
    compileShader: vi.fn(),
    getShaderParameter: vi.fn(() => compiles),
    getShaderInfoLog: vi.fn(() => "ERROR: 0:1: nonsense"),
    attachShader: vi.fn(),
    deleteShader: vi.fn(),
    bindAttribLocation: vi.fn(),
    linkProgram: vi.fn(),
    getProgramParameter: vi.fn(() => true),
    getProgramInfoLog: vi.fn(() => ""),
    getUniformLocation: vi.fn((_program: unknown, name: string) => ({ name })),
    bindVertexArray: vi.fn(),
    bindBuffer: vi.fn(),
    bufferData: vi.fn(),
    enableVertexAttribArray: vi.fn(),
    vertexAttribPointer: vi.fn(),
    vertexAttribDivisor: vi.fn(),
    useProgram: vi.fn(),
    uniformMatrix4fv: vi.fn(),
    uniform1f: vi.fn(),
    uniform2f: vi.fn(),
    uniform3f: vi.fn(),
    uniform4f: vi.fn(),
    uniform4fv: vi.fn(),
    enable: vi.fn(),
    disable: vi.fn(),
    blendFuncSeparate: vi.fn(),
    depthMask: vi.fn(),
    drawArraysInstanced: vi.fn(),
    deleteBuffer: vi.fn(),
    deleteVertexArray: vi.fn(),
    deleteProgram: vi.fn(),
    isContextLost: vi.fn(() => false),
  };
  return gl;
}

type MockGl = ReturnType<typeof mockGl>;

/** What MapLibre hands a custom layer for a frame, in Mercator or on the globe */
function frame(globe = false): CustomRenderMethodInput {
  const identity = new Float64Array([
    1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
  ]);
  const projection = new Float64Array(identity);
  projection[10] = -1.01;
  projection[14] = -2.5;
  return {
    farZ: 1000,
    nearZ: 1,
    fov: 0.6435,
    modelViewProjectionMatrix: identity,
    projectionMatrix: projection,
    shaderData: {
      variantName: globe ? "globe" : "mercator",
      vertexShaderPrelude: "uniform mat4 u_projection_matrix;",
      define: globe ? "#define GLOBE" : "",
    },
    defaultProjectionData: {
      mainMatrix: new Float64Array(identity),
      fallbackMatrix: new Float64Array(identity),
      tileMercatorCoords: [0, 0, 1, 1],
      clippingPlane: [1, 0, 0, 0],
      projectionTransition: globe ? 1 : 0,
      clipAntimeridian: false,
    },
    getProjectionData: vi.fn(),
  } as unknown as CustomRenderMethodInput;
}

function mockMap(): MapLibreMap & {
  triggerRepaint: Mock;
  emit: (type: string) => void;
} {
  const listeners = new Map<string, Set<() => void>>();
  return {
    on: vi.fn((type: string, listener: () => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    }),
    off: vi.fn((type: string, listener: () => void) => {
      listeners.get(type)?.delete(listener);
    }),
    emit: (type: string) => {
      for (const listener of listeners.get(type) ?? []) listener();
    },
    getCenter: vi.fn(() => ({ lng: 11, lat: 47 })),
    getZoom: vi.fn(() => 8),
    getPixelRatio: vi.fn(() => 2),
    getCenterElevation: vi.fn(() => 500),
    triggerRepaint: vi.fn(),
  } as unknown as MapLibreMap & {
    triggerRepaint: Mock;
    emit: (type: string) => void;
  };
}

/** Points of a flight of five fixes, a stretch between each */
function points(): CloudPoints {
  const fixes: [number, number][] = [0, 1, 2, 3, 4].map((i) => [
    47,
    11 + i * 0.01,
  ]);
  const segments: PathSegment[] = fixes.slice(1).map((to, i) => ({
    path_id: 1,
    coords: [fixes[i]!, to],
    altitude_ft: 3000,
    groundspeed_knots: 100,
    time: i * 5,
  }));
  const flights = smoothFlights(segments, (i) => segments[i]!.altitude_ft, {
    groundOf: () => 0,
  });
  return cloudPoints(segments, flights, () => true, 11);
}

const STYLE: HeatCloudStyle = {
  groundM: 3,
  liftM: 3,
  opacity: 1,
  flow: true,
};

/** The draws of a frame of STYLE: the shadow, then the glow */
const PASSES = 2;

describe("the heat cloud's layer", () => {
  let gl: MockGl;
  let map: ReturnType<typeof mockMap>;
  let style: HeatCloudStyle | null;
  let failed: Mock;
  let layer: HeatCloudLayer;

  const render = (options = frame()): void =>
    layer.render(gl as unknown as WebGL2RenderingContext, options);

  /** What performance.now says, in milliseconds */
  let now: number;

  /** Every value given to a uniform, with its place in the calls */
  const given = (): [name: string, at: number, values: number[]][] =>
    [gl.uniform1f, gl.uniform2f, gl.uniform4f].flatMap((fn) =>
      fn.mock.calls.map(
        (call, k) =>
          [
            (call[0] as { name: string }).name,
            fn.mock.invocationCallOrder[k]!,
            call.slice(1) as number[],
          ] as [string, number, number[]],
      ),
    );

  /** The value the uniform `name` was last given before the call `before` */
  const uniform = (name: string, before = Infinity): number[] => {
    let last = -1;
    let value: number[] = [];
    for (const [of, at, values] of given()) {
      if (of === name && at < before && at > last) {
        last = at;
        value = values;
      }
    }
    return value;
  };

  /** The values the uniform `name` had in the draws of the last frame */
  const perDraw = (name: string): number[][] =>
    gl.drawArraysInstanced.mock.invocationCallOrder
      .slice(-PASSES)
      .map((draw) => uniform(name, draw));

  beforeEach(() => {
    gl = mockGl();
    map = mockMap();
    style = STYLE;
    failed = vi.fn();
    motion.reduced = false;
    now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    layer = new HeatCloudLayer(() => style, failed);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is a 3D custom layer of its own id", () => {
    expect(layer.id).toBe(HEAT_CLOUD_LAYER);
    expect(layer.type).toBe("custom");
    expect(layer.renderingMode).toBe("3d");
  });

  it("makes nothing in the context as it is added, where MapLibre does not expect it", () => {
    layer.onAdd(map);
    for (const [name, fn] of Object.entries(gl)) {
      if (typeof fn === "function") expect(fn, name).not.toHaveBeenCalled();
    }
  });

  it("draws nothing without points, or where the app says not to", () => {
    layer.onAdd(map);
    render();
    expect(gl.drawArraysInstanced).not.toHaveBeenCalled();

    layer.setPoints(points());
    style = null;
    render();
    style = { ...STYLE, opacity: 0 };
    render();
    expect(gl.drawArraysInstanced).not.toHaveBeenCalled();
    expect(layer.frames).toBe(0);
    expect(layer.drawn).toBe(0);
  });

  it("asks the map for a frame as it gets new points", () => {
    layer.onAdd(map);
    layer.setPoints(points());
    expect(map.triggerRepaint).toHaveBeenCalled();
  });

  it("draws a quad per stretch, additively and without writing the depth, and counts it", () => {
    const cloud = points();
    layer.onAdd(map);
    layer.setPoints(cloud);
    render();

    expect(gl.drawArraysInstanced).toHaveBeenCalledTimes(PASSES);
    expect(gl.drawArraysInstanced).toHaveBeenLastCalledWith(
      gl.TRIANGLE_STRIP,
      0,
      4,
      cloud.count - 1,
    );
    expect(gl.blendFuncSeparate).toHaveBeenCalledWith(
      gl.ONE,
      gl.ONE_MINUS_SRC_COLOR,
      gl.ONE,
      gl.ONE_MINUS_SRC_ALPHA,
    );
    expect(gl.enable).toHaveBeenCalledWith(gl.DEPTH_TEST);
    expect(gl.depthMask).toHaveBeenCalledWith(false);
    // Its vertex array is not left bound for MapLibre's next draw
    expect(gl.bindVertexArray).toHaveBeenLastCalledWith(null);
    expect(layer.frames).toBe(1);
    expect(layer.drawn).toBe(cloud.count - 1);
  });

  it("makes its buffers and compiles its shaders once, and uploads the points once", () => {
    const cloud = points();
    layer.onAdd(map);
    layer.setPoints(cloud);
    render();
    render();
    render();

    expect(gl.createVertexArray).toHaveBeenCalledOnce();
    expect(gl.createProgram).toHaveBeenCalledOnce();
    const uploads = gl.bufferData.mock.calls.filter(
      ([, data]) => data === cloud.points,
    );
    expect(uploads).toHaveLength(1);

    const next = points();
    layer.setPoints(next);
    render();
    expect(
      gl.bufferData.mock.calls.filter(([, data]) => data === next.points),
    ).toHaveLength(1);
    expect(gl.drawArraysInstanced).toHaveBeenCalledTimes(4 * PASSES);
  });

  it("builds its vertex shader on MapLibre's prelude for the projection, and a program per projection", () => {
    layer.onAdd(map);
    layer.setPoints(points());
    render(frame(false));
    render(frame(true));
    render(frame(true));

    expect(gl.createProgram).toHaveBeenCalledTimes(2);
    const vertexSources = gl.shaderSource.mock.calls
      .map(([, source]) => source as string)
      .filter((source) => source.includes("projectTileFor3D"));
    expect(vertexSources).toHaveLength(2);
    for (const source of vertexSources) {
      expect(
        source.startsWith("#version 300 es\nuniform mat4 u_projection_matrix;"),
      ).toBe(true);
    }
    expect(vertexSources[1]).toContain("#define GLOBE");
  });

  it("hands the globe its own matrix, and the flat map's for the way into it", () => {
    const cloud = points();
    layer.onAdd(map);
    layer.setPoints(cloud);
    render(frame(true));

    const matrices = new Map(
      gl.uniformMatrix4fv.mock.calls.map(([location, , matrix]) => [
        (location as { name: string }).name,
        matrix as Float32Array,
      ]),
    );
    expect([...matrices.get("u_projection_matrix")!]).toEqual([
      1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
    ]);
    expect(matrices.get("u_projection_fallback_matrix")).toBeDefined();
    expect(gl.uniform4f).toHaveBeenCalledWith(
      { name: "u_projection_tile_mercator_coords" },
      cloud.origin[0],
      cloud.origin[1],
      1,
      1,
    );
  });

  it("gives up on shaders that do not compile, says so once, and leaves the map as it is", () => {
    gl = mockGl(false);
    layer.onAdd(map);
    layer.setPoints(points());
    render();
    render();

    expect(failed).toHaveBeenCalledOnce();
    expect(String(failed.mock.calls[0]![0])).toContain("did not compile");
    expect(gl.drawArraysInstanced).not.toHaveBeenCalled();
    expect(gl.createShader).toHaveBeenCalledOnce();
  });

  it("lets go of what it made as it is removed", () => {
    layer.onAdd(map);
    layer.setPoints(points());
    render();
    layer.onRemove(map, gl as unknown as WebGL2RenderingContext);

    expect(gl.deleteBuffer).toHaveBeenCalledTimes(2);
    expect(gl.deleteVertexArray).toHaveBeenCalledOnce();
    expect(gl.deleteProgram).toHaveBeenCalledOnce();
  });

  it("does not touch a context that was lost", () => {
    layer.onAdd(map);
    layer.setPoints(points());
    render();
    gl.isContextLost.mockReturnValue(true);
    layer.onRemove(map, gl as unknown as WebGL2RenderingContext);
    expect(gl.deleteBuffer).not.toHaveBeenCalled();
  });

  it("makes everything anew in the context MapLibre gets back after a loss, which is the same object", () => {
    layer.onAdd(map);
    layer.setPoints(points());
    render();
    map.emit("webglcontextlost");
    // MapLibre removes the layer with the style of before, and the app adds
    // it again to the one it gets back (see ui/heatCloud.ts)
    layer.onRemove(map, gl as unknown as WebGL2RenderingContext);
    expect(gl.deleteBuffer).not.toHaveBeenCalled();
    gl.createVertexArray.mockClear();
    gl.createProgram.mockClear();
    gl.drawArraysInstanced.mockClear();
    layer.onAdd(map);
    render();

    expect(gl.createVertexArray).toHaveBeenCalledOnce();
    expect(gl.createProgram).toHaveBeenCalledOnce();
    expect(gl.drawArraysInstanced).toHaveBeenCalledTimes(PASSES);
  });

  it("makes everything anew in another context", () => {
    layer.onAdd(map);
    layer.setPoints(points());
    render();
    const other = mockGl();
    layer.render(other as unknown as WebGL2RenderingContext, frame());

    expect(other.createVertexArray).toHaveBeenCalledOnce();
    expect(other.createProgram).toHaveBeenCalledOnce();
    expect(other.bufferData).toHaveBeenCalled();
    expect(other.drawArraysInstanced).toHaveBeenCalledTimes(PASSES);
  });

  it("reads the heat and the time of a stretch's ends from the six floats of each point", () => {
    layer.onAdd(map);
    layer.setPoints(points());
    render();
    const stride = 6 * 4;
    const pointers = gl.vertexAttribPointer.mock.calls
      .slice(1)
      .map((call) => call as unknown as number[]);
    // Before, start, end and after, and a float or two past each of the
    // first three: the heat into the start, and the heat and the time at
    // either end of the stretch
    expect(
      pointers.map(([location, size, , , step, offset]) => [
        location,
        size,
        step,
        offset,
      ]),
    ).toEqual([
      [1, 4, stride, 0],
      [2, 1, stride, 16],
      [3, 4, stride, stride],
      [4, 2, stride, stride + 16],
      [5, 4, stride, 2 * stride],
      [6, 2, stride, 2 * stride + 16],
      [7, 4, stride, 3 * stride],
    ]);
  });

  it("draws a faint shadow on the ground under the lifted flights, then their glow", () => {
    layer.onAdd(map);
    layer.setPoints(points());
    render();

    const [shadow, glow] = perDraw("u_heights");
    expect(shadow).toEqual([STYLE.groundM, 0]);
    expect(glow).toEqual([STYLE.groundM, STYLE.liftM]);
    // Muted, filling slower and not near as far, and as strong as the app
    // asks for either
    const [shadowColour, glowColour] = perDraw("u_colour");
    const [r, g, b] = shadowColour!;
    expect(Math.max(r!, g!, b!) - Math.min(r!, g!, b!)).toBeLessThan(0.1);
    expect(b).toBeGreaterThan(0);
    expect(b).toBeLessThan(glowColour![2]! / 2);
    expect(shadowColour![3]).toBe(glowColour![3]);
    const [shadowCeiling, glowCeiling] = perDraw("u_ceiling").map(([c]) => c);
    expect(shadowCeiling).toBeLessThan(0.5);
    expect(glowCeiling).toBe(1);
    // No pulses in the shadow
    expect(perDraw("u_flowMix")[0]![1]).toBe(0);
  });

  it("draws no shadow where the flights are drawn on the ground", () => {
    style = { ...STYLE, liftM: 0 };
    layer.onAdd(map);
    layer.setPoints(points());
    render();
    expect(gl.drawArraysInstanced).toHaveBeenCalledOnce();
    expect(uniform("u_heights")).toEqual([STYLE.groundM, 0]);
  });

  describe("the pulses", () => {
    /** Draw frames `ms` apart for `total` milliseconds */
    const frames = (total: number, ms = 16): void => {
      for (let t = 0; t < total; t += ms) {
        now += ms;
        render();
      }
    };
    const strength = (): number => uniform("u_flowMix")[1]!;

    beforeEach(() => {
      layer.onAdd(map);
      layer.setPoints(points());
    });

    it("fade in and move on along the flights' time, a frame after the other", () => {
      render();
      expect(map.triggerRepaint).toHaveBeenCalled();
      frames(2000);
      expect(strength()).toBeGreaterThan(0.5);
      expect(strength()).toBeLessThanOrEqual(1);
      const [, , before] = uniform("u_flow");
      now += 16;
      render();
      const [inverse, half, after] = uniform("u_flow");
      // Two periods, one twice the other
      expect(half).toBeCloseTo(inverse! / 2, 12);
      expect(after).not.toBe(before);
      map.triggerRepaint.mockClear();
      render();
      expect(map.triggerRepaint).toHaveBeenCalledOnce();
    });

    it("fade out and ask for no frame once the map has not been used for a while, and run again as it is", () => {
      frames(2000);
      frames(30000, 100);
      expect(strength()).toBe(0);
      map.triggerRepaint.mockClear();
      now += 16;
      render();
      expect(map.triggerRepaint).not.toHaveBeenCalled();

      map.emit("mousemove");
      expect(map.triggerRepaint).toHaveBeenCalledOnce();
      // Once is enough until they rest again
      map.emit("move");
      expect(map.triggerRepaint).toHaveBeenCalledOnce();
      frames(2000);
      expect(strength()).toBeGreaterThan(0.5);
    });

    it("keep running while the map is used", () => {
      for (let k = 0; k < 40; k++) {
        frames(1000, 100);
        map.emit("move");
      }
      expect(strength()).toBeGreaterThan(0.5);
    });

    it("do not run under reduced motion, nor where the app says not to, and ask for no frame", () => {
      for (const [reduced, flow] of [
        [true, true],
        [false, false],
      ] as const) {
        motion.reduced = reduced;
        style = { ...STYLE, flow };
        frames(500);
        expect(strength()).toBe(0);
        map.triggerRepaint.mockClear();
        now += 16;
        render();
        expect(map.triggerRepaint).not.toHaveBeenCalled();
        // Nor for the map as it is used
        map.emit("mousemove");
        expect(map.triggerRepaint).not.toHaveBeenCalled();
      }
    });

    it("start again as the map is used once reduced motion is turned off", () => {
      motion.reduced = true;
      frames(500);
      map.triggerRepaint.mockClear();
      map.emit("mousemove");
      expect(map.triggerRepaint).not.toHaveBeenCalled();
      motion.reduced = false;
      map.emit("mousemove");
      expect(map.triggerRepaint).toHaveBeenCalledOnce();
      frames(2000);
      expect(strength()).toBeGreaterThan(0.5);
    });

    it("stop the frames when the cloud is not drawn", () => {
      frames(2000);
      expect(strength()).toBeGreaterThan(0.5);
      style = null;
      map.triggerRepaint.mockClear();
      now += 16;
      render();
      expect(map.triggerRepaint).not.toHaveBeenCalled();
      map.emit("mousemove");
      expect(map.triggerRepaint).not.toHaveBeenCalled();
    });

    it("let go of the map as the layer is removed", () => {
      layer.onRemove(map, gl as unknown as WebGL2RenderingContext);
      expect(map.off).toHaveBeenCalledWith("mousemove", expect.any(Function));
      expect(map.off).toHaveBeenCalledWith("move", expect.any(Function));
    });
  });

  describe("the exposure", () => {
    const gainOf = (cloud: CloudPoints): number => {
      const fresh = new HeatCloudLayer(() => ({ ...STYLE, liftM: 0 }), failed);
      fresh.onAdd(map);
      fresh.setPoints(cloud);
      gl.uniform1f.mockClear();
      fresh.render(gl as unknown as WebGL2RenderingContext, frame());
      return uniform("u_gain")[0]!;
    };

    it("follows the busiest heat of the points", () => {
      const cloud = { ...points(), busiest: 100 / 51.4 };
      const busy = { ...cloud, busiest: 200 / 51.4 };
      expect(gainOf(busy) / gainOf(cloud)).toBeCloseTo(0.5, 9);
    });

    it("darkens the busiest cells no further than white at the gain of the zoom", () => {
      const light = { ...points(), busiest: 10 / 51.4 };
      const busy = { ...light, busiest: 200 / 51.4 };
      const out = [gainOf(light), gainOf(busy)];
      (map.getZoom as Mock).mockReturnValue(13);
      const closer = [gainOf(light), gainOf(busy)];
      // Five zooms in a pixel is 32 times shorter, at half the gain: a light
      // cloud dims with it, the busiest cells stay as white as further out
      expect(closer[0]! / out[0]!).toBeCloseTo(16, 6);
      expect(closer[1]! / out[1]!).toBeCloseTo(32, 6);
    });

    it("eases to that of new points, and asks for no frame once there", () => {
      motion.reduced = true;
      style = { ...STYLE, liftM: 0 };
      const cloud = { ...points(), busiest: 200 / 51.4 };
      layer.onAdd(map);
      layer.setPoints(cloud);
      render();
      const first = uniform("u_gain")[0]!;
      layer.setPoints({ ...cloud, busiest: cloud.busiest / 2 });
      now += 16;
      render();
      const eased = uniform("u_gain")[0]!;
      const target = first * 2;
      expect(eased).toBeGreaterThan(first);
      expect(eased).toBeLessThan(target);
      map.triggerRepaint.mockClear();
      for (let k = 0; k < 100; k++) {
        now += 16;
        render();
      }
      expect(map.triggerRepaint).toHaveBeenCalled();
      expect(uniform("u_gain")[0]! / target).toBeCloseTo(1, 1);
      map.triggerRepaint.mockClear();
      now += 16;
      render();
      expect(map.triggerRepaint).not.toHaveBeenCalled();
    });
  });
});

describe("cloudExposure", () => {
  /** The heat per metre of `count` cruises over the same track */
  const cruises = (count: number): number => count / 51.4;

  it("draws the busiest cells no hotter than white, the whole cloud darker for them", () => {
    const hundred = cloudExposure(cruises(100));
    expect(hundred).toBeLessThan(1);
    expect(cloudExposure(cruises(200))).toBeCloseTo(hundred / 2, 9);
    // Years of flights over one field are not darkened to nothing
    expect(cloudExposure(cruises(10000))).toBe(cloudExposure(cruises(20000)));
    expect(cloudExposure(cruises(10000))).toBeGreaterThan(0);
  });

  it("never draws the cloud brighter than its colours are made for", () => {
    expect(cloudExposure(cruises(10))).toBe(1);
    expect(cloudExposure(cruises(0.1))).toBe(1);
    expect(cloudExposure(0)).toBe(1);
    expect(cloudExposure(Number.NaN)).toBe(1);
  });
});

describe("cloudMatrix", () => {
  /** A column-major matrix times a vector */
  function times(m: ArrayLike<number>, v: number[]): number[] {
    return [0, 1, 2, 3].map(
      (row) =>
        m[row]! * v[0]! +
        m[4 + row]! * v[1]! +
        m[8 + row]! * v[2]! +
        m[12 + row]! * v[3]!,
    );
  }

  it("takes a point from the origin, with a height in metres, where MapLibre's matrix takes it in Mercator units", () => {
    const mercator = [
      2, 0.5, 0.1, 0.01, -0.3, 1.5, 0.2, 0.02, 0.4, -0.6, 3, 0.03, 7, -3, 1, 1,
    ];
    const origin: [number, number] = [0.53, 0.35];
    const lat = 47;
    const matrix = cloudMatrix(mercator, origin, lat);
    const metresPerUnit =
      2 * Math.PI * 6371008.8 * Math.cos((lat * Math.PI) / 180);

    const offset = [0.001, -0.002];
    const heightM = 1500;
    const ours = times(matrix, [offset[0]!, offset[1]!, heightM, 1]);
    const theirs = times(mercator, [
      origin[0] + offset[0]!,
      origin[1] + offset[1]!,
      heightM / metresPerUnit,
      1,
    ]);
    ours.forEach((value, i) => expect(value).toBeCloseTo(theirs[i]!, 5));
  });
});

describe("cloudLook", () => {
  it("keeps the glow of a region out to the first stop, and narrows and dims it closer in", () => {
    const [first] = CLOUD_STOPS;
    expect(cloudLook(4)).toEqual({ sigmaPx: first![1], gain: first![2] });
    expect(cloudLook(first![0])).toEqual({
      sigmaPx: first![1],
      gain: first![2],
    });
    let before = cloudLook(first![0]);
    for (let zoom = first![0] + 0.25; zoom <= 16; zoom += 0.25) {
      const look = cloudLook(zoom);
      expect(look.sigmaPx).toBeLessThanOrEqual(before.sigmaPx);
      expect(look.gain).toBeLessThanOrEqual(before.gain);
      before = look;
    }
    const last = CLOUD_STOPS[CLOUD_STOPS.length - 1]!;
    expect(cloudLook(18)).toEqual({ sigmaPx: last[1], gain: last[2] });
  });

  it("runs straight from one stop to the next", () => {
    const [[z0, s0, g0], [z1, s1, g1]] = CLOUD_STOPS as [
      readonly [number, number, number],
      readonly [number, number, number],
    ];
    const middle = cloudLook((z0 + z1) / 2);
    expect(middle.sigmaPx).toBeCloseTo((s0 + s1) / 2, 9);
    expect(middle.gain).toBeCloseTo((g0 + g1) / 2, 9);
  });
});
