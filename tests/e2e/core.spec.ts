import { test, expect } from "@playwright/test";
import {
  KNOWN_YEARS,
  activateReplay,
  attachErrorCollectors,
  expectNoA11yViolations,
  gotoApp,
  relevantConsoleErrors,
} from "./helpers";

test.describe("Core", () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
  });

  test("page loads without errors or CSP violations", async ({ page }) => {
    const errors = await attachErrorCollectors(page);

    await gotoApp(page);

    expect(errors.pageErrors).toEqual([]);
    expect(errors.cspViolations).toEqual([]);
    expect(relevantConsoleErrors(errors)).toEqual([]);
  });

  test("content security policy is declared", async ({ page }) => {
    const csp = await page
      .locator('meta[http-equiv="Content-Security-Policy"]')
      .getAttribute("content");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self' file: https://unpkg.com");
    expect(csp).toContain("base-uri 'none'");
  });

  test("map container renders with Leaflet", async ({ page }) => {
    const mapContainer = page.locator("#map");
    await expect(mapContainer).toBeVisible();
    await expect(mapContainer).toHaveClass(/leaflet-container/);
  });

  test("map has tile pane initialized", async ({ page }) => {
    await expect(page.locator(".leaflet-tile-pane")).toBeAttached();
  });

  test("control buttons are present", async ({ page }) => {
    const buttons = [
      "#heatmap-btn",
      "#altitude-btn",
      "#airspeed-btn",
      "#airports-btn",
      "#stats-btn",
      "#export-btn",
      "#share-btn",
      "#wrapped-btn",
      "#replay-btn",
      "#hide-buttons-btn",
      "#isolate-btn",
    ];

    for (const selector of buttons) {
      await expect(page.locator(selector)).toBeVisible();
    }
  });

  test("icon-only buttons have matching title and aria-label", async ({
    page,
  }) => {
    for (const selector of [
      "#isolate-btn",
      "#hide-buttons-btn",
      "#replay-play-btn",
      "#replay-pause-btn",
      "#replay-stop-btn",
    ]) {
      const button = page.locator(selector);
      const title = await button.getAttribute("title");
      expect(title, selector).toBeTruthy();
      await expect(button).toHaveAttribute("aria-label", title!);
    }
  });

  test("heatmap is active by default", async ({ page }) => {
    const btn = page.locator("#heatmap-btn");
    await expect(btn).toHaveAttribute("aria-pressed", "true");
    await expect(btn).toHaveCSS("opacity", "1");
  });

  test("replay button is enabled but marked unavailable initially", async ({
    page,
  }) => {
    const replayBtn = page.locator("#replay-btn");
    await expect(replayBtn).toBeVisible();
    // The button stays actionable so clicking it can explain why
    expect(
      await replayBtn.evaluate((el) => (el as HTMLButtonElement).disabled),
    ).toBe(false);
    await expect(replayBtn).toHaveAttribute(
      "title",
      "Select exactly one flight with timing data to replay",
    );
    await expect(replayBtn).toHaveAttribute("aria-pressed", "false");
  });

  test("replay controls are hidden by default", async ({ page }) => {
    await expect(page.locator("#replay-controls")).toBeHidden();
  });

  test("loading indicator is a status region and hidden after initialization", async ({
    page,
  }) => {
    const loading = page.locator("#loading");
    await expect(loading).toBeHidden();
    await expect(loading).toHaveAttribute("role", "status");
    await expect(page.locator("#loading-text")).toBeAttached();
  });

  test("map zoom control and attribution are shown", async ({ page }) => {
    await expect(page.locator(".leaflet-control-zoom")).toBeVisible();
    const attribution = page.locator(".leaflet-control-attribution");
    await expect(attribution).toBeVisible();
    await expect(attribution).toContainText("OpenStreetMap");
  });

  test("page title is set correctly", async ({ page }) => {
    await expect(page).toHaveTitle("KML Heatmap");
  });

  test("map config is loaded with correct structure", async ({ page }) => {
    const config = await page.evaluate(() => window.MAP_CONFIG);
    expect(config).toBeTruthy();
    expect(config!.center).toHaveLength(2);
    expect(config!.bounds).toHaveLength(2);
    expect(config!.dataDir).toBe("data");
  });

  test("metadata is loaded", async ({ page }) => {
    const metadata = await page.evaluate(() => window.KML_METADATA);
    expect(metadata).toBeTruthy();
    expect(metadata!.stats).toBeTruthy();
    expect(metadata!.available_years.map(String)).toEqual(KNOWN_YEARS);
  });

  test("airports data is loaded", async ({ page }) => {
    const airports = await page.evaluate(() => window.KML_AIRPORTS);
    expect(airports).toBeTruthy();
    expect(Array.isArray(airports!.airports)).toBe(true);
    expect(airports!.airports.length).toBeGreaterThan(0);
  });

  test("airport markers are rendered on the map", async ({ page }) => {
    const markers = page.locator(".leaflet-marker-icon");
    await expect(markers.first()).toBeAttached({ timeout: 15000 });
    expect(await markers.count()).toBeGreaterThan(0);
  });

  test("github footer is visible and labelled", async ({ page }) => {
    const footer = page.locator("#github-footer");
    await expect(footer).toBeVisible();

    const link = footer.locator("a");
    await expect(link).toHaveAttribute(
      "href",
      "https://github.com/saschagrunert/kml-heatmap",
    );
    await expect(link).toHaveAttribute("aria-label", "View on GitHub");
  });

  test.describe("Accessibility", () => {
    test("initial page has no WCAG A/AA violations", async ({ page }) => {
      await expectNoA11yViolations(page, "initial page");
    });

    test("open stats panel has no WCAG A/AA violations", async ({ page }) => {
      await page.locator("#stats-btn").click();
      await expect(page.locator("#stats-panel")).toBeVisible();

      await expectNoA11yViolations(page, "stats panel");
    });

    test("replay controls have no WCAG A/AA violations", async ({ page }) => {
      await activateReplay(page);

      await expectNoA11yViolations(page, "replay controls");
    });

    test("wrapped dialog has no WCAG A/AA violations", async ({ page }) => {
      await page.locator("#wrapped-btn").click();
      await expect(page.locator("#wrapped-modal")).toBeVisible();
      await expect(page.locator("#wrapped-card-airports")).toBeVisible();

      await expectNoA11yViolations(page, "wrapped dialog");
    });
  });
});
