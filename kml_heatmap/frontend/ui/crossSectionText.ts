/**
 * Cross-section text - what the chart of a section says in words
 *
 * The figures above the chart, its readout, the labels of its axis and of
 * the corridor's widths, and the summary a screen reader hears
 * (`sectionSummary`, which is also the chart's accessible name) all say a
 * section's heat the same way: as time spent, or with the heatmap's By
 * distance switch on as the distance flown (`formatAmount`), and its
 * heights in the unit the section was worked out in (`heightUnit`). The
 * tool (ui/crossSection.ts) and its chart (ui/crossSectionChart.ts) both
 * take their words from here, so the two never disagree.
 */
import type { CrossSection } from "../calculations/crossSection";
import { ROUTE_SPEED_MS } from "../calculations/heatLines";
import { formatDuration } from "../utils/duration";
import { formatNumber } from "../utils/formatters";

/** The labels of the corridor's widths */
export function widthLabel(metres: number): string {
  return metres < 1000 ? `±${metres} m` : `±${metres / 1000} km`;
}

/** Kilometres, with a decimal under ten */
export function formatKm(metres: number): string {
  const km = metres / 1000;
  return `${formatNumber(km, km < 10 ? 1 : 0)} km`;
}

/**
 * The heat of `seconds` of a section as its figures say it: the time
 * spent, or by distance the distance flown (lengths at ROUTE_SPEED_MS)
 */
export function formatAmount(section: CrossSection, seconds: number): string {
  return section.route
    ? formatKm(seconds * ROUTE_SPEED_MS)
    : formatDuration(seconds);
}

/** The unit of the heights of a section */
export function heightUnit(section: CrossSection): string {
  if (section.reference === "msl") return "ft MSL";
  return section.fromTerrain ? "ft AGL" : "ft above field";
}

/**
 * What the chart says, for a screen reader: the line, the corridor, the
 * time (the distance flown, By distance on), the flights and where most
 * of it was
 */
export function sectionSummary(
  section: CrossSection,
  selected: number,
): string {
  const where = `within ${widthLabel(section.halfWidthM).slice(1)} of a ${formatKm(section.lengthM)} line`;
  if (section.totalSeconds <= 0) {
    return `Cross-section: no ${selected ? "selected " : ""}flight passes ${where}`;
  }
  const flights = `${formatNumber(section.flights)} ${selected ? "selected " : ""}flight${section.flights === 1 ? "" : "s"}`;
  const busiest = section.busiest
    ? `, most of it in the air between ${formatNumber(section.busiest[0])} and ${formatNumber(section.busiest[1])} ${heightUnit(section)}`
    : "";
  const amount = formatAmount(section, section.totalSeconds);
  return `Cross-section: ${amount} ${section.route ? "flown by" : "from"} ${flights} ${where}${busiest}`;
}
