/**
 * The intro of a link to shared flights: the share of the intro each flight
 * is drawn in, the clock of the run it moves, and the intro itself on the
 * map, with what skips it and what keeps it from playing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  introShares,
  introTime,
  playShareIntro,
  SHARE_INTRO_LEAST_MS,
  SHARE_INTRO_MS,
} from "../../../../kml_heatmap/frontend/ui/shareIntro";
import { LEG_PAUSE_S } from "../../../../kml_heatmap/frontend/calculations/replayAll";
import { flightClockOf } from "../../../../kml_heatmap/frontend/calculations/flightClock";
import { MAP_LAYERS } from "../../../../kml_heatmap/frontend/utils/constants";
import * as motion from "../../../../kml_heatmap/frontend/utils/motion";
import type { PathSegment } from "../../../../kml_heatmap/frontend/types";
import {
  asMapApp,
  createDataset,
  createMockApp,
  type MockApp,
} from "../../testHelpers";

/** The id of the intro's layer on the map */
const LAYER = "share-intro";

/** A flight of `path_id` along the latitude `lat`, `fixes` fixes 30 s apart */
function flight(path_id: number, lat: number, fixes = 5): PathSegment[] {
  return Array.from({ length: fixes - 1 }, (_, i) => ({
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

/**
 * The flight of `path_id` with no clock: neither times nor speeds, as a
 * planned route may be (see flightClock)
 */
function untimed(path_id: number, lat: number): PathSegment[] {
  return flight(path_id, lat).map(({ time: _time, ...segment }) => ({
    ...segment,
    groundspeed_knots: 0,
  }));
}

/**
 * Three flights of 2025, the second the longest, the third of D-EBBB, and
 * a fourth and a fifth with no clock
 */
const DATA = createDataset(
  [
    { id: 1, year: 2025, aircraft_registration: "D-EAAA" },
    { id: 2, year: 2025, aircraft_registration: "D-EAAA" },
    { id: 3, year: 2025, aircraft_registration: "D-EBBB" },
    { id: 4, year: 2025, aircraft_registration: "D-EAAA" },
    { id: 5, year: 2025, aircraft_registration: "D-EAAA" },
  ] as never,
  [
    ...flight(1, 47),
    ...flight(2, 48, 9),
    ...flight(3, 49),
    ...untimed(4, 50),
    ...untimed(5, 51),
  ],
);

/** The seconds of each flight on its own clock */
const SECONDS = flightClockOf(DATA.path_segments).duration;

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

/** Let the render a repaint fires and the promises after it run */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("introShares", () => {
  it("splits the intro by the seconds of each flight, each with its least", () => {
    const shares = introShares([3600, 600, 1800]);

    expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(SHARE_INTRO_MS, 6);
    // The hop is drawn in more than its tenth of the seconds would give it
    expect(shares[1]).toBeGreaterThan(SHARE_INTRO_LEAST_MS);
    expect(shares[1]).toBeGreaterThan(SHARE_INTRO_MS / 10);
    // The rest goes by the seconds: the longest flight the longest
    expect(shares[0]).toBeGreaterThan(shares[2]!);
    expect(shares[2]).toBeGreaterThan(shares[1]!);
    expect(shares[0]! - SHARE_INTRO_LEAST_MS).toBeCloseTo(
      2 * (shares[2]! - SHARE_INTRO_LEAST_MS),
      6,
    );
  });

  it("gives a very short flight its least", () => {
    const shares = introShares([10_000, 1]);

    expect(shares[1]).toBeGreaterThanOrEqual(SHARE_INTRO_LEAST_MS);
    expect(shares[0]! + shares[1]!).toBeCloseTo(SHARE_INTRO_MS, 6);
  });

  it("splits evenly where the flights are too many for each to have its least", () => {
    const shares = introShares(Array.from({ length: 20 }, (_, i) => i + 1));

    for (const share of shares) expect(share).toBeCloseTo(SHARE_INTRO_MS / 20);
  });

  it("gives one flight all of it", () => {
    expect(introShares([1234])).toEqual([SHARE_INTRO_MS]);
  });
});

describe("introTime", () => {
  // As sequenceStarts lays them out: a pause on the clock between them
  const legs = new Map([
    [7, 0],
    [8, 3600 + LEG_PAUSE_S],
  ]);
  const durations = new Map([
    [7, 3600],
    [8, 600],
  ]);
  const [first] = introShares([3600, 600]);

  it("starts at the first fix of the first flight", () => {
    expect(introTime(legs, durations, 0)).toBe(0);
  });

  it("moves along each flight in its share of the intro", () => {
    expect(introTime(legs, durations, first! / 2)).toBeCloseTo(1800, 6);
    expect(introTime(legs, durations, first!)).toBeCloseTo(3600, 6);
  });

  it("leaves out the pause: the next flight starts as the one before lands", () => {
    expect(introTime(legs, durations, first! + 1)).toBeGreaterThan(
      3600 + LEG_PAUSE_S,
    );
  });

  it("ends as the last flight lands, and stays there", () => {
    expect(introTime(legs, durations, SHARE_INTRO_MS)).toBeCloseTo(
      3600 + LEG_PAUSE_S + 600,
      6,
    );
    expect(introTime(legs, durations, 2 * SHARE_INTRO_MS)).toBeCloseTo(
      3600 + LEG_PAUSE_S + 600,
      6,
    );
  });
});

describe("playShareIntro", () => {
  let app: MockApp;
  let lifetime: AbortController;
  let frames: ReturnType<typeof clockedFrames>;

  const map = (): NonNullable<MockApp["map"]> => app.map!;
  const onMap = (): boolean => !!map().getLayer(LAYER);
  /** The time the intro's layer was last asked to draw */
  const time = (): number =>
    (
      map()
        .addLayer.mock.calls.filter(
          ([spec]) => (spec as { id: string }).id === LAYER,
        )
        .pop()![0] as unknown as { style: () => { time: number } }
    ).style().time;
  const lines = (): unknown =>
    map().getLayoutProperty(MAP_LAYERS.selectionHighlight, "visibility");

  /** Share the flights `pathIds` */
  function share(...pathIds: number[]): void {
    app.store.batch(() => {
      for (const pathId of pathIds) app.selectedPathIds.add(pathId);
      app.store.notifyMutation("selectedPathIds");
      app.isolateSelection = true;
    });
  }

  beforeEach(() => {
    lifetime = new AbortController();
    app = createMockApp({
      signal: lifetime.signal,
      currentData: DATA,
      selectedYear: "all",
    });
    frames = clockedFrames();
    vi.spyOn(motion, "prefersReducedMotion").mockReturnValue(false);
    // The lines of the selection show, as the store has them in share mode
    app.selectionHighlightLayer.setVisible(true);
  });

  afterEach(() => {
    lifetime.abort();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("frames the shared flights and draws them in, one after another", () => {
    share(1, 2);
    map().easeTo.mockClear();

    playShareIntro(asMapApp(app));

    // The camera sets off for the flights, the bearing kept
    expect(map().easeTo).toHaveBeenCalledTimes(1);
    const ease = map().easeTo.mock.calls[0]![0] as {
      bearing?: number;
      duration?: number;
    };
    expect(ease.bearing).toBe(map().getBearing());
    expect(ease.duration).toBeGreaterThan(0);
    // The trails take the place of the lines, from nothing drawn
    expect(onMap()).toBe(true);
    expect(lines()).toBe("none");
    expect(time()).toBe(0);

    frames.run();
    const one = SECONDS.get(1)!;
    const [first] = introShares([one, SECONDS.get(2)!]);
    frames.run(first! / 2);
    // Half way through the first flight, the second not started
    expect(time()).toBeCloseTo(one / 2, 6);
    frames.run(first! / 2 + 1);
    expect(time()).toBeGreaterThan(one + LEG_PAUSE_S);
    expect(lines()).toBe("none");
  });

  it("hands over to the lines at the end, and takes the trails away once they are drawn", async () => {
    share(1, 2, 3);
    playShareIntro(asMapApp(app));
    frames.run();
    // The tiles of the lines are on their way
    map().areTilesLoaded.mockReturnValue(false);

    frames.run(SHARE_INTRO_MS);

    expect(lines()).toBe("visible");
    expect(onMap()).toBe(true);
    // Drawn in full: the last flight has landed
    expect(time()).toBeGreaterThan(0);
    expect(frames.pending()).toBe(0);
    await settle();
    expect(onMap()).toBe(true);

    map().areTilesLoaded.mockReturnValue(true);
    map().emit("render");
    await settle();
    expect(onMap()).toBe(false);
  });

  it("gives the lines back what the store had them at", () => {
    app.selectionHighlightLayer.setVisible(false);
    share(1);
    playShareIntro(asMapApp(app));
    frames.run();

    frames.run(SHARE_INTRO_MS);

    expect(lines()).toBe("none");
  });

  it("hides the lines again on every frame, as the store shows them", () => {
    share(1, 2);
    playShareIntro(asMapApp(app));
    frames.run();

    app.selectionHighlightLayer.setVisible(true);
    expect(lines()).toBe("visible");
    frames.run(100);

    expect(lines()).toBe("none");
  });

  for (const type of ["pointerdown", "wheel", "keydown", "touchstart"]) {
    it(`skips to the end on ${type}`, async () => {
      share(1, 2);
      playShareIntro(asMapApp(app));
      frames.run();
      frames.run(500);
      map().isMoving.mockReturnValue(true);
      map().jumpTo.mockClear();

      window.dispatchEvent(new Event(type));

      // The camera where it was going, every flight drawn, the lines back
      expect(map().jumpTo).toHaveBeenCalledTimes(1);
      expect(frames.pending()).toBe(0);
      expect(lines()).toBe("visible");
      await settle();
      expect(onMap()).toBe(false);
    });
  }

  it("keeps the trails through the rest of the gesture that skipped it", async () => {
    // A tap is a pointerdown and a touchstart: the second took the trails
    // away before the lines were drawn again, and the flights blinked out
    share(1, 2);
    playShareIntro(asMapApp(app));
    frames.run();
    map().areTilesLoaded.mockReturnValue(false);

    window.dispatchEvent(new Event("pointerdown"));
    window.dispatchEvent(new Event("touchstart"));
    await settle();

    expect(onMap()).toBe(true);
  });

  it("keeps the trails on input while the lines are drawn", async () => {
    share(1, 2);
    playShareIntro(asMapApp(app));
    frames.run();
    map().areTilesLoaded.mockReturnValue(false);
    frames.run(SHARE_INTRO_MS);
    await settle();

    window.dispatchEvent(new Event("wheel"));
    await settle();

    expect(onMap()).toBe(true);
  });

  it("leaves the camera to what the app opened when the map is taken", () => {
    share(1, 2);
    playShareIntro(asMapApp(app));
    frames.run();
    map().isMoving.mockReturnValue(true);
    map().jumpTo.mockClear();

    app.replayActive = true;

    expect(frames.pending()).toBe(0);
    expect(map().jumpTo).not.toHaveBeenCalled();
    expect(lines()).toBe("visible");
    // Its trails do not stand over what the replay draws
    expect(onMap()).toBe(false);
  });

  it("takes the trails away at once when the map is taken as the lines are drawn", async () => {
    share(1, 2);
    playShareIntro(asMapApp(app));
    frames.run();
    map().areTilesLoaded.mockReturnValue(false);
    frames.run(SHARE_INTRO_MS);
    await settle();
    expect(onMap()).toBe(true);

    // The replay of all flights, started by the click that skipped it
    app.replayActive = true;

    expect(onMap()).toBe(false);
  });

  it("only frames flights with no clock, their lines left as they are", () => {
    share(4, 5);
    map().easeTo.mockClear();

    playShareIntro(asMapApp(app));

    expect(map().easeTo).toHaveBeenCalledTimes(1);
    expect(onMap()).toBe(false);
    expect(frames.pending()).toBe(0);
    expect(lines()).toBe("visible");
  });

  it("draws in the flights with a clock, and shows those without at the end", () => {
    share(1, 4);
    playShareIntro(asMapApp(app));
    frames.run();

    frames.run(SHARE_INTRO_MS / 2);

    // The one flight with a clock takes all of the intro
    expect(time()).toBeCloseTo(SECONDS.get(1)! / 2, 6);
    expect(lines()).toBe("none");
    frames.run(SHARE_INTRO_MS);
    expect(lines()).toBe("visible");
  });

  it("only frames the flights under reduced motion", () => {
    vi.mocked(motion.prefersReducedMotion).mockReturnValue(true);
    share(1, 2);
    map().easeTo.mockClear();

    playShareIntro(asMapApp(app));

    expect(map().jumpTo).toHaveBeenCalledTimes(1);
    expect(map().easeTo).not.toHaveBeenCalled();
    expect(onMap()).toBe(false);
    expect(frames.pending()).toBe(0);
    expect(lines()).toBe("visible");
  });

  it("does not play while a replay, the tour or Wrapped holds the map", () => {
    share(1, 2);
    for (const hold of [
      () => (app.replayActive = true),
      () => (app.wrappedVisible = true),
      () => (app.tourView = {} as never),
    ]) {
      hold();
      map().easeTo.mockClear();
      map().jumpTo.mockClear();

      playShareIntro(asMapApp(app));

      expect(map().easeTo).not.toHaveBeenCalled();
      expect(map().jumpTo).not.toHaveBeenCalled();
      expect(onMap()).toBe(false);
      app.replayActive = false;
      app.wrappedVisible = false;
      app.tourView = null;
    }
  });

  it("does not play without share mode", () => {
    app.selectedPathIds.add(1);
    app.store.notifyMutation("selectedPathIds");

    playShareIntro(asMapApp(app));

    expect(onMap()).toBe(false);
    expect(map().easeTo).not.toHaveBeenCalled();
  });

  it("does not play where the filter hides every shared flight", () => {
    share(3);
    app.selectedAircraft = "D-EAAA";

    playShareIntro(asMapApp(app));

    expect(onMap()).toBe(false);
    expect(map().easeTo).not.toHaveBeenCalled();
  });

  it("draws only the shared flights the filter shows", () => {
    share(1, 3);
    app.selectedAircraft = "D-EAAA";
    playShareIntro(asMapApp(app));
    frames.run();

    frames.run(SHARE_INTRO_MS / 2);

    // The one flight takes all of the intro
    expect(time()).toBeCloseTo(SECONDS.get(1)! / 2, 6);
  });

  it("stands down with the app", async () => {
    share(1, 2);
    playShareIntro(asMapApp(app));
    frames.run();

    lifetime.abort();
    await settle();

    expect(onMap()).toBe(false);
    // No frame runs on for a torn down app
    expect(frames.pending()).toBe(0);
  });
});
