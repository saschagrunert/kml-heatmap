/**
 * Crossing the mobile breakpoint in a real browser.
 *
 * Every other spec runs at one fixed viewport, so the bar's mount and
 * unmount are only ever proven in jsdom. A rotation, a window resize on a
 * small laptop or a desktop browser at a narrow width all cross 768px with
 * the page already running, and the columns the bar stands in for have to
 * come back working when it leaves.
 *
 * The interesting case is a resize while something else is holding the
 * chrome hidden: Wrapped and the image export both hide the control groups
 * for the duration, so the bar's idea of what `display` they had is only
 * correct when it happens to mount first.
 */
import { test, expect, type Page } from "@playwright/test";
import { gotoApp, MOBILE_BAR_BREAKPOINT_PX, waitForAppReady } from "./helpers";

const BREAKPOINT_PX = MOBILE_BAR_BREAKPOINT_PX;

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 720 };

/** Resize and wait until the bar has caught up with the new width */
async function resizeTo(
  page: Page,
  size: { width: number; height: number },
): Promise<void> {
  await page.setViewportSize(size);
  await expect(page.locator("#mobile-bar")).toHaveCount(
    size.width < BREAKPOINT_PX ? 1 : 0,
  );
}

/** Both control columns are on screen and reachable */
async function expectColumnsUsable(page: Page): Promise<void> {
  const left = page.locator("#left-buttons");
  const right = page.locator("#right-buttons");
  await expect(left).toBeVisible();
  await expect(right).toBeVisible();
  // `hidden` is what takes them out of the tab order while the bar is up
  await expect(left).not.toHaveAttribute("hidden", /.*/);
  await expect(right).not.toHaveAttribute("hidden", /.*/);

  // Visible is not the same as working: drive a control in each column
  const heatmap = page.locator("#heatmap-btn");
  const pressed = (await heatmap.getAttribute("aria-pressed")) === "true";
  await heatmap.click();
  await expect(heatmap).toHaveAttribute("aria-pressed", String(!pressed));
  await heatmap.click();
  await expect(heatmap).toHaveAttribute("aria-pressed", String(pressed));

  await expect(page.locator("#stats-btn")).toBeEnabled();
}

/** Neither column may show through while the bar is standing in for them */
async function expectColumnsReplaced(page: Page): Promise<void> {
  await expect(page.locator("#mobile-bar")).toBeVisible();
  await expect(page.locator("#left-buttons")).toBeHidden();
  await expect(page.locator("#right-buttons")).toBeHidden();
}

test.describe("Mobile breakpoint", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await gotoApp(page);
  });

  test("the bar mounts and unmounts as the viewport crosses 768px", async ({
    page,
  }) => {
    await expect(page.locator("#mobile-bar")).toHaveCount(0);
    await expectColumnsUsable(page);

    await resizeTo(page, PHONE);

    await expectColumnsReplaced(page);
    await expect(page.locator(".mobile-tab")).toHaveCount(5);

    await resizeTo(page, DESKTOP);

    await expect(page.locator("#mobile-sheet")).toHaveCount(0);
    await expectColumnsUsable(page);

    // And back again, so the second mount is not a special case
    await resizeTo(page, PHONE);
    await expectColumnsReplaced(page);
    await resizeTo(page, DESKTOP);
    await expectColumnsUsable(page);
  });

  test("the columns come back after Wrapped was opened below the breakpoint", async ({
    page,
  }) => {
    await resizeTo(page, PHONE);
    await expectColumnsReplaced(page);

    // Wrapped hides the control chrome for as long as it is showing, so
    // the columns are already display:none when the bar leaves
    await page.locator("#mobile-tab-wrapped").click();
    await expect(page.locator("#wrapped-modal")).toBeVisible({ timeout: 5000 });

    await resizeTo(page, DESKTOP);

    await page.locator("#wrapped-modal .close-btn").click();
    await expect(page.locator("#wrapped-modal")).toBeHidden();

    await expectColumnsUsable(page);
  });

  test("the columns come back after Wrapped was opened above the breakpoint", async ({
    page,
  }) => {
    await page.locator("#wrapped-btn").click();
    await expect(page.locator("#wrapped-modal")).toBeVisible({ timeout: 5000 });

    // The bar mounts while the chrome is already hidden by Wrapped
    await resizeTo(page, PHONE);
    await expect(page.locator("#left-buttons")).toBeHidden();
    await expect(page.locator("#right-buttons")).toBeHidden();

    await page.locator("#wrapped-modal .close-btn").click();
    await expect(page.locator("#wrapped-modal")).toBeHidden();

    // Closing Wrapped must not put the columns back next to the bar
    await expectColumnsReplaced(page);

    await resizeTo(page, DESKTOP);

    await expectColumnsUsable(page);
  });

  test("a reload at the new width agrees with the resized page", async ({
    page,
  }) => {
    await resizeTo(page, PHONE);
    await expectColumnsReplaced(page);

    await page.reload();
    await waitForAppReady(page);

    await expectColumnsReplaced(page);

    await resizeTo(page, DESKTOP);
    await expectColumnsUsable(page);
  });

  test("the mobile bar cannot reach into an already open Wrapped dialog", async ({
    page,
  }) => {
    // The dialog makes the page behind it inert when it opens. Crossing the
    // breakpoint mounts the bar afterwards, and its five tabs used to join the
    // dialog's tab cycle and stay operable behind the modal.
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.locator("#wrapped-btn").click();
    await expect(page.locator("#wrapped-modal")).toBeVisible();

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator("#mobile-bar")).toHaveCount(1);

    await expect(page.locator("#mobile-bar")).toHaveAttribute("inert", "");
    const focusable = await page.evaluate(() =>
      ["mobile-tab-layers", "mobile-tab-stats", "mobile-tab-more"].map((id) => {
        const el = document.getElementById(id);
        if (!el) return "absent";
        el.focus();
        return document.activeElement === el;
      }),
    );
    expect(focusable).toEqual([false, false, false]);

    await page.keyboard.press("Escape");
    await expect(page.locator("#wrapped-modal")).toBeHidden();
    // And the bar is handed back once the dialog closes
    await expect(page.locator("#mobile-bar")).not.toHaveAttribute("inert", "");
    await page.locator("#mobile-tab-layers").click();
    await expect(page.locator("#mobile-sheet")).toBeVisible();
  });
});
