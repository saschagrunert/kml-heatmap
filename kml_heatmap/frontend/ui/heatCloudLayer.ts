/**
 * The layer that draws the heat of the 3D view as a cloud in the air (see
 * ui/heatCloud.ts): a MapLibre custom layer with shaders of its own, since
 * no style layer draws a glow at a height. Every stretch between two
 * points of the cloud (calculations/heatCloud.ts) is a quad on the screen
 * around its two ends, and each of its pixels gets the heat of the
 * stretch spread along it and blurred across it: a Gaussian of the
 * distance to the stretch, integrated along it from the join with the
 * stretch before to the join with the one after. The joins are the
 * bisectors of the bends, so the stretches of a flight add up to the blur
 * of the whole line without a gap or a bead where one ends and the next
 * begins (round ends overlapped into beads, see the heat lines in
 * mapLayers.ts), and a stretch shorter than its blur is a soft point.
 *
 * The blur is as wide on the screen at the middle of the map at every
 * zoom out to a region, and narrows closer in (CLOUD_STOPS); it is wider
 * in front of the middle and narrower behind it in a tilted view, like
 * everything else there. The heat of a stretch is the seconds spent on it
 * over the pixels it spans, so a lone flight glows alike at every zoom out
 * to a region and at every depth, as the heatmap's intensity keeps a lone track alike by
 * zoom (see heatmapIntensity), and a slow one, a circuit or the taxiing,
 * glows brighter. The glows are added up over what the map has drawn
 * (see CLOUD_COLOUR), so where flights overlap the cloud glows brighter,
 * from blue over cyan to white.
 *
 * It is drawn as a 3D layer, before the ribbons (see ui/heatCloud.ts):
 * against the relief in the depth buffer, so a mountain in front of a
 * flight hides its glow, but without writing to it, so the glow of one
 * flight does not hide another's, and the ribbons are drawn over it.
 * Each glow is pulled towards the camera by its reach for that test, so a
 * fix on the ground glows round rather than cut in half by the ground in
 * front of it. MapLibre's own projection code (the prelude it hands a
 * custom layer) projects the points, which makes the same shaders work on
 * the globe; the points are given from an origin near them, so a 32-bit
 * float keeps them to a fraction of a pixel close in.
 */
import type {
  CustomLayerInterface,
  CustomRenderMethodInput,
  Map as MapLibreMap,
} from "maplibre-gl";
import {
  CLOUD_POINT_FLOATS,
  mercatorOf,
  type CloudPoints,
} from "../calculations/heatCloud";

/** The id of the cloud's layer on the map */
export const HEAT_CLOUD_LAYER = "heat-cloud";

/**
 * By map zoom: the blur of a stretch at the middle of the map, in CSS
 * pixels (the standard deviation of the Gaussian), and how much of its heat
 * it glows with (see CLOUD_REFERENCE_SPEED_MS), between the stops linearly.
 * Out to 9.5 (the app's 10.5) the glow reaches 21 px, as the heatmap's
 * points reach 22, and a region's routes run together into a cloud. Closer
 * in a glow that wide over every track of a busy field covered its roads
 * and labels, where the flat heatmap has handed over to thin heat lines
 * (HEAT_LINES): it narrows to a crisp glow along each track, and dims so
 * that only the tracks flown over and over glow white, the circuit of the
 * home field among them.
 */
export const CLOUD_STOPS: readonly (readonly [
  zoom: number,
  sigmaPx: number,
  gain: number,
])[] = [
  [9.5, 7, 1],
  [10.5, 4.5, 0.75],
  [13, 2.5, 0.5],
];

/** The blur and the gain of CLOUD_STOPS at the map zoom `zoom` */
export function cloudLook(zoom: number): { sigmaPx: number; gain: number } {
  const next = CLOUD_STOPS.findIndex(([stop]) => stop > zoom);
  const [z0, s0, g0] = CLOUD_STOPS[next <= 0 ? 0 : next - 1]!;
  if (next <= 0) {
    const [, s, g] =
      next === 0 ? CLOUD_STOPS[0]! : CLOUD_STOPS[CLOUD_STOPS.length - 1]!;
    return { sigmaPx: s, gain: g };
  }
  const [z1, s1, g1] = CLOUD_STOPS[next]!;
  const t = (zoom - z0) / (z1 - z0);
  return { sigmaPx: s0 + (s1 - s0) * t, gain: g0 + (g1 - g0) * t };
}

/**
 * The narrowest and the widest the blur gets in a tilted view, as parts of
 * the one at the middle: behind a pixel the far flights would flicker, and
 * close to the camera a glow would fill the screen
 */
const CLOUD_SIGMA_RANGE = [0.15, 3] as const;

/** How many blurs a quad reaches around its stretch */
const CLOUD_REACH = 3;

/**
 * How many blurs a glow is pulled towards the camera for the depth test:
 * as far as it reaches, so the relief hides the glow of a flight only
 * where it is in front of all of it
 */
const CLOUD_DEPTH_PULL = CLOUD_REACH;

/**
 * The groundspeed of a cruise, in metres per second (100 kt). The heat of
 * a lone track flown at it is 1 at its middle (times the gain of
 * CLOUD_STOPS); one flown slower, a
 * circuit, a climb or the taxiing, glows brighter, as the heatmap does
 * where more fixes lie, for the time spent there, and where flights
 * overlap their heat adds up.
 */
const CLOUD_REFERENCE_SPEED_MS = 51.4;

/**
 * How fast each colour channel fills with heat: a pixel of heat `h` is
 * `1 - exp(-h * k)` of each channel, which the blending adds up the same
 * way over every glow on the pixel (the "screen" of two layers). Blue
 * fills first, then green, then red, and each only comes near full, so a
 * lone cruise is a faint azure, four of them cyan, sixteen a light cyan
 * and only some sixty, the fields and the circuits flown every week,
 * white: the stops of the heatmap's colours (see HEATMAP_GRADIENT).
 */
const CLOUD_COLOUR = [0.04, 0.26, 0.62] as const;

/**
 * MapLibre's sphere, whose circumference its Mercator heights are in
 * (mercatorZfromAltitude): the app's EARTH_CIRCUMFERENCE_M is the WGS84
 * equator's
 */
const MAPLIBRE_EARTH_RADIUS_M = 6371008.8;

/** What the layer asks the app for every frame it draws */
export interface HeatCloudStyle {
  /**
   * The metres a foot of the ground and a foot of the height above it is
   * drawn as: the exaggeration of the relief, and 0 for the ground where
   * the map draws no relief and for the height where the 3D view draws
   * the flights flat (see isLiftedAt)
   */
  groundM: number;
  liftM: number;
  /** How strongly the cloud is drawn, from 0 to 1 (see dimsHeatmap) */
  opacity: number;
}

const VERTEX_SHADER = `
in vec2 a_corner;
in vec4 a_before;
in float a_in;
in vec4 a_start;
in float a_heat;
in vec4 a_end;
in float a_out;
in vec4 a_after;
uniform vec2 u_heights;
uniform vec3 u_centre;
uniform vec2 u_viewport;
uniform vec3 u_sigma;
uniform vec4 u_depth;
uniform float u_gain;
flat out vec4 v_ends;
flat out vec4 v_joins;
flat out vec4 v_blur;
flat out float v_heat;

vec4 project(vec4 point) {
  return projectTileFor3D(point.xy, point.z * u_heights.x + point.w * u_heights.y);
}

vec2 onScreen(vec4 clip) {
  return (clip.xy / clip.w * 0.5 + 0.5) * u_viewport;
}

vec2 unit(vec2 v, vec2 otherwise) {
  float l = length(v);
  return l > 1e-3 ? v / l : otherwise;
}

void main() {
  vec4 a = project(a_start);
  vec4 b = project(a_end);
  float near = u_depth.z;
  if (a_heat <= 0.0 || (a.w < near && b.w < near)) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    return;
  }
  if (a.w < near) a = mix(a, b, (near - a.w) / (b.w - a.w));
  if (b.w < near) b = mix(b, a, (near - b.w) / (a.w - b.w));
  float middle = projectTileFor3D(u_centre.xy, u_centre.z).w;
  vec2 scales = vec2(middle / a.w, middle / b.w);
  vec2 sigmas = clamp(u_sigma.x * scales, u_sigma.y, u_sigma.z);
  vec2 pa = onScreen(a);
  vec2 pb = onScreen(b);
  float length_px = distance(pa, pb);
  vec2 dir = unit(pb - pa, vec2(1.0, 0.0));
  // Where the stretch hands over to the one before and the one after: the
  // bisector of the angle between the two, which is as far from either
  // line, so their glows meet without a gap or an overlap where it bends
  vec2 joinA = dir;
  vec2 joinB = dir;
  if (a_in > 0.0) {
    vec4 c = project(a_before);
    if (c.w > near) joinA = unit(unit(pa - onScreen(c), dir) + dir, dir);
  }
  if (a_out > 0.0) {
    vec4 c = project(a_after);
    if (c.w > near) joinB = unit(dir + unit(onScreen(c) - pb, dir), dir);
  }
  // Across a stretch shorter than its blur the two joins would open into a
  // wedge far longer than the stretch, all of it lit with the heat of that
  // stretch: those meet the next straight across, as the heat of a short
  // stretch is a soft point anyway
  float bend = smoothstep(0.5, 2.0, length_px / min(sigmas.x, sigmas.y));
  joinA = unit(mix(dir, joinA, bend), dir);
  joinB = unit(mix(dir, joinB, bend), dir);
  bool atEnd = a_corner.x > 0.0;
  float sigma = atEnd ? sigmas.y : sigmas.x;
  float w = atEnd ? b.w : a.w;
  // Past its end by the reach of the glow, and as far again as the
  // bisector slants away from the end at that distance across
  float slant = clamp(dot(atEnd ? joinB : joinA, dir), 0.5, 1.0);
  float reach = ${CLOUD_REACH.toFixed(1)} * sigma;
  vec2 corner = (atEnd ? pb : pa)
    + dir * a_corner.x * reach * (1.0 + sqrt(max(1.0 - slant * slant, 0.0)) / slant)
    + vec2(-dir.y, dir.x) * a_corner.y * reach;
  // Towards the camera by CLOUD_DEPTH_PULL blurs, where it is still on
  // the same pixels, with the depth the projection gives there
  float pulled = max(w - ${CLOUD_DEPTH_PULL.toFixed(1)} * sigma * w / u_depth.w, 0.5 * w);
  gl_Position = vec4(
    (corner / u_viewport * 2.0 - 1.0) * pulled,
    u_depth.y - u_depth.x * pulled,
    pulled
  );
  v_ends = vec4(pa, pb);
  v_joins = vec4(joinA, joinB);
  v_blur = vec4(sigmas, scales);
  v_heat = u_gain * a_heat / max(length_px, 1e-3);
}
`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
flat in vec4 v_ends;
flat in vec4 v_joins;
flat in vec4 v_blur;
flat in float v_heat;
uniform vec4 u_colour;
out vec4 fragColor;

// Abramowitz and Stegun 7.1.26, to 1.5e-7
float erf(float x) {
  float t = 1.0 / (1.0 + 0.3275911 * abs(x));
  float y = 1.0 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t
    - 0.284496736) * t + 0.254829592) * t * exp(-x * x);
  return sign(x) * y;
}

void main() {
  vec2 a = v_ends.xy;
  vec2 b = v_ends.zw;
  vec2 p = gl_FragCoord.xy;
  float length_px = distance(a, b);
  vec2 dir = length_px > 1e-3 ? (b - a) / length_px : v_joins.xy;
  float across = dot(p - a, vec2(-dir.y, dir.x));
  float t = length_px > 1e-3 ? clamp(dot(p - a, dir) / length_px, 0.0, 1.0) : 0.5;
  float sigma = mix(v_blur.x, v_blur.y, t);
  float scale = mix(v_blur.z, v_blur.w, t);
  float spread = 0.70710678 / sigma;
  // The Gaussian across the stretch, integrated along it from the join
  // with the one before to the join with the one after
  float glow = v_heat * scale * exp(-0.5 * across * across / (sigma * sigma))
    * 0.5 * (erf(dot(p - a, v_joins.xy) * spread) + erf(dot(b - p, v_joins.zw) * spread));
  vec3 filled = 1.0 - exp(-glow * u_colour.a * u_colour.rgb);
  if (filled.b < 0.002) discard;
  fragColor = vec4(filled, max(filled.r, max(filled.g, filled.b)));
}
`;

/** A compiled program and where its uniforms are */
interface Program {
  program: WebGLProgram;
  uniforms: Record<(typeof UNIFORMS)[number], WebGLUniformLocation | null>;
}

/** The attributes, at locations of their own in every program */
const ATTRIBUTES = [
  "a_corner",
  "a_before",
  "a_in",
  "a_start",
  "a_heat",
  "a_end",
  "a_out",
  "a_after",
] as const;

const UNIFORMS = [
  "u_projection_matrix",
  "u_projection_tile_mercator_coords",
  "u_projection_clipping_plane",
  "u_projection_transition",
  "u_projection_fallback_matrix",
  "u_heights",
  "u_centre",
  "u_viewport",
  "u_sigma",
  "u_depth",
  "u_gain",
  "u_colour",
] as const;

/** The GL objects of the layer, made for one context */
interface Resources {
  gl: WebGL2RenderingContext;
  corners: WebGLBuffer;
  points: WebGLBuffer;
  vao: WebGLVertexArrayObject;
  /** By MapLibre's shader variant, one per projection; null did not work */
  programs: Map<string, Program | null>;
  /** The points uploaded to `points` */
  uploaded: CloudPoints | null;
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

export class HeatCloudLayer implements CustomLayerInterface {
  readonly id = HEAT_CLOUD_LAYER;
  readonly type = "custom" as const;
  readonly renderingMode = "3d" as const;
  /** Frames the layer has drawn the cloud in, for the e2e tests */
  frames = 0;
  /** The stretches it drew in the last of them */
  drawn = 0;
  private map: MapLibreMap | null = null;
  private resources: Resources | null = null;
  private cloud: CloudPoints | null = null;

  /**
   * `style` is asked on every frame, and draws nothing where it gives null;
   * `failed` is told when the shaders do not compile in the map's context
   */
  constructor(
    private readonly style: () => HeatCloudStyle | null,
    private readonly failed: (error: unknown) => void,
  ) {}

  /** Draw the points `cloud` from the next frame on, or none */
  setPoints(cloud: CloudPoints | null): void {
    this.cloud = cloud;
    this.map?.triggerRepaint();
  }

  /**
   * The GL objects of a lost context are gone with it, and a context
   * restored is the same object: they are made anew in it
   */
  private readonly lost = (): void => {
    this.resources = null;
  };

  /**
   * Its GL objects are made as it first draws, in a frame: MapLibre keeps
   * track of what is bound in its context, and takes it up anew only after
   * a custom layer has drawn
   */
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
    const cloud = this.cloud;
    this.drawn = 0;
    if (!map || !cloud || cloud.count < 2) return;
    const style = this.style();
    if (!style || style.opacity <= 0) return;
    const held = this.resourcesOf(gl);
    const program = held && this.program(held, options);
    if (!held || !program) return;

    const resources = held;
    if (resources.uploaded !== cloud) {
      gl.bindBuffer(gl.ARRAY_BUFFER, resources.points);
      gl.bufferData(gl.ARRAY_BUFFER, cloud.points, gl.STATIC_DRAW);
      resources.uploaded = cloud;
    }

    const u = program.uniforms;
    const data = options.defaultProjectionData;
    const center = map.getCenter();
    const globe = options.shaderData.define.includes("GLOBE");
    const mercator = cloudMatrix(
      globe ? data.fallbackMatrix : data.mainMatrix,
      cloud.origin,
      center.lat,
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
        cloud.origin[0],
        cloud.origin[1],
        1,
        1,
      );
      gl.uniform4fv(u.u_projection_clipping_plane, data.clippingPlane);
      gl.uniform1f(u.u_projection_transition, data.projectionTransition);
    }
    const width = gl.drawingBufferWidth;
    const height = gl.drawingBufferHeight;
    const ratio = map.getPixelRatio();
    const zoom = map.getZoom();
    const [mx, my] = mercatorOf([center.lat, center.lng]);
    gl.uniform2f(u.u_heights, style.groundM, style.liftM);
    gl.uniform3f(
      u.u_centre,
      mx - cloud.origin[0],
      my - cloud.origin[1],
      map.getCenterElevation(),
    );
    gl.uniform2f(u.u_viewport, width, height);
    const look = cloudLook(zoom);
    const sigma = look.sigmaPx * ratio;
    gl.uniform3f(
      u.u_sigma,
      sigma,
      sigma * CLOUD_SIGMA_RANGE[0],
      sigma * CLOUD_SIGMA_RANGE[1],
    );
    // What the projection makes of a distance from the camera (w) for the
    // depth, the nearest a point may be, and the focal length in pixels
    const projection = options.projectionMatrix;
    gl.uniform4f(
      u.u_depth,
      projection[10],
      projection[14],
      options.nearZ,
      height / 2 / Math.tan(options.fov / 2),
    );
    // The seconds of a cruise over a pixel at the middle: the heat is the
    // seconds of a stretch over its pixels
    const metresPerPixel =
      (2 *
        Math.PI *
        MAPLIBRE_EARTH_RADIUS_M *
        Math.cos((center.lat * Math.PI) / 180)) /
      (512 * 2 ** zoom);
    gl.uniform1f(
      u.u_gain,
      (look.gain * CLOUD_REFERENCE_SPEED_MS * ratio) / metresPerPixel,
    );
    gl.uniform4f(
      u.u_colour,
      CLOUD_COLOUR[0],
      CLOUD_COLOUR[1],
      CLOUD_COLOUR[2],
      style.opacity,
    );

    gl.bindVertexArray(resources.vao);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(
      gl.ONE,
      gl.ONE_MINUS_SRC_COLOR,
      gl.ONE,
      gl.ONE_MINUS_SRC_ALPHA,
    );
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.STENCIL_TEST);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, cloud.count - 1);
    gl.bindVertexArray(null);
    gl.depthMask(true);
    this.frames++;
    this.drawn = cloud.count - 1;
  }

  /**
   * The GL objects for the context `gl`, made the first time: after a lost
   * context MapLibre adds the layer again (see ui/heatCloud.ts), and what
   * was made in the one before is gone with it. Null where they could not
   * be made, which the layer tells once.
   */
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
    throw new Error("the cloud's buffers could not be made");
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
  const stride = CLOUD_POINT_FLOATS * 4;
  // A stretch is the point it starts from and the one after it, with the
  // points on either side of them for the joins, and the heat of the
  // stretches before and after it
  for (let point = 0; point < 4; point++) {
    const location = 1 + 2 * point;
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(
      location,
      4,
      gl.FLOAT,
      false,
      stride,
      point * stride,
    );
    gl.vertexAttribDivisor(location, 1);
    if (point === 3) continue;
    gl.enableVertexAttribArray(location + 1);
    gl.vertexAttribPointer(
      location + 1,
      1,
      gl.FLOAT,
      false,
      stride,
      point * stride + 16,
    );
    gl.vertexAttribDivisor(location + 1, 1);
  }
  gl.bindVertexArray(null);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);
  return { gl, corners, points, vao, programs: new Map(), uploaded: null };
}

/** Compile and link the program of `vertex` and the fragment shader */
function compile(gl: WebGL2RenderingContext, vertex: string): Program {
  const program = gl.createProgram();
  const shaders = [
    [gl.VERTEX_SHADER, vertex],
    [gl.FRAGMENT_SHADER, FRAGMENT_SHADER],
  ] as const;
  for (const [type, source] of shaders) {
    const shader = gl.createShader(type);
    if (!shader) throw new Error("the cloud's shaders could not be made");
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      gl.deleteProgram(program);
      throw new Error(`the cloud's shader did not compile: ${log}`);
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
    throw new Error(`the cloud's program did not link: ${log}`);
  }
  const uniforms = Object.fromEntries(
    UNIFORMS.map((name) => [name, gl.getUniformLocation(program, name)]),
  ) as Program["uniforms"];
  return { program, uniforms };
}
