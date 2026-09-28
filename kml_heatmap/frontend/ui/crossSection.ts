/**
 * Cross-section - the heights flown along a line drawn on the map
 *
 * The heights of circuits, approaches and climb-outs are hard to judge in
 * a tilted 3D view. This tool draws a line on the map (two clicks or taps,
 * or a drag; the map centre by keyboard) and shows, side on, where time was
 * spent within a corridor either side of it: distance along the line
 * across, height up, as a density image weighed like the heatmap, by its
 * By distance switch (calculations/crossSection.ts), which makes its
 * figures distances rather than times. Heights are above the ground under
 * each fix by default, or above sea level with the terrain under the flights
 * drawn beneath them. The corridor is drawn on the map for as long as the
 * tool is open, and its two ends can be dragged, or moved with the arrow
 * keys, afterwards.
 *
 * It counts the flights the filters keep and, while flights are selected,
 * the selected ones among them, so a click on a flight shows that flight
 * alone. The panel is the one at the bottom of the map that the altitude
 * profile of a selected flight uses: the profile steps aside while this is
 * open (crossSectionOpen), and neither replay, Wrapped nor the hotspot
 * tour runs with it, as they take the map over: they close it.
 *
 * It comes with the feature bundle, which the Cross-section control
 * fetches the first time it is used (MapApp.toggleCrossSection). A closure
 * rather than a class: the bundle carries a class's member names as they
 * are written.
 */
import {
  Marker,
  type GeoJSONSource,
  type Map as MapLibreMap,
} from "maplibre-gl";
import type { MapApp } from "../mapApp";
import {
  CORRIDOR_HALF_WIDTHS_M,
  corridorForScale,
  corridorOutline,
  crossSection,
  fromFrame,
  lineFrame,
  smoothCells,
  windowSeconds,
  type CrossSection,
  type HeightReference,
  type LineFrame,
} from "../calculations/crossSection";
import { datasetIndex } from "../calculations/datasetIndex";
import { ROUTE_SPEED_MS } from "../calculations/heatLines";
import { MAP_LAYERS } from "../utils/constants";
import { formatNumber } from "../utils/formatters";
import { frameCoalescer } from "../utils/frameCoalescer";
import {
  DEGREES_TO_RADIANS,
  metresPerPixel,
  type Coordinate,
} from "../utils/geometry";
import { setControlIcon, type IconName } from "../utils/icons";
import { cssVar, toLngLat } from "../utils/mapHelpers";

/** The control in the View group that opens and closes the tool */
const CROSS_SECTION_BUTTON_ID = "cross-section-btn";

/** The panel's height, which the toasts stand on (features.css) */
export const CROSS_SECTION_HEIGHT_VAR = "--cross-section-h";

/** The source of the corridor on the map, and its layers */
export const CROSS_SECTION_SOURCE = "cross-section";
export const CROSS_SECTION_LAYERS = {
  corridor: "cross-section-corridor",
  edge: "cross-section-edge",
  line: "cross-section-line",
} as const;

/**
 * Cells of the density image along the line and up: about one per pixel of
 * the chart on a screen of one device pixel per CSS pixel, two by two on a
 * finer one, which it is drawn smoothed on (see smoothCells)
 */
const COLUMNS = 400;
const ROWS = 128;

/** The chart's own units: it is stretched to the plot (see the CSS) */
const VIEW_W = 1000;
const VIEW_H = 100;

/** How far a pointer may move and still tap, in pixels */
const TAP_SLOP_PX = 6;

/** The shortest line there is a section of, in metres */
const MIN_LINE_M = 1;

/** How far an arrow key moves an end of the line, in pixels; with Shift */
const KEY_STEP_PX = 10;
const KEY_STEP_FAST_PX = 50;

/** How long after the last key or drag the result is announced, in ms */
const ANNOUNCE_DELAY_MS = 600;

/** The corridor's width on the screen as the line is drawn, in pixels */
const CORRIDOR_SCREEN_PX = 40;

/**
 * Cells either way of the one pointed at that the readout adds up: a
 * single cell is some ten metres by some ten feet, and mostly empty. The
 * window reaches past what smoothCells spreads a cell by, so a place the
 * chart colours never reads as empty.
 */
const READOUT_RADIUS = 4;

/**
 * The heatmap's colours by density (HEATMAP_GRADIENT in ui/heatmapPaint.ts),
 * `[share of the fullest cell, [r, g, b], alpha]`: deep blue through cyan
 * to white, each stop about four times the one before
 */
const DENSITY_STOPS: readonly (readonly [number, readonly number[], number])[] =
  [
    [0, [10, 30, 120], 0],
    [0.004, [20, 60, 190], 0.25],
    [0.015, [20, 120, 235], 0.5],
    [0.06, [40, 190, 255], 0.7],
    [0.25, [120, 230, 255], 0.85],
    [0.6, [200, 248, 255], 0.95],
    [1, [255, 255, 255], 1],
  ];

/**
 * Share of the cells with any time that sets the white end of the colours:
 * the apron and a holding point would otherwise take white alone and leave
 * the circuits in the dark
 */
const DENSITY_REFERENCE_QUANTILE = 0.95;

/** The labels of the corridor's widths */
function widthLabel(metres: number): string {
  return metres < 1000 ? `±${metres} m` : `±${metres / 1000} km`;
}

/** Minutes, or hours from ten of them, as the figures say them */
export function formatMinutes(seconds: number): string {
  const minutes = seconds / 60;
  if (minutes >= 600) return `${formatNumber(minutes / 60)} h`;
  return `${formatNumber(minutes, minutes < 10 ? 1 : 0)} min`;
}

/** Kilometres, with a decimal under ten */
function formatKm(metres: number): string {
  const km = metres / 1000;
  return `${formatNumber(km, km < 10 ? 1 : 0)} km`;
}

/**
 * The heat of `seconds` of a section as its figures say it: the time
 * spent, or by distance the distance flown (lengths at ROUTE_SPEED_MS)
 */
export function formatAmount(section: CrossSection, seconds: number): string {
  return section.route
    ? formatKm(seconds * ROUTE_SPEED_MS)
    : formatMinutes(seconds);
}

/** The unit of the heights of a section */
export function heightUnit(section: CrossSection): string {
  if (section.reference === "msl") return "ft MSL";
  return section.fromTerrain ? "ft AGL" : "ft above field";
}

/**
 * What the chart says, for a screen reader: the line, the corridor, the
 * time (the distance flown, By distance on), the flights and where most
 * of it was
 */
export function sectionSummary(
  section: CrossSection,
  selected: number,
): string {
  const where = `within ${widthLabel(section.halfWidthM).slice(1)} of a ${formatKm(section.lengthM)} line`;
  if (section.totalSeconds <= 0) {
    return `Cross-section: no ${selected ? "selected " : ""}flight passes ${where}`;
  }
  const flights = `${formatNumber(section.flights)} ${selected ? "selected " : ""}flight${section.flights === 1 ? "" : "s"}`;
  const busiest = section.busiest
    ? `, most of it in the air between ${formatNumber(section.busiest[0])} and ${formatNumber(section.busiest[1])} ${heightUnit(section)}`
    : "";
  const amount = formatAmount(section, section.totalSeconds);
  return `Cross-section: ${amount} ${section.route ? "flown by" : "from"} ${flights} ${where}${busiest}`;
}

/** The colour of a cell holding `share` of the reference, as RGBA */
function densityColour(share: number, out: Uint8ClampedArray, at: number) {
  const t = Math.min(1, share);
  let i = 1;
  while (i < DENSITY_STOPS.length - 1 && DENSITY_STOPS[i]![0] < t) i++;
  const [from, rgbFrom, alphaFrom] = DENSITY_STOPS[i - 1]!;
  const [to, rgbTo, alphaTo] = DENSITY_STOPS[i]!;
  const f = Math.min(1, Math.max(0, (t - from) / (to - from)));
  for (let c = 0; c < 3; c++) {
    out[at + c] = rgbFrom[c]! + (rgbTo[c]! - rgbFrom[c]!) * f;
  }
  out[at + 3] = 255 * (alphaFrom + (alphaTo - alphaFrom) * f);
}

/** The seconds of the cell the colours reach white at */
export function densityReference(seconds: Float64Array): number {
  // A typed array sorts by value, and fast
  const filled = seconds.filter((value) => value > 0).sort();
  if (!filled.length) return 0;
  return filled[
    Math.min(
      filled.length - 1,
      Math.floor(filled.length * DENSITY_REFERENCE_QUANTILE),
    )
  ]!;
}

/** An element with a class, in `parent` */
function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  parent: Element,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  el.className = className;
  parent.append(el);
  return el;
}

/** A shape of the chart, with a class */
function shape(tag: string, className: string, parent: Element): SVGElement {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  el.setAttribute("class", className);
  parent.append(el);
  return el;
}

/** A button named the same to the eye and the ear */
function button(
  className: string,
  name: string,
  parent: Element,
  iconName?: IconName,
): HTMLButtonElement {
  const el = element("button", className, parent);
  el.type = "button";
  el.title = name;
  el.setAttribute("aria-label", name);
  if (iconName) setControlIcon(el, iconName, 16);
  return el;
}

/** A select of `options`, `[value, label]` */
function select(
  name: string,
  options: readonly (readonly [string, string])[],
  parent: Element,
): HTMLSelectElement {
  const el = element("select", "btn-surface section-select", parent);
  el.setAttribute("aria-label", name);
  el.title = name;
  for (const [value, label] of options) {
    el.append(new Option(label, value));
  }
  return el;
}

/** The tool of an app */
interface Tool {
  toggle(): void;
  isOpen(): boolean;
}

const tools = new WeakMap<MapApp, Tool>();

/** Who wants to hear the tool of each app open and close */
const followers = new WeakMap<MapApp, Set<() => void>>();

/** Whether the cross-section of `app` is open */
export function crossSectionOpen(app: MapApp): boolean {
  return tools.get(app)?.isOpen() ?? false;
}

/**
 * Call `listener` whenever the cross-section of `app` opens or closes, for
 * as long as `signal` lives: the profile strip steps aside for it
 */
export function followCrossSection(
  app: MapApp,
  listener: () => void,
  signal: AbortSignal,
): void {
  let listeners = followers.get(app);
  if (!listeners) followers.set(app, (listeners = new Set()));
  const own = listeners;
  own.add(listener);
  signal.addEventListener("abort", () => own.delete(listener), {
    once: true,
  });
}

/** Open the cross-section of `app`, or close it */
export function toggleCrossSection(app: MapApp): void {
  toolOf(app).toggle();
}

function toolOf(app: MapApp): Tool {
  let tool = tools.get(app);
  if (!tool) {
    tool = createTool(app);
    tools.set(app, tool);
  }
  return tool;
}

/** Where the drawing of a line is */
type Phase = "closed" | "placing" | "shown";

/** A press on the map while a line is drawn */
interface Press {
  id: number;
  x: number;
  y: number;
  at: Coordinate;
  dragging: boolean;
}

function createTool(app: MapApp): Tool {
  let phase: Phase = "closed";
  /** The line shown, [lat, lon] at each end */
  let line: [Coordinate, Coordinate] | null = null;
  /** The first end of a line being drawn */
  let first: Coordinate | null = null;
  let press: Press | null = null;
  /** The click that ends a press that placed a point goes to no flight */
  let swallowClick = false;
  /** The corridor's half width once picked, rather than from the zoom */
  let chosenWidth: number | null = null;
  let halfWidth: number = CORRIDOR_HALF_WIDTHS_M[1];
  let reference: HeightReference = "agl";
  let section: CrossSection | null = null;
  /** The seconds of the cell the colours reach white at */
  let densityRef = 0;
  let frame: LineFrame | null = null;
  let frameRequest = 0;
  let announceTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Whether the map panned by dragging, and zoomed on a double click or
   * tap, as the tool started drawing
   */
  let panned = true;
  let zoomedOnDouble = true;

  // The panel
  const root = document.createElement("section");
  root.id = "cross-section";
  root.hidden = true;
  root.setAttribute("aria-labelledby", "cross-section-title");
  const bar = element("div", "section-bar", root);
  const title = element("h2", "section-title", bar);
  title.id = "cross-section-title";
  title.textContent = "Cross-section";
  const widthSelect = select(
    "Corridor either side of the line",
    CORRIDOR_HALF_WIDTHS_M.map((metres) => [
      String(metres),
      widthLabel(metres),
    ]),
    bar,
  );
  const referenceSelect = select(
    "Heights",
    [
      ["agl", "AGL"],
      ["msl", "MSL"],
    ],
    bar,
  );
  const redraw = button(
    "btn-surface section-btn",
    "Draw a new line",
    bar,
    "ruler",
  );
  const close = button(
    "btn-surface section-btn",
    "Close the cross-section",
    bar,
    "close",
  );
  const head = element("div", "profile-head", root);
  const stats = element("div", "profile-stats", head);
  const readout = element("div", "profile-readout", head);
  const place = element("div", "section-place", root);
  const hint = element("p", "section-hint", place);
  const placeButton = button("btn-surface section-place-btn", "", place);
  const plot = element("div", "section-plot", root);
  plot.setAttribute("role", "img");
  // The chart's canvas, a pixel for each of the screen's, and the density
  // image it draws smoothed, a pixel per cell
  const canvas = element("canvas", "section-density", plot);
  const cellImage = document.createElement("canvas");
  cellImage.width = COLUMNS;
  cellImage.height = ROWS;
  const svg = shape("svg", "section-chart", plot);
  svg.setAttribute("viewBox", `0 0 ${VIEW_W} ${VIEW_H}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("aria-hidden", "true");
  const grid = shape("path", "section-grid", svg);
  const ground = shape("path", "section-ground", svg);
  const hover = shape("line", "section-hover", svg);
  hover.setAttribute("y2", String(VIEW_H));
  /** The cells the readout adds up */
  const cells = shape("rect", "section-window", svg);
  for (const mark of [hover, cells]) mark.setAttribute("visibility", "hidden");
  const ticks = element("div", "section-ticks", plot);
  ticks.setAttribute("aria-hidden", "true");
  const axis = element("div", "profile-axis", root);
  axis.setAttribute("aria-hidden", "true");
  const axisStart = element("span", "", axis);
  const axisEnd = element("span", "", axis);
  const live = element("div", "visually-hidden", root);
  live.setAttribute("aria-live", "polite");

  /** The two ends on the map, A and B */
  const handles = (["A", "B"] as const).map((label, index) => {
    const handle = document.createElement("div");
    handle.className = "section-handle";
    handle.textContent = label;
    handle.tabIndex = 0;
    handle.setAttribute("role", "button");
    handle.setAttribute(
      "aria-label",
      `${index ? "End" : "Start"} of the cross-section, ${label}: drag it, or move it with the arrow keys`,
    );
    return new Marker({ element: handle, draggable: true });
  });
  /** The place on the map the pointer on the chart stands for */
  let dot: Marker | null = null;

  const map = (): MapLibreMap | null => app.map;

  const notify = (): void => {
    for (const listener of followers.get(app) ?? []) listener();
  };

  /** Keep the control's pressed state and the page's class in step */
  const syncChrome = (): void => {
    // Asked first: a browser may let go of the focus of a part as it hides
    const active = document.activeElement;
    const open = phase !== "closed";
    root.hidden = !open;
    document.body.classList.toggle("cross-section-open", open);
    document
      .getElementById(CROSS_SECTION_BUTTON_ID)
      ?.setAttribute("aria-pressed", String(open));
    const placing = phase === "placing";
    place.hidden = !placing;
    plot.hidden = placing;
    axis.hidden = placing;
    redraw.hidden = placing;
    if (placing) {
      stats.textContent = "";
      readout.textContent = "";
      hint.textContent = first
        ? "Now B, the end of the line. Escape starts again."
        : "Click or tap two points on the map, or drag a line. Escape cancels.";
      placeButton.textContent = `Set ${first ? "B" : "A"} at the map centre`;
    }
    // Focus on a part that went away goes to the one in its place: the
    // button that placed B hands it to the one that draws a new line
    if (
      open &&
      active instanceof HTMLElement &&
      root.contains(active) &&
      active.closest("[hidden]")
    ) {
      (placing ? placeButton : redraw).focus({ preventScroll: true });
    }
  };

  // The corridor on the map

  /** The corridor and the line from `from` to `to`, as GeoJSON */
  const corridorData = (
    from: Coordinate | null,
    to: Coordinate | null,
  ): GeoJSON.FeatureCollection => {
    const features: GeoJSON.Feature[] = [];
    if (from && to) {
      const outline = corridorOutline(lineFrame(from, to), halfWidth);
      features.push(
        {
          type: "Feature",
          properties: { kind: "corridor" },
          geometry: {
            type: "Polygon",
            coordinates: [outline.ring.map(toLngLat)],
          },
        },
        {
          type: "Feature",
          properties: { kind: "line" },
          geometry: {
            type: "LineString",
            coordinates: outline.line.map(toLngLat),
          },
        },
      );
    }
    return { type: "FeatureCollection", features };
  };

  /** Add the source and the layers of the corridor where they are missing */
  const addLayers = (target: MapLibreMap): void => {
    if (!target.getSource(CROSS_SECTION_SOURCE)) {
      target.addSource(CROSS_SECTION_SOURCE, {
        type: "geojson",
        data: corridorData(null, null),
      });
    }
    const colour = cssVar("--color-accent-blue") || "#4facfe";
    const before = target.getLayer(MAP_LAYERS.airportLabels)
      ? MAP_LAYERS.airportLabels
      : undefined;
    const layers = [
      {
        id: CROSS_SECTION_LAYERS.corridor,
        type: "fill",
        source: CROSS_SECTION_SOURCE,
        filter: ["==", ["get", "kind"], "corridor"],
        paint: { "fill-color": colour, "fill-opacity": 0.12 },
      },
      {
        id: CROSS_SECTION_LAYERS.edge,
        type: "line",
        source: CROSS_SECTION_SOURCE,
        filter: ["==", ["get", "kind"], "corridor"],
        paint: {
          "line-color": colour,
          "line-width": 1.5,
          "line-dasharray": [2, 2],
        },
      },
      {
        id: CROSS_SECTION_LAYERS.line,
        type: "line",
        source: CROSS_SECTION_SOURCE,
        filter: ["==", ["get", "kind"], "line"],
        layout: { "line-cap": "round" },
        paint: { "line-color": "#ffffff", "line-width": 2 },
      },
    ] as const;
    for (const layer of layers) {
      if (!target.getLayer(layer.id)) {
        target.addLayer(
          layer as unknown as Parameters<MapLibreMap["addLayer"]>[0],
          before,
        );
      }
    }
  };

  const removeLayers = (target: MapLibreMap): void => {
    for (const id of Object.values(CROSS_SECTION_LAYERS)) {
      if (target.getLayer(id)) target.removeLayer(id);
    }
    if (target.getSource(CROSS_SECTION_SOURCE)) {
      target.removeSource(CROSS_SECTION_SOURCE);
    }
  };

  /** Draw the corridor from `from` to `to`, or none */
  const drawCorridor = (from: Coordinate | null, to: Coordinate | null) => {
    const target = map();
    const source = target?.getSource<GeoJSONSource>(CROSS_SECTION_SOURCE);
    void source?.setData(corridorData(from, to));
  };

  /** Put the handles on the ends of the line, or take them off */
  const placeHandles = (): void => {
    const target = map();
    handles.forEach((handle, index) => {
      const at = phase === "shown" ? line?.[index] : index ? null : first;
      if (at && target) handle.setLngLat(toLngLat(at)).addTo(target);
      else handle.remove();
    });
  };

  /** The corridor for the map's zoom where none was picked */
  const widthForZoom = (at: Coordinate): number => {
    const zoom = map()?.getZoom() ?? 12;
    return corridorForScale(
      metresPerPixel(zoom) * Math.cos(at[0] * DEGREES_TO_RADIANS),
      CORRIDOR_SCREEN_PX,
    );
  };

  // The section and its chart

  /** Whether a flight counts: the filters keep it, and it is selected */
  const keeper = (): ((pathId: number) => boolean) | null => {
    const data = app.currentData;
    if (!data) return null;
    const kept = datasetIndex(data).filter(
      app.selectedYear,
      app.selectedAircraft,
    ).pathIds;
    const selected = app.selectedPathIds;
    return selected.size
      ? (pathId) => kept.has(pathId) && selected.has(pathId)
      : (pathId) => kept.has(pathId);
  };

  /** Work the section out again and draw it */
  const compute = (): void => {
    const keep = keeper();
    const data = app.currentData;
    section =
      line && keep && data
        ? crossSection({
            segments: data.path_segments,
            keep,
            start: line[0],
            end: line[1],
            halfWidthM: halfWidth,
            reference,
            route: app.routeWeighting,
            columns: COLUMNS,
            rows: ROWS,
          })
        : null;
    frame = line ? lineFrame(line[0], line[1]) : null;
    draw();
  };

  const draw = (): void => {
    leave();
    if (!section) {
      stats.textContent = "";
      plot.removeAttribute("aria-label");
      return;
    }
    const shown = section;
    // The density image, a pixel per cell, the bottom row last
    const context = cellImage.getContext("2d");
    const density = smoothCells(shown.seconds, COLUMNS, ROWS);
    densityRef = densityReference(density);
    if (context) {
      const image = context.createImageData(COLUMNS, ROWS);
      for (let row = 0; row < ROWS; row++) {
        for (let column = 0; column < COLUMNS; column++) {
          const value = density[row * COLUMNS + column]!;
          if (value <= 0) continue;
          const at = ((ROWS - 1 - row) * COLUMNS + column) * 4;
          densityColour(value / densityRef, image.data, at);
        }
      }
      context.putImageData(image, 0, 0);
    }
    paint();
    const { bottomFt, topFt, gridStepFt } = shown;
    const yOf = (feet: number): string =>
      (VIEW_H - ((feet - bottomFt) / (topFt - bottomFt)) * VIEW_H).toFixed(1);
    let lines = "";
    ticks.replaceChildren();
    for (let feet = bottomFt; feet < topFt; feet += gridStepFt) {
      if (feet > bottomFt) lines += `M0 ${yOf(feet)}H${VIEW_W}`;
      const tick = element("span", "section-tick", ticks);
      tick.style.bottom = `${((feet - bottomFt) / (topFt - bottomFt)) * 100}%`;
      tick.textContent = formatNumber(feet);
    }
    element("span", "section-tick section-unit", ticks).textContent =
      heightUnit(shown);
    grid.setAttribute("d", lines);
    // Above sea level, the ground under the flights, filled in
    let floor = "";
    if (shown.reference === "msl" && shown.groundFt) {
      const columnW = VIEW_W / COLUMNS;
      floor = `M0 ${VIEW_H}`;
      shown.groundFt.forEach((feet, column) => {
        floor += `L${((column + 0.5) * columnW).toFixed(1)} ${yOf(feet)}`;
      });
      floor += `L${VIEW_W} ${yOf(shown.groundFt[COLUMNS - 1]!)}L${VIEW_W} ${VIEW_H}Z`;
    }
    ground.setAttribute("d", floor);

    const unit = heightUnit(shown);
    const figures: [string, string][] = [
      [
        shown.route ? "Distance" : "Time",
        formatAmount(shown, shown.totalSeconds),
      ],
      [
        app.selectedPathIds.size ? "Selected flights" : "Flights",
        formatNumber(shown.flights),
      ],
    ];
    if (shown.busiest) {
      figures.push([
        "Most flown",
        `${formatNumber(shown.busiest[0])} to ${formatNumber(shown.busiest[1])} ${unit}`,
      ]);
    }
    if (shown.aboveSeconds >= 30) {
      figures.push(["Higher", formatAmount(shown, shown.aboveSeconds)]);
    }
    stats.replaceChildren();
    for (const [label, value] of figures) {
      const stat = element("span", "profile-stat", stats);
      element("span", "profile-stat-label", stat).textContent = label;
      stat.append(" ", value);
    }
    axisStart.textContent = "A · 0 km";
    axisEnd.textContent = `${formatKm(shown.lengthM)} · B`;
    plot.setAttribute(
      "aria-label",
      sectionSummary(shown, app.selectedPathIds.size),
    );
  };

  /**
   * Draw the density image onto the chart, stretched to its pixels on the
   * screen and smoothed; again whenever the chart changes size
   */
  const paint = (): void => {
    const context = canvas.getContext("2d");
    const scale = window.devicePixelRatio || 1;
    const width = Math.round(plot.clientWidth * scale);
    const height = Math.round(plot.clientHeight * scale);
    if (!context || !section || width <= 0 || height <= 0) return;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    context.clearRect(0, 0, width, height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(cellImage, 0, 0, width, height);
  };

  /** Say what the chart shows once the line has come to rest */
  const announce = (): void => {
    if (announceTimer !== null) clearTimeout(announceTimer);
    announceTimer = null;
    live.textContent = section
      ? sectionSummary(section, app.selectedPathIds.size)
      : "";
  };

  const announceSoon = (): void => {
    if (announceTimer !== null) clearTimeout(announceTimer);
    announceTimer = setTimeout(announce, ANNOUNCE_DELAY_MS);
  };

  /** Draw the corridor and the chart of the line in the next frame */
  const schedule = (): void => {
    if (frameRequest) return;
    frameRequest = requestAnimationFrame(() => {
      frameRequest = 0;
      if (phase !== "shown") return;
      drawCorridor(line![0], line![1]);
      compute();
    });
  };

  // Reading the chart

  const leave = (): void => {
    hover.setAttribute("visibility", "hidden");
    cells.setAttribute("visibility", "hidden");
    readout.textContent = "";
    dot?.remove();
  };

  /** Read the chart under a pointer at `clientX`, `clientY` */
  const readAt = (clientX: number, clientY: number): void => {
    if (!section || !frame) return;
    const box = plot.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return;
    const x = Math.min(1, Math.max(0, (clientX - box.left) / box.width));
    const y = Math.min(1, Math.max(0, (box.bottom - clientY) / box.height));
    const column = Math.min(COLUMNS - 1, Math.floor(x * COLUMNS));
    const row = Math.min(ROWS - 1, Math.floor(y * ROWS));
    const along = x * section.lengthM;
    const rowFt = (section.topFt - section.bottomFt) / ROWS;
    // The band the readout adds up, to the nearest 10 ft
    const tens = (edge: number): string =>
      formatNumber(
        Math.max(0, Math.round((section!.bottomFt + edge * rowFt) / 10) * 10),
      );
    const low = Math.max(0, row - READOUT_RADIUS);
    const high = Math.min(ROWS, row + READOUT_RADIUS + 1);
    const seconds = windowSeconds(section, column, row, READOUT_RADIUS);
    readout.textContent = [
      formatKm(along),
      `${tens(low)} to ${tens(high)} ${heightUnit(section)}`,
      seconds > 0 ? formatAmount(section, seconds) : "no flights here",
    ].join(" · ");
    const chartX = (x * VIEW_W).toFixed(1);
    hover.setAttribute("x1", chartX);
    hover.setAttribute("x2", chartX);
    const left = Math.max(0, column - READOUT_RADIUS);
    const right = Math.min(COLUMNS, column + READOUT_RADIUS + 1);
    cells.setAttribute("x", String((left / COLUMNS) * VIEW_W));
    cells.setAttribute("width", String(((right - left) / COLUMNS) * VIEW_W));
    cells.setAttribute("y", String(VIEW_H - (high / ROWS) * VIEW_H));
    cells.setAttribute("height", String(((high - low) / ROWS) * VIEW_H));
    for (const mark of [hover, cells])
      mark.setAttribute("visibility", "visible");
    const target = map();
    if (!target) return;
    dot ??= new Marker({
      element: Object.assign(document.createElement("div"), {
        className: "profile-map-dot",
      }),
    });
    dot.setLngLat(toLngLat(fromFrame(frame, along, 0)));
    // Put on the map once and moved after that: MapLibre takes a marker
    // off the map and puts it on again for every addTo, which was at every
    // move of the pointer over the chart
    if (!dot.getElement().parentNode) dot.addTo(target);
  };

  // Drawing a line

  /** Where a pointer is on the map, [lat, lon] */
  const pointAt = (target: MapLibreMap, event: PointerEvent): Coordinate => {
    const box = target.getContainer().getBoundingClientRect();
    const at = target.unproject([
      event.clientX - box.left,
      event.clientY - box.top,
    ]);
    return [at.lat, at.lng];
  };

  /** Whether the ends `from` and `to` are too close to make a line */
  const tooShort = (from: Coordinate, to: Coordinate): boolean =>
    lineFrame(from, to).lengthM < MIN_LINE_M;

  /**
   * Draw the corridor of the line being drawn to where the pointer of
   * `event` is, once a frame: the map's source is set anew for each, which
   * MapLibre hands to its worker, and a pointer moves many times a frame
   */
  const corridorFrame = frameCoalescer<PointerEvent>((event) => {
    const target = map();
    if (phase === "placing" && first && target) {
      drawCorridor(first, pointAt(target, event));
    }
  });

  /** Stop drawing: the map pans by dragging and zooms on a double again */
  const stopPlacing = (): void => {
    press = null;
    first = null;
    corridorFrame.cancel();
    const target = map();
    if (!target) return;
    target.getContainer().classList.remove("is-drawing-section");
    if (panned) target.dragPan.enable();
    if (zoomedOnDouble) target.doubleClickZoom.enable();
  };

  /** Show the line from `from` to `to`, if it is one */
  const finish = (from: Coordinate, to: Coordinate): void => {
    if (tooShort(from, to)) {
      live.textContent = "B is where A is: move the map, then set B";
      return;
    }
    stopPlacing();
    line = [from, to];
    if (chosenWidth === null) {
      halfWidth = widthForZoom(from);
      widthSelect.value = String(halfWidth);
    }
    phase = "shown";
    syncChrome();
    placeHandles();
    drawCorridor(from, to);
    compute();
    announce();
  };

  /** Start drawing a line; the one shown stays for Escape */
  const startPlacing = (): void => {
    const target = map();
    if (target && phase !== "placing") {
      panned = target.dragPan.isEnabled();
      target.dragPan.disable();
      // Two taps that place A and B would zoom the map in. The double tap
      // has no event to prevent (see keepMarkerTapsFromZoom), and switched
      // off, its recogniser does not see the second tap begin either.
      zoomedOnDouble = target.doubleClickZoom.isEnabled();
      target.doubleClickZoom.disable();
      target.getContainer().classList.add("is-drawing-section");
    }
    phase = "placing";
    first = null;
    press = null;
    if (chosenWidth === null && target) {
      halfWidth = widthForZoom([target.getCenter().lat, 0]);
      widthSelect.value = String(halfWidth);
    }
    syncChrome();
    placeHandles();
    drawCorridor(null, null);
    plot.removeAttribute("aria-label");
    leave();
  };

  /** Set a point of the line being drawn at `at` */
  const setPoint = (at: Coordinate): void => {
    if (!first) {
      first = at;
      syncChrome();
      placeHandles();
      return;
    }
    finish(first, at);
  };

  const onPointerDown = (event: PointerEvent): void => {
    // Whatever the press that placed a point left behind is done with: a
    // drag by touch, or one let go of beside the map, has no click to end
    // it, and the next click on the map is a flight's again
    swallowClick = false;
    const target = map();
    if (phase !== "placing" || !target) return;
    if (!event.isPrimary || event.button !== 0) {
      // A second finger: a pinch, not a line
      press = null;
      return;
    }
    if (!target.getCanvasContainer().contains(event.target as Node)) return;
    press = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      at: pointAt(target, event),
      dragging: false,
    };
  };

  const onPointerMove = (event: PointerEvent): void => {
    const target = map();
    if (phase !== "placing" || !target) return;
    if (press && event.pointerId === press.id) {
      if (
        !press.dragging &&
        Math.hypot(event.clientX - press.x, event.clientY - press.y) >
          TAP_SLOP_PX
      ) {
        press.dragging = true;
        first = press.at;
        syncChrome();
        placeHandles();
      }
      if (press.dragging) corridorFrame.schedule(event);
    } else if (first && !press && event.pointerType === "mouse") {
      corridorFrame.schedule(event);
    }
  };

  const onPointerUp = (event: PointerEvent): void => {
    const target = map();
    const ended = press;
    if (phase !== "placing" || !target || !ended) return;
    if (event.pointerId !== ended.id) return;
    press = null;
    swallowClick = true;
    if (ended.dragging) finish(first!, pointAt(target, event));
    else setPoint(ended.at);
  };

  /** A click that placed a point selects no flight, nor opens a popup */
  const onClick = (event: MouseEvent): void => {
    const target = map();
    if (phase !== "placing" && !swallowClick) return;
    if (!target?.getCanvasContainer().contains(event.target as Node)) return;
    // The second click of a double one, which placed B, has its dblclick
    // still to come, and the map zooms in on that
    if (event.type === "dblclick" || event.detail < 2) swallowClick = false;
    event.stopPropagation();
    event.preventDefault();
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    // An Escape in a popup or on an airport's marker closes the popup
    const from = event.target;
    if (
      phase === "closed" ||
      (from instanceof Element &&
        from.closest(
          ".maplibregl-popup, .maplibregl-marker:not(.section-handle)",
        ))
    ) {
      return;
    }
    event.preventDefault();
    if (phase === "placing" && (first || press)) {
      // Back to the start of the line being drawn
      startPlacing();
    } else if (phase === "placing" && line) {
      // Back to the line of before
      stopPlacing();
      phase = "shown";
      syncChrome();
      placeHandles();
      drawCorridor(line[0], line[1]);
      compute();
    } else {
      hide();
    }
  };

  /** Move an end of the line with the arrow keys */
  const onHandleKey = (index: number, event: KeyboardEvent): void => {
    const steps: Partial<Record<string, [number, number]>> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };
    const step = steps[event.key];
    const target = map();
    if (!step || !target || !line) return;
    // The map would pan by the same keys
    event.preventDefault();
    event.stopPropagation();
    const pixels = event.shiftKey ? KEY_STEP_FAST_PX : KEY_STEP_PX;
    const point = target.project(toLngLat(line[index]!));
    const moved = target.unproject([
      point.x + step[0] * pixels,
      point.y + step[1] * pixels,
    ]);
    // Onto the other end, there would be no line left: the key does nothing
    if (tooShort([moved.lat, moved.lng], line[1 - index]!)) return;
    line[index] = [moved.lat, moved.lng];
    handles[index]!.setLngLat([moved.lng, moved.lat]);
    schedule();
    announceSoon();
  };

  handles.forEach((handle, index) => {
    handle.on("drag", () => {
      if (phase !== "shown" || !line) return;
      const at = handle.getLngLat();
      const moved: Coordinate = [at.lat, at.lng];
      // On the other end the line keeps where this one was last apart
      if (tooShort(moved, line[1 - index]!)) return;
      line[index] = moved;
      schedule();
    });
    handle.on("dragend", () => {
      // An end let go of on the other goes back to where the line has it
      if (phase === "shown" && line) handle.setLngLat(toLngLat(line[index]!));
      announceSoon();
    });
    handle
      .getElement()
      .addEventListener("keydown", (event) => onHandleKey(index, event));
  });

  // Opening and closing

  /** The listeners of the tool on the map and the page, while it is open */
  let listening: AbortController | null = null;

  const listen = (target: MapLibreMap): void => {
    listening = new AbortController();
    const { signal } = listening;
    const container = target.getContainer();
    const capture = { capture: true, signal };
    container.addEventListener("pointerdown", onPointerDown, capture);
    // A drag may leave the map before it lets go
    window.addEventListener("pointermove", onPointerMove, capture);
    window.addEventListener("pointerup", onPointerUp, capture);
    window.addEventListener("pointercancel", () => (press = null), capture);
    // Clicks and double clicks as a point is placed: the map zoomed in on
    // the second of two quick clicks
    container.addEventListener("click", onClick, capture);
    container.addEventListener("dblclick", onClick, capture);
    // Last of all, on the window: what is open over the tool (the phone's
    // sheet) takes its Escape on the document and prevents it
    window.addEventListener("keydown", onKeyDown, { signal });
    // A new base style drops the corridor, which is none of the app's for
    // `withDataLayers` to carry
    const styled = target.on("styledata", () => {
      if (target.getSource(CROSS_SECTION_SOURCE)) return;
      addLayers(target);
      if (phase === "shown") drawCorridor(line![0], line![1]);
    });
    signal.addEventListener("abort", () => styled.unsubscribe(), {
      once: true,
    });
  };

  const show = (): void => {
    // Nor while the hotspot tour holds the map, which closes it as it
    // starts; its control is held then, and this covers a late bundle
    if (app.replayActive || app.wrappedVisible || app.tourView || !map()) {
      return;
    }
    const target = map()!;
    const mapElement = document.getElementById("map");
    // Ahead of the map, like the controls: after it, it was past every
    // airport marker in the tab order
    if (mapElement?.parentElement === document.body) mapElement.before(root);
    else document.body.append(root);
    addLayers(target);
    listen(target);
    startPlacing();
    notify();
    placeButton.focus({ preventScroll: true });
  };

  const hide = (): void => {
    if (phase === "closed") return;
    stopPlacing();
    phase = "closed";
    line = null;
    section = null;
    frame = null;
    if (frameRequest) cancelAnimationFrame(frameRequest);
    frameRequest = 0;
    if (announceTimer !== null) clearTimeout(announceTimer);
    announceTimer = null;
    listening?.abort();
    listening = null;
    const active = document.activeElement;
    const hadFocus =
      !!active &&
      (root.contains(active) ||
        handles.some((handle) => handle.getElement() === active));
    leave();
    placeHandles();
    const target = map();
    if (target) removeLayers(target);
    syncChrome();
    notify();
    if (hadFocus) document.getElementById(CROSS_SECTION_BUTTON_ID)?.focus();
  };

  // The controls of the panel
  const lifetime = { signal: app.signal };
  placeButton.addEventListener(
    "click",
    () => {
      const center = map()?.getCenter();
      if (center) setPoint([center.lat, center.lng]);
    },
    lifetime,
  );
  redraw.addEventListener("click", startPlacing, lifetime);
  close.addEventListener("click", hide, lifetime);
  widthSelect.addEventListener(
    "change",
    () => {
      chosenWidth = halfWidth = Number(widthSelect.value);
      if (phase === "shown") {
        drawCorridor(line![0], line![1]);
        compute();
        announceSoon();
      }
    },
    lifetime,
  );
  referenceSelect.addEventListener(
    "change",
    () => {
      reference = referenceSelect.value === "msl" ? "msl" : "agl";
      compute();
      announceSoon();
    },
    lifetime,
  );
  plot.addEventListener(
    "pointermove",
    (event) => readAt(event.clientX, event.clientY),
    lifetime,
  );
  plot.addEventListener(
    "pointerdown",
    (event) => {
      // A finger on the chart reads it rather than scrolling the page
      event.preventDefault();
      readAt(event.clientX, event.clientY);
    },
    lifetime,
  );
  plot.addEventListener("pointerleave", leave, lifetime);
  plot.addEventListener(
    "pointerup",
    (event) => {
      if (event.pointerType !== "mouse") leave();
    },
    lifetime,
  );

  const resized =
    typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => {
          const height = root.offsetHeight;
          if (height > 0) {
            document.documentElement.style.setProperty(
              CROSS_SECTION_HEIGHT_VAR,
              `${height}px`,
            );
          }
          paint();
        });
  resized?.observe(root);
  resized?.observe(plot);

  const store = app.store;
  store.subscribeKeys(
    // The flights it counts, and how the heatmap weighs them
    [
      "currentData",
      "selectedYear",
      "selectedAircraft",
      "selectedPathIds",
      "routeWeighting",
    ],
    () => {
      if (phase !== "shown") return;
      compute();
      announceSoon();
    },
  );
  // Replay and Wrapped take the map over
  store.subscribeKeys(["replayActive", "wrappedVisible"], () => {
    if (app.replayActive || app.wrappedVisible) hide();
  });
  app.signal.addEventListener(
    "abort",
    () => {
      hide();
      resized?.disconnect();
      root.remove();
      tools.delete(app);
    },
    { once: true },
  );

  return {
    isOpen: () => phase !== "closed",
    toggle: () => (phase === "closed" ? show() : hide()),
  };
}
