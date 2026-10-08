/**
 * The flight profile strip (ui/flightProfile.ts): shown for one selected
 * flight, read by pointing, a way into replay, and the replay's scrubber.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";
import {
  followFlightProfile,
  NO_TIMES_MESSAGE,
  profileSegments,
  PROFILE_HEIGHT_VAR,
  PROFILE_STORAGE_KEY,
} from "../../../../kml_heatmap/frontend/ui/flightProfile";
import { DAY_MAX_FLIGHTS } from "../../../../kml_heatmap/frontend/utils/constants";
import { toggleSequence } from "../../../../kml_heatmap/frontend/ui/replayAll";
import { REPLAY_PANEL_HEIGHT_VAR } from "../../../../kml_heatmap/frontend/ui/replayManager";
import { toggleCrossSection } from "../../../../kml_heatmap/frontend/ui/crossSection";
import { holdControls } from "../../../../kml_heatmap/frontend/ui/heldControls";
import * as toast from "../../../../kml_heatmap/frontend/utils/toast";
import {
  resetSiteData,
  siteData,
} from "../../../../kml_heatmap/frontend/state/siteData";
import type { PathSegment } from "../../../../kml_heatmap/frontend/types";
import {
  asMapApp,
  createDataset,
  createMockApp,
  type MockApp,
  type MockAppOverrides,
} from "../../testHelpers";

// The replay of several flights one after another has tests of its own
vi.mock(
  "../../../../kml_heatmap/frontend/ui/replayAll",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    toggleSequence: vi.fn(),
  }),
);

/** Ten segments due north, a minute apart, over ground at 300 ft */
const ALTITUDES = [800, 1500, 2500, 1100, 1200, 3000, 3000, 1800, 600, 300];

function flight(pathId: number, timed = true): PathSegment[] {
  return ALTITUDES.map((altitude, i) => ({
    path_id: pathId,
    coords: [
      [50 + i / 100, 8],
      [50 + (i + 1) / 100, 8],
    ],
    altitude_ft: altitude,
    groundspeed_knots: i === 9 ? 0 : 90,
    ground_ft: 300,
    ...(timed ? { time: i * 60 } : {}),
  }));
}

/** The plot spans 100 to 640 px across the window */
const PLOT_LEFT = 100;
const PLOT_WIDTH = 540;
/** Where a pointer is `share` of the way across the plot */
const across = (share: number): number => PLOT_LEFT + share * PLOT_WIDTH;

function pointer(
  type: string,
  share: number,
  options: PointerEventInit = {},
): PointerEvent {
  return new PointerEvent(type, {
    clientX: across(share),
    pointerType: "mouse",
    button: 0,
    bubbles: true,
    cancelable: true,
    ...options,
  });
}

interface Setup {
  app: MockApp;
  root: HTMLElement;
  plot: HTMLElement;
  toggle: HTMLButtonElement;
  hover: { onHover: ((segment: PathSegment | null) => void) | null };
  followTime: Mock;
  segments: PathSegment[];
}

let lifetime = new AbortController();

function setup(
  selected: number[] = [7],
  overrides: MockAppOverrides = {},
): Setup {
  const segments = [...flight(7), ...flight(8, false)];
  const app = createMockApp({
    currentData: createDataset(
      [{ id: 7, max_altitude_ft: 3040 }, { id: 8 }],
      segments,
    ),
    selectedPathIds: new Set(selected),
    hasTimingData: true,
    signal: lifetime.signal,
    ...overrides,
  });
  const hover = { onHover: null };
  (app.layerManager as unknown as { pathHover: typeof hover }).pathHover =
    hover;
  const followTime = vi.fn();
  (app.replayManager as unknown as { followTime: Mock }).followTime =
    followTime;
  // Opening replay swaps in the smoothed times: here twice the logged ones
  app.replayManager.toggleReplay.mockImplementation(() => {
    app.replayState.segments = flight(7).map((segment) => ({
      ...segment,
      time: segment.time! * 2,
    }));
    app.replayActive = true;
  });
  const root = followFlightProfile(asMapApp(app));
  const plot = root.querySelector<HTMLElement>(".profile-plot")!;
  vi.spyOn(plot, "getBoundingClientRect").mockReturnValue({
    left: PLOT_LEFT,
    width: PLOT_WIDTH,
  } as DOMRect);
  return {
    app,
    root,
    plot,
    toggle: document.querySelector<HTMLButtonElement>("#profile-toggle-btn")!,
    hover,
    followTime,
    segments,
  };
}

const text = (root: HTMLElement, selector: string): string =>
  root.querySelector(selector)!.textContent;

const cursorOf = (root: HTMLElement, name: string): Element =>
  root.querySelector(`.profile-${name}`)!;

describe("flight profile", () => {
  beforeEach(() => {
    lifetime = new AbortController();
    localStorage.clear();
    document.body.className = "";
    document.body.removeAttribute("style");
    document.body.innerHTML = `
      <div id="selection-chip">
        <span id="selection-chip-count"></span>
        <button id="selection-clear-btn"></button>
      </div>
      <div id="replay-controls">
        <div id="replay-controls-inner">
          <div id="replay-buttons"></div>
          <div id="replay-slider-container">
            <input id="replay-slider" type="range" />
          </div>
        </div>
      </div>`;
  });

  afterEach(() => {
    lifetime.abort();
    resetSiteData();
  });

  describe("the strip", () => {
    it("shows the one selected flight with its figures", () => {
      const { root, toggle } = setup();

      expect(root.hidden).toBe(false);
      expect(root.parentElement).toBe(document.body);
      expect(root.classList.contains("is-timed")).toBe(true);
      expect(document.body.classList.contains("profile-open")).toBe(true);
      const stats = text(root, ".profile-stats");
      expect(stats).toContain("Highest 3,040 ft MSL");
      expect(stats).toContain("Lowest en route 800 ft AGL");
      // A length of time, not a clock: "2:16" read as hours and minutes
      expect(stats).toContain("Below 1,000 ft AGL 2 min");
      expect(text(root, ".profile-axis")).toBe("0:009:00");
      expect(
        root.querySelector(".profile-plot")!.getAttribute("aria-label"),
      ).toBe("Altitude over time, 0:00 to 9:00, highest 3,040 ft MSL");
      expect(root.querySelector(".profile-line")!.getAttribute("d")).toMatch(
        /^M0\.0 /,
      );
      expect(root.querySelector(".profile-ground")!.getAttribute("d")).toMatch(
        /Z$/,
      );
      // On the chip, ahead of its Clear
      expect(toggle.hidden).toBe(false);
      expect(toggle.nextElementSibling?.id).toBe("selection-clear-btn");
      expect(toggle.getAttribute("aria-expanded")).toBe("true");
      expect(toggle.getAttribute("aria-controls")).toBe("flight-profile");
    });

    it("stays away with no flight selected, and with more than it draws", () => {
      const { app, root, toggle } = setup([]);
      expect(root.hidden).toBe(true);
      expect(toggle.hidden).toBe(true);

      app.selectedPathIds.add(7);
      app.store.notifyMutation("selectedPathIds");
      expect(root.hidden).toBe(false);

      for (let id = 10; app.selectedPathIds.size <= DAY_MAX_FLIGHTS; id++) {
        app.selectedPathIds.add(id);
      }
      app.store.notifyMutation("selectedPathIds");
      expect(root.hidden).toBe(true);
      expect(toggle.hidden).toBe(true);
      expect(document.body.classList.contains("profile-open")).toBe(false);
    });

    it("runs a flight without times along its distance", () => {
      const { root } = setup([8]);

      expect(root.hidden).toBe(false);
      expect(root.classList.contains("is-timed")).toBe(false);
      expect(text(root, ".profile-axis")).toMatch(/^0 km10 km$/);
      expect(text(root, ".profile-stats")).not.toContain("Below");
    });

    it("leaves out the fields of the site's airports", () => {
      siteData.airports = [{ name: "Middle", lat: 50.04, lon: 8 }];
      const { root } = setup();

      expect(text(root, ".profile-stats")).toContain(
        "Lowest en route 1,200 ft AGL",
      );
    });

    it("is drawn anew for another dataset", () => {
      const { app, root } = setup();
      const segments = flight(7).map((segment) => ({
        ...segment,
        altitude_ft: segment.altitude_ft + 1000,
      }));

      app.currentData = createDataset([{ id: 7 }], segments);

      expect(text(root, ".profile-stats")).toContain("Highest 4,000 ft MSL");
    });

    it("steps aside for Wrapped", () => {
      const { app, root } = setup();

      app.wrappedVisible = true;
      expect(root.hidden).toBe(true);

      app.wrappedVisible = false;
      expect(root.hidden).toBe(false);
    });

    it("tells the page its height", () => {
      let measure: () => void = () => {};
      vi.stubGlobal(
        "ResizeObserver",
        class {
          constructor(callback: () => void) {
            measure = callback;
          }
          observe(): void {}
          disconnect(): void {}
        },
      );
      const { root } = setup();

      measure();
      expect(
        document.documentElement.style.getPropertyValue(PROFILE_HEIGHT_VAR),
      ).toBe("");
      Object.defineProperty(root, "offsetHeight", { value: 120 });
      measure();
      expect(
        document.documentElement.style.getPropertyValue(PROFILE_HEIGHT_VAR),
      ).toBe("120px");
    });
  });

  describe("its lifetime", () => {
    it("goes with the app", () => {
      const disconnect = vi.fn();
      vi.stubGlobal(
        "ResizeObserver",
        class {
          observe(): void {}
          disconnect = disconnect;
        },
      );
      const { app, root, toggle, hover, followTime, plot } = setup();
      plot.dispatchEvent(pointer("pointermove", 0.5));
      plot.dispatchEvent(pointer("pointerdown", 0.5, { pointerType: "touch" }));

      lifetime.abort();

      expect(root.isConnected).toBe(false);
      expect(toggle.isConnected).toBe(false);
      expect(document.body.classList.contains("profile-open")).toBe(false);
      expect(hover.onHover).toBeNull();
      expect(followTime).toHaveBeenLastCalledWith(null);
      expect(disconnect).toHaveBeenCalled();
      expect(
        app.map!.getCanvasContainer().querySelector(".profile-map-dot"),
      ).toBeNull();
      // The drag it was in lets go as well
      window.dispatchEvent(pointer("pointerup", 0.5, { pointerType: "touch" }));
      expect(app.replayManager.toggleReplay).not.toHaveBeenCalled();
    });

    it("takes its place in a replay that is running already", () => {
      const { root, followTime } = setup([7], { replayActive: true });

      expect(root.parentElement?.id).toBe("replay-controls-inner");
      expect(followTime).toHaveBeenCalledWith(expect.any(Function));
    });

    it("leaves the replay panel's height to the panel", () => {
      let measure: () => void = () => {};
      vi.stubGlobal(
        "ResizeObserver",
        class {
          constructor(callback: () => void) {
            measure = callback;
          }
          observe(): void {}
          disconnect(): void {}
        },
      );
      const { app } = setup();
      app.replayManager.toggleReplay();
      const panel = document.getElementById("replay-controls")!;

      // The panel follows its own height, the strip in it included (see
      // followPanelHeight): measured here as well, it forced a layout on
      // every change of the selection
      Object.defineProperty(panel, "offsetHeight", { value: 150 });
      measure();

      expect(
        document.body.style.getPropertyValue(REPLAY_PANEL_HEIGHT_VAR),
      ).toBe("");
    });
  });

  describe("the toggle", () => {
    it("puts the strip away and brings it back, and remembers", () => {
      const { root, toggle } = setup();

      toggle.click();
      expect(root.hidden).toBe(true);
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      expect(toggle.title).toBe("Show the altitude profile");
      expect(localStorage.getItem(PROFILE_STORAGE_KEY)).toBe("1");

      toggle.click();
      expect(root.hidden).toBe(false);
      expect(toggle.title).toBe("Hide the altitude profile");
      expect(localStorage.getItem(PROFILE_STORAGE_KEY)).toBeNull();
    });

    it("starts put away where it was left so", () => {
      localStorage.setItem(PROFILE_STORAGE_KEY, "1");
      const { root, toggle } = setup();

      expect(root.hidden).toBe(true);
      expect(toggle.hidden).toBe(false);
    });

    it("works without storage", () => {
      vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
        throw new Error("denied");
      });
      vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new Error("denied");
      });
      const { root, toggle } = setup();
      expect(root.hidden).toBe(false);

      toggle.click();
      expect(root.hidden).toBe(true);
    });
  });

  describe("pointing", () => {
    it("reads out the values under the pointer and marks the map", () => {
      const { app, root, plot } = setup();

      // Half way: between segment 4 at 1,200 ft and segment 5 at 3,000
      plot.dispatchEvent(pointer("pointermove", 0.5));

      expect(text(root, ".profile-readout")).toBe(
        "2,100 ft · 1,800 ft AGL · 90 kt · 4:30",
      );
      const cursor = cursorOf(root, "hover");
      expect(cursor.getAttribute("visibility")).toBe("visible");
      expect(cursor.getAttribute("x1")).toBe("500.0");
      const dot = root.querySelector<HTMLElement>(".profile-dot")!;
      expect(dot.hidden).toBe(false);
      expect(dot.style.left).toBe("50%");
      const container = app.map!.getCanvasContainer();
      const mapDot = container.querySelector(".profile-map-dot");
      expect(mapDot).not.toBeNull();
      // Moved as the pointer goes on, not taken off the map and put on anew
      const changes = new MutationObserver(() => {});
      changes.observe(container, { childList: true, subtree: true });
      plot.dispatchEvent(pointer("pointermove", 0.6));
      plot.dispatchEvent(pointer("pointermove", 0.7));
      expect(changes.takeRecords()).toHaveLength(0);
      changes.disconnect();
      expect(container.querySelector(".profile-map-dot")).toBe(mapDot);

      plot.dispatchEvent(pointer("pointerleave", 0.5));
      expect(text(root, ".profile-readout")).toBe("");
      expect(dot.hidden).toBe(true);
      expect(cursor.getAttribute("visibility")).toBe("hidden");
      expect(
        app.map!.getCanvasContainer().querySelector(".profile-map-dot"),
      ).toBeNull();
    });

    it("leaves the groundspeed out where there is none", () => {
      const { root, plot } = setup();

      plot.dispatchEvent(pointer("pointermove", 1));

      expect(text(root, ".profile-readout")).toBe("300 ft · 0 ft AGL · 9:00");
    });

    it("lifts the mark in the 3D view", () => {
      const { app, plot } = setup();
      app.threeDVisible = true;
      app.map!.setZoom(14);

      plot.dispatchEvent(pointer("pointermove", 0.5));

      expect(
        app.map!.getCanvasContainer().querySelector(".profile-map-dot"),
      ).not.toBeNull();
    });

    it("does not read a pointer that does not hover", () => {
      const { root, plot } = setup();

      plot.dispatchEvent(pointer("pointermove", 0.5, { pointerType: "touch" }));

      expect(text(root, ".profile-readout")).toBe("");
    });

    it("follows the pointer on the flight on the map", () => {
      const { root, hover, segments, app } = setup();

      hover.onHover!(segments[4]!);
      expect(cursorOf(root, "hover").getAttribute("x1")).toBe("500.0");
      expect(text(root, ".profile-readout")).toContain("2,100 ft");
      // The pointer is on the map already
      expect(
        app.map!.getCanvasContainer().querySelector(".profile-map-dot"),
      ).toBeNull();

      hover.onHover!(null);
      expect(text(root, ".profile-readout")).toBe("");

      hover.onHover!(segments[4]!);
      // Another flight's segment
      hover.onHover!(segments[14]!);
      expect(text(root, ".profile-readout")).toBe("");
    });

    it("ignores the map while the strip is away", () => {
      const { root, hover, segments, toggle } = setup();
      toggle.click();

      hover.onHover!(segments[4]!);

      expect(text(root, ".profile-readout")).toBe("");
    });
  });

  describe("into replay", () => {
    it("opens replay paused at the moment pressed", () => {
      const { app, root, plot, followTime } = setup();

      plot.dispatchEvent(pointer("pointerdown", 0.5));

      // Where the map is, and at the replay's own time of that point
      expect(app.replayManager.toggleReplay).toHaveBeenCalledWith(false);
      expect(app.replayManager.seekReplay).toHaveBeenLastCalledWith("540");
      expect(app.replayManager.playReplay).not.toHaveBeenCalled();
      // The strip is the panel's scrubber now
      expect(root.parentElement?.id).toBe("replay-controls-inner");
      expect(root.nextElementSibling?.id).toBe("replay-slider-container");
      expect(
        document
          .getElementById("replay-controls")!
          .classList.contains("has-profile"),
      ).toBe(true);
      expect(document.body.classList.contains("profile-open")).toBe(false);
      expect(followTime).toHaveBeenCalledWith(expect.any(Function));

      // Dragging seeks on; the airplane marks the place, not a dot
      window.dispatchEvent(pointer("pointermove", 0.75));
      expect(app.replayManager.seekReplay).toHaveBeenLastCalledWith("810");
      expect(
        app.map!.getCanvasContainer().querySelector(".profile-map-dot"),
      ).toBeNull();

      window.dispatchEvent(pointer("pointerup", 0.75));
      app.replayManager.seekReplay.mockClear();
      window.dispatchEvent(pointer("pointermove", 0.25));
      expect(app.replayManager.seekReplay).not.toHaveBeenCalled();
    });

    it("keeps its cursor on the replay's time", () => {
      const { app, root, followTime } = setup();
      app.replayManager.toggleReplay();
      const follow = followTime.mock.calls[0]![0] as (
        state: typeof app.replayState,
      ) => void;

      app.replayState.currentTime = 540;
      follow(app.replayState);

      const cursor = cursorOf(root, "cursor");
      expect(cursor.getAttribute("visibility")).toBe("visible");
      expect(cursor.getAttribute("x1")).toBe("500.0");

      // Segments that are not the profile's: by the time alone
      app.replayState.segments = app.replayState.segments.slice(1);
      app.replayState.currentTime = 270;
      follow(app.replayState);
      expect(cursor.getAttribute("x1")).toBe("500.0");
    });

    it("goes back to its own place as replay closes", () => {
      const { app, root, followTime } = setup();
      app.replayManager.toggleReplay();

      app.replayActive = false;

      expect(root.parentElement).toBe(document.body);
      expect(followTime).toHaveBeenLastCalledWith(null);
      expect(cursorOf(root, "cursor").getAttribute("visibility")).toBe(
        "hidden",
      );
      expect(
        document
          .getElementById("replay-controls")!
          .classList.contains("has-profile"),
      ).toBe(false);
      expect(document.body.classList.contains("profile-open")).toBe(true);
    });

    it("stays out of the replay of every flight", () => {
      let measure: () => void = () => {};
      vi.stubGlobal(
        "ResizeObserver",
        class {
          constructor(callback: () => void) {
            measure = callback;
          }
          observe(): void {}
          disconnect(): void {}
        },
      );
      const { app, root, plot, toggle, hover, followTime } = setup();
      document.body.style.setProperty(REPLAY_PANEL_HEIGHT_VAR, "60px");

      app.replayState.all = true;
      app.replayActive = true;
      measure();

      // Not in the panel of one flight's replay, nor over the one of all
      expect(root.hidden).toBe(true);
      expect(toggle.hidden).toBe(true);
      expect(root.parentElement).toBe(document.body);
      expect(document.body.classList.contains("profile-open")).toBe(false);
      expect(
        document
          .getElementById("replay-controls")!
          .classList.contains("has-profile"),
      ).toBe(false);
      expect(followTime).not.toHaveBeenCalledWith(expect.any(Function));
      // The replay of all measured its own panel
      expect(
        document.body.style.getPropertyValue(REPLAY_PANEL_HEIGHT_VAR),
      ).toBe("60px");
      // Nor does it read the map or open the replay of one flight
      hover.onHover?.(app.currentData!.path_segments[3]!);
      expect(text(root, ".profile-readout")).toBe("");
      plot.dispatchEvent(pointer("pointerdown", 0.5));
      window.dispatchEvent(pointer("pointerup", 0.5));
      expect(app.replayManager.toggleReplay).not.toHaveBeenCalled();
      expect(app.replayManager.seekReplay).not.toHaveBeenCalled();

      app.replayState.all = false;
      app.replayActive = false;

      expect(root.hidden).toBe(false);
      expect(toggle.hidden).toBe(false);
      expect(document.body.classList.contains("profile-open")).toBe(true);
    });

    it("steps aside while the cross-section has the bottom of the map", () => {
      const { app, root, toggle } = setup();
      expect(root.hidden).toBe(false);

      toggleCrossSection(asMapApp(app));

      expect(root.hidden).toBe(true);
      expect(toggle.hidden).toBe(true);
      expect(document.body.classList.contains("profile-open")).toBe(false);

      toggleCrossSection(asMapApp(app));

      expect(root.hidden).toBe(false);
      expect(toggle.hidden).toBe(false);
    });

    it("gives the slider back when put away during replay", () => {
      const { app, toggle } = setup();
      app.replayManager.toggleReplay();

      toggle.click();

      expect(
        document
          .getElementById("replay-controls")!
          .classList.contains("has-profile"),
      ).toBe(false);
    });

    it("reads with a finger, and opens replay on a tap", () => {
      const { app, root, plot } = setup();
      const touch = { pointerType: "touch" };

      plot.dispatchEvent(pointer("pointerdown", 0.5, touch));
      window.dispatchEvent(pointer("pointermove", 0.6, touch));
      expect(text(root, ".profile-readout")).not.toBe("");
      expect(
        app.map!.getCanvasContainer().querySelector(".profile-map-dot"),
      ).not.toBeNull();
      window.dispatchEvent(pointer("pointerup", 0.6, touch));
      expect(app.replayManager.toggleReplay).not.toHaveBeenCalled();

      plot.dispatchEvent(pointer("pointerdown", 0.5, touch));
      window.dispatchEvent(pointer("pointerup", 0.5, touch));
      expect(app.replayManager.toggleReplay).toHaveBeenCalledWith(false);
      expect(app.replayManager.seekReplay).toHaveBeenLastCalledWith("540");

      // During the replay a finger seeks as it drags
      plot.dispatchEvent(pointer("pointerdown", 0.5, touch));
      window.dispatchEvent(pointer("pointermove", 0.75, touch));
      expect(app.replayManager.seekReplay).toHaveBeenLastCalledWith("810");
      window.dispatchEvent(pointer("pointercancel", 0.75, touch));
    });

    it("fetches replay first when it is not there yet", async () => {
      const { app, plot } = setup();
      const manager = app.replayManager;
      (app as { replayManager: unknown }).replayManager = undefined;

      plot.dispatchEvent(pointer("pointerdown", 0.5));
      window.dispatchEvent(pointer("pointerup", 0.5));

      await vi.waitFor(() =>
        expect(manager.seekReplay).toHaveBeenCalledWith("540"),
      );
    });

    it("does not open replay for a flight without times", () => {
      const { app, plot } = setup([8]);

      plot.dispatchEvent(pointer("pointerdown", 0.5));
      window.dispatchEvent(pointer("pointerup", 0.5));

      expect(app.replayManager.toggleReplay).not.toHaveBeenCalled();
      expect(app.loadReplay).not.toHaveBeenCalled();
    });

    it("does not open replay where the app cannot", () => {
      const { app, plot } = setup();
      app.hasTimingData = false;

      plot.dispatchEvent(pointer("pointerdown", 0.5));

      expect(app.replayManager.toggleReplay).not.toHaveBeenCalled();
      expect(app.replayManager.seekReplay).not.toHaveBeenCalled();
      window.dispatchEvent(pointer("pointerup", 0.5));
    });

    it("does not open replay while a mode holds its control, and says why", () => {
      // The tour holds Replay; a press on the chart went round it
      const { app, plot } = setup();
      const button = document.createElement("button");
      button.id = "replay-btn";
      document.body.append(button);
      const release = holdControls(["replay-btn"], "the hotspot tour");
      const toastSpy = vi.spyOn(toast, "showToast");

      plot.dispatchEvent(pointer("pointerdown", 0.5));
      window.dispatchEvent(pointer("pointerup", 0.5));

      expect(app.replayManager.toggleReplay).not.toHaveBeenCalled();
      expect(app.replayManager.seekReplay).not.toHaveBeenCalled();
      expect(toastSpy).toHaveBeenCalledWith(
        "End the hotspot tour to change this",
      );
      release();
      button.remove();
    });

    it("stops where replay did not open", () => {
      const { app, plot } = setup();
      app.replayManager.toggleReplay.mockImplementation(() => {});

      plot.dispatchEvent(pointer("pointerdown", 0.5));

      expect(app.replayManager.seekReplay).not.toHaveBeenCalled();
      window.dispatchEvent(pointer("pointerup", 0.5));
    });

    it("seeks by the chart's own time for other segments", () => {
      const { app, plot } = setup();
      app.replayManager.toggleReplay.mockImplementation(() => {
        app.replayState.segments = [];
        app.replayActive = true;
      });

      plot.dispatchEvent(pointer("pointerdown", 0.5));

      expect(app.replayManager.seekReplay).toHaveBeenLastCalledWith("270");
      window.dispatchEvent(pointer("pointerup", 0.5));
    });

    it("puts the values away as a drag ends off the chart", () => {
      const { root, plot } = setup();

      plot.dispatchEvent(pointer("pointerdown", 0.5));
      plot.dispatchEvent(pointer("pointerup", 0.5));
      // Still over the chart
      expect(text(root, ".profile-readout")).not.toBe("");

      plot.dispatchEvent(pointer("pointerdown", 0.5));
      document.body.dispatchEvent(pointer("pointerup", 1.2));
      expect(text(root, ".profile-readout")).toBe("");

      // A finger that lifted, although the tap moved the strip away from
      // under it and it is told of no pointerleave
      const touch = { pointerType: "touch" };
      plot.dispatchEvent(pointer("pointerdown", 0.5, touch));
      expect(text(root, ".profile-readout")).not.toBe("");
      plot.dispatchEvent(pointer("pointerup", 0.5, touch));
      expect(text(root, ".profile-readout")).toBe("");
    });

    it("keeps reading while a drag leaves the chart", () => {
      const { root, plot } = setup();
      const touch = { pointerType: "touch" };

      plot.dispatchEvent(pointer("pointerdown", 0.5, touch));
      plot.dispatchEvent(pointer("pointerleave", 0.5, touch));

      expect(text(root, ".profile-readout")).not.toBe("");
      window.dispatchEvent(pointer("pointerup", 0.9, touch));
    });

    it("lets go of a drag whose flight went away", () => {
      const { app, plot } = setup();
      const touch = { pointerType: "touch" };
      plot.dispatchEvent(pointer("pointerdown", 0.5, touch));

      app.selectedPathIds.clear();
      app.store.notifyMutation("selectedPathIds");
      window.dispatchEvent(pointer("pointermove", 0.6, touch));
      window.dispatchEvent(pointer("pointerup", 0.5, touch));

      expect(app.replayManager.toggleReplay).not.toHaveBeenCalled();
    });

    it("reads the start of a chart that is not laid out", () => {
      const { root, plot } = setup();
      vi.mocked(plot.getBoundingClientRect).mockReturnValue({
        left: 0,
        width: 0,
      } as DOMRect);

      plot.dispatchEvent(pointer("pointermove", 0.5));

      expect(text(root, ".profile-readout")).toMatch(/· 0:00$/);
    });

    it("takes only the main button", () => {
      const { app, plot } = setup();

      plot.dispatchEvent(pointer("pointerdown", 0.5, { button: 2 }));

      expect(app.replayManager.toggleReplay).not.toHaveBeenCalled();
    });
  });

  describe("several flights", () => {
    /**
     * Flights 7 and 9 of a day, both timed and nine minutes long; 9 was
     * read first. Joined, 9 runs from 0 to 540 s and 7 from 572.4 s on,
     * after a gap of 3 % of the two: the chart is 1,112.4 s across.
     */
    function day(): Setup {
      const segments = [...flight(7), ...flight(9)];
      return setup([7, 9], {
        currentData: createDataset(
          [
            { id: 9, start_airport: "EDDS", end_airport: "EDTF" },
            {
              id: 7,
              start_airport: "EDTF",
              end_airport: "EDDS",
              max_altitude_ft: 3040,
            },
          ],
          segments,
        ),
      });
    }

    beforeEach(() => {
      vi.mocked(toggleSequence).mockClear();
    });

    it("draws them one after another in the order of their files", () => {
      const { root } = day();

      expect(root.hidden).toBe(false);
      const routes = [...root.querySelectorAll(".profile-leg")].map(
        (leg) => leg.textContent,
      );
      expect(routes).toEqual(["EDDS → EDTF", "EDTF → EDDS"]);
      // Each its own line, nothing drawn across the gap
      const line = root.querySelector(".profile-line")!.getAttribute("d")!;
      expect(line.match(/M/g)).toHaveLength(2);
      expect(text(root, ".profile-axis")).toBe("0:002 flights");
      // The routes are hidden over the chart, and read out with it
      expect(
        root.querySelector(".profile-plot")!.getAttribute("aria-label"),
      ).toBe(
        "Altitude over time, 2 flights: EDDS → EDTF, EDTF → EDDS, highest 3,040 ft MSL",
      );
      expect(text(root, ".profile-stats")).toContain("Highest 3,040 ft MSL");
    });

    it("reads the time into the flight pointed at, and not the gap", () => {
      const { app, root, plot, hover } = day();
      const segments = app.currentData!.path_segments;

      // 834 s into the chart, 262 s into the second flight
      plot.dispatchEvent(pointer("pointermove", 0.75));
      expect(text(root, ".profile-readout")).toMatch(/ · 4:21$/);
      // In the gap: the nearer end of a flight, the first one's
      plot.dispatchEvent(pointer("pointermove", 0.49));
      expect(text(root, ".profile-readout")).toMatch(/ · 9:00$/);

      // The middle of flight 7's fifth segment, on the map
      hover.onHover!(segments[4]!);
      expect(text(root, ".profile-readout")).toMatch(/ · 4:30$/);
      // The last of flight 9, read first: its landing, not the gap after
      hover.onHover!(segments[19]!);
      expect(text(root, ".profile-readout")).toMatch(/ · 9:00$/);
      const cursor = root.querySelector(".profile-hover")!;
      expect(Number(cursor.getAttribute("x1"))).toBeCloseTo(
        (540 / 1112.4) * 1000,
        0,
      );
    });

    it("opens the replay of them one after another at the moment pressed", () => {
      const { app, plot } = day();

      plot.dispatchEvent(pointer("pointerdown", 0.75));
      window.dispatchEvent(pointer("pointerup", 0.75));

      expect(app.replayManager.toggleReplay).not.toHaveBeenCalled();
      expect(toggleSequence).toHaveBeenCalledOnce();
      const [opened, at] = vi.mocked(toggleSequence).mock.calls[0]!;
      expect(opened).toBe(app);
      // 261.9 s into flight 7: its fifth segment, of a minute
      expect(at!.segment).toBe(app.currentData!.path_segments[4]);
      expect(at!.fraction).toBeCloseTo((834.3 - 572.4 - 240) / 60, 6);
    });
  });

  describe("several flights, one of them without times", () => {
    beforeEach(() => {
      vi.mocked(toggleSequence).mockClear();
    });

    it("opens the replay at a flight with times, along the distance", () => {
      // 7 timed, then 8 without times: the chart runs along the km
      const { app, root, plot } = setup([7, 8]);
      expect(text(root, ".profile-axis")).toBe("0 km2 flights");
      // The pointer says a click replays only over the flight with times
      plot.dispatchEvent(pointer("pointermove", 0.25));
      expect(root.classList.contains("is-timed")).toBe(true);
      plot.dispatchEvent(pointer("pointermove", 0.75));
      expect(root.classList.contains("is-timed")).toBe(false);

      // A quarter across is on flight 7, which the replay plays
      plot.dispatchEvent(pointer("pointerdown", 0.25));
      window.dispatchEvent(pointer("pointerup", 0.25));

      expect(app.replayManager.toggleReplay).not.toHaveBeenCalled();
      expect(toggleSequence).toHaveBeenCalledOnce();
      const [, at] = vi.mocked(toggleSequence).mock.calls[0]!;
      expect(at!.segment.path_id).toBe(7);
      expect(app.currentData!.path_segments).toContain(at!.segment);
    });

    it("says a flight without times has no replay, once for a drag", () => {
      const { app, plot } = setup([7, 8]);
      const toastSpy = vi.spyOn(toast, "showToast");

      plot.dispatchEvent(pointer("pointerdown", 0.75));
      window.dispatchEvent(pointer("pointermove", 0.8));
      window.dispatchEvent(pointer("pointermove", 0.9));
      window.dispatchEvent(pointer("pointerup", 0.9));

      expect(toggleSequence).not.toHaveBeenCalled();
      expect(app.replayManager.toggleReplay).not.toHaveBeenCalled();
      expect(toastSpy).toHaveBeenCalledOnce();
      expect(toastSpy).toHaveBeenCalledWith(NO_TIMES_MESSAGE);
      toastSpy.mockRestore();
    });

    it("draws one that has a profile on its own, and plays both from it", () => {
      // 9 is a stub of one segment, which has no profile
      const segments = [...flight(7), ...flight(9).slice(0, 1)];
      const { app, root, plot } = setup([7, 9], {
        currentData: createDataset([{ id: 7 }, { id: 9 }], segments),
      });

      expect(root.querySelectorAll(".profile-leg")).toHaveLength(0);
      expect(text(root, ".profile-axis")).toBe("0:009:00");

      plot.dispatchEvent(pointer("pointerdown", 0.5));
      window.dispatchEvent(pointer("pointerup", 0.5));
      // Both are selected: they play one after another, not as one
      expect(app.replayManager.toggleReplay).not.toHaveBeenCalled();
      expect(toggleSequence).toHaveBeenCalledOnce();
    });
  });

  describe("profileSegments", () => {
    it("takes the replay's segments for a flight with times", () => {
      const { app } = setup([]);
      const data = app.currentData!;

      expect(profileSegments(data, 7)).toHaveLength(10);
      expect(profileSegments(data, 8)).toHaveLength(10);
      expect(profileSegments(data, 8)[0]!.time).toBeUndefined();
    });
  });
});
