/**
 * The look of the heatmap and of the heat lines it hands over to: the
 * MapLibre paint expressions, pure functions of the constants below. The
 * data manager gives the layers this paint and changes their opacity.
 */
import type {
  ExpressionSpecification,
  HeatmapLayerSpecification,
  LineLayerSpecification,
} from "maplibre-gl";
import {
  HEAT_LINES,
  HEATMAP_CLUSTER,
  MAP_LAYERS,
  MAP_MAX_ZOOM,
} from "../utils/constants";

/*
 * The look of the heatmap, tuned side by side against what leaflet.heat drew
 * for the same flights (radius 10, blur 15 and minOpacity 0.25). The numbers
 * live here so that a later visual pass has one place to turn.
 */

/** Reach of one point in pixels; leaflet.heat's radius plus its blur was 25 */
export const HEATMAP_RADIUS_PX = 22;
/**
 * The zoom at which the fixes of a track (a few hundred metres apart) are
 * about one radius apart on screen, and the intensity a point has there.
 * With the radius above it puts the ridge of a single track at a density
 * of about 0.015, which the gradient below draws in teal.
 */
const HEATMAP_REFERENCE_ZOOM = 12;
const HEATMAP_REFERENCE_INTENSITY = 0.0375;
/** Opacity of the layer when no colour layer is drawn over it */
export const HEATMAP_OPACITY = 1;
/**
 * Colour and opacity by density: `[density, "r, g, b", alpha]`.
 *
 * One hue that gets lighter, from deep blue over azure and cyan to white:
 * on the dark base map more flights read as more light. A rainbow from blue
 * over green to orange used to be here; it made most of the map green,
 * spoke in the blue, green and yellow of the speed ramp and ended in the
 * orange of the altitude ramp (see colors.ts). This one borrows from
 * neither, and the places flown over so often that the density is cut off
 * at 1 glow white instead of standing as a flat block of colour.
 *
 * leaflet.heat drew every point as a translucent disc, and discs painted
 * over one another saturate: fifty flights over the home airfield came out
 * a little warmer than one, not fifty times as hot. The map adds densities
 * up instead, so on an even scale one track is nearly invisible next to the
 * places flown over every week. The stops therefore sit closer together the
 * lower they are: each is about four times the one before, so a single
 * track is azure, a busy route cyan, and only the airfields themselves come
 * near white. The faintest stop keeps leaflet.heat's least opacity, below
 * which a lone track is lost on the map.
 */
const HEATMAP_GRADIENT: readonly (readonly [number, string, number])[] = [
  [0, "10, 30, 120", 0],
  [0.004, "20, 60, 190", 0.25],
  [0.015, "20, 120, 235", 0.5],
  [0.06, "40, 190, 255", 0.7],
  [0.25, "120, 230, 255", 0.85],
  [0.6, "200, 248, 255", 0.95],
  [1, "255, 255, 255", 1],
];

/**
 * The heat lines the heatmap hands over to (see HEAT_LINES) speak its
 * colours: each stop of the gradient above, from the faintest on, stands
 * for the seconds spent around a stretch (see calculations/heatLines.ts)
 * named here, four times the one before like the densities. A route flown
 * once at cruise speed is deep blue, a circuit flown every week cyan, and
 * taxiways, holding points and the apron glow white.
 */
const HEAT_LINE_SECONDS = [1, 5, 20, 80, 320, 1500] as const;
/**
 * The lines are drawn as a wide blurred glow and a thin core over it, both
 * in the colour of their heat; the core is fainter where less time was
 * spent. Widths in pixels by map zoom, opacities at full strength.
 */
const HEAT_LINE_GLOW = {
  opacity: 0.18,
  width: [12, 5, 16, 12],
  blur: [12, 4, 16, 9],
} as const;
const HEAT_LINE_CORE = {
  /** Opacity by heat: `[seconds, opacity]` */
  opacity: [
    [HEAT_LINE_SECONDS[0], 0.45],
    [HEAT_LINE_SECONDS[2], 0.8],
    [HEAT_LINE_SECONDS[4], 1],
  ],
  /**
   * Width by zoom and heat, `[zoom, px of the coolest, px of the hottest]`:
   * a busy route reads by its weight as well as its colour, and the many
   * flights that passed a place once stay hairlines behind it
   */
  width: [
    [12, 0.75, 2],
    [16, 1.5, 4],
  ],
} as const;

/**
 * Intensity of a point by zoom. The fixes of a track are a fixed distance
 * apart on the ground, so every level zoomed out puts twice as many of them
 * under one pixel of the track and the density there doubles. Halving the
 * intensity per level (an exponential interpolation of base 2 between two
 * stops that are themselves a power of two apart is exactly 2^zoom) cancels
 * that, and a single track keeps about the same colour at every zoom.
 *
 * Above the reference zoom the fixes no longer overlap: they are dots, and
 * the density of a dot does not depend on the zoom. The intensity stays
 * where it is from there on, or every dot would end up red.
 *
 * Clusters (see HEATMAP_CLUSTER) leave the curve as it is. The density at
 * a pixel is the sum of weight times kernel over the points around it, and
 * a cluster carries the weight of its fixes, only moved to their centre. No
 * fix moves further than twice the cluster radius, about half the kernel's,
 * and most far less, so the sum along a track is the one the fixes
 * themselves would give.
 */
function heatmapIntensity(): ExpressionSpecification {
  return [
    "interpolate",
    ["exponential", 2],
    ["zoom"],
    0,
    intensityAt(0),
    HEATMAP_REFERENCE_ZOOM,
    intensityAt(HEATMAP_REFERENCE_ZOOM),
    Math.max(MAP_MAX_ZOOM, HEATMAP_REFERENCE_ZOOM + 1),
    intensityAt(HEATMAP_REFERENCE_ZOOM),
  ];
}

/** What heatmapIntensity comes to at `zoom` */
function intensityAt(zoom: number): number {
  return (
    HEATMAP_REFERENCE_INTENSITY /
    2 ** Math.max(HEATMAP_REFERENCE_ZOOM - zoom, 0)
  );
}

/**
 * The first zoom at which the fixes are drawn as they are, and what one of
 * them contributes there, weight times intensity. That is the least a drawn
 * point may contribute: see heatmapWeight.
 */
const HEATMAP_FIXES_FROM_ZOOM = HEATMAP_CLUSTER.maxZoom + 1;
export const HEATMAP_LEAST_CONTRIBUTION = intensityAt(HEATMAP_FIXES_FROM_ZOOM);

/**
 * Weight of a drawn point by zoom. Every fix counts the same, a track has no
 * heavier and lighter ones, and a cluster (see HEATMAP_CLUSTER) counts as the
 * fixes it stands for.
 *
 * But not every fix finds a cluster. The exporter keeps the vertices a KML
 * has, and those of a planned route or a slow logger are kilometres apart,
 * further than the cluster radius reaches. Such a fix stays a point of
 * weight 1 at every zoom while the intensity keeps halving. MapLibre sizes
 * the kernel of a point from weight times intensity: under about 0.004 the
 * kernel shrinks, and under 0.0006 its size is not a number at all. So the
 * weight never lets a point contribute less than a fix does at the first
 * zoom without clusters, where it is a faint dot: at zoom z that takes a
 * weight of intensity(first) / intensity(z), one more power of two per
 * level out. Tried and dropped: a floor four times as high shows a sparse
 * track as a line at every zoom, but it also lifts the clusters of a lone
 * normal track, which then changes colour at the first zoom without them.
 *
 * A cluster of a normal track holds more fixes than that at every zoom (see
 * HEATMAP_CLUSTER), so the floor leaves it alone. `zoom` may only be the
 * input of a top-level interpolation, hence a stop per level with the floor
 * inside. Between two levels the floor halves, which the base 1/2 follows
 * exactly; a count above both floors is the same at both stops and stays.
 */
function heatmapWeight(): ExpressionSpecification {
  const count: ExpressionSpecification = [
    "coalesce",
    ["get", "point_count"],
    1,
  ];
  const stops: (number | ExpressionSpecification)[] = [];
  for (let zoom = 0; zoom < HEATMAP_FIXES_FROM_ZOOM; zoom++) {
    stops.push(zoom, [
      "max",
      count,
      HEATMAP_LEAST_CONTRIBUTION / intensityAt(zoom),
    ]);
  }
  stops.push(HEATMAP_FIXES_FROM_ZOOM, count);
  return [
    "interpolate",
    ["exponential", 0.5],
    ["zoom"],
    ...stops,
  ] as ExpressionSpecification;
}

/** Colour and opacity by density, see HEATMAP_GRADIENT */
function heatmapColor(): ExpressionSpecification {
  return [
    "interpolate",
    ["linear"],
    ["heatmap-density"],
    ...HEATMAP_GRADIENT.flatMap(([density, rgb, alpha]) => [
      density,
      `rgba(${rgb}, ${alpha})`,
    ]),
  ] as ExpressionSpecification;
}

/**
 * Opacity by zoom across the hand-over to the heat lines: `opacity` on the
 * heatmap's side of it, nothing on the other
 */
export function fadeOutToLines(opacity: number): ExpressionSpecification {
  return [
    "interpolate",
    ["linear"],
    ["zoom"],
    HEAT_LINES.midZoom,
    opacity,
    HEAT_LINES.fullZoom,
    0,
  ];
}

/** Opacity by zoom of the heat lines: nothing, then `opacity` */
function fadeInLines(
  opacity: number | ExpressionSpecification,
): ExpressionSpecification {
  return [
    "interpolate",
    ["linear"],
    ["zoom"],
    HEAT_LINES.fromZoom,
    0,
    HEAT_LINES.midZoom,
    opacity,
  ];
}

/** A width or blur that grows with the zoom, `[zoom, px, zoom, px]` */
function byZoom(stops: readonly number[]): ExpressionSpecification {
  return [
    "interpolate",
    ["exponential", 2],
    ["zoom"],
    ...stops,
  ] as ExpressionSpecification;
}

/** The paint of the heat layer, which the map creates without any */
export function heatmapPaint(): NonNullable<
  HeatmapLayerSpecification["paint"]
> {
  return {
    "heatmap-radius": HEATMAP_RADIUS_PX,
    "heatmap-weight": heatmapWeight(),
    "heatmap-intensity": heatmapIntensity(),
    "heatmap-color": heatmapColor(),
    "heatmap-opacity": fadeOutToLines(HEATMAP_OPACITY),
  };
}

/** Colour of a heat line by its heat, see HEAT_LINE_SECONDS */
function heatLineColor(): ExpressionSpecification {
  return [
    "interpolate",
    ["linear"],
    ["get", "heat"],
    ...HEATMAP_GRADIENT.slice(1).flatMap(([, rgb], index) => [
      HEAT_LINE_SECONDS[index]!,
      `rgb(${rgb})`,
    ]),
  ] as ExpressionSpecification;
}

/**
 * Opacity of the heat lines at full strength, `strength` of 1 or less while
 * a colour layer is drawn over them (see
 * DataManager.applyHeatmapEmphasis)
 */
export function heatLineOpacities(strength: number): {
  glow: ExpressionSpecification;
  core: ExpressionSpecification;
} {
  return {
    glow: fadeInLines(HEAT_LINE_GLOW.opacity * strength),
    core: fadeInLines([
      "interpolate",
      ["linear"],
      ["get", "heat"],
      ...HEAT_LINE_CORE.opacity.flatMap(([seconds, opacity]) => [
        seconds,
        opacity * strength,
      ]),
    ] as ExpressionSpecification),
  };
}

/** Width of the heat line cores by zoom and heat, see HEAT_LINE_CORE */
function heatLineCoreWidth(): ExpressionSpecification {
  const coolest = HEAT_LINE_SECONDS[0];
  const hottest = HEAT_LINE_SECONDS[HEAT_LINE_SECONDS.length - 1]!;
  return [
    "interpolate",
    ["exponential", 2],
    ["zoom"],
    ...HEAT_LINE_CORE.width.flatMap(([zoom, cool, hot]) => [
      zoom,
      [
        "interpolate",
        ["linear"],
        ["log2", ["get", "heat"]],
        Math.log2(coolest),
        cool,
        Math.log2(hottest),
        hot,
      ],
    ]),
  ] as ExpressionSpecification;
}

/** The paint of the two heat line layers, created without any either */
export function heatLinesPaint(): Record<
  typeof MAP_LAYERS.heatLinesGlow | typeof MAP_LAYERS.heatLinesCore,
  NonNullable<LineLayerSpecification["paint"]>
> {
  const opacity = heatLineOpacities(HEATMAP_OPACITY);
  return {
    [MAP_LAYERS.heatLinesGlow]: {
      "line-color": heatLineColor(),
      "line-width": byZoom(HEAT_LINE_GLOW.width),
      "line-blur": byZoom(HEAT_LINE_GLOW.blur),
      "line-opacity": opacity.glow,
    },
    [MAP_LAYERS.heatLinesCore]: {
      "line-color": heatLineColor(),
      "line-width": heatLineCoreWidth(),
      "line-opacity": opacity.core,
    },
  };
}
