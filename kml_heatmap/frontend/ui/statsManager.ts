/**
 * Stats Manager - Handles statistics panel updates
 */
import type { MapApp } from "../mapApp";
import type { FilteredStatistics } from "../types";
import { calculateFilteredStatistics } from "../calculations/statistics";
import {
  countryDisplayName,
  countryFlag,
  groupByCountry,
} from "../features/airports";
import { FEET_TO_METERS, NAUTICAL_MILES_TO_KM } from "../utils/constants";
import { escapeHtml } from "../utils/htmlGenerators";
import { domCache } from "../utils/domCache";

/** Duration of the stats panel hide transition (ms) */
const PANEL_TRANSITION_MS = 300;

function statsRow(label: string, value: string): string {
  return (
    '<div class="kh-stats-row"><strong>' +
    label +
    ":</strong> " +
    value +
    "</div>"
  );
}

export class StatsManager {
  private app: MapApp;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(app: MapApp) {
    this.app = app;

    // Pre-cache stats panel element
    domCache.cacheElements(["stats-panel"]);
  }

  updateStatsForSelection(): void {
    const pathInfo = this.app.fullPathInfo ?? [];
    const segments = this.app.fullPathSegments ?? [];

    if (this.app.selectedPathIds.size === 0) {
      const statsToShow = calculateFilteredStatistics({
        pathInfo,
        segments,
        year: this.app.selectedYear,
        aircraft: this.app.selectedAircraft,
        coordinateCount: this.app.currentData?.original_points,
      });
      this.updateStatsPanel(statsToShow, false);
      return;
    }

    // Calculate stats for selected paths only
    const selectedPathInfo = pathInfo.filter((path) =>
      this.app.selectedPathIds.has(path.id),
    );
    const selectedSegments = segments.filter((segment) =>
      this.app.selectedPathIds.has(segment.path_id),
    );

    if (selectedSegments.length === 0) return;

    // Calculate unique coordinate count from selected segments
    const coordSet = new Set<string>();
    for (const segment of selectedSegments) {
      if (segment.coords && segment.coords.length === 2) {
        const c0 = segment.coords[0];
        const c1 = segment.coords[1];
        coordSet.add(c0[0] + "," + c0[1]);
        coordSet.add(c1[0] + "," + c1[1]);
      }
    }

    const selectedStats = calculateFilteredStatistics({
      pathInfo: selectedPathInfo,
      segments: selectedSegments,
      year: "all", // Don't filter by year for selection
      aircraft: "all", // Don't filter by aircraft for selection
      coordinateCount: coordSet.size,
    });

    this.updateStatsPanel(selectedStats, true);
  }

  updateStatsPanel(stats: FilteredStatistics, isSelection: boolean): void {
    let html = "";

    // Add indicator if showing selected paths only
    if (isSelection) {
      html += '<h2 class="kh-stats-title">📊 Selected Paths Statistics</h2>';
      html +=
        '<div class="kh-stats-note">Showing stats for ' +
        stats.num_paths +
        " selected path(s)</div>";
    } else {
      html += '<h2 class="kh-stats-title">📊 Flight Statistics</h2>';
    }

    html += statsRow("Data Points", String(stats.total_points));
    html += statsRow("Flights", String(stats.num_paths));

    if (stats.airport_names.length > 0) {
      const grouped = groupByCountry(stats.airport_names);
      html +=
        '<div class="kh-stats-row kh-stats-scroll kh-stats-scroll-airports" tabindex="0">' +
        '<h3 class="kh-stats-subtitle">Airports (' +
        stats.num_airports +
        "):</h3>";
      for (const [code, airports] of grouped) {
        const f = code !== "Other" ? countryFlag(code) : "";
        const label =
          code === "Other" ? "Other" : escapeHtml(countryDisplayName(code));
        const title = f ? label + " &ensp;" + f : label;
        html += '<div class="kh-stats-group">' + title + "</div>";
        html += '<ul class="kh-stats-list">';
        for (const name of airports) {
          html += "<li>" + escapeHtml(name) + "</li>";
        }
        html += "</ul>";
      }
      html += "</div>";
    }

    if (stats.num_aircraft > 0 && stats.aircraft_list.length > 0) {
      html +=
        '<div class="kh-stats-row kh-stats-scroll kh-stats-scroll-aircraft" tabindex="0">' +
        '<h3 class="kh-stats-subtitle">Aircraft (' +
        stats.num_aircraft +
        "):</h3>" +
        '<ul class="kh-stats-list">';
      stats.aircraft_list.forEach((aircraft) => {
        const typeStr = aircraft.type
          ? " (" + escapeHtml(aircraft.type) + ")"
          : "";
        html +=
          "<li>" +
          escapeHtml(aircraft.registration) +
          typeStr +
          " - " +
          aircraft.flights +
          " flight(s)</li>";
      });
      html += "</ul></div>";
    }

    if (stats.total_flight_time_str) {
      html += statsRow("Total Flight Time", stats.total_flight_time_str);
    }

    // Distance with km conversion
    const distanceKm = (stats.total_distance_nm * NAUTICAL_MILES_TO_KM).toFixed(
      1,
    );
    html += statsRow(
      "Distance",
      stats.total_distance_nm.toFixed(1) + " nm (" + distanceKm + " km)",
    );

    // Average distance per trip
    if (stats.num_paths > 0) {
      const avgDistanceNm = (stats.total_distance_nm / stats.num_paths).toFixed(
        1,
      );
      const avgDistanceKm = (
        parseFloat(avgDistanceNm) * NAUTICAL_MILES_TO_KM
      ).toFixed(1);
      html += statsRow(
        "Average Distance per Trip",
        avgDistanceNm + " nm (" + avgDistanceKm + " km)",
      );
    }

    // Longest single flight distance
    if (stats.longest_flight_nm && stats.longest_flight_nm > 0) {
      const longestKm = (stats.longest_flight_km || 0).toFixed(1);
      html += statsRow(
        "Longest Flight",
        stats.longest_flight_nm.toFixed(1) + " nm (" + longestKm + " km)",
      );
    }

    if (stats.avg_groundspeed_knots && stats.avg_groundspeed_knots > 0) {
      const kmh = Math.round(
        stats.avg_groundspeed_knots * NAUTICAL_MILES_TO_KM,
      );
      html += statsRow(
        "Average Groundspeed",
        Math.round(stats.avg_groundspeed_knots) + " kt (" + kmh + " km/h)",
      );
    }

    if (stats.cruise_speed_knots && stats.cruise_speed_knots > 0) {
      const kmhCruise = Math.round(
        stats.cruise_speed_knots * NAUTICAL_MILES_TO_KM,
      );
      html += statsRow(
        "Cruise Speed (>1000ft AGL)",
        Math.round(stats.cruise_speed_knots) + " kt (" + kmhCruise + " km/h)",
      );
    }

    if (stats.max_groundspeed_knots && stats.max_groundspeed_knots > 0) {
      const kmhMax = Math.round(
        stats.max_groundspeed_knots * NAUTICAL_MILES_TO_KM,
      );
      html += statsRow(
        "Max Groundspeed",
        Math.round(stats.max_groundspeed_knots) + " kt (" + kmhMax + " km/h)",
      );
    }

    if (stats.max_altitude_ft) {
      // Altitude with meter conversion
      const maxAltitudeM = Math.round(stats.max_altitude_ft * FEET_TO_METERS);
      html += statsRow(
        "Max Altitude (MSL)",
        Math.round(stats.max_altitude_ft) + " ft (" + maxAltitudeM + " m)",
      );

      // Elevation gain with meter conversion
      if (stats.total_altitude_gain_ft) {
        const elevationGainM = Math.round(
          stats.total_altitude_gain_ft * FEET_TO_METERS,
        );
        html += statsRow(
          "Elevation Gain",
          Math.round(stats.total_altitude_gain_ft) +
            " ft (" +
            elevationGainM +
            " m)",
        );
      }
    }

    // Most common cruise altitude
    if (
      stats.most_common_cruise_altitude_ft &&
      stats.most_common_cruise_altitude_ft > 0
    ) {
      const cruiseAltM = Math.round(stats.most_common_cruise_altitude_m || 0);
      html += statsRow(
        "Most Common Cruise Altitude (AGL)",
        stats.most_common_cruise_altitude_ft + " ft (" + cruiseAltM + " m)",
      );
    }

    const panel = domCache.get("stats-panel");
    if (panel) panel.innerHTML = html;
  }

  /**
   * Show or hide the stats panel. The store key `statsPanelVisible` is the
   * source of truth for state persistence.
   * @param visible - Target visibility
   * @param save - Persist the state after the change (default true)
   */
  setStatsPanelVisible(visible: boolean, save = true): void {
    const panel = domCache.get("stats-panel");
    if (!panel) return;

    if (this.closeTimer !== null) {
      clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }

    this.app.store.set("statsPanelVisible", visible);

    if (visible) {
      // Show with animation
      panel.style.display = "block";
      // Trigger reflow to ensure transition works
      panel.offsetHeight;
      panel.classList.add("visible");
      if (save) this.app.stateManager.saveMapState();
    } else {
      // Hide with animation, then remove from layout
      panel.classList.remove("visible");
      this.closeTimer = setTimeout(() => {
        this.closeTimer = null;
        panel.style.display = "none";
        if (save) this.app.stateManager.saveMapState();
      }, PANEL_TRANSITION_MS);
    }
  }

  toggleStats(): void {
    const panel = domCache.get("stats-panel");
    if (!panel) return;
    this.setStatsPanelVisible(!panel.classList.contains("visible"));
  }
}
