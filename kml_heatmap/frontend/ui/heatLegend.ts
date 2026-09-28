/**
 * The heat legend: the colours of the heat, of the flat heatmap and of the
 * cloud of the 3D view alike, with about how many flights' worth of time
 * spent, or of distance flown with By distance on, each stands for (see
 * ui/heatScale.ts). Its markup is in the page, with the labels of the
 * heatmap drawn unscaled; it shows with the other colour legends (see
 * followLayerVisibility), and says what the cloud shows while the cloud
 * draws the heat.
 *
 * Its labels are four steps of four apart, "≈1 pass · 4 · 16 · 64" for the
 * heatmap drawn unscaled, each under the middle of its quarter of the bar, and
 * the bar is drawn in a scale of those steps: the ramp is laid under the
 * labels rather than the labels over the ramp, so the labels stay round
 * numbers whatever the exposure. The first is the power of two nearest the
 * flights' worth the colour of one flight at full strength stands for.
 * They are about as many flights as the logs are near the pace of fixes
 * the heat is made for (see ui/heatScale.ts).
 *
 * A flight's worth is the heat of one pass over a place, of any flight: the
 * time it takes, or with By distance on its length. The labels count
 * passes, which say both; "≈1 flight" under "Distance flown" read as a
 * count of flights.
 */
import type { MapApp } from "../mapApp";
import { domCache } from "../utils/domCache";
import { heatUntone } from "../calculations/heatTone";
import { HEAT_FLIGHT_DENSITY, HEATMAP_GRADIENT } from "./heatmapPaint";
import { heatScale } from "./heatScale";

/**
 * The labels of the legend, in flights' worth, and its bar as a CSS
 * gradient, for heat drawn at the density `perFlight` for each flight's
 * worth (see heatScale). The bar spans four steps of four, the step of the
 * ramp's colours, half a step on either side of the outer labels, and the
 * colour under the middle of each label is the one its count is drawn in.
 * The ramp's faintest colour, a quarter of one flight's, lies a step left
 * of the first label, off the bar; where it fades in from nothing, further
 * left still (on this scale infinitely far), is left out. The colours
 * beyond the knee of the heat stand for the flights' worth rolled off to
 * them (see heatTone), further apart than their densities.
 */
export function heatLegend(perFlight: number): {
  counts: number[];
  gradient: string;
} {
  const first = Math.max(
    1,
    2 ** Math.round(Math.log2(HEAT_FLIGHT_DENSITY / perFlight)),
  );
  // A step of four is two powers of two, a quarter of the bar
  const stops = HEATMAP_GRADIENT.slice(1).map(
    ([density, rgb, alpha]) =>
      `rgba(${rgb}, ${alpha}) ${12.5 * (Math.log2((heatUntone(density / HEAT_FLIGHT_DENSITY) * HEAT_FLIGHT_DENSITY) / perFlight / first) + 1)}%`,
  );
  return {
    counts: [1, 4, 16, 64].map((step) => first * step),
    gradient: `linear-gradient(to right, ${stops.join()})`,
  };
}

/**
 * What the heat counts, as the legend's title says it: the time spent, or
 * with By distance on the distance flown (see heatWeight)
 */
export const HEAT_LEGEND_TITLES = {
  time: "Time spent",
  distance: "Distance flown",
} as const;

/**
 * Keep the title, the labels and the bar of the heat legend in step with
 * what the heat counts and its scale (see heatScale), and what the cloud
 * shows in it while the cloud draws the heat, from now on for as long as
 * the app lives
 */
export function followHeatLegend(app: MapApp): void {
  const legend = domCache.get("heat-legend");
  if (!legend) return;
  const bar = legend.querySelector<HTMLElement>(".gradient-bar")!;
  const labels = legend.querySelectorAll(".labels > *");
  const what = domCache.get("heat-legend-what");
  const about = domCache.get("heat-cloud-about");
  const label = (): void => {
    const { counts, gradient } = heatLegend(heatScale(app));
    bar.style.backgroundImage = gradient;
    labels.forEach((text, i) => {
      text.textContent = i
        ? `${counts[i]}`
        : `≈${counts[0]} ${counts[0]! > 1 ? "passes" : "pass"}`;
    });
    if (what) {
      what.textContent =
        HEAT_LEGEND_TITLES[app.routeWeighting ? "distance" : "time"];
    }
    if (about) about.hidden = !app.heatCloud;
  };
  app.store.subscribeKeys(
    ["heatCloud", "heatCloudScale", "heatmapExposure", "routeWeighting"],
    label,
  );
  label();
}
