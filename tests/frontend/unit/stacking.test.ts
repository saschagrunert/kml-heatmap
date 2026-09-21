import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The airplane and the popups share one stacking context on the map, and the
 * stylesheets own their order. An airplane above an open airport popup
 * covers it and takes the clicks meant for its buttons.
 */
function sheet(name: string): string {
  return readFileSync(
    resolve(__dirname, "../../../kml_heatmap/static", name),
    "utf8",
  );
}

function token(css: string, name: string): number {
  const match = new RegExp(`${name}:\\s*(\\d+);`).exec(css);
  expect(match, name).not.toBeNull();
  return Number(match![1]);
}

function rule(css: string, selector: string): string {
  const start = css.indexOf(`\n${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf("}", start));
}

describe("stacking on the map", () => {
  const styles = sheet("styles.css");
  const features = sheet("features.css");

  it("puts a popup above the airplane", () => {
    expect(token(styles, "--z-map-popup")).toBeGreaterThan(
      token(styles, "--z-map-airplane"),
    );
  });

  it("keeps both below the chrome around the map", () => {
    expect(token(styles, "--z-map-popup")).toBeLessThan(
      token(styles, "--z-legend"),
    );
  });

  it("stacks the popup and the airplane through the tokens", () => {
    expect(rule(styles, ".maplibregl-popup")).toContain(
      "z-index: var(--z-map-popup);",
    );
    expect(rule(features, ".replay-airplane-root")).toContain(
      "z-index: var(--z-map-airplane);",
    );
  });
});
