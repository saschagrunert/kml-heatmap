import { test, expect } from "@playwright/test";

test.describe("Core", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("#map.leaflet-container", { timeout: 15000 });
  });

  test("page loads without console errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));

    await page.reload();
    await page.waitForSelector("#map.leaflet-container", { timeout: 15000 });

    expect(errors).toHaveLength(0);
  });

  test("map container renders with Leaflet", async ({ page }) => {
    const mapContainer = page.locator("#map");
    await expect(mapContainer).toBeVisible();
    await expect(mapContainer).toHaveClass(/leaflet-container/);
  });

  test("map has tile pane initialized", async ({ page }) => {
    const tilePane = page.locator(".leaflet-tile-pane");
    await expect(tilePane).toBeAttached();
  });

  test("control buttons are present", async ({ page }) => {
    const buttons = [
      "#heatmap-btn",
      "#altitude-btn",
      "#airspeed-btn",
      "#airports-btn",
      "#stats-btn",
      "#export-btn",
      "#wrapped-btn",
      "#replay-btn",
      "#hide-buttons-btn",
    ];

    for (const selector of buttons) {
      await expect(page.locator(selector)).toBeVisible();
    }
  });

  test("heatmap is active by default", async ({ page }) => {
    const btn = page.locator("#heatmap-btn");
    await expect(btn).toHaveAttribute("aria-pressed", "true");
    await expect(btn).toHaveCSS("opacity", "1");
  });

  test("replay button is present and initially disabled", async ({ page }) => {
    const replayBtn = page.locator("#replay-btn");
    await expect(replayBtn).toBeVisible();
    await expect(replayBtn).toHaveAttribute("aria-disabled", "true");
    await expect(replayBtn).toBeDisabled();
  });

  test("replay controls are hidden by default", async ({ page }) => {
    const replayControls = page.locator("#replay-controls");
    await expect(replayControls).toBeHidden();
  });

  test("loading indicator is hidden after initialization", async ({ page }) => {
    const loading = page.locator("#loading");
    await expect(loading).toBeHidden({ timeout: 15000 });
  });

  test("page title is set correctly", async ({ page }) => {
    await expect(page).toHaveTitle("KML Heatmap");
  });

  test("map config is loaded with correct structure", async ({ page }) => {
    const config = await page.evaluate(() => (window as any).MAP_CONFIG);
    expect(config).toBeTruthy();
    expect(config.center).toHaveLength(2);
    expect(config.bounds).toHaveLength(2);
    expect(config.dataDir).toBe("data");
  });

  test("metadata is loaded", async ({ page }) => {
    const metadata = await page.evaluate(() => (window as any).KML_METADATA);
    expect(metadata).toBeTruthy();
    expect(metadata.stats).toBeTruthy();
    expect(metadata.available_years).toBeTruthy();
    expect(Array.isArray(metadata.available_years)).toBe(true);
  });

  test("airports data is loaded", async ({ page }) => {
    const airports = await page.evaluate(() => (window as any).KML_AIRPORTS);
    expect(airports).toBeTruthy();
    expect(airports.airports).toBeTruthy();
    expect(Array.isArray(airports.airports)).toBe(true);
  });

  test("airport markers are rendered on the map", async ({ page }) => {
    const markers = page.locator(".leaflet-marker-icon");
    await expect(markers.first()).toBeAttached({ timeout: 15000 });
    expect(await markers.count()).toBeGreaterThan(0);
  });

  test("github footer is visible", async ({ page }) => {
    const footer = page.locator("#github-footer");
    await expect(footer).toBeVisible();

    const link = footer.locator("a");
    await expect(link).toHaveAttribute(
      "href",
      "https://github.com/saschagrunert/kml-heatmap"
    );
  });
});
