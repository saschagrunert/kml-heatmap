import { test, expect, type Page } from "@playwright/test";
import {
  activateReplay,
  attachErrorCollectors,
  gotoApp,
  readSavedState,
  relevantConsoleErrors,
  selectPathForReplay,
  waitForAircraftFilter,
  waitForAppReady,
  waitForPathData,
  waitForYearFilter,
  type ErrorCollector,
} from "./helpers";

/** Toggle a layer button and wait for its pressed state to flip */
async function toggle(page: Page, selector: string): Promise<void> {
  const button = page.locator(selector);
  const pressed = (await button.getAttribute("aria-pressed")) === "true";
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", String(!pressed));
}

function expectClean(errors: ErrorCollector): void {
  expect(errors.pageErrors).toEqual([]);
  expect(errors.cspViolations).toEqual([]);
  expect(relevantConsoleErrors(errors)).toEqual([]);
}

test.describe("Error-Free Interactions", () => {
  let errors: ErrorCollector;

  test.beforeEach(async ({ page }) => {
    errors = await attachErrorCollectors(page);
    await gotoApp(page);
  });

  test.describe("Console Error-Free", () => {
    test("no errors during layer toggling", async ({ page }) => {
      const buttons = [
        "#heatmap-btn",
        "#altitude-btn",
        "#airspeed-btn",
        "#airports-btn",
      ];
      for (const selector of buttons) await toggle(page, selector);
      for (const selector of buttons) await toggle(page, selector);

      expectClean(errors);
    });

    test("no errors during filter changes", async ({ page }) => {
      const yearSelect = page.locator("#year-select");
      const yearOptions = yearSelect.locator("option");
      expect(await yearOptions.count()).toBeGreaterThanOrEqual(3);
      const yearVal = (await yearOptions.nth(1).getAttribute("value"))!;
      await yearSelect.selectOption(yearVal);
      await waitForYearFilter(page, yearVal);

      const aircraftSelect = page.locator("#aircraft-select");
      const aircraftOptions = aircraftSelect.locator("option");
      expect(await aircraftOptions.count()).toBeGreaterThanOrEqual(2);
      const aircraftVal = (await aircraftOptions.nth(1).getAttribute("value"))!;
      await aircraftSelect.selectOption(aircraftVal);
      await waitForAircraftFilter(page, aircraftVal);

      await yearSelect.selectOption("all");
      await waitForYearFilter(page, "all");
      await aircraftSelect.selectOption("all");
      await waitForAircraftFilter(page, "all");

      expectClean(errors);
    });

    test("no errors during path selection and deselection", async ({
      page,
    }) => {
      const pathId = await selectPathForReplay(page);

      await page.evaluate(
        (id) => window.mapApp!.togglePathSelection(String(id)),
        pathId,
      );
      await page.waitForFunction(
        () => window.mapApp!.selectedPathIds.size === 0,
      );

      expectClean(errors);
    });

    test("no errors during replay lifecycle", async ({ page }) => {
      await activateReplay(page);

      await page.locator("#replay-play-btn").click();
      await expect(page.locator("#replay-pause-btn")).toBeVisible();
      await page.locator("#replay-pause-btn").click();
      await expect(page.locator("#replay-play-btn")).toBeVisible();
      await page.locator("#replay-stop-btn").click();
      await expect(page.locator("#replay-play-btn")).toBeVisible();

      await page.locator("#replay-btn").click();
      await expect(page.locator("#replay-controls")).toBeHidden();

      expectClean(errors);
    });

    test("no errors during wrapped modal lifecycle", async ({ page }) => {
      await page.locator("#wrapped-btn").click();
      await expect(page.locator("#wrapped-modal")).toBeVisible({
        timeout: 5000,
      });

      await page.locator("#wrapped-modal .close-btn").click();
      await expect(page.locator("#wrapped-modal")).toBeHidden();

      expectClean(errors);
    });

    test("no errors during stats panel toggle", async ({ page }) => {
      await page.locator("#stats-btn").click();
      await expect(page.locator("#stats-panel")).toBeVisible();

      await page.locator("#stats-btn").click();
      await expect(page.locator("#stats-panel")).toBeHidden();

      expectClean(errors);
    });
  });

  test.describe("Zoom Behavior", () => {
    async function setZoom(page: Page, zoom: number): Promise<void> {
      await page.evaluate((z) => {
        window.mapApp!.map!.setZoom(z, { animate: false });
      }, zoom);
      await expect
        .poll(() => page.evaluate(() => window.mapApp!.map!.getZoom()))
        .toBe(zoom);
    }

    test("zooming in updates heatmap without errors", async ({ page }) => {
      const zoom = await page.evaluate(() => window.mapApp!.map!.getZoom());
      await setZoom(page, zoom + 2);

      expect(await page.evaluate(() => window.mapApp!.heatmapVisible)).toBe(
        true,
      );
      expectClean(errors);
    });

    test("zooming out updates heatmap without errors", async ({ page }) => {
      const zoom = await page.evaluate(() => window.mapApp!.map!.getZoom());
      await setZoom(page, Math.max(1, zoom - 3));

      expect(await page.evaluate(() => window.mapApp!.heatmapVisible)).toBe(
        true,
      );
      expectClean(errors);
    });

    test("zooming preserves altitude path colors", async ({ page }) => {
      await waitForPathData(page);

      const initialPathCount = await page.evaluate(
        () => window.mapApp!.currentData?.path_segments.length ?? 0,
      );
      expect(initialPathCount).toBeGreaterThan(0);

      const zoom = await page.evaluate(() => window.mapApp!.map!.getZoom());
      await setZoom(page, zoom + 2);

      expect(await page.evaluate(() => window.mapApp!.altitudeVisible)).toBe(
        true,
      );
      const afterPathCount = await page.evaluate(
        () => window.mapApp!.currentData?.path_segments.length ?? 0,
      );
      expect(afterPathCount).toBe(initialPathCount);
      expectClean(errors);
    });

    test("zooming preserves airspeed path colors", async ({ page }) => {
      await page.locator("#airspeed-btn").click();
      await expect(page.locator("#airspeed-btn")).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await page.waitForFunction(
        () => window.mapApp!.airspeedLayer.getLayers().length > 0,
      );

      const zoom = await page.evaluate(() => window.mapApp!.map!.getZoom());
      await setZoom(page, zoom + 2);

      expect(await page.evaluate(() => window.mapApp!.airspeedVisible)).toBe(
        true,
      );
      expectClean(errors);
    });

    test("zoom level is saved to state", async ({ page }) => {
      await page.evaluate(() => localStorage.removeItem("kml-heatmap-state"));
      await page.reload();
      await waitForAppReady(page);

      await setZoom(page, 12);

      await expect
        .poll(async () => (await readSavedState(page))["zoom"])
        .toBe(12);
    });

    test("zoom level is restored on reload", async ({ page }) => {
      await page.evaluate(() => localStorage.removeItem("kml-heatmap-state"));
      await page.reload();
      await waitForAppReady(page);

      await setZoom(page, 12);
      await expect
        .poll(async () => (await readSavedState(page))["zoom"])
        .toBe(12);

      await page.reload();
      await waitForAppReady(page);

      const zoom = await page.evaluate(() => window.mapApp!.map!.getZoom());
      expect(zoom).toBe(12);
    });
  });
});
