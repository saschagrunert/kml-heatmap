/**
 * Replay and Wrapped are fetched only when they are used.
 *
 * They are a quarter of the frontend and most visits open neither, so they
 * are built into a second bundle, and their styles into a second stylesheet,
 * that the page imports on demand. The saving is only real if a first visit
 * fetches neither, and the features only work if both arrive when one of them
 * is opened, so both halves are checked here.
 */
import { test, expect } from "./fixtures";
import {
  attachErrorCollectors,
  gotoApp,
  openWrapped,
  usesMobileBar,
  waitForAppReady,
} from "./helpers";
import type { Page } from "./fixtures";

const FEATURES = "features.bundle.js";
const FEATURES_CSS = "features.css";

/** The feature bundle requests the page made so far */
function trackFeatureRequests(page: Page): string[] {
  const requested: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes(FEATURES)) requested.push(request.url());
  });
  return requested;
}

/** The feature stylesheet requests the page made so far */
function trackFeatureCssRequests(page: Page): string[] {
  const requested: string[] = [];
  page.on("request", (request) => {
    // features.bundle.js contains the other name, so match the end
    if (request.url().endsWith(FEATURES_CSS)) requested.push(request.url());
  });
  return requested;
}

test.describe("the feature bundle", () => {
  test("is not fetched by a visit that opens neither feature", async ({
    page,
  }) => {
    const requested = trackFeatureRequests(page);
    const css = trackFeatureCssRequests(page);

    await gotoApp(page);
    await waitForAppReady(page);
    // Exercise the parts of the map that stay in the main bundle
    await page.locator("#heatmap-btn").click();
    await page.locator("#airports-btn").click();

    expect(requested).toEqual([]);
    expect(css).toEqual([]);
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
    const shared: string[] = [];
    page.on("request", (request) => {
      if (request.url().endsWith("/shared.bundle.js")) {
        shared.push(request.url());
      }
    });
    await gotoApp(page);
    await waitForAppReady(page);
    await openWrapped(page);

    // The DOM cache is a singleton the app invalidates; a second copy inside
    // the feature bundle would quietly hold stale elements. A module is
    // instantiated once per URL, so the feature bundle importing the chunk
    // the app already loaded is what gives both the same instance.
    const features = await page.request.get(new URL(FEATURES, page.url()).href);
    expect(await features.text()).toContain('"./shared.bundle.js"');
    expect(shared).toHaveLength(1);
  });

  test("loads on the next try after a failed one", async ({ page }) => {
    const errors = await attachErrorCollectors(page);
    const requested = trackFeatureRequests(page);
    await gotoApp(page);
    await waitForAppReady(page);
    // A network blip, or a deploy replacing the file, on the first request
    let failed = false;
    await page.route(`**/${FEATURES}*`, (route) => {
      if (failed) return route.continue();
      failed = true;
      return route.abort();
    });

    const mobile = await usesMobileBar(page);
    await page.locator(mobile ? "#mobile-tab-wrapped" : "#wrapped-btn").click();
    await expect(
      page.getByText("their code could not be loaded"),
    ).toBeVisible();

    // A browser may keep the failure of that URL for the life of the page;
    // the retry must reach the server anyway
    await expect(await openWrapped(page)).toBeVisible();
    expect(requested).toHaveLength(2);
    expect(requested[1]).not.toBe(requested[0]);

    expect(errors.pageErrors).toEqual([]);
  });

  test("brings its stylesheet with it, and neither panel shows before", async ({
    page,
  }) => {
    const css = trackFeatureCssRequests(page);
    await gotoApp(page);
    await waitForAppReady(page);

    // Both panels are in the markup from the first paint. Their layout is in
    // features.css, so styles.css has to hide them on its own until it lands
    await expect(page.locator("#replay-controls")).toBeHidden();
    await expect(page.locator("#wrapped-modal")).toBeHidden();
    expect(css).toEqual([]);

    const dialog = await openWrapped(page);
    await expect(dialog).toBeVisible();

    expect(css).toHaveLength(1);
    // Applied, not merely fetched: this display only exists in features.css
    const styled = await page
      .locator("#wrapped-container")
      .evaluate((el) => getComputedStyle(el).display);
    expect(styled).toBe("flex");
  });
});
