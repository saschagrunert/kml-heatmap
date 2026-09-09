import { test, expect } from "@playwright/test";
import {
  KNOWN_YEARS,
  gotoApp,
  readSavedState,
  selectPathForReplay,
  waitForAircraftFilter,
  waitForAppReady,
  waitForPathData,
  waitForYearFilter,
} from "./helpers";

test.describe("State Persistence", () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
  });

  test.describe("Button Hiding", () => {
    test("hidden buttons are invisible and not interactive", async ({
      page,
    }) => {
      await page.locator("#hide-buttons-btn").click();

      const heatmapBtn = page.locator("#heatmap-btn");
      await expect(heatmapBtn).toHaveCSS("visibility", "hidden");
      await expect(heatmapBtn).toHaveCSS("pointer-events", "none");

      const altBtn = page.locator("#altitude-btn");
      await expect(altBtn).toHaveCSS("visibility", "hidden");
      await expect(altBtn).toHaveCSS("pointer-events", "none");
    });

    test("hidden buttons are not clickable", async ({ page }) => {
      await expect(page.locator("#heatmap-btn")).toHaveCSS("opacity", "1");

      await page.locator("#hide-buttons-btn").click();
      await expect(page.locator("#heatmap-btn")).toHaveCSS(
        "visibility",
        "hidden",
      );

      await page.locator("#heatmap-btn").click({ force: true });
      expect(await page.evaluate(() => window.mapApp!.heatmapVisible)).toBe(
        true,
      );
    });

    test("buttons hidden state persists in localStorage", async ({ page }) => {
      await page.locator("#hide-buttons-btn").click();
      await expect
        .poll(async () => (await readSavedState(page))["buttonsHidden"])
        .toBe(true);

      await page.reload();
      await waitForAppReady(page);

      await expect(page.locator("#heatmap-btn")).toHaveCSS(
        "visibility",
        "hidden",
      );
      await expect(page.locator("#hide-buttons-btn")).toHaveText("🔽");
    });

    test("buttons hidden state via URL parameter", async ({ page }) => {
      await gotoApp(page, "/?v=100100010");

      await expect(page.locator("#heatmap-btn")).toHaveCSS(
        "visibility",
        "hidden",
      );
      await expect(page.locator("#hide-buttons-btn")).toHaveText("🔽");
    });

    test("showing buttons restores visibility and pointer-events", async ({
      page,
    }) => {
      await page.locator("#hide-buttons-btn").click();
      await expect(page.locator("#heatmap-btn")).toHaveCSS(
        "visibility",
        "hidden",
      );

      await page.locator("#hide-buttons-btn").click();
      await expect(page.locator("#heatmap-btn")).toHaveCSS(
        "visibility",
        "visible",
      );
      await expect(page.locator("#heatmap-btn")).toHaveCSS("opacity", "1");
      await expect(page.locator("#heatmap-btn")).not.toHaveCSS(
        "pointer-events",
        "none",
      );
    });
  });

  test.describe("localStorage", () => {
    test("state is saved to localStorage", async ({ page }) => {
      await page.evaluate(() => localStorage.removeItem("kml-heatmap-state"));

      await page.locator("#heatmap-btn").click();
      await expect(page.locator("#heatmap-btn")).toHaveCSS("opacity", "0.5");

      await expect
        .poll(async () => (await readSavedState(page))["heatmapVisible"])
        .toBe(false);
    });

    test("state is restored on reload", async ({ page }) => {
      await page.locator("#heatmap-btn").click();
      await expect(page.locator("#heatmap-btn")).toHaveCSS("opacity", "0.5");
      await expect
        .poll(async () => (await readSavedState(page))["heatmapVisible"])
        .toBe(false);

      await page.reload();
      await waitForAppReady(page);

      await expect(page.locator("#heatmap-btn")).toHaveCSS("opacity", "0.5");
    });

    test("localStorage stores expected state fields", async ({ page }) => {
      await page.locator("#heatmap-btn").click();
      await expect
        .poll(async () => (await readSavedState(page))["heatmapVisible"])
        .toBe(false);

      const state = await readSavedState(page);

      const expectedKeys = [
        "schemaVersion",
        "center",
        "zoom",
        "heatmapVisible",
        "altitudeVisible",
        "airspeedVisible",
        "airportsVisible",
        "selectedYear",
        "selectedAircraft",
        "selectedPathIds",
        "statsPanelVisible",
        "buttonsHidden",
        "isolateSelection",
      ];

      for (const key of expectedKeys) {
        expect(state).toHaveProperty(key);
      }
    });

    test("selected path IDs persist across reload", async ({ page }) => {
      await selectPathForReplay(page);

      await expect
        .poll(async () => {
          const ids = (await readSavedState(page))["selectedPathIds"];
          return Array.isArray(ids) ? ids.length : 0;
        })
        .toBe(1);

      await page.reload();
      await waitForAppReady(page);

      await page.waitForFunction(
        () => window.mapApp!.selectedPathIds.size > 0,
        { timeout: 15000 },
      );
      expect(
        await page.evaluate(() => window.mapApp!.selectedPathIds.size),
      ).toBe(1);
    });
  });

  test.describe("URL and localStorage Combinations", () => {
    test("URL parameters take priority over localStorage", async ({ page }) => {
      await page.locator("#heatmap-btn").click();
      await expect
        .poll(async () => (await readSavedState(page))["heatmapVisible"])
        .toBe(false);

      await gotoApp(page, "/?v=100100000");

      await expect(page.locator("#heatmap-btn")).toHaveCSS("opacity", "1");
    });

    test("URL year parameter overrides localStorage year", async ({ page }) => {
      const yearSelect = page.locator("#year-select");
      expect(await yearSelect.locator("option").count()).toBe(
        KNOWN_YEARS.length + 1,
      );
      const [year1, year2] = KNOWN_YEARS as [string, string];

      await yearSelect.selectOption(year1);
      await waitForYearFilter(page, year1);
      await expect
        .poll(async () => (await readSavedState(page))["selectedYear"])
        .toBe(year1);

      await gotoApp(page, `/?y=${year2}`);

      await expect(yearSelect).toHaveValue(year2);
    });

    test("URL aircraft parameter overrides localStorage aircraft", async ({
      page,
    }) => {
      const aircraftSelect = page.locator("#aircraft-select");
      const options = aircraftSelect.locator("option");
      expect(await options.count()).toBeGreaterThanOrEqual(2);

      const aircraft = (await options.nth(1).getAttribute("value"))!;
      await aircraftSelect.selectOption("all");
      await waitForAircraftFilter(page, "all");

      await gotoApp(page, `/?a=${aircraft}`);

      await expect(aircraftSelect).toHaveValue(aircraft);
    });

    test("URL visibility overrides localStorage visibility", async ({
      page,
    }) => {
      await page.locator("#heatmap-btn").click();
      await expect
        .poll(async () => (await readSavedState(page))["heatmapVisible"])
        .toBe(false);

      await gotoApp(page, "/?v=010100000");

      await expect(page.locator("#heatmap-btn")).toHaveCSS("opacity", "0.5");
      await expect(page.locator("#altitude-btn")).toHaveCSS("opacity", "1");
    });

    test("URL stats panel visibility is restored", async ({ page }) => {
      await gotoApp(page, "/?v=100111000");

      await expect(page.locator("#stats-panel")).toBeVisible();
    });

    test("URL map position overrides localStorage position", async ({
      page,
    }) => {
      await gotoApp(page, "/?lat=48.000000&lng=11.000000&z=10.00");

      const center = await page.evaluate(() => {
        const map = window.mapApp!.map!;
        return { lat: map.getCenter().lat, lng: map.getCenter().lng };
      });

      expect(Math.abs(center.lat - 48.0)).toBeLessThan(1);
      expect(Math.abs(center.lng - 11.0)).toBeLessThan(1);
    });

    test("URL path selection overrides localStorage paths", async ({
      page,
    }) => {
      await waitForPathData(page);
      const pathId = await page.evaluate(
        () => window.mapApp!.fullPathInfo![0]!.id,
      );

      await gotoApp(page, `/?p=${pathId}&sv=2`);

      await page.waitForFunction(
        () => window.mapApp!.selectedPathIds.size > 0,
        { timeout: 15000 },
      );
      const hasPath = await page.evaluate(
        (id) => window.mapApp!.selectedPathIds.has(id),
        pathId,
      );
      expect(hasPath).toBe(true);
    });

    test("localStorage is used when no URL params present", async ({
      page,
    }) => {
      await page.locator("#heatmap-btn").click();
      await expect
        .poll(async () => (await readSavedState(page))["heatmapVisible"])
        .toBe(false);

      await gotoApp(page, "/");

      await expect(page.locator("#heatmap-btn")).toHaveCSS("opacity", "0.5");
    });

    test("URL updates when state changes", async ({ page }) => {
      await page.locator("#heatmap-btn").click();

      await expect.poll(() => page.url()).toContain("v=");
    });

    test("combined URL params are applied together", async ({ page }) => {
      const year = KNOWN_YEARS[0]!;

      await gotoApp(page, `/?y=${year}&v=000100000`);

      await expect(page.locator("#year-select")).toHaveValue(year);
      await expect(page.locator("#heatmap-btn")).toHaveCSS("opacity", "0.5");
      await expect(page.locator("#airports-btn")).toHaveCSS("opacity", "1");
    });
  });
});
