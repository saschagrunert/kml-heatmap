/**
 * Airport labels - the ICAO codes above the airport markers
 *
 * The markers are buttons in the DOM, so they take focus and open their
 * popups from the keyboard. Their codes are a symbol layer of the map
 * instead: DOM labels could only be kept apart from one another, while the
 * place names of the base style were placed by the map without knowing of
 * them, so a code sat right on the name of the town beside its airport.
 * On the map both go through one collision pass. The airport labels are
 * the top layer, so they are placed first and the place names give way;
 * the map fades labels in and out, keeps them apart while it moves, and
 * hides the ones on the far side of the globe.
 */
import type {
  ExpressionSpecification,
  Map as MapLibreMap,
  SymbolLayerSpecification,
} from "maplibre-gl";
import type { Airport } from "../types";
import {
  AIRPORT_HIDE_LABELS_BELOW_ZOOM,
  MAP_LAYERS,
  MAP_SOURCES,
} from "../utils/constants";
import { isPhoneLayout, matchesMedia } from "../utils/device";
import { cssVar } from "../utils/mapHelpers";

/**
 * The font of the codes: Roboto, the interface font of the page on Android
 * and Linux, and narrow enough for four capitals, where the base style's
 * Montserrat runs wide. The base style's glyph server has it. A style
 * without a glyph server (the fallback the map starts on, and the stub of
 * the e2e specs) has the map draw the text with a local font of that name
 * instead, and `sans-serif` is the one every browser has; the glyph server
 * skips a name it does not know.
 */
const AIRPORT_LABEL_FONT = ["Roboto Medium", "Noto Sans Regular", "sans-serif"];

/**
 * Label size by zoom, `[size, zoom, size, ...]`: it grows at the zooms the
 * markers do (AIRPORT_SIZE_ZOOMS). Pixels, from the stylesheet's smallest
 * text (`--text-xs`) up: the 10 and 10.5 px it started at were off the
 * page's type scale, at the zooms a first visit opens on.
 */
const LABEL_SIZE_STEPS = [11, 9, 12, 13, 13] as const;

/**
 * Nothing on a phone reads smaller than the stylesheet's small text there
 * (`--text-sm`). Pixels.
 */
const PHONE_MIN_LABEL_PX = 12;

/**
 * How far the bottom of the text sits above the airport, in ems: the chip
 * around it clears the largest dot and the pointer target around it
 */
const LABEL_LIFT_EM = 1.35;

/** The chip the codes sit on */
const CHIP_IMAGE = "airport-label-chip";

/**
 * The chip, in CSS pixels: a rounded rectangle with the corners of the
 * page's controls (`--radius-control`), its straight middle stretched to
 * the text. It is a distance field, so the map colours it: its fill, and
 * the rim drawn as its halo, change with the home base and the hover.
 */
const CHIP = {
  width: 20,
  height: 16,
  radius: 4,
  /** Room around it for the rim, which the map draws outside the edge */
  margin: 4,
  pixelRatio: 2,
} as const;

/**
 * Distance field units, as the map reads an SDF image: the edge is at 3/4
 * of the value range, and a pixel of distance is 1/8 of it
 */
const SDF_EDGE = 0.75;
const SDF_PX = 8;

/** What a label feature carries */
interface AirportLabelProperties {
  /** The airport's full name, which the markers and the popups use */
  name: string;
  /** The four letters drawn */
  icao: string;
  /** Flights of the current filter; the busier airport keeps its label */
  count: number;
  home: boolean;
}

/** What an airport's label says without an ICAO code of its own */
export const NO_CODE_LABEL = "APT";

/** The label size by zoom, never under `minPx` */
export function airportLabelSize(minPx = 0): ExpressionSpecification {
  return [
    "step",
    ["zoom"],
    ...LABEL_SIZE_STEPS.map((value, index) =>
      index % 2 ? value : Math.max(value, minPx),
    ),
  ] as ExpressionSpecification;
}

/** An expression for the hovered label, and one for every other */
function onHover(
  hovered: string,
  otherwise: string | ExpressionSpecification,
): ExpressionSpecification {
  return [
    "case",
    ["boolean", ["feature-state", "hover"], false],
    hovered,
    otherwise,
  ] as ExpressionSpecification;
}

/**
 * The label layer, created hidden like every layer of the app. Its colours
 * are the page's: the surface of its panels, a hairline rim, the accent
 * blue around the home base, and the hover colour of a control with the
 * accent rim under the pointer.
 */
export function airportLabelLayer(): SymbolLayerSpecification {
  const token = (name: string, fallback: string): string =>
    cssVar(name) || fallback;
  const surface = token("--color-bg-secondary-rgb", "28, 28, 28");
  const text = token("--color-text-rgb", "242, 242, 242");
  const accent = token("--color-accent-blue-rgb", "79, 172, 254");
  const hover = token("--color-bg-hover", "#262626");
  const contrast = matchesMedia("(prefers-contrast: more)");
  // The phone layout, as the page opened
  const phone = isPhoneLayout();

  return {
    id: MAP_LAYERS.airportLabels,
    type: "symbol",
    source: MAP_SOURCES.airportLabels,
    minzoom: AIRPORT_HIDE_LABELS_BELOW_ZOOM,
    layout: {
      visibility: "none",
      "text-field": ["get", "icao"],
      "text-font": AIRPORT_LABEL_FONT,
      "text-size": airportLabelSize(phone ? PHONE_MIN_LABEL_PX : 0),
      "text-letter-spacing": 0.05,
      // Always above the dot: a label without room there is left out
      "text-anchor": "bottom",
      "text-offset": [0, -LABEL_LIFT_EM],
      // Lower keys are placed first: the home base, then the busiest
      "symbol-sort-key": [
        "-",
        ["case", ["get", "home"], Number.MAX_SAFE_INTEGER, ["get", "count"]],
      ],
      "icon-image": CHIP_IMAGE,
      "icon-text-fit": "both",
      "icon-text-fit-padding": [1, 2, 1, 2],
      // Point labels stay upright and face the reader on a tilted map, like
      // the markers: the default of the pitch alignment for them
    },
    paint: {
      "text-color": onHover("#ffffff", `rgb(${text})`),
      "icon-color": onHover(hover, `rgba(${surface}, ${contrast ? 1 : 0.92})`),
      "icon-halo-color": onHover(`rgb(${accent})`, [
        "case",
        ["get", "home"],
        `rgba(${accent}, 0.9)`,
        `rgba(${text}, ${contrast ? 0.5 : 0.16})`,
      ]),
      "icon-halo-width": 1,
    },
  };
}

/**
 * The chip as a distance field: every pixel tells how far it is from the
 * edge of the rounded rectangle, which the map turns into a fill and a rim
 * of any colour. Computed rather than drawn, so it needs no canvas.
 */
export function chipImage(): {
  width: number;
  height: number;
  data: Uint8Array;
} {
  const { width, height, radius, margin, pixelRatio } = CHIP;
  const imageWidth = (width + 2 * margin) * pixelRatio;
  const imageHeight = (height + 2 * margin) * pixelRatio;
  const data = new Uint8Array(imageWidth * imageHeight * 4);
  // Half of each side's straight part, from the centre
  const halfX = width / 2 - radius;
  const halfY = height / 2 - radius;
  for (let y = 0; y < imageHeight; y++) {
    for (let x = 0; x < imageWidth; x++) {
      // From the centre of the chip, in CSS pixels
      const dx = Math.abs((x + 0.5) / pixelRatio - margin - width / 2) - halfX;
      const dy = Math.abs((y + 0.5) / pixelRatio - margin - height / 2) - halfY;
      const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
      const inside = Math.min(Math.max(dx, dy), 0);
      // Positive outside the edge, in pixels of the image
      const distance = (outside + inside - radius) * pixelRatio;
      const value = SDF_EDGE - distance / SDF_PX;
      const alpha = Math.round(Math.min(Math.max(value, 0), 1) * 255);
      data.set([255, 255, 255, alpha], (y * imageWidth + x) * 4);
    }
  }
  return { width: imageWidth, height: imageHeight, data };
}

/** Add the chip to the map, unless it has it */
function addChip(map: MapLibreMap): void {
  if (map.hasImage(CHIP_IMAGE)) return;
  const { width, height, radius, margin, pixelRatio: r } = CHIP;
  map.addImage(CHIP_IMAGE, chipImage(), {
    sdf: true,
    pixelRatio: r,
    // The straight middle of each side stretches; the corners do not
    stretchX: [[(margin + radius) * r, (margin + width - radius) * r]],
    stretchY: [[(margin + radius) * r, (margin + height - radius) * r]],
    // Where the text goes: inside the edge, clear of the corners
    content: [
      (margin + 5) * r,
      (margin + 3) * r,
      (margin + width - 5) * r,
      (margin + height - 3) * r,
    ],
  });
}

/**
 * Give the map the chip. It is not part of any style: a base style that
 * replaces the map's style may drop it, and the map asks for a missing
 * image by name, which is when it gets it again.
 */
export function addAirportLabelImages(map: MapLibreMap): void {
  addChip(map);
  map.on("styleimagemissing", (event: { id: string }) => {
    if (event.id === CHIP_IMAGE) addChip(map);
  });
}

/**
 * The content of the label source: one point per airport that is shown.
 * The source takes the name for the feature id, by which the hover state
 * is set (see setAirportLabelHover).
 * @param visible - The names of the airports shown, or null for all
 */
export function airportLabelFeatures(
  airports: readonly Airport[],
  counts: Readonly<Record<string, number>>,
  homeBase: string | null,
  visible: ReadonlySet<string> | null,
): GeoJSON.FeatureCollection<GeoJSON.Point, AirportLabelProperties> {
  return {
    type: "FeatureCollection",
    features: airports
      .filter((airport) => visible === null || visible.has(airport.name))
      .map((airport) => ({
        type: "Feature",
        properties: {
          name: airport.name,
          // The code the export found in the name, as the markers and the
          // lists of the panels have it
          icao: airport.code ?? NO_CODE_LABEL,
          count: counts[airport.name] ?? 0,
          home: airport.name === homeBase,
        },
        geometry: { type: "Point", coordinates: [airport.lon, airport.lat] },
      })),
  };
}

/**
 * Show an airport's label as hovered, or not. The pointer may be on the
 * label or on the marker's dot; either way both answer.
 */
export function setAirportLabelHover(
  map: MapLibreMap,
  name: string,
  hover: boolean,
): void {
  if (!map.getSource(MAP_SOURCES.airportLabels)) return;
  map.setFeatureState(
    { source: MAP_SOURCES.airportLabels, id: name },
    { hover },
  );
}
