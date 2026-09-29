/**
 * The cross-section (ui/crossSection.ts): a line drawn across a flight on
 * the map, and the chart of the time spent along it with its summary.
 */
import { test, expect, type Page } from "./fixtures";
import {
  expectNoA11yViolations,
  findSegmentFarFromAirports,
  gotoApp,
} from "./helpers";
import { setView } from "./map";

/** A line across the flight at `coord`, in page pixels, A and B */
async function lineAcross(
  page: Page,
  coord: number[],
): Promise<[{ x: number; y: number }, { x: number; y: number }]> {
  return page.evaluate(([lat, lon]) => {
    const map = window.mapApp!.map!;
    const segments = window.mapApp!.currentData!.path_segments;
    const segment = segments.find(
      (one) => one.coords[1][0] === lat && one.coords[1][1] === lon,
    )!;
    const [[lat0, lon0], [lat1, lon1]] = segment.coords;
    const from = map.project([lon0, lat0]);
    const to = map.project([lon1, lat1]);
    const at = map.project([lon!, lat!]);
    // Across the segment, 100 px either side of it
    const length = Math.hypot(to.x - from.x, to.y - from.y) || 1;
    const nx = -(to.y - from.y) / length;
    const ny = (to.x - from.x) / length;
    const box = map.getContainer().getBoundingClientRect();
    return [
      { x: box.left + at.x - nx * 100, y: box.top + at.y - ny * 100 },
      { x: box.left + at.x + nx * 100, y: box.top + at.y + ny * 100 },
    ];
  }, coord);
}

test.describe("Cross-section", () => {
  test.beforeEach(async ({ page, isMobile }) => {
    test.skip(isMobile, "Drives the desktop column's control");
    await gotoApp(page);
  });

  test("a line drawn across a flight shows the chart with its summary", async ({
    page,
  }) => {
    const found = await findSegmentFarFromAirports(page);
    expect(found).not.toBeNull();
    const [a, b] = await lineAcross(page, found!.coord);

    const control = page.locator("#cross-section-btn");
    await control.click();
    const panel = page.locator("#cross-section");
    await expect(panel).toBeVisible();
    await expect(control).toHaveAttribute("aria-pressed", "true");
    await expect(panel.locator(".section-hint")).toContainText("two points");

    await page.mouse.click(a.x, a.y);
    await page.mouse.click(b.x, b.y);

    // The chart, its figures and the summary a screen reader gets
    const plot = panel.locator(".section-plot");
    await expect(plot).toBeVisible();
    await expect(plot).toHaveAttribute("role", "img");
    await expect(plot).toHaveAttribute(
      "aria-label",
      /^Cross-section: [\d,]+ (s|min|h)( \d+ min)? from \d+ flights? within [\d.]+ k?m of a [\d.,]+ km line/,
    );
    await expect(panel.locator(".profile-stats")).toContainText("Time");
    await expect(panel.locator(".profile-axis")).toContainText("B");
    // The corridor is on the map with its two ends
    await expect(page.locator(".section-handle")).toHaveCount(2);
    expect(
      await page.evaluate(
        () => !!window.mapApp!.map!.getLayer("cross-section-corridor"),
      ),
    ).toBe(true);
    await expectNoA11yViolations(page, "cross-section");

    // Pointing at the chart reads it out
    const box = (await plot.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await expect(panel.locator(".profile-readout")).toContainText(" km · ");

    // Escape closes it, and takes the corridor off the map
    await page.mouse.move(1, 1);
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(control).toHaveAttribute("aria-pressed", "false");
    expect(
      await page.evaluate(
        () => !!window.mapApp!.map!.getLayer("cross-section-corridor"),
      ),
    ).toBe(false);
  });

  test("the keyboard places the ends at the map centre", async ({ page }) => {
    const found = await findSegmentFarFromAirports(page);
    expect(found).not.toBeNull();
    const [lat, lon] = found!.coord as [number, number];

    const control = page.locator("#cross-section-btn");
    await control.focus();
    await page.keyboard.press("Enter");
    const place = page.locator("#cross-section .section-place-btn");
    await expect(place).toBeFocused();
    await expect(place).toHaveText("Set A at the map centre");

    await setView(page, [lat - 0.005, lon], 13);
    await page.keyboard.press("Enter");
    await expect(place).toHaveText("Set B at the map centre");
    await setView(page, [lat + 0.005, lon], 13);
    await page.keyboard.press("Enter");

    await expect(page.locator("#cross-section .section-plot")).toHaveAttribute(
      "aria-label",
      /^Cross-section: /,
    );
    await expect(page.locator(".section-handle")).toHaveCount(2);
    // The button that placed B is gone, and focus is on the one in its place
    await expect(
      page.locator("#cross-section .section-btn[aria-label='Draw a new line']"),
    ).toBeFocused();
  });

  test("the link carries the line, and opens the tool on it", async ({
    page,
  }) => {
    const found = await findSegmentFarFromAirports(page);
    expect(found).not.toBeNull();
    const [a, b] = await lineAcross(page, found!.coord);
    await page.locator("#cross-section-btn").click();
    // The tool is fetched on the first use: a click before it listens is
    // one on the map
    await expect(page.locator("#cross-section .section-hint")).toContainText(
      "two points",
    );
    await page.mouse.click(a.x, a.y);
    await page.mouse.click(b.x, b.y);
    const plot = page.locator("#cross-section .section-plot");
    await expect(plot).toHaveAttribute("aria-label", /^Cross-section: /);

    // lat,lng of A, then of B
    await expect
      .poll(() => new URL(page.url()).searchParams.get("x"))
      .toMatch(/^-?[\d.]+(,-?[\d.]+){3}$/);
    await gotoApp(page, new URL(page.url()).search);

    // Drawn, not waiting for its first point
    await expect(page.locator("#cross-section")).toBeVisible();
    await expect(plot).toHaveAttribute("aria-label", /^Cross-section: /);
    await expect(page.locator(".section-handle")).toHaveCount(2);

    // Closed, the link has no line
    await page
      .locator(
        "#cross-section .section-btn[aria-label='Close the cross-section']",
      )
      .click();
    await expect
      .poll(() => new URL(page.url()).searchParams.has("x"))
      .toBe(false);
  });
});
