import { test, expect } from "@playwright/test";
import { selectPathForReplay, activateReplay } from "./helpers";

test.describe("Error-Free Interactions", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("#map.leaflet-container", { timeout: 15000 });
  });

  test.describe("Console Error-Free", () => {
    test("no console errors during layer toggling", async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (err) => errors.push(err.message));

      await page.locator("#heatmap-btn").click();
      await page.waitForTimeout(200);
      await page.locator("#altitude-btn").click();
      await page.waitForTimeout(200);
      await page.locator("#airspeed-btn").click();
      await page.waitForTimeout(200);
      await page.locator("#airports-btn").click();
      await page.waitForTimeout(200);

      await page.locator("#heatmap-btn").click();
      await page.waitForTimeout(200);
      await page.locator("#altitude-btn").click();
      await page.waitForTimeout(200);
      await page.locator("#airspeed-btn").click();
      await page.waitForTimeout(200);
      await page.locator("#airports-btn").click();
      await page.waitForTimeout(200);

      expect(errors).toHaveLength(0);
    });

    test("no console errors during filter changes", async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (err) => errors.push(err.message));

      const yearSelect = page.locator("#year-select");
      const yearOptions = yearSelect.locator("option");
      if ((await yearOptions.count()) >= 2) {
        const yearVal = await yearOptions.nth(1).getAttribute("value");
        if (yearVal) {
          await yearSelect.selectOption(yearVal);
          await page.waitForTimeout(1000);
        }
      }

      const aircraftSelect = page.locator("#aircraft-select");
      const aircraftOptions = aircraftSelect.locator("option");
      if ((await aircraftOptions.count()) >= 2) {
        const aircraftVal = await aircraftOptions.nth(1).getAttribute("value");
        if (aircraftVal) {
          await aircraftSelect.selectOption(aircraftVal);
          await page.waitForTimeout(1000);
        }
      }

      await yearSelect.selectOption("all");
      await page.waitForTimeout(500);
      await aircraftSelect.selectOption("all");
      await page.waitForTimeout(500);

      expect(errors).toHaveLength(0);
    });

    test("no console errors during path selection and deselection", async ({
      page,
    }) => {
      const errors: string[] = [];
      page.on("pageerror", (err) => errors.push(err.message));

      const pathId = await selectPathForReplay(page);

      await page.evaluate(
        (id) => (window as any).togglePathSelection(String(id)),
        pathId
      );
      await page.waitForFunction(
        () => (window as any).mapApp.selectedPathIds.size === 0
      );

      expect(errors).toHaveLength(0);
    });

    test("no console errors during replay lifecycle", async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (err) => errors.push(err.message));

      await activateReplay(page);

      await page.locator("#replay-play-btn").click();
      await page.waitForTimeout(300);
      await page.locator("#replay-pause-btn").click();
      await page.waitForTimeout(200);
      await page.locator("#replay-stop-btn").click();
      await page.waitForTimeout(200);

      await page.locator("#replay-btn").click();
      await expect(page.locator("#replay-controls")).toBeHidden();

      expect(errors).toHaveLength(0);
    });

    test("no console errors during wrapped modal lifecycle", async ({
      page,
    }) => {
      const errors: string[] = [];
      page.on("pageerror", (err) => errors.push(err.message));

      await page.locator("#wrapped-btn").click();
      await expect(page.locator("#wrapped-modal")).toBeVisible({
        timeout: 5000,
      });

      await page.locator("#wrapped-modal .close-btn").click();
      await expect(page.locator("#wrapped-modal")).toBeHidden();

      expect(errors).toHaveLength(0);
    });

    test("no console errors during stats panel toggle", async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (err) => errors.push(err.message));

      await page.locator("#stats-btn").click();
      await expect(page.locator("#stats-panel")).toBeVisible();

      await page.locator("#stats-btn").click();
      await page.waitForTimeout(400);

      expect(errors).toHaveLength(0);
    });
  });

  test.describe("Zoom Behavior", () => {
    test("zooming in updates heatmap without errors", async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (err) => errors.push(err.message));

      await page.evaluate(() => {
        const map = (window as any).mapApp.map;
        map.setZoom(map.getZoom() + 2, { animate: false });
      });
      await page.waitForTimeout(300);

      const isVisible = await page.evaluate(
        () => (window as any).mapApp.heatmapVisible
      );
      expect(isVisible).toBe(true);
      expect(errors).toHaveLength(0);
    });

    test("zooming out updates heatmap without errors", async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (err) => errors.push(err.message));

      await page.evaluate(() => {
        const map = (window as any).mapApp.map;
        map.setZoom(Math.max(1, map.getZoom() - 3), { animate: false });
      });
      await page.waitForTimeout(300);

      const isVisible = await page.evaluate(
        () => (window as any).mapApp.heatmapVisible
      );
      expect(isVisible).toBe(true);
      expect(errors).toHaveLength(0);
    });

    test("zooming preserves altitude path colors", async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (err) => errors.push(err.message));

      await page.locator("#altitude-btn").click();
      await expect(page.locator("#altitude-btn")).toHaveCSS("opacity", "1");
      await page.waitForFunction(
        () => (window as any).mapApp?.fullPathInfo?.length > 0,
        { timeout: 15000 }
      );

      const initialPathCount = await page.evaluate(() => {
        const app = (window as any).mapApp;
        return app.currentData?.path_segments?.length || 0;
      });

      await page.evaluate(() => {
        const map = (window as any).mapApp.map;
        map.setZoom(map.getZoom() + 2, { animate: false });
      });
      await page.waitForTimeout(300);

      const altVisible = await page.evaluate(
        () => (window as any).mapApp.altitudeVisible
      );
      expect(altVisible).toBe(true);

      const afterPathCount = await page.evaluate(() => {
        const app = (window as any).mapApp;
        return app.currentData?.path_segments?.length || 0;
      });
      expect(afterPathCount).toBe(initialPathCount);
      expect(errors).toHaveLength(0);
    });

    test("zooming preserves airspeed path colors", async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (err) => errors.push(err.message));

      await page.locator("#airspeed-btn").click();
      await expect(page.locator("#airspeed-btn")).toHaveCSS("opacity", "1");
      await page.waitForTimeout(300);

      await page.evaluate(() => {
        const map = (window as any).mapApp.map;
        map.setZoom(map.getZoom() + 2, { animate: false });
      });
      await page.waitForTimeout(300);

      const airspeedVisible = await page.evaluate(
        () => (window as any).mapApp.airspeedVisible
      );
      expect(airspeedVisible).toBe(true);
      expect(errors).toHaveLength(0);
    });

    test("zoom level is saved to state", async ({ page }) => {
      await page.evaluate(() => localStorage.removeItem("kml-heatmap-state"));
      await page.reload();
      await page.waitForSelector("#map.leaflet-container", { timeout: 15000 });
      await page.waitForTimeout(500);

      await page.evaluate(() => {
        const map = (window as any).mapApp.map;
        map.setZoom(12, { animate: false });
      });
      await page.waitForTimeout(500);

      const afterZoom = await page.evaluate(() =>
        (window as any).mapApp.map.getZoom()
      );
      expect(afterZoom).toBe(12);

      const state = await page.evaluate(() =>
        JSON.parse(localStorage.getItem("kml-heatmap-state") || "{}")
      );
      expect(state.zoom).toBe(12);
    });

    test("zoom level is restored on reload", async ({ page }) => {
      await page.evaluate(() => localStorage.removeItem("kml-heatmap-state"));
      await page.reload();
      await page.waitForSelector("#map.leaflet-container", { timeout: 15000 });
      await page.waitForTimeout(500);

      await page.evaluate(() => {
        const map = (window as any).mapApp.map;
        map.setZoom(12, { animate: false });
      });
      await page.waitForTimeout(500);

      await page.reload();
      await page.waitForSelector("#map.leaflet-container", { timeout: 15000 });
      await page.waitForTimeout(500);

      const zoom = await page.evaluate(() =>
        (window as any).mapApp.map.getZoom()
      );
      expect(zoom).toBe(12);
    });
  });
});
