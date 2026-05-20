/**
 * Replay Manager - Handles flight replay functionality
 */
import * as L from "leaflet";
import type { MapApp } from "../mapApp";
import { domCache } from "../utils/domCache";
import { showToast } from "../utils/toast";
import { ReplayRenderer } from "./replayRenderer";
import { ReplayState } from "./replayState";

export class ReplayManager {
  private app: MapApp;
  private renderer: ReplayRenderer;
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
      "replay-speed",
      "replay-autozoom-btn",
      "altitude-btn",
      "altitude-legend",
    ]);
  }

  toggleReplay(): void {
    const panel = domCache.get("replay-controls");
    if (!panel) return;

    if (this.state.active) {
      // Stop replay and hide panel
      this.stopReplay();
      panel.style.display = "none";
      this.state.active = false;
      const replayBtn = domCache.get("replay-btn");
      if (replayBtn) replayBtn.textContent = "▶️ Replay";

      // Remove replay-active class from body
      document.body.classList.remove("replay-active");

      // Remove airplane marker when closing replay completely
      if (this.state.airplaneMarker && this.app.map) {
        this.app.map.removeLayer(this.state.airplaneMarker);
        this.state.airplaneMarker = null;
      }

      // Remove replay layer from map (important for mobile Safari touch events)
      if (this.state.layer && this.app.map) {
        this.app.map.removeLayer(this.state.layer);
      }

      // Restore visibility of other layers
      this.restoreLayerVisibility();

      // Ensure altitude layer is visible for path selection after replay
      if (
        !this.app.altitudeVisible &&
        !this.app.airspeedVisible &&
        this.app.map
      ) {
        this.app.altitudeVisible = true;
        const altBtn = domCache.get("altitude-btn");
        if (altBtn) altBtn.style.opacity = "1.0";
        const altLegend = domCache.get("altitude-legend");
        if (altLegend) altLegend.style.display = "block";
        this.app.map.addLayer(this.app.altitudeLayer);
      }

      // Force a redraw on mobile Safari to ensure click handlers work
      setTimeout(() => {
        if (this.app.altitudeVisible) {
          this.app.layerManager.redrawAltitudePaths();
        } else if (this.app.airspeedVisible) {
          this.app.layerManager.redrawAirspeedPaths();
        }
        if (this.app.map) this.app.map.invalidateSize();
      }, 100);

      this.updateReplayButtonState();
      this.app.stateManager.saveMapState();
    } else {
      if (this.app.selectedPathIds.size !== 1) {
        return;
      }

      if (this.initializeReplay()) {
        panel.style.display = "block";
        this.state.active = true;
        const replayBtn = domCache.get("replay-btn");
        if (replayBtn) {
          replayBtn.textContent = "⏹️ Replay";
          replayBtn.style.opacity = "1.0";
        }

        const autoZoomBtn = domCache.get(
          "replay-autozoom-btn"
        ) as HTMLButtonElement | null;
        if (autoZoomBtn) {
          autoZoomBtn.style.opacity = this.state.autoZoom ? "1.0" : "0.5";
          autoZoomBtn.title = this.state.autoZoom
            ? "Auto-zoom enabled"
            : "Auto-zoom disabled";
        }

        document.body.classList.add("replay-active");
        this.hideOtherLayersDuringReplay();
        this.app.stateManager.saveMapState();
      }
    }
  }

  updateReplayButtonState(): void {
    const btn = domCache.get("replay-btn") as HTMLButtonElement | null;
    if (!btn) return;

    const hasTimingData =
      this.app.fullStats &&
      this.app.fullStats.max_groundspeed_knots !== undefined &&
      this.app.fullStats.max_groundspeed_knots > 0;

    if (this.app.selectedPathIds.size === 1 && hasTimingData) {
      btn.style.opacity = "1.0";
      btn.disabled = false;
      btn.setAttribute("aria-disabled", "false");
    } else {
      btn.style.opacity = "0.5";
      btn.disabled = true;
      btn.setAttribute("aria-disabled", "true");
    }
  }

  updateReplayAirplanePopup(): void {
    this.renderer.updateAirplanePopup(this);
  }

  initializeReplay(): boolean {
    if (!this.app.fullPathSegments) {
      showToast(
        "No flight data available for replay. Please wait for data to load or refresh the page.",
        "error"
      );
      return false;
    }

    const selectedPathId = Array.from(this.app.selectedPathIds)[0];
    if (selectedPathId === undefined) return false;
    if (!this.filterAndSortSegments(selectedPathId)) return false;

    this.calculateColorRanges(selectedPathId);
    this.setupReplayUI();

    if (!this.createReplayMarker()) return false;

    this.state.resetDrawState();
    this.setInitialView();
    this.updateReplayDisplay();

    return true;
  }

  private filterAndSortSegments(pathId: number): boolean {
    this.state.segments = this.app.fullPathSegments!.filter((seg) => {
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
      (seg) => seg.path_id === pathId
    );

    const sourceSegments =
      currentResSegments.length > 0 ? currentResSegments : this.state.segments;

    const altitudes = sourceSegments.map((s) => s.altitude_ft ?? 0);
    const altRange = window.KMLHeatmap.findMinMax(altitudes);
    this.state.colorMinAlt = altRange.min;
    this.state.colorMaxAlt = altRange.max;

    const groundspeeds = sourceSegments
      .map((s) => s.groundspeed_knots ?? 0)
      .filter((s) => s > 0);
    if (groundspeeds.length > 0) {
      const speedRange = window.KMLHeatmap.findMinMax(groundspeeds);
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
      sliderEnd.textContent = window.KMLHeatmap.formatTime(this.state.maxTime);
    }

    this.app.layerManager.updateAltitudeLegend(
      this.state.colorMinAlt,
      this.state.colorMaxAlt
    );
    this.app.layerManager.updateAirspeedLegend(
      this.state.colorMinSpeed,
      this.state.colorMaxSpeed
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
    });
    this.state.airplaneMarker.addTo(this.app.map);

    const markerElement = this.state.airplaneMarker.getElement();
    if (markerElement) {
      markerElement.style.transition = "transform 0.08s linear";
      markerElement.style.cursor = "pointer";
      markerElement.style.pointerEvents = "auto";

      markerElement.addEventListener("click", (e: Event) => {
        e.stopPropagation();
        if (this.state.airplaneMarker!.isPopupOpen()) {
          this.state.airplaneMarker!.closePopup();
        } else {
          this.updateReplayAirplanePopup();
        }
      });
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

    const disableElements = [
      "heatmap-btn",
      "airports-btn",
      "aviation-btn",
      "year-select",
      "aircraft-select",
    ];

    disableElements.forEach((id) => {
      const el = document.getElementById(id) as
        | HTMLButtonElement
        | HTMLSelectElement
        | null;
      if (el) el.disabled = true;
    });
  }

  restoreLayerVisibility(): void {
    if (!this.app.map) return;

    if (this.app.heatmapLayer && this.app.heatmapVisible) {
      this.app.map.addLayer(this.app.heatmapLayer);
      if (this.app.heatmapLayer._canvas) {
        this.app.heatmapLayer._canvas.style.pointerEvents = "none";
      }
    }

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

    const enableElements = [
      "heatmap-btn",
      "airports-btn",
      "aviation-btn",
      "year-select",
      "aircraft-select",
    ];

    enableElements.forEach((id) => {
      const el = document.getElementById(id) as
        | HTMLButtonElement
        | HTMLSelectElement
        | null;
      if (el) el.disabled = false;
    });
  }

  playReplay(): void {
    if (!this.state.active || !this.app.map) return;

    if (this.state.currentTime >= this.state.maxTime) {
      this.state.currentTime = 0;
      this.state.lastDrawnIndex = -1;
      if (this.state.layer) this.state.layer.clearLayers();

      if (
        this.state.airplaneMarker &&
        this.state.segments.length > 0 &&
        this.app.map
      ) {
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

      this.state.recenterTimestamps = [];
      this.state.lastBearing = null;
    }

    this.state.playing = true;
    const playBtn = domCache.get("replay-play-btn");
    const pauseBtn = domCache.get("replay-pause-btn");
    if (playBtn) playBtn.style.display = "none";
    if (pauseBtn) pauseBtn.style.display = "inline-block";

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
        this.pauseReplay();

        if (this.state.segments.length > 0 && this.app.map) {
          const allCoords: [number, number][] = [];
          this.state.segments.forEach((seg) => {
            if (seg.coords && seg.coords.length > 0) {
              seg.coords.forEach((coord) => {
                allCoords.push(coord);
              });
            }
          });

          if (allCoords.length > 0) {
            const bounds = L.latLngBounds(allCoords);
            this.app.map.fitBounds(bounds, {
              padding: [50, 50],
              animate: true,
              duration: 1.0,
            });
          }
        }
      } else {
        this.state.animationFrameId = requestAnimationFrame(animateReplay);
      }

      this.updateReplayDisplay();
    };

    this.state.animationFrameId = requestAnimationFrame(animateReplay);
    this.app.stateManager.saveMapState();
  }

  pauseReplay(): void {
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
    this.app.stateManager.saveMapState();
  }

  stopReplay(): void {
    this.pauseReplay();
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
  }

  seekReplay(value: string): void {
    const newTime = parseFloat(value);

    if (newTime < this.state.currentTime) {
      if (this.state.layer) this.state.layer.clearLayers();
      this.state.lastDrawnIndex = -1;
    }

    this.state.currentTime = newTime;
    this.updateReplayDisplay(true);
    this.app.stateManager.saveMapState();
  }

  changeReplaySpeed(): void {
    const select = domCache.get("replay-speed") as HTMLSelectElement | null;
    if (!select) return;

    this.state.speed = parseFloat(select.value);
    this.app.stateManager.saveMapState();
  }

  toggleAutoZoom(): void {
    this.state.autoZoom = !this.state.autoZoom;
    const autoZoomBtn = domCache.get("replay-autozoom-btn");
    if (autoZoomBtn) {
      autoZoomBtn.style.opacity = this.state.autoZoom ? "1.0" : "0.5";
      autoZoomBtn.title = this.state.autoZoom
        ? "Auto-zoom enabled"
        : "Auto-zoom disabled";
    }
    this.app.stateManager.saveMapState();
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

      const value =
        mode === "altitude"
          ? (seg.altitude_ft ?? 0)
          : (seg.groundspeed_knots ?? 0);
      const min =
        mode === "altitude" ? this.state.colorMinAlt : this.state.colorMinSpeed;
      const max =
        mode === "altitude" ? this.state.colorMaxAlt : this.state.colorMaxSpeed;
      const color = window.KMLHeatmap.getColorForAltitude(value, min, max);

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
