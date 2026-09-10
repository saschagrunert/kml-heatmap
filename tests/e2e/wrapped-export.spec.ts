import { test, expect, type Locator } from "@playwright/test";
import {
  KNOWN_YEARS,
  gotoApp,
  usesMobileBar,
  waitForAircraftFilter,
  waitForYearFilter,
} from "./helpers";

/**
 * Wait until an element's entry animation has finished.
 *
 * The Wrapped surfaces fade and slide in, so anything that measures geometry
 * has to let that settle first: the map container travels 30px over 0.8s
 * after a 0.9s delay, and a box read part-way through moves on its own.
 */
async function settleAnimations(locator: Locator): Promise<void> {
  await locator.evaluate((el) =>
    Promise.all(el.getAnimations().map((animation) => animation.finished)),
  );
}

/** Fail loudly if the cards no longer overflow, rather than time out */
async function expectScrollable(column: Locator): Promise<void> {
  const overflow = await column.evaluate(
    (el) => el.scrollHeight - el.clientHeight,
  );
  expect(overflow, "the cards column has nothing to scroll").toBeGreaterThan(0);
}

test.describe("Wrapped and Export", () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
  });

  test("wrapped button opens wrapped modal", async ({ page }) => {
    const wrappedModal = page.locator("#wrapped-modal");
    await expect(wrappedModal).toBeHidden();

    await page.locator("#wrapped-btn").click();
    await expect(wrappedModal).toBeVisible({ timeout: 5000 });
    await expect(wrappedModal).toHaveAttribute("role", "dialog");
    await expect(wrappedModal).toHaveAttribute("aria-modal", "true");
    await expect(page.locator("#wrapped-content")).toBeVisible();
  });

  // Desktop only: below the breakpoint the cards stack under the map and the
  // dialog scrolls as one column, which is a different arrangement entirely
  test("the map stays put while the cards scroll", async ({ page }) => {
    test.skip(
      await usesMobileBar(page),
      "the stacked layout scrolls the dialog, not the column",
    );
    await page.locator("#wrapped-btn").click();
    await expect(page.locator("#wrapped-modal")).toBeVisible({ timeout: 5000 });
    const column = page.locator("#wrapped-cards-column");
    const map = page.locator("#wrapped-map-container");
    await expect(map).toBeVisible();

    await settleAnimations(map);
    await expectScrollable(column);

    const before = await map.boundingBox();
    await column.evaluate((el) => el.scrollTo(0, el.scrollHeight));
    await expect
      .poll(() => column.evaluate((el) => el.scrollTop))
      .toBeGreaterThan(0);
    const after = await map.boundingBox();

    // Scrolling the row itself used to take the map with it and leave most
    // of the dialog empty for every card after the first
    expect(after?.y).toBe(before?.y);
    await expect(map).toBeInViewport();
  });

  test("reopening starts at the top of the cards", async ({ page }) => {
    test.skip(
      await usesMobileBar(page),
      "the stacked layout scrolls the dialog, not the column",
    );
    const modal = page.locator("#wrapped-modal");
    const column = page.locator("#wrapped-cards-column");

    await page.locator("#wrapped-btn").click();
    await expect(modal).toBeVisible({ timeout: 5000 });
    await expectScrollable(column);
    await column.evaluate((el) => el.scrollTo(0, 900));
    await expect
      .poll(() => column.evaluate((el) => el.scrollTop))
      .toBeGreaterThan(0);

    await modal.locator(".close-btn").click();
    await expect(modal).toBeHidden();
    await page.locator("#wrapped-btn").click();
    await expect(modal).toBeVisible({ timeout: 5000 });

    // The column keeps its position between openings, so without a reset
    // Wrapped reopens halfway down a card instead of on the title
    await expect.poll(() => column.evaluate((el) => el.scrollTop)).toBe(0);
  });

  test("wrapped modal closes via close button", async ({ page }) => {
    const wrappedModal = page.locator("#wrapped-modal");

    await page.locator("#wrapped-btn").click();
    await expect(wrappedModal).toBeVisible({ timeout: 5000 });

    await wrappedModal.locator(".close-btn").click();
    await expect(wrappedModal).toBeHidden();
  });

  test("wrapped modal traps focus and returns it on close", async ({
    page,
  }) => {
    const wrappedBtn = page.locator("#wrapped-btn");
    await wrappedBtn.focus();
    await wrappedBtn.press("Enter");

    const wrappedModal = page.locator("#wrapped-modal");
    await expect(wrappedModal).toBeVisible({ timeout: 5000 });
    await expect(wrappedModal.locator(".close-btn")).toBeFocused();
    await expect(page.locator("#left-buttons")).toHaveAttribute("inert", "");
    await expect(page.locator("#right-buttons")).toHaveAttribute("inert", "");
    await expect(page.locator("#github-footer")).toHaveAttribute("inert", "");

    await page.keyboard.press("Escape");

    await expect(wrappedModal).toBeHidden();
    await expect(page.locator("#left-buttons")).not.toHaveAttribute(
      "inert",
      "",
    );
    await expect(wrappedBtn).toBeFocused();
  });

  test("wrapped modal shows content sections", async ({ page }) => {
    await page.locator("#wrapped-btn").click();

    const wrappedModal = page.locator("#wrapped-modal");
    await expect(wrappedModal).toBeVisible({ timeout: 5000 });

    await expect(page.locator("#wrapped-card-stats")).toBeVisible();
    await expect(page.locator("#wrapped-title")).toBeVisible();
    await expect(page.locator("#wrapped-year")).toBeVisible();
    await expect(page.locator("#wrapped-stats")).toBeAttached();
  });

  test("wrapped modal shows all content cards", async ({ page }) => {
    await page.locator("#wrapped-btn").click();
    await expect(page.locator("#wrapped-modal")).toBeVisible({ timeout: 5000 });

    await expect(page.locator("#wrapped-card-stats")).toBeVisible();
    await expect(page.locator("#wrapped-card-facts")).toBeVisible();
    await expect(page.locator("#wrapped-card-fleet")).toBeVisible();
    await expect(page.locator("#wrapped-card-airports")).toBeVisible();
  });

  test("wrapped destinations are grouped by country", async ({ page }) => {
    await page.locator("#wrapped-btn").click();
    await expect(page.locator("#wrapped-modal")).toBeVisible({ timeout: 5000 });

    const airportsCard = page.locator("#wrapped-card-airports");
    await expect(airportsCard).toBeVisible();

    const countryGroups = airportsCard.locator(".country-group");
    expect(await countryGroups.count()).toBeGreaterThanOrEqual(1);

    const firstTitle = airportsCard.locator(".country-group-title").first();
    await expect(firstTitle).toBeVisible();
    await expect(firstTitle).not.toHaveText(/^\s*$/);
  });

  test("wrapped stats card contains flight data", async ({ page }) => {
    await page.locator("#wrapped-btn").click();
    await expect(page.locator("#wrapped-modal")).toBeVisible({
      timeout: 5000,
    });

    const statsCard = page.locator("#wrapped-card-stats");
    await expect(statsCard).toContainText("Flights");
    await expect(statsCard).toContainText("Airports");
  });

  test("wrapped modal includes map container", async ({ page }) => {
    await page.locator("#wrapped-btn").click();
    await expect(page.locator("#wrapped-modal")).toBeVisible({
      timeout: 5000,
    });

    await expect(page.locator("#wrapped-map-container #map")).toBeAttached();
  });

  test("wrapped modal close button is accessible", async ({ page }) => {
    await page.locator("#wrapped-btn").click();
    const modal = page.locator("#wrapped-modal");
    await expect(modal).toBeVisible({ timeout: 5000 });

    const closeBtn = modal.locator(".close-btn");
    await expect(closeBtn).toBeVisible();
    await expect(closeBtn).toHaveAttribute(
      "aria-label",
      "Close year in review",
    );
    await closeBtn.click();
    await expect(modal).toBeHidden();

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
    await expect(page.locator("#wrapped-map-container #map")).toHaveCount(0);
  });

  test("wrapped panel updates when year filter changes", async ({ page }) => {
    const yearSelect = page.locator("#year-select");
    expect(await yearSelect.locator("option").count()).toBe(
      KNOWN_YEARS.length + 1,
    );

    const year = KNOWN_YEARS[0]!;
    await yearSelect.selectOption(year);
    await waitForYearFilter(page, year);

    await page.locator("#wrapped-btn").click();
    await expect(page.locator("#wrapped-modal")).toBeVisible({ timeout: 5000 });

    await expect(page.locator("#wrapped-year")).toHaveText(year);
    await expect(page.locator("#wrapped-title")).toHaveText(
      "✨ Your Year in Flight",
    );
  });

  test("wrapped panel updates when aircraft filter changes", async ({
    page,
  }) => {
    const aircraftSelect = page.locator("#aircraft-select");
    const options = aircraftSelect.locator("option");
    expect(await options.count()).toBeGreaterThanOrEqual(2);
    const aircraftOption = (await options.nth(1).getAttribute("value"))!;

    await page.locator("#wrapped-btn").click();
    await expect(page.locator("#wrapped-modal")).toBeVisible({ timeout: 5000 });

    const allStatsText = await page.locator("#wrapped-stats").textContent();
    await page.locator("#wrapped-modal .close-btn").click();
    await expect(page.locator("#wrapped-modal")).toBeHidden();

    await aircraftSelect.selectOption(aircraftOption);
    await waitForAircraftFilter(page, aircraftOption);

    await page.locator("#wrapped-btn").click();
    await expect(page.locator("#wrapped-modal")).toBeVisible({ timeout: 5000 });

    await expect(page.locator("#wrapped-stats")).not.toHaveText(allStatsText!);
    await expect(page.locator("#wrapped-aircraft-fleet")).toContainText(
      aircraftOption,
    );
  });

  test("wrapped panel shows all years when year filter set to all", async ({
    page,
  }) => {
    await page.locator("#year-select").selectOption("all");
    await waitForYearFilter(page, "all");

    await page.locator("#wrapped-btn").click();
    await expect(page.locator("#wrapped-modal")).toBeVisible({ timeout: 5000 });

    await expect(page.locator("#wrapped-year")).toHaveText("All Years");
    await expect(page.locator("#wrapped-title")).toHaveText(
      "✨ Your Flight History",
    );
  });

  test("export button triggers download", async ({ page }) => {
    // Mock dom-to-image for reliable headless testing
    await page.evaluate(() => {
      window.domtoimage = {
        toJpeg: () =>
          Promise.resolve(
            "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA",
          ),
      } as unknown as DomToImage;
    });

    const downloadPromise = page.waitForEvent("download", {
      timeout: 10000,
    });
    await page.locator("#export-btn").click();

    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^heatmap_.*\.jpg$/);

    await expect(page.locator(".toast-notification")).toHaveText(
      "Map exported",
    );
    await expect(page.locator("#export-btn")).toHaveText("Export image");
    await expect(page.locator("#export-btn")).toBeEnabled();
    await expect(page.locator("#replay-btn")).toBeVisible();
  });

  test("export loads dom-to-image on demand and reports when unavailable", async ({
    page,
  }) => {
    // The library is not part of the initial page load
    expect(
      await page.evaluate(
        () => document.querySelector('script[src*="dom-to-image"]') !== null,
      ),
    ).toBe(false);

    await page.route("**/dom-to-image*", (route) => route.abort());
    await page.locator("#export-btn").click();

    await expect(page.locator(".toast-notification")).toHaveText(
      "Export unavailable",
    );
    await expect(page.locator("#export-btn")).toHaveText("Export image");
    await expect(page.locator("#export-btn")).toBeEnabled();
  });

  test("share button copies the current link", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);

    await page.locator("#share-btn").click();

    await expect(page.locator(".toast-notification")).toHaveText("Link copied");
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toBe(page.url());
    expect(copied).toContain("?");
  });
});
