/**
 * Replay controller for animated flight path playback
 */

import L from "leaflet";
import type { ReplaySegment, ReplayState } from "../types";
import { getColorForAltitude } from "../utils/formatting";
import { REPLAY_CONFIG } from "../constants";

export class ReplayController {
  private map: any; // L.Map - using any to avoid Leaflet type resolution issues
  private state: ReplayState;
  private layer: any; // L.LayerGroup - using any to avoid Leaflet type resolution issues
  private airplaneMarker: any | null = null; // L.Marker - using any to avoid Leaflet type resolution issues
  private drawnPolylines: any[] = []; // L.Polyline[] - using any to avoid Leaflet type resolution issues

  constructor(map: any, state: ReplayState) {
    this.map = map;
    this.state = state;
    this.layer = L.layerGroup();
  }

  /**
   * Initialize replay with segments
   */
  initialize(
    segments: ReplaySegment[],
    colorMode: "altitude" | "airspeed",
  ): void {
    // Sort segments by time
    this.state.segments = segments.sort((a, b) => {
      const timeA = a.timestamp && a.timestamp.length > 0 ? a.timestamp[0] : 0;
      const timeB = b.timestamp && b.timestamp.length > 0 ? b.timestamp[0] : 0;
      return timeA - timeB;
    });

    // Calculate max time
    this.state.maxTime = 0;
    segments.forEach((seg) => {
      if (seg.timestamp && seg.timestamp.length > 0) {
        const maxSegTime = Math.max(...seg.timestamp);
        if (maxSegTime > this.state.maxTime) {
          this.state.maxTime = maxSegTime;
        }
      }
    });

    // Calculate color ranges
    if (colorMode === "altitude") {
      let minAlt = Infinity;
      let maxAlt = -Infinity;
      segments.forEach((seg) => {
        if (seg.altitude) {
          seg.altitude.forEach((alt) => {
            if (alt < minAlt) minAlt = alt;
            if (alt > maxAlt) maxAlt = alt;
          });
        }
      });
      this.state.colorMinAlt =
        minAlt !== Infinity ? minAlt : REPLAY_CONFIG.DEFAULT_ALTITUDE_MIN;
      this.state.colorMaxAlt =
        maxAlt !== -Infinity ? maxAlt : REPLAY_CONFIG.DEFAULT_ALTITUDE_MAX;
    } else {
      let minSpeed = Infinity;
      let maxSpeed = -Infinity;
      segments.forEach((seg) => {
        if (seg.groundspeed) {
          seg.groundspeed.forEach((speed) => {
            if (speed < minSpeed) minSpeed = speed;
            if (speed > maxSpeed) maxSpeed = speed;
          });
        }
      });
      this.state.colorMinSpeed =
        minSpeed !== Infinity ? minSpeed : REPLAY_CONFIG.DEFAULT_SPEED_MIN;
      this.state.colorMaxSpeed =
        maxSpeed !== -Infinity ? maxSpeed : REPLAY_CONFIG.DEFAULT_SPEED_MAX;
    }

    // Create airplane marker
    this.createAirplaneMarker();

    // Add layer to map
    this.layer.addTo(this.map);
    this.state.layer = this.layer;
  }

  /**
   * Create airplane icon marker
   */
  private createAirplaneMarker(): void {
    const icon = L.divIcon({
      className: "airplane-marker",
      html: `
        <div style="
          width: ${REPLAY_CONFIG.AIRPLANE_MARKER_SIZE}px;
          height: ${REPLAY_CONFIG.AIRPLANE_MARKER_SIZE}px;
          background: #FF6B35;
          border: ${REPLAY_CONFIG.AIRPLANE_MARKER_BORDER}px solid white;
          border-radius: 50%;
          transform: translate(-50%, -50%);
        ">
          <div style="
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            color: white;
            font-size: 12px;
          ">✈</div>
        </div>
      `,
      iconSize: [
        REPLAY_CONFIG.AIRPLANE_MARKER_SIZE,
        REPLAY_CONFIG.AIRPLANE_MARKER_SIZE,
      ],
      iconAnchor: [10, 10],
    });

    this.airplaneMarker = L.marker([0, 0], { icon });
    this.state.airplaneMarker = this.airplaneMarker;
  }

  /**
   * Start or resume playback
   */
  play(): void {
    if (this.state.playing) return;

    this.state.playing = true;
    this.state.lastFrameTime = performance.now();

    const animate = (timestamp: number) => {
      if (!this.state.playing) return;

      // Calculate time delta
      const deltaTime = this.state.lastFrameTime
        ? (timestamp - this.state.lastFrameTime) / 1000
        : 0;
      this.state.lastFrameTime = timestamp;

      // Update current time
      this.state.currentTime += deltaTime * this.state.speed;

      // Check if replay finished
      if (this.state.currentTime >= this.state.maxTime) {
        this.stop();
        return;
      }

      // Render current frame
      this.renderFrame(this.state.currentTime);

      // Continue animation
      this.state.animationFrameId = requestAnimationFrame(animate);
    };

    this.state.animationFrameId = requestAnimationFrame(animate);
  }

  /**
   * Pause playback
   */
  pause(): void {
    this.state.playing = false;
    if (this.state.animationFrameId !== null) {
      cancelAnimationFrame(this.state.animationFrameId);
      this.state.animationFrameId = null;
    }
  }

  /**
   * Stop and reset playback
   */
  stop(): void {
    this.pause();
    this.state.currentTime = 0;
    this.state.lastDrawnIndex = -1;
    this.layer.clearLayers();
    this.drawnPolylines = [];
    if (this.airplaneMarker) {
      this.layer.removeLayer(this.airplaneMarker);
    }
  }

  /**
   * Seek to specific time
   */
  seek(time: number): void {
    const wasPlaying = this.state.playing;
    this.pause();

    this.state.currentTime = Math.max(0, Math.min(time, this.state.maxTime));
    this.state.lastDrawnIndex = -1;
    this.layer.clearLayers();
    this.drawnPolylines = [];

    this.renderFrame(this.state.currentTime);

    if (wasPlaying) {
      this.play();
    }
  }

  /**
   * Set playback speed
   */
  setSpeed(speed: number): void {
    this.state.speed = speed;
  }

  /**
   * Render current frame
   */
  private renderFrame(currentTime: number): void {
    // Find segments to draw
    const segmentsToDraw: ReplaySegment[] = [];
    let airplanePosition: [number, number] | null = null;
    let airplaneBearing: number | null = null;

    this.state.segments.forEach((seg) => {
      if (!seg.timestamp || seg.timestamp.length === 0) return;

      const segStart = seg.timestamp[0];
      const segEnd = seg.timestamp[seg.timestamp.length - 1];

      if (currentTime >= segEnd) {
        // Fully visible segment
        segmentsToDraw.push(seg);
      } else if (currentTime >= segStart && currentTime < segEnd) {
        // Partially visible - find airplane position
        for (let i = 0; i < seg.timestamp.length - 1; i++) {
          if (
            currentTime >= seg.timestamp[i] &&
            currentTime < seg.timestamp[i + 1]
          ) {
            // Interpolate position
            const t =
              (currentTime - seg.timestamp[i]) /
              (seg.timestamp[i + 1] - seg.timestamp[i]);
            const lat1 = seg.coords[i][0];
            const lon1 = seg.coords[i][1];
            const lat2 = seg.coords[i + 1][0];
            const lon2 = seg.coords[i + 1][1];

            airplanePosition = [
              lat1 + t * (lat2 - lat1),
              lon1 + t * (lon2 - lon1),
            ];

            // Calculate bearing
            airplaneBearing =
              Math.atan2(lon2 - lon1, lat2 - lat1) * (180 / Math.PI);
            break;
          }
        }

        // Draw partial segment
        segmentsToDraw.push(seg);
      }
    });

    // Draw segments (incrementally)
    segmentsToDraw.forEach((seg) => {
      const color = this.getSegmentColor(seg);

      seg.coords.forEach((coord, i) => {
        if (i === 0) return;

        const polyline = L.polyline([seg.coords[i - 1], coord], {
          color,
          weight: 3,
          opacity: 0.8,
        });

        polyline.addTo(this.layer);
        this.drawnPolylines.push(polyline);
      });
    });

    // Update airplane position
    if (airplanePosition && this.airplaneMarker) {
      this.airplaneMarker.setLatLng(airplanePosition);

      if (airplaneBearing !== null) {
        const icon = this.airplaneMarker.getIcon() as any; // L.DivIcon - using any to avoid Leaflet type resolution issues
        const newIcon = L.divIcon({
          ...icon.options,
          html: `
            <div style="
              width: 20px;
              height: 20px;
              background: #FF6B35;
              border: 2px solid white;
              border-radius: 50%;
              transform: translate(-50%, -50%) rotate(${airplaneBearing}deg);
            ">
              <div style="
                position: absolute;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                color: white;
                font-size: 12px;
              ">✈</div>
            </div>
          `,
        });
        this.airplaneMarker.setIcon(newIcon);
      }

      if (!this.layer.hasLayer(this.airplaneMarker)) {
        this.airplaneMarker.addTo(this.layer);
      }
    }
  }

  /**
   * Get color for segment based on altitude or airspeed
   */
  private getSegmentColor(segment: ReplaySegment): string {
    if (segment.altitude && segment.altitude.length > 0) {
      const avgAlt =
        segment.altitude.reduce((a, b) => a + b, 0) / segment.altitude.length;
      return getColorForAltitude(
        avgAlt,
        this.state.colorMinAlt,
        this.state.colorMaxAlt,
      );
    }
    return "#3388ff";
  }

  /**
   * Get current state
   */
  getState(): ReplayState {
    return this.state;
  }

  /**
   * Clean up
   */
  destroy(): void {
    this.stop();
    this.layer.remove();
  }
}
