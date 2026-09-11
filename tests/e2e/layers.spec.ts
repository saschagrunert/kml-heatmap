import { test, expect, type Locator, type Page } from "./fixtures";
import {
  findSegmentFarFromAirports,
  gotoApp,
  toggleLayer,
  waitForPathData,
} from "./helpers";

/** The Layers group of the right column, addressed by its own heading */
const LAYERS_GROUP =
  '#right-buttons .control-group[aria-labelledby="layers-group-title"]';

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

  test("heatmap button toggles heatmap layer", async ({ page, isMobile }) => {
    test.skip(
      isMobile,
      "The Layers sheet drives this below the breakpoint; see mobile.spec.ts",
    );
    // Addressed through the named group rather than a position: the button
    // has to be the one under the Layers heading, carrying its own icon
    const btn = page.locator(`${LAYERS_GROUP} #heatmap-btn`);
    await expect(btn.locator("svg.icon")).toHaveCount(1);

    await btn.click();
    await expect(btn).toHaveCSS("opacity", "0.5");
    await expect(btn).toHaveAttribute("aria-pressed", "false");

    await btn.click();
    await expect(btn).toHaveCSS("opacity", "1");
    await expect(btn).toHaveAttribute("aria-pressed", "true");
  });

  test("altitude toggle shows altitude layer and legend", async ({
    page,
    isMobile,
  }) => {
    test.skip(
      isMobile,
      "The Layers sheet drives this below the breakpoint; see mobile.spec.ts",
    );
    const altBtn = page.locator(`${LAYERS_GROUP} #altitude-btn`);
    const altLegend = page.locator("#altitude-legend");

    // The row shows the ramp the layer colours by, next to its button
    await expect(altBtn.locator("svg.icon")).toHaveCount(1);
    await expect(
      page
        .locator(`${LAYERS_GROUP} .control-row:has(#altitude-btn)`)
        .locator(".ramp-chip-altitude"),
    ).toHaveCount(1);

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

  test("airspeed toggle shows airspeed layer and legend", async ({
    page,
    isMobile,
  }) => {
    test.skip(
      isMobile,
      "The Layers sheet drives this below the breakpoint; see mobile.spec.ts",
    );
    const airspeedBtn = page.locator(`${LAYERS_GROUP} #airspeed-btn`);
    const airspeedLegend = page.locator("#airspeed-legend");

    await expect(airspeedBtn.locator("svg.icon")).toHaveCount(1);
    await expect(
      page
        .locator(`${LAYERS_GROUP} .control-row:has(#airspeed-btn)`)
        .locator(".ramp-chip-speed"),
    ).toHaveCount(1);

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

  test("altitude and airspeed are mutually exclusive", async ({
    page,
    isMobile,
  }) => {
    test.skip(
      isMobile,
      "The Layers sheet drives this below the breakpoint; see mobile.spec.ts",
    );
    const altBtn = page.locator("#altitude-btn");
    const airspeedBtn = page.locator("#airspeed-btn");

    await altBtn.click();
    await expect(altBtn).toHaveCSS("opacity", "1");
    await expect(airspeedBtn).toHaveCSS("opacity", "0.5");

    await airspeedBtn.click();
    await expect(airspeedBtn).toHaveCSS("opacity", "1");
    await expect(altBtn).toHaveCSS("opacity", "0.5");
  });

  test("airports button toggles airport markers", async ({
    page,
    isMobile,
  }) => {
    test.skip(
      isMobile,
      "The Layers sheet drives this below the breakpoint; see mobile.spec.ts",
    );
    const btn = page.locator(`${LAYERS_GROUP} #airports-btn`);
    await expect(btn.locator("svg.icon")).toHaveCount(1);
    // The separator splits the on/off overlays from the colour layers
    await expect(page.locator(`${LAYERS_GROUP} .control-sep`)).toHaveCount(1);
    await expect(page.locator("#layers-group-title")).toHaveText("Layers");

    await expect(btn).toHaveCSS("opacity", "1");

    await btn.click();
    await expect(btn).toHaveCSS("opacity", "0.5");
    await expect(page.locator(".airport-marker").first()).toBeHidden();

    await btn.click();
    await expect(btn).toHaveCSS("opacity", "1");
    await expect(page.locator(".airport-marker").first()).toBeAttached();
  });

  test("aviation button follows the API key configuration", async ({
    page,
    isMobile,
  }) => {
    test.skip(
      isMobile,
      "The Layers sheet drives this below the breakpoint; see mobile.spec.ts",
    );
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

  test.describe("Heatmap emphasis", () => {
    /** The leaflet.heat canvas, which the emphasis class lands on */
    const HEAT_CANVAS = "canvas.leaflet-heatmap-layer";

    /** Opacity as the browser computes it, so the token stays the one source */
    function heatOpacity(page: Page): Promise<number> {
      return page
        .locator(HEAT_CANVAS)
        .evaluate((el) => Number(getComputedStyle(el).opacity));
    }

    test("the heatmap steps back while a colour layer is over it", async ({
      page,
    }) => {
      const canvas = page.locator(HEAT_CANVAS);
      await expect(canvas).toBeVisible();
      expect(await heatOpacity(page)).toBe(1);

      // waitForPathData switches the altitude layer on
      await waitForPathData(page);

      await expect(canvas).toHaveClass(/heatmap-dimmed/);
      // Its bloom under the gradient washed out the scale just switched on
      const dimmed = await heatOpacity(page);
      expect(dimmed).toBeLessThan(1);
      expect(dimmed).toBeGreaterThan(0);
    });

    test("it comes back to full strength when the layer goes", async ({
      page,
    }) => {
      const canvas = page.locator(HEAT_CANVAS);
      await waitForPathData(page);
      await expect(canvas).toHaveClass(/heatmap-dimmed/);

      await toggleLayer(page, "altitude");

      await expect(canvas).not.toHaveClass(/heatmap-dimmed/);
      expect(await heatOpacity(page)).toBe(1);
    });
  });
});
