/**
 * Replay Manager - Handles flight replay functionality
 */
import type { Feature } from "geojson";
import type { GeoJSONSource } from "maplibre-gl";
import type { MapApp } from "../mapApp";
import { domCache } from "../utils/domCache";
import { announceInRegion, announceStatus, showToast } from "../utils/toast";
import { findMinMax } from "../utils/arrayHelpers";
import { formatTime } from "../utils/formatters";
import {
  applyLegendVisibility,
  applyToggleButtonState,
  setControlLabel,
} from "../utils/buttonState";
import { setControlIcon } from "../utils/icons";
import { AUTO_ZOOM_FOLLOW, MAP_SOURCES } from "../utils/constants";
import { toBounds, toLngLat, type LngLatTuple } from "../utils/mapHelpers";
import { prefersReducedMotion } from "../utils/motion";
import { prepareReplaySegments } from "../features/replay";
import { segmentBounds } from "../features/wrapped";
import { segmentsForPathIds } from "../calculations/statistics";
import {
  AirplaneMarker,
  ReplayRenderer,
  appendTrailSegment,
} from "./replayRenderer";
import type { ReplayState } from "./replayState";
import type { PathSegment } from "../types";
import {
  REPLAY_BUTTON_LABEL,
  REPLAY_PRECONDITION_MESSAGE,
  updateReplayButtonState,
} from "./replayButton";

const REPLAY_BUTTON_ACTIVE_LABEL = "Stop replay";
const REPLAY_BUTTON_TEXT = "Replay";
const REPLAY_EXIT_LABEL = "Close replay";

/**
 * Controls that stay disabled while replay runs. Wrapped is one of them: it
 * takes the map into its dialog, where the running replay kept panning it
 * with no way to pause, and the end of the replay zoomed the overview to
 * the single flight. Isolate and the selection chip's clear button would
 * change the selection the replay is playing (PathSelection ignores them
 * then as well).
 */
const REPLAY_DISABLED_CONTROL_IDS = [
  "heatmap-btn",
  "airports-btn",
  "aviation-btn",
  "wrapped-btn",
  "year-select",
  "aircraft-select",
  "isolate-btn",
  "selection-clear-btn",
];

/** Custom property holding the replay panel's height, read by styles.css */
export const REPLAY_PANEL_HEIGHT_VAR = "--replay-panel-h";

/**
 * How far a key moves the timeline, as a share of the flight. The native
 * step is one second, which on a three hour flight took over ten thousand
 * presses end to end.
 */
const SLIDER_KEY_STEPS: Partial<Record<string, number>> = {
  ArrowRight: 0.01,
  ArrowUp: 0.01,
  ArrowLeft: -0.01,
  ArrowDown: -0.01,
  PageUp: 0.1,
  PageDown: -0.1,
};

/**
 * Where a key step lands: at least one second on, and never past either
 * end of the flight
 */
function sliderTarget(
  state: Pick<ReplayState, "currentTime" | "maxTime">,
  step: number,
): number {
  const seconds = Math.max(1, Math.round(Math.abs(step) * state.maxTime));
  const target = state.currentTime + Math.sign(step) * seconds;
  return Math.min(state.maxTime, Math.max(0, target));
}

/** Delay before the colour layers are redrawn after replay ends (ms) */
const LAYER_REDRAW_DELAY_MS = 50;

/**
 * Time the view takes to reach the aircraft (ms), at AUTO_ZOOM_FOLLOW both
 * when a replay opens with auto-zoom already on and when it is switched on
 * part way through, so the two arrive at the same view
 */
const AUTO_ZOOM_PAN_MS = 800;

/** Time the view takes back to the start when a finished replay restarts (ms) */
const RESTART_PAN_MS = 500;

/** Time the view takes to show the whole flight once the replay ends (ms) */
const FIT_BOUNDS_MS = 1000;

/** Pixels kept free around the flight in that view */
const FIT_BOUNDS_PADDING = 50;

/**
 * Longest wall-clock step a single frame may advance the replay by (ms).
 * A frame after a stall (a busy main thread, a laptop waking up) would
 * otherwise jump the replay ahead by the whole stall times the speed.
 */
export const MAX_FRAME_DELTA_MS = 100;

export class ReplayManager {
  private app: MapApp;
  private renderer: ReplayRenderer;
  /** Pending colour layer redraws scheduled by restoreLayerVisibility */
  private redrawTimers: ReturnType<typeof setTimeout>[] = [];
  /** Inline opacity of the controls replay disabled, put back afterwards */
  private savedOpacities = new Map<HTMLElement, string>();
  /** Ends the layer subscriptions that keep the trail's scale in step */
  private unsubscribeTrailLegend: (() => void) | null = null;
  private readonly onVisibilityChange = (): void => {
    // No frames run in a hidden tab, so the first one after it comes back
    // would count all the hidden time; start timing afresh instead
    if (document.hidden) this.state.lastFrameTime = null;
  };
  /**
   * The replay state, owned by the app. The map click handler and the layer
   * redraws read it on paths that must not wait for this bundle to load, so
   * it lives in the main bundle and this manager works on the same object.
   */
  readonly state: ReplayState;

  constructor(app: MapApp) {
    this.app = app;
    this.renderer = new ReplayRenderer(app);
    this.state = app.replayState;

    document.addEventListener("visibilitychange", this.onVisibilityChange);

    // Announce the final position once a slider drag ends (not per frame)
    const slider = domCache.get("replay-slider");
    if (slider) {
      slider.addEventListener(
        "change",
        () => this.announce("Moved to " + formatTime(this.state.currentTime)),
        // The slider outlives this manager; the app's signal ends with it
        { signal: app.signal },
      );
      slider.addEventListener(
        "keydown",
        (event) => {
          const step = SLIDER_KEY_STEPS[event.key];
          if (step) {
            event.preventDefault();
            this.seekReplay(String(sliderTarget(this.state, step)));
          }
        },
        { signal: app.signal },
      );
    }

    // Whether replay is available follows the selection and the timing
    // data, which MapApp watches: the control has to say so before this
    // bundle is ever fetched. This manager only nudges the button after an
    // activation changes it.
  }

  /** Cancel every pending timer; the panel itself stays as it is */
  destroy(): void {
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    this.stopFollowingTrailLegend();
    this.cancelRedrawTimers();
    this.renderer.cancelTrailFlush();
    this.renderer.stopWatchingMap();
    if (this.state.animationFrameId) {
      cancelAnimationFrame(this.state.animationFrameId);
      this.state.animationFrameId = null;
    }
  }

  private cancelRedrawTimers(): void {
    for (const timer of this.redrawTimers) clearTimeout(timer);
    this.redrawTimers = [];
  }

  /** Whether the current selection can be replayed; the app decides */
  canReplay(): boolean {
    return this.app.canReplay();
  }

  toggleReplay(): void {
    const panel = domCache.get("replay-controls");
    if (!panel) return;

    if (this.state.active) {
      this.deactivateReplay(panel);
      return;
    }

    if (!this.canReplay()) {
      showToast(REPLAY_PRECONDITION_MESSAGE, "info");
      return;
    }

    // Before initializeReplay(): it ends in updateReplayDisplay(), which
    // writes the readout, and cells that do not exist yet would leave the
    // strip showing placeholder dashes for the whole first activation
    const exit = this.ensureReplayChrome(panel);

    if (!this.initializeReplay()) return;

    // A popup left open on the map, such as the one a tap on a path opens on
    // a phone, would otherwise stay over the replay and its controls. The
    // airplane's own popup only opens on a click later.
    this.closeOtherPopups();

    panel.style.display = "block";
    // The colour legend stands on top of the panel during replay (see
    // styles.css). The panel's height follows the pointer and the readout,
    // so it is measured rather than repeated in the stylesheet.
    document.body.style.setProperty(
      REPLAY_PANEL_HEIGHT_VAR,
      panel.offsetHeight + "px",
    );
    this.state.active = true;
    this.renderer.watchUser();
    // The panel takes the bottom edge; the bar steps aside instead of
    // stacking under it
    this.app.mobileBar?.setReplayActive(true);
    // Starting from the More sheet leaves focus on a tab the line above has
    // just removed from the document, so move it into the panel
    exit.focus();

    const replayBtn = domCache.get("replay-btn");
    if (replayBtn) {
      setControlIcon(replayBtn, "stop");
      setControlLabel(replayBtn, REPLAY_BUTTON_TEXT);
      applyToggleButtonState(replayBtn, true);
      replayBtn.setAttribute("aria-label", REPLAY_BUTTON_ACTIVE_LABEL);
      replayBtn.title = REPLAY_BUTTON_ACTIVE_LABEL;
    }

    this.updateAutoZoomButton();

    document.body.classList.add("replay-active");
    this.hideOtherLayersDuringReplay();
    this.updateTrailLegend();
    // The colour toggles stay usable during replay and change what colours
    // the trail, so the scale follows them. Subscribed after the store's own
    // legend sync, so this runs last and has the final word.
    this.stopFollowingTrailLegend();
    this.unsubscribeTrailLegend = this.app.store.subscribeKeys(
      ["altitudeVisible", "airspeedVisible"],
      () => this.updateTrailLegend(),
    );
  }

  private stopFollowingTrailLegend(): void {
    this.unsubscribeTrailLegend?.();
    this.unsubscribeTrailLegend = null;
  }

  private deactivateReplay(panel: HTMLElement): void {
    // The closing announcement below replaces the "stopped" one
    this.stopReplay(false);
    panel.style.display = "none";
    document.body.style.removeProperty(REPLAY_PANEL_HEIGHT_VAR);
    this.state.active = false;
    this.app.mobileBar?.setReplayActive(false);
    this.restoreFocusAfterReplay();

    const replayBtn = domCache.get("replay-btn");
    if (replayBtn) {
      setControlIcon(replayBtn, "play");
      setControlLabel(replayBtn, REPLAY_BUTTON_TEXT);
      // The opacity is settled by updateReplayButtonState below
      applyToggleButtonState(replayBtn, false);
      replayBtn.setAttribute("aria-label", REPLAY_BUTTON_LABEL);
      replayBtn.title = REPLAY_BUTTON_LABEL;
    }

    document.body.classList.remove("replay-active");

    // Remove airplane marker when closing replay completely
    this.state.airplaneMarker?.remove();
    this.state.airplaneMarker = null;

    this.clearReplayLayer();
    // No camera follows the airplane any more
    this.renderer.stopWatchingMap();

    // The layers come back the way the user left them: closing replay used
    // to switch the altitude layer on when neither colour layer was
    this.restoreLayerVisibility();
    this.stopFollowingTrailLegend();
    this.updateTrailLegend();
    this.updateReplayButtonState();
    // The panel's own live region is hidden with it by now, and a hidden
    // region is not read out
    announceStatus("Replay closed");
  }

  /**
   * Show the altitude scale whenever the replay trail is drawn with it.
   * The trail is coloured by altitude unless the speed layer is the one
   * that is on, so with neither layer on it still needs the scale that the
   * store keeps hidden. Outside replay the legend follows its layer again.
   */
  private updateTrailLegend(): void {
    const legend = domCache.get("altitude-legend");
    if (!legend) return;
    const trailByAltitude = this.state.active && !this.app.airspeedVisible;
    applyLegendVisibility(legend, this.app.altitudeVisible || trailByAltitude);
  }

  updateReplayButtonState(): void {
    updateReplayButtonState(this.canReplay());
  }

  /**
   * Build the parts of the replay panel the template does not carry: an
   * exit control in the top right, away from the transport controls at the
   * bottom, and the readout strip. Both are created once and reused.
   */
  private ensureReplayChrome(panel: HTMLElement): HTMLButtonElement {
    this.renderer.ensureReadout(panel);

    const existing = panel.querySelector<HTMLButtonElement>(".replay-exit");
    if (existing) return existing;

    const exit = document.createElement("button");
    exit.type = "button";
    exit.className = "replay-exit";
    exit.id = "replay-exit-btn";
    exit.title = REPLAY_EXIT_LABEL;
    exit.setAttribute("aria-label", REPLAY_EXIT_LABEL);
    setControlIcon(exit, "close", 20);
    exit.addEventListener("click", () => this.toggleReplay());
    panel.prepend(exit);
    return exit;
  }

  /**
   * Hand focus back when the panel closes. The exit control usually holds it
   * and is about to be hidden with the panel, which would drop focus to
   * <body>. The bar owns the entry point while it is showing, otherwise the
   * replay button does.
   */
  private restoreFocusAfterReplay(): void {
    const target = this.app.mobileBar?.isVisible()
      ? document.getElementById("mobile-tab-more")
      : domCache.get("replay-btn");
    target?.focus();
  }

  private updateAutoZoomButton(): void {
    const autoZoomBtn = domCache.get("replay-autozoom-btn");
    if (!autoZoomBtn) return;
    applyToggleButtonState(autoZoomBtn, this.state.autoZoom);
    autoZoomBtn.title = this.state.autoZoom
      ? "Auto-zoom enabled"
      : "Auto-zoom disabled";
  }

  /** Write to the polite live region (play/pause/seek end announcements) */
  private announce(message: string): void {
    const live = domCache.get("replay-live");
    if (live) announceInRegion(live, message);
  }

  /**
   * MapLibre keeps no list of its open popups, so each owner closes its
   * own: the airports theirs, the layer manager the one of a tapped flight
   */
  private closeOtherPopups(): void {
    for (const marker of Object.values(this.app.airportMarkers)) {
      if (marker.isPopupOpen()) marker.closePopup();
    }
    this.app.layerManager.closeSegmentPopup();
  }

  updateReplayAirplanePopup(): void {
    this.renderer.updateAirplanePopup(this);
  }

  initializeReplay(): boolean {
    if (!this.app.fullPathSegments) {
      showToast(
        "No flight data available for replay. Please wait for data to load or refresh the page.",
        "error",
      );
      return false;
    }

    const selectedPathId = Array.from(this.app.selectedPathIds)[0];
    if (selectedPathId === undefined) return false;
    if (!this.filterAndSortSegments(selectedPathId)) {
      showToast(REPLAY_PRECONDITION_MESSAGE, "info");
      return false;
    }

    this.calculateColorRanges(selectedPathId);
    this.setupReplayUI();
    // The speed select may hold a value restored by the browser, so the
    // state follows it rather than the other way round
    this.changeReplaySpeed();

    if (!this.createReplayMarker()) return false;

    this.state.resetDrawState();
    this.setInitialView();
    this.updateReplayDisplay();

    return true;
  }

  private filterAndSortSegments(pathId: number): boolean {
    if (!this.app.fullPathSegments) return false;
    this.state.segments = prepareReplaySegments(
      this.app.fullPathSegments,
      pathId,
    );
    // A flight whose times are all 0 would finish the moment it started
    // without drawing anything (see MapApp.canReplay)
    const last = this.state.segments[this.state.segments.length - 1];
    return (last?.time ?? 0) > 0;
  }

  private calculateColorRanges(pathId: number): void {
    if (!this.app.currentData?.path_segments) return;

    const currentResSegments = segmentsForPathIds(
      this.app.currentData.path_segments,
      [pathId],
    );

    const sourceSegments =
      currentResSegments.length > 0 ? currentResSegments : this.state.segments;

    const altitudes = sourceSegments.map((s) => s.altitude_ft ?? 0);
    const altRange = findMinMax(altitudes);
    this.state.colorMinAlt = altRange.min;
    this.state.colorMaxAlt = altRange.max;

    const groundspeeds = sourceSegments
      .map((s) => s.groundspeed_knots ?? 0)
      .filter((s) => s > 0);
    if (groundspeeds.length > 0) {
      const speedRange = findMinMax(groundspeeds);
      this.state.colorMinSpeed = speedRange.min;
      this.state.colorMaxSpeed = speedRange.max;
    } else {
      this.state.colorMinSpeed = this.app.airspeedRange.min;
      this.state.colorMaxSpeed = this.app.airspeedRange.max;
    }
  }

  private setupReplayUI(): void {
    const lastSegment = this.state.segments[this.state.segments.length - 1];
    this.state.maxTime = lastSegment?.time ?? 0;

    const slider = domCache.get("replay-slider", HTMLInputElement);
    if (slider) slider.max = this.state.maxTime.toString();

    const sliderEnd = domCache.get("replay-slider-end");
    if (sliderEnd) {
      sliderEnd.textContent = formatTime(this.state.maxTime);
    }

    this.app.layerManager.updateAltitudeLegend(
      this.state.colorMinAlt,
      this.state.colorMaxAlt,
    );
    this.app.layerManager.updateAirspeedLegend(
      this.state.colorMinSpeed,
      this.state.colorMaxSpeed,
    );
  }

  /**
   * Lay the route down and start the trail afresh.
   *
   * Replay used to open on an empty map: the heat bloom and the paths are
   * hidden while it runs, so at 0:00 there was an aircraft over nothing,
   * with no way to see where it was about to go. The whole track is drawn
   * dimmed underneath, and the flown part paints over it in the colours of
   * the active scale. The route never changes during a replay, so its
   * source is written here and nowhere else.
   */
  private startReplayLayer(): void {
    const coordinates = routeCoordinates(this.state.segments);
    this.setReplaySource(
      MAP_SOURCES.replayRoute,
      coordinates.length < 2
        ? []
        : [
            {
              type: "Feature",
              properties: {},
              geometry: { type: "LineString", coordinates },
            },
          ],
    );
    this.setReplaySource(MAP_SOURCES.replayTrail, []);
    this.state.trailRuns = [];
    this.state.trailDirty = false;
    this.state.layerActive = true;
  }

  /** Empty both replay sources; their layers stay on the map, showing nothing */
  private clearReplayLayer(): void {
    this.renderer.cancelTrailFlush();
    this.state.trailDirty = false;
    if (!this.state.layerActive) return;
    this.state.layerActive = false;
    this.setReplaySource(MAP_SOURCES.replayRoute, []);
    this.setReplaySource(MAP_SOURCES.replayTrail, []);
  }

  private setReplaySource(
    id: typeof MAP_SOURCES.replayRoute | typeof MAP_SOURCES.replayTrail,
    features: Feature[],
  ): void {
    void this.app.map
      ?.getSource<GeoJSONSource>(id)
      ?.setData({ type: "FeatureCollection", features });
  }

  private createReplayMarker(): boolean {
    this.state.airplaneMarker?.remove();
    this.state.airplaneMarker = null;

    const firstSegment = this.state.segments[0];
    const startCoords = firstSegment?.coords?.[0];
    if (!startCoords || !this.app.map) return false;

    this.startReplayLayer();

    // The content is the position at the moment the popup opens (see
    // ReplayRenderer.updateAirplanePopup)
    this.state.airplaneMarker = new AirplaneMarker(
      this.app.map,
      [startCoords[0], startCoords[1]],
      () => this.updateReplayAirplanePopup(),
    );

    return true;
  }

  private setInitialView(): void {
    const firstSegment = this.state.segments[0];
    const startCoords = firstSegment?.coords?.[0];
    if (!startCoords || !this.app.map) return;

    this.app.map.easeTo({
      center: toLngLat(startCoords),
      ...(this.state.autoZoom ? { zoom: AUTO_ZOOM_FOLLOW } : {}),
      duration: AUTO_ZOOM_PAN_MS,
      animate: !prefersReducedMotion(),
    });
  }

  hideOtherLayersDuringReplay(): void {
    if (!this.app.map) return;

    // What the user had switched on stays in the store, which the restore
    // reads; only the layers themselves are hidden
    if (this.app.heatmapVisible) this.app.heatmapLayer.setVisible(false);
    // The heatmap is hidden for the replay, so its toggle must not report
    // it as on; restoreLayerVisibility hands it back to the store
    const heatmapBtn = domCache.get("heatmap-btn");
    if (heatmapBtn) applyToggleButtonState(heatmapBtn, false);

    if (this.app.altitudeVisible) this.app.altitudeLayer.setVisible(false);
    if (this.app.airspeedVisible) this.app.airspeedLayer.setVisible(false);

    this.setElementsDisabled(REPLAY_DISABLED_CONTROL_IDS, true);
  }

  restoreLayerVisibility(): void {
    if (!this.app.map) return;

    // With the points of the filter changes made during the replay, and
    // the dimming under a colour layer
    if (this.app.heatmapVisible) this.app.dataManager.showHeatmap();

    // Redraw once the layer shows again: a colour layer switched on during
    // the replay was never drawn. A redraw still pending from an earlier
    // close is dropped rather than run twice.
    this.cancelRedrawTimers();
    if (this.app.altitudeVisible) {
      this.app.altitudeLayer.setVisible(true);
      this.scheduleRedraw(() => this.app.layerManager.redrawAltitudePaths());
    }

    if (this.app.airspeedVisible) {
      this.app.airspeedLayer.setVisible(true);
      this.scheduleRedraw(() => this.app.layerManager.redrawAirspeedPaths());
    }

    this.setElementsDisabled(REPLAY_DISABLED_CONTROL_IDS, false);
    const heatmapBtn = domCache.get("heatmap-btn");
    if (heatmapBtn) applyToggleButtonState(heatmapBtn, this.app.heatmapVisible);
  }

  private scheduleRedraw(redraw: () => void): void {
    const timer = setTimeout(() => {
      this.redrawTimers = this.redrawTimers.filter((t) => t !== timer);
      redraw();
      this.app.map?.resize();
    }, LAYER_REDRAW_DELAY_MS);
    this.redrawTimers.push(timer);
  }

  private setElementsDisabled(ids: string[], disabled: boolean): void {
    ids.forEach((id) => {
      const el = domCache.get(id);
      if (el instanceof HTMLButtonElement || el instanceof HTMLSelectElement) {
        el.disabled = disabled;
        this.setDisabledOpacity(el, disabled);
      }
    });
  }

  /**
   * The store-driven toggles carry an inline opacity, and an inline 1.0
   * beat the stylesheet's dimmed look for a disabled control, so a
   * disabled toggle looked as live as an enabled one. The inline value is
   * set aside while the control is disabled and put back afterwards.
   */
  private setDisabledOpacity(el: HTMLElement, disabled: boolean): void {
    if (disabled) {
      if (!this.savedOpacities.has(el)) {
        this.savedOpacities.set(el, el.style.opacity);
      }
      el.style.opacity = "";
      return;
    }
    const saved = this.savedOpacities.get(el);
    if (saved === undefined) return;
    el.style.opacity = saved;
    this.savedOpacities.delete(el);
  }

  playReplay(): void {
    if (!this.state.active || !this.app.map) return;
    // Never start a second animation loop
    if (this.state.playing) return;

    if (this.state.currentTime >= this.state.maxTime) {
      this.state.resetDrawState();
      this.renderer.scheduleTrailFlush(this.state);

      if (this.state.airplaneMarker && this.state.segments.length > 0) {
        const firstSeg = this.state.segments[0];
        const startCoords = firstSeg?.coords?.[0];
        if (startCoords) {
          this.state.airplaneMarker.setLatLng([startCoords[0], startCoords[1]]);

          if (this.state.autoZoom) {
            this.app.map.easeTo({
              center: toLngLat(startCoords),
              zoom: AUTO_ZOOM_FOLLOW,
              duration: RESTART_PAN_MS,
              animate: !prefersReducedMotion(),
            });
          }
        }
      }
    }

    this.state.playing = true;
    setTransportState(true);
    this.announce("Replay playing");

    this.state.lastFrameTime = null;

    const animateReplay = (timestamp: number) => {
      if (!this.state.playing) return;

      if (this.state.lastFrameTime === null) {
        this.state.lastFrameTime = timestamp;
      }
      const deltaMs = Math.min(
        timestamp - this.state.lastFrameTime,
        MAX_FRAME_DELTA_MS,
      );
      this.state.lastFrameTime = timestamp;

      const deltaTime = (deltaMs / 1000) * this.state.speed;
      this.state.currentTime += deltaTime;

      if (this.state.currentTime >= this.state.maxTime) {
        this.state.currentTime = this.state.maxTime;
        this.pauseReplay(false);
        this.announce("Replay finished");
        this.fitReplayBounds();
      } else {
        this.state.animationFrameId = requestAnimationFrame(animateReplay);
      }

      this.updateReplayDisplay();
    };

    this.state.animationFrameId = requestAnimationFrame(animateReplay);
  }

  private fitReplayBounds(): void {
    if (this.state.segments.length === 0 || !this.app.map) return;

    const bounds = segmentBounds(this.state.segments);
    if (!bounds) return;
    this.app.map.fitBounds(toBounds(bounds), {
      // A fit turns the map north up unless it is told the bearing, and
      // the replay leaves the orientation to the user
      bearing: this.app.map.getBearing(),
      padding: FIT_BOUNDS_PADDING,
      duration: FIT_BOUNDS_MS,
      animate: !prefersReducedMotion(),
    });
  }

  pauseReplay(announce: boolean = true): void {
    const wasPlaying = this.state.playing;
    this.state.playing = false;
    setTransportState(false);

    if (this.state.animationFrameId) {
      cancelAnimationFrame(this.state.animationFrameId);
      this.state.animationFrameId = null;
    }

    this.state.lastFrameTime = null;

    if (wasPlaying && announce) {
      this.announce("Replay paused at " + formatTime(this.state.currentTime));
    }
  }

  stopReplay(announce = true): void {
    this.pauseReplay(false);
    this.state.resetDrawState();
    if (this.state.airplaneMarker && this.state.segments.length > 0) {
      const firstSeg = this.state.segments[0];
      const startCoords = firstSeg?.coords?.[0];
      if (startCoords) {
        this.state.airplaneMarker.setLatLng([startCoords[0], startCoords[1]]);
      }
    }
    this.updateReplayDisplay();
    if (this.state.active && announce) this.announce("Replay stopped");
  }

  seekReplay(value: string): void {
    const newTime = parseFloat(value);
    if (!isFinite(newTime)) return;

    if (newTime < this.state.currentTime) {
      // Drop only the segments after the new position; starting the trail
      // over would colour the entire flight again on every drag event
      this.renderer.removeSegmentsAfter(this, newTime);
    }

    this.state.currentTime = newTime;
    this.updateReplayDisplay(true);
  }

  changeReplaySpeed(): void {
    const select = domCache.get("replay-speed", HTMLSelectElement);
    if (!select) return;

    const speed = parseFloat(select.value);
    if (!isFinite(speed) || speed <= 0) return;
    this.state.speed = speed;
  }

  toggleAutoZoom(): void {
    this.state.autoZoom = !this.state.autoZoom;
    this.updateAutoZoomButton();
    if (this.state.autoZoom) this.zoomToAircraft();
  }

  /**
   * Go to the aircraft at the follow zoom, the view a replay that opened with
   * auto-zoom already on starts at.
   *
   * Switching it on used to do nothing to the map. The renderer only ever
   * zooms out, to catch an aircraft the pan has lost, so the control stayed
   * silent until the flight left the viewport and then only widened the view:
   * the one thing "auto-zoom" does not suggest. Turning it on now arrives at
   * the same place as starting with it on, whatever the map was showing.
   */
  private zoomToAircraft(): void {
    const position = this.state.airplaneMarker?.getLatLng();
    if (!position || !this.app.map) return;
    this.app.map.easeTo({
      center: toLngLat(position),
      zoom: AUTO_ZOOM_FOLLOW,
      duration: AUTO_ZOOM_PAN_MS,
      animate: !prefersReducedMotion(),
    });
  }

  redrawReplayPath(mode: "altitude" | "airspeed"): void {
    if (!this.state.layerActive) return;
    const savedTime = this.state.currentTime;
    const savedIndex = this.state.lastDrawnIndex;
    // The runs are cut by colour, so another scale means other runs: the
    // flown part is coloured again from the start
    this.state.trailRuns = [];
    this.state.lastDrawnIndex = -1;
    this.state.trailDirty = true;

    for (let i = 0; i <= savedIndex && i < this.state.segments.length; i++) {
      const seg = this.state.segments[i];
      if (!seg || (seg.time ?? 0) > savedTime) continue;
      appendTrailSegment(this.state, i, mode === "airspeed");
    }
    this.renderer.scheduleTrailFlush(this.state);
  }

  updateReplayDisplay(isManualSeek: boolean = false): void {
    this.renderer.updateDisplay(this, isManualSeek);
  }
}

/**
 * Show exactly one of the play and pause controls.
 *
 * The attribute is the only owner of which one shows. Writing an inline
 * `display` here used to blockify the button inside the flex transport row,
 * which pinned its icon to the left edge for the rest of the session, and it
 * left `.initially-hidden` claiming the same state from the stylesheet.
 *
 * The control that goes away may be the one holding focus: pressing Play
 * with the keyboard hides Play, and the end of the replay hides Pause.
 * Focus then moves to the control that took its place instead of dropping
 * to <body>, where the next Space did nothing.
 */
function setTransportState(playing: boolean): void {
  const playBtn = domCache.get("replay-play-btn");
  const pauseBtn = domCache.get("replay-pause-btn");
  const hiding = playing ? playBtn : pauseBtn;
  const showing = playing ? pauseBtn : playBtn;
  const hadFocus = hiding !== null && document.activeElement === hiding;
  // The class covers only the moment before this first runs
  playBtn?.classList.remove("initially-hidden");
  pauseBtn?.classList.remove("initially-hidden");
  if (playBtn) playBtn.hidden = playing;
  if (pauseBtn) pauseBtn.hidden = !playing;
  if (hadFocus) showing?.focus();
}

/**
 * The flight's whole track as one list of `[lng, lat]` points: the start of
 * every segment, plus the end of the last one.
 */
function routeCoordinates(segments: PathSegment[]): LngLatTuple[] {
  const coords: LngLatTuple[] = [];
  for (const segment of segments) {
    const start = segment.coords?.[0];
    if (start) coords.push(toLngLat(start));
  }
  const last = segments[segments.length - 1]?.coords?.[1];
  if (last) coords.push(toLngLat(last));
  return coords;
}
