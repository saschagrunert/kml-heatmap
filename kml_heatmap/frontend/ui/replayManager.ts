/**
 * Replay Manager - Handles flight replay functionality
 */
import * as L from "leaflet";
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
import { prefersReducedMotion } from "../utils/motion";
import { prepareReplaySegments } from "../features/replay";
import { segmentsForPathIds } from "../calculations/statistics";
import { ReplayRenderer, drawReplaySegment } from "./replayRenderer";
import { ReplayState } from "./replayState";

export const REPLAY_PRECONDITION_MESSAGE =
  "Select exactly one flight with timing data to replay";

const REPLAY_BUTTON_LABEL = "Replay selected flight path";
const REPLAY_BUTTON_ACTIVE_LABEL = "Stop replay";
const REPLAY_BUTTON_TEXT = "Replay";
const REPLAY_EXIT_LABEL = "Close replay";

/**
 * Controls that stay disabled while replay runs. Wrapped is one of them: it
 * takes the map into its dialog, where the running replay kept panning it
 * with no way to pause, and the end of the replay zoomed the overview to
 * the single flight.
 */
const REPLAY_DISABLED_CONTROL_IDS = [
  "heatmap-btn",
  "airports-btn",
  "aviation-btn",
  "wrapped-btn",
  "year-select",
  "aircraft-select",
];

/** Custom property holding the replay panel's height, read by styles.css */
export const REPLAY_PANEL_HEIGHT_VAR = "--replay-panel-h";

/** Delay before the colour layers are redrawn after replay ends (ms) */
const LAYER_REDRAW_DELAY_MS = 50;

/**
 * Longest wall-clock step a single frame may advance the replay by (ms).
 * A frame after a stall (a busy main thread, a laptop waking up) would
 * otherwise jump the replay ahead by the whole stall times the speed.
 */
export const MAX_FRAME_DELTA_MS = 100;

export class ReplayManager {
  private app: MapApp;
  private renderer: ReplayRenderer;
  private markerClickHandler: ((e: Event) => void) | null = null;
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
  state: ReplayState;

  constructor(app: MapApp) {
    this.app = app;
    this.renderer = new ReplayRenderer(app);
    this.state = new ReplayState();

    document.addEventListener("visibilitychange", this.onVisibilityChange);

    // Announce the final position once a slider drag ends (not per frame)
    const slider = domCache.get("replay-slider");
    if (slider) {
      slider.addEventListener("change", () => {
        this.announce("Moved to " + formatTime(this.state.currentTime));
      });
    }

    // Whether replay is available follows the selection and the timing data
    const refresh = (): void => this.updateReplayButtonState();
    app.store.subscribe("selectedPathIds", refresh);
    app.store.subscribe("hasTimingData", refresh);
    refresh();
  }

  /** Cancel every pending timer; the panel itself stays as it is */
  destroy(): void {
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    this.stopFollowingTrailLegend();
    this.cancelRedrawTimers();
    if (this.state.animationFrameId) {
      cancelAnimationFrame(this.state.animationFrameId);
      this.state.animationFrameId = null;
    }
  }

  private cancelRedrawTimers(): void {
    for (const timer of this.redrawTimers) clearTimeout(timer);
    this.redrawTimers = [];
  }

  /** Whether the current selection can be replayed */
  canReplay(): boolean {
    return this.app.selectedPathIds.size === 1 && this.app.hasTimingData;
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
    this.app.map?.closePopup();

    panel.style.display = "block";
    // The colour legend stands on top of the panel during replay (see
    // styles.css). The panel's height follows the pointer and the readout,
    // so it is measured rather than repeated in the stylesheet.
    document.body.style.setProperty(
      REPLAY_PANEL_HEIGHT_VAR,
      panel.offsetHeight + "px",
    );
    this.state.active = true;
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
    if (this.state.airplaneMarker) {
      const el = this.state.airplaneMarker.getElement();
      if (el && this.markerClickHandler) {
        el.removeEventListener("click", this.markerClickHandler);
        this.markerClickHandler = null;
      }
      if (this.app.map) {
        this.app.map.removeLayer(this.state.airplaneMarker);
      }
      this.state.airplaneMarker = null;
    }

    // Remove replay layer from map (important for mobile Safari touch events)
    if (this.state.layer && this.app.map) {
      this.app.map.removeLayer(this.state.layer);
    }

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
    const btn = domCache.get("replay-btn", HTMLButtonElement);
    if (!btn) return;

    // The button stays enabled so it can explain why replay is unavailable
    const ready = this.canReplay();
    btn.style.opacity = ready ? "1.0" : "0.5";
    // No aria-disabled: assistive tech would skip the button, and clicking it
    // is how the user learns why replay is unavailable
    btn.title = ready
      ? "Replay selected flight path"
      : "Select exactly one flight with timing data to replay";
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
    return this.state.segments.length > 0;
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

  private createReplayMarker(): boolean {
    if (!this.state.layer) {
      this.state.layer = L.layerGroup();
    }
    this.state.layer.clearLayers();
    if (this.app.map) {
      this.state.layer.addTo(this.app.map);
    }

    if (this.state.airplaneMarker && this.app.map) {
      this.app.map.removeLayer(this.state.airplaneMarker);
      this.state.airplaneMarker = null;
    }

    const airplaneIcon = L.divIcon({
      html: '<div class="replay-airplane-icon">✈️</div>',
      iconSize: [32, 32],
      iconAnchor: [16, 16],
      className: "",
    });

    const firstSegment = this.state.segments[0];
    const startCoords = firstSegment?.coords?.[0];
    if (!startCoords || !this.app.map) return false;

    this.state.airplaneMarker = L.marker([startCoords[0], startCoords[1]], {
      icon: airplaneIcon,
      zIndexOffset: 1000,
      title: "Aircraft position",
      alt: "Aircraft position",
    });
    this.state.airplaneMarker.addTo(this.app.map);

    // The rotation transition lives on the inner icon (see styles.css);
    // Leaflet positions the marker root with transforms, which must not animate.
    const markerElement = this.state.airplaneMarker.getElement();
    if (markerElement) {
      markerElement.style.cursor = "pointer";
      markerElement.style.pointerEvents = "auto";

      this.markerClickHandler = (e: Event) => {
        e.stopPropagation();
        if (!this.state.airplaneMarker) return;
        if (this.state.airplaneMarker.isPopupOpen()) {
          this.state.airplaneMarker.closePopup();
        } else {
          this.updateReplayAirplanePopup();
        }
      };
      markerElement.addEventListener("click", this.markerClickHandler);
    }

    return true;
  }

  private setInitialView(): void {
    const firstSegment = this.state.segments[0];
    const startCoords = firstSegment?.coords?.[0];
    if (!startCoords || !this.app.map) return;

    const animate = !prefersReducedMotion();
    if (this.state.autoZoom) {
      this.app.map.setView([startCoords[0], startCoords[1]], 16, {
        animate,
        duration: 0.8,
      });
    } else {
      this.app.map.panTo([startCoords[0], startCoords[1]], {
        animate,
        duration: 0.8,
      });
    }
  }

  hideOtherLayersDuringReplay(): void {
    if (!this.app.map) return;

    if (this.app.heatmapLayer && this.app.heatmapVisible) {
      this.app.map.removeLayer(this.app.heatmapLayer);
    }
    // The heatmap is off the map for the replay, so its toggle must not
    // report it as on; restoreLayerVisibility hands it back to the store
    const heatmapBtn = domCache.get("heatmap-btn");
    if (heatmapBtn) applyToggleButtonState(heatmapBtn, false);

    if (this.app.altitudeVisible) {
      this.app.map.removeLayer(this.app.altitudeLayer);
    }

    if (this.app.airspeedVisible) {
      this.app.map.removeLayer(this.app.airspeedLayer);
    }

    this.setElementsDisabled(REPLAY_DISABLED_CONTROL_IDS, true);
  }

  restoreLayerVisibility(): void {
    if (!this.app.map) return;

    if (this.app.heatmapLayer && this.app.heatmapVisible) {
      this.app.map.addLayer(this.app.heatmapLayer);
      if (this.app.heatmapLayer._canvas) {
        this.app.heatmapLayer._canvas.style.pointerEvents = "none";
      }
      // Adding the layer builds a new canvas, which has lost the dimming
      // it had under a colour layer
      this.app.dataManager.applyHeatmapEmphasis();
    }

    // Redraw once after the layer is back on the map so click handlers work
    // on mobile Safari. A redraw still pending from an earlier close is
    // dropped rather than run twice.
    this.cancelRedrawTimers();
    if (this.app.altitudeVisible) {
      this.app.map.addLayer(this.app.altitudeLayer);
      this.scheduleRedraw(() => this.app.layerManager.redrawAltitudePaths());
    }

    if (this.app.airspeedVisible) {
      this.app.map.addLayer(this.app.airspeedLayer);
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
      if (this.app.map) this.app.map.invalidateSize();
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
      if (this.state.layer) this.state.layer.clearLayers();

      if (this.state.airplaneMarker && this.state.segments.length > 0) {
        const firstSeg = this.state.segments[0];
        const startCoords = firstSeg?.coords?.[0];
        if (startCoords) {
          this.state.airplaneMarker.setLatLng([startCoords[0], startCoords[1]]);

          if (this.state.autoZoom) {
            this.app.map.setView([startCoords[0], startCoords[1]], 16, {
              animate: !prefersReducedMotion(),
              duration: 0.5,
            });
          }
        }
      }
    }

    this.state.playing = true;
    this.renderer.syncPopupAutoPan(this);
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

    const allCoords: [number, number][] = [];
    this.state.segments.forEach((seg) => {
      seg.coords?.forEach((coord) => allCoords.push(coord));
    });

    if (allCoords.length > 0) {
      this.app.map.fitBounds(L.latLngBounds(allCoords), {
        padding: [50, 50],
        animate: !prefersReducedMotion(),
        duration: 1.0,
      });
    }
  }

  pauseReplay(announce: boolean = true): void {
    const wasPlaying = this.state.playing;
    this.state.playing = false;
    this.renderer.syncPopupAutoPan(this);
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
    if (this.state.layer) {
      this.state.layer.clearLayers();
    }
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
      // Drop only the segments after the new position; clearing the whole
      // layer would redraw the entire flight on every drag event
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
  }

  redrawReplayPath(mode: "altitude" | "airspeed"): void {
    if (!this.state.layer) return;
    const savedTime = this.state.currentTime;
    const savedIndex = this.state.lastDrawnIndex;
    this.state.layer.clearLayers();
    // The drawn polylines are gone, so the trim stack has to be rebuilt too;
    // stale entries would make a backward seek remove nothing visible
    this.state.drawnLayers = [];
    this.state.lastDrawnIndex = -1;

    for (let i = 0; i <= savedIndex && i < this.state.segments.length; i++) {
      const seg = this.state.segments[i];
      if (!seg || (seg.time ?? 0) > savedTime) continue;
      drawReplaySegment(this.state, i, mode === "airspeed");
    }
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
