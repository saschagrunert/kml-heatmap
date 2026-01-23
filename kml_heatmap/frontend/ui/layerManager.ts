/**
 * Layer Manager - Handles altitude/airspeed path rendering and legend updates
 */
import * as L from "leaflet";
import { logWarn } from "../utils/logger";
import type { MapApp } from "../mapApp";
import { domCache } from "../utils/domCache";

export class LayerManager {
  private app: MapApp;

  constructor(app: MapApp) {
    this.app = app;

    // Pre-cache legend elements
    domCache.cacheElements([
      "legend-min",
      "legend-max",
      "airspeed-legend-min",
      "airspeed-legend-max",
    ]);
  }

  redrawAltitudePaths(): void {
    if (!this.app.currentData) return;

    // Clear altitude layer and path references
    this.app.altitudeLayer.clearLayers();
    this.app.pathSegments = {};

    // Calculate altitude range for color scaling
    let colorMinAlt: number, colorMaxAlt: number;
    if (this.app.selectedPathIds.size > 0) {
      // Use selected paths' altitude range
      const selectedSegments = this.app.currentData.path_segments.filter(
        (segment) => {
          return this.app.selectedPathIds.has(segment.path_id);
        }
      );
      if (selectedSegments.length > 0) {
        const altitudes = selectedSegments.map((s) => s.altitude_ft || 0);
        // Use iterative approach to avoid stack overflow with large arrays
        let min = altitudes[0] ?? 0;
        let max = altitudes[0] ?? 0;
        for (let i = 1; i < altitudes.length; i++) {
          const alt = altitudes[i] ?? 0;
          if (alt < min) min = alt;
          if (alt > max) max = alt;
        }
        colorMinAlt = min;
        colorMaxAlt = max;
      } else {
        colorMinAlt = this.app.altitudeRange.min;
        colorMaxAlt = this.app.altitudeRange.max;
      }
    } else {
      // Use full altitude range
      colorMinAlt = this.app.altitudeRange.min;
      colorMaxAlt = this.app.altitudeRange.max;
    }

    // Create path segments with interactivity and rescaled colors
    this.app.currentData.path_segments.forEach((segment) => {
      const pathId = segment.path_id;

      const pathInfo = this.app.currentData!.path_info.find(
        (p) => p.id === pathId
      );

      // Filter by year if selected
      if (this.app.selectedYear !== "all") {
        if (
          pathInfo &&
          pathInfo.year &&
          pathInfo.year.toString() !== this.app.selectedYear
        ) {
          return; // Skip this segment
        }
      }

      // Filter by aircraft if selected
      if (this.app.selectedAircraft !== "all") {
        if (
          pathInfo &&
          pathInfo.aircraft_registration !== this.app.selectedAircraft
        ) {
          return; // Skip this segment
        }
      }

      const isSelected = this.app.selectedPathIds.has(pathId);

      // When buttons are hidden and paths are selected: hide unselected paths
      // When buttons are visible: dim unselected paths to opacity 0.1
      if (this.app.selectedPathIds.size > 0 && !isSelected) {
        if (this.app.buttonsHidden) {
          return; // Hide completely
        }
      }

      // Recalculate color based on current altitude range
      const color = window.KMLHeatmap.getColorForAltitude(
        segment.altitude_ft ?? 0,
        colorMinAlt,
        colorMaxAlt
      );

      const polyline = L.polyline(segment.coords || [], {
        color: color,
        weight: isSelected ? 6 : 4,
        opacity: isSelected
          ? 1.0
          : this.app.selectedPathIds.size > 0
            ? 0.1
            : 0.85,
        renderer: this.app.altitudeRenderer,
        interactive: true,
      })
        .bindPopup(
          "Altitude: " +
            segment.altitude_ft +
            " ft (" +
            segment.altitude_m +
            " m)"
        )
        .addTo(this.app.altitudeLayer);

      // Make path clickable
      polyline.on("click", (e: L.LeafletMouseEvent) => {
        L.DomEvent.stopPropagation(e);
        this.app.pathSelection!.togglePathSelection(pathId);
      });

      // Store reference to polyline by path_id
      if (!this.app.pathSegments[pathId]) {
        this.app.pathSegments[pathId] = [];
      }
      this.app.pathSegments[pathId].push(segment);
    });

    // Update legend to show current altitude range
    this.updateAltitudeLegend(colorMinAlt, colorMaxAlt);

    // Update airport marker opacity based on selection
    this.app.airportManager!.updateAirportOpacity();

    // Update statistics panel based on selection
    this.app.statsManager!.updateStatsForSelection();
  }

  redrawAirspeedPaths(): void {
    if (!this.app.currentData) {
      logWarn("redrawAirspeedPaths: No current data available");
      return;
    }

    // Clear airspeed layer
    this.app.airspeedLayer.clearLayers();

    // Calculate groundspeed range for color scaling
    let colorMinSpeed: number, colorMaxSpeed: number;
    if (this.app.selectedPathIds.size > 0) {
      // Use selected paths' groundspeed range
      const selectedSegments = this.app.currentData.path_segments.filter(
        (segment) => {
          return (
            this.app.selectedPathIds.has(segment.path_id) &&
            (segment.groundspeed_knots || 0) > 0
          );
        }
      );
      if (selectedSegments.length > 0) {
        const groundspeeds = selectedSegments.map(
          (s) => s.groundspeed_knots || 0
        );
        // Use iterative approach to avoid stack overflow with large arrays
        let min = groundspeeds[0] ?? 0;
        let max = groundspeeds[0] ?? 0;
        for (let i = 1; i < groundspeeds.length; i++) {
          const speed = groundspeeds[i] ?? 0;
          if (speed < min) min = speed;
          if (speed > max) max = speed;
        }
        colorMinSpeed = min;
        colorMaxSpeed = max;
      } else {
        colorMinSpeed = this.app.airspeedRange.min;
        colorMaxSpeed = this.app.airspeedRange.max;
      }
    } else {
      // Use full groundspeed range from metadata (not from current resolution)
      colorMinSpeed = this.app.airspeedRange.min;
      colorMaxSpeed = this.app.airspeedRange.max;
    }

    // Create path segments with groundspeed colors and rescaled colors
    this.app.currentData.path_segments.forEach((segment) => {
      const pathId = segment.path_id;

      const pathInfo = this.app.currentData!.path_info.find(
        (p) => p.id === pathId
      );

      // Filter by year if selected
      if (this.app.selectedYear !== "all") {
        if (
          pathInfo &&
          pathInfo.year &&
          pathInfo.year.toString() !== this.app.selectedYear
        ) {
          return; // Skip this segment
        }
      }

      // Filter by aircraft if selected
      if (this.app.selectedAircraft !== "all") {
        if (
          pathInfo &&
          pathInfo.aircraft_registration !== this.app.selectedAircraft
        ) {
          return; // Skip this segment
        }
      }

      if ((segment.groundspeed_knots || 0) > 0) {
        const isSelected = this.app.selectedPathIds.has(pathId);

        // When buttons are hidden and paths are selected: hide unselected paths
        // When buttons are visible: dim unselected paths to opacity 0.1
        if (this.app.selectedPathIds.size > 0 && !isSelected) {
          if (this.app.buttonsHidden) {
            return; // Hide completely
          }
        }

        // Recalculate color based on current groundspeed range
        const color = window.KMLHeatmap.getColorForAirspeed(
          segment.groundspeed_knots ?? 0,
          colorMinSpeed,
          colorMaxSpeed
        );

        const kmh = Math.round((segment.groundspeed_knots || 0) * 1.852);
        const polyline = L.polyline(segment.coords || [], {
          color: color,
          weight: isSelected ? 6 : 4,
          opacity: isSelected
            ? 1.0
            : this.app.selectedPathIds.size > 0
              ? 0.1
              : 0.85,
          renderer: this.app.airspeedRenderer,
          interactive: true,
        })
          .bindPopup(
            "Groundspeed: " +
              segment.groundspeed_knots +
              " kt (" +
              kmh +
              " km/h)"
          )
          .addTo(this.app.airspeedLayer);

        // Make path clickable
        polyline.on("click", (e: L.LeafletMouseEvent) => {
          L.DomEvent.stopPropagation(e);
          this.app.pathSelection!.togglePathSelection(pathId);
        });
      }
    });

    // Update legend
    this.updateAirspeedLegend(colorMinSpeed, colorMaxSpeed);

    // Update airport marker opacity based on selection
    this.app.airportManager!.updateAirportOpacity();

    // Update statistics panel based on selection
    this.app.statsManager!.updateStatsForSelection();
  }

  updateAltitudeLegend(minAlt: number, maxAlt: number): void {
    const minFt = Math.round(minAlt);
    const maxFt = Math.round(maxAlt);
    const minM = Math.round(minAlt * 0.3048);
    const maxM = Math.round(maxAlt * 0.3048);

    const minEl = domCache.get("legend-min");
    const maxEl = domCache.get("legend-max");

    if (minEl) {
      minEl.textContent =
        minFt.toLocaleString() + " ft (" + minM.toLocaleString() + " m)";
    }
    if (maxEl) {
      maxEl.textContent =
        maxFt.toLocaleString() + " ft (" + maxM.toLocaleString() + " m)";
    }
  }

  updateAirspeedLegend(minSpeed: number, maxSpeed: number): void {
    const minKnots = Math.round(minSpeed);
    const maxKnots = Math.round(maxSpeed);
    const minKmh = Math.round(minSpeed * 1.852);
    const maxKmh = Math.round(maxSpeed * 1.852);

    const minEl = domCache.get("airspeed-legend-min");
    const maxEl = domCache.get("airspeed-legend-max");

    if (minEl) {
      minEl.textContent =
        minKnots.toLocaleString() +
        " kt (" +
        minKmh.toLocaleString() +
        " km/h)";
    }
    if (maxEl) {
      maxEl.textContent =
        maxKnots.toLocaleString() +
        " kt (" +
        maxKmh.toLocaleString() +
        " km/h)";
    }
  }
}
