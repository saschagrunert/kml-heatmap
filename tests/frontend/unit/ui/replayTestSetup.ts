/**
 * Shared fixtures for the ReplayManager test files.
 *
 * The real domCache and the real pure helpers (formatTime, colors, bearing)
 * are used; only the map, layers and managers of MapApp are mocked.
 */
import { vi } from "vitest";
import type { MapApp } from "../../../../kml_heatmap/frontend/mapApp";
import type { PathSegment } from "../../../../kml_heatmap/frontend/types";
import { icon } from "../../../../kml_heatmap/frontend/utils/icons";
import { ReplayManager } from "../../../../kml_heatmap/frontend/ui/replayManager";

type AnyMock = ReturnType<typeof vi.fn>;

export interface ReplayMockMap {
  addLayer: AnyMock;
  removeLayer: AnyMock;
  hasLayer: AnyMock;
  invalidateSize: AnyMock;
  setView: AnyMock;
  panTo: AnyMock;
  setZoom: AnyMock;
  getSize: AnyMock;
  latLngToContainerPoint: AnyMock;
  fitBounds: AnyMock;
}

export interface ReplayMockApp {
  map: ReplayMockMap | null;
  heatmapLayer: { _canvas: HTMLCanvasElement | null };
  heatmapVisible: boolean;
  altitudeLayer: object;
  airspeedLayer: object;
  airportLayer: object;
  altitudeVisible: boolean;
  airspeedVisible: boolean;
  airportsVisible: boolean;
  aviationVisible: boolean;
  selectedPathIds: Set<number>;
  fullPathInfo: unknown[];
  fullPathSegments: PathSegment[] | null;
  currentData: {
    path_info: { id: number }[];
    path_segments: PathSegment[];
  } | null;
  altitudeRange: { min: number; max: number };
  airspeedRange: { min: number; max: number };
  stateManager: { saveMapState: AnyMock };
  layerManager: {
    redrawAltitudePaths: AnyMock;
    redrawAirspeedPaths: AnyMock;
    updateAltitudeLegend: AnyMock;
    updateAirspeedLegend: AnyMock;
  };
  dataManager: { applyHeatmapEmphasis: AnyMock };
  fullStats: { max_groundspeed_knots: number } | null;
}

/** Three consecutive segments of path 1 at t = 0, 60 and 120 seconds */
export function createSegments(): PathSegment[] {
  return [
    {
      path_id: 1,
      coords: [
        [48.0, 16.0],
        [48.1, 16.1],
      ],
      altitude_ft: 3000,
      groundspeed_knots: 100,
      time: 0,
    },
    {
      path_id: 1,
      coords: [
        [48.1, 16.1],
        [48.2, 16.2],
      ],
      altitude_ft: 4000,
      groundspeed_knots: 120,
      time: 60,
    },
    {
      path_id: 1,
      coords: [
        [48.2, 16.2],
        [48.3, 16.3],
      ],
      altitude_ft: 5000,
      groundspeed_knots: 130,
      time: 120,
    },
  ];
}

export function createMockMap(): ReplayMockMap {
  return {
    addLayer: vi.fn(),
    removeLayer: vi.fn(),
    hasLayer: vi.fn(() => true),
    invalidateSize: vi.fn(),
    setView: vi.fn(),
    panTo: vi.fn(),
    setZoom: vi.fn(),
    getSize: vi.fn(() => ({ x: 800, y: 600 })),
    latLngToContainerPoint: vi.fn(() => ({ x: 400, y: 300 })),
    fitBounds: vi.fn(),
  };
}

export function createReplayMockApp(): ReplayMockApp {
  return {
    map: createMockMap(),
    heatmapLayer: { _canvas: null },
    heatmapVisible: true,
    altitudeLayer: {},
    airspeedLayer: {},
    airportLayer: {},
    altitudeVisible: false,
    airspeedVisible: false,
    airportsVisible: true,
    aviationVisible: false,
    selectedPathIds: new Set<number>(),
    fullPathInfo: [],
    fullPathSegments: createSegments(),
    currentData: {
      path_info: [{ id: 1 }],
      path_segments: [
        { path_id: 1, altitude_ft: 3000, groundspeed_knots: 100 },
        { path_id: 1, altitude_ft: 5000, groundspeed_knots: 130 },
      ],
    },
    altitudeRange: { min: 0, max: 10000 },
    airspeedRange: { min: 0, max: 200 },
    stateManager: { saveMapState: vi.fn() },
    layerManager: {
      redrawAltitudePaths: vi.fn(),
      redrawAirspeedPaths: vi.fn(),
      updateAltitudeLegend: vi.fn(),
      updateAirspeedLegend: vi.fn(),
    },
    dataManager: { applyHeatmapEmphasis: vi.fn() },
    fullStats: { max_groundspeed_knots: 130 },
  };
}

/** One element of the replay DOM fixture */
interface FixtureNode {
  id: string;
  tag: string;
  attributes?: Record<string, string>;
  children?: FixtureNode[];
}

/**
 * The replay panel, nested the way map_template.html nests it. The shape
 * matters: the readout strip must land beside `#replay-live`, never inside
 * it, and a flat fixture could not tell the two apart.
 */
const REPLAY_PANEL: FixtureNode = {
  id: "replay-controls",
  tag: "div",
  children: [
    {
      id: "replay-controls-inner",
      tag: "div",
      children: [
        {
          id: "replay-buttons",
          tag: "div",
          children: [
            { id: "replay-play-btn", tag: "button" },
            { id: "replay-pause-btn", tag: "button" },
            { id: "replay-time-display", tag: "div" },
            { id: "replay-speed", tag: "select" },
            { id: "replay-autozoom-btn", tag: "button" },
          ],
        },
        {
          id: "replay-slider-container",
          tag: "div",
          children: [
            { id: "replay-slider-start", tag: "span" },
            { id: "replay-slider", tag: "input" },
            { id: "replay-slider-end", tag: "span" },
          ],
        },
        {
          id: "replay-live",
          tag: "div",
          attributes: { "aria-live": "polite", "aria-atomic": "true" },
        },
      ],
    },
  ],
};

/** Page chrome outside the replay panel that the manager reads or disables */
const PAGE_CHROME: FixtureNode[] = [
  { id: "replay-btn", tag: "button" },
  { id: "altitude-btn", tag: "button" },
  { id: "altitude-legend", tag: "div" },
  { id: "airspeed-btn", tag: "button" },
  { id: "airspeed-legend", tag: "div" },
  { id: "heatmap-btn", tag: "button" },
  { id: "airports-btn", tag: "button" },
  { id: "aviation-btn", tag: "button" },
  { id: "year-select", tag: "select" },
  { id: "aircraft-select", tag: "select" },
];

function buildFixtureNode(node: FixtureNode): HTMLElement {
  const element = document.createElement(node.tag);
  element.id = node.id;
  for (const [name, value] of Object.entries(node.attributes ?? {})) {
    element.setAttribute(name, value);
  }
  if (element instanceof HTMLInputElement) element.type = "range";
  if (node.id === "replay-btn") {
    // Same shape as the template: an injected icon plus a label span
    element.dataset["icon"] = "play";
    element.innerHTML =
      icon("play", 16) + '<span class="control-label">Replay</span>';
  }
  if (node.id === "replay-speed") {
    for (const speed of ["10", "50", "100"]) {
      const option = document.createElement("option");
      option.value = speed;
      option.textContent = speed + "x";
      element.appendChild(option);
    }
  }
  for (const child of node.children ?? []) {
    element.appendChild(buildFixtureNode(child));
  }
  return element;
}

export function mountReplayDom(): void {
  for (const node of [REPLAY_PANEL, ...PAGE_CHROME]) {
    document.body.appendChild(buildFixtureNode(node));
  }
}

export function unmountReplayDom(): void {
  for (const node of [REPLAY_PANEL, ...PAGE_CHROME]) {
    document.getElementById(node.id)?.remove();
  }
  document
    .querySelectorAll(".toast-notification")
    .forEach((toast) => toast.remove());
  // Replay hands the bottom edge over to the mobile bar, which only mounts
  // on a narrow viewport; clean it up so a test that changes the width
  // stays isolated
  document
    .querySelectorAll(".mobile-bar, .mobile-sheet, .sheet-scrim")
    .forEach((element) => element.remove());
  document.body.classList.remove("replay-active");
}

/** Get an element that must exist */
export function el(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing test element #${id}`);
  return element;
}

export function createReplayManager(app: ReplayMockApp): ReplayManager {
  return new ReplayManager(app as unknown as MapApp);
}

/** Drive requestAnimationFrame through fake timers (16 ms per frame) */
export function mockAnimationFrame(): void {
  vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((cb) => {
    return setTimeout(() => cb(performance.now()), 16) as unknown as number;
  });
  vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation((id) => {
    clearTimeout(id);
  });
}

/** Last message written to the replay live region */
export function liveRegionText(): string {
  return el("replay-live").textContent ?? "";
}
