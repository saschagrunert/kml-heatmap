/**
 * Replay Renderer - Handles rendering concerns for flight replay
 */
import * as L from "leaflet";
import type { MapApp } from "../mapApp";
import type { ReplayManager } from "./replayManager";
import type { PathSegment } from "../types";
import { domCache } from "../utils/domCache";

export class ReplayRenderer {
  private app: MapApp;

  constructor(app: MapApp) {
    this.app = app;
  }

  updateAirplanePopup(replayManager: ReplayManager): void {
    if (!replayManager.replayAirplaneMarker || !replayManager.replayActive)
      return;

    // Find the current segment for data
    let currentSegment: PathSegment | null = null;
    for (let i = 0; i < replayManager.replaySegments.length; i++) {
      const seg = replayManager.replaySegments[i];
      if (seg && (seg.time || 0) <= replayManager.replayCurrentTime) {
        currentSegment = seg;
      } else {
        break;
      }
    }

    if (!currentSegment && replayManager.replaySegments.length > 0) {
      currentSegment = replayManager.replaySegments[0]!;
    }

    if (!currentSegment) return;

    // Build popup content
    let popupContent =
      "<div style=\"font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; min-width: 180px; padding: 8px 4px; background-color: #2b2b2b; color: #ffffff;\">";

    popupContent +=
      '<div style="font-size: 14px; font-weight: bold; color: #4facfe; margin-bottom: 8px; padding-bottom: 6px; border-bottom: 2px solid #4facfe; display: flex; align-items: center; gap: 6px;">';
    popupContent += '<span style="font-size: 16px;">✈️</span>';
    popupContent += "<span>Current Position</span>";
    popupContent += "</div>";

    // Altitude
    const altFt = currentSegment.altitude_ft || 0;
    // Round altitude to nearest 50ft
    const altFtRounded = Math.round(altFt / 50) * 50;
    const altMRounded = Math.round(altFtRounded * 0.3048);
    // Get color based on current altitude using the same scale as the path
    const altColor = window.KMLHeatmap.getColorForAltitude(
      altFt,
      replayManager.replayColorMinAlt,
      replayManager.replayColorMaxAlt
    );
    // Convert rgb color to rgba with transparency for background
    const altColorBg = altColor
      .replace("rgb(", "rgba(")
      .replace(")", ", 0.15)");
    popupContent += '<div style="margin-bottom: 8px;">';
    popupContent +=
      '<div style="font-size: 11px; color: #999; margin-bottom: 2px; text-transform: uppercase; letter-spacing: 0.5px;">Altitude (MSL)</div>';
    popupContent +=
      '<div style="background: ' +
      altColorBg +
      "; padding: 6px 8px; border-radius: 6px; border-left: 3px solid " +
      altColor +
      ';">';
    popupContent +=
      '<span style="font-size: 16px; font-weight: bold; color: ' +
      altColor +
      ';">' +
      altFtRounded +
      " ft</span>";
    popupContent +=
      '<span style="font-size: 12px; color: #ccc; margin-left: 6px;">(' +
      altMRounded +
      " m)</span>";
    popupContent += "</div>";
    popupContent += "</div>";

    // Groundspeed
    const speedKt = currentSegment.groundspeed_knots || 0;
    const speedKmh = speedKt * 1.852;
    // Round groundspeed to whole numbers
    const speedKtRounded = Math.round(speedKt);
    const speedKmhRounded = Math.round(speedKmh);
    // Get color based on current groundspeed using the same scale as the path
    const speedColor = window.KMLHeatmap.getColorForAirspeed(
      speedKt,
      replayManager.replayColorMinSpeed,
      replayManager.replayColorMaxSpeed
    );
    // Convert rgb color to rgba with transparency for background
    const speedColorBg = speedColor
      .replace("rgb(", "rgba(")
      .replace(")", ", 0.15)");
    popupContent += '<div style="margin-bottom: 8px;">';
    popupContent +=
      '<div style="font-size: 11px; color: #999; margin-bottom: 2px; text-transform: uppercase; letter-spacing: 0.5px;">Groundspeed</div>';
    popupContent +=
      '<div style="background: ' +
      speedColorBg +
      "; padding: 6px 8px; border-radius: 6px; border-left: 3px solid " +
      speedColor +
      ';">';
    popupContent +=
      '<span style="font-size: 16px; font-weight: bold; color: ' +
      speedColor +
      ';">' +
      speedKtRounded +
      " kt</span>";
    popupContent +=
      '<span style="font-size: 12px; color: #ccc; margin-left: 6px;">(' +
      speedKmhRounded +
      " km/h)</span>";
    popupContent += "</div>";
    popupContent += "</div>";

    popupContent += "</div>";

    // Update or create popup
    if (!replayManager.replayAirplaneMarker.getPopup()) {
      replayManager.replayAirplaneMarker.bindPopup(popupContent, {
        autoPanPadding: [50, 50],
      });
    } else {
      replayManager.replayAirplaneMarker.getPopup()!.setContent(popupContent);
    }

    // Open the popup
    replayManager.replayAirplaneMarker.openPopup();
  }

  updateDisplay(
    replayManager: ReplayManager,
    isManualSeek: boolean = false
  ): void {
    // Update time display
    const timeDisplay = domCache.get("replay-time-display");
    if (timeDisplay) {
      timeDisplay.textContent =
        window.KMLHeatmap.formatTime(replayManager.replayCurrentTime) +
        " / " +
        window.KMLHeatmap.formatTime(replayManager.replayMaxTime);
    }

    // Update slider position
    const slider = domCache.get("replay-slider") as HTMLInputElement | null;
    if (slider) slider.value = replayManager.replayCurrentTime.toString();

    const sliderStart = domCache.get("replay-slider-start");
    if (sliderStart) {
      sliderStart.textContent = window.KMLHeatmap.formatTime(
        replayManager.replayCurrentTime
      );
    }

    // Find current position in replay timeline (for airplane positioning)
    let lastSegment: PathSegment | null = null;
    let nextSegment: PathSegment | null = null;
    let currentIndex = -1;

    // Search through ALL segments to find airplane position
    for (let i = 0; i < replayManager.replaySegments.length; i++) {
      const seg = replayManager.replaySegments[i];
      if (seg && (seg.time || 0) <= replayManager.replayCurrentTime) {
        lastSegment = seg;
        currentIndex = i;
      } else if (seg) {
        // Found the next segment beyond current time
        nextSegment = seg;
        break;
      }
    }

    // Draw path segments (separate loop for incremental rendering)
    if (replayManager.replayLayer) {
      // Determine which color scheme to use based on visible layer
      const useAirspeedColors =
        this.app.airspeedVisible && !this.app.altitudeVisible;

      for (let i = 0; i < replayManager.replaySegments.length; i++) {
        const seg = replayManager.replaySegments[i];
        if (!seg) continue;

        // Don't draw any segments when at time 0 (stopped/reset state)
        if (
          (seg.time || 0) <= replayManager.replayCurrentTime &&
          replayManager.replayCurrentTime > 0
        ) {
          // Only draw if we haven't drawn this segment yet (incremental rendering)
          if (i > replayManager.replayLastDrawnIndex) {
            // Calculate color based on selected profile using replay-specific ranges
            let segmentColor: string;
            if (useAirspeedColors && (seg.groundspeed_knots || 0) > 0) {
              // Use airspeed colors with selected path's groundspeed range
              segmentColor = window.KMLHeatmap.getColorForAltitude(
                seg.groundspeed_knots ?? 0,
                replayManager.replayColorMinSpeed,
                replayManager.replayColorMaxSpeed
              );
            } else {
              // Use altitude colors with selected path's altitude range (default)
              segmentColor = window.KMLHeatmap.getColorForAltitude(
                seg.altitude_ft ?? 0,
                replayManager.replayColorMinAlt,
                replayManager.replayColorMaxAlt
              );
            }

            L.polyline(seg.coords || [], {
              color: segmentColor,
              weight: 3,
              opacity: 0.8,
            }).addTo(replayManager.replayLayer);

            // Update last drawn index incrementally during the loop
            replayManager.replayLastDrawnIndex = i;
          }
        } else {
          break;
        }
      }
    }

    // Update airplane marker position and rotation
    // Ensure marker is on the map (in case it was removed during seeking/zooming)
    if (
      replayManager.replayAirplaneMarker &&
      this.app.map &&
      !this.app.map.hasLayer(replayManager.replayAirplaneMarker)
    ) {
      replayManager.replayAirplaneMarker.addTo(this.app.map);
    }

    if (replayManager.replayAirplaneMarker && this.app.map) {
      // If we have a lastSegment, use it for positioning
      if (lastSegment) {
        let currentPos: [number, number];
        let bearing: number;

        if (
          nextSegment &&
          (lastSegment.time || 0) < replayManager.replayCurrentTime
        ) {
          // Interpolate between last and next segment
          const timeFraction =
            (replayManager.replayCurrentTime - (lastSegment.time || 0)) /
            ((nextSegment.time || 0) - (lastSegment.time || 0));
          const lat1 = lastSegment.coords?.[1]?.[0] || 0;
          const lon1 = lastSegment.coords?.[1]?.[1] || 0;
          const lat2 = nextSegment.coords?.[0]?.[0] || 0;
          const lon2 = nextSegment.coords?.[0]?.[1] || 0;

          currentPos = [
            lat1 + (lat2 - lat1) * timeFraction,
            lon1 + (lon2 - lon1) * timeFraction,
          ];

          // Calculate bearing for rotation
          bearing = window.KMLHeatmap.calculateBearing(lat1, lon1, lat2, lon2);
        } else {
          // Use end of last segment
          currentPos = (lastSegment.coords?.[1] || [0, 0]) as [number, number];

          // Calculate bearing from this segment
          const lat1 = lastSegment.coords?.[0]?.[0] || 0;
          const lon1 = lastSegment.coords?.[0]?.[1] || 0;
          const lat2 = lastSegment.coords?.[1]?.[0] || 0;
          const lon2 = lastSegment.coords?.[1]?.[1] || 0;
          bearing = window.KMLHeatmap.calculateBearing(lat1, lon1, lat2, lon2);
        }

        // Calculate smoothed bearing by looking ahead several segments
        const smoothedBearing = window.KMLHeatmap.calculateSmoothedBearing(
          replayManager.replaySegments,
          currentIndex,
          5
        );
        if (smoothedBearing !== null) {
          bearing = smoothedBearing;
          replayManager.replayLastBearing = bearing; // Store for use when stationary
        } else if (replayManager.replayLastBearing !== null) {
          // Plane is stationary - use last known bearing to avoid rotation jitter
          bearing = replayManager.replayLastBearing;
        }

        // Update marker position
        // The CSS transition on the marker element provides smooth movement
        replayManager.replayAirplaneMarker.setLatLng(currentPos);

        // Auto-pan map if airplane is near viewport edge (when playing or manually seeking)
        if (replayManager.replayPlaying || isManualSeek) {
          const mapSize = this.app.map.getSize();
          const airplanePoint = this.app.map.latLngToContainerPoint(currentPos);

          // Define margin from edge (in pixels) before triggering pan
          // Smaller margin allows airplane to get closer to edges before recentering
          const marginPercent = 0.1; // 10% margin from each edge
          const marginX = mapSize.x * marginPercent;
          const marginY = mapSize.y * marginPercent;

          // Check if airplane is approaching edges - if so, center on airplane
          let needsRecenter = false;
          if (
            airplanePoint.x < marginX ||
            airplanePoint.x > mapSize.x - marginX ||
            airplanePoint.y < marginY ||
            airplanePoint.y > mapSize.y - marginY
          ) {
            needsRecenter = true;
          }

          // For manual seek, always center on airplane position
          if (isManualSeek) {
            needsRecenter = true;
          }

          // Center map on airplane instead of incremental panning
          if (needsRecenter) {
            this.app.map.panTo(currentPos, {
              animate: true,
              duration: 0.5,
              easeLinearity: 0.25,
              noMoveStart: true,
            });

            // Track recenter events for auto-zoom using sliding window
            const now = Date.now();
            replayManager.replayRecenterTimestamps.push(now);

            // Remove timestamps older than 30 seconds (sliding window)
            const cutoffTime = now - 30000; // 30 seconds ago
            replayManager.replayRecenterTimestamps =
              replayManager.replayRecenterTimestamps.filter((ts) => {
                return ts > cutoffTime;
              });
          }

          // Auto-zoom based on map recenter frequency
          if (replayManager.replayAutoZoom) {
            // Clean up old timestamps from sliding window
            const now = Date.now();
            const cutoffTime = now - 30000;
            replayManager.replayRecenterTimestamps =
              replayManager.replayRecenterTimestamps.filter((ts) => {
                return ts > cutoffTime;
              });

            const recenterCount = replayManager.replayRecenterTimestamps.length;

            // Trigger zoom-out when more than 2 recenters happen within 5 seconds
            if (recenterCount > 2) {
              // Check if we have more than 2 recenters within the last 5 seconds
              const now = Date.now();
              const fiveSecondsAgo = now - 5000;
              const recentRecenters =
                replayManager.replayRecenterTimestamps.filter((ts) => {
                  return ts >= fiveSecondsAgo;
                });

              if (recentRecenters.length > 2) {
                // More than 2 recenters in 5 seconds - zoom out aggressively
                const zoomOutStep = 1; // Always zoom out 1 level for fine-granular control

                // Only zoom out, never zoom in
                // Zoom out by 1 level, but don't go below level 9
                if (
                  zoomOutStep > 0 &&
                  replayManager.replayLastZoom !== null &&
                  replayManager.replayLastZoom > 9
                ) {
                  const newZoom = Math.max(
                    9,
                    replayManager.replayLastZoom - zoomOutStep
                  );

                  // Zoom out without recentering
                  this.app.map.setZoom(newZoom, {
                    animate: true,
                    duration: 0.5,
                  });
                  replayManager.replayLastZoom = newZoom;

                  // Clear ALL recenter timestamps after zoom-out to allow fresh evaluation
                  // This prevents immediate re-triggering with the same old timestamps
                  replayManager.replayRecenterTimestamps = [];
                }
              }
            }
          }
        }

        // Update rotation using hardware-accelerated transforms
        // Airplane emoji typically points right/northeast, adjust to match bearing
        // The offset may vary by system - adjust if airplane orientation looks wrong
        const iconElement = replayManager.replayAirplaneMarker.getElement();
        if (iconElement) {
          const iconDiv = iconElement.querySelector(".replay-airplane-icon");
          if (iconDiv) {
            // Most systems: emoji points at ~45° (northeast), so adjust by -45°
            const adjustedBearing = bearing - 45;
            // Use translate3d(0,0,0) to force hardware acceleration
            (iconDiv as HTMLElement).style.transform =
              "translate3d(0,0,0) rotate(" + adjustedBearing + "deg)";
          }
        }
      } else if (replayManager.replaySegments.length > 0) {
        // No segment yet (at start of replay) - position at first coordinate
        const firstSeg = replayManager.replaySegments[0];
        const startCoords = firstSeg?.coords?.[0];
        if (startCoords) {
          replayManager.replayAirplaneMarker.setLatLng([
            startCoords[0],
            startCoords[1],
          ]);
        }
      }
    }

    // Update popup content if it's open
    if (
      replayManager.replayAirplaneMarker &&
      replayManager.replayAirplaneMarker.getPopup() &&
      replayManager.replayAirplaneMarker.isPopupOpen()
    ) {
      this.updateAirplanePopup(replayManager);
    }
  }
}
