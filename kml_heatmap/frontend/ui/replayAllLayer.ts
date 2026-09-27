/**
 * The layer of the replay of all flights (ui/replayAll.ts): every flight as
 * a bright head with a trail that fades behind it, drawn with shaders of
 * its own, as the heat cloud is (ui/heatCloudLayer.ts), since moving a
 * hundred markers and writing a hundred trails to a source every frame is
 * far too slow. The curves of all flights are uploaded once, each point
 * with the seconds into its flight (calculations/replayAll.ts), and a
 * frame only tells the shaders the time: a stretch between two points
 * that has not begun is not drawn, one that has is drawn as far as the
 * time has come, and fades by how long ago each of its pixels was flown.
 * The heads are drawn from the same stretches, one at the tip of the
 * stretch each flight is on.
 *
 * It projects with MapLibre's own code, as the cloud does, so it works on
 * the globe, at the heights of the ribbons and the cloud, and against the
 * relief in the depth buffer without writing to it.
 */
import type {
  CustomLayerInterface,
  CustomRenderMethodInput,
  Map as MapLibreMap,
} from "maplibre-gl";
import {
  REPLAY_ALL_POINT_FLOATS,
  type ReplayAllPoints,
} from "../calculations/replayAll";
import { cloudMatrix } from "./heatCloudLayer";

/** The id of the layer on the map */
export const REPLAY_ALL_LAYER = "replay-all";

/** Half the width of a trail and the reach of a head's glow, in CSS pixels */
const TRAIL_HALF_WIDTH_PX = 1.5;
const HEAD_RADIUS_PX = 7;

/** What the layer asks for every frame it draws */
export interface ReplayAllStyle {
  /** Metres a foot of the ground and of the height above it is drawn as */
  groundM: number;
  liftM: number;
  /** The seconds into every flight */
  time: number;
  /** The seconds of flight a trail takes to fade */
  fade: number;
}

/**
 * A stretch is not drawn where it is the step from one curve to the next,
 * not flown yet or faded away, and for the heads where no flight is on it.
 * Each is pulled towards the camera by its reach for the depth test, so a
 * flight on the ground is not cut by the ground it stands on.
 */
const VERTEX_SHADER = `
in vec2 a_corner;
in vec4 a_start;
in vec2 a_startClock;
in vec4 a_end;
in vec2 a_endClock;
uniform vec2 u_heights;
uniform vec2 u_viewport;
uniform vec4 u_depth;
uniform vec3 u_clock;
uniform vec2 u_size;
flat out vec4 v_ends;
flat out vec2 v_times;

vec4 project(vec4 point) {
  return projectTileFor3D(point.xy, point.z * u_heights.x + point.w * u_heights.y);
}

vec2 onScreen(vec4 clip) {
  return (clip.xy / clip.w * 0.5 + 0.5) * u_viewport;
}

void main() {
  float now = u_clock.x;
  bool head = u_clock.z > 0.5;
  float t0 = a_startClock.x;
  float t1 = a_endClock.x;
  float near = u_depth.z;
  if (a_startClock.y < 0.5 || t0 > now || t1 < now - u_clock.y
    || (head && t1 <= now)) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    return;
  }
  float cut = t1 > t0 ? min((now - t0) / (t1 - t0), 1.0) : 1.0;
  vec4 a = project(a_start);
  vec4 b = project(mix(a_start, a_end, cut));
  if (a.w < near && b.w < near) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    return;
  }
  if (a.w < near) a = mix(a, b, (near - a.w) / (b.w - a.w));
  if (b.w < near) b = mix(b, a, (near - b.w) / (a.w - b.w));
  vec2 pa = onScreen(a);
  vec2 pb = onScreen(b);
  vec2 corner = pb + a_corner * u_size.y;
  float w = b.w;
  float reach = u_size.y;
  if (!head) {
    vec2 d = pb - pa;
    float l = length(d);
    vec2 dir = l > 1e-3 ? d / l : vec2(1.0, 0.0);
    reach = u_size.x + 1.0;
    bool atEnd = a_corner.x > 0.0;
    corner = (atEnd ? pb : pa) + vec2(-dir.y, dir.x) * a_corner.y * reach;
    w = atEnd ? b.w : a.w;
  }
  float pulled = max(w - reach * w / u_depth.w, 0.5 * w);
  gl_Position = vec4(
    (corner / u_viewport * 2.0 - 1.0) * pulled,
    u_depth.y - u_depth.x * pulled,
    pulled
  );
  v_ends = vec4(pa, pb);
  v_times = vec2(t0, mix(t0, t1, cut));
}
`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
flat in vec4 v_ends;
flat in vec2 v_times;
uniform vec3 u_clock;
uniform vec2 u_size;
out vec4 fragColor;

const vec3 TRAIL = vec3(1.0, 0.7, 0.28);

void main() {
  vec2 p = gl_FragCoord.xy;
  vec2 a = v_ends.xy;
  vec2 b = v_ends.zw;
  float alpha;
  vec3 colour = TRAIL;
  if (u_clock.z > 0.5) {
    float d = distance(p, b) / u_size.y;
    float core = 1.0 - smoothstep(0.25, 0.4, d);
    alpha = max(core, 0.7 * exp(-8.0 * d * d));
    colour = mix(TRAIL, vec3(1.0), core);
  } else {
    vec2 d = b - a;
    float l = max(length(d), 1e-3);
    vec2 dir = d / l;
    float s = clamp(dot(p - a, dir) / l, 0.0, 1.0);
    float across = abs(dot(p - a, vec2(-dir.y, dir.x)));
    float age = (u_clock.x - mix(v_times.x, v_times.y, s)) / u_clock.y;
    float fade = 1.0 - clamp(age, 0.0, 1.0);
    alpha = 0.85 * clamp(u_size.x + 0.5 - across, 0.0, 1.0) * fade * fade;
  }
  if (alpha < 0.004) discard;
  fragColor = vec4(colour * alpha, alpha);
}
`;

const ATTRIBUTES = [
  "a_corner",
  "a_start",
  "a_startClock",
  "a_end",
  "a_endClock",
] as const;

const UNIFORMS = [
  "u_projection_matrix",
  "u_projection_tile_mercator_coords",
  "u_projection_clipping_plane",
  "u_projection_transition",
  "u_projection_fallback_matrix",
  "u_heights",
  "u_viewport",
  "u_depth",
  "u_clock",
  "u_size",
] as const;

interface Program {
  program: WebGLProgram;
  uniforms: Record<(typeof UNIFORMS)[number], WebGLUniformLocation | null>;
}

/** The GL objects of the layer, made for one context */
interface Resources {
  gl: WebGL2RenderingContext;
  corners: WebGLBuffer;
  points: WebGLBuffer;
  vao: WebGLVertexArrayObject;
  /** By MapLibre's shader variant, one per projection; null did not work */
  programs: Map<string, Program | null>;
  uploaded: ReplayAllPoints | null;
}

export class ReplayAllLayer implements CustomLayerInterface {
  readonly id = REPLAY_ALL_LAYER;
  readonly type = "custom" as const;
  readonly renderingMode = "3d" as const;
  /** Frames the layer has drawn, and the time of the last, for the e2e tests */
  frames = 0;
  time = 0;
  private map: MapLibreMap | null = null;
  private resources: Resources | null = null;
  private flights: ReplayAllPoints | null = null;

  /**
   * `style` is asked on every frame, and draws nothing where it gives null;
   * `failed` is told when the shaders do not work in the map's context
   */
  constructor(
    private readonly style: () => ReplayAllStyle | null,
    private readonly failed: (error: unknown) => void,
  ) {}

  /** Draw the points `flights` from the next frame on, or none */
  setPoints(flights: ReplayAllPoints | null): void {
    this.flights = flights;
    this.map?.triggerRepaint();
  }

  private readonly lost = (): void => {
    this.resources = null;
  };

  onAdd(map: MapLibreMap): void {
    this.map = map;
    map.on("webglcontextlost", this.lost);
  }

  onRemove(map: MapLibreMap, gl: WebGL2RenderingContext): void {
    const resources = this.resources;
    this.resources = null;
    this.map = null;
    map.off("webglcontextlost", this.lost);
    if (!resources || resources.gl !== gl || gl.isContextLost()) return;
    gl.deleteBuffer(resources.corners);
    gl.deleteBuffer(resources.points);
    gl.deleteVertexArray(resources.vao);
    for (const program of resources.programs.values()) {
      if (program) gl.deleteProgram(program.program);
    }
  }

  render(gl: WebGL2RenderingContext, options: CustomRenderMethodInput): void {
    const map = this.map;
    const flights = this.flights;
    const style = this.style();
    if (!map || !flights || flights.count < 2 || !style) return;
    const resources = this.resourcesOf(gl);
    const program = resources && this.program(resources, options);
    if (!resources || !program) return;

    if (resources.uploaded !== flights) {
      gl.bindBuffer(gl.ARRAY_BUFFER, resources.points);
      gl.bufferData(gl.ARRAY_BUFFER, flights.points, gl.STATIC_DRAW);
      resources.uploaded = flights;
    }

    const u = program.uniforms;
    const data = options.defaultProjectionData;
    const globe = options.shaderData.define.includes("GLOBE");
    const mercator = cloudMatrix(
      globe ? data.fallbackMatrix : data.mainMatrix,
      flights.origin,
      map.getCenter().lat,
    );
    gl.useProgram(program.program);
    gl.uniformMatrix4fv(
      u.u_projection_matrix,
      false,
      globe ? new Float32Array(data.mainMatrix) : mercator,
    );
    if (globe) {
      gl.uniformMatrix4fv(u.u_projection_fallback_matrix, false, mercator);
      gl.uniform4f(
        u.u_projection_tile_mercator_coords,
        flights.origin[0],
        flights.origin[1],
        1,
        1,
      );
      gl.uniform4fv(u.u_projection_clipping_plane, data.clippingPlane);
      gl.uniform1f(u.u_projection_transition, data.projectionTransition);
    }
    const height = gl.drawingBufferHeight;
    const ratio = map.getPixelRatio();
    gl.uniform2f(u.u_heights, style.groundM, style.liftM);
    gl.uniform2f(u.u_viewport, gl.drawingBufferWidth, height);
    const projection = options.projectionMatrix;
    gl.uniform4f(
      u.u_depth,
      projection[10],
      projection[14],
      options.nearZ,
      height / 2 / Math.tan(options.fov / 2),
    );
    gl.uniform2f(u.u_size, TRAIL_HALF_WIDTH_PX * ratio, HEAD_RADIUS_PX * ratio);

    gl.bindVertexArray(resources.vao);
    gl.enable(gl.BLEND);
    // Premultiplied, over what the map has drawn
    gl.blendFuncSeparate(
      gl.ONE,
      gl.ONE_MINUS_SRC_ALPHA,
      gl.ONE,
      gl.ONE_MINUS_SRC_ALPHA,
    );
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.STENCIL_TEST);
    // The trails, then the heads over them
    for (const head of [0, 1]) {
      gl.uniform3f(u.u_clock, style.time, Math.max(style.fade, 1), head);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, flights.count - 1);
    }
    gl.bindVertexArray(null);
    gl.depthMask(true);
    this.frames++;
    this.time = style.time;
  }

  /** The GL objects for the context `gl`, made the first time */
  private resourcesOf(gl: WebGL2RenderingContext): Resources | null {
    if (this.resources?.gl === gl) return this.resources;
    this.resources = null;
    try {
      this.resources = makeResources(gl);
    } catch (error) {
      this.failed(error);
    }
    return this.resources;
  }

  /** The program for the projection of the frame, compiled on first use */
  private program(
    resources: Resources,
    options: CustomRenderMethodInput,
  ): Program | null {
    const { variantName, vertexShaderPrelude, define } = options.shaderData;
    const held = resources.programs.get(variantName);
    if (held !== undefined) return held;
    let program: Program | null = null;
    try {
      program = compile(
        resources.gl,
        `#version 300 es\n${vertexShaderPrelude}\n${define}\n${VERTEX_SHADER}`,
      );
    } catch (error) {
      this.failed(error);
    }
    resources.programs.set(variantName, program);
    return program;
  }
}

/** The buffers of a context: a quad's corners and the points */
function makeResources(gl: WebGL2RenderingContext): Resources {
  const corners = gl.createBuffer();
  const points = gl.createBuffer();
  const vao = gl.createVertexArray();
  if (!corners || !points || !vao) {
    throw new Error("the replay's buffers could not be made");
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
  const stride = REPLAY_ALL_POINT_FLOATS * 4;
  // A stretch is the point it starts from and the one after it: where each
  // is, then its time and whether it joins the next
  for (let point = 0; point < 2; point++) {
    for (const [slot, size, offset] of [
      [1, 4, 0],
      [2, 2, 16],
    ] as const) {
      const location = slot + 2 * point;
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(
        location,
        size,
        gl.FLOAT,
        false,
        stride,
        point * stride + offset,
      );
      gl.vertexAttribDivisor(location, 1);
    }
  }
  gl.bindVertexArray(null);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);
  return { gl, corners, points, vao, programs: new Map(), uploaded: null };
}

/** Compile and link the program of `vertex` and the fragment shader */
function compile(gl: WebGL2RenderingContext, vertex: string): Program {
  const program = gl.createProgram();
  for (const [type, source] of [
    [gl.VERTEX_SHADER, vertex],
    [gl.FRAGMENT_SHADER, FRAGMENT_SHADER],
  ] as const) {
    const shader = gl.createShader(type);
    if (!shader) throw new Error("the replay's shaders could not be made");
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      gl.deleteProgram(program);
      throw new Error(`the replay's shader did not compile: ${log}`);
    }
    gl.attachShader(program, shader);
    gl.deleteShader(shader);
  }
  ATTRIBUTES.forEach((name, location) =>
    gl.bindAttribLocation(program, location, name),
  );
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`the replay's program did not link: ${log}`);
  }
  const uniforms = Object.fromEntries(
    UNIFORMS.map((name) => [name, gl.getUniformLocation(program, name)]),
  ) as Program["uniforms"];
  return { program, uniforms };
}
