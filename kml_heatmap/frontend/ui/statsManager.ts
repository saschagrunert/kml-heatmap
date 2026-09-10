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
import {
  escapeHtml,
  pluralFlights,
  pluralize,
  splitAirportName,
} from "../utils/htmlGenerators";
import { icon, type IconName } from "../utils/icons";
import { domCache } from "../utils/domCache";

/** Duration of the stats panel hide transition (ms) */
const PANEL_TRANSITION_MS = 300;

/** Panel element: owns visibility and the panel transition */
const PANEL_ID = "stats-panel";

/** Stand-in for a measurement the data does not carry */
const MISSING_VALUE = "—";

/** A single measurement: label, primary value and its metric equivalent */
interface Metric {
  /** Plain-text label, escaped at render */
  label: string;
  /** Primary value including its unit */
  value: string;
  /** Same measurement in the other unit system */
  alt?: string;
}

/** One lead figure at the top of the panel */
function leadItem(
  value: string,
  unit: string,
  label: string,
  alt?: string,
): string {
  return (
    '<div class="kh-stats-lead-item">' +
    '<span class="kh-stats-lead-value">' +
    escapeHtml(value) +
    (unit
      ? ' <span class="kh-stats-lead-unit">' + escapeHtml(unit) + "</span>"
      : "") +
    "</span>" +
    (alt
      ? '<span class="kh-stats-lead-alt">' + escapeHtml(alt) + "</span>"
      : "") +
    '<span class="kh-stats-lead-label">' +
    escapeHtml(label) +
    "</span>" +
    "</div>"
  );
}

/** One metric row: muted label left, value (and metric equivalent) right */
function metricRow(metric: Metric): string {
  return (
    '<li class="kh-stats-metric">' +
    '<span class="kh-stats-metric-label">' +
    escapeHtml(metric.label) +
    "</span>" +
    '<span class="kh-stats-metric-values">' +
    '<span class="kh-stats-metric-value">' +
    escapeHtml(metric.value) +
    "</span>" +
    (metric.alt
      ? '<span class="kh-stats-metric-alt">' +
        escapeHtml(metric.alt) +
        "</span>"
      : "") +
    "</span>" +
    "</li>"
  );
}

/** Section heading: line icon, uppercase label and an optional count */
function sectionTitle(
  iconName: IconName,
  label: string,
  count?: number,
): string {
  return (
    '<h3 class="kh-stats-section-title">' +
    icon(iconName, 16) +
    '<span class="kh-stats-section-label">' +
    label +
    "</span>" +
    (count === undefined
      ? ""
      : '<span class="kh-stats-section-count">' + count + "</span>") +
    "</h3>"
  );
}

/** A section of metric rows; empty when it has nothing to show */
function metricSection(
  iconName: IconName,
  label: string,
  metrics: Metric[],
): string {
  if (metrics.length === 0) return "";
  return (
    '<section class="kh-stats-section">' +
    sectionTitle(iconName, label) +
    '<ul class="kh-stats-list">' +
    metrics.map(metricRow).join("") +
    "</ul>" +
    "</section>"
  );
}

/** "15 airports in 6 countries" */
function airportSummary(numAirports: number, numCountries: number): string {
  const airports = pluralize(numAirports, "airport");
  if (numCountries <= 0) return airports;
  return airports + " in " + pluralize(numCountries, "country", "countries");
}

/** Airport list grouped by country, every entry with its code and name */
function airportGroups(grouped: Map<string, string[]>): string {
  let html = "";
  for (const [code, airports] of grouped) {
    const flag = code !== "Other" ? countryFlag(code) : "";
    const label = code === "Other" ? "Other" : countryDisplayName(code);
    html +=
      '<div class="kh-stats-group">' +
      (flag
        ? '<span class="kh-stats-group-flag" aria-hidden="true">' +
          escapeHtml(flag) +
          "</span>"
        : "") +
      '<span class="kh-stats-group-name">' +
      escapeHtml(label) +
      "</span>" +
      '<span class="kh-stats-group-count">' +
      airports.length +
      "</span>" +
      "</div>" +
      '<ul class="kh-stats-list kh-stats-airport-list">';
    for (const name of airports) {
      const airport = splitAirportName(name);
      html +=
        '<li class="kh-stats-airport">' +
        (airport.code
          ? '<span class="kh-stats-code">' +
            escapeHtml(airport.code) +
            "</span>"
          : "") +
        '<span class="kh-stats-airport-name">' +
        escapeHtml(airport.name) +
        "</span>" +
        "</li>";
    }
    html += "</ul>";
  }
  return html;
}

/** Airports section: a summary line above the list, grouped by country */
function airportsSection(stats: FilteredStatistics): string {
  if (stats.airport_names.length === 0) return "";

  const grouped = groupByCountry(stats.airport_names);
  let numCountries = 0;
  for (const code of grouped.keys()) {
    if (code !== "Other") numCountries += 1;
  }

  return (
    '<section class="kh-stats-section">' +
    sectionTitle("airport", "Airports", stats.num_airports) +
    '<p class="kh-stats-airports-summary">' +
    airportSummary(stats.num_airports, numCountries) +
    "</p>" +
    '<div class="kh-stats-groups">' +
    airportGroups(grouped) +
    "</div>" +
    "</section>"
  );
}

/** Aircraft section: registration, type and flight count per aircraft */
function aircraftSection(stats: FilteredStatistics): string {
  if (stats.num_aircraft === 0 || stats.aircraft_list.length === 0) return "";

  let rows = "";
  for (const aircraft of stats.aircraft_list) {
    rows +=
      '<li class="kh-stats-metric kh-stats-aircraft">' +
      '<span class="kh-stats-metric-label">' +
      '<span class="kh-stats-code">' +
      escapeHtml(aircraft.registration) +
      "</span>" +
      (aircraft.type
        ? '<span class="kh-stats-aircraft-type">' +
          escapeHtml(aircraft.type) +
          "</span>"
        : "") +
      "</span>" +
      '<span class="kh-stats-metric-values">' +
      '<span class="kh-stats-metric-value">' +
      pluralFlights(aircraft.flights) +
      "</span>" +
      (aircraft.flight_time_str
        ? '<span class="kh-stats-metric-alt">' +
          escapeHtml(aircraft.flight_time_str) +
          "</span>"
        : "") +
      "</span>" +
      "</li>";
  }

  return (
    '<section class="kh-stats-section">' +
    sectionTitle("aircraft", "Aircraft", stats.num_aircraft) +
    '<ul class="kh-stats-list">' +
    rows +
    "</ul>" +
    "</section>"
  );
}

/** Distance rows beyond the lead figure */
function distanceMetrics(stats: FilteredStatistics): Metric[] {
  const metrics: Metric[] = [];

  if (stats.num_paths > 0) {
    const avgDistanceNm = stats.total_distance_nm / stats.num_paths;
    metrics.push({
      label: "Average Distance per Trip",
      value: avgDistanceNm.toFixed(1) + " nm",
      alt: (avgDistanceNm * NAUTICAL_MILES_TO_KM).toFixed(1) + " km",
    });
  }

  if (stats.longest_flight_nm && stats.longest_flight_nm > 0) {
    metrics.push({
      label: "Longest Flight",
      value: stats.longest_flight_nm.toFixed(1) + " nm",
      alt: (stats.longest_flight_km || 0).toFixed(1) + " km",
    });
  }

  return metrics;
}

/** Groundspeed rows, knots first and km/h underneath */
function speedMetrics(stats: FilteredStatistics): Metric[] {
  const metrics: Metric[] = [];
  const speeds: Array<[string, number | undefined]> = [
    ["Average Groundspeed", stats.avg_groundspeed_knots],
    ["Cruise Speed (>1000ft AGL)", stats.cruise_speed_knots],
    ["Max Groundspeed", stats.max_groundspeed_knots],
  ];

  for (const [label, knots] of speeds) {
    if (knots && knots > 0) {
      metrics.push({
        label,
        value: Math.round(knots) + " kt",
        alt: Math.round(knots * NAUTICAL_MILES_TO_KM) + " km/h",
      });
    }
  }

  return metrics;
}

/** Altitude rows, feet first and meters underneath */
function altitudeMetrics(stats: FilteredStatistics): Metric[] {
  const metrics: Metric[] = [];

  if (stats.max_altitude_ft) {
    metrics.push({
      label: "Max Altitude (MSL)",
      value: Math.round(stats.max_altitude_ft) + " ft",
      alt: Math.round(stats.max_altitude_ft * FEET_TO_METERS) + " m",
    });

    if (stats.total_altitude_gain_ft) {
      metrics.push({
        label: "Elevation Gain",
        value: Math.round(stats.total_altitude_gain_ft) + " ft",
        alt: Math.round(stats.total_altitude_gain_ft * FEET_TO_METERS) + " m",
      });
    }
  }

  if (
    stats.most_common_cruise_altitude_ft &&
    stats.most_common_cruise_altitude_ft > 0
  ) {
    metrics.push({
      label: "Most Common Cruise Altitude (AGL)",
      value: stats.most_common_cruise_altitude_ft + " ft",
      alt: Math.round(stats.most_common_cruise_altitude_m || 0) + " m",
    });
  }

  return metrics;
}

export class StatsManager {
  private app: MapApp;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;
  /** Markup of the last render; an identical result is not written again */
  private lastHtml: string | null = null;

  constructor(app: MapApp) {
    this.app = app;

    // Pre-cache the stats panel element
    domCache.cacheElements([PANEL_ID]);
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

    // A selection without segments still gets rendered: leaving the previous
    // flight's numbers under the "Selected Paths" title would be worse
    const selectedStats = calculateFilteredStatistics({
      pathInfo: selectedPathInfo,
      segments: selectedSegments,
      year: "all", // Don't filter by year for selection
      aircraft: "all", // Don't filter by aircraft for selection
    });

    this.updateStatsPanel(selectedStats, true);
  }

  updateStatsPanel(stats: FilteredStatistics, isSelection: boolean): void {
    const panel = domCache.get(PANEL_ID);
    if (!panel) return;

    const titleEl = document.getElementById("stats-rail-title");
    if (titleEl) {
      const textEl = titleEl.querySelector(".kh-stats-title-text");
      if (textEl)
        textEl.textContent = isSelection
          ? "Selected Paths Statistics"
          : "Flight Statistics";
    }

    let html = '<div class="kh-stats">';

    if (isSelection) {
      html +=
        '<div class="kh-stats-note">Showing stats for ' +
        pluralize(stats.num_paths, "selected path") +
        "</div>";
    }

    // Lead figures: what the flying adds up to
    const distanceKm = stats.total_distance_nm * NAUTICAL_MILES_TO_KM;
    html +=
      '<div class="kh-stats-lead">' +
      leadItem(
        stats.total_distance_nm.toFixed(1),
        "nm",
        "Distance",
        distanceKm.toFixed(1) + " km",
      ) +
      // Kept even without timing data so the grid always reads as four cells
      leadItem(
        stats.total_flight_time_str || MISSING_VALUE,
        "",
        "Total Flight Time",
      ) +
      leadItem(String(stats.num_paths), "", "Flights") +
      leadItem(String(stats.num_airports), "", "Airports") +
      "</div>";

    html += metricSection("aviation", "Distance", distanceMetrics(stats));
    html += metricSection("speed", "Speed", speedMetrics(stats));
    html += metricSection("altitude", "Altitude", altitudeMetrics(stats));
    html += aircraftSection(stats);
    html += airportsSection(stats);

    // Data points measure the export, not the flying
    html +=
      '<p class="kh-stats-footer">' +
      pluralize(stats.total_points, "data point") +
      "</p>";

    html += "</div>";

    // Rewriting identical markup reflows the whole list and drops focus out
    // of the panel, and most refreshes produce exactly the same content
    if (html === this.lastHtml && panel.firstChild !== null) return;
    this.lastHtml = html;
    panel.innerHTML = html;
  }

  /**
   * Show or hide the stats panel. The store key `statsPanelVisible` is the
   * source of truth for state persistence.
   * @param visible - Target visibility
   * @param save - Persist the state after the change (default true)
   */
  setStatsPanelVisible(visible: boolean, save = true): void {
    const panel = domCache.get(PANEL_ID);
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
    this.setStatsPanelVisible(!this.app.store.get("statsPanelVisible"));
  }
}
