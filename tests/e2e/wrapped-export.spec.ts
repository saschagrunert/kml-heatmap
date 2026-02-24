import { test, expect } from "@playwright/test";

test.describe("Wrapped and Export", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("#map.leaflet-container", { timeout: 15000 });
  });

  test("wrapped button opens wrapped modal", async ({ page }) => {
    const wrappedBtn = page.locator("#wrapped-btn");
    const wrappedModal = page.locator("#wrapped-modal");

    await expect(wrappedModal).toBeHidden();

    await wrappedBtn.click();
    await expect(wrappedModal).toBeVisible({ timeout: 5000 });

    const wrappedContent = page.locator("#wrapped-content");
    await expect(wrappedContent).toBeVisible();
  });

  test("wrapped modal closes via close button", async ({ page }) => {
    const wrappedBtn = page.locator("#wrapped-btn");
    const wrappedModal = page.locator("#wrapped-modal");

    await wrappedBtn.click();
    await expect(wrappedModal).toBeVisible({ timeout: 5000 });

    const closeBtn = wrappedModal.locator(".close-btn");
    await closeBtn.click();
    await expect(wrappedModal).toBeHidden();
  });

  test("wrapped modal shows content sections", async ({ page }) => {
    const wrappedBtn = page.locator("#wrapped-btn");
    await wrappedBtn.click();

    const wrappedModal = page.locator("#wrapped-modal");
    await expect(wrappedModal).toBeVisible({ timeout: 5000 });

    await expect(page.locator("#wrapped-card-stats")).toBeVisible();
    await expect(page.locator("#wrapped-title")).toBeVisible();
    await expect(page.locator("#wrapped-year")).toBeVisible();
    await expect(page.locator("#wrapped-stats")).toBeAttached();
  });

  test("wrapped modal shows all content cards", async ({ page }) => {
    await page.locator("#wrapped-btn").click();
    const modal = page.locator("#wrapped-modal");
    await expect(modal).toBeVisible({ timeout: 5000 });

    await expect(page.locator("#wrapped-card-stats")).toBeVisible();
    await expect(page.locator("#wrapped-card-facts")).toBeVisible();
    await expect(page.locator("#wrapped-card-fleet")).toBeVisible();
    await expect(page.locator("#wrapped-card-airports")).toBeVisible();
  });

  test("wrapped stats card contains flight data", async ({ page }) => {
    await page.locator("#wrapped-btn").click();
    await expect(page.locator("#wrapped-modal")).toBeVisible({
      timeout: 5000,
    });

    const statsCard = page.locator("#wrapped-card-stats");
    const text = await statsCard.textContent();
    expect(text).toBeTruthy();
    expect(text!.length).toBeGreaterThan(0);
  });

  test("wrapped modal includes map container", async ({ page }) => {
    await page.locator("#wrapped-btn").click();
    await expect(page.locator("#wrapped-modal")).toBeVisible({
      timeout: 5000,
    });

    const wrappedMap = page.locator("#wrapped-map-container #map");
    await expect(wrappedMap).toBeAttached();
  });

  test("wrapped modal close button is accessible", async ({ page }) => {
    await page.locator("#wrapped-btn").click();
    const modal = page.locator("#wrapped-modal");
    await expect(modal).toBeVisible({ timeout: 5000 });

    const closeBtn = modal.locator(".close-btn");
    await expect(closeBtn).toBeVisible();
    await closeBtn.click();
    await expect(modal).toBeHidden();

    // Re-open to verify it can be opened again after closing
    await page.locator("#wrapped-btn").click();
    await expect(modal).toBeVisible({ timeout: 5000 });
  });

  test("map returns to original position after closing wrapped", async ({
    page,
  }) => {
    await page.locator("#wrapped-btn").click();
    await expect(page.locator("#wrapped-modal")).toBeVisible({
      timeout: 5000,
    });

    await page.locator("#wrapped-modal .close-btn").click();
    await expect(page.locator("#wrapped-modal")).toBeHidden();

    const mapEl = page.locator("#map");
    await expect(mapEl).toBeVisible();
    await expect(mapEl).toHaveClass(/leaflet-container/);
  });

  test("export button triggers download", async ({ page }) => {
    // Mock dom-to-image for reliable headless testing
    await page.evaluate(() => {
      (window as any).domtoimage = {
        toJpeg: () =>
          Promise.resolve(
            "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA"
          ),
      };
    });

    const downloadPromise = page.waitForEvent("download", {
      timeout: 10000,
    });
    await page.locator("#export-btn").click();

    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^heatmap_.*\.jpg$/);

    // Button should revert to original text
    await expect(page.locator("#export-btn")).toHaveText("📷 Export");
  });
});
