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
 *
 * The map itself is hidden rather than masked: it is live data over stubbed
 * tiles, so comparing it would make every one of these flaky, and a mask
 * over a full-viewport element covers the chrome along with it.
 */
import { test, expect } from "./fixtures";
import {
  gotoApp,
  openWrapped,
  settleAnimations,
  toggleStatsPanel,
  waitForWrappedMap,
} from "./helpers";
import { hideMapData } from "./map";

/**
 * The year every snapshot is taken with. Left alone, the page opens on the
 * latest year of data/, so the first flight of a new year would change the
 * year dropdown in the chrome, and every flight of the running year moves
 * the figures of the rail and of Wrapped. A year that is over only changes
 * when an old flight is added late.
 */
const PINNED_YEAR = 2025;

test.describe("visual", () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page, `/?y=${PINNED_YEAR}`);
    // A site without that year would fall back to another one and fail on
    // the pixels, which says nothing about why
    await expect(page.locator("#year-select")).toHaveValue(String(PINNED_YEAR));
    await hideMapData(page);
    await settleAnimations(page);
  });

  test("the control chrome at rest", async ({ page }) => {
    // Every control has to be in the frame. An earlier version masked
    // `#map`, which is `inset: 0` behind the whole page, so Playwright
    // painted its mask over the entire viewport and the snapshot was 1280
    // by 720 pixels of solid magenta: it passed for any stylesheet at all.
    await expect(page.locator("#left-buttons")).toBeVisible();
    await expect(page.locator("#right-buttons")).toBeVisible();

    // With the year pinned, the only thing in this frame that comes from
    // the flights is the label of the year dropdown, and the pinned image
    // renders it identically run after run, so any difference is a change
    // to the chrome. The project-wide ratio would let a whole control row
    // disappear; the smaller of the two limits applies.
    await expect(page).toHaveScreenshot("chrome-at-rest.png", {
      animations: "disabled",
      maxDiffPixels: 0,
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
    // Without this the snapshot races the reveal
    await waitForWrappedMap(page);
    await settleAnimations(dialog);

    await expect(dialog).toHaveScreenshot("wrapped-dialog.png", {
      animations: "disabled",
    });
  });
});
