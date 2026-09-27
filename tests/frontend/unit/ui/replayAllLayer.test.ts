/**
 * The custom layer of the replay of all flights, with the WebGL context
 * mocked: it uploads the flights once, and a frame only sets the time.
 */
import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import type { CustomRenderMethodInput, Map as MapLibreMap } from "maplibre-gl";
import {
  REPLAY_ALL_LAYER,
  ReplayAllLayer,
  type ReplayAllStyle,
} from "../../../../kml_heatmap/frontend/ui/replayAllLayer";
import {
  replayAllPoints,
  type ReplayAllPoints,
} from "../../../../kml_heatmap/frontend/calculations/replayAll";
import { flightClock } from "../../../../kml_heatmap/frontend/calculations/flightClock";
import { smoothFlights } from "../../../../kml_heatmap/frontend/calculations/smoothing";
import type { PathSegment } from "../../../../kml_heatmap/frontend/types";

/** A WebGL2 context that records what is asked of it */
function mockGl(compiles = true) {
  let objects = 0;
  const made = (kind: string) => vi.fn(() => ({ kind, n: objects++ }));
  return {
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
}

type MockGl = ReturnType<typeof mockGl>;

function frame(globe = false): CustomRenderMethodInput {
  const identity = new Float64Array([
    1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
  ]);
  return {
    farZ: 1000,
    nearZ: 1,
    fov: 0.6435,
    modelViewProjectionMatrix: identity,
    projectionMatrix: new Float64Array(identity),
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

function mockMap(): MapLibreMap {
  return {
    on: vi.fn(),
    off: vi.fn(),
    getCenter: vi.fn(() => ({ lng: 11, lat: 47 })),
    getPixelRatio: vi.fn(() => 2),
    triggerRepaint: vi.fn(),
  } as unknown as MapLibreMap;
}

/** Two flights of five fixes each */
function flights(): ReplayAllPoints {
  const segments: PathSegment[] = [1, 2].flatMap((path_id) =>
    [0, 1, 2, 3].map((i) => ({
      path_id,
      coords: [
        [46 + path_id, 11 + i * 0.01],
        [46 + path_id, 11 + (i + 1) * 0.01],
      ] as PathSegment["coords"],
      altitude_ft: 3000,
      groundspeed_knots: 100,
      time: i * 30,
    })),
  );
  const curves = smoothFlights(segments, (i) => segments[i]!.altitude_ft, {
    groundOf: () => 0,
  });
  return replayAllPoints(
    segments,
    curves,
    flightClock(segments),
    () => true,
    14,
    null,
  );
}

const STYLE: ReplayAllStyle = { groundM: 3, liftM: 3, time: 42, fade: 400 };

describe("the replay of all flights' layer", () => {
  let gl: MockGl;
  let map: MapLibreMap;
  let style: ReplayAllStyle | null;
  let failed: Mock<(error: unknown) => void>;
  let layer: ReplayAllLayer;

  const draw = (input = frame()): void =>
    layer.render(gl as unknown as WebGL2RenderingContext, input);

  beforeEach(() => {
    gl = mockGl();
    map = mockMap();
    style = STYLE;
    failed = vi.fn();
    layer = new ReplayAllLayer(() => style, failed);
    layer.onAdd(map);
  });

  it("is a 3D custom layer of its own id", () => {
    expect(layer.id).toBe(REPLAY_ALL_LAYER);
    expect(layer.type).toBe("custom");
    expect(layer.renderingMode).toBe("3d");
  });

  it("draws nothing without flights or where it is told not to", () => {
    draw();
    layer.setPoints(flights());
    style = null;
    draw();

    expect(gl.drawArraysInstanced).not.toHaveBeenCalled();
    expect(layer.frames).toBe(0);
  });

  it("draws the trails and then the heads from the same stretches", () => {
    const points = flights();
    layer.setPoints(points);

    draw();

    expect(gl.drawArraysInstanced.mock.calls).toEqual([
      [gl.TRIANGLE_STRIP, 0, 4, points.count - 1],
      [gl.TRIANGLE_STRIP, 0, 4, points.count - 1],
    ]);
    const clocks = gl.uniform3f.mock.calls.filter(
      ([location]) => (location as { name: string }).name === "u_clock",
    );
    expect(clocks.map((call): unknown[] => call.slice(1))).toEqual([
      [42, 400, 0],
      [42, 400, 1],
    ]);
    // Over the map, premultiplied, against the depth without writing it
    expect(gl.blendFuncSeparate).toHaveBeenCalledWith(
      gl.ONE,
      gl.ONE_MINUS_SRC_ALPHA,
      gl.ONE,
      gl.ONE_MINUS_SRC_ALPHA,
    );
    expect(gl.depthMask).toHaveBeenNthCalledWith(1, false);
    expect(layer.frames).toBe(1);
    expect(layer.time).toBe(42);
  });

  it("uploads the flights once, and a frame after that only the time", () => {
    layer.setPoints(flights());

    draw();
    style = { ...STYLE, time: 100 };
    draw();

    expect(gl.bufferData).toHaveBeenCalledTimes(2);
    expect(gl.createProgram).toHaveBeenCalledTimes(1);
    expect(layer.time).toBe(100);
  });

  it("reads each stretch as its two points, six floats apart", () => {
    layer.setPoints(flights());

    draw();

    const stride = 6 * 4;
    const pointers = gl.vertexAttribPointer.mock.calls.slice(1);
    expect(pointers).toEqual([
      [1, 4, gl.FLOAT, false, stride, 0],
      [2, 2, gl.FLOAT, false, stride, 16],
      [3, 4, gl.FLOAT, false, stride, stride],
      [4, 2, gl.FLOAT, false, stride, stride + 16],
    ]);
  });

  it("compiles a program for the globe of its own", () => {
    layer.setPoints(flights());

    draw();
    draw(frame(true));

    expect(gl.createProgram).toHaveBeenCalledTimes(2);
    const sources = gl.shaderSource.mock.calls.map((call) => String(call[1]));
    expect(sources.some((source) => source.includes("#define GLOBE"))).toBe(
      true,
    );
  });

  it("says once that its shaders do not compile, and draws nothing", () => {
    gl = mockGl(false);
    layer.setPoints(flights());

    draw();
    draw();

    expect(failed).toHaveBeenCalledTimes(1);
    expect(gl.drawArraysInstanced).not.toHaveBeenCalled();
  });

  it("makes its buffers anew and uploads the flights again after a lost context", () => {
    layer.setPoints(flights());
    draw();
    const lost = vi
      .mocked(map.on)
      .mock.calls.find(
        ([type]) => type === "webglcontextlost",
      )![1] as () => void;

    // A context restored is the same object, with nothing of before in it
    lost();
    draw();

    expect(gl.createVertexArray).toHaveBeenCalledTimes(2);
    expect(gl.createProgram).toHaveBeenCalledTimes(2);
    expect(gl.bufferData).toHaveBeenCalledTimes(4);
    expect(layer.frames).toBe(2);
  });

  it("lets go of what it made as it is removed", () => {
    layer.setPoints(flights());
    draw();

    layer.onRemove(map, gl as unknown as WebGL2RenderingContext);

    expect(gl.deleteBuffer).toHaveBeenCalledTimes(2);
    expect(gl.deleteVertexArray).toHaveBeenCalledTimes(1);
    expect(gl.deleteProgram).toHaveBeenCalledTimes(1);
  });
});
