/**
 * Replay and Wrapped are fetched only when they are used.
 *
 * They are a quarter of the frontend and most visits open neither, so they
 * are built into a second bundle the page loads on demand. The saving is
 * only real if a first visit does not fetch it, and the features only work
 * if it arrives when one of them is opened, so both halves are checked here.
 */
import { test, expect } from "./fixtures";
import { gotoApp, openWrapped, waitForAppReady } from "./helpers";
import type { Page } from "./fixtures";

const FEATURES = "features.bundle.js";

/** The feature bundle requests the page made so far */
function trackFeatureRequests(page: Page): string[] {
  const requested: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes(FEATURES)) requested.push(request.url());
  });
  return requested;
}

test.describe("the feature bundle", () => {
  test("is not fetched by a visit that opens neither feature", async ({
    page,
  }) => {
    const requested = trackFeatureRequests(page);

    await gotoApp(page);
    await waitForAppReady(page);
    // Exercise the parts of the map that stay in the main bundle
    await page.locator("#heatmap-btn").click();
    await page.locator("#airports-btn").click();

    expect(requested).toEqual([]);
    // ... and the replay control still says whether replay is possible,
    // which is what the main bundle has to answer on its own
    await expect(page.locator("#replay-btn")).toHaveAttribute(
      "title",
      "Select exactly one flight with timing data to replay",
    );
  });

  test("arrives when Wrapped is opened, and only once", async ({ page }) => {
    const requested = trackFeatureRequests(page);
    await gotoApp(page);
    await waitForAppReady(page);

    const dialog = await openWrapped(page);
    await expect(dialog).toBeVisible();

    expect(requested).toHaveLength(1);

    // Closing and reopening must not fetch it again
    await dialog.locator(".close-btn").click();
    await expect(dialog).toBeHidden();
    await expect(await openWrapped(page)).toBeVisible();

    expect(requested).toHaveLength(1);
  });

  test("shares one copy of the modules with the main bundle", async ({
    page,
  }) => {
    await gotoApp(page);
    await waitForAppReady(page);
    await openWrapped(page);

    // The DOM cache is a singleton the app invalidates; a second copy inside
    // the feature bundle would quietly hold stale elements
    const shared = await page.evaluate(() => {
      const registry = window.__kmlShared;
      return {
        published: registry ? Object.keys(registry).length : 0,
        hasDomCache: Boolean(registry?.["utils/domCache"]),
      };
    });

    expect(shared.published).toBeGreaterThan(10);
    expect(shared.hasDomCache).toBe(true);
  });
});
