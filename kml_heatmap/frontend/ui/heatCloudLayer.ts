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
 * Each glow is pulled towards the camera by its reach for that test, and
 * near the ground as far as the ground in front of it rises, so a fix on
 * the ground glows round rather than cut in half by the ground in front of
 * it. MapLibre's own projection code (the prelude it hands a
 * custom layer) projects the points, which makes the same shaders work on
 * the globe; the points are given from an origin near them, so a 32-bit
 * float keeps them to a fraction of a pixel close in.
 *
 * Three things help to read it. A faint copy of the glow on the ground
 * under the flights, its shadow, shows how high they were. Pulses run
 * along every track the way it was flown, by the time of its points,
 * which shows the direction of a circuit and the usual ways in and out;
 * they rest while the map is not used and under reduced motion, and the
 * map draws no frame for them then, and an exported image has none. And
 * the exposure follows the heat: the busiest cells of the cloud glow no
 * brighter than white, however many flights the filters keep (see
 * cloudExposure). A band of heights above ground can leave out the heat
 * below and above it, in the glow and its shadow alike, fading out at its
 * edges (calculations/heightBand.ts); the exposure stays that of all of it,
 * so a band draws its heat as bright as the whole cloud does.
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
import { LayerGl, MAPLIBRE_EARTH_RADIUS_M, setProjection } from "./glLayer";
import { isMapStill } from "../utils/mapHelpers";
import { prefersReducedMotion } from "../utils/motion";

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
 * The narrowest the blur gets in a tilted view, in device pixels, and the
 * widest, as a part of the one at the middle: close to the camera a glow
 * would fill the screen. A far flight narrower than a pixel was drawn as a
 * crisp line that flickered: it is drawn this wide, and as much fainter,
 * so it fades into the distance.
 */
const CLOUD_SIGMA_FLOOR_PX = 0.8;
const CLOUD_SIGMA_MOST = 3;

/**
 * How many blurs a quad reaches around its stretch, and pulls its glow
 * towards the camera for the depth test: as far as it reaches, so the
 * relief hides the glow of a flight only where it is in front of all of it
 */
const CLOUD_REACH = 3;

/**
 * How far the glow of a stretch reaches on the screen at the middle of the
 * map at the map zoom `zoom`, in CSS pixels: the 21 px of CLOUD_STOPS out
 * to 9.5, 7.5 px from 13 in. The readout of the cloud under the pointer is
 * for about as far (ui/cloudReadout.ts).
 */
export function cloudReachPx(zoom: number): number {
  return CLOUD_REACH * cloudLook(zoom).sigmaPx;
}

/**
 * Near the ground a glow is pulled further, to where the ground in front
 * of each corner of its quad lies, as the ground there rises into the
 * view the steeper, the flatter the view: it cut the glow of a runway in a
 * straight line. The ground is taken this many feet higher than the
 * cloud's, where the relief MapLibre draws can lie, and the pull is held
 * to this many blurs, so a ridge in front of a flight low over a valley
 * still hides it.
 */
const CLOUD_GROUND_SLACK_FT = 30;
const CLOUD_GROUND_PULL = 12;

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
 * The heat the busiest cells of the cloud (see CloudPoints.busiest) are
 * drawn with at most: white (see CLOUD_COLOUR). Where more than a
 * hundredth of its cells would glow hotter, the whole cloud is drawn
 * darker, down to the least of CLOUD_EXPOSURE_RANGE, so a home field
 * flown for years does not wash out its circuits and the routes out of
 * it. It is never drawn brighter than its colours are made for: the two
 * years of flights of the sample data have their busiest cells at a heat
 * of 6 to 18 (cyan), a lone flight at about 3 to 6, and drawn near white
 * they glowed white along every route.
 */
const CLOUD_WHITE_HEAT = 60;
const CLOUD_EXPOSURE_RANGE = [0.25, 1] as const;

/**
 * The shadow of the cloud: how fast each colour channel fills with heat (see
 * CLOUD_COLOUR), a muted grey blue, and the most it fills, so that under a
 * busy field it stays a haze rather than a second white blot under the
 * glow's. The shadows are not added up but the brightest is kept, which
 * the ceiling holds: added up, those of every circuit over a field filled
 * to white. The brightest is kept against what the pixel already has, the
 * map, so over ground brighter than the shadow (roads, satellite imagery)
 * none shows: keeping it against the other shadows alone needs a texture
 * of its own (see DEVELOPMENT.md). A stretch casts none on the ground it is on (the taxiing, the
 * run for a take-off), and a full one from the second of these heights
 * above it, in feet. It is a Gaussian of the distance to the stretch,
 * which the brightest of them keeps as whole as the joins of the glow do,
 * cut at this many blurs, at half the cost of the glow. None is drawn
 * while the cloud is dimmed (see HeatCloudStyle.opacity), where it cost
 * as much as the glow for a haze no one could see.
 */
const CLOUD_SHADOW_COLOUR = [0.22, 0.26, 0.35] as const;
const CLOUD_SHADOW_CEILING = 0.18;
const CLOUD_SHADOW_LIFT_FT = [30, 100] as const;
const CLOUD_SHADOW_REACH = 2;

/** The Gaussian of the shadow at its reach, taken off so it ends at 0 */
const SHADOW_EDGE = Math.exp(-0.5 * CLOUD_SHADOW_REACH ** 2);

/**
 * The pulses of the flow: how many CSS pixels a cruise flies between two
 * (see CLOUD_REFERENCE_SPEED_MS), in how many seconds one moves on to the
 * next, and how strongly they bring out and take back the glow. Along a
 * stretch where they would come closer than the first of these many blurs
 * on the screen, the taxiing close in and every track near the horizon,
 * they ran together into a comb: they fade out there from the second.
 */
const CLOUD_FLOW_SPACING_PX = 90;
const CLOUD_FLOW_CYCLE_S = 2.5;
const CLOUD_FLOW_STRENGTH = 0.6;
const CLOUD_FLOW_CLOSEST = [4, 8] as const;

/**
 * The factor of a pulse at the part `phase` of its period (see
 * FRAGMENT_SHADER, which has the same): a raised cosine, skewed forward by
 * the square of the phase, so it rises along where it has been to its head
 * at 0.71 of the period and falls, a little quicker but as smoothly, ahead
 * of it. It and its slope are 0 at either end of the period, so the pulses
 * pass without a jump, where a fall to 0 in the last 15 % of it snapped.
 * CLOUD_PULSE_SCALE makes it 1 on average, 1 / (1 - C(2) / 2) with the
 * Fresnel integral C, so the heat as a whole shows as bright as without.
 */
const CLOUD_PULSE_SCALE = 1.3229730485502598;
export function cloudPulse(phase: number): number {
  return (1 - Math.cos(2 * Math.PI * phase * phase)) * CLOUD_PULSE_SCALE;
}

/**
 * How long after the map was last used the pulses keep running, and in
 * how many seconds they fade in and out (and the exposure follows a new
 * level's)
 */
const CLOUD_FLOW_IDLE_MS = 8000;
const CLOUD_FADE_S = 0.8;

/**
 * What the map does when it is used, a move of its camera or a touch: each
 * wakes the flow. The pointer moving over it is not: it kept the map
 * drawing every frame for as long as it rested on it.
 */
const CLOUD_FLOW_WAKE = ["touchstart", "move"] as const;

/**
 * How brightly the cloud is drawn for its busiest heat per metre
 * `busiest` (see CloudPoints.busiest), times the gain of CLOUD_STOPS it
 * is drawn with: a factor of its heat that draws those cells in
 * CLOUD_WHITE_HEAT, within CLOUD_EXPOSURE_RANGE; 1 without any heat
 */
export function cloudExposure(busiest: number): number {
  if (!(busiest > 0)) return 1;
  const [least, most] = CLOUD_EXPOSURE_RANGE;
  return Math.min(
    Math.max(CLOUD_WHITE_HEAT / (busiest * CLOUD_REFERENCE_SPEED_MS), least),
    most,
  );
}

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
  /**
   * How strongly the cloud is drawn, from 0 to 1 (see dimsHeatCloud): the
   * most of white it fills a pixel to; below 1 without its shadow
   */
  opacity: number;
  /** Whether its pulses may run (see CLOUD_FLOW_SPACING_PX) */
  flow: boolean;
  /**
   * The heights above ground its heat is drawn at, in feet: from the first
   * it fades in up to the second, and from the third out up to the fourth
   * (see heightBandEdgesFt)
   */
  band: readonly [number, number, number, number];
}

/**
 * The quad of a stretch, and what its pixels need to know of it. Its
 * comments are here rather than in the shader, which is shipped as it is
 * written:
 * - The joins, where the stretch hands over to the one before and the one
 *   after, are the bisectors of the angles between them, which are as far
 *   from either line, so their glows meet without a gap or an overlap
 *   where it bends.
 * - Across a stretch shorter than its blur the two joins would open into a
 *   wedge far longer than the stretch, all of it lit with the heat of that
 *   stretch: those meet the next straight across (`bend`), as the heat of
 *   a short stretch is a soft point anyway.
 * - The quad reaches past each end by the reach of the glow, and as far
 *   again as the bisector slants away from the end at that distance
 *   across; the shadow's only by its reach (CLOUD_SHADOW_REACH).
 * - It is pulled towards the camera by its reach, where it is still on the
 *   same pixels, with the depth the projection gives there; and a corner
 *   the ground in front of it is nearer than that to where the ground is
 *   (CLOUD_GROUND_PULL): the plane of the ground under its end, through
 *   three points of it projected, meets the ray through the corner there.
 *   Never nearer than halfway to the camera, nor than its near plane.
 * - The shadow of a stretch shorter than its blur is as bright as the
 *   glow's erf makes it in its middle: a soft point, where the brightest
 *   of them is kept.
 * - Its pulses come as far apart on the screen as its length over the
 *   periods of the flight's time along it (CLOUD_FLOW_CLOSEST).
 * - A stretch whose two ends are below the band of heights, or both above
 *   it, is left out whole: none of it is in the band.
 */
const VERTEX_SHADER = `
in vec2 a_corner;
in vec4 a_before;
in float a_in;
in vec4 a_start;
in vec2 a_heat;
in vec4 a_end;
in vec2 a_out;
in vec4 a_after;
uniform vec2 u_heights;
uniform vec3 u_centre;
uniform vec2 u_viewport;
uniform vec3 u_sigma;
uniform vec4 u_depth;
uniform float u_gain;
uniform vec4 u_band;
uniform vec2 u_ground;
uniform vec2 u_shadow;
uniform vec4 u_flow;
uniform vec2 u_flowMix;
flat out vec4 v_ends;
flat out vec4 v_joins;
flat out vec4 v_blur;
flat out float v_heat;
flat out vec2 v_time;
flat out vec2 v_height;
flat out float v_flow;

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

float meet(vec4 o, vec4 e, vec4 n, vec2 at) {
  vec2 q = at / u_viewport * 2.0 - 1.0;
  vec2 r = q * o.w - o.xy;
  vec2 ce = e.xy - q * e.w;
  vec2 cn = n.xy - q * n.w;
  float det = ce.x * cn.y - ce.y * cn.x;
  if (abs(det) <= 1e-6 * length(ce) * length(cn)) return 0.0;
  return o.w + (e.w * (r.x * cn.y - r.y * cn.x) + n.w * (ce.x * r.y - ce.y * r.x)) / det;
}

void main() {
  bool shadow = u_shadow.y > 0.0;
  float shade = shadow ? smoothstep(u_shadow.x, u_shadow.y, max(a_start.w, a_end.w)) : 1.0;
  vec4 a = project(a_start);
  vec4 b = project(a_end);
  float near = u_depth.z;
  if (
    a_heat.x <= 0.0 || shade <= 0.0 || (a.w < near && b.w < near)
    || max(a_start.w, a_end.w) <= u_band.x || min(a_start.w, a_end.w) >= u_band.w
  ) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    return;
  }
  if (a.w < near) a = mix(a, b, (near - a.w) / (b.w - a.w));
  if (b.w < near) b = mix(b, a, (near - b.w) / (a.w - b.w));
  float middle = projectTileFor3D(u_centre.xy, u_centre.z).w;
  vec2 scales = vec2(middle / a.w, middle / b.w);
  vec2 blurs = u_sigma.x * scales;
  vec2 sigmas = clamp(blurs, u_sigma.y, u_sigma.z);
  vec2 pa = onScreen(a);
  vec2 pb = onScreen(b);
  float length_px = distance(pa, pb);
  vec2 dir = unit(pb - pa, vec2(1.0, 0.0));
  vec2 joinA = dir;
  vec2 joinB = dir;
  if (a_in > 0.0) {
    vec4 c = project(a_before);
    if (c.w > near) joinA = unit(unit(pa - onScreen(c), dir) + dir, dir);
  }
  if (a_out.x > 0.0) {
    vec4 c = project(a_after);
    if (c.w > near) joinB = unit(dir + unit(onScreen(c) - pb, dir), dir);
  }
  float bend = smoothstep(0.5, 2.0, length_px / min(sigmas.x, sigmas.y));
  joinA = unit(mix(dir, joinA, bend), dir);
  joinB = unit(mix(dir, joinB, bend), dir);
  bool atEnd = a_corner.x > 0.0;
  float sigma = atEnd ? sigmas.y : sigmas.x;
  float w = atEnd ? b.w : a.w;
  float slant = clamp(dot(atEnd ? joinB : joinA, dir), 0.5, 1.0);
  float reach = (shadow ? ${CLOUD_SHADOW_REACH.toFixed(1)} : ${CLOUD_REACH.toFixed(1)}) * sigma;
  vec2 corner = (atEnd ? pb : pa)
    + dir * a_corner.x * reach * (shadow ? 1.0 : 1.0 + sqrt(max(1.0 - slant * slant, 0.0)) / slant)
    + vec2(-dir.y, dir.x) * a_corner.y * reach;
  float pull = reach * w / u_depth.w;
  float pulled = w - pull;
  vec4 point = atEnd ? a_end : a_start;
  float h = point.z * u_heights.x + u_ground.y;
  vec4 o = projectTileFor3D(point.xy, h);
  vec4 e = projectTileFor3D(point.xy + vec2(u_ground.x, 0.0), h) - o;
  vec4 n = projectTileFor3D(point.xy + vec2(0.0, u_ground.x), h) - o;
  float behind = meet(o, e, n, atEnd ? pb : pa);
  float under = meet(o, e, n, corner);
  if (behind > 0.0 && behind < w + pull && under > 0.0 && under < pulled) {
    pulled = mix(
      max(under, w - ${CLOUD_GROUND_PULL.toFixed(1)} * sigma * w / u_depth.w),
      pulled,
      max(behind - w, 0.0) / pull
    );
  }
  pulled = max(pulled, max(0.5 * w, near * 1.01));
  gl_Position = vec4(
    (corner / u_viewport * 2.0 - 1.0) * pulled,
    u_depth.y - u_depth.x * pulled,
    pulled
  );
  v_ends = vec4(pa, pb);
  v_joins = vec4(joinA, joinB);
  v_blur = vec4(sigmas, scales * min(blurs / sigmas, 1.0));
  if (shadow) {
    float f = length_px / (1.4142136 * (sigmas.x + sigmas.y));
    shade *= sqrt(1.0 - exp(-1.2732395 * f * f));
  }
  v_heat = shade * u_gain * a_heat.x / max(length_px, 1e-3);
  v_time = vec2(a_heat.y, a_out.y);
  v_height = vec2(a_start.w, a_end.w);
  float periods = abs(a_out.y - a_heat.y) * u_flow.x / (1.0 + u_flowMix.x);
  v_flow = shadow ? 0.0 : smoothstep(
    ${CLOUD_FLOW_CLOSEST[0].toFixed(1)},
    ${CLOUD_FLOW_CLOSEST[1].toFixed(1)},
    length_px / max(periods, 1e-6) / (0.5 * (sigmas.x + sigmas.y))
  );
}
`;

/**
 * The glow of a pixel of a stretch: the Gaussian across the stretch,
 * integrated along it from the join with the one before to the join with
 * the one after; of the shadow, the Gaussian of its distance to the
 * stretch, down to 0 at its reach. With the flow, times its pulses at the
 * time the pixel was flown at, in two periods, one twice the other,
 * blended as the zoom goes from one to the next; a pulse is brightest at
 * its head and fades along where it has been, and is 1 on average.
 * Times the part of the band of heights at the height it was flown at,
 * which fades in and out at the band's edges, in the shadow as in the
 * glow.
 */
const FRAGMENT_SHADER = `#version 300 es
precision highp float;
flat in vec4 v_ends;
flat in vec4 v_joins;
flat in vec4 v_blur;
flat in float v_heat;
flat in vec2 v_time;
flat in vec2 v_height;
flat in float v_flow;
uniform vec3 u_colour;
uniform float u_ceiling;
uniform vec2 u_shadow;
uniform vec4 u_flow;
uniform vec2 u_flowMix;
uniform vec4 u_band;
out vec4 fragColor;

float pulse(float phase) {
  return (1.0 - cos(6.2831853 * phase * phase)) * ${CLOUD_PULSE_SCALE.toFixed(7)};
}

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
  float glow;
  if (u_shadow.y > 0.0) {
    float off = distance(p, a + dir * clamp(dot(p - a, dir), 0.0, length_px)) / sigma;
    glow = v_heat * scale * max(exp(-0.5 * off * off) - ${SHADOW_EDGE.toFixed(6)}, 0.0)
      / ${(1 - SHADOW_EDGE).toFixed(6)};
  } else {
    float spread = 0.70710678 / sigma;
    glow = v_heat * scale * exp(-0.5 * across * across / (sigma * sigma))
      * 0.5 * (erf(dot(p - a, v_joins.xy) * spread) + erf(dot(b - p, v_joins.zw) * spread));
  }
  float height = mix(v_height.x, v_height.y, t);
  glow *= smoothstep(u_band.x, u_band.y, height) * (1.0 - smoothstep(u_band.z, u_band.w, height));
  if (u_flowMix.y * v_flow > 0.0) {
    float time = mix(v_time.x, v_time.y, t);
    float pulses = mix(
      pulse(fract(time * u_flow.x - u_flow.z)),
      pulse(fract(time * u_flow.y - u_flow.w)),
      u_flowMix.x
    );
    glow *= 1.0 + u_flowMix.y * v_flow * (pulses - 1.0);
  }
  vec3 filled = u_ceiling * (1.0 - exp(-glow * u_colour / u_ceiling));
  if (filled.b < 0.002) discard;
  fragColor = vec4(filled, max(filled.r, max(filled.g, filled.b)));
}
`;

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

/** The uniforms besides those of the projection */
const UNIFORMS = [
  "u_heights",
  "u_centre",
  "u_viewport",
  "u_sigma",
  "u_depth",
  "u_gain",
  "u_ground",
  "u_shadow",
  "u_colour",
  "u_ceiling",
  "u_flow",
  "u_flowMix",
  "u_band",
] as const;

/**
 * A stretch is the point it starts from and the one after it, with the
 * points on either side of them for the joins, the heat of the stretches
 * before and after it, and the time at either end
 */
function layout(gl: WebGL2RenderingContext): void {
  const stride = CLOUD_POINT_FLOATS * 4;
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
      point ? 2 : 1,
      gl.FLOAT,
      false,
      stride,
      point * stride + 16,
    );
    gl.vertexAttribDivisor(location + 1, 1);
  }
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
  /** Its GL objects, made as it first draws (see LayerGl) */
  private readonly objects: LayerGl<(typeof UNIFORMS)[number]>;
  private cloud: CloudPoints | null = null;
  /** When the last frame was drawn, and the map last used (performance.now) */
  private drawnAt = 0;
  private usedAt = 0;
  /** How strongly the pulses show, from 0 to 1 as they fade in and out */
  private flow = 0;
  /** How far they have moved on, in seconds of the flights */
  private flowS = 0;
  /**
   * Whether they rest, for a map not used or under reduced motion, until
   * the map is used again
   */
  private resting = false;
  /** The exposure drawn with, which follows cloudExposure of the points */
  private exposure = 0;

  /**
   * `style` is asked on every frame, and draws nothing where it gives null;
   * `failed` is told when the shaders do not compile in the map's context
   */
  constructor(
    private readonly style: () => HeatCloudStyle | null,
    private readonly failed: (error: unknown) => void,
  ) {
    this.objects = new LayerGl(
      {
        owner: "the cloud's",
        vertex: VERTEX_SHADER,
        fragment: FRAGMENT_SHADER,
        attributes: ATTRIBUTES,
        uniforms: UNIFORMS,
        layout,
      },
      this.failed,
    );
  }

  /** Draw the points `cloud` from the next frame on, or none */
  setPoints(cloud: CloudPoints | null): void {
    this.cloud = cloud;
    this.usedAt = performance.now();
    this.resting = false;
    this.map?.triggerRepaint();
  }

  /**
   * The map is used: the pulses run again, from a frame on if they rest,
   * and so once reduced motion is turned off
   */
  private readonly wake = (): void => {
    // Not by the resizes of an export (see withMapStill)
    if (this.map && isMapStill(this.map)) return;
    this.usedAt = performance.now();
    if (!this.resting || prefersReducedMotion()) return;
    this.resting = false;
    this.map?.triggerRepaint();
  };

  onAdd(map: MapLibreMap): void {
    this.map = map;
    this.usedAt = performance.now();
    map.on("webglcontextlost", this.objects.lost);
    for (const type of CLOUD_FLOW_WAKE) map.on(type, this.wake);
  }

  onRemove(map: MapLibreMap, gl: WebGL2RenderingContext): void {
    this.map = null;
    map.off("webglcontextlost", this.objects.lost);
    for (const type of CLOUD_FLOW_WAKE) map.off(type, this.wake);
    this.objects.release(gl);
  }

  render(gl: WebGL2RenderingContext, options: CustomRenderMethodInput): void {
    const map = this.map;
    const cloud = this.cloud;
    this.drawn = 0;
    this.resting = false;
    if (!map || !cloud || cloud.count < 2) return;
    const style = this.style();
    if (!style || style.opacity <= 0) return;
    const ready = this.objects.begin(gl, options, cloud);
    if (!ready) return;

    const u = ready.program.uniforms;
    const center = map.getCenter();
    setProjection(gl, u, options, cloud.origin, center.lat);
    const width = gl.drawingBufferWidth;
    const height = gl.drawingBufferHeight;
    const ratio = map.getPixelRatio();
    const zoom = map.getZoom();
    const [mx, my] = mercatorOf([center.lat, center.lng]);
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
      CLOUD_SIGMA_FLOOR_PX,
      sigma * CLOUD_SIGMA_MOST,
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
    // The ground under a glow, for its pull: the plane through its point
    // and two a hundred pixels of the middle away, where the relief may be
    gl.uniform2f(
      u.u_ground,
      100 / (512 * 2 ** zoom),
      CLOUD_GROUND_SLACK_FT * style.groundM,
    );

    // The pulses and the exposure, eased from the last frame's. A frame
    // that took longer than 100 ms (a first one after a rest, or a busy
    // main thread) moves them on by that much: they slow for it rather
    // than jump. The period changing by the zoom needs nothing here: the
    // longer period of one octave is the shorter of the next, at the same
    // phase, and the blend between them is all on it where they meet.
    const now = performance.now();
    const seconds = Math.min(Math.max(now - this.drawnAt, 0), 100) / 1000;
    this.drawnAt = now;
    const step = seconds / CLOUD_FADE_S;
    const wanted = style.flow && !prefersReducedMotion();
    const awake = wanted && now - this.usedAt < CLOUD_FLOW_IDLE_MS;
    this.flow = wanted
      ? Math.min(Math.max(this.flow + (awake ? step : -step), 0), 1)
      : 0;
    const exposure = cloudExposure(cloud.busiest * look.gain);
    this.exposure = this.exposure
      ? this.exposure + (exposure - this.exposure) * Math.min(step * 4, 1)
      : exposure;
    // The seconds of the flights between two pulses, as a power of two and
    // the part of the way to the next: both are drawn, and blended
    const octave = Math.log2(
      (CLOUD_FLOW_SPACING_PX * metresPerPixel) / CLOUD_REFERENCE_SPEED_MS,
    );
    const period = 2 ** Math.floor(octave);
    this.flowS += (seconds * 2 ** octave) / CLOUD_FLOW_CYCLE_S;
    gl.uniform4f(
      u.u_flow,
      1 / period,
      0.5 / period,
      (this.flowS / period) % 1,
      (this.flowS / period / 2) % 1,
    );

    gl.uniform4f(u.u_band, ...style.band);
    gl.uniform1f(
      u.u_gain,
      (look.gain * this.exposure * CLOUD_REFERENCE_SPEED_MS * ratio) /
        metresPerPixel,
    );
    gl.bindVertexArray(ready.vao);
    gl.enable(gl.BLEND);
    // The screen of the glows, towards white at full strength, and towards
    // as much of white as the cloud is drawn with when it is dimmed: every
    // glow on a pixel moves it that way, so however many there are it gets
    // no brighter than that, where a quarter of their heat, which it scaled
    // before, still filled the home field to white. The map under the
    // brightest of it goes the same way (see DEVELOPMENT.md). The shadow's
    // MAX takes no factors, and it is not drawn dimmed.
    const opacity = style.opacity;
    gl.blendColor(opacity, opacity, opacity, opacity);
    gl.blendFuncSeparate(
      gl.CONSTANT_COLOR,
      gl.ONE_MINUS_SRC_COLOR,
      gl.ONE,
      gl.ONE_MINUS_SRC_ALPHA,
    );
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.STENCIL_TEST);
    // The shadow on the ground, where the flights are lifted off it and the
    // cloud is not dimmed, the brightest of them kept; then the glow at
    // their heights, added up, and without its pulses while the map is
    // exported
    const flow = isMapStill(map) ? 0 : this.flow * CLOUD_FLOW_STRENGTH;
    const passes = [
      [
        0,
        CLOUD_SHADOW_COLOUR,
        CLOUD_SHADOW_CEILING,
        0,
        gl.MAX,
        CLOUD_SHADOW_LIFT_FT,
      ],
      [style.liftM, CLOUD_COLOUR, 1, flow, gl.FUNC_ADD, [0, 0]],
    ] as const;
    const shadow = style.liftM > 0 && style.opacity >= 1;
    for (const [liftM, colour, ceiling, pulses, blend, cast] of passes.slice(
      shadow ? 0 : 1,
    )) {
      gl.blendEquation(blend);
      gl.uniform2f(u.u_heights, style.groundM, liftM);
      gl.uniform2f(u.u_shadow, cast[0], cast[1]);
      gl.uniform3f(u.u_colour, colour[0], colour[1], colour[2]);
      gl.uniform1f(u.u_ceiling, ceiling);
      gl.uniform2f(u.u_flowMix, octave - Math.floor(octave), pulses);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, cloud.count - 1);
    }
    gl.bindVertexArray(null);
    gl.depthMask(true);
    this.frames++;
    this.drawn = cloud.count - 1;
    // The next frame while the pulses run or fade, or the exposure moves,
    // every one the screen shows so they move smoothly; none at all once
    // they rest, for the map or for reduced motion
    this.resting = style.flow && !awake && !this.flow;
    if (
      awake ||
      this.flow > 0 ||
      Math.abs(this.exposure - exposure) > exposure / 100
    ) {
      map.triggerRepaint();
    }
  }
}
