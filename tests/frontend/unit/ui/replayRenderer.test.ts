import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  AirplaneMarker,
  ReplayRenderer,
  appendTrailSegment,
  findSegmentIndexAtTime,
  trailFeatureCollection,
  truncateTrail,
} from "../../../../kml_heatmap/frontend/ui/replayRenderer";
import {
  AUTO_ZOOM_DURATION_MS,
  AUTO_ZOOM_SETTLE_MS,
  RECENTER_PAN_DURATION_MS,
  SEEK_PAN_THROTTLE_MS,
  iconHeading,
  unwrapRotation,
  zoomOutSteps,
} from "../../../../kml_heatmap/frontend/ui/replayCamera";
import * as motion from "../../../../kml_heatmap/frontend/utils/motion";
import {
  liftFt,
  liftOffsetPx,
  pointOnFlight,
  smoothFlights,
  type SmoothedFlights,
} from "../../../../kml_heatmap/frontend/calculations/lift";
import { ReplayState } from "../../../../kml_heatmap/frontend/ui/replayState";
import type { ReplayManager } from "../../../../kml_heatmap/frontend/ui/replayManager";
import type { MapApp } from "../../../../kml_heatmap/frontend/mapApp";
import type { PathSegment } from "../../../../kml_heatmap/frontend/types";
import {
  getColorForAirspeed,
  getColorForAltitude,
} from "../../../../kml_heatmap/frontend/utils/colors";
import * as replayFeature from "../../../../kml_heatmap/frontend/features/replay";
import { generateSegmentPopupHtml } from "../../../../kml_heatmap/frontend/utils/htmlGenerators";
import * as mapHelpers from "../../../../kml_heatmap/frontend/utils/mapHelpers";
import {
  AUTO_ZOOM_MIN,
  MAP_SOURCES,
} from "../../../../kml_heatmap/frontend/utils/constants";
import type { Map as MapLibreMap } from "maplibre-gl";
import { createMapLibreMock } from "../../testHelpers";
import type { Map as MockMapLibreMap } from "../../../mocks/maplibre-gl";

vi.mock("../../../../kml_heatmap/frontend/utils/htmlGenerators", () => ({
  generateSegmentPopupHtml: vi.fn(() => "<div>popup</div>"),
}));

function makeSegment(overrides: Partial<PathSegment> = {}): PathSegment {
  return {
    coords: [
      [50.0, 8.5],
      [50.01, 8.51],
    ],
    altitude_ft: 3000,
    groundspeed_knots: 120,
    path_id: 0,
    time: 0,
    ...overrides,
  };
}

function el(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing test element #${id}`);
  return element;
}

describe("findSegmentIndexAtTime", () => {
  const segments = [
    makeSegment({ time: 0 }),
    makeSegment({ time: 10 }),
    makeSegment({ time: 20 }),
    makeSegment({ time: 30 }),
  ];

  it("returns the last segment at or before the time", () => {
    expect(findSegmentIndexAtTime(segments, 15)).toBe(1);
    expect(findSegmentIndexAtTime(segments, 20)).toBe(2);
    expect(findSegmentIndexAtTime(segments, 1000)).toBe(3);
  });

  it("returns -1 before the first segment or for empty input", () => {
    expect(findSegmentIndexAtTime(segments, -1)).toBe(-1);
    expect(findSegmentIndexAtTime([], 5)).toBe(-1);
  });
});

describe("unwrapRotation", () => {
  it("takes the first heading as it is", () => {
    expect(unwrapRotation(null, 300)).toBe(300);
  });

  it("turns the short way across north in both directions", () => {
    expect(unwrapRotation(350, 10)).toBe(370);
    expect(unwrapRotation(10, 350)).toBe(-10);
    expect(unwrapRotation(-45, 314)).toBe(-46);
  });

  it("keeps turning from an angle that has already wrapped", () => {
    expect(unwrapRotation(725, 10)).toBe(730);
  });
});

describe("iconHeading", () => {
  let map: MockMapLibreMap;
  const heading = (track: number): number =>
    iconHeading(map as unknown as MapLibreMap, [0, 0], track);

  beforeEach(() => {
    map = createMapLibreMock();
  });

  it("is the track itself on a flat map that is north up", () => {
    expect(heading(19)).toBe(19);
    expect(heading(250)).toBe(250);
    // Nothing to measure, so the map is not asked
    expect(map.project).not.toHaveBeenCalled();
  });

  it("takes the bearing of a turned map off the track", () => {
    map.jumpTo({ bearing: 120 });

    expect(heading(19)).toBeCloseTo(-101, 6);
    // East is up on this map, so north is to the left
    map.jumpTo({ bearing: 90 });
    expect(heading(0)).toBeCloseTo(-90, 6);
    expect(heading(90)).toBeCloseTo(0, 6);
  });

  it("leaves the foreshortening of a tilted map to the marker's own tilt", () => {
    // At 60 degrees a north-east track runs 63 degrees off the vertical on
    // screen. The marker lies on the map and MapLibre tilts it back by the
    // same 60, so the icon itself is turned by the angle on the ground
    map.jumpTo({ pitch: 60 });

    expect(heading(45)).toBeCloseTo(45, 3);
    expect(heading(0)).toBeCloseTo(0, 6);
    expect(heading(90)).toBeCloseTo(90, 6);
    map.jumpTo({ pitch: 60, bearing: 30 });
    expect(heading(45)).toBeCloseTo(15, 3);
  });

  it("measures on a globe even when it is north up and flat", () => {
    map.setProjection({ type: "globe" });
    // The airplane is 60 degrees of longitude east of the centre, where the
    // globe of the mock draws east and west half as long as at the centre
    // and north and south as long as ever: a north-east track points 27
    // degrees off the vertical. The track itself, 45, would be wrong.
    // Zoomed in, where the few pixels the heading is measured over are a
    // short way on the ground.
    map.jumpTo({ center: [-60, 0], zoom: 10 });

    expect(heading(45)).toBeCloseTo(26.565, 1);
    expect(heading(0)).toBeCloseTo(0, 6);
  });

  it("falls back to the track less the bearing where the map cannot tell", () => {
    // Both ends of the probe on one pixel, as right at a pole
    map.jumpTo({ bearing: 30 });
    map.project.mockReturnValue({ x: 5, y: 5 });

    expect(heading(100)).toBe(70);
  });
});

describe("zoomOutSteps", () => {
  const size = { x: 800, y: 600 };

  it("takes one level while the airplane is at most twice as far out", () => {
    expect(zoomOutSteps({ x: 400, y: 300 }, size)).toBe(1);
    expect(zoomOutSteps({ x: -10, y: 300 }, size)).toBe(1);
    expect(zoomOutSteps({ x: 400, y: -300 }, size)).toBe(1);
  });

  it("takes a level for every further doubling", () => {
    expect(zoomOutSteps({ x: 400, y: -301 }, size)).toBe(2);
    expect(zoomOutSteps({ x: 2200, y: 300 }, size)).toBe(3);
  });

  it("stays within four levels", () => {
    expect(zoomOutSteps({ x: 400, y: -100_000 }, size)).toBe(4);
  });

  it("takes one level for a map without a size", () => {
    expect(zoomOutSteps({ x: 0, y: 0 }, { x: 0, y: 0 })).toBe(1);
  });
});

/** Consecutive segments that join end to start, 10 s apart */
function makeChain(altitudes: number[]): PathSegment[] {
  return altitudes.map((altitude_ft, i) =>
    makeSegment({
      time: i * 10,
      altitude_ft,
      coords: [
        [50 + i * 0.01, 8 + i * 0.01],
        [50 + (i + 1) * 0.01, 8 + (i + 1) * 0.01],
      ],
    }),
  );
}

describe("trail runs", () => {
  function stateWith(segments: PathSegment[]): ReplayState {
    const state = new ReplayState();
    state.segments = segments;
    return state;
  }

  it("extends the last run while the colour stays the same", () => {
    const state = stateWith(makeChain([3000, 3000, 3000]));

    appendTrailSegment(state, 0, false);
    appendTrailSegment(state, 1, false);
    appendTrailSegment(state, 2, false);

    expect(state.trailRuns).toHaveLength(1);
    expect(state.trailRuns[0]).toMatchObject({ firstIndex: 0, lastIndex: 2 });
    // One vertex more than segments, longitude first
    expect(state.trailRuns[0]!.coords).toEqual([
      [8, 50],
      [8.01, 50.01],
      [8.02, 50.02],
      [8.03, 50.03],
    ]);
    expect(state.lastDrawnIndex).toBe(2);
    expect(state.trailDirty).toBe(true);
  });

  it("starts a run where the colour changes", () => {
    const state = stateWith(makeChain([0, 0, 10000]));

    for (let i = 0; i < 3; i++) appendTrailSegment(state, i, false);

    expect(state.trailRuns.map((run) => run.color)).toEqual([
      getColorForAltitude(0, 0, 10000),
      getColorForAltitude(10000, 0, 10000),
    ]);
    expect(state.trailRuns[1]).toMatchObject({ firstIndex: 2, lastIndex: 2 });
  });

  it("carries a run on across the antimeridian instead of round the world", () => {
    const segments = makeChain([3000, 3000, 3000]);
    const lngs = [179.98, 179.99, -179.99, -179.98];
    segments.forEach((segment, i) => {
      segment.coords = [
        [60, lngs[i]!],
        [60, lngs[i + 1]!],
      ];
    });
    const state = stateWith(segments);

    for (let i = 0; i < 3; i++) appendTrailSegment(state, i, false);

    expect(state.trailRuns).toHaveLength(1);
    expect(state.trailRuns[0]!.coords.map(([lng]) => lng)).toEqual([
      179.98,
      179.99,
      expect.closeTo(180.01, 9),
      expect.closeTo(180.02, 9),
    ]);
  });

  it("starts a run where the flight does not join up", () => {
    const segments = makeChain([3000, 3000]);
    segments[1]!.coords = [
      [51, 9],
      [51.01, 9.01],
    ];
    const state = stateWith(segments);

    appendTrailSegment(state, 0, false);
    appendTrailSegment(state, 1, false);

    expect(state.trailRuns).toHaveLength(2);
  });

  it("counts a segment without coordinates as drawn but draws nothing", () => {
    const segments = makeChain([3000]);
    delete segments[0]!.coords;
    const state = stateWith(segments);

    appendTrailSegment(state, 0, false);

    expect(state.trailRuns).toEqual([]);
    expect(state.lastDrawnIndex).toBe(0);
    expect(state.trailDirty).toBe(false);
  });

  it("colours by groundspeed when asked to", () => {
    const state = stateWith([makeSegment({ groundspeed_knots: 150 })]);

    appendTrailSegment(state, 0, true);

    expect(state.trailRuns[0]!.color).toBe(
      getColorForAirspeed(150, state.colorMinSpeed, state.colorMaxSpeed),
    );
  });

  it("cuts the last run on a backward seek and drops the runs after it", () => {
    const state = stateWith(makeChain([0, 0, 0, 10000, 10000]));
    for (let i = 0; i < 5; i++) appendTrailSegment(state, i, false);
    state.trailDirty = false;

    // Back to 15 s: segments 0 and 1 remain
    truncateTrail(state, 15);

    expect(state.lastDrawnIndex).toBe(1);
    expect(state.trailRuns).toHaveLength(1);
    expect(state.trailRuns[0]).toMatchObject({ firstIndex: 0, lastIndex: 1 });
    expect(state.trailRuns[0]!.coords).toHaveLength(3);
    expect(state.trailDirty).toBe(true);
  });

  it("extends a cut run again when the replay moves on", () => {
    const state = stateWith(makeChain([0, 0, 0]));
    for (let i = 0; i < 3; i++) appendTrailSegment(state, i, false);

    truncateTrail(state, 5);
    appendTrailSegment(state, 1, false);

    expect(state.trailRuns).toHaveLength(1);
    expect(state.trailRuns[0]!.coords).toHaveLength(3);
  });

  it("empties the trail on a seek before the first segment", () => {
    const state = stateWith(makeChain([0, 10000]));
    state.segments[0]!.time = 5;
    for (let i = 0; i < 2; i++) appendTrailSegment(state, i, false);

    truncateTrail(state, 1);

    expect(state.trailRuns).toEqual([]);
    expect(state.lastDrawnIndex).toBe(-1);
  });

  it("leaves a trail that needs no cutting clean", () => {
    const state = stateWith(makeChain([0, 0]));
    for (let i = 0; i < 2; i++) appendTrailSegment(state, i, false);
    state.trailDirty = false;

    truncateTrail(state, 15);

    expect(state.trailDirty).toBe(false);
    expect(state.lastDrawnIndex).toBe(1);
  });

  it("turns the runs into one coloured line each", () => {
    const state = stateWith(makeChain([0, 10000]));
    for (let i = 0; i < 2; i++) appendTrailSegment(state, i, false);

    const data = trailFeatureCollection(state, 13);

    expect(data.type).toBe("FeatureCollection");
    expect(data.features).toHaveLength(2);
    expect(data.features[0]).toEqual({
      type: "Feature",
      properties: { color: getColorForAltitude(0, 0, 10000) },
      geometry: {
        type: "LineString",
        coordinates: [
          [8, 50],
          [8.01, 50.01],
        ],
      },
    });
  });
});

describe("trail runs in the 3D view", () => {
  /** The trail's flight smoothed at its height above 1000 ft */
  function smoothed(segments: PathSegment[]): SmoothedFlights {
    return smoothFlights(segments, (i) =>
      Math.max((segments[i]!.altitude_ft ?? 0) - 1000, 0),
    );
  }

  it("writes each run as ribbons cut from the smoothed flight, in place of its line", () => {
    const segments = makeChain([1000, 1100]);
    const state = new ReplayState();
    state.segments = segments;
    state.smoothed = smoothed(segments);
    for (let i = 0; i < 2; i++) appendTrailSegment(state, i, false);

    const data = trailFeatureCollection(state, 13);

    // The lines' source is another one
    expect(data.features.every((f) => f.geometry.type === "MultiPolygon")).toBe(
      true,
    );
    const heights = data.features.map((ribbon) => ribbon.properties.h!);
    expect(heights[0]).toBe(0);
    expect(heights).toEqual([...heights].sort((a, b) => a - b));
    expect(Math.max(...heights)).toBeLessThanOrEqual(100);
    expect(heights.length).toBeGreaterThanOrEqual(1 + 100 / 20);
  });

  it("writes no ribbon while the trail is flat", () => {
    const state = new ReplayState();
    state.segments = makeChain([1000, 1100]);
    for (let i = 0; i < 2; i++) appendTrailSegment(state, i, false);

    expect(
      trailFeatureCollection(state, 13).features.every(
        (feature) => feature.geometry.type === "LineString",
      ),
    ).toBe(true);
  });

  it("cuts only the runs that grew or changed their width again", () => {
    // Two runs: the climb changes the colour after the first segment
    const segments = makeChain([1000, 1000, 9000, 9000]);
    const state = new ReplayState();
    state.segments = segments;
    state.smoothed = smoothed(segments);
    for (let i = 0; i < 3; i++) appendTrailSegment(state, i, false);
    expect(state.trailRuns).toHaveLength(2);
    const [first, second] = state.trailRuns;
    const geometryOf = (data: ReturnType<typeof trailFeatureCollection>) =>
      data.features.map((feature) => feature.geometry);

    const before = geometryOf(trailFeatureCollection(state, 13));
    const cutFirst = state.trailPieces.get(first!)!.pieces;
    const cutSecond = state.trailPieces.get(second!)!.pieces;
    appendTrailSegment(state, 3, false);
    const after = geometryOf(trailFeatureCollection(state, 13));

    // The first run is the same, down to its geometry; the second grew
    expect(state.trailPieces.get(first!)!.pieces).toBe(cutFirst);
    expect(state.trailPieces.get(second!)!.pieces).not.toBe(cutSecond);
    expect(after[0]).toBe(before[0]);

    // Another zoom level, and every run is cut again, as wide as it asks
    trailFeatureCollection(state, 9);
    expect(state.trailPieces.get(first!)!.pieces).not.toBe(cutFirst);
    expect(state.trailPieces.get(first!)!.widthZoom).toBe(9);
  });
});

describe("AirplaneMarker", () => {
  let map: MockMapLibreMap;
  let onActivate: ReturnType<typeof vi.fn<() => void>>;
  let airplane: AirplaneMarker;

  beforeEach(() => {
    map = createMapLibreMock();
    onActivate = vi.fn<() => void>();
    airplane = new AirplaneMarker(
      map as unknown as MapLibreMap,
      [48, 16],
      onActivate,
    );
  });

  afterEach(() => airplane.remove());

  it("is a button on the map, centred on the position", () => {
    const element = airplane.getElement();

    expect(element.tagName).toBe("BUTTON");
    expect(element.type).toBe("button");
    expect(element.className).toContain("replay-airplane-root");
    expect(element.getAttribute("aria-label")).toBe("Aircraft position");
    // The stylesheet owns the stacking: an inline value would beat it
    expect(element.style.zIndex).toBe("");
    expect(element.querySelector(".replay-airplane-icon svg")).not.toBeNull();
    expect(map.getCanvasContainer().contains(element)).toBe(true);
    expect(
      (airplane.marker as unknown as { options: unknown }).options,
    ).toMatchObject({ anchor: "center" });
    expect(airplane.getLatLng()).toEqual([48, 16]);
  });

  it("lies on the map, tilted with it, and turns on its own", () => {
    // The heading is turned inside the marker (see iconHeading), so the
    // marker only takes the map's tilt, not its bearing
    expect(
      (airplane.marker as unknown as { options: unknown }).options,
    ).toMatchObject({ pitchAlignment: "map", rotationAlignment: "viewport" });
  });

  describe("setLift", () => {
    /** The last offset the popup was given, by anchor */
    const popupOffset = (): Record<string, [number, number]> =>
      vi.mocked(airplane.popup.setOffset).mock.calls.at(-1)![0] as Record<
        string,
        [number, number]
      >;
    /** What MapLibre makes of a popup offset of 16 px, by anchor */
    const standard: Record<string, [number, number]> = {
      center: [0, 0],
      top: [0, 16],
      "top-left": [11, 11],
      "top-right": [-11, 11],
      bottom: [0, -16],
      "bottom-left": [11, -11],
      "bottom-right": [-11, -11],
      left: [16, 0],
      right: [-16, 0],
    };

    it("draws the airplane and points its popup the lift higher", () => {
      airplane.setLift(30);

      expect(airplane.marker.setOffset).toHaveBeenLastCalledWith([0, -30]);
      const offset = popupOffset();
      expect(Object.keys(offset).sort()).toEqual(Object.keys(standard).sort());
      for (const [anchor, [x, y]] of Object.entries(standard)) {
        // Whichever side it opens on, only up by the lift
        expect(offset[anchor]).toEqual([x, y - 30]);
      }
    });

    it("gives the standard offsets back on the ground", () => {
      airplane.setLift(30);
      airplane.setLift(0);

      expect(airplane.marker.setOffset).toHaveBeenLastCalledWith([0, -0]);
      expect(popupOffset()).toEqual(
        Object.fromEntries(
          Object.entries(standard).map(([anchor, [x, y]]) => [
            anchor,
            [x, y - 0],
          ]),
        ),
      );
    });

    it("writes nothing when the lift has not changed", () => {
      airplane.setLift(12);
      vi.mocked(airplane.marker.setOffset).mockClear();
      vi.mocked(airplane.popup.setOffset).mockClear();

      airplane.setLift(12);

      expect(airplane.marker.setOffset).not.toHaveBeenCalled();
      expect(airplane.popup.setOffset).not.toHaveBeenCalled();
    });
  });

  it("closes its popup once the globe has turned the airplane away", () => {
    map.setProjection({ type: "globe" });
    airplane.openPopup();

    map.jumpTo({ center: [60, 40] });
    map.emit("move");
    expect(airplane.isPopupOpen()).toBe(true);

    map.jumpTo({ center: [-160, 40] });
    map.emit("move");
    expect(airplane.isPopupOpen()).toBe(false);
  });

  it("creates a popup the map's clicks and focus leave alone", () => {
    expect(
      (airplane.popup as unknown as { options: unknown }).options,
    ).toMatchObject({
      maxWidth: "none",
      closeOnClick: false,
      focusAfterOpen: false,
    });
    expect(airplane.marker.getPopup()).toBeFalsy();
  });

  it("asks for the popup on a click, which it leaves to the map as well", () => {
    // The map's handler tells a click on a marker by its target; a marker
    // that stops its events would be one more thing to remember
    const mapClick = vi.fn();
    map.getCanvasContainer().addEventListener("click", mapClick);

    airplane.getElement().click();

    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(mapClick).toHaveBeenCalledTimes(1);
  });

  it("opens from the keyboard: Enter on a focused button is a click", () => {
    // Focus needs the map to be part of the document
    document.body.append(map.getContainer());
    const element = airplane.getElement();
    element.focus();
    expect(document.activeElement).toBe(element);
    map.getContainer().remove();

    // jsdom does not turn the key into the click a browser makes of it
    element.click();

    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it("closes an open popup on the next click", () => {
    airplane.openPopup();
    expect(airplane.isPopupOpen()).toBe(true);

    airplane.getElement().click();

    expect(airplane.isPopupOpen()).toBe(false);
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("keeps the popup open through a double click or a double tap", () => {
    const element = airplane.getElement();
    // The caller opens it; here only whether it is asked to matters
    onActivate.mockImplementation(() => airplane.openPopup());

    for (const detail of [1, 2, 3]) {
      element.dispatchEvent(new MouseEvent("click", { bubbles: true, detail }));
    }

    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(airplane.isPopupOpen()).toBe(true);
  });

  it("tells assistive technology whether its popup is open", () => {
    const element = airplane.getElement();
    expect(element.getAttribute("aria-expanded")).toBe("false");

    airplane.openPopup();
    expect(element.getAttribute("aria-expanded")).toBe("true");

    airplane.closePopup();
    expect(element.getAttribute("aria-expanded")).toBe("false");
  });

  it("opens the popup at the marker", () => {
    airplane.setPopupContent("<p>here</p>");
    airplane.openPopup();

    expect(airplane.popup.getLngLat()).toMatchObject({ lng: 16, lat: 48 });
    expect(airplane.popup.getElement().innerHTML).toContain("<p>here</p>");
    expect(map.getContainer().contains(airplane.popup.getElement())).toBe(true);
  });

  it("takes an open popup along, and leaves a closed one alone", () => {
    airplane.setLatLng([48.5, 16.5]);
    expect(airplane.popup.setLngLat).not.toHaveBeenCalled();

    airplane.openPopup();
    airplane.setLatLng([49, 17]);

    expect(airplane.getLatLng()).toEqual([49, 17]);
    expect(airplane.popup.getLngLat()).toMatchObject({ lng: 17, lat: 49 });
  });

  it("takes the marker and the popup off the map", () => {
    airplane.openPopup();

    airplane.remove();

    expect(airplane.isPopupOpen()).toBe(false);
    expect(map.getCanvasContainer().contains(airplane.getElement())).toBe(
      false,
    );
  });
});

describe("ReplayRenderer", () => {
  let renderer: ReplayRenderer;
  let map: MockMapLibreMap;
  let mockApp: {
    map: MockMapLibreMap;
    altitudeVisible: boolean;
    airspeedVisible: boolean;
    replayActive: boolean;
  };
  let mockReplayManager: { state: ReplayState };
  let frames: FrameRequestCallback[];

  const manager = () => mockReplayManager as unknown as ReplayManager;

  /** An airplane on the mock map; a click on it refreshes its popup */
  function makeAirplane(): AirplaneMarker {
    return new AirplaneMarker(map as unknown as MapLibreMap, [0, 0], () =>
      renderer.updateAirplanePopup(manager()),
    );
  }

  /** Where the map says the airplane is, in pixels of an 800 x 600 map */
  function airplaneAt(x: number, y: number): void {
    map.project.mockReturnValue({ x, y });
  }

  /** Run the animation frames asked for so far */
  function runFrame(): void {
    const due = frames;
    frames = [];
    due.forEach((callback) => callback(performance.now()));
  }

  function trailSource() {
    return map.source(MAP_SOURCES.replayTrail);
  }

  beforeEach(() => {
    vi.clearAllMocks();

    const timeDisplay = document.createElement("div");
    timeDisplay.id = "replay-time-display";
    const slider = document.createElement("input");
    slider.id = "replay-slider";
    slider.type = "range";
    const sliderStart = document.createElement("span");
    sliderStart.id = "replay-slider-start";
    document.body.append(timeDisplay, slider, sliderStart);

    frames = [];
    vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((cb) => {
      frames.push(cb);
      return frames.length;
    });
    vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation(() => {
      frames = [];
    });

    map = createMapLibreMock();
    // jsdom lays nothing out, so the container is given its size
    const container = map.getContainer();
    Object.defineProperty(container, "clientWidth", { value: 800 });
    Object.defineProperty(container, "clientHeight", { value: 600 });
    airplaneAt(400, 300);

    mockApp = {
      map,
      altitudeVisible: true,
      airspeedVisible: false,
      replayActive: false,
    };

    mockReplayManager = {
      state: new ReplayState(),
    };

    renderer = new ReplayRenderer(mockApp as unknown as MapApp);
  });

  afterEach(() => {
    mockReplayManager.state.airplaneMarker?.remove();
    ["replay-time-display", "replay-slider", "replay-slider-start"].forEach(
      (id) => document.getElementById(id)?.remove(),
    );
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe("updateAirplanePopup", () => {
    it("skips when no marker", () => {
      mockApp.replayActive = true;
      mockReplayManager.state.airplaneMarker = null;
      mockReplayManager.state.segments = [makeSegment()];

      renderer.updateAirplanePopup(manager());

      expect(generateSegmentPopupHtml).not.toHaveBeenCalled();
    });

    it("skips when not active", () => {
      mockApp.replayActive = false;
      const airplane = makeAirplane();
      mockReplayManager.state.airplaneMarker = airplane;
      mockReplayManager.state.segments = [makeSegment()];

      renderer.updateAirplanePopup(manager());

      expect(airplane.isPopupOpen()).toBe(false);
    });

    it("finds current segment by time", () => {
      mockApp.replayActive = true;
      const airplane = makeAirplane();
      mockReplayManager.state.airplaneMarker = airplane;
      mockReplayManager.state.currentTime = 15;
      const segments = [
        makeSegment({ time: 0 }),
        makeSegment({ time: 10 }),
        makeSegment({ time: 20 }),
      ];
      mockReplayManager.state.segments = segments;

      renderer.updateAirplanePopup(manager());

      expect(generateSegmentPopupHtml).toHaveBeenCalledWith(
        expect.objectContaining({ segment: segments[1] }),
      );
      expect(airplane.popup.setHTML).toHaveBeenCalledWith("<div>popup</div>");
      expect(airplane.isPopupOpen()).toBe(true);
    });

    it("opens on a click on the airplane", () => {
      mockApp.replayActive = true;
      const airplane = makeAirplane();
      mockReplayManager.state.airplaneMarker = airplane;
      mockReplayManager.state.segments = [makeSegment({ time: 0 })];

      airplane.getElement().click();

      expect(airplane.isPopupOpen()).toBe(true);
      expect(airplane.popup.getElement().innerHTML).toContain("popup");
    });

    it("shows where the aircraft is, not where its segment ends", () => {
      mockApp.replayActive = true;
      const airplane = makeAirplane();
      mockReplayManager.state.airplaneMarker = airplane;
      mockReplayManager.state.segments = [makeSegment({ time: 0 })];
      // Part way along the segment, as the frame loop leaves it
      airplane.setLatLng([50.25, 8.25]);

      renderer.updateAirplanePopup(manager());

      expect(generateSegmentPopupHtml).toHaveBeenCalledWith(
        expect.objectContaining({ position: [50.25, 8.25] }),
      );
    });

    it("uses the given index instead of searching", () => {
      mockApp.replayActive = true;
      mockReplayManager.state.airplaneMarker = makeAirplane();
      mockReplayManager.state.currentTime = 25;
      const segments = [
        makeSegment({ time: 0 }),
        makeSegment({ time: 10 }),
        makeSegment({ time: 20 }),
      ];
      mockReplayManager.state.segments = segments;

      renderer.updateAirplanePopup(manager(), 0);

      expect(generateSegmentPopupHtml).toHaveBeenCalledWith(
        expect.objectContaining({ segment: segments[0] }),
      );
    });

    it("falls back to first segment when currentTime is before all", () => {
      mockApp.replayActive = true;
      const airplane = makeAirplane();
      mockReplayManager.state.airplaneMarker = airplane;
      mockReplayManager.state.currentTime = 0;
      const segments = [makeSegment({ time: 5 }), makeSegment({ time: 10 })];
      mockReplayManager.state.segments = segments;

      renderer.updateAirplanePopup(manager());

      expect(generateSegmentPopupHtml).toHaveBeenCalledWith(
        expect.objectContaining({ segment: segments[0] }),
      );
      expect(airplane.isPopupOpen()).toBe(true);
    });

    it("skips when no segments", () => {
      mockApp.replayActive = true;
      const airplane = makeAirplane();
      mockReplayManager.state.airplaneMarker = airplane;
      mockReplayManager.state.segments = [];

      renderer.updateAirplanePopup(manager());

      expect(airplane.isPopupOpen()).toBe(false);
    });

    it("refills an open popup without opening it again", () => {
      mockApp.replayActive = true;
      const airplane = makeAirplane();
      mockReplayManager.state.airplaneMarker = airplane;
      mockReplayManager.state.segments = [makeSegment({ time: 0 })];
      mockReplayManager.state.currentTime = 5;
      airplane.openPopup();
      vi.mocked(airplane.popup.addTo).mockClear();

      renderer.updateAirplanePopup(manager());

      expect(airplane.popup.setHTML).toHaveBeenCalledWith("<div>popup</div>");
      expect(airplane.popup.addTo).not.toHaveBeenCalled();
    });

    it("pans the popup into view while paused, and never while playing", () => {
      const pan = vi.spyOn(mapHelpers, "panPopupIntoView");
      mockApp.replayActive = true;
      const airplane = makeAirplane();
      mockReplayManager.state.airplaneMarker = airplane;
      mockReplayManager.state.segments = [makeSegment({ time: 0 })];

      mockReplayManager.state.playing = true;
      renderer.updateAirplanePopup(manager());
      expect(pan).not.toHaveBeenCalled();

      mockReplayManager.state.playing = false;
      renderer.updateAirplanePopup(manager());
      expect(pan).toHaveBeenCalledWith(map, airplane.popup, undefined, true);
    });
  });

  describe("ensureReadout", () => {
    it("builds the three cells once", () => {
      const panel = document.createElement("div");

      const first = renderer.ensureReadout(panel);
      const second = renderer.ensureReadout(panel);

      expect(second).toBe(first);
      expect(panel.querySelectorAll(".replay-readout-cell")).toHaveLength(3);
      expect(first.querySelector(".replay-readout-value")!.textContent).toBe(
        "—",
      );
    });

    it("places the strip inside the panel's inner wrapper when present", () => {
      const panel = document.createElement("div");
      const inner = document.createElement("div");
      inner.id = "replay-controls-inner";
      panel.append(inner);

      const strip = renderer.ensureReadout(panel);

      expect(strip.parentElement).toBe(inner);
    });
  });

  describe("updateDisplay", () => {
    function callUpdateDisplay(isManualSeek = false): void {
      renderer.updateDisplay(manager(), isManualSeek);
    }

    it("updates time display text", () => {
      mockReplayManager.state.currentTime = 65;
      mockReplayManager.state.maxTime = 300;

      callUpdateDisplay();

      expect(el("replay-time-display").textContent).toBe("1:05 / 5:00");
      expect(el("replay-slider-start").textContent).toBe("1:05");
    });

    it("updates slider value and spoken value text", () => {
      mockReplayManager.state.currentTime = 42;
      mockReplayManager.state.maxTime = 300;

      callUpdateDisplay();

      const slider = el("replay-slider") as HTMLInputElement;
      expect(slider.value).toBe("42");
      expect(slider.getAttribute("aria-valuetext")).toBe("0:42 of 5:00");
    });

    it("works without the replay control elements", () => {
      el("replay-time-display").remove();
      el("replay-slider").remove();
      el("replay-slider-start").remove();
      mockReplayManager.state.currentTime = 5;

      expect(() => callUpdateDisplay()).not.toThrow();
    });

    it("draws segments incrementally", () => {
      mockReplayManager.state.layerActive = true;
      mockReplayManager.state.lastDrawnIndex = -1;
      mockReplayManager.state.currentTime = 15;
      mockReplayManager.state.segments = makeChain([3000, 3000, 3000]);

      callUpdateDisplay();

      expect(mockReplayManager.state.lastDrawnIndex).toBe(1);
      expect(mockReplayManager.state.currentIndex).toBe(1);
      expect(mockReplayManager.state.trailRuns).toHaveLength(1);
      expect(mockReplayManager.state.trailRuns[0]!.coords).toHaveLength(3);
    });

    it("draws nothing while the replay layer is not set up", () => {
      mockReplayManager.state.currentTime = 15;
      mockReplayManager.state.segments = makeChain([3000, 3000]);

      callUpdateDisplay();
      runFrame();

      expect(mockReplayManager.state.trailRuns).toEqual([]);
      expect(trailSource().setData).not.toHaveBeenCalled();
    });

    it("does not draw segments at time 0", () => {
      mockReplayManager.state.layerActive = true;
      mockReplayManager.state.currentTime = 0;
      mockReplayManager.state.segments = [makeSegment({ time: 0 })];

      callUpdateDisplay();
      runFrame();

      expect(mockReplayManager.state.trailRuns).toEqual([]);
      expect(mockReplayManager.state.lastDrawnIndex).toBe(-1);
      expect(trailSource().setData).not.toHaveBeenCalled();
    });

    it("starts drawing after the last drawn index", () => {
      mockReplayManager.state.layerActive = true;
      mockReplayManager.state.lastDrawnIndex = 1;
      mockReplayManager.state.currentTime = 30;
      mockReplayManager.state.segments = makeChain([3000, 3000, 3000]);

      callUpdateDisplay();

      expect(mockReplayManager.state.trailRuns).toHaveLength(1);
      expect(mockReplayManager.state.trailRuns[0]).toMatchObject({
        firstIndex: 2,
        lastIndex: 2,
      });
      expect(mockReplayManager.state.lastDrawnIndex).toBe(2);
    });

    it("hands the trail to the map once per frame, however often it grew", () => {
      const state = mockReplayManager.state;
      state.layerActive = true;
      state.segments = makeChain([0, 0, 10000, 10000]);

      // A drag of the slider: several positions before the next frame
      state.currentTime = 5;
      callUpdateDisplay(true);
      state.currentTime = 15;
      callUpdateDisplay(true);
      state.currentTime = 25;
      callUpdateDisplay(true);
      expect(trailSource().setData).not.toHaveBeenCalled();

      runFrame();

      expect(trailSource().setData).toHaveBeenCalledTimes(1);
      expect(trailSource().data).toEqual(trailFeatureCollection(state, 13));
      expect(
        (trailSource().data as { features: unknown[] }).features,
      ).toHaveLength(2);
      expect(state.trailDirty).toBe(false);
    });

    it("writes nothing for frames that drew no new segment", () => {
      const state = mockReplayManager.state;
      state.layerActive = true;
      state.segments = makeChain([0, 0]);
      state.currentTime = 5;
      callUpdateDisplay();
      runFrame();
      expect(trailSource().setData).toHaveBeenCalledTimes(1);

      // Still on segment 0: the airplane moves, the trail does not
      for (const time of [6, 7, 8]) {
        state.currentTime = time;
        callUpdateDisplay();
        runFrame();
      }
      expect(trailSource().setData).toHaveBeenCalledTimes(1);

      state.currentTime = 12;
      callUpdateDisplay();
      runFrame();
      expect(trailSource().setData).toHaveBeenCalledTimes(2);
    });

    it("cuts the trail on a backward seek and tells the map", () => {
      const state = mockReplayManager.state;
      state.layerActive = true;
      state.segments = makeChain([0, 0, 0]);
      state.currentTime = 25;
      callUpdateDisplay();
      runFrame();

      renderer.removeSegmentsAfter(manager(), 5);
      runFrame();

      expect(state.lastDrawnIndex).toBe(0);
      expect(trailSource().setData).toHaveBeenCalledTimes(2);
      expect(trailSource().data).toMatchObject({
        features: [
          {
            geometry: {
              coordinates: [
                [8, 50],
                [8.01, 50.01],
              ],
            },
          },
        ],
      });
    });

    it("writes the emptied trail after a reset", () => {
      const state = mockReplayManager.state;
      state.layerActive = true;
      state.segments = makeChain([0, 0]);
      state.currentTime = 15;
      callUpdateDisplay();
      runFrame();

      state.resetDrawState();
      callUpdateDisplay();
      runFrame();

      expect(trailSource().data).toEqual({
        type: "FeatureCollection",
        features: [],
      });
    });

    it("drops a pending write when asked to", () => {
      const state = mockReplayManager.state;
      state.layerActive = true;
      state.segments = makeChain([0]);
      state.currentTime = 5;
      callUpdateDisplay();

      renderer.cancelTrailFlush();
      runFrame();

      expect(trailSource().setData).not.toHaveBeenCalled();
    });

    it("scans forward from the previous index while playing", () => {
      mockReplayManager.state.currentIndex = 1;
      mockReplayManager.state.currentTime = 25;
      mockReplayManager.state.segments = [
        makeSegment({ time: 0 }),
        makeSegment({ time: 10 }),
        makeSegment({ time: 20 }),
        makeSegment({ time: 30 }),
      ];

      callUpdateDisplay();

      expect(mockReplayManager.state.currentIndex).toBe(2);
    });

    it("searches again when the time moved backwards", () => {
      mockReplayManager.state.currentIndex = 3;
      mockReplayManager.state.currentTime = 5;
      mockReplayManager.state.segments = [
        makeSegment({ time: 0 }),
        makeSegment({ time: 10 }),
        makeSegment({ time: 20 }),
        makeSegment({ time: 30 }),
      ];

      callUpdateDisplay();

      expect(mockReplayManager.state.currentIndex).toBe(0);
    });

    it("positions airplane marker at segment end", () => {
      const airplane = makeAirplane();
      mockReplayManager.state.airplaneMarker = airplane;
      mockReplayManager.state.currentTime = 5;
      mockReplayManager.state.segments = [makeSegment({ time: 0 })];

      callUpdateDisplay();

      expect(airplane.getLatLng()).toEqual([50.01, 8.51]);
      // Longitude first on its way to the map
      expect(airplane.marker.setLngLat).toHaveBeenLastCalledWith([8.51, 50.01]);
    });

    it("moves the airplane along its segment between two times", () => {
      const airplane = makeAirplane();
      mockReplayManager.state.airplaneMarker = airplane;
      mockReplayManager.state.currentTime = 5;
      mockReplayManager.state.segments = [
        makeSegment({ time: 0 }),
        makeSegment({ time: 10 }),
      ];

      callUpdateDisplay();

      const [lat, lon] = airplane.getLatLng();
      expect(lat).toBeCloseTo(50.005);
      expect(lon).toBeCloseTo(8.505);
    });

    it("draws with airspeed colors when airspeed is visible and altitude is not", () => {
      mockApp.airspeedVisible = true;
      mockApp.altitudeVisible = false;

      mockReplayManager.state.layerActive = true;
      mockReplayManager.state.lastDrawnIndex = -1;
      mockReplayManager.state.currentTime = 5;
      mockReplayManager.state.segments = [
        makeSegment({ time: 0, groundspeed_knots: 150 }),
      ];

      callUpdateDisplay();

      const { colorMinSpeed, colorMaxSpeed } = mockReplayManager.state;
      expect(mockReplayManager.state.trailRuns[0]!.color).toBe(
        getColorForAirspeed(150, colorMinSpeed, colorMaxSpeed),
      );
    });

    it("falls back to altitude colors for segments without groundspeed", () => {
      mockApp.airspeedVisible = true;
      mockApp.altitudeVisible = false;

      mockReplayManager.state.layerActive = true;
      mockReplayManager.state.currentTime = 5;
      mockReplayManager.state.segments = [
        makeSegment({ time: 0, groundspeed_knots: 0 }),
      ];

      callUpdateDisplay();

      expect(mockReplayManager.state.trailRuns[0]!.color).toBe(
        getColorForAltitude(3000, 0, 10000),
      );
    });

    it("falls back to first segment coords when no lastSegment", () => {
      const airplane = makeAirplane();
      mockReplayManager.state.airplaneMarker = airplane;
      mockReplayManager.state.currentTime = 0;
      mockReplayManager.state.segments = [
        makeSegment({
          time: 5,
          coords: [
            [51.0, 9.0],
            [51.01, 9.01],
          ],
        }),
      ];

      callUpdateDisplay();

      expect(airplane.getLatLng()).toEqual([51.0, 9.0]);
    });

    it("applies rotation transform to airplane icon", () => {
      const airplane = makeAirplane();
      const iconDiv = airplane
        .getElement()
        .querySelector<HTMLElement>(".replay-airplane-icon")!;
      mockReplayManager.state.airplaneMarker = airplane;
      mockReplayManager.state.currentTime = 5;
      mockReplayManager.state.segments = [makeSegment({ time: 0 })];

      callUpdateDisplay();

      expect(iconDiv.style.transform).toContain("rotate(");
      expect(iconDiv.style.transform).toContain("translate3d(0,0,0)");
      expect(mockReplayManager.state.lastBearing).not.toBeNull();
      // The marker itself is never rotated: MapLibre positions it
      expect(airplane.marker.setRotation).not.toHaveBeenCalled();
    });

    it("turns the icon the short way when the heading crosses north", () => {
      const airplane = makeAirplane();
      const iconDiv = airplane
        .getElement()
        .querySelector<HTMLElement>(".replay-airplane-icon")!;
      mockReplayManager.state.airplaneMarker = airplane;
      mockReplayManager.state.currentTime = 5;
      mockReplayManager.state.segments = [makeSegment({ time: 0 })];
      const bearing = vi.spyOn(replayFeature, "calculateSmoothedBearing");

      bearing.mockReturnValue(350);
      callUpdateDisplay();
      expect(iconDiv.style.transform).toContain("rotate(350deg)");

      // 350 to 10 degrees is a 20 degree turn: 370, not a transition back
      // through 180 to 10
      bearing.mockReturnValue(10);
      callUpdateDisplay();
      expect(iconDiv.style.transform).toContain("rotate(370deg)");

      bearing.mockReturnValue(340);
      callUpdateDisplay();
      expect(iconDiv.style.transform).toContain("rotate(340deg)");
    });

    describe("in the 3D view", () => {
      let airplane: AirplaneMarker;

      beforeEach(() => {
        airplane = makeAirplane();
        mockReplayManager.state.airplaneMarker = airplane;
        mockReplayManager.state.currentTime = 15;
        // Halfway along a segment climbing from 1000 to 2000 ft
        mockReplayManager.state.segments = makeChain([1000, 2000, 2000]);
        lifted(true);
      });

      /** The trail lifted, as ReplayManager does it, or flat */
      const lifted = (on: boolean): void => {
        const state = mockReplayManager.state;
        state.lifted = on;
        // Standing on 1000 ft all along
        state.groundFt = new Float64Array(state.segments.length).fill(1000);
        state.smoothed = on
          ? smoothFlights(state.segments, (i) =>
              liftFt(state.segments[i]!.altitude_ft ?? 0, state.groundFt[i]!),
            )
          : null;
      };

      /** How far up the marker is drawn, in pixels */
      /** How far up the marker is drawn, in pixels; 0 before it is moved */
      const lift = (): number => {
        const calls = vi.mocked(airplane.marker.setOffset).mock.calls;
        const last = calls[calls.length - 1]?.[0] as
          [number, number] | undefined;
        return last ? -last[1] : 0;
      };

      it("lifts the airplane to its height on a tilted map, along its segment", () => {
        // The middle of the map far south of the airplane, at 50 degrees
        map.jumpTo({ center: [8, 20], zoom: 13, pitch: 60 });

        callUpdateDisplay();

        // 500 ft above the ground, halfway up the climb, at the scale of the
        // map's centre, which MapLibre raises every extrusion by
        expect(lift()).toBeCloseTo(
          liftOffsetPx(map as unknown as MapLibreMap, 20, 500),
          0,
        );
        expect(lift()).toBeGreaterThan(0);
      });

      it("lifts it zoomed out too, where the replay starts", () => {
        // The replay's one flight is lifted at every zoom, unlike the flights
        map.jumpTo({ zoom: 8, pitch: 60 });

        callUpdateDisplay();

        expect(lift()).toBeGreaterThan(0);
      });

      it("points its popup at it, up where it is drawn", () => {
        map.jumpTo({ zoom: 13, pitch: 60 });

        callUpdateDisplay();

        const offset = vi
          .mocked(airplane.popup.setOffset)
          .mock.calls.at(-1)![0] as Record<string, [number, number]>;
        // Opening above it or below it, the popup moves up with it
        expect(offset["bottom"]![1]).toBeCloseTo(-16 - lift(), 6);
        expect(offset["top"]![1]).toBeCloseTo(16 - lift(), 6);
      });

      it("keeps the lifted airplane, not the ground under it, in view", () => {
        // 3000 ft up at zoom 15, well over the top of an 800 px map, while
        // the ground under it is in the middle
        mockReplayManager.state.segments = [
          makeSegment({ time: 0, altitude_ft: 4000 }),
          makeSegment({ time: 0, altitude_ft: 4000 }),
          makeSegment({ time: 10, altitude_ft: 4000 }),
        ];
        mockReplayManager.state.currentTime = 5;
        lifted(true);
        mockReplayManager.state.playing = true;
        map.jumpTo({ center: [8.505, 50.005], zoom: 15, pitch: 60 });

        callUpdateDisplay();

        expect(map.easeTo).toHaveBeenCalled();

        // Flat, the same airplane is in the middle and nothing moves
        vi.mocked(map.easeTo).mockClear();
        lifted(false);
        callUpdateDisplay();
        expect(map.easeTo).not.toHaveBeenCalled();
      });

      it("follows the map as it tilts under a paused airplane", () => {
        map.jumpTo({ zoom: 13, pitch: 30 });
        callUpdateDisplay();
        const at30 = lift();

        map.jumpTo({ zoom: 13, pitch: 60 });
        map.emit("move");

        expect(lift()).toBeGreaterThan(at30);
      });

      it("flies along the ribbon's curve through a turn, not across it", () => {
        // A right angle at the second point: the ribbon rounds it
        const segments = [0, 10, 20].map((time) =>
          makeSegment({ time, altitude_ft: 2000 }),
        );
        segments[0]!.coords = [
          [50, 8],
          [50.01, 8],
        ];
        segments[1]!.coords = [
          [50.01, 8],
          [50.01, 8.015],
        ];
        segments[2]!.coords = [
          [50.01, 8.015],
          [50.01, 8.03],
        ];
        mockReplayManager.state.segments = segments;
        mockReplayManager.state.currentTime = 5;
        lifted(true);
        map.jumpTo({ zoom: 13, pitch: 60 });

        callUpdateDisplay();

        // Halfway up the first segment, where its ribbon is: the curve is
        // off the straight line already, swinging out to come into the turn
        const [lat, lon] = airplane.getLatLng();
        const onCurve = pointOnFlight(
          mockReplayManager.state.smoothed!,
          0,
          0.5,
        );
        expect(lat).toBeCloseTo(onCurve!.position[0], 9);
        expect(lon).toBeCloseTo(onCurve!.position[1], 9);
        expect(Math.abs(lon - 8)).toBeGreaterThan(1e-4);
        // Flat, straight up the segment
        lifted(false);
        callUpdateDisplay();
        expect(airplane.getLatLng()[1]).toBeCloseTo(8, 9);
      });

      it("hands the trail to its line and the airplane to the ground zoomed in close", () => {
        const state = mockReplayManager.state;
        state.layerActive = true;
        const ribbons = (): unknown[] =>
          (
            (map.source(MAP_SOURCES.replayTrailRibbons).data ?? {
              features: [],
            }) as { features: unknown[] }
          ).features;
        const lines = (): unknown[] =>
          ((trailSource().data ?? { features: [] }) as { features: unknown[] })
            .features;
        map.jumpTo({ zoom: 14, pitch: 60 });
        callUpdateDisplay(true);
        runFrame();
        expect(ribbons().length).toBeGreaterThan(0);
        expect(lift()).toBeGreaterThan(0);

        // Lower than a circuit, the camera would be among the flights
        map.jumpTo({ zoom: 17.5 });
        map.emit("move");
        runFrame();

        expect(ribbons()).toEqual([]);
        expect(lines().length).toBeGreaterThan(0);
        expect(lift()).toBe(0);
      });

      it("keeps it on the ground while the trail is flat", () => {
        lifted(false);
        map.jumpTo({ zoom: 13, pitch: 60 });

        callUpdateDisplay();

        expect(lift()).toBe(0);
      });
    });

    describe("on a turned map", () => {
      let iconDiv: HTMLElement;

      beforeEach(() => {
        const airplane = makeAirplane();
        iconDiv = airplane
          .getElement()
          .querySelector<HTMLElement>(".replay-airplane-icon")!;
        mockReplayManager.state.airplaneMarker = airplane;
        mockReplayManager.state.currentTime = 5;
        mockReplayManager.state.segments = [makeSegment({ time: 0 })];
        vi.spyOn(replayFeature, "calculateSmoothedBearing").mockReturnValue(0);
      });

      const rotation = (): number =>
        Number(/rotate\((-?[\d.]+)deg\)/.exec(iconDiv.style.transform)![1]);

      it("points the icon along the track on screen, not over the ground", () => {
        map.jumpTo({ bearing: 90 });

        callUpdateDisplay();

        // Flying north on a map whose top is east: to the left
        expect(rotation()).toBeCloseTo(-90, 6);
        // What the readout says is still where the airplane flies
        expect(mockReplayManager.state.lastBearing).toBe(0);
      });

      it("turns the icon with the map while the replay is paused", () => {
        callUpdateDisplay();
        expect(rotation()).toBe(0);

        // No frame of the replay comes to say so: the map's own event does
        map.jumpTo({ bearing: 45 });
        map.emit("move");

        expect(rotation()).toBeCloseTo(-45, 6);
      });

      it("stops following the map when the replay closes", () => {
        callUpdateDisplay();
        expect(map.listenerCount("move")).toBe(1);
        callUpdateDisplay();
        expect(map.listenerCount("move")).toBe(1);

        renderer.stopWatchingMap();

        expect(map.listenerCount("move")).toBe(0);
        map.jumpTo({ bearing: 45 });
        map.emit("move");
        expect(rotation()).toBe(0);
      });
    });

    it("starts the rotation afresh for the airplane of another replay", () => {
      const bearing = vi.spyOn(replayFeature, "calculateSmoothedBearing");
      mockReplayManager.state.currentTime = 5;
      mockReplayManager.state.segments = [makeSegment({ time: 0 })];
      const first = makeAirplane();
      mockReplayManager.state.airplaneMarker = first;
      bearing.mockReturnValue(725);
      callUpdateDisplay();
      first.remove();

      const second = makeAirplane();
      mockReplayManager.state.airplaneMarker = second;
      bearing.mockReturnValue(10);
      callUpdateDisplay();

      expect(
        second.getElement().querySelector<HTMLElement>(".replay-airplane-icon")!
          .style.transform,
      ).toContain("rotate(10deg)");
    });

    it("keeps the last bearing when no smoothed bearing is available", () => {
      vi.spyOn(replayFeature, "calculateSmoothedBearing").mockReturnValue(null);
      mockReplayManager.state.lastBearing = 90;
      mockReplayManager.state.airplaneMarker = makeAirplane();
      mockReplayManager.state.currentTime = 5;
      mockReplayManager.state.segments = [makeSegment({ time: 0 })];

      callUpdateDisplay();

      expect(mockReplayManager.state.lastBearing).toBe(90);
    });

    it("auto-pans when airplane is near viewport edge during playback", () => {
      airplaneAt(10, 10);

      mockReplayManager.state.airplaneMarker = makeAirplane();
      mockReplayManager.state.playing = true;
      mockReplayManager.state.currentTime = 5;
      mockReplayManager.state.segments = [makeSegment({ time: 0 })];

      callUpdateDisplay();

      expect(map.project).toHaveBeenCalledWith([8.51, 50.01]);
      // Milliseconds, where Leaflet counted seconds
      expect(RECENTER_PAN_DURATION_MS).toBe(500);
      expect(map.easeTo).toHaveBeenCalledWith({
        center: [8.51, 50.01],
        duration: RECENTER_PAN_DURATION_MS,
        easing: expect.any(Function) as unknown,
        animate: true,
      });
      expect(mockReplayManager.state.recenterTimestamps).toHaveLength(1);
    });

    it("eases the pan out, so restarting it every frame still moves the map", () => {
      airplaneAt(10, 10);
      mockReplayManager.state.airplaneMarker = makeAirplane();
      mockReplayManager.state.playing = true;
      mockReplayManager.state.currentTime = 5;
      mockReplayManager.state.segments = [makeSegment({ time: 0 })];

      callUpdateDisplay();

      const { easing } = map.easeTo.mock.calls[0]![0] as unknown as {
        easing: (t: number) => number;
      };
      expect(easing(0)).toBe(0);
      expect(easing(1)).toBe(1);
      // One frame of a 500 ms pan covers a tenth of the way
      expect(easing(16 / 500)).toBeGreaterThan(0.1);
    });

    it("does not pan while playing when the airplane is inside the margins", () => {
      airplaneAt(400, 300);
      mockReplayManager.state.airplaneMarker = makeAirplane();
      mockReplayManager.state.playing = true;
      mockReplayManager.state.currentTime = 5;
      mockReplayManager.state.segments = [makeSegment({ time: 0 })];

      callUpdateDisplay();

      expect(map.easeTo).not.toHaveBeenCalled();
      expect(map.jumpTo).not.toHaveBeenCalled();
    });

    it("does not pan when paused and not seeking", () => {
      airplaneAt(10, 10);
      mockReplayManager.state.airplaneMarker = makeAirplane();
      mockReplayManager.state.playing = false;
      mockReplayManager.state.currentTime = 5;
      mockReplayManager.state.segments = [makeSegment({ time: 0 })];

      callUpdateDisplay(false);

      expect(map.easeTo).not.toHaveBeenCalled();
      expect(map.jumpTo).not.toHaveBeenCalled();
    });

    it("leaves the camera alone while the map is zooming", () => {
      // A camera move ends the one before it, so a pan would stop the zoom
      airplaneAt(10, 10);
      map.isZooming.mockReturnValue(true);
      mockReplayManager.state.airplaneMarker = makeAirplane();
      mockReplayManager.state.playing = true;
      mockReplayManager.state.autoZoom = true;
      mockReplayManager.state.currentTime = 5;
      mockReplayManager.state.segments = [makeSegment({ time: 0 })];

      callUpdateDisplay();

      expect(map.easeTo).not.toHaveBeenCalled();
      expect(mockReplayManager.state.recenterTimestamps).toEqual([]);
    });

    describe("behind a globe", () => {
      // The end of the one segment, where the airplane is at this time
      const airplane = { lat: 50.01, lng: 8.51 };

      beforeEach(() => {
        map.setProjection({ type: "globe" });
        mockReplayManager.state.airplaneMarker = makeAirplane();
        mockReplayManager.state.playing = true;
        mockReplayManager.state.currentTime = 5;
        mockReplayManager.state.segments = [makeSegment({ time: 0 })];
        // Far from every edge of the 800 x 600 map, which is also where the
        // far side of a globe projects to
        airplaneAt(400, 300);
      });

      /** What the map says is drawn where the airplane projects to */
      function drawnThere(place: { lat: number; lng: number }): void {
        map.unproject.mockReturnValue(
          place as ReturnType<typeof map.unproject>,
        );
      }

      it("leaves the camera alone while the airplane is on the near side", () => {
        drawnThere(airplane);

        callUpdateDisplay();

        expect(map.easeTo).not.toHaveBeenCalled();
      });

      it("brings an airplane back that flew over the rim, though it never left the map", () => {
        // Another part of the world is drawn there: the airplane is behind it
        drawnThere({ lat: 50.01, lng: 151.49 });

        callUpdateDisplay();

        expect(map.easeTo).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ center: [airplane.lng, airplane.lat] }),
        );
      });

      it("zooms out for it at once when auto-zoom is on, like for one that left the map", () => {
        mockReplayManager.state.autoZoom = true;
        map.setZoom(12);
        drawnThere({ lat: 50.01, lng: 151.49 });

        callUpdateDisplay();

        expect(map.easeTo).toHaveBeenLastCalledWith(
          expect.objectContaining({ zoom: 11 }),
        );
      });

      it("jumps to it on a seek", () => {
        drawnThere({ lat: 50.01, lng: 151.49 });

        callUpdateDisplay(true);

        expect(map.jumpTo).toHaveBeenCalledWith({
          center: [airplane.lng, airplane.lat],
        });
      });
    });

    describe("while the user moves the map", () => {
      // A camera move resets every gesture: a pan per frame would end the
      // user's drag or pinch the moment it starts
      beforeEach(() => {
        airplaneAt(10, 10);
        mockReplayManager.state.airplaneMarker = makeAirplane();
        mockReplayManager.state.playing = true;
        mockReplayManager.state.currentTime = 5;
        mockReplayManager.state.segments = [makeSegment({ time: 0 })];
        // What the manager does as a replay opens
        renderer.watchUser();
      });

      function expectCameraLeftAlone(): void {
        callUpdateDisplay();
        expect(map.easeTo).not.toHaveBeenCalled();
        expect(map.jumpTo).not.toHaveBeenCalled();
        expect(mockReplayManager.state.recenterTimestamps).toEqual([]);
      }

      function expectCameraFollows(): void {
        callUpdateDisplay();
        expect(map.easeTo).toHaveBeenCalledTimes(1);
      }

      it.each([
        ["mousedown", "mouseup"],
        ["touchstart", "touchend"],
        ["touchstart", "touchcancel"],
      ])("waits from %s to %s, before any move", (press, release) => {
        // Inside the click tolerance no handler is active yet
        map.getCanvasContainer().dispatchEvent(new Event(press));
        expectCameraLeftAlone();

        // Let go, wherever the pointer is by then
        window.dispatchEvent(new Event(release));
        expectCameraFollows();
      });

      it("sees a press that began before the first frame that would pan", () => {
        // No frame has run yet: the watching starts with the replay
        map.getCanvasContainer().dispatchEvent(new MouseEvent("mousedown"));

        expectCameraLeftAlone();
      });

      it("takes no other button for a press", () => {
        // The context menu of a right click swallows the mouseup on Linux
        // and macOS, and the camera would wait for it for good
        map
          .getCanvasContainer()
          .dispatchEvent(new MouseEvent("mousedown", { button: 2 }));

        expectCameraFollows();
      });

      it("takes no menu that opens for the end of a press", () => {
        // A long press on Android opens one with the finger still down; a
        // pan on every frame from then on would reset the drag under it
        map.getCanvasContainer().dispatchEvent(new Event("touchstart"));
        window.dispatchEvent(new Event("contextmenu"));

        expectCameraLeftAlone();
      });

      it("sees a release that went missing in the next move of the mouse", () => {
        // A menu that opens over a press takes the mouseup with it
        map.getCanvasContainer().dispatchEvent(new MouseEvent("mousedown"));
        window.dispatchEvent(new MouseEvent("mousemove", { buttons: 1 }));
        expectCameraLeftAlone();

        window.dispatchEvent(new MouseEvent("mousemove", { buttons: 0 }));
        expectCameraFollows();
      });

      it("takes a camera move of the app for the end of a gesture it cut short", () => {
        // MapLibre resets the gesture handlers before every camera move,
        // and ends a drag or a pinch that way without a moveend
        map.isMoving.mockReturnValue(true);
        map.emit("movestart", { originalEvent: new Event("mousemove") });
        expectCameraLeftAlone();

        map.emit("movestart", {});

        expectCameraFollows();
      });

      it("keeps waiting while a finger of a pinch is still down", () => {
        map.getCanvasContainer().dispatchEvent(new Event("touchstart"));
        const lifted = Object.assign(new Event("touchend"), {
          touches: [{}],
        });
        window.dispatchEvent(lifted);

        expectCameraLeftAlone();
      });

      it.each(["movestart", "zoomstart"])(
        "waits from a %s of the user to the moveend, a key or a glide included",
        (start) => {
          map.isMoving.mockReturnValue(true);
          map.emit(start, { originalEvent: new Event("keydown") });
          expectCameraLeftAlone();

          // A camera move of the app that ends meanwhile says nothing
          // about the user's
          map.emit("moveend", {});
          expectCameraLeftAlone();

          map.emit("moveend", { originalEvent: new Event("keyup") });
          expectCameraFollows();
        },
      );

      it("takes a map at rest for the end of a move whose end went missing", () => {
        map.emit("movestart", { originalEvent: new Event("keydown") });
        map.isMoving.mockReturnValue(true);
        expectCameraLeftAlone();

        map.isMoving.mockReturnValue(false);
        expectCameraFollows();
      });

      it("does not wait for a camera move of the app", () => {
        map.emit("movestart", {});

        expectCameraFollows();
      });

      it.each(["rotatestart", "pitchstart"])(
        "leaves the compass to finish: waits from a %s of the app to its moveend",
        (start) => {
          // The compass turns the map with a camera move that carries no
          // DOM event, and a follow pan would end it in its first frame
          map.isMoving.mockReturnValue(true);
          map.emit("movestart", {});
          map.emit(start, {});
          expectCameraLeftAlone();
          expectCameraLeftAlone();

          map.emit("moveend", {});
          expectCameraFollows();
        },
      );

      it("takes a map at rest for the end of a turn whose end went missing", () => {
        map.isMoving.mockReturnValue(true);
        map.emit("rotatestart", {});
        expectCameraLeftAlone();

        map.isMoving.mockReturnValue(false);
        expectCameraFollows();
      });

      it("waits for the wheel, which moves nothing before the next frame", () => {
        map.scrollZoom.isActive.mockReturnValue(true);
        expectCameraLeftAlone();

        map.scrollZoom.isActive.mockReturnValue(false);
        expectCameraFollows();
      });

      it("listens once however often it is asked, and stops when the replay closes", () => {
        const types = [
          "movestart",
          "zoomstart",
          "rotatestart",
          "pitchstart",
          "moveend",
        ];
        renderer.watchUser();
        for (const type of types) {
          expect(map.listenerCount(type)).toBe(1);
        }

        renderer.stopWatchingMap();

        for (const type of types) {
          expect(map.listenerCount(type)).toBe(0);
        }
        map.getCanvasContainer().dispatchEvent(new MouseEvent("mousedown"));
        expectCameraFollows();
      });
    });

    it("uses binary search on manual seek with multiple segments", () => {
      const airplane = makeAirplane();
      mockReplayManager.state.airplaneMarker = airplane;
      mockReplayManager.state.lastDrawnIndex = 5;
      mockReplayManager.state.currentIndex = 3;
      mockReplayManager.state.currentTime = 15;
      mockReplayManager.state.segments = [
        makeSegment({ time: 0 }),
        makeSegment({ time: 10 }),
        makeSegment({ time: 20 }),
        makeSegment({ time: 30 }),
      ];
      vi.mocked(airplane.marker.setLngLat).mockClear();

      callUpdateDisplay(true);

      expect(mockReplayManager.state.currentIndex).toBe(1);
      expect(airplane.marker.setLngLat).toHaveBeenCalled();
    });

    it("does not recenter on manual seek while the airplane stays in view", () => {
      airplaneAt(400, 300);
      mockReplayManager.state.airplaneMarker = makeAirplane();
      mockReplayManager.state.currentTime = 5;
      mockReplayManager.state.segments = [makeSegment({ time: 0 })];

      callUpdateDisplay(true);

      expect(map.jumpTo).not.toHaveBeenCalled();
    });

    it("pans without animation on manual seek near the edge, throttled to 250 ms", () => {
      vi.useFakeTimers();
      vi.setSystemTime(10_000);
      airplaneAt(10, 300);
      mockReplayManager.state.airplaneMarker = makeAirplane();
      mockReplayManager.state.currentTime = 5;
      mockReplayManager.state.segments = [makeSegment({ time: 0 })];

      callUpdateDisplay(true);
      expect(map.jumpTo).toHaveBeenCalledTimes(1);
      expect(map.jumpTo).toHaveBeenCalledWith({ center: [8.51, 50.01] });
      expect(map.easeTo).not.toHaveBeenCalled();

      // A second seek shortly after is throttled
      vi.advanceTimersByTime(SEEK_PAN_THROTTLE_MS - 50);
      callUpdateDisplay(true);
      expect(map.jumpTo).toHaveBeenCalledTimes(1);

      // After the throttle window the map follows again
      vi.advanceTimersByTime(100);
      callUpdateDisplay(true);
      expect(map.jumpTo).toHaveBeenCalledTimes(2);
      // Manual seeks do not feed the auto-zoom recenter counter
      expect(mockReplayManager.state.recenterTimestamps).toHaveLength(0);
    });

    it("pans immediately on manual seek when the airplane left the viewport", () => {
      vi.useFakeTimers();
      vi.setSystemTime(10_000);
      airplaneAt(10, 300);
      mockReplayManager.state.airplaneMarker = makeAirplane();
      mockReplayManager.state.currentTime = 5;
      mockReplayManager.state.segments = [makeSegment({ time: 0 })];

      callUpdateDisplay(true);
      expect(map.jumpTo).toHaveBeenCalledTimes(1);

      // Outside the viewport: the throttle does not apply
      airplaneAt(-50, 300);
      vi.advanceTimersByTime(10);
      callUpdateDisplay(true);
      expect(map.jumpTo).toHaveBeenCalledTimes(2);
    });

    /** The zoom-outs among the camera moves; the pans carry no zoom */
    function zoomOuts(): { zoom: number }[] {
      return map.easeTo.mock.calls
        .map(([options]) => options as { zoom?: number })
        .filter((options): options is { zoom: number } => "zoom" in options);
    }

    it("auto-zooms out after frequent recenters", () => {
      airplaneAt(10, 10);
      map.getZoom.mockReturnValue(12);

      mockReplayManager.state.airplaneMarker = makeAirplane();
      mockReplayManager.state.playing = true;
      mockReplayManager.state.autoZoom = true;
      mockReplayManager.state.currentTime = 5;
      mockReplayManager.state.segments = [makeSegment({ time: 0 })];

      const now = Date.now();
      mockReplayManager.state.recenterTimestamps = [
        now - 1000,
        now - 500,
        now - 100,
      ];

      callUpdateDisplay();

      // Onto the airplane: no pan runs while the map zooms
      expect(map.easeTo).toHaveBeenLastCalledWith({
        center: [8.51, 50.01],
        zoom: 11,
        duration: AUTO_ZOOM_DURATION_MS,
        animate: true,
      });
      expect(map.setZoom).not.toHaveBeenCalled();
      expect(mockReplayManager.state.recenterTimestamps).toEqual([]);
    });

    it("zooms out from the map's own zoom, which the user may have changed", () => {
      // Replay opened with auto-zoom at 15, then the user zoomed out to 12.5:
      // a remembered 15 made "zoom out" set 14
      airplaneAt(10, 10);
      map.getZoom.mockReturnValue(12.5);
      mockReplayManager.state.airplaneMarker = makeAirplane();
      mockReplayManager.state.playing = true;
      mockReplayManager.state.autoZoom = true;
      mockReplayManager.state.currentTime = 5;
      mockReplayManager.state.segments = [makeSegment({ time: 0 })];
      const now = Date.now();
      mockReplayManager.state.recenterTimestamps = [now - 900, now - 600];

      callUpdateDisplay();

      expect(zoomOuts()).toEqual([expect.objectContaining({ zoom: 11.5 })]);
    });

    it("counts one recenter per pan, not one per frame of it", () => {
      vi.useFakeTimers();
      vi.setSystemTime(10_000);
      airplaneAt(10, 10);
      mockReplayManager.state.airplaneMarker = makeAirplane();
      mockReplayManager.state.playing = true;
      mockReplayManager.state.autoZoom = true;
      mockReplayManager.state.currentTime = 5;
      mockReplayManager.state.segments = [makeSegment({ time: 0 })];

      // Twenty frames (320 ms) of the airplane near the edge while the pan
      // runs: the map follows on every frame, but it is one recenter and
      // no zoom. Counted per frame this fired a burst of zoom-outs.
      for (let frame = 0; frame < 20; frame++) {
        callUpdateDisplay();
        vi.advanceTimersByTime(16);
      }
      expect(map.easeTo).toHaveBeenCalledTimes(20);
      expect(mockReplayManager.state.recenterTimestamps).toHaveLength(1);
      expect(zoomOuts()).toEqual([]);

      // Once a pan has had its time, still being at the edge is a new one
      vi.advanceTimersByTime(RECENTER_PAN_DURATION_MS);
      callUpdateDisplay();
      expect(mockReplayManager.state.recenterTimestamps).toHaveLength(2);
    });

    it("pans without animation for reduced motion", () => {
      vi.spyOn(motion, "prefersReducedMotion").mockReturnValue(true);
      airplaneAt(10, 10);
      map.getZoom.mockReturnValue(12);
      mockReplayManager.state.airplaneMarker = makeAirplane();
      mockReplayManager.state.playing = true;
      mockReplayManager.state.autoZoom = true;
      mockReplayManager.state.currentTime = 5;
      mockReplayManager.state.segments = [makeSegment({ time: 0 })];
      const now = Date.now();
      mockReplayManager.state.recenterTimestamps = [now - 2000, now - 1000];

      callUpdateDisplay();

      expect(map.easeTo).toHaveBeenCalledTimes(2);
      for (const [options] of map.easeTo.mock.calls) {
        expect(options).toMatchObject({ animate: false });
      }
      expect(zoomOuts()).toEqual([expect.objectContaining({ zoom: 11 })]);
    });

    it("does not zoom out below the auto-zoom minimum", () => {
      // Map units: what was 9 under Leaflet
      expect(AUTO_ZOOM_MIN).toBe(8);
      airplaneAt(10, 10);
      map.getZoom.mockReturnValue(AUTO_ZOOM_MIN);
      mockReplayManager.state.airplaneMarker = makeAirplane();
      mockReplayManager.state.playing = true;
      mockReplayManager.state.autoZoom = true;
      mockReplayManager.state.currentTime = 5;
      mockReplayManager.state.segments = [makeSegment({ time: 0 })];
      const now = Date.now();
      mockReplayManager.state.recenterTimestamps = [
        now - 300,
        now - 200,
        now - 100,
      ];

      callUpdateDisplay();

      expect(zoomOuts()).toEqual([]);
    });

    it("stops at the auto-zoom minimum when the steps would pass it", () => {
      airplaneAt(400, -100_000);
      map.getZoom.mockReturnValue(AUTO_ZOOM_MIN + 1.5);
      mockReplayManager.state.airplaneMarker = makeAirplane();
      mockReplayManager.state.playing = true;
      mockReplayManager.state.autoZoom = true;
      mockReplayManager.state.currentTime = 5;
      mockReplayManager.state.segments = [makeSegment({ time: 0 })];

      callUpdateDisplay();

      expect(zoomOuts()).toEqual([
        expect.objectContaining({ zoom: AUTO_ZOOM_MIN }),
      ]);
    });

    it("zooms out at once when the airplane has left the map", () => {
      // At 200x the pan fell behind at the follow zoom, and waiting for
      // three recenters left the airplane above the map for over a second
      vi.useFakeTimers();
      vi.setSystemTime(10_000);
      airplaneAt(400, -20);
      map.getZoom.mockReturnValue(15);
      mockReplayManager.state.airplaneMarker = makeAirplane();
      mockReplayManager.state.playing = true;
      mockReplayManager.state.autoZoom = true;
      mockReplayManager.state.currentTime = 5;
      mockReplayManager.state.segments = [makeSegment({ time: 0 })];

      callUpdateDisplay();
      expect(zoomOuts()).toEqual([expect.objectContaining({ zoom: 14 })]);

      // Still outside while that zoom has not settled: no second one
      map.getZoom.mockReturnValue(14);
      vi.advanceTimersByTime(AUTO_ZOOM_SETTLE_MS - 50);
      callUpdateDisplay();
      expect(zoomOuts()).toHaveLength(1);

      // Once it has, further out takes more than one level
      airplaneAt(400, -700);
      vi.advanceTimersByTime(50);
      callUpdateDisplay();
      expect(zoomOuts()).toHaveLength(2);
      expect(zoomOuts()[1]).toMatchObject({ center: [8.51, 50.01], zoom: 12 });
    });

    it("leaves the zoom alone off the map when auto-zoom is off", () => {
      airplaneAt(-50, 300);
      mockReplayManager.state.airplaneMarker = makeAirplane();
      mockReplayManager.state.playing = true;
      mockReplayManager.state.currentTime = 5;
      mockReplayManager.state.segments = [makeSegment({ time: 0 })];

      callUpdateDisplay();

      expect(map.easeTo).toHaveBeenCalledTimes(1);
      expect(zoomOuts()).toEqual([]);
    });

    it("refreshes an open popup with the current segment index", () => {
      mockApp.replayActive = true;
      const airplane = makeAirplane();
      mockReplayManager.state.airplaneMarker = airplane;
      mockReplayManager.state.currentTime = 15;
      const segments = [makeSegment({ time: 0 }), makeSegment({ time: 10 })];
      mockReplayManager.state.segments = segments;
      airplane.openPopup();

      callUpdateDisplay();

      expect(generateSegmentPopupHtml).toHaveBeenCalledWith(
        expect.objectContaining({ segment: segments[1] }),
      );
      expect(airplane.popup.setHTML).toHaveBeenCalledWith("<div>popup</div>");
      // The popup went along with the airplane
      expect(airplane.popup.getLngLat()).toMatchObject({
        lng: 8.51,
        lat: 50.01,
      });
    });

    it("rebuilds an open popup only when the airplane reaches another segment", () => {
      mockApp.replayActive = true;
      const airplane = makeAirplane();
      mockReplayManager.state.airplaneMarker = airplane;
      mockReplayManager.state.segments = [
        makeSegment({ time: 0 }),
        makeSegment({ time: 10 }),
      ];
      mockReplayManager.state.currentTime = 2;
      renderer.updateAirplanePopup(manager());
      vi.mocked(generateSegmentPopupHtml).mockClear();

      mockReplayManager.state.currentTime = 4;
      callUpdateDisplay();
      expect(generateSegmentPopupHtml).not.toHaveBeenCalled();

      mockReplayManager.state.currentTime = 12;
      callUpdateDisplay();
      expect(generateSegmentPopupHtml).toHaveBeenCalledTimes(1);
    });

    it("leaves a closed popup closed as the airplane moves on", () => {
      mockApp.replayActive = true;
      const airplane = makeAirplane();
      mockReplayManager.state.airplaneMarker = airplane;
      mockReplayManager.state.currentTime = 15;
      mockReplayManager.state.segments = [
        makeSegment({ time: 0 }),
        makeSegment({ time: 10 }),
      ];

      callUpdateDisplay();

      expect(airplane.isPopupOpen()).toBe(false);
      expect(generateSegmentPopupHtml).not.toHaveBeenCalled();
    });
  });
});
