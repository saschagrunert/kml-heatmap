/**
 * Wrapped's intro (ui/wrappedIntro.ts): the flight over the heat cloud that
 * opens the dialog from its button, with every flight of the year playing
 * underneath, its Skip, and what it leaves behind:
 * nothing in the link or the saved state, and the user's view, globe and
 * 3D switches back once the dialog closes.
 *
 * The suite runs with reduced motion, under which the intro does not play,
 * so these ask for motion. The camera itself is left to the unit tests: a
 * flight in software WebGL takes as long as the machine makes it.
 */
import { test, expect, type Page } from "./fixtures";
import { gotoApp, readSavedState, waitForAppReady } from "./helpers";
import {
  getOrientation,
  getZoom,
  heatCloudOnMap,
  setOrientation,
  waitForMapReady,
} from "./map";

test.use({ reducedMotion: "no-preference" });

/** Open Wrapped from its button, as a user does, which plays the intro */
async function openWithIntro(page: Page) {
  await page.locator("#wrapped-btn").click();
  const modal = page.locator("#wrapped-modal");
  await expect(modal).toBeVisible({ timeout: 5000 });
  return modal;
}

test.describe("Wrapped's intro", () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await waitForAppReady(page);
    await waitForMapReady(page);
    await setOrientation(page, { bearing: 30, pitch: 20 });
  });

  test("is skipped, and the view comes back as the dialog closes", async ({
    page,
  }) => {
    const zoom = await getZoom(page);
    const modal = await openWithIntro(page);
    const skip = page.locator("#wrapped-skip-btn");
    // Offered from the moment the dialog opens until the camera settles
    await expect(modal).toHaveClass(/is-intro/);
    await expect(skip).toBeVisible();

    await skip.click();

    // Wrapped as it opens without the intro: the cards, the flat overview
    // north up, no globe and no cloud
    await expect(skip).toBeHidden();
    await expect(modal).not.toHaveClass(/is-intro/);
    await expect(page.locator("#wrapped-stats .stat-card").first()).toBeVisible(
      { timeout: 15000 },
    );
    await expect
      .poll(() => getOrientation(page))
      .toMatchObject({ bearing: 0, pitch: 0, projection: "mercator" });
    expect((await heatCloudOnMap(page)).onMap).toBe(false);
    // The flights that played underneath are gone, and were never a replay
    // of the map
    expect(
      await page.evaluate(() => ({
        onMap: !!window.mapApp!.map!.getLayer("replay-all"),
        replayActive: window.mapApp!.replayActive,
      })),
    ).toEqual({ onMap: false, replayActive: false });
    // Focus stays in the dialog
    await expect(modal.locator(".close-btn")).toBeFocused();

    await modal.locator(".close-btn").click();
    await expect(modal).toBeHidden();
    await expect
      .poll(() => getOrientation(page))
      .toMatchObject({ bearing: 30, pitch: 20, projection: "mercator" });
    await expect.poll(() => getZoom(page)).toBeCloseTo(zoom, 5);
  });

  test("keeps its globe and cloud out of the link and the saved state, and takes them away on close", async ({
    page,
  }) => {
    const modal = await openWithIntro(page);

    // The intro draws the cloud over the globe with the 3D view off, and
    // both stay while the dialog is open, whether it still flies or not
    await expect
      .poll(() => getOrientation(page).then((view) => view.projection), {
        timeout: 15000,
      })
      .toBe("globe");
    await expect
      .poll(() => heatCloudOnMap(page), { timeout: 15000 })
      .toMatchObject({ onMap: true, stepsIn: true });
    expect(await page.evaluate(() => window.mapApp!.threeDVisible)).toBe(false);

    // A save while it is open writes the user's switches and view: the one
    // the share action makes, rather than waiting for the debounce
    await page.evaluate(() => window.mapApp!.stateManager.flush());
    const saved = await readSavedState(page);
    expect(saved["wrappedVisible"]).toBe(true);
    expect(saved["globeVisible"]).toBe(false);
    expect(saved["threeDVisible"]).toBe(false);
    expect(saved).toMatchObject({ bearing: 30, pitch: 20 });
    const link = new URL(page.url()).searchParams;
    expect(link.has("g")).toBe(false);
    expect(link.has("d")).toBe(false);

    await modal.locator(".close-btn").click();
    await expect(modal).toBeHidden();
    await expect
      .poll(() => getOrientation(page))
      .toMatchObject({ bearing: 30, pitch: 20, projection: "mercator" });
    await expect
      .poll(() => heatCloudOnMap(page))
      .toMatchObject({ onMap: false, stepsIn: false });
    expect(new URL(page.url()).searchParams.has("g")).toBe(false);
  });
});
