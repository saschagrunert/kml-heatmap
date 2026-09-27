/**
 * Replay of all flights: every flight of the filter starts at once and plays
 * at a hundred times its speed and more, drawn by a WebGL layer of its own,
 * with a clock that reads the time into every flight. The filters are held
 * while it plays, and closing it gives the page back as it was.
 */
import { test, expect } from "./fixtures";
import type { Page } from "./fixtures";
import { gotoApp, openMobileSheet, toastMessage } from "./helpers";

const CLOCK = /^\d+:\d{2} into every flight$/;

/** What the layer of the replay has drawn: frames and the time of the last */
function drawn(page: Page): Promise<{ frames: number; time: number } | null> {
  return page.evaluate(() => {
    const layer = window.mapApp!.map!.getLayer("replay-all") as
      { implementation?: { frames: number; time: number } } | undefined;
    const drawing = layer?.implementation;
    return drawing ? { frames: drawing.frames, time: drawing.time } : null;
  });
}

test.describe("Replay all flights", () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
  });

  test("plays every flight at once with a running clock, and gives the page back", async ({
    page,
  }) => {
    const button = page.locator("#replay-all-btn");
    await button.click();

    const panel = page.locator("#replay-all-controls");
    await expect(panel).toBeVisible({ timeout: 10000 });
    await expect(button).toHaveAttribute("aria-pressed", "true");
    // Held while it plays, as for the replay of one flight
    await expect(page.locator("#year-select")).toBeDisabled();
    await expect(page.locator("#aircraft-select")).toBeDisabled();
    await expect(page.locator("#replay-btn")).toBeDisabled();

    // A minute of flight passes in a third of a second at 200 times
    const clock = page.locator("#replay-all-clock");
    await expect(clock).toHaveText(CLOCK);
    await expect(clock).not.toHaveText("0:00 into every flight", {
      timeout: 10000,
    });
    // And the layer draws the flights as far as the clock has come
    await expect
      .poll(async () => (await drawn(page))?.time ?? 0, { timeout: 10000 })
      .toBeGreaterThan(0);

    // Paused, the clock holds: half a second would be over a minute
    const play = page.locator("#replay-all-play-btn");
    await play.click();
    await expect(play).toHaveAttribute(
      "aria-label",
      "Play the replay of all flights",
    );
    const held = await clock.textContent();
    await page.waitForTimeout(500);
    await expect(clock).toHaveText(held!);

    await page.locator("#replay-all-close-btn").click();
    await expect(panel).toBeHidden();
    await expect(button).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator("#year-select")).toBeEnabled();
    expect(await drawn(page)).toBeNull();
    expect(await page.evaluate(() => window.mapApp!.replayActive)).toBe(false);
  });

  test("closes on Escape and hands focus back to its control", async ({
    page,
  }) => {
    const button = page.locator("#replay-all-btn");
    await button.click();
    await expect(page.locator("#replay-all-controls")).toBeVisible({
      timeout: 10000,
    });

    await page.keyboard.press("Escape");

    await expect(page.locator("#replay-all-controls")).toBeHidden();
    await expect(button).toBeFocused();
  });

  test("keeps the orbit off under reduced motion, and says why", async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.locator("#replay-all-btn").click();

    const orbit = page.locator("#replay-all-orbit-btn");
    await expect(orbit).toBeVisible({ timeout: 10000 });
    await orbit.click();

    await expect(orbit).toHaveAttribute("aria-pressed", "false");
    await expect(toastMessage(page, "reduced motion")).toBeVisible();
  });
});

test.describe("Replay all flights on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("starts from the More sheet, and the bar steps aside while it plays", async ({
    page,
  }) => {
    await gotoApp(page);
    await openMobileSheet(page, "more");
    await page.locator('.sheet-row[data-row="replay-all"]').click();

    await expect(page.locator("#replay-all-controls")).toBeVisible({
      timeout: 10000,
    });
    await expect(page.locator("#mobile-bar")).toHaveCount(0);

    await page.locator("#replay-all-close-btn").click();

    await expect(page.locator("#replay-all-controls")).toBeHidden();
    await expect(page.locator("#mobile-bar")).toHaveCount(1);
    await expect(page.locator("#mobile-tab-more")).toBeFocused();
  });
});
