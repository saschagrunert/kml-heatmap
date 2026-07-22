/**
 * Replay Renderer - Handles rendering concerns for flight replay
 */
import * as L from "leaflet";
import type { MapApp } from "../mapApp";
import type { ReplayManager } from "./replayManager";
import type { PathSegment } from "../types";
import { domCache } from "../utils/domCache";
import { generateSegmentPopupHtml } from "../utils/htmlGenerators";

export class ReplayRenderer {
  private app: MapApp;

  constructor(app: MapApp) {
    this.app = app;
  }

  updateAirplanePopup(replayManager: ReplayManager): void {
    if (!replayManager.state.airplaneMarker || !replayManager.state.active)
      return;

    // Find the current segment for data
    let currentSegment: PathSegment | null = null;
    for (let i = 0; i < replayManager.state.segments.length; i++) {
      const seg = replayManager.state.segments[i];
      if (seg && (seg.time || 0) <= replayManager.state.currentTime) {
        currentSegment = seg;
      } else {
        break;
      }
    }

    if (!currentSegment && replayManager.state.segments.length > 0) {
      currentSegment = replayManager.state.segments[0]!;
    }

    if (!currentSegment) return;

    const popupContent = generateSegmentPopupHtml({
      segment: currentSegment,
      altMin: replayManager.state.colorMinAlt,
      altMax: replayManager.state.colorMaxAlt,
      speedMin: replayManager.state.colorMinSpeed,
      speedMax: replayManager.state.colorMaxSpeed,
      title: "Current Position",
      icon: "✈️",
    });

    // Update or create popup
    if (!replayManager.state.airplaneMarker.getPopup()) {
      replayManager.state.airplaneMarker.bindPopup(popupContent, {
        autoPanPadding: [50, 50],
      });
    } else {
      replayManager.state.airplaneMarker.getPopup()!.setContent(popupContent);
    }

    // Open the popup
    replayManager.state.airplaneMarker.openPopup();
  }

  updateDisplay(
    replayManager: ReplayManager,
    isManualSeek: boolean = false
  ): void {
    // Update time display
    const timeDisplay = domCache.get("replay-time-display");
    if (timeDisplay) {
      timeDisplay.textContent =
        window.KMLHeatmap.formatTime(replayManager.state.currentTime) +
        " / " +
        window.KMLHeatmap.formatTime(replayManager.state.maxTime);
    }

    // Update slider position
    const slider = domCache.get("replay-slider") as HTMLInputElement | null;
    if (slider) slider.value = replayManager.state.currentTime.toString();

    const sliderStart = domCache.get("replay-slider-start");
    if (sliderStart) {
      sliderStart.textContent = window.KMLHeatmap.formatTime(
        replayManager.state.currentTime
      );
    }

    // Find current position in replay timeline (for airplane positioning)
    let lastSegment: PathSegment | null = null;
    let nextSegment: PathSegment | null = null;
    let currentIndex = -1;

    const searchStart =
      replayManager.state.lastDrawnIndex > 0 && !isManualSeek
        ? replayManager.state.lastDrawnIndex
        : 0;
    for (let i = searchStart; i < replayManager.state.segments.length; i++) {
      const seg = replayManager.state.segments[i];
      if (seg && (seg.time || 0) <= replayManager.state.currentTime) {
        lastSegment = seg;
        currentIndex = i;
      } else if (seg) {
        // Found the next segment beyond current time
        nextSegment = seg;
        break;
      }
    }

    // Draw path segments (separate loop for incremental rendering)
    if (replayManager.state.layer) {
      // Determine which color scheme to use based on visible layer
      const useAirspeedColors =
        this.app.airspeedVisible && !this.app.altitudeVisible;

      for (let i = 0; i < replayManager.state.segments.length; i++) {
        const seg = replayManager.state.segments[i];
        if (!seg) continue;

        // Don't draw any segments when at time 0 (stopped/reset state)
        if (
          (seg.time || 0) <= replayManager.state.currentTime &&
          replayManager.state.currentTime > 0
        ) {
          // Only draw if we haven't drawn this segment yet (incremental rendering)
          if (i > replayManager.state.lastDrawnIndex) {
            // Calculate color based on selected profile using replay-specific ranges
            let segmentColor: string;
            if (useAirspeedColors && (seg.groundspeed_knots || 0) > 0) {
              // Use airspeed colors with selected path's groundspeed range
              segmentColor = window.KMLHeatmap.getColorForAirspeed(
                seg.groundspeed_knots ?? 0,
                replayManager.state.colorMinSpeed,
                replayManager.state.colorMaxSpeed
              );
            } else {
              // Use altitude colors with selected path's altitude range (default)
              segmentColor = window.KMLHeatmap.getColorForAltitude(
                seg.altitude_ft ?? 0,
                replayManager.state.colorMinAlt,
                replayManager.state.colorMaxAlt
              );
            }

            L.polyline(seg.coords || [], {
              color: segmentColor,
              weight: 3,
              opacity: 0.8,
            }).addTo(replayManager.state.layer);

            // Update last drawn index incrementally during the loop
            replayManager.state.lastDrawnIndex = i;
          }
        } else {
          break;
        }
      }
    }

    // Update airplane marker position and rotation
    // Ensure marker is on the map (in case it was removed during seeking/zooming)
    if (
      replayManager.state.airplaneMarker &&
      this.app.map &&
      !this.app.map.hasLayer(replayManager.state.airplaneMarker)
    ) {
      replayManager.state.airplaneMarker.addTo(this.app.map);
    }

    if (replayManager.state.airplaneMarker && this.app.map) {
      // If we have a lastSegment, use it for positioning
      if (lastSegment) {
        let currentPos: [number, number];
        let bearing: number;

        if (
          nextSegment &&
          (lastSegment.time || 0) < replayManager.state.currentTime
        ) {
          // Interpolate between last and next segment
          const timeFraction =
            (replayManager.state.currentTime - (lastSegment.time || 0)) /
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
          currentPos = lastSegment.coords?.[1] || [0, 0];

          // Calculate bearing from this segment
          const lat1 = lastSegment.coords?.[0]?.[0] || 0;
          const lon1 = lastSegment.coords?.[0]?.[1] || 0;
          const lat2 = lastSegment.coords?.[1]?.[0] || 0;
          const lon2 = lastSegment.coords?.[1]?.[1] || 0;
          bearing = window.KMLHeatmap.calculateBearing(lat1, lon1, lat2, lon2);
        }

        // Calculate smoothed bearing by looking ahead several segments
        const smoothedBearing = window.KMLHeatmap.calculateSmoothedBearing(
          replayManager.state.segments,
          currentIndex,
          5
        );
        if (smoothedBearing !== null) {
          bearing = smoothedBearing;
          replayManager.state.lastBearing = bearing;
        } else if (replayManager.state.lastBearing !== null) {
          bearing = replayManager.state.lastBearing;
        }

        // Update marker position
        replayManager.state.airplaneMarker.setLatLng(currentPos);

        // Auto-pan map if airplane is near viewport edge (when playing or manually seeking)
        if (replayManager.state.playing || isManualSeek) {
          const mapSize = this.app.map.getSize();
          const airplanePoint = this.app.map.latLngToContainerPoint(currentPos);

          const marginPercent = 0.1;
          const marginX = mapSize.x * marginPercent;
          const marginY = mapSize.y * marginPercent;

          let needsRecenter = false;
          if (
            airplanePoint.x < marginX ||
            airplanePoint.x > mapSize.x - marginX ||
            airplanePoint.y < marginY ||
            airplanePoint.y > mapSize.y - marginY
          ) {
            needsRecenter = true;
          }

          if (isManualSeek) {
            needsRecenter = true;
          }

          if (needsRecenter) {
            this.app.map.panTo(currentPos, {
              animate: true,
              duration: 0.5,
              easeLinearity: 0.25,
              noMoveStart: true,
            });

            const now = Date.now();
            replayManager.state.recenterTimestamps.push(now);

            const cutoffTime = now - 30000;
            replayManager.state.recenterTimestamps =
              replayManager.state.recenterTimestamps.filter((ts) => {
                return ts > cutoffTime;
              });
          }

          // Auto-zoom based on map recenter frequency
          if (replayManager.state.autoZoom) {
            const recenterCount = replayManager.state.recenterTimestamps.length;

            if (recenterCount > 2) {
              const fiveSecondsAgo = Date.now() - 5000;
              const recentRecenters =
                replayManager.state.recenterTimestamps.filter((ts) => {
                  return ts >= fiveSecondsAgo;
                });

              if (recentRecenters.length > 2) {
                const zoomOutStep = 1;

                if (
                  zoomOutStep > 0 &&
                  replayManager.state.lastZoom !== null &&
                  replayManager.state.lastZoom > 9
                ) {
                  const newZoom = Math.max(
                    9,
                    replayManager.state.lastZoom - zoomOutStep
                  );

                  this.app.map.setZoom(newZoom, {
                    animate: true,
                    duration: 0.5,
                  });
                  replayManager.state.lastZoom = newZoom;

                  replayManager.state.recenterTimestamps = [];
                }
              }
            }
          }
        }

        // Update rotation using hardware-accelerated transforms
        const iconElement = replayManager.state.airplaneMarker.getElement();
        if (iconElement) {
          const iconDiv = iconElement.querySelector(".replay-airplane-icon");
          if (iconDiv) {
            const adjustedBearing = bearing - 45;
            (iconDiv as HTMLElement).style.transform =
              "translate3d(0,0,0) rotate(" + adjustedBearing + "deg)";
          }
        }
      } else if (replayManager.state.segments.length > 0) {
        const firstSeg = replayManager.state.segments[0];
        const startCoords = firstSeg?.coords?.[0];
        if (startCoords) {
          replayManager.state.airplaneMarker.setLatLng([
            startCoords[0],
            startCoords[1],
          ]);
        }
      }
    }

    // Update popup content if it's open
    if (
      replayManager.state.airplaneMarker &&
      replayManager.state.airplaneMarker.getPopup() &&
      replayManager.state.airplaneMarker.isPopupOpen()
    ) {
      this.updateAirplanePopup(replayManager);
    }
  }
}
