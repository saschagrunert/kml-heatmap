/**
 * Stats Manager - Handles statistics panel updates
 */
import DOMPurify from "dompurify";
import type { MapApp } from "../mapApp";
import type { FilteredStatistics } from "../types";
import { domCache } from "../utils/domCache";

export class StatsManager {
  private app: MapApp;

  constructor(app: MapApp) {
    this.app = app;

    // Pre-cache stats panel element
    domCache.cacheElements(["stats-panel"]);
  }

  updateStatsForSelection(): void {
    if (this.app.selectedPathIds.size === 0) {
      const statsToShow = window.KMLHeatmap.calculateFilteredStatistics({
        pathInfo: this.app.fullPathInfo || [],
        segments: this.app.fullPathSegments || [],
        year: this.app.selectedYear,
        aircraft: this.app.selectedAircraft,
        coordinateCount: this.app.currentData?.original_points,
      });
      if (statsToShow) {
        this.updateStatsPanel(statsToShow, false);
      }
      return;
    }

    // Calculate stats for selected paths only
    // Filter pathInfo and segments to only selected paths
    const selectedPathInfo = (this.app.fullPathInfo || []).filter((path) => {
      return this.app.selectedPathIds.has(path.id);
    });

    const selectedSegments = (this.app.fullPathSegments || []).filter(
      (segment) => {
        return this.app.selectedPathIds.has(segment.path_id);
      }
    );

    if (selectedSegments.length === 0) return;

    // Calculate unique coordinate count from selected segments
    // Note: This counts only points that have altitude data (i.e., points in segments)
    // Some coordinates in the raw data may not have altitude and won't be counted here
    const coordSet = new Set<string>();
    for (const segment of selectedSegments) {
      if (segment.coords && segment.coords.length === 2) {
        coordSet.add(JSON.stringify(segment.coords[0]));
        coordSet.add(JSON.stringify(segment.coords[1]));
      }
    }
    const selectedCoordCount = coordSet.size;

    // Use KMLHeatmap library to calculate stats for selected paths
    const selectedStats = window.KMLHeatmap.calculateFilteredStatistics({
      pathInfo: selectedPathInfo,
      segments: selectedSegments,
      year: "all", // Don't filter by year for selection
      aircraft: "all", // Don't filter by aircraft for selection
      coordinateCount: selectedCoordCount,
    });

    this.updateStatsPanel(selectedStats, true);
  }

  updateStatsPanel(stats: FilteredStatistics, isSelection: boolean): void {
    let html = "";

    // Add indicator if showing selected paths only
    if (isSelection) {
      html +=
        '<p style="margin:0 0 10px 0; font-weight:bold; font-size:15px;">📊 Selected Paths Statistics</p>';
      html +=
        '<div style="background-color: #3a5a7a; padding: 4px 8px; margin-bottom: 8px; border-radius: 3px; font-size: 11px; color: #a0c0e0;">Showing stats for ' +
        stats.num_paths +
        " selected path(s)</div>";
    } else {
      html +=
        '<p style="margin:0 0 10px 0; font-weight:bold; font-size:15px;">📊 Flight Statistics</p>';
    }

    html +=
      '<div style="margin-bottom: 8px;"><strong>Data Points:</strong> ' +
      stats.total_points.toLocaleString() +
      "</div>";
    html +=
      '<div style="margin-bottom: 8px;"><strong>Flights:</strong> ' +
      stats.num_paths +
      "</div>";

    if (stats.airport_names && stats.airport_names.length > 0) {
      html +=
        '<div style="margin-bottom: 8px; max-height: 150px; overflow-y: auto;"><strong>Airports (' +
        stats.num_airports +
        "):</strong><br>";
      stats.airport_names.forEach((name) => {
        html += '<span style="margin-left: 10px;">• ' + name + "</span><br>";
      });
      html += "</div>";
    }

    // Aircraft information (below airports)
    if (
      stats.num_aircraft &&
      stats.num_aircraft > 0 &&
      stats.aircraft_list &&
      stats.aircraft_list.length > 0
    ) {
      html +=
        '<div style="margin-bottom: 8px; max-height: 150px; overflow-y: auto;"><strong>Aircrafts (' +
        stats.num_aircraft +
        "):</strong><br>";
      stats.aircraft_list.forEach((aircraft) => {
        const typeStr = aircraft.type ? " (" + aircraft.type + ")" : "";
        html +=
          '<span style="margin-left: 10px;">• ' +
          aircraft.registration +
          typeStr +
          " - " +
          aircraft.flights +
          " flight(s)</span><br>";
      });
      html += "</div>";
    }

    if (stats.total_flight_time_str) {
      html +=
        '<div style="margin-bottom: 8px;"><strong>Total Flight Time:</strong> ' +
        stats.total_flight_time_str +
        "</div>";
    }

    // Distance with km conversion
    const distanceKm = (stats.total_distance_nm * 1.852).toFixed(1);
    html +=
      '<div style="margin-bottom: 8px;"><strong>Distance:</strong> ' +
      stats.total_distance_nm.toFixed(1) +
      " nm (" +
      distanceKm +
      " km)</div>";

    // Average distance per trip
    if (stats.num_paths > 0) {
      const avgDistanceNm = (stats.total_distance_nm / stats.num_paths).toFixed(
        1
      );
      const avgDistanceKm = (parseFloat(avgDistanceNm) * 1.852).toFixed(1);
      html +=
        '<div style="margin-bottom: 8px;"><strong>Average Distance per Trip:</strong> ' +
        avgDistanceNm +
        " nm (" +
        avgDistanceKm +
        " km)</div>";
    }

    // Longest single flight distance
    if (stats.longest_flight_nm && stats.longest_flight_nm > 0) {
      const longestKm = (stats.longest_flight_km || 0).toFixed(1);
      html +=
        '<div style="margin-bottom: 8px;"><strong>Longest Flight:</strong> ' +
        stats.longest_flight_nm.toFixed(1) +
        " nm (" +
        longestKm +
        " km)</div>";
    }

    if (
      stats.average_groundspeed_knots &&
      stats.average_groundspeed_knots > 0
    ) {
      const kmh = Math.round(stats.average_groundspeed_knots * 1.852);
      html +=
        '<div style="margin-bottom: 8px;"><strong>Average Groundspeed:</strong> ' +
        Math.round(stats.average_groundspeed_knots) +
        " kt (" +
        kmh +
        " km/h)</div>";
    }

    if (stats.cruise_speed_knots && stats.cruise_speed_knots > 0) {
      const kmh_cruise = Math.round(stats.cruise_speed_knots * 1.852);
      html +=
        '<div style="margin-bottom: 8px;"><strong>Cruise Speed (>1000ft AGL):</strong> ' +
        Math.round(stats.cruise_speed_knots) +
        " kt (" +
        kmh_cruise +
        " km/h)</div>";
    }

    if (stats.max_groundspeed_knots && stats.max_groundspeed_knots > 0) {
      const kmh_max = Math.round(stats.max_groundspeed_knots * 1.852);
      html +=
        '<div style="margin-bottom: 8px;"><strong>Max Groundspeed:</strong> ' +
        Math.round(stats.max_groundspeed_knots) +
        " kt (" +
        kmh_max +
        " km/h)</div>";
    }

    if (stats.max_altitude_ft) {
      // Altitude with meter conversion
      const maxAltitudeM = Math.round(stats.max_altitude_ft * 0.3048);
      html +=
        '<div style="margin-bottom: 8px;"><strong>Max Altitude (MSL):</strong> ' +
        Math.round(stats.max_altitude_ft) +
        " ft (" +
        maxAltitudeM +
        " m)</div>";

      // Elevation gain with meter conversion
      if (stats.total_altitude_gain_ft) {
        const elevationGainM = Math.round(
          stats.total_altitude_gain_ft * 0.3048
        );
        html +=
          '<div style="margin-bottom: 8px;"><strong>Elevation Gain:</strong> ' +
          Math.round(stats.total_altitude_gain_ft) +
          " ft (" +
          elevationGainM +
          " m)</div>";
      }
    }

    // Most common cruise altitude
    if (
      stats.most_common_cruise_altitude_ft &&
      stats.most_common_cruise_altitude_ft > 0
    ) {
      const cruiseAltM = Math.round(stats.most_common_cruise_altitude_m || 0);
      html +=
        '<div style="margin-bottom: 8px;"><strong>Most Common Cruise Altitude (AGL):</strong> ' +
        stats.most_common_cruise_altitude_ft.toLocaleString() +
        " ft (" +
        cruiseAltM.toLocaleString() +
        " m)</div>";
    }

    const panel = domCache.get("stats-panel");
    if (panel) panel.innerHTML = DOMPurify.sanitize(html);
  }

  toggleStats(): void {
    const panel = domCache.get("stats-panel");
    if (!panel) return;

    if (panel.classList.contains("visible")) {
      // Hide with animation
      panel.classList.remove("visible");
      // Wait for animation to complete before hiding
      setTimeout(() => {
        panel.style.display = "none";
        this.app.stateManager!.saveMapState();
      }, 300);
    } else {
      // Show with animation
      panel.style.display = "block";
      // Trigger reflow to ensure transition works
      panel.offsetHeight;
      panel.classList.add("visible");
      this.app.stateManager!.saveMapState();
    }
  }
}
