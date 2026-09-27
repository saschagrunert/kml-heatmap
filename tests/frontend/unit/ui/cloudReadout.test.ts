/**
 * The readout of the heat cloud under the pointer: shown beside a resting
 * pointer and above a tapping finger while the 3D view draws the cloud,
 * and only then; out of the way of the flights, markers, drags and Escape.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { LngLat, Point } from "maplibre-gl";
import { followCloudReadout } from "../../../../kml_heatmap/frontend/ui/cloudReadout";
import { releaseReadoutData } from "../../../../kml_heatmap/frontend/calculations/cloudReadout";
import type { PathSegment } from "../../../../kml_heatmap/frontend/types";
import {
  asMapApp,
  createDataset,
  createMockApp,
  type MockApp,
} from "../../testHelpers";
import { resetMapLibreMock } from "../../../mocks/maplibre-gl";

/**
 * A flight of `path_id` across 8° E along `lat`, 1,000 ft above the ground
 * the build sampled, a minute per 700 m
 */
function flight(path_id: number, lat: number): PathSegment[] {
  return Array.from({ length: 10 }, (_, i) => ({
    path_id,
    coords: [
      [lat, 7.95 + i * 0.01],
      [lat, 7.95 + (i + 1) * 0.01],
    ],
    altitude_ft: 1000,
    ground_ft: 0,
    groundspeed_knots: 23,
    time: i * 60,
  }));
}

/** Two flights over the middle of the map in 2026, one far away in 2025 */
const DATA = createDataset(
  [
    { id: 1, year: 2026, aircraft_registration: "D-EAAA" },
    { id: 2, year: 2026, aircraft_registration: "D-EAAA" },
    { id: 3, year: 2025, aircraft_registration: "D-EAAA" },
  ],
  [...flight(1, 50), ...flight(2, 50.001), ...flight(3, 51)],
);

/** The next frame, after the readout's own */
const nextFrame = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => resolve()));

describe("the readout of the heat cloud", () => {
  let app: MockApp;
  let lifetime: AbortController;
  /** The clock of the events, in milliseconds */
  let clock: number;

  const map = (): NonNullable<MockApp["map"]> => app.map!;
  const box = (): HTMLElement | null =>
    map().getContainer().querySelector(".cloud-readout");
  /** What the box says, null while it is hidden */
  const shown = (): string | null => {
    const element = box();
    return element && !element.hidden ? element.textContent : null;
  };

  /** A move of the mouse to `x`, `y` of the map, over `target` */
  const move = (
    x: number,
    y: number,
    {
      target = map().getCanvas(),
      buttons = 0,
    }: { target?: EventTarget; buttons?: number } = {},
  ): void => {
    clock += 50;
    map().emit("mousemove", {
      point: new Point(x, y),
      originalEvent: { target, buttons, timeStamp: clock },
    });
  };

  const click = (
    x: number,
    y: number,
    { target = map().getCanvas() }: { target?: EventTarget } = {},
  ): void => {
    clock += 50;
    map().emit("click", {
      point: new Point(x, y),
      lngLat: map().unproject([x, y]),
      originalEvent: { target, timeStamp: clock },
    });
  };

  const touch = (): void => {
    clock += 50;
    map().emit("touchstart", { originalEvent: { timeStamp: clock } });
  };

  const status = (): string =>
    document.getElementById("toast-status")?.textContent ?? "";

  /** Turn the 3D view on, with the cloud, as ui/heatCloud.ts does */
  const enter3D = (): void => {
    app.threeDVisible = true;
    app.heatCloud = true;
  };

  beforeEach(async () => {
    lifetime = new AbortController();
    clock = 10000;
    app = createMockApp({
      signal: lifetime.signal,
      currentData: DATA,
      heatmapVisible: true,
      terrainActive: true,
      selectedYear: "all",
      selectedAircraft: "all",
    });
    // Looking straight down at the flights, a kilometre around the pointer
    map().jumpTo({ center: [8, 50], zoom: 10, pitch: 0 });
    Object.defineProperty(map().getContainer(), "clientWidth", {
      value: 800,
    });
    Object.defineProperty(map().getContainer(), "clientHeight", {
      value: 600,
    });
    followCloudReadout(asMapApp(app));
    await app.mapReady;
  });

  afterEach(() => {
    lifetime.abort();
    releaseReadoutData();
    resetMapLibreMock();
    document.getElementById("toast-status")?.remove();
  });

  it("listens to the pointer only while the 3D view draws the cloud", () => {
    expect(map().listenerCount("mousemove")).toBe(0);
    enter3D();
    expect(map().listenerCount("mousemove")).toBe(1);
    expect(map().listenerCount("click")).toBe(1);

    for (const key of ["replayActive", "wrappedVisible"] as const) {
      app[key] = true;
      expect(map().listenerCount("mousemove")).toBe(0);
      app[key] = false;
      expect(map().listenerCount("mousemove")).toBe(1);
    }
    app.heatmapVisible = false;
    expect(map().listenerCount("mousemove")).toBe(0);
    app.heatmapVisible = true;

    // Wrapped's intro draws the cloud with the 3D view off
    app.threeDVisible = false;
    app.forcedHeatCloud = true;
    expect(map().listenerCount("mousemove")).toBe(0);
    expect(map().listenerCount("click")).toBe(0);
  });

  it("shows what the cloud under a resting pointer is made of, in the next frame", async () => {
    enter3D();
    move(0, 0);
    expect(shown()).toBeNull();
    await nextFrame();
    // Both flights cross the kilometre around the pointer, at 1,000 ft
    expect(shown()).toMatch(
      /^About \d+ min within 1 km2 flights · mostly \d+ to 1,\d00 ft AGL$/,
    );
    expect(box()!.getAttribute("aria-hidden")).toBe("true");
    // Below and to the right of the pointer, not on it
    expect(box()!.style.transform).toBe("translate(14px, 14px)");

    // Away from every flight it goes
    move(0, -500);
    await nextFrame();
    expect(shown()).toBeNull();
    // A hover says nothing to a screen reader
    expect(status()).toBe("");
  });

  it("follows the filters, Isolate and the band of heights", async () => {
    enter3D();
    app.selectedPathIds = new Set([2]);
    move(0, 0);
    await nextFrame();
    expect(shown()).toContain("2 flights");

    app.isolateSelection = true;
    // What it said is no longer true, and the resting pointer is told anew
    expect(shown()).toBeNull();
    await nextFrame();
    expect(shown()).toContain("1 flight ·");

    app.isolateSelection = false;
    // Only the heights the cloud is drawn at
    app.heightBand = "2000-";
    expect(shown()).toBeNull();
    move(0, 0);
    await nextFrame();
    expect(shown()).toBeNull();
    app.heightBand = "";
    move(1, 0);
    await nextFrame();
    expect(shown()).toContain("2 flights");

    app.selectedYear = "2025";
    move(0, 0);
    await nextFrame();
    expect(shown()).toBeNull();
  });

  it("counts what the cloud draws with Routes and Airborne, and says the distance with Routes", async () => {
    enter3D();
    move(0, 0);
    await nextFrame();
    expect(shown()).toMatch(/^About \d+ min within 1 km/);

    app.routeWeighting = true;
    // The resting pointer is told anew, by the distance flown
    expect(shown()).toBeNull();
    await nextFrame();
    expect(shown()).toMatch(/^About [\d.]+ km flown within 1 km2 flights · /);

    // Both flights at 23 kt, which Airborne leaves out
    app.routeWeighting = false;
    app.airborneOnly = true;
    await nextFrame();
    expect(shown()).toBeNull();
  });

  it("stands clear of the values of a flight", async () => {
    enter3D();
    // The flights under the middle of the map
    map().jumpTo({ center: [7.6, 50.3] });
    move(400, 300);
    await nextFrame();
    expect(box()!.style.transform).toBe("translate(414px, 314px)");

    // The values of a ribbon below the pointer, shown after the readout
    // (a look on idle): the box goes above it (jsdom lays nothing out, the
    // box is 0 px wide and high)
    const values = document.createElement("div");
    values.className = "maplibregl-popup segment-tooltip";
    values.getBoundingClientRect = () =>
      ({ left: 300, top: 310, right: 500, bottom: 400 }) as DOMRect;
    map().getContainer().append(values);
    await vi.waitFor(() =>
      expect(box()!.style.transform).toBe("translate(414px, 286px)"),
    );
    // And stays shown beside them as the pointer moves
    move(401, 300);
    await nextFrame();
    expect(shown()).not.toBeNull();
    expect(box()!.style.transform).toBe("translate(415px, 286px)");

    // Where no side of the pointer is clear, beside the values
    values.getBoundingClientRect = () =>
      ({ left: 300, top: 250, right: 500, bottom: 350 }) as DOMRect;
    move(400, 300);
    await nextFrame();
    expect(box()!.style.transform).toBe("translate(504px, 246px)");

    values.remove();
    await vi.waitFor(() =>
      expect(box()!.style.transform).toBe("translate(414px, 314px)"),
    );
  });

  it("steps aside for a marker and a drag", async () => {
    enter3D();
    move(0, 0);
    await nextFrame();
    expect(shown()).not.toBeNull();
    move(0, 0, { target: document.createElement("div") });
    expect(shown()).toBeNull();

    move(0, 0);
    await nextFrame();
    expect(shown()).not.toBeNull();
    move(0, 0, { buttons: 1 });
    expect(shown()).toBeNull();

    move(0, 0);
    await nextFrame();
    map().emit("movestart");
    expect(shown()).toBeNull();
    // Shown again where the map comes to rest under the pointer
    map().emit("moveend");
    await nextFrame();
    expect(shown()).not.toBeNull();

    map().emit("mouseout");
    expect(shown()).toBeNull();
  });

  it("shows nothing where the pointer is on no ground the cloud is drawn over", async () => {
    enter3D();
    // MapLibre answers the sky of a tilted map with ground behind the
    // camera: here the flights, which are drawn elsewhere
    const unproject = map().unproject;
    const ground = unproject.getMockImplementation()!;
    unproject.mockImplementation((point) => {
      const y = Array.isArray(point) ? point[1] : point.y;
      return y < -100 ? new LngLat(8, 50) : ground(point);
    });
    move(0, -300);
    await nextFrame();
    expect(shown()).toBeNull();

    // A copy of the world to the east, with no cloud drawn in it
    move(360000, 0);
    await nextFrame();
    expect(shown()).toBeNull();
    move(0, 0);
    await nextFrame();
    expect(shown()).not.toBeNull();
  });

  it("goes with Escape until the pointer moves on", async () => {
    enter3D();
    move(0, 0);
    await nextFrame();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(shown()).toBeNull();

    move(3, 3);
    await nextFrame();
    expect(shown()).toBeNull();

    move(20, 0);
    await nextFrame();
    expect(shown()).not.toBeNull();
  });

  it("shows a tap's readout above the finger and reads it out once", async () => {
    enter3D();
    touch();
    // The browser's move of the mouse for the tap is not a hover
    move(400, 300);
    await nextFrame();
    expect(shown()).toBeNull();

    click(0, 0);
    expect(shown()).toMatch(/within 1 km/);
    // Below the finger at the top of the map, where there is no room
    // above it (jsdom lays nothing out: the box is 0 px wide and high)
    expect(box()!.style.transform).toBe("translate(0px, 28px)");
    click(400, 300);
    expect(shown()).toBeNull();
    touch();
    map().jumpTo({ center: [7.6, 50.3] });
    click(400, 300);
    // 28 px above the finger
    expect(box()!.style.transform).toBe("translate(400px, 272px)");
    await vi.waitFor(() =>
      expect(status()).toMatch(
        /^About \d+ min within 1 km: 2 flights, mostly \d+ to 1,\d00 ft AGL$/,
      ),
    );
  });

  it("keeps clear of the panels over the map where it can", () => {
    enter3D();
    map().jumpTo({ center: [7.6, 50.3] });
    // The band of heights floats over the top of a phone's map
    const panel = document.createElement("div");
    panel.id = "height-band";
    panel.getBoundingClientRect = () =>
      ({ left: 0, top: 200, right: 800, bottom: 280 }) as DOMRect;
    document.body.append(panel);
    try {
      touch();
      click(400, 300);
      // Below the finger, not under the panel
      expect(box()!.style.transform).toBe("translate(400px, 328px)");
      // Hidden, it is no panel
      panel.getBoundingClientRect = () =>
        ({ left: 0, top: 0, right: 0, bottom: 0 }) as DOMRect;
      touch();
      click(400, 300);
      expect(box()!.style.transform).toBe("translate(400px, 272px)");
    } finally {
      panel.remove();
    }
  });

  it("takes a tap's readout along as the app moves the map", async () => {
    enter3D();
    map().jumpTo({ center: [7.6, 50.3] });
    touch();
    click(400, 300);
    expect(box()!.style.transform).toBe("translate(400px, 272px)");
    // The profile of the flight the tap selected opens under the map
    map().emit("movestart");
    expect(shown()).toBeNull();
    map().jumpTo({ center: [7.6, 50.25] });
    map().emit("moveend");
    await nextFrame();
    expect(shown()).toMatch(/within 1 km/);
    expect(box()!.style.transform).toBe("translate(400px, 222px)");

    // Not after Escape, nor once the place is off the map
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    map().emit("moveend");
    await nextFrame();
    expect(shown()).toBeNull();
    touch();
    click(400, 250);
    expect(shown()).not.toBeNull();
    map().emit("movestart");
    map().jumpTo({ center: [7.6, 49] });
    map().emit("moveend");
    await nextFrame();
    expect(shown()).toBeNull();
  });

  it("leaves a click on a marker or an airport's code to them", () => {
    enter3D();
    app.airportManager.airportLabelAt.mockReturnValueOnce("EDAQ Halle-Oppin");
    click(0, 0);
    expect(shown()).toBeNull();
    click(0, 0, { target: document.createElement("div") });
    expect(shown()).toBeNull();
  });

  it("shows the readout of a click on a flight, and leaves saying what it selected to the app", async () => {
    enter3D();
    // A tap selects the flight under it (the app's click handler, which
    // runs first) and opens its values
    touch();
    app.selectedPathIds = new Set([1]);
    click(0, 0);
    expect(shown()).toMatch(/within 1 km/);
    // A click beside every flight clears the selection
    map().emit("mousedown", {});
    app.selectedPathIds = new Set();
    click(0, 0);
    expect(shown()).toMatch(/within 1 km/);

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(status()).toBe("");
    // One that changed nothing is read out
    map().emit("mousedown", {});
    click(0, 0);
    await vi.waitFor(() => expect(status()).toMatch(/within 1 km: 2 flights/));
  });

  it("lets go of the map when the app goes", async () => {
    enter3D();
    move(0, 0);
    await nextFrame();
    expect(box()).not.toBeNull();
    lifetime.abort();
    expect(box()).toBeNull();
    expect(map().listenerCount("mousemove")).toBe(0);
    expect(map().listenerCount("click")).toBe(0);
  });
});
