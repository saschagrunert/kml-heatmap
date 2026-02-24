import { test, expect } from "@playwright/test";

test.describe("Layers", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("#map.leaflet-container", { timeout: 15000 });
  });

  test("heatmap button toggles heatmap layer", async ({ page }) => {
    const btn = page.locator("#heatmap-btn");

    // Click to hide heatmap
    await btn.click();
    await expect(btn).toHaveCSS("opacity", "0.5");

    // Click to show heatmap
    await btn.click();
    await expect(btn).toHaveCSS("opacity", "1");
  });

  test("altitude toggle shows altitude layer and legend", async ({ page }) => {
    const altBtn = page.locator("#altitude-btn");
    const altLegend = page.locator("#altitude-legend");

    // Initially off
    await expect(altBtn).toHaveCSS("opacity", "0.5");
    await expect(altLegend).toBeHidden();

    // Click to show altitude
    await altBtn.click();
    await expect(altBtn).toHaveCSS("opacity", "1");
    await expect(altLegend).toBeVisible();

    // Legend should show min/max altitude values
    const legendMin = page.locator("#legend-min");
    const legendMax = page.locator("#legend-max");
    await expect(legendMin).toBeVisible();
    await expect(legendMax).toBeVisible();

    // Click to hide altitude
    await altBtn.click();
    await expect(altBtn).toHaveCSS("opacity", "0.5");
    await expect(altLegend).toBeHidden();
  });

  test("airspeed toggle shows airspeed layer and legend", async ({ page }) => {
    const airspeedBtn = page.locator("#airspeed-btn");
    const airspeedLegend = page.locator("#airspeed-legend");

    // Initially off
    await expect(airspeedBtn).toHaveCSS("opacity", "0.5");
    await expect(airspeedLegend).toBeHidden();

    // Click to show airspeed
    await airspeedBtn.click();
    await expect(airspeedBtn).toHaveCSS("opacity", "1");
    await expect(airspeedLegend).toBeVisible();

    // Legend should show min/max speed values
    const legendMin = page.locator("#airspeed-legend-min");
    const legendMax = page.locator("#airspeed-legend-max");
    await expect(legendMin).toBeVisible();
    await expect(legendMax).toBeVisible();

    // Click to hide airspeed
    await airspeedBtn.click();
    await expect(airspeedBtn).toHaveCSS("opacity", "0.5");
    await expect(airspeedLegend).toBeHidden();
  });

  test("altitude and airspeed are mutually exclusive", async ({ page }) => {
    const altBtn = page.locator("#altitude-btn");
    const airspeedBtn = page.locator("#airspeed-btn");

    // Enable altitude
    await altBtn.click();
    await expect(altBtn).toHaveCSS("opacity", "1");
    await expect(airspeedBtn).toHaveCSS("opacity", "0.5");

    // Enable airspeed should disable altitude
    await airspeedBtn.click();
    await expect(airspeedBtn).toHaveCSS("opacity", "1");
    await expect(altBtn).toHaveCSS("opacity", "0.5");
  });

  test("airports button toggles airport markers", async ({ page }) => {
    const btn = page.locator("#airports-btn");

    // Initially visible (opacity 1)
    await expect(btn).toHaveCSS("opacity", "1");

    // Click to hide
    await btn.click();
    await expect(btn).toHaveCSS("opacity", "0.5");

    // Click to show
    await btn.click();
    await expect(btn).toHaveCSS("opacity", "1");
  });

  test("hide buttons toggle collapses controls", async ({ page }) => {
    const hideBtn = page.locator("#hide-buttons-btn");
    const toggleableButtons = page.locator(".toggleable-btn");

    // Buttons should be visible initially
    const firstBtn = toggleableButtons.first();
    await expect(firstBtn).toBeVisible();
    await expect(firstBtn).not.toHaveClass(/buttons-hidden/);

    // Click to hide buttons
    await hideBtn.click();

    const count = await toggleableButtons.count();
    for (let i = 0; i < count; i++) {
      await expect(toggleableButtons.nth(i)).toHaveClass(/buttons-hidden/);
    }

    await expect(hideBtn).toHaveText("🔽");

    // Click to show buttons again
    await hideBtn.click();
    for (let i = 0; i < count; i++) {
      await expect(toggleableButtons.nth(i)).not.toHaveClass(/buttons-hidden/);
    }
    await expect(hideBtn).toHaveText("🔼");
  });

  test("aviation button is visible when API key is configured", async ({
    page,
  }) => {
    const hasApiKey = await page.evaluate(
      () => !!(window as any).MAP_CONFIG?.openaipApiKey
    );

    if (hasApiKey) {
      await expect(page.locator("#aviation-btn")).toBeVisible();
    }
  });

  test("aviation button toggles aviation layer", async ({ page }) => {
    const hasApiKey = await page.evaluate(
      () => !!(window as any).MAP_CONFIG?.openaipApiKey
    );
    if (!hasApiKey) return;

    const btn = page.locator("#aviation-btn");

    // Default: off
    await expect(btn).toHaveCSS("opacity", "0.5");

    // Toggle on
    await btn.click();
    await expect(btn).toHaveCSS("opacity", "1");
    const isVisible = await page.evaluate(
      () => (window as any).mapApp.aviationVisible
    );
    expect(isVisible).toBe(true);

    // Toggle off
    await btn.click();
    await expect(btn).toHaveCSS("opacity", "0.5");
  });

  test("airport marker sizes change with zoom level", async ({ page }) => {
    // Wait for markers and initial map load to settle
    await expect(
      page.locator(".airport-marker-container").first()
    ).toBeAttached({ timeout: 15000 });
    await page.waitForTimeout(500);

    // Zoom to level 12 (large) using setView to override any initialization
    await page.evaluate(() => {
      const app = (window as any).mapApp;
      const center = app.map.getCenter();
      app.map.setView(center, 12, { animate: false });
      app.airportManager.updateAirportMarkerSizes();
    });

    await page.waitForFunction(
      () =>
        document
          .querySelector(".airport-marker-container")
          ?.classList.contains("airport-marker-container-large") ?? false,
      { timeout: 5000 }
    );

    // Zoom to level 6 (small)
    await page.evaluate(() => {
      const app = (window as any).mapApp;
      const center = app.map.getCenter();
      app.map.setView(center, 6, { animate: false });
      app.airportManager.updateAirportMarkerSizes();
    });

    await page.waitForFunction(
      () =>
        document
          .querySelector(".airport-marker-container")
          ?.classList.contains("airport-marker-container-small") ?? false,
      { timeout: 5000 }
    );
  });

  test("airport labels hidden at low zoom", async ({ page }) => {
    // Wait for markers and initial map load to settle
    await expect(
      page.locator(".airport-marker-container").first()
    ).toBeAttached({ timeout: 15000 });
    await page.waitForTimeout(500);

    // Zoom out below level 5
    await page.evaluate(() => {
      const app = (window as any).mapApp;
      const center = app.map.getCenter();
      app.map.setView(center, 4, { animate: false });
      app.airportManager.updateAirportMarkerSizes();
    });

    await page.waitForFunction(
      () => {
        const labels = document.querySelectorAll(".airport-label");
        if (labels.length === 0) return true;
        return Array.from(labels).every(
          (l) => (l as HTMLElement).style.display === "none"
        );
      },
      { timeout: 5000 }
    );

    // Zoom in above level 5
    await page.evaluate(() => {
      const app = (window as any).mapApp;
      const center = app.map.getCenter();
      app.map.setView(center, 8, { animate: false });
      app.airportManager.updateAirportMarkerSizes();
    });

    await page.waitForFunction(
      () => {
        const labels = document.querySelectorAll(".airport-label");
        if (labels.length === 0) return false;
        return Array.from(labels).some(
          (l) => (l as HTMLElement).style.display !== "none"
        );
      },
      { timeout: 5000 }
    );
  });
});
