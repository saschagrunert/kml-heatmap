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
 * That project drives visual-site/, built from the fixture flights of
 * tests/fixtures/visual/ with a fixed build stamp, and not docs/: the rail
 * and Wrapped print figures computed from the flights, and every snapshot
 * here is compared without any tolerance. With 1% of the pixels allowed to
 * differ, which the flights of data/ needed, a missing control row passed
 * and so did three stale snapshots.
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
} from "./helpers";
import { hideMapData } from "./map";

/**
 * The year every snapshot is taken with. The fixture has a later year as
 * well, which the page would open on, so that the snapshots also cover a
 * year picked through the URL and a dropdown with more than one entry.
 */
const PINNED_YEAR = 2025;

/**
 * The pinned image renders the same page identically run after run, and the
 * fixture site never changes on its own, so any differing pixel is a change
 * to the look. Spelled out, although it is Playwright's default, so that the
 * next tolerance somebody needs is an exception made here, in plain sight.
 */
const EXACT = { animations: "disabled", maxDiffPixels: 0 } as const;

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

    await expect(page).toHaveScreenshot("chrome-at-rest.png", EXACT);
  });

  test("the statistics rail", async ({ page }) => {
    await toggleStatsPanel(page);
    const rail = page.locator("#stats-rail");
    await expect(rail).toBeVisible();
    await settleAnimations(page);

    await expect(rail).toHaveScreenshot("stats-rail.png", EXACT);
  });

  test("the Wrapped dialog", async ({ page }) => {
    const dialog = await openWrapped(page);
    // The map panel holds a placeholder until its tiles land, and that
    // placeholder shimmers forever, so `settleAnimations` does not wait for
    // it. Without this the snapshot races the reveal.
    await expect(
      page.locator("#wrapped-map-container:not(.is-awaiting-map)"),
    ).toBeAttached();
    await settleAnimations(dialog);

    await expect(dialog).toHaveScreenshot("wrapped-dialog.png", EXACT);
  });
});
