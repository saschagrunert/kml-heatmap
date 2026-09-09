/**
 * Shared fixtures for the ReplayManager test files.
 *
 * The real domCache and the real pure helpers (formatTime, colors, bearing)
 * are used; only the map, layers and managers of MapApp are mocked.
 */
import { vi } from "vitest";
import type { MapApp } from "../../../../kml_heatmap/frontend/mapApp";
import type { PathSegment } from "../../../../kml_heatmap/frontend/types";
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
  buttonsHidden: boolean;
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
    buttonsHidden: false,
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
    fullStats: { max_groundspeed_knots: 130 },
  };
}

/** Elements created by mountReplayDom(), keyed by id with their tag name */
const REPLAY_DOM: Record<string, string> = {
  "replay-controls": "div",
  "replay-btn": "button",
  "replay-play-btn": "button",
  "replay-pause-btn": "button",
  "replay-slider": "input",
  "replay-slider-start": "span",
  "replay-slider-end": "span",
  "replay-time-display": "div",
  "replay-live": "div",
  "replay-speed": "select",
  "replay-autozoom-btn": "button",
  "altitude-btn": "button",
  "altitude-legend": "div",
  "airspeed-btn": "button",
  "airspeed-legend": "div",
  "heatmap-btn": "button",
  "airports-btn": "button",
  "aviation-btn": "button",
  "year-select": "select",
  "aircraft-select": "select",
};

export function mountReplayDom(): void {
  for (const [id, tag] of Object.entries(REPLAY_DOM)) {
    const element = document.createElement(tag);
    element.id = id;
    if (element instanceof HTMLInputElement) element.type = "range";
    if (id === "replay-speed") {
      for (const speed of ["10", "50", "100"]) {
        const option = document.createElement("option");
        option.value = speed;
        option.textContent = speed + "x";
        element.appendChild(option);
      }
    }
    document.body.appendChild(element);
  }
}

export function unmountReplayDom(): void {
  for (const id of Object.keys(REPLAY_DOM)) {
    document.getElementById(id)?.remove();
  }
  document
    .querySelectorAll(".toast-notification")
    .forEach((toast) => toast.remove());
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
