/**
 * ReplayManager: activation, initialization and layer handling.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ReplayManager } from "../../../../kml_heatmap/frontend/ui/replayManager";
import { REPLAY_PRECONDITION_MESSAGE } from "../../../../kml_heatmap/frontend/ui/replayManager";
import {
  createReplayManager,
  createReplayMockApp,
  createSegments,
  el,
  liveRegionText,
  mockAnimationFrame,
  mountReplayDom,
  statsWithSpeed,
  unmountReplayDom,
} from "./replayTestSetup";
import { createDataset, type MockApp } from "../../testHelpers";

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
      expect(replayManager.state.layer).toBeNull();
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
  });

  describe("canReplay", () => {
    it("requires exactly one selected path with timing data", () => {
      mockApp.selectedPathIds = new Set([1]);
      expect(replayManager.canReplay()).toBe(true);

      mockApp.selectedPathIds = new Set([1, 2]);
      expect(replayManager.canReplay()).toBe(false);

      mockApp.selectedPathIds = new Set([1]);
      mockApp.fullStats = statsWithSpeed(0);
      expect(replayManager.canReplay()).toBe(false);

      mockApp.fullStats = null;
      expect(replayManager.canReplay()).toBe(false);
    });
  });

  describe("store subscriptions", () => {
    it("marks the button ready as soon as one timed flight is selected", () => {
      const btn = el("replay-btn") as HTMLButtonElement;
      expect(btn.style.opacity).toBe("0.5");

      mockApp.selectedPathIds.add(1);
      mockApp.store.notifyMutation("selectedPathIds");

      expect(btn.style.opacity).toBe("1");
      expect(btn.title).toBe("Replay selected flight path");
    });

    it("follows the timing data of the loaded metadata", () => {
      mockApp.selectedPathIds = new Set([1]);
      const btn = el("replay-btn") as HTMLButtonElement;
      expect(btn.style.opacity).toBe("1");

      mockApp.fullStats = statsWithSpeed(0);

      expect(btn.style.opacity).toBe("0.5");
    });

    it("reflects a selection restored before the manager existed", () => {
      const app = createReplayMockApp();
      app.selectedPathIds.add(1);

      createReplayManager(app);

      expect((el("replay-btn") as HTMLButtonElement).style.opacity).toBe("1");
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

    it("shows an explanatory toast when the selection has no timing data", () => {
      mockApp.selectedPathIds = new Set([1]);
      mockApp.fullStats = statsWithSpeed(0);

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

      // Replay state itself is not persisted, and the altitude layer it
      // switches on reaches the state manager through the store
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
      expect(liveRegionText()).toBe("Replay closed");
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

      replayManager.toggleReplay();

      expect(mockApp.map!.removeLayer).toHaveBeenCalledWith(
        mockApp.heatmapLayer,
      );
      expect(mockApp.map!.removeLayer).toHaveBeenCalledWith(
        mockApp.altitudeLayer,
      );
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

    it("removes airplane marker and its click handler on deactivation", () => {
      mockApp.selectedPathIds = new Set([1]);
      replayManager.toggleReplay();
      const marker = replayManager.state.airplaneMarker;
      expect(marker).not.toBeNull();

      replayManager.toggleReplay();

      expect(mockApp.map!.removeLayer).toHaveBeenCalledWith(marker);
      expect(replayManager.state.airplaneMarker).toBeNull();
    });

    it("removes replay layer from map on deactivation", () => {
      mockApp.selectedPathIds = new Set([1]);
      replayManager.toggleReplay();
      const layer = replayManager.state.layer;

      replayManager.toggleReplay();

      expect(mockApp.map!.removeLayer).toHaveBeenCalledWith(layer);
    });

    it("restores layer visibility on deactivation", () => {
      mockApp.selectedPathIds = new Set([1]);
      mockApp.heatmapVisible = true;

      replayManager.toggleReplay();
      replayManager.toggleReplay();

      expect(mockApp.map!.addLayer).toHaveBeenCalledWith(mockApp.heatmapLayer);
    });

    it("enables altitude with pressed state when no color layer is visible on deactivation", () => {
      mockApp.selectedPathIds = new Set([1]);
      mockApp.altitudeVisible = false;
      mockApp.airspeedVisible = false;

      replayManager.toggleReplay();
      replayManager.toggleReplay();

      expect(mockApp.altitudeVisible).toBe(true);
      const altBtn = el("altitude-btn");
      expect(altBtn.style.opacity).toBe("1");
      expect(altBtn.getAttribute("aria-pressed")).toBe("true");
      expect(el("altitude-legend").style.display).toBe("block");
      expect(mockApp.map!.addLayer).toHaveBeenCalledWith(mockApp.altitudeLayer);
    });

    it("redraws altitude paths exactly once after deactivation", () => {
      mockApp.selectedPathIds = new Set([1]);
      mockApp.altitudeVisible = false;
      mockApp.airspeedVisible = false;

      replayManager.toggleReplay();
      replayManager.toggleReplay();
      vi.advanceTimersByTime(500);

      expect(mockApp.layerManager.redrawAltitudePaths).toHaveBeenCalledTimes(1);
      expect(mockApp.map!.invalidateSize).toHaveBeenCalled();
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

    it("creates replay layer group and adds to map", () => {
      mockApp.selectedPathIds = new Set([1]);

      replayManager.initializeReplay();

      expect(replayManager.state.layer).not.toBeNull();
      expect(replayManager.state.layer!.addTo).toHaveBeenCalledWith(
        mockApp.map,
      );
    });

    it("creates an accessible airplane marker at the first segment", () => {
      mockApp.selectedPathIds = new Set([1]);

      replayManager.initializeReplay();

      expect(replayManager.state.airplaneMarker).not.toBeNull();
      expect(replayManager.state.airplaneMarker!.addTo).toHaveBeenCalledWith(
        mockApp.map,
      );
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

      expect(mockApp.map!.setView).toHaveBeenCalledWith(
        [48.0, 16.0],
        16,
        expect.objectContaining({ animate: true }),
      );
      expect(replayManager.state.lastZoom).toBe(16);
    });

    it("pans to start position without changing zoom when autoZoom is disabled", () => {
      mockApp.selectedPathIds = new Set([1]);
      replayManager.state.autoZoom = false;

      replayManager.initializeReplay();

      expect(mockApp.map!.panTo).toHaveBeenCalledWith(
        [48.0, 16.0],
        expect.objectContaining({ animate: true }),
      );
      expect(mockApp.map!.setView).not.toHaveBeenCalled();
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
      const firstMarker = replayManager.state.airplaneMarker;

      replayManager.initializeReplay();

      expect(mockApp.map!.removeLayer).toHaveBeenCalledWith(firstMarker);
      expect(replayManager.state.airplaneMarker).not.toBe(firstMarker);
    });

    it("returns true on success", () => {
      mockApp.selectedPathIds = new Set([1]);

      expect(replayManager.initializeReplay()).toBe(true);
    });
  });

  describe("hideOtherLayersDuringReplay", () => {
    it("does nothing without a map", () => {
      const map = mockApp.map!;
      mockApp.map = null;
      mockApp.heatmapVisible = true;

      replayManager.hideOtherLayersDuringReplay();

      expect(map.removeLayer).not.toHaveBeenCalled();
      expect((el("year-select") as HTMLSelectElement).disabled).toBe(false);
    });

    it("hides heatmap when visible", () => {
      mockApp.heatmapVisible = true;

      replayManager.hideOtherLayersDuringReplay();

      expect(mockApp.map!.removeLayer).toHaveBeenCalledWith(
        mockApp.heatmapLayer,
      );
    });

    it("does not hide heatmap when not visible", () => {
      mockApp.heatmapVisible = false;

      replayManager.hideOtherLayersDuringReplay();

      expect(mockApp.map!.removeLayer).not.toHaveBeenCalledWith(
        mockApp.heatmapLayer,
      );
    });

    it("hides altitude layer when visible", () => {
      mockApp.altitudeVisible = true;

      replayManager.hideOtherLayersDuringReplay();

      expect(mockApp.map!.removeLayer).toHaveBeenCalledWith(
        mockApp.altitudeLayer,
      );
    });

    it("hides airspeed layer when visible", () => {
      mockApp.airspeedVisible = true;

      replayManager.hideOtherLayersDuringReplay();

      expect(mockApp.map!.removeLayer).toHaveBeenCalledWith(
        mockApp.airspeedLayer,
      );
    });

    it("disables layer buttons and filters during replay", () => {
      replayManager.hideOtherLayersDuringReplay();

      expect((el("heatmap-btn") as HTMLButtonElement).disabled).toBe(true);
      expect((el("airports-btn") as HTMLButtonElement).disabled).toBe(true);
      expect((el("aviation-btn") as HTMLButtonElement).disabled).toBe(true);
      expect((el("year-select") as HTMLSelectElement).disabled).toBe(true);
      expect((el("aircraft-select") as HTMLSelectElement).disabled).toBe(true);
    });
  });

  describe("restoreLayerVisibility", () => {
    it("does nothing without a map", () => {
      const map = mockApp.map!;
      mockApp.map = null;
      mockApp.heatmapVisible = true;
      (el("year-select") as HTMLSelectElement).disabled = true;

      replayManager.restoreLayerVisibility();

      expect(map.addLayer).not.toHaveBeenCalled();
      expect((el("year-select") as HTMLSelectElement).disabled).toBe(true);
    });

    it("restores heatmap when visible", () => {
      mockApp.heatmapVisible = true;

      replayManager.restoreLayerVisibility();

      expect(mockApp.map!.addLayer).toHaveBeenCalledWith(mockApp.heatmapLayer);
    });

    it("sets pointer-events none on heatmap canvas when restoring", () => {
      const canvas = document.createElement("canvas");
      mockApp.heatmapLayer!._canvas = canvas;
      mockApp.heatmapVisible = true;

      replayManager.restoreLayerVisibility();

      expect(canvas.style.pointerEvents).toBe("none");
    });

    it("does not restore heatmap when not visible", () => {
      mockApp.heatmapVisible = false;

      replayManager.restoreLayerVisibility();

      expect(mockApp.map!.addLayer).not.toHaveBeenCalledWith(
        mockApp.heatmapLayer,
      );
    });

    it("restores altitude layer when visible and redraws with delay", () => {
      mockApp.altitudeVisible = true;

      replayManager.restoreLayerVisibility();

      expect(mockApp.map!.addLayer).toHaveBeenCalledWith(mockApp.altitudeLayer);
      expect(mockApp.layerManager.redrawAltitudePaths).not.toHaveBeenCalled();
      vi.advanceTimersByTime(100);
      expect(mockApp.layerManager.redrawAltitudePaths).toHaveBeenCalledTimes(1);
      expect(mockApp.map!.invalidateSize).toHaveBeenCalled();
    });

    it("restores airspeed layer when visible and redraws with delay", () => {
      mockApp.airspeedVisible = true;

      replayManager.restoreLayerVisibility();

      expect(mockApp.map!.addLayer).toHaveBeenCalledWith(mockApp.airspeedLayer);
      vi.advanceTimersByTime(100);
      expect(mockApp.layerManager.redrawAirspeedPaths).toHaveBeenCalledTimes(1);
      expect(mockApp.map!.invalidateSize).toHaveBeenCalled();
    });

    it("re-enables disabled buttons and filters", () => {
      replayManager.hideOtherLayersDuringReplay();
      expect((el("year-select") as HTMLSelectElement).disabled).toBe(true);

      replayManager.restoreLayerVisibility();

      expect((el("heatmap-btn") as HTMLButtonElement).disabled).toBe(false);
      expect((el("year-select") as HTMLSelectElement).disabled).toBe(false);
      expect((el("aircraft-select") as HTMLSelectElement).disabled).toBe(false);
    });
  });

  describe("updateReplayButtonState", () => {
    it("marks the button ready when exactly one path selected and timing data available", () => {
      mockApp.selectedPathIds = new Set([1]);

      replayManager.updateReplayButtonState();

      const btn = el("replay-btn") as HTMLButtonElement;
      expect(btn.style.opacity).toBe("1");
      expect(btn.disabled).toBe(false);
      expect(btn.getAttribute("aria-disabled")).toBeNull();
      expect(btn.title).toBe("Replay selected flight path");
    });

    it("keeps the button enabled but marked unavailable when no paths selected", () => {
      mockApp.selectedPathIds = new Set();

      replayManager.updateReplayButtonState();

      const btn = el("replay-btn") as HTMLButtonElement;
      expect(btn.style.opacity).toBe("0.5");
      expect(btn.disabled).toBe(false);
      expect(btn.getAttribute("aria-disabled")).toBeNull();
      expect(btn.title).toBe(
        "Select exactly one flight with timing data to replay",
      );
    });

    it("marks the button unavailable when no timing data", () => {
      mockApp.selectedPathIds = new Set([1]);
      mockApp.fullStats = statsWithSpeed(0);

      replayManager.updateReplayButtonState();

      const btn = el("replay-btn") as HTMLButtonElement;
      expect(btn.style.opacity).toBe("0.5");
      expect(btn.getAttribute("aria-disabled")).toBeNull();
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
