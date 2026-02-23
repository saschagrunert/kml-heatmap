import { test, expect } from "@playwright/test";

test.describe("KML Heatmap", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    // Leaflet adds the leaflet-container class directly to #map
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
    // Leaflet tile pane should exist in the DOM
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

  test("heatmap button toggles heatmap layer", async ({ page }) => {
    const btn = page.locator("#heatmap-btn");

    // Click to hide heatmap
    await btn.click();
    await expect(btn).toHaveCSS("opacity", "0.5");

    // Click to show heatmap
    await btn.click();
    await expect(btn).toHaveCSS("opacity", "1");
  });

  test("statistics panel opens and closes", async ({ page }) => {
    const statsBtn = page.locator("#stats-btn");
    const statsPanel = page.locator("#stats-panel");

    // Panel should be hidden initially
    await expect(statsPanel).toBeHidden();

    // Click to open
    await statsBtn.click();
    await expect(statsPanel).toBeVisible();
    await expect(statsPanel).toHaveClass(/visible/);

    // Click to close
    await statsBtn.click();
    await expect(statsPanel).not.toHaveClass(/visible/);
  });

  test("statistics panel shows flight data", async ({ page }) => {
    const statsBtn = page.locator("#stats-btn");
    const statsPanel = page.locator("#stats-panel");

    await statsBtn.click();
    await expect(statsPanel).toBeVisible();

    // Panel should contain statistics content
    const panelText = await statsPanel.textContent();
    expect(panelText).toBeTruthy();
    expect(panelText!.length).toBeGreaterThan(0);
  });

  test("year filter dropdown exists and has options", async ({ page }) => {
    const yearFilter = page.locator("#year-filter");
    await expect(yearFilter).toBeVisible();

    const yearSelect = page.locator("#year-select");
    await expect(yearSelect).toBeVisible();

    // Should have at least "All Years" plus data years
    const options = yearSelect.locator("option");
    expect(await options.count()).toBeGreaterThanOrEqual(1);
  });

  test("aircraft filter dropdown exists", async ({ page }) => {
    const aircraftFilter = page.locator("#aircraft-filter");
    await expect(aircraftFilter).toBeVisible();

    const aircraftSelect = page.locator("#aircraft-select");
    await expect(aircraftSelect).toBeVisible();
  });

  test("year filter changes data", async ({ page }) => {
    const yearSelect = page.locator("#year-select");
    const options = yearSelect.locator("option");
    const count = await options.count();

    if (count >= 2) {
      // Select a specific year (not "All Years")
      const secondOption = await options.nth(1).getAttribute("value");
      if (secondOption) {
        await yearSelect.selectOption(secondOption);
        // Wait for data to load
        await page.waitForTimeout(1000);
        // Verify the selection stuck
        await expect(yearSelect).toHaveValue(secondOption);
      }
    }
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

    // Buttons should be visible initially (no buttons-hidden class)
    const firstBtn = toggleableButtons.first();
    await expect(firstBtn).toBeVisible();
    await expect(firstBtn).not.toHaveClass(/buttons-hidden/);

    // Click to hide buttons
    await hideBtn.click();

    // All toggleable buttons should have buttons-hidden class
    const count = await toggleableButtons.count();
    for (let i = 0; i < count; i++) {
      await expect(toggleableButtons.nth(i)).toHaveClass(/buttons-hidden/);
    }

    // Hide button text should change to down arrow
    await expect(hideBtn).toHaveText("🔽");

    // Click to show buttons again
    await hideBtn.click();
    for (let i = 0; i < count; i++) {
      await expect(toggleableButtons.nth(i)).not.toHaveClass(/buttons-hidden/);
    }
    await expect(hideBtn).toHaveText("🔼");
  });

  test("replay button is present and initially disabled", async ({ page }) => {
    const replayBtn = page.locator("#replay-btn");
    await expect(replayBtn).toBeVisible();
    await expect(replayBtn).toHaveAttribute("aria-disabled", "true");
    await expect(replayBtn).toBeDisabled();
  });

  test("loading indicator is hidden after initialization", async ({ page }) => {
    const loading = page.locator("#loading");
    // CSS default is display:none, and hideLoading sets display:none
    await expect(loading).toBeHidden({ timeout: 15000 });
  });

  test("wrapped button opens wrapped modal", async ({ page }) => {
    const wrappedBtn = page.locator("#wrapped-btn");
    const wrappedModal = page.locator("#wrapped-modal");

    // Modal should be hidden initially
    await expect(wrappedModal).toBeHidden();

    // Click to open
    await wrappedBtn.click();
    await expect(wrappedModal).toBeVisible({ timeout: 5000 });

    // Modal should contain wrapped content
    const wrappedContent = page.locator("#wrapped-content");
    await expect(wrappedContent).toBeVisible();
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

  test("wrapped modal closes via close button", async ({ page }) => {
    const wrappedBtn = page.locator("#wrapped-btn");
    const wrappedModal = page.locator("#wrapped-modal");

    // Open the modal
    await wrappedBtn.click();
    await expect(wrappedModal).toBeVisible({ timeout: 5000 });

    // Close via close button
    const closeBtn = wrappedModal.locator(".close-btn");
    await closeBtn.click();
    await expect(wrappedModal).toBeHidden();
  });

  test("wrapped modal shows content sections", async ({ page }) => {
    const wrappedBtn = page.locator("#wrapped-btn");
    await wrappedBtn.click();

    const wrappedModal = page.locator("#wrapped-modal");
    await expect(wrappedModal).toBeVisible({ timeout: 5000 });

    // Verify content sections exist
    await expect(page.locator("#wrapped-card-stats")).toBeVisible();
    await expect(page.locator("#wrapped-title")).toBeVisible();
    await expect(page.locator("#wrapped-year")).toBeVisible();
    await expect(page.locator("#wrapped-stats")).toBeAttached();
  });

  test("aircraft filter has options and can be changed", async ({ page }) => {
    const aircraftSelect = page.locator("#aircraft-select");
    const options = aircraftSelect.locator("option");
    const count = await options.count();

    if (count >= 2) {
      const secondOption = await options.nth(1).getAttribute("value");
      if (secondOption) {
        await aircraftSelect.selectOption(secondOption);
        await page.waitForTimeout(1000);
        await expect(aircraftSelect).toHaveValue(secondOption);
      }
    }
  });

  test("replay controls are hidden by default", async ({ page }) => {
    const replayControls = page.locator("#replay-controls");
    await expect(replayControls).toBeHidden();
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

  test("airport markers are rendered on the map", async ({ page }) => {
    // Leaflet renders airport markers as divIcon elements
    const markers = page.locator(".leaflet-marker-icon");
    // Wait for markers to appear after data loads
    await expect(markers.first()).toBeAttached({ timeout: 15000 });
    expect(await markers.count()).toBeGreaterThan(0);
  });
});
