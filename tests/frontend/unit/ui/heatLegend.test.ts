/**
 * The heat legend: its labels and bar worked out from the scale of the
 * heat, with the markup of map_template.html. When it shows is up to
 * followLayerVisibility (layerVisibility.test.ts).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  followHeatLegend,
  HEAT_LEGEND_TITLES,
  heatLegend,
} from "../../../../kml_heatmap/frontend/ui/heatLegend";
import {
  HEAT_FLIGHT_DENSITY,
  HEATMAP_GRADIENT,
} from "../../../../kml_heatmap/frontend/ui/heatmapPaint";
import { asMapApp, createMockApp, type MockApp } from "../../testHelpers";

/** A gradient as the page's style spells it */
function styled(gradient: string): string {
  const element = document.createElement("div");
  element.style.backgroundImage = gradient;
  return element.style.backgroundImage;
}

/** The heat legend as the page has it */
function heatLegendOfPage(): HTMLElement {
  const template = readFileSync(
    join(process.cwd(), "kml_heatmap/templates/map_template.html"),
    "utf8",
  );
  const page = new DOMParser().parseFromString(template, "text/html");
  return document.importNode(page.getElementById("heat-legend")!, true);
}

/** The stops of a gradient of heatLegend: [rgba, position in percent] */
function stopsOf(gradient: string): [string, number][] {
  return [...gradient.matchAll(/(rgba\([^)]*\)) (-?[\d.e-]+)%/g)].map(
    ([, colour, at]) => [colour!, Number(at)],
  );
}

/** Where on the bar, in percent, the heat of `density` is drawn */
function positionOf(gradient: string, density: number): number {
  const index = HEATMAP_GRADIENT.findIndex(([d]) => d === density);
  return stopsOf(gradient)[index - 1]![1];
}

describe("heatLegend", () => {
  it("labels the heatmap as drawn: 1 flight, 4, 16 and 64", () => {
    const { counts, gradient } = heatLegend(HEAT_FLIGHT_DENSITY);
    expect(counts).toEqual([1, 4, 16, 64]);
    expect(gradient.startsWith("linear-gradient(to right, ")).toBe(true);
    // Every colour of the ramp from its faintest on, in its order and its
    // own opacity
    const stops = stopsOf(gradient);
    expect(stops.map(([colour]) => colour)).toEqual(
      HEATMAP_GRADIENT.slice(1).map(
        ([, rgb, alpha]) => `rgba(${rgb}, ${alpha})`,
      ),
    );
    // One flight under the middle of the first quarter, four under the
    // second: the colours a step of four apart are a quarter apart
    expect(positionOf(gradient, 0.015)).toBeCloseTo(12.5, 9);
    expect(positionOf(gradient, 0.06)).toBeCloseTo(37.5, 9);
    // White (a density of 1) at about 67 flights, just past the last label
    expect(positionOf(gradient, 1)).toBeGreaterThan(87.5);
    expect(positionOf(gradient, 1)).toBeLessThan(90);
    // The faintest colour a step left of one flight's, off the bar
    expect(stops[0]![1]).toBeLessThan(0);
  });

  it("keeps the labels round under an exposure, and the colours under them", () => {
    // The cloud of a busy field, drawn at a quarter
    const quarter = heatLegend(HEAT_FLIGHT_DENSITY / 4);
    expect(quarter.counts).toEqual([4, 16, 64, 256]);
    expect(positionOf(quarter.gradient, 0.015)).toBeCloseTo(12.5, 9);

    // Drawn at 0.3: 3.3 flights' worth in the colour of one flight, so the
    // labels start at 4, a little to the right of that colour
    const perFlight = HEAT_FLIGHT_DENSITY * 0.3;
    const dim = heatLegend(perFlight);
    expect(dim.counts).toEqual([4, 16, 64, 256]);
    const at = positionOf(dim.gradient, 0.015);
    expect(at).toBeLessThan(12.5);
    // The colour under the first label is that of 4 flights' worth
    expect(at).toBeCloseTo(12.5 * (Math.log2(0.015 / (4 * perFlight)) + 1), 9);
    // However the ramp is shifted, its faintest colour stays off the bar
    expect(stopsOf(dim.gradient)[0]![1]).toBeLessThan(0);
  });

  it("starts at one flight however bright a flight is drawn", () => {
    expect(heatLegend(HEAT_FLIGHT_DENSITY * 3).counts).toEqual([1, 4, 16, 64]);
  });
});

describe("followHeatLegend", () => {
  let app: MockApp;
  let legend: HTMLElement;

  const labels = (): string[] =>
    [...legend.querySelectorAll(".labels > *")].map(
      (label) => label.textContent ?? "",
    );
  const bar = (): string =>
    legend.querySelector<HTMLElement>(".gradient-bar")!.style.backgroundImage;

  beforeEach(() => {
    legend = heatLegendOfPage();
    document.body.appendChild(legend);
    app = createMockApp({ heatmapVisible: true });
  });

  afterEach(() => {
    legend.remove();
  });

  it("draws the bar under the labels the page has, those of the heatmap", () => {
    expect(labels()).toEqual(["≈1 flight", "4", "16", "64"]);
    followHeatLegend(asMapApp(app));
    expect(labels()).toEqual(["≈1 flight", "4", "16", "64"]);
    expect(bar()).toBe(styled(heatLegend(HEAT_FLIGHT_DENSITY).gradient));
  });

  it("follows the cloud's scale while the cloud is drawn", () => {
    followHeatLegend(asMapApp(app));
    app.store.batch(() => {
      app.heatCloud = true;
      app.store.set("heatCloudScale", 0.5);
    });
    expect(labels()).toEqual(["≈2 flights", "8", "32", "128"]);
    expect(bar()).toBe(styled(heatLegend(HEAT_FLIGHT_DENSITY / 2).gradient));
    app.store.set("heatCloudScale", 0.25);
    expect(labels()).toEqual(["≈4 flights", "16", "64", "256"]);

    app.heatCloud = false;
    expect(labels()).toEqual(["≈1 flight", "4", "16", "64"]);
  });

  it("follows the exposure of the flat heatmap, but not in the cloud's place", () => {
    followHeatLegend(asMapApp(app));
    // A logbook of many years, drawn at a quarter
    app.heatmapExposure = 0.25;
    expect(labels()).toEqual(["≈4 flights", "16", "64", "256"]);
    expect(bar()).toBe(styled(heatLegend(HEAT_FLIGHT_DENSITY / 4).gradient));
    // A lone flight, drawn at twice its heat: one flight's colour is
    // brighter, and the labels start at one all the same
    app.heatmapExposure = 2;
    expect(labels()).toEqual(["≈1 flight", "4", "16", "64"]);
    expect(bar()).toBe(styled(heatLegend(HEAT_FLIGHT_DENSITY * 2).gradient));

    app.store.batch(() => {
      app.heatCloud = true;
      app.store.set("heatCloudScale", 0.5);
    });
    expect(labels()).toEqual(["≈2 flights", "8", "32", "128"]);
  });

  it("says what the heat counts: the distance flown with By distance on", () => {
    const title = (): string =>
      legend.querySelector("#heat-legend-what")!.textContent ?? "";
    followHeatLegend(asMapApp(app));
    expect(title()).toBe(HEAT_LEGEND_TITLES.time);
    expect(title()).toBe("Time spent");
    app.routeWeighting = true;
    expect(title()).toBe("Distance flown");
    // The labels hold: a flight's worth is a pass, of any flight
    expect(labels()).toEqual(["≈1 flight", "4", "16", "64"]);
    app.routeWeighting = false;
    expect(title()).toBe("Time spent");
  });

  it("says what the cloud shows while the cloud draws the heat", () => {
    const about = legend.querySelector<HTMLElement>("#heat-cloud-about")!;
    expect(about.hidden).toBe(true);
    followHeatLegend(asMapApp(app));
    expect(about.hidden).toBe(true);
    app.heatCloud = true;
    expect(about.hidden).toBe(false);
    app.heatCloud = false;
    expect(about.hidden).toBe(true);
  });

  it("says the direction flown shows by the pulses or the chevrons at rest, and by the chevrons alone under reduced motion", () => {
    const wording = (selector: string): string =>
      legend.querySelector(selector)!.textContent.replace(/\s+/g, " ").trim();
    expect(wording("#heat-cloud-about .heat-cloud-moving")).toBe(
      "Pulses, or chevrons at rest: the direction flown",
    );
    expect(wording("#heat-cloud-about .heat-cloud-still")).toBe(
      "Chevrons: the direction flown",
    );
    // The stylesheet shows one of the two: the chevrons' own under reduced
    // motion, where the pulses rest
    const css = readFileSync(
      join(process.cwd(), "kml_heatmap/static/features.css"),
      "utf8",
    ).replace(/\s+/g, " ");
    expect(css).toContain("#heat-legend .heat-cloud-still { display: none; }");
    expect(css).toContain(
      "@media (prefers-reduced-motion: reduce) { #heat-legend .heat-cloud-moving { display: none; } #heat-legend .heat-cloud-still { display: inline; } }",
    );
  });

  it("does nothing on a page without it", () => {
    legend.remove();
    expect(() => followHeatLegend(asMapApp(app))).not.toThrow();
  });
});
