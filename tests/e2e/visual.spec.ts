/**
 * Visual regression for the page's own chrome.
 *
 * styles.css is over three thousand lines and nothing checked what it
 * renders: a rule that moved a control off screen or collapsed a panel
 * passed every functional test. These snapshots cover the parts a
 * stylesheet change is most likely to break, and deliberately not the map
 * itself, which is a canvas of live data.
 *
 * They run in their own project so the rest of the suite keeps working
 * wherever it is run; the snapshots are generated in the Playwright
 * container, which is also where CI compares them (see CONTRIBUTING.md).
 */
import { test, expect } from "./fixtures";
import {
  gotoApp,
  openWrapped,
  settleAnimations,
  toggleStatsPanel,
  waitForAppReady,
} from "./helpers";
import type { Page } from "./fixtures";

/**
 * The map is a canvas of flight paths over tiles the fixture stubs out; it
 * is not what a stylesheet change breaks, and comparing it would make every
 * one of these flaky. Everything around it is the point.
 */
function mapPane(page: Page) {
  return [page.locator("#map")];
}

test.describe("visual", () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await waitForAppReady(page);
    await settleAnimations(page);
  });

  test("the control chrome at rest", async ({ page }) => {
    await expect(page).toHaveScreenshot("chrome-at-rest.png", {
      mask: mapPane(page),
      animations: "disabled",
    });
  });

  test("the statistics rail", async ({ page }) => {
    await toggleStatsPanel(page);
    const rail = page.locator("#stats-rail");
    await expect(rail).toBeVisible();
    await settleAnimations(page);

    await expect(rail).toHaveScreenshot("stats-rail.png", {
      animations: "disabled",
    });
  });

  test("the Wrapped dialog", async ({ page }) => {
    const dialog = await openWrapped(page);
    await settleAnimations(dialog);

    await expect(dialog).toHaveScreenshot("wrapped-dialog.png", {
      // The dialog takes the map into itself while it is open
      mask: mapPane(page),
      animations: "disabled",
    });
  });
});
