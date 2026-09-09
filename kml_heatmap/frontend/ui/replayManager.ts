/**
 * Replay Manager - Handles flight replay functionality
 */
import * as L from "leaflet";
import type { MapApp } from "../mapApp";
import { domCache } from "../utils/domCache";
import { showToast } from "../utils/toast";
import { findMinMax } from "../utils/arrayHelpers";
import { formatTime } from "../utils/formatters";
import { getColorForAirspeed, getColorForAltitude } from "../utils/colors";
import { ReplayRenderer } from "./replayRenderer";
import { ReplayState } from "./replayState";

export const REPLAY_PRECONDITION_MESSAGE =
  "Select exactly one flight with timing data to replay";

const REPLAY_BUTTON_LABEL = "Replay selected flight path";
const REPLAY_BUTTON_ACTIVE_LABEL = "Stop replay";

const REPLAY_DISABLED_CONTROL_IDS = [
  "heatmap-btn",
  "airports-btn",
  "aviation-btn",
  "year-select",
  "aircraft-select",
];

export class ReplayManager {
  private app: MapApp;
  private renderer: ReplayRenderer;
  private markerClickHandler: ((e: Event) => void) | null = null;
  state: ReplayState;

  constructor(app: MapApp) {
    this.app = app;
    this.renderer = new ReplayRenderer(app);
    this.state = new ReplayState();

    // Pre-cache replay control elements
    domCache.cacheElements([
      "replay-controls",
      "replay-btn",
      "replay-play-btn",
      "replay-pause-btn",
      "replay-slider",
      "replay-slider-start",
      "replay-slider-end",
      "replay-time-display",
      "replay-live",
      "replay-speed",
      "replay-autozoom-btn",
      "altitude-btn",
      "altitude-legend",
    ]);

    // Announce the final position once a slider drag ends (not per frame)
    const slider = domCache.get("replay-slider");
    if (slider) {
      slider.addEventListener("change", () => {
        this.announce("Moved to " + formatTime(this.state.currentTime));
      });
    }
  }

  /** Whether the current selection can be replayed */
  canReplay(): boolean {
    const hasTimingData =
      this.app.fullStats?.max_groundspeed_knots !== undefined &&
      this.app.fullStats.max_groundspeed_knots > 0;
    return this.app.selectedPathIds.size === 1 && hasTimingData;
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

    if (!this.initializeReplay()) return;

    panel.style.display = "block";
    this.state.active = true;

    const replayBtn = domCache.get("replay-btn");
    if (replayBtn) {
      replayBtn.textContent = "⏹️ Replay";
      replayBtn.style.opacity = "1.0";
      replayBtn.setAttribute("aria-pressed", "true");
      replayBtn.setAttribute("aria-label", REPLAY_BUTTON_ACTIVE_LABEL);
      replayBtn.title = REPLAY_BUTTON_ACTIVE_LABEL;
    }

    this.updateAutoZoomButton();

    document.body.classList.add("replay-active");
    this.hideOtherLayersDuringReplay();
    this.app.stateManager.saveMapState();
  }

  private deactivateReplay(panel: HTMLElement): void {
    // The closing announcement below replaces the "stopped" one
    this.stopReplay(false);
    panel.style.display = "none";
    this.state.active = false;

    const replayBtn = domCache.get("replay-btn");
    if (replayBtn) {
      replayBtn.textContent = "▶️ Replay";
      replayBtn.setAttribute("aria-pressed", "false");
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

    // Ensure a colored path layer is visible for path selection after replay.
    // restoreLayerVisibility() adds the layer and redraws it once.
    if (!this.app.altitudeVisible && !this.app.airspeedVisible) {
      this.app.altitudeVisible = true;
      const altBtn = domCache.get("altitude-btn");
      if (altBtn) {
        altBtn.style.opacity = "1.0";
        altBtn.setAttribute("aria-pressed", "true");
      }
      const altLegend = domCache.get("altitude-legend");
      if (altLegend) altLegend.style.display = "block";
    }

    this.restoreLayerVisibility();
    this.updateReplayButtonState();
    this.app.stateManager.saveMapState();
    this.announce("Replay closed");
  }

  updateReplayButtonState(): void {
    const btn = domCache.get("replay-btn") as HTMLButtonElement | null;
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

  private updateAutoZoomButton(): void {
    const autoZoomBtn = domCache.get("replay-autozoom-btn");
    if (!autoZoomBtn) return;
    autoZoomBtn.style.opacity = this.state.autoZoom ? "1.0" : "0.5";
    autoZoomBtn.title = this.state.autoZoom
      ? "Auto-zoom enabled"
      : "Auto-zoom disabled";
    autoZoomBtn.setAttribute("aria-pressed", String(this.state.autoZoom));
  }

  /** Write to the polite live region (play/pause/seek end announcements) */
  private announce(message: string): void {
    const live = domCache.get("replay-live");
    if (!live) return;
    // Clear first so repeated identical messages are announced again
    live.textContent = "";
    live.textContent = message;
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

    if (!this.createReplayMarker()) return false;

    this.state.resetDrawState();
    this.setInitialView();
    this.updateReplayDisplay();

    return true;
  }

  private filterAndSortSegments(pathId: number): boolean {
    if (!this.app.fullPathSegments) return false;
    this.state.segments = this.app.fullPathSegments.filter((seg) => {
      return (
        seg.path_id === pathId && seg.time !== undefined && seg.time !== null
      );
    });

    if (this.state.segments.length === 0) return false;

    this.state.segments.sort((a, b) => (a.time ?? 0) - (b.time ?? 0));
    return true;
  }

  private calculateColorRanges(pathId: number): void {
    if (!this.app.currentData?.path_segments) return;

    const currentResSegments = this.app.currentData.path_segments.filter(
      (seg) => seg.path_id === pathId,
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

    const slider = domCache.get("replay-slider") as HTMLInputElement | null;
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

    if (this.state.autoZoom) {
      this.app.map.setView([startCoords[0], startCoords[1]], 16, {
        animate: true,
        duration: 0.8,
      });
      this.state.lastZoom = 16;
    } else {
      this.app.map.panTo([startCoords[0], startCoords[1]], {
        animate: true,
        duration: 0.8,
      });
    }
  }

  hideOtherLayersDuringReplay(): void {
    if (!this.app.map) return;

    if (this.app.heatmapLayer && this.app.heatmapVisible) {
      this.app.map.removeLayer(this.app.heatmapLayer);
    }

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
    }

    // Redraw once after the layer is back on the map so click handlers work
    // on mobile Safari.
    if (this.app.altitudeVisible) {
      this.app.map.addLayer(this.app.altitudeLayer);
      setTimeout(() => {
        this.app.layerManager.redrawAltitudePaths();
        if (this.app.map) this.app.map.invalidateSize();
      }, 50);
    }

    if (this.app.airspeedVisible) {
      this.app.map.addLayer(this.app.airspeedLayer);
      setTimeout(() => {
        this.app.layerManager.redrawAirspeedPaths();
        if (this.app.map) this.app.map.invalidateSize();
      }, 50);
    }

    this.setElementsDisabled(REPLAY_DISABLED_CONTROL_IDS, false);
  }

  private setElementsDisabled(ids: string[], disabled: boolean): void {
    ids.forEach((id) => {
      const el = domCache.get(id);
      if (el instanceof HTMLButtonElement || el instanceof HTMLSelectElement) {
        el.disabled = disabled;
      }
    });
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
              animate: true,
              duration: 0.5,
            });
            this.state.lastZoom = 16;
          }
        }
      }
    }

    this.state.playing = true;
    const playBtn = domCache.get("replay-play-btn");
    const pauseBtn = domCache.get("replay-pause-btn");
    if (playBtn) playBtn.style.display = "none";
    if (pauseBtn) pauseBtn.style.display = "inline-block";
    this.announce("Replay playing");

    this.state.lastFrameTime = null;

    const animateReplay = (timestamp: number) => {
      if (!this.state.playing) return;

      if (this.state.lastFrameTime === null) {
        this.state.lastFrameTime = timestamp;
      }
      const deltaMs = timestamp - this.state.lastFrameTime;
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
        animate: true,
        duration: 1.0,
      });
    }
  }

  pauseReplay(announce: boolean = true): void {
    const wasPlaying = this.state.playing;
    this.state.playing = false;
    const playBtn = domCache.get("replay-play-btn");
    const pauseBtn = domCache.get("replay-pause-btn");
    if (playBtn) playBtn.style.display = "inline-block";
    if (pauseBtn) pauseBtn.style.display = "none";

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

    if (newTime < this.state.currentTime) {
      // Drop only the segments after the new position; clearing the whole
      // layer would redraw the entire flight on every drag event
      this.renderer.removeSegmentsAfter(this, newTime);
    }

    this.state.currentTime = newTime;
    this.updateReplayDisplay(true);
  }

  changeReplaySpeed(): void {
    const select = domCache.get("replay-speed") as HTMLSelectElement | null;
    if (!select) return;

    this.state.speed = parseFloat(select.value);
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
    this.state.lastDrawnIndex = -1;

    for (let i = 0; i <= savedIndex && i < this.state.segments.length; i++) {
      const seg = this.state.segments[i];
      if (!seg || (seg.time ?? 0) > savedTime) continue;
      if (mode === "airspeed" && (seg.groundspeed_knots ?? 0) <= 0) continue;

      const color =
        mode === "altitude"
          ? getColorForAltitude(
              seg.altitude_ft ?? 0,
              this.state.colorMinAlt,
              this.state.colorMaxAlt,
            )
          : getColorForAirspeed(
              seg.groundspeed_knots ?? 0,
              this.state.colorMinSpeed,
              this.state.colorMaxSpeed,
            );

      L.polyline(seg.coords ?? [], {
        color,
        weight: 3,
        opacity: 0.8,
      }).addTo(this.state.layer);

      this.state.lastDrawnIndex = i;
    }
  }

  updateReplayDisplay(isManualSeek: boolean = false): void {
    this.renderer.updateDisplay(this, isManualSeek);
  }
}
