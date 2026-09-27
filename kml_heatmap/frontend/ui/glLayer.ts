/**
 * What the app's two custom WebGL layers, the heat cloud
 * (ui/heatCloudLayer.ts) and the replay of all flights
 * (ui/replayAllLayer.ts), do alike: a quad drawn per stretch between two
 * points, from a buffer of points uploaded once; a program per projection,
 * built on the prelude MapLibre hands a custom layer, so the same shaders
 * work on the globe; and GL objects made for one context, anew after it
 * was lost.
 */
import type { CustomRenderMethodInput } from "maplibre-gl";

/**
 * MapLibre's sphere, whose circumference its Mercator heights are in
 * (mercatorZfromAltitude): the app's EARTH_CIRCUMFERENCE_M is the WGS84
 * equator's
 */
export const MAPLIBRE_EARTH_RADIUS_M = 6371008.8;

/** The uniforms of MapLibre's projection prelude, set by setProjection */
const PROJECTION_UNIFORMS = [
  "u_projection_matrix",
  "u_projection_tile_mercator_coords",
  "u_projection_clipping_plane",
  "u_projection_transition",
  "u_projection_fallback_matrix",
] as const;

type ProjectionUniform = (typeof PROJECTION_UNIFORMS)[number];

/** A compiled program and where its uniforms are */
export interface Program<U extends string> {
  program: WebGLProgram;
  uniforms: Record<U | ProjectionUniform, WebGLUniformLocation | null>;
}

/** The shaders of a layer and how its points are read */
export interface LayerShaders<U extends string> {
  /** Whose they are, for the errors: "the cloud's" */
  owner: string;
  /** The vertex shader, after MapLibre's prelude for the projection */
  vertex: string;
  fragment: string;
  /** The attributes, at locations of their own, `a_corner` the first */
  attributes: readonly string[];
  /** The uniforms besides the projection's */
  uniforms: readonly U[];
  /**
   * Point the attributes after the corner at the buffer of points, which
   * is bound, in the vertex array, which is bound as well
   */
  layout: (gl: WebGL2RenderingContext) => void;
}

/** The GL objects of a layer, made for one context */
interface Resources<U extends string> {
  gl: WebGL2RenderingContext;
  corners: WebGLBuffer;
  points: WebGLBuffer;
  vao: WebGLVertexArrayObject;
  /** By MapLibre's shader variant, one per projection; null did not work */
  programs: Map<string, Program<U> | null>;
  /** What the points uploaded to `points` are of */
  uploaded: object | null;
}

/**
 * The GL objects of a custom layer. They are made as it first draws, in a
 * frame: MapLibre keeps track of what is bound in its context, and takes it
 * up anew only after a custom layer has drawn. After a lost context
 * MapLibre adds the layer again, and what was made in the one before is
 * gone with it.
 */
export class LayerGl<U extends string> {
  private resources: Resources<U> | null = null;

  /** `failed` is told when the shaders or buffers do not work in a context */
  constructor(
    private readonly shaders: LayerShaders<U>,
    private readonly failed: (error: unknown) => void,
  ) {}

  /**
   * The GL objects of a lost context are gone with it, and a context
   * restored is the same object: they are made anew in it
   */
  readonly lost = (): void => {
    this.resources = null;
  };

  /**
   * Ready to draw `data` in the frame `options`: its points uploaded where
   * they are new, and the program for the frame's projection in use. The
   * program and the vertex array to bind; null where either cannot be
   * made (see `failed`).
   */
  begin(
    gl: WebGL2RenderingContext,
    options: CustomRenderMethodInput,
    data: { points: Float32Array },
  ): { program: Program<U>; vao: WebGLVertexArrayObject } | null {
    const resources = this.resourcesOf(gl);
    const program = resources && this.program(resources, options);
    if (!resources || !program) return null;
    if (resources.uploaded !== data) {
      gl.bindBuffer(gl.ARRAY_BUFFER, resources.points);
      gl.bufferData(gl.ARRAY_BUFFER, data.points, gl.STATIC_DRAW);
      resources.uploaded = data;
    }
    gl.useProgram(program.program);
    return { program, vao: resources.vao };
  }

  /** Let go of what was made in `gl`, unless that context is lost */
  release(gl: WebGL2RenderingContext): void {
    const resources = this.resources;
    this.resources = null;
    if (!resources || resources.gl !== gl || gl.isContextLost()) return;
    gl.deleteBuffer(resources.corners);
    gl.deleteBuffer(resources.points);
    gl.deleteVertexArray(resources.vao);
    for (const program of resources.programs.values()) {
      if (program) gl.deleteProgram(program.program);
    }
  }

  /** The GL objects for the context `gl`, made the first time */
  private resourcesOf(gl: WebGL2RenderingContext): Resources<U> | null {
    if (this.resources?.gl === gl) return this.resources;
    this.resources = null;
    try {
      this.resources = this.makeResources(gl);
    } catch (error) {
      this.failed(error);
    }
    return this.resources;
  }

  /** The program for the projection of the frame, compiled on first use */
  private program(
    resources: Resources<U>,
    options: CustomRenderMethodInput,
  ): Program<U> | null {
    const { variantName, vertexShaderPrelude, define } = options.shaderData;
    const held = resources.programs.get(variantName);
    if (held !== undefined) return held;
    let program: Program<U> | null = null;
    try {
      program = this.compile(
        resources.gl,
        `#version 300 es\n${vertexShaderPrelude}\n${define}\n${this.shaders.vertex}`,
      );
    } catch (error) {
      this.failed(error);
    }
    resources.programs.set(variantName, program);
    return program;
  }

  /** The buffers of a context: a quad's corners and the points */
  private makeResources(gl: WebGL2RenderingContext): Resources<U> {
    const corners = gl.createBuffer();
    const points = gl.createBuffer();
    const vao = gl.createVertexArray();
    if (!corners || !points || !vao) {
      throw new Error(`${this.shaders.owner} buffers could not be made`);
    }
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, corners);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW,
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, points);
    this.shaders.layout(gl);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    return { gl, corners, points, vao, programs: new Map(), uploaded: null };
  }

  /** Compile and link the program of `vertex` and the fragment shader */
  private compile(gl: WebGL2RenderingContext, vertex: string): Program<U> {
    const { owner, fragment, attributes, uniforms } = this.shaders;
    const program = gl.createProgram();
    const shaders = [
      [gl.VERTEX_SHADER, vertex],
      [gl.FRAGMENT_SHADER, fragment],
    ] as const;
    for (const [type, source] of shaders) {
      const shader = gl.createShader(type);
      if (!shader) throw new Error(`${owner} shaders could not be made`);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(shader);
        gl.deleteShader(shader);
        gl.deleteProgram(program);
        throw new Error(`${owner} shader did not compile: ${log}`);
      }
      gl.attachShader(program, shader);
      gl.deleteShader(shader);
    }
    attributes.forEach((name, location) =>
      gl.bindAttribLocation(program, location, name),
    );
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error(`${owner} program did not link: ${log}`);
    }
    const located = Object.fromEntries(
      [...PROJECTION_UNIFORMS, ...uniforms].map((name) => [
        name,
        gl.getUniformLocation(program, name),
      ]),
    ) as Program<U>["uniforms"];
    return { program, uniforms: located };
  }
}

/**
 * Set the uniforms of MapLibre's projection prelude for points given from
 * `origin` (see cloudMatrix), on the map or the globe, in the program in use
 */
export function setProjection(
  gl: WebGL2RenderingContext,
  u: Record<ProjectionUniform, WebGLUniformLocation | null>,
  options: CustomRenderMethodInput,
  origin: readonly [number, number],
  lat: number,
): void {
  const data = options.defaultProjectionData;
  const globe = options.shaderData.define.includes("GLOBE");
  const mercator = cloudMatrix(
    globe ? data.fallbackMatrix : data.mainMatrix,
    origin,
    lat,
  );
  gl.uniformMatrix4fv(
    u.u_projection_matrix,
    false,
    globe ? new Float32Array(data.mainMatrix) : mercator,
  );
  if (globe) {
    gl.uniformMatrix4fv(u.u_projection_fallback_matrix, false, mercator);
    gl.uniform4f(
      u.u_projection_tile_mercator_coords,
      origin[0],
      origin[1],
      1,
      1,
    );
    gl.uniform4fv(u.u_projection_clipping_plane, data.clippingPlane);
    gl.uniform1f(u.u_projection_transition, data.projectionTransition);
  }
}

/**
 * The matrix that takes a point of the cloud, as x and y from `origin` in
 * Mercator units and a height in metres, to where `mercator` takes a point
 * in Mercator units with a height in Mercator units at the latitude `lat`
 * (see getProjectionDataForCustomLayer): `mercator` moved to the origin
 * and its heights scaled to metres, in 64 bits, then as 32
 */
export function cloudMatrix(
  mercator: ArrayLike<number>,
  origin: readonly [number, number],
  lat: number,
): Float32Array {
  const [x, y] = origin;
  const metre =
    1 /
    (2 * Math.PI * MAPLIBRE_EARTH_RADIUS_M * Math.cos((lat * Math.PI) / 180));
  const m = Array.from(mercator);
  const out = new Float32Array(16);
  for (let row = 0; row < 4; row++) {
    out[row] = m[row]!;
    out[4 + row] = m[4 + row]!;
    out[8 + row] = m[8 + row]! * metre;
    out[12 + row] = m[row]! * x + m[4 + row]! * y + m[12 + row]!;
  }
  return out;
}
