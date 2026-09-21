/**
 * ReplayManager: activation, initialization and layer handling.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ReplayManager } from "../../../../kml_heatmap/frontend/ui/replayManager";
import { REPLAY_PANEL_HEIGHT_VAR } from "../../../../kml_heatmap/frontend/ui/replayManager";
import { REPLAY_PRECONDITION_MESSAGE } from "../../../../kml_heatmap/frontend/ui/replayButton";
import {
  LIVE_REGION_DELAY_MS,
  TOAST_STATUS_ID,
} from "../../../../kml_heatmap/frontend/utils/toast";
import { MAP_LAYERS } from "../../../../kml_heatmap/frontend/utils/constants";
import type { AirportMarker } from "../../../../kml_heatmap/frontend/types";
import {
  createReplayManager,
  createReplayMockApp,
  createSegments,
  el,
  featuresOf,
  liveRegionText,
  mockAnimationFrame,
  mountReplayDom,
  replaySources,
  unmountReplayDom,
  type MockApp,
} from "./replayTestSetup";
import { createDataset, createMockApp } from "../../testHelpers";
import { domCache } from "../../../../kml_heatmap/frontend/utils/domCache";
import * as motion from "../../../../kml_heatmap/frontend/utils/motion";

vi.mock("../../../../kml_heatmap/frontend/utils/htmlGenerators", () => ({
  generateSegmentPopupHtml: vi.fn(() => "<div>popup</div>"),
}));

function toastText(): string | null {
  return document.querySelector(".toast-notification")?.textContent ?? null;
}

describe("ReplayManager activation", () => {
  let replayManager: ReplayManager;
  let mockApp: MockApp;

  beforeEach(() => {
    vi.useFakeTimers();
    mountReplayDom();
    mockAnimationFrame();
    mockApp = createReplayMockApp();
    replayManager = createReplayManager(mockApp);
  });

  afterEach(() => {
    vi.useRealTimers();
    unmountReplayDom();
    vi.restoreAllMocks();
  });

  describe("constructor", () => {
    it("initializes with default replay state", () => {
      expect(replayManager.state.active).toBe(false);
      expect(replayManager.state.playing).toBe(false);
      expect(replayManager.state.currentTime).toBe(0);
      expect(replayManager.state.maxTime).toBe(0);
      expect(replayManager.state.speed).toBe(50.0);
      expect(replayManager.state.layerActive).toBe(false);
      expect(replayManager.state.trailRuns).toEqual([]);
      expect(replayManager.state.segments).toEqual([]);
      expect(replayManager.state.airplaneMarker).toBeNull();
      expect(replayManager.state.lastDrawnIndex).toBe(-1);
      expect(replayManager.state.autoZoom).toBe(false);
    });

    it("announces the position when a slider drag ends", () => {
      replayManager.state.currentTime = 65;

      el("replay-slider").dispatchEvent(new Event("change"));

      expect(liveRegionText()).toBe("Moved to 1:05");
    });

    it("stops listening to the slider once the app is gone", () => {
      // A fresh panel, so only the manager of the ended app listens to it
      unmountReplayDom();
      domCache.clear();
      mountReplayDom();
      const lifetime = new AbortController();
      const manager = createReplayManager(
        createMockApp({ signal: lifetime.signal }),
      );
      manager.state.currentTime = 65;

      lifetime.abort();
      el("replay-slider").dispatchEvent(new Event("change"));

      expect(liveRegionText()).toBe("");
    });
  });

  describe("canReplay", () => {
    it("requires exactly one selected path with timing data", () => {
      mockApp.selectedPathIds = new Set([1]);
      expect(replayManager.canReplay()).toBe(true);

      mockApp.selectedPathIds = new Set([1, 2]);
      expect(replayManager.canReplay()).toBe(false);

      mockApp.selectedPathIds = new Set([1]);
      mockApp.hasTimingData = false;
      expect(replayManager.canReplay()).toBe(false);
    });
  });

  describe("the replay button", () => {
    it("shows availability again after the manager asks it to", () => {
      const btn = el("replay-btn") as HTMLButtonElement;
      mockApp.selectedPathIds.add(1);

      replayManager.updateReplayButtonState();

      expect(btn.style.opacity).toBe("1");
      expect(btn.title).toBe("Replay selected flight path");
    });
  });

  describe("toggleReplay", () => {
    it("returns early if replay-controls panel not found", () => {
      el("replay-controls").remove();
      mockApp.selectedPathIds = new Set([1]);

      replayManager.toggleReplay();

      expect(replayManager.state.active).toBe(false);
    });

    it("shows an explanatory toast when no path is selected", () => {
      mockApp.selectedPathIds = new Set();

      replayManager.toggleReplay();

      expect(replayManager.state.active).toBe(false);
      expect(toastText()).toBe(REPLAY_PRECONDITION_MESSAGE);
    });

    it("shows an explanatory toast when multiple paths are selected", () => {
      mockApp.selectedPathIds = new Set([1, 2]);

      replayManager.toggleReplay();

      expect(replayManager.state.active).toBe(false);
      expect(toastText()).toBe(REPLAY_PRECONDITION_MESSAGE);
    });

    it("shows an explanatory toast for a flight that takes no time", () => {
      // A single timed segment: replay would finish the moment it started
      mockApp.currentData = createDataset(
        [{ id: 1 }],
        createSegments().slice(0, 1),
      );
      mockApp.selectedPathIds = new Set([1]);

      replayManager.toggleReplay();

      expect(replayManager.state.active).toBe(false);
      expect(toastText()).toBe(REPLAY_PRECONDITION_MESSAGE);
    });

    it("refuses to initialize a flight whose times are all 0", () => {
      const segments = createSegments().map((s) => ({ ...s, time: 0 }));
      mockApp.currentData = createDataset([{ id: 1 }], segments);
      mockApp.selectedPathIds = new Set([1]);

      expect(replayManager.initializeReplay()).toBe(false);
      expect(toastText()).toBe(REPLAY_PRECONDITION_MESSAGE);
    });

    it("shows an explanatory toast when the selection has no timing data", () => {
      mockApp.selectedPathIds = new Set([1]);
      mockApp.hasTimingData = false;

      replayManager.toggleReplay();

      expect(replayManager.state.active).toBe(false);
      expect(toastText()).toBe(REPLAY_PRECONDITION_MESSAGE);
    });

    it("activates replay when exactly one path is selected", () => {
      mockApp.selectedPathIds = new Set([1]);

      replayManager.toggleReplay();

      expect(replayManager.state.active).toBe(true);
      expect(el("replay-controls").style.display).toBe("block");
      expect(document.body.classList.contains("replay-active")).toBe(true);
    });

    it("leaves persistence to the store subscription", () => {
      mockApp.selectedPathIds = new Set([1]);

      replayManager.toggleReplay();
      replayManager.toggleReplay();

      // Replay state itself is not persisted, and the layer state reaches
      // the state manager through the store
      expect(mockApp.stateManager.saveMapState).not.toHaveBeenCalled();
    });

    it("takes the speed from the select on activation", () => {
      (el("replay-speed") as HTMLSelectElement).value = "100";
      mockApp.selectedPathIds = new Set([1]);

      replayManager.toggleReplay();

      expect(replayManager.state.speed).toBe(100);
    });

    it("swaps the replay button to stop without losing its label", () => {
      mockApp.selectedPathIds = new Set([1]);

      replayManager.toggleReplay();

      const replayBtn = el("replay-btn");
      expect(replayBtn.dataset["icon"]).toBe("stop");
      expect(replayBtn.querySelectorAll("svg.icon")).toHaveLength(1);
      expect(replayBtn.querySelector(".control-label")!.textContent).toBe(
        "Replay",
      );
      expect(replayBtn.style.opacity).toBe("1");
      expect(replayBtn.getAttribute("aria-pressed")).toBe("true");
      expect(replayBtn.getAttribute("aria-label")).toBe("Stop replay");
      expect(replayBtn.title).toBe("Stop replay");
    });

    it("restores the replay button on deactivation", () => {
      mockApp.selectedPathIds = new Set([1]);
      replayManager.toggleReplay();

      replayManager.toggleReplay();

      const replayBtn = el("replay-btn");
      expect(replayBtn.dataset["icon"]).toBe("play");
      expect(replayBtn.querySelectorAll("svg.icon")).toHaveLength(1);
      expect(replayBtn.querySelector(".control-label")!.textContent).toBe(
        "Replay",
      );
      expect(replayBtn.getAttribute("aria-pressed")).toBe("false");
      expect(replayBtn.getAttribute("aria-label")).toBe(
        "Replay selected flight path",
      );
    });

    it("announces the close through the page, not the hidden panel", () => {
      mockApp.selectedPathIds = new Set([1]);
      replayManager.toggleReplay();

      replayManager.toggleReplay();

      // The panel's region is hidden with the panel and would not be read
      vi.advanceTimersByTime(LIVE_REGION_DELAY_MS);
      expect(document.getElementById(TOAST_STATUS_ID)!.textContent).toBe(
        "Replay closed",
      );
      expect(liveRegionText()).not.toBe("Replay closed");
    });

    it("hands the panel height to the stylesheet while replay is open", () => {
      mockApp.selectedPathIds = new Set([1]);
      Object.defineProperty(el("replay-controls"), "offsetHeight", {
        value: 167,
        configurable: true,
      });

      replayManager.toggleReplay();
      expect(
        document.body.style.getPropertyValue(REPLAY_PANEL_HEIGHT_VAR),
      ).toBe("167px");

      replayManager.toggleReplay();
      expect(
        document.body.style.getPropertyValue(REPLAY_PANEL_HEIGHT_VAR),
      ).toBe("");
    });

    it("syncs the auto-zoom button with the autoZoom state on activation", () => {
      mockApp.selectedPathIds = new Set([1]);
      replayManager.state.autoZoom = true;

      replayManager.toggleReplay();

      const autoZoomBtn = el("replay-autozoom-btn");
      expect(autoZoomBtn.style.opacity).toBe("1");
      expect(autoZoomBtn.getAttribute("aria-pressed")).toBe("true");
      expect(autoZoomBtn.title).toBe("Auto-zoom enabled");
    });

    it("dims the auto-zoom button when auto-zoom is off", () => {
      mockApp.selectedPathIds = new Set([1]);
      replayManager.state.autoZoom = false;

      replayManager.toggleReplay();

      const autoZoomBtn = el("replay-autozoom-btn");
      expect(autoZoomBtn.style.opacity).toBe("0.5");
      expect(autoZoomBtn.getAttribute("aria-pressed")).toBe("false");
    });

    it("hides other layers during replay activation", () => {
      mockApp.selectedPathIds = new Set([1]);
      mockApp.heatmapVisible = true;
      mockApp.altitudeVisible = true;
      mockApp.heatmapLayer.setVisible(true);
      mockApp.altitudeLayer.setVisible(true);

      replayManager.toggleReplay();

      expect(mockApp.heatmapLayer.isVisible()).toBe(false);
      expect(mockApp.altitudeLayer.isVisible()).toBe(false);
      expect(mockApp.map!.layer(MAP_LAYERS.heat).layout["visibility"]).toBe(
        "none",
      );
      // What the user had on is remembered by the store, for the restore
      expect(mockApp.heatmapVisible).toBe(true);
      expect(mockApp.altitudeVisible).toBe(true);
    });

    it("deactivates replay when already active", () => {
      mockApp.selectedPathIds = new Set([1]);
      replayManager.toggleReplay();
      expect(replayManager.state.active).toBe(true);

      replayManager.toggleReplay();

      expect(replayManager.state.active).toBe(false);
      expect(el("replay-controls").style.display).toBe("none");
      expect(document.body.classList.contains("replay-active")).toBe(false);
    });

    it("removes the airplane marker on deactivation", () => {
      mockApp.selectedPathIds = new Set([1]);
      replayManager.toggleReplay();
      const marker = replayManager.state.airplaneMarker!;
      marker.openPopup();
      const canvasContainer = mockApp.map!.getCanvasContainer();
      expect(canvasContainer.contains(marker.getElement())).toBe(true);

      replayManager.toggleReplay();

      expect(canvasContainer.contains(marker.getElement())).toBe(false);
      expect(marker.isPopupOpen()).toBe(false);
      expect(replayManager.state.airplaneMarker).toBeNull();
    });

    it("lays the dimmed route down once, when replay opens", () => {
      // Replay hides the heat bloom and the paths, so without the route the
      // map is empty ahead of the aircraft
      mockApp.selectedPathIds = new Set([1]);
      const { route, trail } = replaySources(mockApp);

      replayManager.toggleReplay();

      expect(route.setData).toHaveBeenCalledTimes(1);
      // One point per segment, plus the end of the last one; longitude first
      expect(featuresOf(route)).toHaveLength(1);
      expect(featuresOf(route)[0]!.geometry).toEqual({
        type: "LineString",
        coordinates: [
          [16.0, 48.0],
          [16.1, 48.1],
          [16.2, 48.2],
          [16.3, 48.3],
        ],
      });
      expect(featuresOf(trail)).toEqual([]);

      // Playing, seeking and stopping never touch it again
      replayManager.seekReplay("100");
      replayManager.seekReplay("20");
      replayManager.stopReplay();
      vi.advanceTimersByTime(100);
      expect(route.setData).toHaveBeenCalledTimes(1);
    });

    it("empties both replay sources on deactivation", () => {
      mockApp.selectedPathIds = new Set([1]);
      const { route, trail } = replaySources(mockApp);
      replayManager.toggleReplay();
      replayManager.seekReplay("100");
      vi.advanceTimersByTime(16);
      expect(featuresOf(trail)).toHaveLength(2);

      replayManager.toggleReplay();

      expect(replayManager.state.layerActive).toBe(false);
      expect(featuresOf(route)).toEqual([]);
      expect(featuresOf(trail)).toEqual([]);
    });

    it("drops a trail write that was still pending when replay closed", () => {
      mockApp.selectedPathIds = new Set([1]);
      const { trail } = replaySources(mockApp);
      replayManager.toggleReplay();
      replayManager.seekReplay("100");

      replayManager.toggleReplay();
      trail.setData.mockClear();
      vi.advanceTimersByTime(100);

      expect(trail.setData).not.toHaveBeenCalled();
      expect(featuresOf(trail)).toEqual([]);
    });

    it("restores layer visibility on deactivation", () => {
      mockApp.selectedPathIds = new Set([1]);
      mockApp.heatmapVisible = true;

      replayManager.toggleReplay();
      replayManager.toggleReplay();

      // The data manager adds it, with the points of the filter changes
      // made during the replay and the dimming its new canvas has lost
      expect(mockApp.dataManager.showHeatmap).toHaveBeenCalledTimes(1);
    });

    it("leaves the colour layers off when neither was on before replay", () => {
      mockApp.selectedPathIds = new Set([1]);
      mockApp.altitudeVisible = false;
      mockApp.airspeedVisible = false;

      replayManager.toggleReplay();
      replayManager.toggleReplay();
      vi.advanceTimersByTime(500);

      // Closing replay used to switch the altitude layer on unasked
      expect(mockApp.altitudeVisible).toBe(false);
      expect(el("altitude-btn").getAttribute("aria-pressed")).toBe("false");
      expect(el("altitude-legend").style.display).toBe("none");
      expect(mockApp.altitudeLayer.isVisible()).toBe(false);
      expect(mockApp.layerManager.redrawAltitudePaths).not.toHaveBeenCalled();
    });

    it("shows the altitude scale for the trail while neither layer is on", () => {
      mockApp.selectedPathIds = new Set([1]);
      mockApp.altitudeVisible = false;
      mockApp.airspeedVisible = false;

      replayManager.toggleReplay();

      // The trail is drawn in altitude colours, so its scale is shown
      expect(el("altitude-legend").style.display).toBe("block");
      expect(el("airspeed-legend").style.display).toBe("none");
    });

    it("moves the trail's scale along when a colour layer is toggled", () => {
      mockApp.selectedPathIds = new Set([1]);
      mockApp.altitudeVisible = false;
      mockApp.airspeedVisible = false;
      replayManager.toggleReplay();

      // Speed switched on during replay colours the trail by speed: its
      // scale replaces the altitude one instead of stacking on top of it
      mockApp.airspeedVisible = true;
      expect(el("altitude-legend").style.display).toBe("none");
      expect(el("airspeed-legend").style.display).toBe("block");

      // And back off, the trail is coloured by altitude again
      mockApp.airspeedVisible = false;
      expect(el("altitude-legend").style.display).toBe("block");
      expect(el("airspeed-legend").style.display).toBe("none");
    });

    it("stops following the colour layers once replay is closed", () => {
      mockApp.selectedPathIds = new Set([1]);
      mockApp.altitudeVisible = false;
      mockApp.airspeedVisible = false;
      replayManager.toggleReplay();
      replayManager.toggleReplay();

      // Only the store's own sync, which never touches the altitude legend
      // for the speed key, is left to react
      el("altitude-legend").style.display = "block";
      mockApp.airspeedVisible = true;
      expect(el("altitude-legend").style.display).toBe("block");
    });

    it("closes a popup left open on the map", () => {
      mockApp.selectedPathIds = new Set([1]);

      const airport = (open: boolean) =>
        ({
          isPopupOpen: vi.fn(() => open),
          closePopup: vi.fn(),
        }) as unknown as AirportMarker;
      const open = airport(true);
      const closed = airport(false);
      mockApp.airportMarkers["EDDF"] = open;
      mockApp.airportMarkers["LOWW"] = closed;

      replayManager.toggleReplay();

      // A path tapped on a phone left its popup over the replay controls
      expect(mockApp.layerManager.closeSegmentPopup).toHaveBeenCalledTimes(1);
      // So did an airport
      expect(open.closePopup).toHaveBeenCalledTimes(1);
      expect(closed.closePopup).not.toHaveBeenCalled();
    });

    it("leaves the legends to the layers when the speed layer colours the trail", () => {
      mockApp.selectedPathIds = new Set([1]);
      mockApp.altitudeVisible = false;
      mockApp.airspeedVisible = true;

      replayManager.toggleReplay();

      expect(el("altitude-legend").style.display).toBe("none");
      expect(el("airspeed-legend").style.display).toBe("block");
    });

    it("redraws altitude paths exactly once after deactivation", () => {
      mockApp.selectedPathIds = new Set([1]);
      mockApp.altitudeVisible = true;
      mockApp.airspeedVisible = false;

      replayManager.toggleReplay();
      replayManager.toggleReplay();
      vi.advanceTimersByTime(500);

      expect(mockApp.layerManager.redrawAltitudePaths).toHaveBeenCalledTimes(1);
      expect(mockApp.map!.resize).toHaveBeenCalled();
    });

    it("redraws airspeed paths once after deactivation when airspeed was visible", () => {
      mockApp.selectedPathIds = new Set([1]);
      mockApp.altitudeVisible = false;
      mockApp.airspeedVisible = true;

      replayManager.toggleReplay();
      replayManager.toggleReplay();
      vi.advanceTimersByTime(500);

      expect(mockApp.layerManager.redrawAirspeedPaths).toHaveBeenCalledTimes(1);
      expect(mockApp.layerManager.redrawAltitudePaths).not.toHaveBeenCalled();
      expect(mockApp.altitudeVisible).toBe(false);
    });

    it("drops a pending redraw when replay is closed again before it runs", () => {
      mockApp.selectedPathIds = new Set([1]);
      mockApp.altitudeVisible = true;

      replayManager.toggleReplay();
      replayManager.toggleReplay();
      replayManager.toggleReplay();
      replayManager.toggleReplay();
      vi.advanceTimersByTime(500);

      // Two closes, but the first redraw was still pending when the second
      // close scheduled its own
      expect(mockApp.layerManager.redrawAltitudePaths).toHaveBeenCalledTimes(1);
    });

    it("cancels pending redraws and the frame loop on destroy", () => {
      mockApp.selectedPathIds = new Set([1]);
      mockApp.altitudeVisible = true;
      replayManager.toggleReplay();
      replayManager.playReplay();
      replayManager.toggleReplay();

      replayManager.destroy();
      vi.advanceTimersByTime(500);

      expect(mockApp.layerManager.redrawAltitudePaths).not.toHaveBeenCalled();
      expect(replayManager.state.animationFrameId).toBeNull();
    });
  });

  describe("replay chrome", () => {
    function activate(): HTMLElement {
      mockApp.selectedPathIds = new Set([1]);
      replayManager.toggleReplay();
      return el("replay-controls");
    }

    it("adds an exit control away from the transport controls", () => {
      const panel = activate();

      const exit = panel.querySelector<HTMLButtonElement>(".replay-exit")!;
      expect(exit).not.toBeNull();
      // First child so it lands in the top corner, not next to play/stop
      expect(panel.firstElementChild).toBe(exit);
      expect(exit.getAttribute("aria-label")).toBe("Close replay");
    });

    it("closes replay from the exit control", () => {
      const panel = activate();

      panel.querySelector<HTMLButtonElement>(".replay-exit")!.click();

      expect(replayManager.state.active).toBe(false);
      expect(panel.style.display).toBe("none");
    });

    it("adds a readout strip that is not a live region", () => {
      const panel = activate();

      const readout = panel.querySelector<HTMLElement>(".replay-readout")!;
      expect(
        Array.from(readout.querySelectorAll(".replay-readout-label")).map(
          (cell) => cell.textContent,
        ),
      ).toEqual(["Altitude", "Groundspeed", "Track"]);
      // The frame loop writes this many times a second
      expect(readout.getAttribute("aria-live")).toBeNull();
      expect(readout.closest("[aria-live]")).toBeNull();
    });

    it("keeps the readout beside the live region, never inside it", () => {
      const panel = activate();

      const live = el("replay-live");
      // The assertion above is only worth anything while this holds
      expect(live.getAttribute("aria-live")).toBe("polite");

      const readout = panel.querySelector<HTMLElement>(".replay-readout")!;
      expect(live.contains(readout)).toBe(false);
      expect(readout.parentElement).toBe(el("replay-controls-inner"));
    });

    it("fills the readout on the first activation", () => {
      // The chrome has to exist before initializeReplay() writes to it, or
      // the strip shows placeholder dashes for the whole first replay
      mockApp.selectedPathIds = new Set([1]);
      replayManager.toggleReplay();

      expect(el("replay-readout-altitude").textContent).toBe("3,000 ft");
    });

    it("moves focus into the panel and back out again", () => {
      const panel = activate();

      const exit = panel.querySelector<HTMLButtonElement>(".replay-exit")!;
      expect(document.activeElement).toBe(exit);

      // Closing hides the panel the focused control lives in; without a
      // hand-off focus would drop to <body>
      exit.click();

      expect(document.activeElement).toBe(el("replay-btn"));
    });

    it("reports the values of the current position", () => {
      activate();

      replayManager.state.currentTime = 65;
      replayManager.updateReplayDisplay();

      expect(el("replay-readout-altitude").textContent).toBe("4,000 ft");
      expect(el("replay-readout-speed").textContent).toBe("120 kt");
      expect(el("replay-readout-track").textContent).toMatch(/^\d{3}°$/);
      // Both unit systems, as on every other surface
      expect(el("replay-readout-altitude-alt").textContent).toBe("1,219 m");
      expect(el("replay-readout-speed-alt").textContent).toBe("222 km/h");
    });

    it("shows placeholders before the first segment", () => {
      activate();

      replayManager.state.currentTime = -1;
      replayManager.updateReplayDisplay();

      expect(el("replay-readout-altitude").textContent).toBe("—");
      expect(el("replay-readout-track").textContent).toBe("—");
    });

    it("builds the chrome once across activations", () => {
      const panel = activate();
      replayManager.toggleReplay();
      replayManager.toggleReplay();

      expect(panel.querySelectorAll(".replay-exit")).toHaveLength(1);
      expect(panel.querySelectorAll(".replay-readout")).toHaveLength(1);
    });
  });

  describe("initializeReplay", () => {
    it("returns false and shows toast if no data is loaded", () => {
      mockApp.currentData = null;
      mockApp.selectedPathIds = new Set([1]);

      const result = replayManager.initializeReplay();

      expect(result).toBe(false);
      const toast = document.querySelector(".toast-notification");
      expect(toast).not.toBeNull();
      expect(toast!.classList.contains("toast-error")).toBe(true);
    });

    it("returns false when no path is selected", () => {
      mockApp.selectedPathIds = new Set();

      expect(replayManager.initializeReplay()).toBe(false);
      expect(toastText()).toBeNull();
    });

    it("returns false with a toast if no segments match the selected path", () => {
      mockApp.selectedPathIds = new Set([999]);

      const result = replayManager.initializeReplay();

      expect(result).toBe(false);
      expect(toastText()).toBe(REPLAY_PRECONDITION_MESSAGE);
    });

    it("filters segments by selected path id", () => {
      mockApp.selectedPathIds = new Set([1]);
      mockApp.currentData!.path_segments.push({
        path_id: 2,
        coords: [
          [49.0, 17.0],
          [49.1, 17.1],
        ],
        time: 10,
      });

      replayManager.initializeReplay();

      expect(replayManager.state.segments.length).toBe(3);
      expect(replayManager.state.segments.every((s) => s.path_id === 1)).toBe(
        true,
      );
    });

    it("ignores segments without timing data", () => {
      mockApp.selectedPathIds = new Set([1]);
      mockApp.currentData!.path_segments.push({
        path_id: 1,
        coords: [
          [48.3, 16.3],
          [48.4, 16.4],
        ],
      });

      replayManager.initializeReplay();

      expect(replayManager.state.segments.length).toBe(3);
    });

    it("sorts segments by time", () => {
      mockApp.selectedPathIds = new Set([1]);
      mockApp.currentData!.path_segments.push({
        path_id: 1,
        coords: [
          [48.4, 16.4],
          [48.5, 16.5],
        ],
        altitude_ft: 2000,
        time: -10,
      });

      replayManager.initializeReplay();

      expect(replayManager.state.segments[0]!.time).toBe(-10);
      expect(replayManager.state.segments.map((s) => s.time)).toEqual([
        -10, 0, 60, 120,
      ]);
    });

    it("calculates the colour ranges from the path's own segments", () => {
      mockApp.selectedPathIds = new Set([1]);
      // Another path's segments must not widen the ranges
      mockApp.currentData = createDataset(
        [{ id: 1 }, { id: 2 }],
        [
          ...createSegments(),
          {
            path_id: 2,
            coords: [
              [49.0, 17.0],
              [49.1, 17.1],
            ],
            altitude_ft: 9000,
            groundspeed_knots: 200,
            time: 0,
          },
        ],
      );

      replayManager.initializeReplay();

      expect(replayManager.state.colorMinAlt).toBe(3000);
      expect(replayManager.state.colorMaxAlt).toBe(5000);
      expect(replayManager.state.colorMinSpeed).toBe(100);
      expect(replayManager.state.colorMaxSpeed).toBe(130);
    });

    it("uses the app's airspeed range when the path has no groundspeeds", () => {
      mockApp.selectedPathIds = new Set([1]);
      mockApp.currentData = createDataset(
        [{ id: 1 }],
        createSegments().map((seg) => ({ ...seg, groundspeed_knots: 0 })),
      );

      replayManager.initializeReplay();

      expect(replayManager.state.colorMinSpeed).toBe(mockApp.airspeedRange.min);
      expect(replayManager.state.colorMaxSpeed).toBe(mockApp.airspeedRange.max);
    });

    it("sets replayMaxTime from last segment and updates the slider", () => {
      mockApp.selectedPathIds = new Set([1]);

      replayManager.initializeReplay();

      expect(replayManager.state.maxTime).toBe(120);
      const slider = el("replay-slider") as HTMLInputElement;
      expect(slider.max).toBe("120");
      expect(el("replay-slider-end").textContent).toBe("2:00");
      expect(slider.getAttribute("aria-valuetext")).toBe("0:00 of 2:00");
    });

    it("sets the replay layer up with the route and an empty trail", () => {
      mockApp.selectedPathIds = new Set([1]);

      replayManager.initializeReplay();

      expect(replayManager.state.layerActive).toBe(true);
      expect(featuresOf(replaySources(mockApp).route)).toHaveLength(1);
      expect(featuresOf(replaySources(mockApp).trail)).toEqual([]);
    });

    it("creates an accessible airplane marker at the first segment", () => {
      mockApp.selectedPathIds = new Set([1]);

      replayManager.initializeReplay();

      const airplane = replayManager.state.airplaneMarker!;
      expect(airplane.getLatLng()).toEqual([48.0, 16.0]);
      const button = airplane.getElement();
      expect(button.tagName).toBe("BUTTON");
      expect(button.getAttribute("aria-label")).toBe("Aircraft position");
      expect(button.classList.contains("replay-airplane-root")).toBe(true);
      expect(button.querySelector(".replay-airplane-icon")).not.toBeNull();
      expect(mockApp.map!.getCanvasContainer().contains(button)).toBe(true);
    });

    it("leaves the replay sources alone when there is no start to fly from", () => {
      mockApp.selectedPathIds = new Set([1]);
      mockApp.currentData = createDataset(
        [{ id: 1 }],
        [
          { path_id: 1, time: 0 },
          { path_id: 1, time: 10 },
        ],
      );

      expect(replayManager.initializeReplay()).toBe(false);
      expect(replayManager.state.layerActive).toBe(false);
      expect(replaySources(mockApp).route.setData).not.toHaveBeenCalled();
    });

    it("returns false when the first segment has no coordinates", () => {
      mockApp.selectedPathIds = new Set([1]);
      mockApp.currentData = createDataset(
        [{ id: 1 }],
        [{ path_id: 1, time: 0 }],
      );

      expect(replayManager.initializeReplay()).toBe(false);
    });

    it("resets replay state on initialization", () => {
      mockApp.selectedPathIds = new Set([1]);
      replayManager.state.currentTime = 50;
      replayManager.state.lastDrawnIndex = 5;
      replayManager.state.lastBearing = 180;

      replayManager.initializeReplay();

      expect(replayManager.state.currentTime).toBe(0);
      expect(replayManager.state.lastDrawnIndex).toBe(-1);
      // The initial display update recomputes the heading for the start position
      expect(replayManager.state.lastBearing).not.toBe(180);
      expect(typeof replayManager.state.lastBearing).toBe("number");
    });

    it("sets initial zoom when autoZoom is enabled", () => {
      mockApp.selectedPathIds = new Set([1]);
      replayManager.state.autoZoom = true;

      replayManager.initializeReplay();

      // The follow zoom in map units (16 under Leaflet); 0.8 s in ms
      expect(mockApp.map!.easeTo).toHaveBeenCalledWith({
        center: [16.0, 48.0],
        zoom: 15,
        duration: 800,
        animate: true,
      });
    });

    it("moves to the start without animation for reduced motion", () => {
      vi.spyOn(motion, "prefersReducedMotion").mockReturnValue(true);
      mockApp.selectedPathIds = new Set([1]);

      replayManager.initializeReplay();
      replayManager.state.autoZoom = true;
      replayManager.initializeReplay();

      const moves = mockApp.map!.easeTo.mock.calls.map(([options]) => options);
      expect(moves).toHaveLength(2);
      expect(moves[0]).toMatchObject({ center: [16.0, 48.0], animate: false });
      expect(moves[0]).not.toHaveProperty("zoom");
      expect(moves[1]).toMatchObject({
        center: [16.0, 48.0],
        zoom: 15,
        animate: false,
      });
    });

    it("pans to start position without changing zoom when autoZoom is disabled", () => {
      mockApp.selectedPathIds = new Set([1]);
      replayManager.state.autoZoom = false;

      replayManager.initializeReplay();

      expect(mockApp.map!.easeTo).toHaveBeenCalledTimes(1);
      expect(mockApp.map!.easeTo).toHaveBeenCalledWith({
        center: [16.0, 48.0],
        duration: 800,
        animate: true,
      });
    });

    it("updates altitude and airspeed legends with the replay ranges", () => {
      mockApp.selectedPathIds = new Set([1]);

      replayManager.initializeReplay();

      expect(mockApp.layerManager.updateAltitudeLegend).toHaveBeenCalledWith(
        3000,
        5000,
      );
      expect(mockApp.layerManager.updateAirspeedLegend).toHaveBeenCalledWith(
        100,
        130,
      );
    });

    it("removes old airplane marker if it exists before creating new one", () => {
      mockApp.selectedPathIds = new Set([1]);

      replayManager.initializeReplay();
      const firstMarker = replayManager.state.airplaneMarker!;

      replayManager.initializeReplay();

      expect(
        mockApp.map!.getCanvasContainer().contains(firstMarker.getElement()),
      ).toBe(false);
      expect(replayManager.state.airplaneMarker).not.toBe(firstMarker);
      expect(
        mockApp
          .map!.getCanvasContainer()
          .querySelectorAll(".replay-airplane-root"),
      ).toHaveLength(1);
    });

    it("returns true on success", () => {
      mockApp.selectedPathIds = new Set([1]);

      expect(replayManager.initializeReplay()).toBe(true);
    });
  });

  describe("toggleAutoZoom", () => {
    /** A replay in progress, with the aircraft away from the start */
    function replayInProgress(
      position: [number, number] = [47.5, 15.5],
    ): [number, number] {
      mockApp.selectedPathIds = new Set([1]);
      replayManager.initializeReplay();
      replayManager.state.autoZoom = false;
      replayManager.state.airplaneMarker!.setLatLng(position);
      mockApp.map!.easeTo.mockClear();
      return position;
    }

    it("goes to the aircraft at the follow zoom when switched on", () => {
      // The renderer only ever zooms out, so without this the control did
      // nothing to the map until the flight left the viewport
      const [lat, lon] = replayInProgress();

      replayManager.toggleAutoZoom();

      expect(mockApp.map!.easeTo).toHaveBeenCalledWith({
        center: [lon, lat],
        zoom: 15,
        duration: 800,
        animate: true,
      });
    });

    it("arrives where a replay that started with it on would be", () => {
      // Same zoom as initializeReplay uses, so the two agree
      const zoomOfFirstMove = (): unknown =>
        (mockApp.map!.easeTo.mock.calls[0]?.[0] as { zoom?: number }).zoom;

      replayInProgress();
      replayManager.toggleAutoZoom();
      const switchedOn = zoomOfFirstMove();
      expect(switchedOn).toBeTypeOf("number");

      replayManager.state.autoZoom = true;
      mockApp.map!.easeTo.mockClear();
      replayManager.initializeReplay();

      expect(switchedOn).toBe(zoomOfFirstMove());
    });

    it("leaves the map alone when switched off", () => {
      replayInProgress();
      replayManager.toggleAutoZoom();
      mockApp.map!.easeTo.mockClear();

      replayManager.toggleAutoZoom();

      expect(replayManager.state.autoZoom).toBe(false);
      expect(mockApp.map!.easeTo).not.toHaveBeenCalled();
    });

    it("does not animate for reduced motion", () => {
      replayInProgress();
      vi.spyOn(motion, "prefersReducedMotion").mockReturnValue(true);

      replayManager.toggleAutoZoom();

      expect(mockApp.map!.easeTo).toHaveBeenCalledWith(
        expect.objectContaining({ zoom: 15, animate: false }),
      );
    });

    it("does nothing without an aircraft on the map", () => {
      mockApp.selectedPathIds = new Set([1]);
      replayManager.state.airplaneMarker = null;

      replayManager.toggleAutoZoom();

      expect(replayManager.state.autoZoom).toBe(true);
      expect(mockApp.map!.easeTo).not.toHaveBeenCalled();
    });
  });

  describe("hideOtherLayersDuringReplay", () => {
    it("does nothing without a map", () => {
      mockApp.map = null;
      mockApp.heatmapVisible = true;

      replayManager.hideOtherLayersDuringReplay();

      expect(mockApp.heatmapLayer.setVisible).not.toHaveBeenCalled();
      expect((el("year-select") as HTMLSelectElement).disabled).toBe(false);
    });

    it("hides heatmap when visible", () => {
      mockApp.heatmapVisible = true;

      mockApp.heatmapLayer.setVisible(true);

      replayManager.hideOtherLayersDuringReplay();

      expect(mockApp.heatmapLayer.setVisible).toHaveBeenLastCalledWith(false);
      expect(mockApp.map!.layer(MAP_LAYERS.heat).layout["visibility"]).toBe(
        "none",
      );
    });

    it("does not hide heatmap when not visible", () => {
      mockApp.heatmapVisible = false;

      replayManager.hideOtherLayersDuringReplay();

      expect(mockApp.heatmapLayer.setVisible).not.toHaveBeenCalled();
    });

    it("leaves the airports and the aviation chart the way they are", () => {
      mockApp.aviationLayer.setVisible(true);
      mockApp.aviationLayer.setVisible.mockClear();

      replayManager.hideOtherLayersDuringReplay();

      expect(mockApp.airportLayer.setVisible).not.toHaveBeenCalled();
      expect(mockApp.aviationLayer.setVisible).not.toHaveBeenCalled();
      expect(mockApp.airportLayer.isVisible()).toBe(true);
    });

    it("hides altitude layer when visible", () => {
      mockApp.altitudeVisible = true;

      mockApp.altitudeLayer.setVisible(true);

      replayManager.hideOtherLayersDuringReplay();

      expect(mockApp.altitudeLayer.isVisible()).toBe(false);
      // The main layer and the one the selection is drawn on
      for (const id of [
        MAP_LAYERS.pathsAltitude,
        MAP_LAYERS.pathsAltitudeSelected,
      ]) {
        expect(mockApp.map!.layer(id).layout["visibility"]).toBe("none");
      }
      expect(mockApp.airspeedLayer.setVisible).not.toHaveBeenCalled();
    });

    it("hides airspeed layer when visible", () => {
      mockApp.airspeedVisible = true;

      mockApp.airspeedLayer.setVisible(true);

      replayManager.hideOtherLayersDuringReplay();

      expect(mockApp.airspeedLayer.isVisible()).toBe(false);
      expect(
        mockApp.map!.layer(MAP_LAYERS.pathsAirspeed).layout["visibility"],
      ).toBe("none");
    });

    it("disables layer buttons and filters during replay", () => {
      replayManager.hideOtherLayersDuringReplay();

      expect((el("heatmap-btn") as HTMLButtonElement).disabled).toBe(true);
      expect((el("airports-btn") as HTMLButtonElement).disabled).toBe(true);
      expect((el("aviation-btn") as HTMLButtonElement).disabled).toBe(true);
      expect((el("year-select") as HTMLSelectElement).disabled).toBe(true);
      expect((el("aircraft-select") as HTMLSelectElement).disabled).toBe(true);
    });

    it("disables the controls that would change the selection", () => {
      // Clearing it dimmed the running replay's Stop button and switched
      // the statistics to another view
      replayManager.hideOtherLayersDuringReplay();

      expect((el("isolate-btn") as HTMLButtonElement).disabled).toBe(true);
      expect((el("selection-clear-btn") as HTMLButtonElement).disabled).toBe(
        true,
      );

      replayManager.restoreLayerVisibility();

      expect((el("isolate-btn") as HTMLButtonElement).disabled).toBe(false);
      expect((el("selection-clear-btn") as HTMLButtonElement).disabled).toBe(
        false,
      );
    });

    it("disables Wrapped, which would take the map away from the replay", () => {
      replayManager.hideOtherLayersDuringReplay();

      expect((el("wrapped-btn") as HTMLButtonElement).disabled).toBe(true);
    });

    it("lets the stylesheet dim the disabled toggles", () => {
      mockApp.airportsVisible = true;
      expect(el("airports-btn").style.opacity).toBe("1");

      replayManager.hideOtherLayersDuringReplay();

      // An inline 1.0 beat the disabled look, so the toggle looked live
      expect(el("airports-btn").style.opacity).toBe("");
    });

    it("does not report the removed heatmap as on", () => {
      mockApp.heatmapVisible = true;

      replayManager.hideOtherLayersDuringReplay();

      const heatmapBtn = el("heatmap-btn");
      expect(heatmapBtn.getAttribute("aria-pressed")).toBe("false");
      expect(heatmapBtn.classList.contains("active")).toBe(false);
      // The user's setting is kept for when replay ends
      expect(mockApp.heatmapVisible).toBe(true);
    });
  });

  describe("restoreLayerVisibility", () => {
    it("does nothing without a map", () => {
      mockApp.map = null;
      mockApp.heatmapVisible = true;
      mockApp.altitudeVisible = true;
      (el("year-select") as HTMLSelectElement).disabled = true;

      replayManager.restoreLayerVisibility();

      expect(mockApp.dataManager.showHeatmap).not.toHaveBeenCalled();
      expect(mockApp.altitudeLayer.setVisible).not.toHaveBeenCalled();
      expect((el("year-select") as HTMLSelectElement).disabled).toBe(true);
    });

    it("restores the heatmap through the data manager when visible", () => {
      mockApp.heatmapVisible = true;

      replayManager.restoreLayerVisibility();

      expect(mockApp.dataManager.showHeatmap).toHaveBeenCalledTimes(1);
    });

    it("does not restore heatmap when not visible", () => {
      mockApp.heatmapVisible = false;

      replayManager.restoreLayerVisibility();

      expect(mockApp.dataManager.showHeatmap).not.toHaveBeenCalled();
      expect(mockApp.heatmapLayer.setVisible).not.toHaveBeenCalled();
    });

    it("puts back exactly what replay hid", () => {
      mockApp.altitudeVisible = true;
      mockApp.airspeedVisible = false;
      mockApp.altitudeLayer.setVisible(true);
      replayManager.hideOtherLayersDuringReplay();

      replayManager.restoreLayerVisibility();

      expect(mockApp.altitudeLayer.isVisible()).toBe(true);
      expect(mockApp.airspeedLayer.isVisible()).toBe(false);
      expect(mockApp.heatmapLayer.isVisible()).toBe(false);
    });

    it("shows a colour layer that was switched on during the replay", () => {
      mockApp.altitudeVisible = false;
      replayManager.hideOtherLayersDuringReplay();
      // The toggle only records the wish while replay runs
      mockApp.altitudeVisible = true;

      replayManager.restoreLayerVisibility();

      expect(mockApp.altitudeLayer.isVisible()).toBe(true);
    });

    it("restores altitude layer when visible and redraws with delay", () => {
      mockApp.altitudeVisible = true;

      replayManager.restoreLayerVisibility();

      expect(mockApp.altitudeLayer.setVisible).toHaveBeenCalledWith(true);
      expect(
        mockApp.map!.layer(MAP_LAYERS.pathsAltitude).layout["visibility"],
      ).toBe("visible");
      expect(mockApp.layerManager.redrawAltitudePaths).not.toHaveBeenCalled();
      vi.advanceTimersByTime(100);
      expect(mockApp.layerManager.redrawAltitudePaths).toHaveBeenCalledTimes(1);
      expect(mockApp.map!.resize).toHaveBeenCalled();
    });

    it("restores airspeed layer when visible and redraws with delay", () => {
      mockApp.airspeedVisible = true;

      replayManager.restoreLayerVisibility();

      expect(mockApp.airspeedLayer.setVisible).toHaveBeenCalledWith(true);
      vi.advanceTimersByTime(100);
      expect(mockApp.layerManager.redrawAirspeedPaths).toHaveBeenCalledTimes(1);
      expect(mockApp.map!.resize).toHaveBeenCalled();
    });

    it("re-enables disabled buttons and filters", () => {
      replayManager.hideOtherLayersDuringReplay();
      expect((el("year-select") as HTMLSelectElement).disabled).toBe(true);

      replayManager.restoreLayerVisibility();

      expect((el("heatmap-btn") as HTMLButtonElement).disabled).toBe(false);
      expect((el("year-select") as HTMLSelectElement).disabled).toBe(false);
      expect((el("aircraft-select") as HTMLSelectElement).disabled).toBe(false);
      expect((el("wrapped-btn") as HTMLButtonElement).disabled).toBe(false);
    });

    it("hands the toggles their state and opacity back", () => {
      mockApp.heatmapVisible = true;
      mockApp.airportsVisible = false;
      replayManager.hideOtherLayersDuringReplay();

      replayManager.restoreLayerVisibility();

      const heatmapBtn = el("heatmap-btn");
      expect(heatmapBtn.getAttribute("aria-pressed")).toBe("true");
      expect(heatmapBtn.style.opacity).toBe("1");
      expect(el("airports-btn").style.opacity).toBe("0.5");
    });

    it("leaves the opacity of a control it did not disable alone", () => {
      el("airports-btn").style.opacity = "0.7";

      replayManager.restoreLayerVisibility();

      expect(el("airports-btn").style.opacity).toBe("0.7");
    });
  });

  describe("updateReplayButtonState", () => {
    it("marks the button ready when exactly one path selected and timing data available", () => {
      mockApp.selectedPathIds = new Set([1]);

      replayManager.updateReplayButtonState();

      const btn = el("replay-btn") as HTMLButtonElement;
      expect(btn.style.opacity).toBe("1");
      expect(btn.disabled).toBe(false);
      expect(btn.getAttribute("aria-disabled")).toBe("false");
      expect(btn.title).toBe("Replay selected flight path");
    });

    it("keeps the button enabled but marked unavailable when no paths selected", () => {
      mockApp.selectedPathIds = new Set();

      replayManager.updateReplayButtonState();

      const btn = el("replay-btn") as HTMLButtonElement;
      expect(btn.style.opacity).toBe("0.5");
      expect(btn.disabled).toBe(false);
      expect(btn.getAttribute("aria-disabled")).toBe("true");
      expect(btn.title).toBe(
        "Select exactly one flight with timing data to replay",
      );
    });

    it("marks the button unavailable when no timing data", () => {
      mockApp.selectedPathIds = new Set([1]);
      mockApp.hasTimingData = false;

      replayManager.updateReplayButtonState();

      const btn = el("replay-btn") as HTMLButtonElement;
      expect(btn.style.opacity).toBe("0.5");
      expect(btn.getAttribute("aria-disabled")).toBe("true");
      expect(btn.title).toBe(
        "Select exactly one flight with timing data to replay",
      );
    });

    it("does nothing without a replay button", () => {
      el("replay-btn").remove();
      mockApp.selectedPathIds = new Set([1]);

      expect(() => replayManager.updateReplayButtonState()).not.toThrow();
      expect(document.getElementById("replay-btn")).toBeNull();
    });
  });
});
