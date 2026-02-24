import { test, expect } from "@playwright/test";
import { waitForPathData, selectPathForReplay } from "./helpers";

test.describe("State Persistence", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("#map.leaflet-container", { timeout: 15000 });
  });

  test.describe("Button Hiding", () => {
    test("hidden buttons have opacity 0 and pointer-events none", async ({
      page,
    }) => {
      await page.locator("#hide-buttons-btn").click();

      const heatmapBtn = page.locator("#heatmap-btn");
      await expect(heatmapBtn).toHaveCSS("opacity", "0");
      await expect(heatmapBtn).toHaveCSS("pointer-events", "none");

      const altBtn = page.locator("#altitude-btn");
      await expect(altBtn).toHaveCSS("opacity", "0");
      await expect(altBtn).toHaveCSS("pointer-events", "none");
    });

    test("hidden buttons are not clickable", async ({ page }) => {
      await expect(page.locator("#heatmap-btn")).toHaveCSS("opacity", "1");

      await page.locator("#hide-buttons-btn").click();
      await expect(page.locator("#heatmap-btn")).toHaveCSS("opacity", "0");

      await page.locator("#heatmap-btn").click({ force: true });
      const isVisible = await page.evaluate(
        () => (window as any).mapApp.heatmapVisible
      );
      expect(isVisible).toBe(true);
    });

    test("buttons hidden state persists in localStorage", async ({ page }) => {
      await page.locator("#hide-buttons-btn").click();
      await page.waitForFunction(() => {
        const state = JSON.parse(
          localStorage.getItem("kml-heatmap-state") || "{}"
        );
        return state.buttonsHidden === true;
      });

      await page.reload();
      await page.waitForSelector("#map.leaflet-container", { timeout: 15000 });

      await expect(page.locator("#heatmap-btn")).toHaveCSS("opacity", "0");
      await expect(page.locator("#hide-buttons-btn")).toHaveText("🔽");
    });

    test("buttons hidden state via URL parameter", async ({ page }) => {
      await page.goto("/?v=10010001");
      await page.waitForSelector("#map.leaflet-container", { timeout: 15000 });

      await expect(page.locator("#heatmap-btn")).toHaveCSS("opacity", "0");
      await expect(page.locator("#hide-buttons-btn")).toHaveText("🔽");
    });

    test("showing buttons restores opacity and pointer-events", async ({
      page,
    }) => {
      await page.locator("#hide-buttons-btn").click();
      await expect(page.locator("#heatmap-btn")).toHaveCSS("opacity", "0");

      await page.locator("#hide-buttons-btn").click();
      await expect(page.locator("#heatmap-btn")).toHaveCSS("opacity", "1");
      await expect(page.locator("#heatmap-btn")).not.toHaveCSS(
        "pointer-events",
        "none"
      );
    });
  });

  test.describe("localStorage", () => {
    test("state is saved to localStorage", async ({ page }) => {
      await page.evaluate(() => localStorage.removeItem("kml-heatmap-state"));

      await page.locator("#heatmap-btn").click();
      await expect(page.locator("#heatmap-btn")).toHaveCSS("opacity", "0.5");

      await page.waitForFunction(
        () => localStorage.getItem("kml-heatmap-state") !== null,
        { timeout: 5000 }
      );

      const state = await page.evaluate(() =>
        JSON.parse(localStorage.getItem("kml-heatmap-state") || "{}")
      );
      expect(state.heatmapVisible).toBe(false);
    });

    test("state is restored on reload", async ({ page }) => {
      await page.locator("#heatmap-btn").click();
      await expect(page.locator("#heatmap-btn")).toHaveCSS("opacity", "0.5");
      await page.waitForFunction(
        () => localStorage.getItem("kml-heatmap-state") !== null
      );

      await page.reload();
      await page.waitForSelector("#map.leaflet-container", { timeout: 15000 });

      await expect(page.locator("#heatmap-btn")).toHaveCSS("opacity", "0.5");
    });

    test("localStorage stores expected state fields", async ({ page }) => {
      await page.locator("#heatmap-btn").click();
      await page.waitForFunction(
        () => localStorage.getItem("kml-heatmap-state") !== null,
        { timeout: 5000 }
      );

      const state = await page.evaluate(() =>
        JSON.parse(localStorage.getItem("kml-heatmap-state") || "{}")
      );

      const expectedKeys = [
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
      ];

      for (const key of expectedKeys) {
        expect(state).toHaveProperty(key);
      }
    });

    test("selected path IDs persist across reload", async ({ page }) => {
      await selectPathForReplay(page);

      await page.waitForFunction(
        () => {
          const state = JSON.parse(
            localStorage.getItem("kml-heatmap-state") || "{}"
          );
          return state.selectedPathIds && state.selectedPathIds.length > 0;
        },
        { timeout: 5000 }
      );

      await page.reload();
      await page.waitForSelector("#map.leaflet-container", { timeout: 15000 });

      await page.waitForFunction(
        () => (window as any).mapApp?.selectedPathIds?.size > 0,
        { timeout: 15000 }
      );

      const size = await page.evaluate(
        () => (window as any).mapApp.selectedPathIds.size
      );
      expect(size).toBe(1);
    });
  });

  test.describe("URL and localStorage Combinations", () => {
    test("URL parameters take priority over localStorage", async ({ page }) => {
      await page.locator("#heatmap-btn").click();
      await page.waitForFunction(
        () => localStorage.getItem("kml-heatmap-state") !== null
      );

      await page.goto("/?v=10010000");
      await page.waitForSelector("#map.leaflet-container", { timeout: 15000 });

      await expect(page.locator("#heatmap-btn")).toHaveCSS("opacity", "1");
    });

    test("URL year parameter overrides localStorage year", async ({ page }) => {
      const yearSelect = page.locator("#year-select");
      const options = yearSelect.locator("option");
      const count = await options.count();
      if (count < 3) return;

      const year1 = await options.nth(1).getAttribute("value");
      const year2 = await options.nth(2).getAttribute("value");
      if (!year1 || !year2) return;

      await yearSelect.selectOption(year1);
      await page.waitForTimeout(500);

      await page.goto(`/?y=${year2}`);
      await page.waitForSelector("#map.leaflet-container", { timeout: 15000 });

      await expect(yearSelect).toHaveValue(year2);
    });

    test("URL aircraft parameter overrides localStorage aircraft", async ({
      page,
    }) => {
      const aircraftSelect = page.locator("#aircraft-select");
      const options = aircraftSelect.locator("option");
      const count = await options.count();
      if (count < 2) return;

      const aircraft = await options.nth(1).getAttribute("value");
      if (!aircraft) return;

      await page.goto(`/?a=${aircraft}`);
      await page.waitForSelector("#map.leaflet-container", { timeout: 15000 });

      await expect(aircraftSelect).toHaveValue(aircraft);
    });

    test("URL visibility overrides localStorage visibility", async ({
      page,
    }) => {
      await page.locator("#heatmap-btn").click();
      await page.waitForFunction(
        () => localStorage.getItem("kml-heatmap-state") !== null
      );

      await page.goto("/?v=01010000");
      await page.waitForSelector("#map.leaflet-container", { timeout: 15000 });

      await expect(page.locator("#heatmap-btn")).toHaveCSS("opacity", "0.5");
      await expect(page.locator("#altitude-btn")).toHaveCSS("opacity", "1");
    });

    test("URL stats panel visibility is restored", async ({ page }) => {
      await page.goto("/?v=10011100");
      await page.waitForSelector("#map.leaflet-container", { timeout: 15000 });

      await expect(page.locator("#stats-panel")).toBeVisible();
    });

    test("URL map position overrides localStorage position", async ({
      page,
    }) => {
      await page.goto("/?lat=48.000000&lng=11.000000&z=10.00");
      await page.waitForSelector("#map.leaflet-container", { timeout: 15000 });

      const center = await page.evaluate(() => {
        const map = (window as any).mapApp.map;
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
        () => (window as any).mapApp.fullPathInfo[0].id
      );

      await page.goto(`/?p=${pathId}`);
      await page.waitForSelector("#map.leaflet-container", { timeout: 15000 });

      await page.waitForFunction(
        () => (window as any).mapApp?.selectedPathIds?.size > 0,
        { timeout: 15000 }
      );

      const hasPath = await page.evaluate(
        (id) => (window as any).mapApp.selectedPathIds.has(id),
        pathId
      );
      expect(hasPath).toBe(true);
    });

    test("localStorage is used when no URL params present", async ({
      page,
    }) => {
      await page.locator("#heatmap-btn").click();
      await page.waitForFunction(
        () => localStorage.getItem("kml-heatmap-state") !== null
      );

      await page.goto("/");
      await page.waitForSelector("#map.leaflet-container", { timeout: 15000 });

      await expect(page.locator("#heatmap-btn")).toHaveCSS("opacity", "0.5");
    });

    test("URL updates when state changes", async ({ page }) => {
      await page.locator("#heatmap-btn").click();
      await page.waitForTimeout(500);

      const url = page.url();
      expect(url).toContain("v=");
    });

    test("combined URL params are applied together", async ({ page }) => {
      const yearSelect = page.locator("#year-select");
      const options = yearSelect.locator("option");
      const count = await options.count();
      if (count < 2) return;

      const year = await options.nth(1).getAttribute("value");
      if (!year) return;

      await page.goto(`/?y=${year}&v=00010000`);
      await page.waitForSelector("#map.leaflet-container", { timeout: 15000 });

      await expect(yearSelect).toHaveValue(year);
      await expect(page.locator("#heatmap-btn")).toHaveCSS("opacity", "0.5");
      await expect(page.locator("#airports-btn")).toHaveCSS("opacity", "1");
    });
  });
});
