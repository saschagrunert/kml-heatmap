/**
 * The replay of all flights: the player that plays every flight of a run at
 * once on the map, and the control and panel that make it a replay of the
 * map, holding the filters and the selection meanwhile.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  REPLAY_ALL_NOTHING_MESSAGE,
  REPLAY_ALL_ORBIT_REDUCED_MOTION_MESSAGE,
  REPLAY_ALL_SPEED,
  REPLAY_ALL_UNAVAILABLE_MESSAGE,
  ReplayAllControls,
  ReplayAllPlayer,
  replayAllClock,
  toggleReplayAll,
} from "../../../../kml_heatmap/frontend/ui/replayAll";
import {
  REPLAY_ALL_LAYER,
  type ReplayAllLayer,
} from "../../../../kml_heatmap/frontend/ui/replayAllLayer";
import * as motion from "../../../../kml_heatmap/frontend/utils/motion";
import { MAP_LAYERS } from "../../../../kml_heatmap/frontend/utils/constants";
import { HEAT_CLOUD_LAYER } from "../../../../kml_heatmap/frontend/ui/heatCloudLayer";
import { REPLAY_PANEL_HEIGHT_VAR } from "../../../../kml_heatmap/frontend/ui/replayManager";
import { heldGroundedFlights } from "../../../../kml_heatmap/frontend/calculations/groundProfile";
import { REPLAY_CAMERA_MOVE } from "../../../../kml_heatmap/frontend/utils/mapHelpers";
import type { PathSegment } from "../../../../kml_heatmap/frontend/types";
import {
  asMapApp,
  createDataset,
  createMockApp,
  mountElements,
  type MockApp,
} from "../../testHelpers";

const toast = vi.hoisted(() => ({ showToast: vi.fn() }));
/** Every cut of the curves, counted */
const cuts = vi.hoisted(() => ({ count: 0 }));
vi.mock(
  "../../../../kml_heatmap/frontend/calculations/replayAll",
  async (original) => {
    const module =
      await original<
        typeof import("../../../../kml_heatmap/frontend/calculations/replayAll")
      >();
    return {
      ...module,
      replayAllPoints: (...args: Parameters<typeof module.replayAllPoints>) => {
        cuts.count++;
        return module.replayAllPoints(...args);
      },
    };
  },
);
vi.mock("../../../../kml_heatmap/frontend/utils/toast", async (original) => ({
  ...(await original<object>()),
  showToast: toast.showToast,
}));

/** A flight of `path_id` along the latitude `lat`: five fixes 30 s apart */
function flight(path_id: number, lat: number): PathSegment[] {
  return [0, 1, 2, 3].map((i) => ({
    path_id,
    coords: [
      [lat, 11 + i * 0.01],
      [lat, 11 + (i + 1) * 0.01],
    ],
    altitude_ft: 3000,
    groundspeed_knots: 100,
    time: i * 30,
  }));
}

/** Two flights in 2025, one of them of another aircraft, one in 2026 */
const DATA = createDataset(
  [
    { id: 1, year: 2025, aircraft_registration: "D-EAAA" },
    { id: 2, year: 2025, aircraft_registration: "D-EBBB" },
    { id: 3, year: 2026, aircraft_registration: "D-EAAA" },
  ] as never,
  [...flight(1, 47), ...flight(2, 48), ...flight(3, 49)],
);

/** Animation frames run by hand, `ms` apart */
function clockedFrames() {
  const frames = new Map<number, FrameRequestCallback>();
  let handle = 0;
  let now = 1000;
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((callback: FrameRequestCallback) => {
      frames.set(++handle, callback);
      return handle;
    }),
  );
  vi.stubGlobal(
    "cancelAnimationFrame",
    vi.fn((id: number) => frames.delete(id)),
  );
  return {
    run(ms = 100, times = 1): void {
      for (let n = 0; n < times; n++) {
        now += ms;
        const due = [...frames.values()];
        frames.clear();
        for (const frame of due) frame(now);
      }
    },
    pending: () => frames.size,
  };
}

/** Held while every flight replays */
const HELD = [
  "heatmap-btn",
  "altitude-btn",
  "year-select",
  "aircraft-select",
  "isolate-btn",
  "wrapped-btn",
  "replay-btn",
];

describe("the replay of all flights", () => {
  let app: MockApp;
  let lifetime: AbortController;
  let frames: ReturnType<typeof clockedFrames>;
  let unmount: () => void;

  const map = (): NonNullable<MockApp["map"]> => app.map!;
  /** The layer the player put on the map, as it was handed to it */
  const layer = (): ReplayAllLayer | null =>
    (
      map().getLayer(REPLAY_ALL_LAYER) as unknown as {
        implementation?: ReplayAllLayer;
      } | null
    )?.implementation ??
    (map()
      .addLayer.mock.calls.filter(
        ([spec]) => (spec as { id: string }).id === REPLAY_ALL_LAYER,
      )
      .pop()?.[0] as unknown as ReplayAllLayer | undefined) ??
    null;
  const onMap = (): boolean => !!map().getLayer(REPLAY_ALL_LAYER);

  beforeEach(() => {
    lifetime = new AbortController();
    app = createMockApp({
      signal: lifetime.signal,
      currentData: DATA,
      selectedYear: "all",
    });
    frames = clockedFrames();
    unmount = mountElements({
      ...Object.fromEntries(
        HELD.map((id) => [id, id.endsWith("select") ? "select" : "button"]),
      ),
      "replay-all-btn": "button",
    });
    toast.showToast.mockClear();
  });

  afterEach(() => {
    lifetime.abort();
    unmount();
    document.getElementById("replay-all-controls")?.remove();
    document.body.className = "";
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("the player", () => {
    let player: ReplayAllPlayer;

    beforeEach(() => {
      player = new ReplayAllPlayer(asMapApp(app));
    });

    it("plays every flight the filters keep, from their first fixes", () => {
      void player.start();

      expect(player.flights).toBe(3);
      expect(player.playing).toBe(true);
      expect(player.time).toBe(0);
      expect(player.speed).toBe(REPLAY_ALL_SPEED);
      // Next to the heat cloud, below the flights in the air
      const order = map().getLayersOrder();
      expect(order.indexOf(REPLAY_ALL_LAYER)).toBe(
        order.indexOf(MAP_LAYERS.pathsAltitudeRibbons) - 1,
      );
    });

    it("keeps to the year and aircraft filters", () => {
      app.store.set("selectedYear", "2025");
      app.store.set("selectedAircraft", "D-EAAA");

      void player.start();

      expect(player.flights).toBe(1);
      expect(player.bounds![1]).toBe(47);
    });

    it("plays the isolated selection alone", () => {
      app.store.batch(() => {
        app.selectedPathIds.add(2);
        app.store.notifyMutation("selectedPathIds");
        app.isolateSelection = true;
      });

      void player.start();

      expect(player.flights).toBe(1);
      expect(player.bounds![1]).toBe(48);
    });

    it("plays the flights it is given, whatever the filters", () => {
      app.store.set("selectedYear", "2026");

      void player.start({ pathIds: [1, 2], speed: 500 });

      expect(player.flights).toBe(2);
      expect(player.speed).toBe(500);
    });

    it("moves the clock by the seconds of the frames times the speed", () => {
      void player.start({ speed: 100 });
      // The first frame starts the clock
      frames.run();
      expect(player.time).toBe(0);

      frames.run(50, 2);

      expect(player.time).toBeCloseTo(10, 6);
      expect(map().triggerRepaint).toHaveBeenCalled();
    });

    it("never moves it by more than a tenth of a second of a stalled frame", () => {
      void player.start({ speed: 100 });
      frames.run();

      frames.run(5000);

      expect(player.time).toBeCloseTo(10, 6);
    });

    it("says it has played once the last flight has landed, and stops once the trails have faded", async () => {
      const ended = player.start({ speed: 500 });
      let landed: boolean | null = null;
      void ended.then((value) => (landed = value));
      frames.run();

      // Some 135 s of flight, a third of a second at 500 times
      frames.run(100, 3);
      await Promise.resolve();
      expect(landed).toBe(true);
      expect(player.playing).toBe(true);

      // The trails fade over 3 s
      frames.run(100, 35);
      expect(player.playing).toBe(false);
      expect(player.time).toBeCloseTo(player.duration + 1500, 6);
      expect(frames.pending()).toBe(0);
    });

    it("starts again from the beginning once it has played to the end", () => {
      void player.start({ speed: 500 });
      frames.run(100, 50);
      expect(player.playing).toBe(false);

      player.resume();

      expect(player.time).toBe(0);
      expect(player.playing).toBe(true);
    });

    it("holds the clock while paused", () => {
      void player.start({ speed: 100 });
      frames.run(100, 3);
      const held = player.time;

      player.pause();
      frames.run(100, 3);

      expect(player.time).toBe(held);
      expect(frames.pending()).toBe(0);
      player.resume();
      frames.run(100, 2);
      expect(player.time).toBeCloseTo(held + 10, 6);
    });

    it("takes the run off the map as it stops, and says it did not play to the end", async () => {
      const ended = player.start();

      player.stop();

      await expect(ended).resolves.toBe(false);
      expect(onMap()).toBe(false);
      expect(player.active).toBe(false);
      expect(player.playing).toBe(false);
    });

    it("stops when another dataset comes, which is not what it plays", async () => {
      const ended = player.start();

      app.store.set("currentData", createDataset([], flight(9, 50)));

      await expect(ended).resolves.toBe(false);
      expect(onMap()).toBe(false);
    });

    it("has nothing to play where no flight has a clock", async () => {
      app.store.set(
        "currentData",
        createDataset(
          [{ id: 1, year: 2025 }] as never,
          flight(1, 47).map(({ time: _, ...segment }) => ({
            ...segment,
            groundspeed_knots: 0,
          })),
        ),
      );

      await expect(player.start()).resolves.toBe(false);
      expect(player.flights).toBe(0);
      expect(onMap()).toBe(false);
    });

    it("stops its frames with the app, which leaves the map as it is", () => {
      void player.start();
      frames.run();

      lifetime.abort();

      expect(frames.pending()).toBe(0);
      expect(player.playing).toBe(false);
      frames.run();
      expect(frames.pending()).toBe(0);
    });

    it("goes back below the ribbons, next to the heat cloud, where a new style left it", () => {
      void player.start();
      const ribbons = MAP_LAYERS.pathsAltitudeRibbons;
      const order = (): string[] => map().getLayersOrder();

      // The heat cloud puts itself right below the ribbons, and may stay
      map().addLayer({ id: HEAT_CLOUD_LAYER, type: "custom" }, ribbons);
      map().emit("styledata");
      expect(map().moveLayer).not.toHaveBeenCalled();

      map().moveLayer(REPLAY_ALL_LAYER);
      map().emit("styledata");

      expect(order().indexOf(REPLAY_ALL_LAYER)).toBeLessThan(
        order().indexOf(ribbons),
      );
      expect(order().indexOf(REPLAY_ALL_LAYER)).toBeGreaterThan(
        order().indexOf(ribbons) - 3,
      );
    });

    it("lets go of the smoothed flights on the flat map as it stops", () => {
      void player.start();
      expect(heldGroundedFlights()).toBe(DATA.path_segments);

      player.stop();

      expect(heldGroundedFlights()).toBeNull();
    });

    it("cuts the curves anew for another zoom, and keeps the cuts of the last ones", () => {
      void player.start();
      const drawn = vi.spyOn(layer()!, "setPoints");

      map().setZoom(14);
      map().emit("zoomend");
      map().setZoom(6);
      map().emit("zoomend");
      map().emit("zoomend");

      expect(drawn).toHaveBeenCalledTimes(2);
      map().setZoom(14.5);
      map().emit("zoomend");
      // The cut of zoom 14 again, as it was
      expect(drawn).toHaveBeenCalledTimes(3);
      expect(drawn.mock.calls[2]![0]).toBe(drawn.mock.calls[0]![0]);
    });

    it("cuts the curves ahead for the zoom a camera on its way sets out for, and draws them as it comes near", () => {
      // A camera setting off from far out for zoom 9
      map().setZoom(1);
      cuts.count = 0;
      void player.start({ zoom: 9 });
      // For where it is, and ahead for where it goes
      expect(cuts.count).toBe(2);
      const drawn = vi.spyOn(layer()!, "setPoints");

      // Far out it draws the curves cut for far out
      map().setZoom(5);
      map().emit("zoom");
      expect(drawn).not.toHaveBeenCalled();
      // Near, those cut ahead, cut no more
      map().setZoom(7.1);
      map().emit("zoom");
      map().setZoom(8);
      map().emit("zoom");
      expect(drawn).toHaveBeenCalledOnce();
      expect(cuts.count).toBe(2);
      // Where it comes to rest: the same
      map().setZoom(9.4);
      map().emit("zoomend", REPLAY_CAMERA_MOVE);
      expect(drawn).toHaveBeenCalledOnce();
      expect(cuts.count).toBe(2);
      // From there on the map's zoom, as without it
      map().setZoom(3);
      map().emit("zoom");
      expect(drawn).toHaveBeenCalledOnce();
      map().emit("zoomend");
      expect(drawn).toHaveBeenCalledTimes(2);
    });

    it("cuts the curves once for a run that sets out near its zoom, and for the map's alone without one", () => {
      map().setZoom(8);
      cuts.count = 0;
      void player.start({ zoom: 9 });
      expect(cuts.count).toBe(1);
      player.stop();

      map().setZoom(1);
      cuts.count = 0;
      void player.start();
      expect(cuts.count).toBe(1);
      const drawn = vi.spyOn(layer()!, "setPoints");
      // Nothing is cut while the map zooms, only as it comes to rest
      map().setZoom(9.4);
      map().emit("zoom");
      expect(drawn).not.toHaveBeenCalled();
      map().emit("zoomend");
      expect(drawn).toHaveBeenCalledOnce();
    });

    it("draws at the heights of the 3D view, and flat without it", () => {
      void player.start();
      const style = (): { groundM: number; liftM: number } =>
        (
          layer() as unknown as {
            style: () => { groundM: number; liftM: number };
          }
        ).style();

      expect(style()).toMatchObject({ groundM: 0, liftM: 0 });

      app.store.batch(() => {
        app.threeDVisible = true;
        app.terrainActive = true;
      });

      expect(style().groundM).toBeGreaterThan(0);
      expect(style().liftM).toBeGreaterThan(0);
    });

    it("turns the camera slowly round the flights while it plays, when asked", () => {
      vi.spyOn(motion, "prefersReducedMotion").mockReturnValue(false);
      void player.start();
      player.orbit = true;
      frames.run();

      frames.run(100, 10);

      expect(map().getBearing()).toBeCloseTo(3, 6);
      expect(map().jumpTo.mock.lastCall?.[1]).toBe(REPLAY_CAMERA_MOVE);
    });

    it("tells the map the camera has come to rest once the orbit stops turning it", () => {
      vi.spyOn(motion, "prefersReducedMotion").mockReturnValue(false);
      void player.start();
      player.orbit = true;
      frames.run();
      frames.run(100, 3);
      const rests = (): number =>
        map().fire.mock.calls.filter(([type]) => type === "moveend").length;
      expect(rests()).toBe(0);

      player.orbit = false;
      frames.run();
      frames.run();

      // Once, untagged, so the saved view and the link follow
      expect(rests()).toBe(1);
      expect(map().fire).toHaveBeenLastCalledWith("moveend");
    });

    it("does not turn the camera under reduced motion", () => {
      vi.spyOn(motion, "prefersReducedMotion").mockReturnValue(true);
      void player.start();
      player.orbit = true;

      frames.run(100, 10);

      expect(map().jumpTo).not.toHaveBeenCalled();
    });
  });

  describe("the control and its panel", () => {
    let controls: ReplayAllControls;

    const panel = (): HTMLElement =>
      document.getElementById("replay-all-controls")!;
    const clock = (): string =>
      document.getElementById("replay-all-clock")!.textContent ?? "";
    const held = (id: string): boolean =>
      (document.getElementById(id) as HTMLButtonElement).disabled;

    beforeEach(() => {
      controls = new ReplayAllControls(asMapApp(app));
    });

    it("plays every flight as a replay of the map, and holds the filters", () => {
      controls.show();

      expect(controls.isOpen).toBe(true);
      expect(app.replayActive).toBe(true);
      expect(app.replayState.all).toBe(true);
      for (const id of HELD) expect(held(id), id).toBe(true);
      expect(panel().hidden).toBe(false);
      expect(document.body.classList).toContain("replay-all-active");
      const button = document.getElementById("replay-all-btn")!;
      expect(button.getAttribute("aria-pressed")).toBe("true");
      expect(button.dataset["icon"]).toBe("stop");
      expect(onMap()).toBe(true);
    });

    it("fits the camera to the flights, north up", () => {
      map().jumpTo({ bearing: 40 });

      controls.show();

      expect(map().fitBounds).toHaveBeenCalledWith(
        [
          [11, 47],
          [expect.closeTo(11.04, 6), 49],
        ],
        expect.objectContaining({ bearing: 0 }),
      );
    });

    it("reads the time into every flight on its clock", () => {
      controls.show();
      expect(clock()).toBe("0:00 into every flight");

      frames.run();
      frames.run(100, 3);

      // 60 s of flight at 200 times
      expect(clock()).toBe("0:01 into every flight");
    });

    it("pauses and plays from its button, which says what a press does", () => {
      controls.show();
      const play = document.getElementById("replay-all-play-btn")!;
      expect(play.getAttribute("aria-label")).toBe(
        "Pause the replay of all flights",
      );

      play.click();

      expect(controls.player.playing).toBe(false);
      expect(play.dataset["icon"]).toBe("play");
      expect(play.getAttribute("aria-label")).toBe(
        "Play the replay of all flights",
      );
      expect(play.title).toBe(play.getAttribute("aria-label"));
      play.click();
      expect(controls.player.playing).toBe(true);
    });

    it("plays at the speed picked", () => {
      controls.show();
      const speed = document.getElementById(
        "replay-all-speed",
      ) as HTMLSelectElement;
      expect([...speed.options].map((option) => option.value)).toEqual([
        "100",
        "200",
        "300",
        "500",
      ]);

      speed.value = "500";
      speed.dispatchEvent(new Event("change"));

      expect(controls.player.speed).toBe(500);
    });

    it("turns the orbit on and off, and a camera the user moves turns it off", () => {
      vi.spyOn(motion, "prefersReducedMotion").mockReturnValue(false);
      controls.show();
      const orbit = document.getElementById("replay-all-orbit-btn")!;
      expect(orbit.getAttribute("aria-pressed")).toBe("false");

      orbit.click();
      expect(controls.player.orbit).toBe(true);
      expect(orbit.getAttribute("aria-pressed")).toBe("true");

      // Its own jumps are not the user's
      map().emit("movestart", {});
      expect(controls.player.orbit).toBe(true);
      map().emit("movestart", { originalEvent: new MouseEvent("mousedown") });
      expect(controls.player.orbit).toBe(false);
      expect(orbit.getAttribute("aria-pressed")).toBe("false");
    });

    it("keeps the orbit off under reduced motion, and says why as it is pressed", () => {
      vi.spyOn(motion, "prefersReducedMotion").mockReturnValue(true);
      controls.show();
      const orbit = document.getElementById(
        "replay-all-orbit-btn",
      ) as HTMLButtonElement;
      // Still in the tab order, so a keyboard can find out why
      expect(orbit.disabled).toBe(false);

      orbit.click();

      expect(controls.player.orbit).toBe(false);
      expect(orbit.getAttribute("aria-pressed")).toBe("false");
      expect(toast.showToast).toHaveBeenCalledWith(
        REPLAY_ALL_ORBIT_REDUCED_MOTION_MESSAGE,
        "info",
      );
    });

    it("opens again with the orbit off", () => {
      vi.spyOn(motion, "prefersReducedMotion").mockReturnValue(false);
      controls.show();
      document.getElementById("replay-all-orbit-btn")!.click();
      controls.close();

      controls.show();

      expect(controls.player.orbit).toBe(false);
      expect(
        document
          .getElementById("replay-all-orbit-btn")!
          .getAttribute("aria-pressed"),
      ).toBe("false");
    });

    it("stacks the toasts above its panel while it is open", () => {
      controls.show();
      expect(
        document.body.style.getPropertyValue(REPLAY_PANEL_HEIGHT_VAR),
      ).toMatch(/px$/);

      controls.close();

      expect(
        document.body.style.getPropertyValue(REPLAY_PANEL_HEIGHT_VAR),
      ).toBe("");
    });

    it("gives the page back as it was when closed", () => {
      controls.show();

      document.getElementById("replay-all-close-btn")!.click();

      expect(controls.isOpen).toBe(false);
      expect(app.replayActive).toBe(false);
      expect(app.replayState.all).toBe(false);
      for (const id of HELD) expect(held(id), id).toBe(false);
      expect(panel().hidden).toBe(true);
      expect(document.body.classList).not.toContain("replay-all-active");
      const button = document.getElementById("replay-all-btn")!;
      expect(button.getAttribute("aria-pressed")).toBe("false");
      expect(document.activeElement).toBe(button);
      expect(onMap()).toBe(false);
    });

    it("closes on Escape, but not from the speed picker", () => {
      controls.show();
      const speed = document.getElementById("replay-all-speed")!;

      speed.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
      expect(controls.isOpen).toBe(true);

      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      expect(controls.isOpen).toBe(false);
    });

    it("closes when the player stops from elsewhere", () => {
      controls.show();

      controls.player.stop();

      expect(controls.isOpen).toBe(false);
      expect(app.replayActive).toBe(false);
    });

    it("says so when there is nothing to play, and holds nothing", () => {
      app.store.set("currentData", createDataset([], []));

      controls.show();

      expect(toast.showToast).toHaveBeenCalledWith(
        REPLAY_ALL_NOTHING_MESSAGE,
        "info",
      );
      expect(controls.isOpen).toBe(false);
      expect(app.replayActive).toBe(false);
      expect(held("year-select")).toBe(false);
    });

    it("says so where its shaders do not work", async () => {
      const layer = (
        controls.player as unknown as {
          layer: { failed: (error: unknown) => void };
        }
      ).layer;
      vi.spyOn(console, "error").mockImplementation(() => {});
      layer.failed(new Error("no WebGL 2"));
      await new Promise((resolve) => setTimeout(resolve, 0));

      controls.show();

      expect(toast.showToast).toHaveBeenCalledWith(
        REPLAY_ALL_UNAVAILABLE_MESSAGE,
        "error",
      );
      expect(controls.isOpen).toBe(false);
    });

    it("plays again in the context the map gets back after a loss, which is what its shaders may have failed with", async () => {
      const layer = (
        controls.player as unknown as {
          layer: { failed: (error: unknown) => void };
        }
      ).layer;
      vi.spyOn(console, "error").mockImplementation(() => {});
      layer.failed(new Error("the replay's buffers could not be made"));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(controls.player.unavailable).toBe(true);
      app.map!.emit("webglcontextlost");

      app.map!.emit("webglcontextrestored");
      app.map!.emit("style.load");
      controls.show();

      expect(controls.player.unavailable).toBe(false);
      expect(controls.isOpen).toBe(true);
    });

    it("stays shut while the replay of one flight runs", () => {
      app.replayActive = true;

      controls.show();

      expect(controls.isOpen).toBe(false);
      expect(onMap()).toBe(false);
    });

    it("stays shut while the hotspot tour holds the map", () => {
      // A click whose bundle came after the tour's
      app.tourView = {
        center: { lat: 51, lng: 12 },
        zoom: 8,
        bearing: 0,
        pitch: 0,
        globeVisible: false,
        threeDVisible: false,
        heatmapVisible: true,
        heightBand: "",
      };

      controls.show();

      expect(controls.isOpen).toBe(false);
      expect(app.replayActive).toBe(false);
      expect(onMap()).toBe(false);
    });

    it("opens and closes from one toggle for each app", () => {
      toggleReplayAll(asMapApp(app));
      expect(app.replayActive).toBe(true);

      toggleReplayAll(asMapApp(app));
      expect(app.replayActive).toBe(false);
    });
  });
});

describe("replayAllClock", () => {
  it("reads hours and minutes into every flight", () => {
    expect(replayAllClock(0)).toBe("0:00 into every flight");
    expect(replayAllClock(42 * 60 + 59)).toBe("0:42 into every flight");
    expect(replayAllClock(3 * 3600 + 5 * 60)).toBe("3:05 into every flight");
  });
});
