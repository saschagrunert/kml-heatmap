/**
 * Replay Manager - Handles flight replay functionality
 */
import * as L from "leaflet";
import type { MapApp } from "../mapApp";
import type { PathSegment } from "../types";
import { domCache } from "../utils/domCache";
import { ReplayRenderer } from "./replayRenderer";

export class ReplayManager {
  private app: MapApp;
  private renderer: ReplayRenderer;

  // Replay state
  replayActive: boolean;
  replayPlaying: boolean;
  replayCurrentTime: number;
  replayMaxTime: number;
  replaySpeed: number;
  replayInterval: number | null;
  replayLayer: L.LayerGroup | null;
  replaySegments: PathSegment[];
  replayAirplaneMarker: L.Marker | null;
  replayLastDrawnIndex: number;
  replayLastBearing: number | null;
  replayAnimationFrameId: number | null;
  replayLastFrameTime: number | null;
  replayColorMinAlt: number;
  replayColorMaxAlt: number;
  replayColorMinSpeed: number;
  replayColorMaxSpeed: number;
  replayAutoZoom: boolean;
  replayLastZoom: number | null;
  replayRecenterTimestamps: number[];

  constructor(app: MapApp) {
    this.app = app;
    this.renderer = new ReplayRenderer(app);

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

    // Replay state
    this.replayActive = false;
    this.replayPlaying = false;
    this.replayCurrentTime = 0;
    this.replayMaxTime = 0;
    this.replaySpeed = 50.0;
    this.replayInterval = null;
    this.replayLayer = null;
    this.replaySegments = [];
    this.replayAirplaneMarker = null;
    this.replayLastDrawnIndex = -1;
    this.replayLastBearing = null;
    this.replayAnimationFrameId = null;
    this.replayLastFrameTime = null;
    this.replayColorMinAlt = 0;
    this.replayColorMaxAlt = 10000;
    this.replayColorMinSpeed = 0;
    this.replayColorMaxSpeed = 200;
    this.replayAutoZoom = false;
    this.replayLastZoom = null;
    this.replayRecenterTimestamps = [];
  }

  toggleReplay(): void {
    const panel = domCache.get("replay-controls");
    if (!panel) return;

    if (this.replayActive) {
      // Stop replay and hide panel
      this.stopReplay();
      panel.style.display = "none";
      this.replayActive = false;
      const replayBtn = domCache.get("replay-btn");
      if (replayBtn) replayBtn.textContent = "▶️ Replay";

      // Remove replay-active class from body
      document.body.classList.remove("replay-active");

      // Remove airplane marker when closing replay completely
      if (this.replayAirplaneMarker && this.app.map) {
        this.app.map.removeLayer(this.replayAirplaneMarker);
        this.replayAirplaneMarker = null;
      }

      // Remove replay layer from map (important for mobile Safari touch events)
      if (this.replayLayer && this.app.map) {
        this.app.map.removeLayer(this.replayLayer);
      }

      // Restore visibility of other layers
      this.restoreLayerVisibility();

      // Ensure altitude layer is visible for path selection after replay
      // (paths are only clickable when altitude or airspeed layer is shown)
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
        // Add layer first, then redraw with a small delay for mobile Safari
        this.app.map.addLayer(this.app.altitudeLayer);
      }

      // Always force a redraw on mobile Safari to ensure click handlers work
      // This is necessary even if the layer was already visible before replay
      setTimeout(() => {
        if (this.app.altitudeVisible) {
          this.app.layerManager.redrawAltitudePaths();
        } else if (this.app.airspeedVisible) {
          this.app.layerManager.redrawAirspeedPaths();
        }
        // Force map to recognize the interactive elements
        if (this.app.map) this.app.map.invalidateSize();
      }, 100);

      // Update button opacity based on selection
      this.updateReplayButtonState();
      this.app.stateManager.saveMapState();
    } else {
      // Check if exactly one path is selected
      if (this.app.selectedPathIds.size !== 1) {
        return; // Do nothing if wrong number of paths selected
      }

      // Initialize and show replay
      if (this.initializeReplay()) {
        panel.style.display = "block";
        this.replayActive = true;
        const replayBtn = domCache.get("replay-btn");
        if (replayBtn) {
          replayBtn.textContent = "⏹️ Replay";
          replayBtn.style.opacity = "1.0";
        }

        // Initialize auto-zoom button style
        const autoZoomBtn = domCache.get(
          "replay-autozoom-btn"
        ) as HTMLButtonElement | null;
        if (autoZoomBtn) {
          autoZoomBtn.style.opacity = this.replayAutoZoom ? "1.0" : "0.5";
          autoZoomBtn.title = this.replayAutoZoom
            ? "Auto-zoom enabled"
            : "Auto-zoom disabled";
        }

        // Add replay-active class to body for mobile legend hiding
        document.body.classList.add("replay-active");

        // Hide other layers during replay
        this.hideOtherLayersDuringReplay();
        this.app.stateManager.saveMapState();
      }
    }
  }

  updateReplayButtonState(): void {
    // Enable replay button only when exactly one path is selected AND timing data is available
    const btn = domCache.get("replay-btn") as HTMLButtonElement | null;
    if (!btn) return;

    // Check if timing data is available (use fullStats which has groundspeed data)
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
    // Get all segments with time data from full resolution
    if (!this.app.fullPathSegments) {
      alert(
        "No flight data available for replay. Please wait for data to load or refresh the page."
      );
      return false;
    }

    // Get the single selected path ID
    const selectedPathId = Array.from(this.app.selectedPathIds)[0];

    // Filter segments that belong to selected path and have time data
    this.replaySegments = this.app.fullPathSegments.filter((seg) => {
      return (
        seg.path_id === selectedPathId &&
        seg.time !== undefined &&
        seg.time !== null
      );
    });

    if (this.replaySegments.length === 0) {
      // Button should be disabled when there's no timing data, but check just in case
      return false;
    }

    // Sort by time
    this.replaySegments.sort((a, b) => {
      return (a.time || 0) - (b.time || 0);
    });

    // Calculate color ranges from CURRENT RESOLUTION data (not full resolution)
    // This ensures replay colors match the selected path colors on screen
    if (this.app.currentData && this.app.currentData.path_segments) {
      const currentResSegments = this.app.currentData.path_segments.filter(
        (seg) => {
          return seg.path_id === selectedPathId;
        }
      );

      if (currentResSegments.length > 0) {
        // Use current resolution altitude range
        const altitudes = currentResSegments.map((s) => {
          return s.altitude_ft || 0;
        });
        const altRange = window.KMLHeatmap.findMinMax(altitudes);
        this.replayColorMinAlt = altRange.min;
        this.replayColorMaxAlt = altRange.max;

        // Use current resolution groundspeed range
        const groundspeeds = currentResSegments
          .map((s) => {
            return s.groundspeed_knots || 0;
          })
          .filter((s) => {
            return s > 0;
          });
        if (groundspeeds.length > 0) {
          const speedRange = window.KMLHeatmap.findMinMax(groundspeeds);
          this.replayColorMinSpeed = speedRange.min;
          this.replayColorMaxSpeed = speedRange.max;
        } else {
          this.replayColorMinSpeed = this.app.airspeedRange.min;
          this.replayColorMaxSpeed = this.app.airspeedRange.max;
        }
      } else {
        // Fallback to full resolution if current resolution not available
        const altitudes = this.replaySegments.map((s) => {
          return s.altitude_ft || 0;
        });
        const altRange = window.KMLHeatmap.findMinMax(altitudes);
        this.replayColorMinAlt = altRange.min;
        this.replayColorMaxAlt = altRange.max;

        const groundspeeds = this.replaySegments
          .map((s) => {
            return s.groundspeed_knots || 0;
          })
          .filter((s) => {
            return s > 0;
          });
        if (groundspeeds.length > 0) {
          const speedRange = window.KMLHeatmap.findMinMax(groundspeeds);
          this.replayColorMinSpeed = speedRange.min;
          this.replayColorMaxSpeed = speedRange.max;
        } else {
          this.replayColorMinSpeed = this.app.airspeedRange.min;
          this.replayColorMaxSpeed = this.app.airspeedRange.max;
        }
      }
    }

    // Find max time
    const lastSegment = this.replaySegments[this.replaySegments.length - 1];
    this.replayMaxTime = lastSegment?.time || 0;

    // Update UI
    const slider = domCache.get("replay-slider") as HTMLInputElement | null;
    if (slider) {
      slider.max = this.replayMaxTime.toString();
    }
    const sliderEnd = domCache.get("replay-slider-end");
    if (sliderEnd) {
      sliderEnd.textContent = window.KMLHeatmap.formatTime(this.replayMaxTime);
    }

    // Update legends to show selected path's color ranges
    this.app.layerManager.updateAltitudeLegend(
      this.replayColorMinAlt,
      this.replayColorMaxAlt
    );
    this.app.layerManager.updateAirspeedLegend(
      this.replayColorMinSpeed,
      this.replayColorMaxSpeed
    );

    // Create replay layer
    if (!this.replayLayer) {
      this.replayLayer = L.layerGroup();
    }
    this.replayLayer.clearLayers();
    if (this.app.map) {
      this.replayLayer.addTo(this.app.map);
    }

    // Remove old airplane marker if it exists
    if (this.replayAirplaneMarker && this.app.map) {
      this.app.map.removeLayer(this.replayAirplaneMarker);
      this.replayAirplaneMarker = null;
    }

    // Create airplane marker
    const airplaneIcon = L.divIcon({
      html: '<div class="replay-airplane-icon">✈️</div>',
      iconSize: [32, 32],
      iconAnchor: [16, 16],
      className: "",
    });

    // Position at start of path
    const firstSegment = this.replaySegments[0];
    const startCoords = firstSegment?.coords?.[0];
    if (!startCoords || !this.app.map) return false;

    this.replayAirplaneMarker = L.marker([startCoords[0], startCoords[1]], {
      icon: airplaneIcon,
      zIndexOffset: 1000,
    });
    this.replayAirplaneMarker.addTo(this.app.map);

    // Add smooth CSS transition to the marker element for fluid movement
    // Using a shorter transition time (80ms) to keep up with high speed playback (100x, 200x)
    const markerElement = this.replayAirplaneMarker.getElement();
    if (markerElement) {
      markerElement.style.transition = "transform 0.08s linear";
      markerElement.style.cursor = "pointer";
      markerElement.style.pointerEvents = "auto";

      // Add click handler directly to the DOM element for better reliability
      markerElement.addEventListener("click", (e: Event) => {
        e.stopPropagation();
        if (this.replayAirplaneMarker!.isPopupOpen()) {
          this.replayAirplaneMarker!.closePopup();
        } else {
          this.updateReplayAirplanePopup();
        }
      });
    }

    // Reset time and drawing state
    this.replayCurrentTime = 0;
    this.replayLastDrawnIndex = -1;
    this.replayLastBearing = null;

    // Set initial zoom level to show takeoff details at airport
    // Only do this if auto-zoom is enabled, otherwise respect user's current zoom
    if (this.replayAutoZoom && this.app.map) {
      this.app.map.setView([startCoords[0], startCoords[1]], 16, {
        animate: true,
        duration: 0.8,
      });
      this.replayLastZoom = 16;
    } else if (this.app.map) {
      // Just center on start position without changing zoom
      this.app.map.panTo([startCoords[0], startCoords[1]], {
        animate: true,
        duration: 0.8,
      });
    }

    this.updateReplayDisplay();

    return true;
  }

  hideOtherLayersDuringReplay(): void {
    if (!this.app.map) return;

    // Hide heatmap
    if (this.app.heatmapLayer && this.app.heatmapVisible) {
      this.app.map.removeLayer(this.app.heatmapLayer);
    }

    // Hide altitude layer but keep legend visible if it was visible
    if (this.app.altitudeVisible) {
      this.app.map.removeLayer(this.app.altitudeLayer);
      // Keep altitude legend visible during replay
    }

    // Hide airspeed layer but keep legend visible if it was visible
    if (this.app.airspeedVisible) {
      this.app.map.removeLayer(this.app.airspeedLayer);
      // Keep airspeed legend visible during replay
    }

    // Disable layer toggle buttons and filters during replay
    // BUT keep altitude and airspeed buttons enabled for profile switching
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

    // Restore heatmap
    if (this.app.heatmapLayer && this.app.heatmapVisible) {
      this.app.map.addLayer(this.app.heatmapLayer);
      if (this.app.heatmapLayer._canvas) {
        this.app.heatmapLayer._canvas.style.pointerEvents = "none";
      }
    }

    // Restore altitude layer (legend was kept visible during replay)
    if (this.app.altitudeVisible) {
      // Add layer first, then redraw with delay for mobile Safari
      this.app.map.addLayer(this.app.altitudeLayer);
      setTimeout(() => {
        // Redraw altitude paths to ensure click handlers work on mobile Safari
        this.app.layerManager.redrawAltitudePaths();
        if (this.app.map) this.app.map.invalidateSize();
      }, 50);
      // Legend stays visible, no need to re-show
    }

    // Restore airspeed layer (legend was kept visible during replay)
    if (this.app.airspeedVisible) {
      // Add layer first, then redraw with delay for mobile Safari
      this.app.map.addLayer(this.app.airspeedLayer);
      setTimeout(() => {
        // Redraw airspeed paths to ensure click handlers work on mobile Safari
        this.app.layerManager.redrawAirspeedPaths();
        if (this.app.map) this.app.map.invalidateSize();
      }, 50);
      // Legend stays visible, no need to re-show
    }

    // Re-enable layer toggle buttons and filters
    // (altitude and airspeed were never disabled during replay)
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
    if (!this.replayActive || !this.app.map) return;

    // If at the end, restart from beginning
    if (this.replayCurrentTime >= this.replayMaxTime) {
      this.replayCurrentTime = 0;
      this.replayLastDrawnIndex = -1;
      if (this.replayLayer) this.replayLayer.clearLayers();

      // Reset airplane to start position
      if (
        this.replayAirplaneMarker &&
        this.replaySegments.length > 0 &&
        this.app.map
      ) {
        const firstSeg = this.replaySegments[0];
        const startCoords = firstSeg?.coords?.[0];
        if (startCoords) {
          this.replayAirplaneMarker.setLatLng([startCoords[0], startCoords[1]]);

          // Reset to initial zoom if auto-zoom is enabled
          if (this.replayAutoZoom) {
            this.app.map.setView([startCoords[0], startCoords[1]], 16, {
              animate: true,
              duration: 0.5,
            });
            this.replayLastZoom = 16;
          }
        }
      }

      // Reset recenter tracking
      this.replayRecenterTimestamps = [];
      this.replayLastBearing = null;
    }

    this.replayPlaying = true;
    const playBtn = domCache.get("replay-play-btn");
    const pauseBtn = domCache.get("replay-pause-btn");
    if (playBtn) playBtn.style.display = "none";
    if (pauseBtn) pauseBtn.style.display = "inline-block";

    // Reset frame time for smooth animation start
    this.replayLastFrameTime = null;

    // Start animation loop using requestAnimationFrame for browser-synchronized updates
    const animateReplay = (timestamp: number) => {
      if (!this.replayPlaying) return;

      // Calculate delta time based on actual elapsed time
      if (this.replayLastFrameTime === null) {
        this.replayLastFrameTime = timestamp;
      }
      const deltaMs = timestamp - this.replayLastFrameTime;
      this.replayLastFrameTime = timestamp;

      // Update replay time based on actual elapsed time and speed multiplier
      const deltaTime = (deltaMs / 1000) * this.replaySpeed;
      this.replayCurrentTime += deltaTime;

      if (this.replayCurrentTime >= this.replayMaxTime) {
        this.replayCurrentTime = this.replayMaxTime;
        this.pauseReplay();

        // Zoom out to show the full path when replay ends
        if (this.replaySegments.length > 0 && this.app.map) {
          // Collect all coordinates from the path
          const allCoords: [number, number][] = [];
          this.replaySegments.forEach((seg) => {
            if (seg.coords && seg.coords.length > 0) {
              seg.coords.forEach((coord) => {
                allCoords.push(coord as [number, number]);
              });
            }
          });

          // Fit the map to show all coordinates
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
        // Continue animation loop
        this.replayAnimationFrameId = requestAnimationFrame(animateReplay);
      }

      this.updateReplayDisplay();
    };

    // Start the animation
    this.replayAnimationFrameId = requestAnimationFrame(animateReplay);
    this.app.stateManager.saveMapState();
  }

  pauseReplay(): void {
    this.replayPlaying = false;
    const playBtn = domCache.get("replay-play-btn");
    const pauseBtn = domCache.get("replay-pause-btn");
    if (playBtn) playBtn.style.display = "inline-block";
    if (pauseBtn) pauseBtn.style.display = "none";

    // Cancel animation frame
    if (this.replayAnimationFrameId) {
      cancelAnimationFrame(this.replayAnimationFrameId);
      this.replayAnimationFrameId = null;
    }

    // Reset frame time
    this.replayLastFrameTime = null;
    this.app.stateManager.saveMapState();
  }

  stopReplay(): void {
    this.pauseReplay();
    this.replayCurrentTime = 0;
    this.replayLastDrawnIndex = -1;
    this.replayLastBearing = null; // Reset bearing
    this.replayRecenterTimestamps = []; // Reset recenter tracking
    if (this.replayLayer) {
      this.replayLayer.clearLayers();
    }
    // Reset airplane to start position instead of removing it
    if (this.replayAirplaneMarker && this.replaySegments.length > 0) {
      const firstSeg = this.replaySegments[0];
      const startCoords = firstSeg?.coords?.[0];
      if (startCoords) {
        this.replayAirplaneMarker.setLatLng([startCoords[0], startCoords[1]]);
      }
    }
    this.updateReplayDisplay();
  }

  seekReplay(value: string): void {
    const newTime = parseFloat(value);

    // If seeking backward, need to clear and redraw
    if (newTime < this.replayCurrentTime) {
      if (this.replayLayer) this.replayLayer.clearLayers();
      this.replayLastDrawnIndex = -1;
    }

    this.replayCurrentTime = newTime;
    this.updateReplayDisplay(true); // Pass true to indicate this is a manual seek
    this.app.stateManager.saveMapState();
  }

  changeReplaySpeed(): void {
    const select = domCache.get("replay-speed") as HTMLSelectElement | null;
    if (!select) return;

    this.replaySpeed = parseFloat(select.value);
    this.app.stateManager.saveMapState();
  }

  toggleAutoZoom(): void {
    this.replayAutoZoom = !this.replayAutoZoom;
    const autoZoomBtn = domCache.get("replay-autozoom-btn");
    if (autoZoomBtn) {
      autoZoomBtn.style.opacity = this.replayAutoZoom ? "1.0" : "0.5";
      autoZoomBtn.title = this.replayAutoZoom
        ? "Auto-zoom enabled"
        : "Auto-zoom disabled";
    }
    this.app.stateManager.saveMapState();
  }

  updateReplayDisplay(isManualSeek: boolean = false): void {
    this.renderer.updateDisplay(this, isManualSeek);
  }
}
