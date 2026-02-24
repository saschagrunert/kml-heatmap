import { test, expect } from "@playwright/test";
import { selectPathForReplay } from "./helpers";

test.describe("Filters and Statistics", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("#map.leaflet-container", { timeout: 15000 });
  });

  test("year filter dropdown exists and has options", async ({ page }) => {
    const yearFilter = page.locator("#year-filter");
    await expect(yearFilter).toBeVisible();

    const yearSelect = page.locator("#year-select");
    await expect(yearSelect).toBeVisible();

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
      const secondOption = await options.nth(1).getAttribute("value");
      if (secondOption) {
        await yearSelect.selectOption(secondOption);
        await page.waitForTimeout(1000);
        await expect(yearSelect).toHaveValue(secondOption);
      }
    }
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

  test("statistics panel opens and closes", async ({ page }) => {
    const statsBtn = page.locator("#stats-btn");
    const statsPanel = page.locator("#stats-panel");

    await expect(statsPanel).toBeHidden();

    await statsBtn.click();
    await expect(statsPanel).toBeVisible();
    await expect(statsPanel).toHaveClass(/visible/);

    await statsBtn.click();
    await expect(statsPanel).not.toHaveClass(/visible/);
  });

  test("statistics panel shows flight data", async ({ page }) => {
    const statsBtn = page.locator("#stats-btn");
    const statsPanel = page.locator("#stats-panel");

    await statsBtn.click();
    await expect(statsPanel).toBeVisible();

    const panelText = await statsPanel.textContent();
    expect(panelText).toBeTruthy();
    expect(panelText!.length).toBeGreaterThan(0);
  });

  test("stats panel shows flight statistics with expected fields", async ({
    page,
  }) => {
    await page.locator("#stats-btn").click();
    const panel = page.locator("#stats-panel");
    await expect(panel).toBeVisible();

    const text = await panel.textContent();
    expect(text).toContain("Flight Statistics");
    expect(text).toContain("Data Points:");
    expect(text).toContain("Flights:");
    expect(text).toContain("Distance:");
    expect(text).toContain("nm");
  });

  test("stats panel shows airports and aircraft", async ({ page }) => {
    await page.locator("#stats-btn").click();
    const panel = page.locator("#stats-panel");
    await expect(panel).toBeVisible();

    const text = await panel.textContent();
    expect(text).toContain("Airports");
    expect(text).toContain("Aircrafts");
    expect(text).toContain("flight(s)");
  });

  test("stats update for selected path", async ({ page }) => {
    await page.locator("#stats-btn").click();
    const panel = page.locator("#stats-panel");
    await expect(panel).toBeVisible();

    const globalText = await panel.textContent();

    await selectPathForReplay(page);

    const selectedText = await panel.textContent();
    expect(selectedText).toContain("Selected Paths Statistics");
    expect(selectedText).toContain("selected path(s)");
    expect(selectedText).not.toBe(globalText);
  });

  test("stats revert to global after deselecting all paths", async ({
    page,
  }) => {
    await page.locator("#stats-btn").click();
    const panel = page.locator("#stats-panel");
    await expect(panel).toBeVisible();

    const pathId = await selectPathForReplay(page);
    await page.evaluate(
      (id) => (window as any).togglePathSelection(String(id)),
      pathId
    );
    await page.waitForFunction(
      () => (window as any).mapApp.selectedPathIds.size === 0
    );

    const revertedText = await panel.textContent();
    expect(revertedText).toContain("Flight Statistics");
    expect(revertedText).not.toContain("Selected Paths");
  });

  test("year filter updates stats panel content", async ({ page }) => {
    await page.locator("#stats-btn").click();
    const panel = page.locator("#stats-panel");
    await expect(panel).toBeVisible();

    const allText = await panel.textContent();

    const yearSelect = page.locator("#year-select");
    const options = yearSelect.locator("option");
    const count = await options.count();
    if (count < 2) return;

    const yearOption = await options.nth(1).getAttribute("value");
    if (!yearOption) return;
    await yearSelect.selectOption(yearOption);

    await page.waitForTimeout(1000);
    const filteredText = await panel.textContent();
    expect(filteredText).not.toBe(allText);
  });

  test("aircraft filter updates stats and can be reset", async ({ page }) => {
    await page.locator("#stats-btn").click();
    const panel = page.locator("#stats-panel");
    await expect(panel).toBeVisible();

    const allText = await panel.textContent();

    const aircraftSelect = page.locator("#aircraft-select");
    const options = aircraftSelect.locator("option");
    const count = await options.count();
    if (count < 2) return;

    const aircraftOption = await options.nth(1).getAttribute("value");
    if (!aircraftOption) return;
    await aircraftSelect.selectOption(aircraftOption);
    await page.waitForTimeout(1000);

    const filteredText = await panel.textContent();
    expect(filteredText).not.toBe(allText);

    await aircraftSelect.selectOption("all");
    await page.waitForTimeout(1000);
    const resetText = await panel.textContent();
    expect(resetText).toContain("Flight Statistics");
  });

  test("year filter updates aircraft filter options", async ({ page }) => {
    const aircraftSelect = page.locator("#aircraft-select");

    const yearSelect = page.locator("#year-select");
    const yearOptions = yearSelect.locator("option");
    if ((await yearOptions.count()) < 3) return;

    const yearOption = await yearOptions.nth(1).getAttribute("value");
    if (!yearOption) return;
    await yearSelect.selectOption(yearOption);
    await page.waitForTimeout(1000);

    const filteredOptions = await aircraftSelect.locator("option").count();
    expect(filteredOptions).toBeGreaterThanOrEqual(1);
  });
});
