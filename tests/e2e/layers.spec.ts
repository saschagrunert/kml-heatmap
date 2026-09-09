import { test, expect, type Locator, type Page } from "@playwright/test";
import {
  findSegmentFarFromAirports,
  gotoApp,
  waitForPathData,
} from "./helpers";

/** Set the zoom level and refresh marker sizes, then wait for the class */
async function zoomAndWaitForMarkerSize(
  page: Page,
  zoom: number,
  expected: string,
): Promise<void> {
  await page.evaluate((z) => {
    const app = window.mapApp!;
    app.map!.setView(app.map!.getCenter(), z, { animate: false });
    app.airportManager.updateAirportMarkerSizes();
  }, zoom);

  await page.waitForFunction(
    (size) => document.getElementById("map")?.dataset["zoomSize"] === size,
    expected,
    { timeout: 5000 },
  );
}

test.describe("Layers", () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
  });

  test("heatmap button toggles heatmap layer", async ({ page }) => {
    const btn = page.locator("#heatmap-btn");

    await btn.click();
    await expect(btn).toHaveCSS("opacity", "0.5");
    await expect(btn).toHaveAttribute("aria-pressed", "false");

    await btn.click();
    await expect(btn).toHaveCSS("opacity", "1");
    await expect(btn).toHaveAttribute("aria-pressed", "true");
  });

  test("altitude toggle shows altitude layer and legend", async ({ page }) => {
    const altBtn = page.locator("#altitude-btn");
    const altLegend = page.locator("#altitude-legend");

    await expect(altBtn).toHaveCSS("opacity", "0.5");
    await expect(altLegend).toBeHidden();

    await altBtn.click();
    await expect(altBtn).toHaveCSS("opacity", "1");
    await expect(altLegend).toBeVisible();

    await expect(page.locator("#legend-min")).toBeVisible();
    await expect(page.locator("#legend-max")).toBeVisible();

    await altBtn.click();
    await expect(altBtn).toHaveCSS("opacity", "0.5");
    await expect(altLegend).toBeHidden();
  });

  test("airspeed toggle shows airspeed layer and legend", async ({ page }) => {
    const airspeedBtn = page.locator("#airspeed-btn");
    const airspeedLegend = page.locator("#airspeed-legend");

    await expect(airspeedBtn).toHaveCSS("opacity", "0.5");
    await expect(airspeedLegend).toBeHidden();

    await airspeedBtn.click();
    await expect(airspeedBtn).toHaveCSS("opacity", "1");
    await expect(airspeedLegend).toBeVisible();

    await expect(page.locator("#airspeed-legend-min")).toBeVisible();
    await expect(page.locator("#airspeed-legend-max")).toBeVisible();

    await airspeedBtn.click();
    await expect(airspeedBtn).toHaveCSS("opacity", "0.5");
    await expect(airspeedLegend).toBeHidden();
  });

  test("altitude and airspeed are mutually exclusive", async ({ page }) => {
    const altBtn = page.locator("#altitude-btn");
    const airspeedBtn = page.locator("#airspeed-btn");

    await altBtn.click();
    await expect(altBtn).toHaveCSS("opacity", "1");
    await expect(airspeedBtn).toHaveCSS("opacity", "0.5");

    await airspeedBtn.click();
    await expect(airspeedBtn).toHaveCSS("opacity", "1");
    await expect(altBtn).toHaveCSS("opacity", "0.5");
  });

  test("airports button toggles airport markers", async ({ page }) => {
    const btn = page.locator("#airports-btn");

    await expect(btn).toHaveCSS("opacity", "1");

    await btn.click();
    await expect(btn).toHaveCSS("opacity", "0.5");
    await expect(page.locator(".airport-marker").first()).toBeHidden();

    await btn.click();
    await expect(btn).toHaveCSS("opacity", "1");
    await expect(page.locator(".airport-marker").first()).toBeAttached();
  });

  test("hide buttons toggle collapses controls", async ({ page }) => {
    const hideBtn = page.locator("#hide-buttons-btn");
    const toggleableButtons = page.locator(".toggleable-btn");

    const firstBtn = toggleableButtons.first();
    await expect(firstBtn).toBeVisible();
    await expect(firstBtn).not.toHaveClass(/buttons-hidden/);
    await expect(hideBtn).toHaveAttribute("aria-pressed", "false");

    await hideBtn.click();

    const count = await toggleableButtons.count();
    for (let i = 0; i < count; i++) {
      await expect(toggleableButtons.nth(i)).toHaveClass(/buttons-hidden/);
    }
    await expect(hideBtn).toHaveText("🔽");
    await expect(hideBtn).toHaveAttribute("aria-pressed", "true");
    await expect(hideBtn).toHaveAttribute("aria-label", "Show control buttons");

    await hideBtn.click();
    for (let i = 0; i < count; i++) {
      await expect(toggleableButtons.nth(i)).not.toHaveClass(/buttons-hidden/);
    }
    await expect(hideBtn).toHaveText("🔼");
    await expect(hideBtn).toHaveAttribute("aria-pressed", "false");
    await expect(hideBtn).toHaveAttribute("aria-label", "Hide control buttons");
  });

  test("aviation button follows the API key configuration", async ({
    page,
  }) => {
    const hasApiKey = await page.evaluate(
      () => !!window.MAP_CONFIG?.openaipApiKey,
    );
    const btn = page.locator("#aviation-btn");

    if (!hasApiKey) {
      await expect(btn).toBeHidden();
      return;
    }

    await expect(btn).toBeVisible();
    await expect(btn).toHaveCSS("opacity", "0.5");

    await btn.click();
    await expect(btn).toHaveCSS("opacity", "1");
    expect(await page.evaluate(() => window.mapApp!.aviationVisible)).toBe(
      true,
    );

    await btn.click();
    await expect(btn).toHaveCSS("opacity", "0.5");
  });

  test("airport marker sizes change with zoom level", async ({ page }) => {
    await expect(
      page.locator(".airport-marker-container").first(),
    ).toBeAttached({ timeout: 15000 });

    await zoomAndWaitForMarkerSize(page, 12, "large");
    const largeSize = await page
      .locator(".airport-marker")
      .first()
      .evaluate((el) => el.getBoundingClientRect().width);

    await zoomAndWaitForMarkerSize(page, 6, "small");
    const smallSize = await page
      .locator(".airport-marker")
      .first()
      .evaluate((el) => el.getBoundingClientRect().width);

    expect(smallSize).toBeLessThan(largeSize);
  });

  async function expectSegmentDetails(details: Locator): Promise<void> {
    await expect(details).toBeVisible({ timeout: 5000 });
    await expect(details).toContainText(/Altitude/);
    await expect(details).toContainText(/ft/);
    await expect(details).toContainText(/Groundspeed/);
    await expect(details).toContainText(/kt/);
  }

  test("hovering over path segment shows tooltip with flight data", async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile, "Touch devices have no hover; see the tap test");
    await waitForPathData(page);

    const pos = await findSegmentFarFromAirports(page);
    expect(pos).not.toBeNull();

    await page.mouse.move(pos!.x, pos!.y);

    await expectSegmentDetails(page.locator(".segment-tooltip").first());
  });

  test("tapping a path segment shows a popup with flight data", async ({
    page,
    isMobile,
  }) => {
    test.skip(!isMobile, "Pointer devices show a hover tooltip instead");
    await waitForPathData(page);

    const pos = await findSegmentFarFromAirports(page);
    expect(pos).not.toBeNull();

    await page.locator("#map").click({ position: { x: pos!.x, y: pos!.y } });

    await expectSegmentDetails(page.locator(".leaflet-popup-content").first());
  });

  test("airport labels hidden at low zoom", async ({ page }) => {
    await expect(
      page.locator(".airport-marker-container").first(),
    ).toBeAttached({ timeout: 15000 });

    await page.evaluate(() => {
      const app = window.mapApp!;
      app.map!.setView(app.map!.getCenter(), 4, { animate: false });
      app.airportManager.updateAirportMarkerSizes();
    });
    await page.waitForFunction(
      () =>
        document.getElementById("map")?.classList.contains("zoom-hide-labels"),
      { timeout: 5000 },
    );
    await expect(page.locator(".airport-label").first()).toBeHidden();

    await page.evaluate(() => {
      const app = window.mapApp!;
      app.map!.setView(app.map!.getCenter(), 8, { animate: false });
      app.airportManager.updateAirportMarkerSizes();
    });
    await page.waitForFunction(
      () =>
        !document.getElementById("map")?.classList.contains("zoom-hide-labels"),
      { timeout: 5000 },
    );
  });
});
