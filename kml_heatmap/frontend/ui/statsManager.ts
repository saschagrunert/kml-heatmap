/**
 * Stats Manager - Handles statistics panel updates
 */
import type { MapApp } from "../mapApp";
import type { FilteredStatistics, PathInfo, PathSegment } from "../types";
import {
  calculateFilteredStatistics,
  segmentsForPathIds,
} from "../calculations/statistics";
import {
  countryDisplayName,
  countryFlagSrc,
  groupByCountry,
} from "../features/airports";
import { FEET_TO_METERS, NAUTICAL_MILES_TO_KM } from "../utils/constants";
import { formatNumber } from "../utils/formatters";
import {
  escapeHtml,
  markFlightTimeUnits,
  pluralFlights,
  pluralize,
  splitAirportName,
} from "../utils/htmlGenerators";
import { icon, type IconName } from "../utils/icons";
import { domCache } from "../utils/domCache";
import { datasetIndex } from "../calculations/datasetIndex";
import { watchScrollEnd, type ScrollEndWatcher } from "../utils/scrollFade";

/** Panel element the statistics are rendered into */
const PANEL_ID = "stats-panel";

/** Store keys the rendered statistics depend on */
const STATS_KEYS = [
  "currentData",
  "selectedPathIds",
  "selectedYear",
  "selectedAircraft",
] as const;

/** Everything a statistics render was computed from */
interface StatsInputs {
  pathInfo: PathInfo[];
  segments: PathSegment[];
  year: string;
  aircraft: string;
  /** Sorted selected path ids, or "" without a selection */
  selection: string;
}

/** Stand-in for a measurement the data does not carry */
const MISSING_VALUE = "—";

/** A single measurement: label, primary value and its metric equivalent */
interface Metric {
  /** Plain-text label, escaped at render */
  label: string;
  /** Primary value, without its unit */
  value: string;
  /** Unit of `value`, set against it at render (see `figure`) */
  unit: string;
  /** Same measurement in the other unit system, without its unit */
  alt?: string;
  /** Unit of `alt` */
  altUnit?: string;
}

/**
 * A number with its unit set against it: the stylesheet opens one hairline of
 * space rather than the word space this used to carry, the same treatment the
 * lead figures and the h and m of a flight time get. The two arrive
 * separately rather than as one formatted string because most callers of the
 * formatters want plain text, for a title or an aria-label, and only the
 * places that typeset a figure want the split.
 */
function figure(value: string, unit: string): string {
  return (
    escapeHtml(value) +
    (unit ? '<span class="kh-stats-unit">' + escapeHtml(unit) + "</span>" : "")
  );
}

/**
 * One lead figure at the top of the panel.
 *
 * No space in the markup: `.kh-stats-lead-unit` opens one hairline of
 * `--unit-gap` with a margin. The h and m that markFlightTimeUnits marks up
 * carry the same class and so are set the same way, which is the point.
 */
function leadItem(
  value: string,
  unit: string,
  label: string,
  altHtml?: string,
): string {
  return leadItemHtml(
    escapeHtml(value) +
      (unit
        ? '<span class="kh-stats-lead-unit">' + escapeHtml(unit) + "</span>"
        : ""),
    label,
    altHtml,
  );
}

/**
 * A lead figure whose value is already marked up (see markFlightTimeUnits).
 *
 * Both `valueHtml` and `altHtml` are inserted as markup, so a caller escapes
 * whatever it puts in them, or builds them with `figure`, which escapes. They
 * are named for it: everything else in this module takes plain text and
 * escapes it here.
 */
function leadItemHtml(
  valueHtml: string,
  label: string,
  altHtml?: string,
): string {
  return (
    '<div class="kh-stats-lead-item">' +
    '<span class="kh-stats-lead-value">' +
    valueHtml +
    "</span>" +
    (altHtml ? '<span class="kh-stats-lead-alt">' + altHtml + "</span>" : "") +
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
    figure(metric.value, metric.unit) +
    "</span>" +
    (metric.alt
      ? '<span class="kh-stats-metric-alt">' +
        figure(metric.alt, metric.altUnit ?? "") +
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

/**
 * The mark beside a country's name: its flag where the site carries one,
 * otherwise the ISO code as a chip. Emoji flags are not an option, whatever
 * the platform: Windows has no glyphs for them at all.
 */
function countryMark(code: string): string {
  const src = countryFlagSrc(code);
  return src
    ? '<img class="kh-stats-group-flag" src="' +
        escapeHtml(src) +
        '" alt="" width="16" height="12" loading="lazy">'
    : '<span class="kh-stats-group-code" aria-hidden="true">' +
        escapeHtml(code) +
        "</span>";
}

/** Airport list grouped by country, every entry with its code and name */
function airportGroups(grouped: Map<string, string[]>): string {
  let html = "";
  for (const [code, airports] of grouped) {
    const isCountry = code !== "Other";
    const label = isCountry ? countryDisplayName(code) : "Other";
    html +=
      '<div class="kh-stats-group">' +
      (isCountry ? countryMark(code) : "") +
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
      value: formatNumber(avgDistanceNm, 1),
      unit: "nm",
      alt: formatNumber(avgDistanceNm * NAUTICAL_MILES_TO_KM, 1),
      altUnit: "km",
    });
  }

  if (stats.longest_flight_nm && stats.longest_flight_nm > 0) {
    metrics.push({
      label: "Longest Flight",
      value: formatNumber(stats.longest_flight_nm, 1),
      unit: "nm",
      alt: formatNumber(stats.longest_flight_km || 0, 1),
      altUnit: "km",
    });
  }

  return metrics;
}

/** Groundspeed rows, knots first and km/h underneath */
function speedMetrics(stats: FilteredStatistics): Metric[] {
  const metrics: Metric[] = [];
  const speeds: Array<[string, number | undefined]> = [
    ["Average Groundspeed", stats.avg_groundspeed_knots],
    ["Cruise Speed (> 1000 ft AGL)", stats.cruise_speed_knots],
    ["Max Groundspeed", stats.max_groundspeed_knots],
  ];

  for (const [label, knots] of speeds) {
    if (knots && knots > 0) {
      metrics.push({
        label,
        value: formatNumber(knots),
        unit: "kt",
        alt: formatNumber(knots * NAUTICAL_MILES_TO_KM),
        altUnit: "km/h",
      });
    }
  }

  return metrics;
}

/** Altitude rows, feet first and meters underneath */
function altitudeMetrics(stats: FilteredStatistics): Metric[] {
  const metrics: Metric[] = [];

  // 0 ft is an altitude; undefined means the filter has none
  if (stats.max_altitude_ft !== undefined) {
    metrics.push({
      label: "Max Altitude (MSL)",
      value: formatNumber(stats.max_altitude_ft),
      unit: "ft",
      alt: formatNumber(stats.max_altitude_ft * FEET_TO_METERS),
      altUnit: "m",
    });

    if (stats.total_altitude_gain_ft !== undefined) {
      metrics.push({
        label: "Elevation Gain",
        value: formatNumber(stats.total_altitude_gain_ft),
        unit: "ft",
        alt: formatNumber(stats.total_altitude_gain_ft * FEET_TO_METERS),
        altUnit: "m",
      });
    }
  }

  if (
    stats.most_common_cruise_altitude_ft &&
    stats.most_common_cruise_altitude_ft > 0
  ) {
    metrics.push({
      label: "Most Common Cruise Altitude (AGL)",
      value: formatNumber(stats.most_common_cruise_altitude_ft),
      unit: "ft",
      alt: formatNumber(stats.most_common_cruise_altitude_m || 0),
      altUnit: "m",
    });
  }

  return metrics;
}

export class StatsManager {
  private app: MapApp;
  /** Markup of the last render; an identical result is not written again */
  private lastHtml: string | null = null;
  /** Keeps the panel's bottom fade in step with what it holds */
  private scrollWatcher: ScrollEndWatcher | null = null;
  /** What the last statistics were computed from; identical inputs skip it */
  private lastInputs: StatsInputs | null = null;

  constructor(app: MapApp) {
    this.app = app;

    // The panel follows the data, the filters and the selection; nothing has
    // to call it. The statistics walk every segment of the filter, so they
    // are only computed for an open panel, and once per update however many
    // of the keys it changed.
    app.store.subscribeKeys(STATS_KEYS, () => {
      if (app.store.get("statsPanelVisible")) this.updateStatsForSelection();
    });
    // The rail on desktop and the Stats tab on mobile both open this panel
    // through the same key. Opening it renders whatever changed while it was
    // closed; lastInputs skips the work when nothing did.
    app.store.subscribe("statsPanelVisible", (visible) => {
      if (!visible) return;
      this.updateStatsForSelection();
      // A closed rail measures zero, so whatever the panel was told about
      // its own overflow while it was hidden was "everything fits". The
      // next frame is the first one that can measure it.
      requestAnimationFrame(() => this.scrollWatcher?.update());
    });

    // The rail holds around twice its own height of content on a phone, and
    // it used to end in a row sliced in half wherever the panel stopped
    const panel = domCache.get(PANEL_ID);
    if (panel) this.scrollWatcher = watchScrollEnd(panel);
  }

  /** The inputs of the current state, in a shape that compares cheaply */
  private currentInputs(): StatsInputs {
    const selected = this.app.selectedPathIds;
    return {
      pathInfo: this.app.fullPathInfo ?? [],
      segments: this.app.fullPathSegments ?? [],
      year: this.app.selectedYear,
      aircraft: this.app.selectedAircraft,
      selection:
        selected.size === 0
          ? ""
          : Array.from(selected)
              .sort((a, b) => a - b)
              .join(","),
    };
  }

  private static sameInputs(a: StatsInputs, b: StatsInputs): boolean {
    return (
      a.pathInfo === b.pathInfo &&
      a.segments === b.segments &&
      a.year === b.year &&
      a.aircraft === b.aircraft &&
      a.selection === b.selection
    );
  }

  /**
   * Render the statistics of the current filter, or of the selection when
   * there is one. The calculation walks every segment, so it only runs
   * when something it depends on has changed; a selection click that ends
   * in the same state as before costs nothing.
   */
  updateStatsForSelection(): void {
    const inputs = this.currentInputs();
    if (this.lastInputs && StatsManager.sameInputs(this.lastInputs, inputs)) {
      return;
    }
    this.lastInputs = inputs;

    const { pathInfo, segments } = inputs;
    const selected = this.app.selectedPathIds;

    if (selected.size === 0) {
      // Clearing a selection comes back to the filter's statistics, which
      // are kept with the dataset instead of computed again every time
      const data = this.app.currentData;
      const statsToShow = data
        ? datasetIndex(data).filter(inputs.year, inputs.aircraft).statistics()
        : calculateFilteredStatistics({ pathInfo, segments });
      this.updateStatsPanel(statsToShow, false);
      return;
    }

    // Calculate stats for selected paths only
    const selectedPathInfo = pathInfo.filter((path) => selected.has(path.id));
    const selectedSegments = segmentsForPathIds(segments, selected);

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
        formatNumber(stats.total_distance_nm, 1),
        "nm",
        "Distance",
        figure(formatNumber(distanceKm, 1), "km"),
      ) +
      // Kept even without timing data so the grid always reads as four cells
      leadItemHtml(
        stats.total_flight_time_str
          ? markFlightTimeUnits(
              stats.total_flight_time_str,
              "kh-stats-lead-unit",
            )
          : escapeHtml(MISSING_VALUE),
        "Total Flight Time",
      ) +
      leadItem(formatNumber(stats.num_paths), "", "Flights") +
      leadItem(formatNumber(stats.num_airports), "", "Airports") +
      "</div>";

    html += metricSection("distance", "Distance", distanceMetrics(stats));
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
    // New content, so whether there is more of it below has changed too
    this.scrollWatcher?.update();
  }

  /**
   * Show or hide the stats panel. The store key `statsPanelVisible` is the
   * source of truth: the rail, the triggers and state persistence all
   * follow it, so this is a store write and nothing else.
   * @param visible - Target visibility
   */
  setStatsPanelVisible(visible: boolean): void {
    this.app.store.set("statsPanelVisible", visible);
  }

  toggleStats(): void {
    this.setStatsPanelVisible(!this.app.store.get("statsPanelVisible"));
  }
}
