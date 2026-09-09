import { test, expect } from "@playwright/test";
import {
  KNOWN_YEARS,
  gotoApp,
  layerButton,
  readSavedState,
  selectPathForReplay,
  setAircraftFilter,
  setYearFilter,
  toggleLayer,
  usesMobileBar,
  waitForAircraftFilter,
  waitForAppReady,
  waitForPathData,
  waitForYearFilter,
} from "./helpers";

test.describe("State Persistence", () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
  });

  test.describe("localStorage", () => {
    test("state is saved to localStorage", async ({ page }) => {
      await page.evaluate(() => localStorage.removeItem("kml-heatmap-state"));

      await toggleLayer(page, "heatmap");
      await expect(layerButton(page, "heatmap")).toHaveCSS("opacity", "0.5");

      await expect
        .poll(async () => (await readSavedState(page))["heatmapVisible"])
        .toBe(false);
    });

    test("state is restored on reload", async ({ page }) => {
      await toggleLayer(page, "heatmap");
      await expect(layerButton(page, "heatmap")).toHaveCSS("opacity", "0.5");
      await expect
        .poll(async () => (await readSavedState(page))["heatmapVisible"])
        .toBe(false);

      await page.reload();
      await waitForAppReady(page);

      await expect(layerButton(page, "heatmap")).toHaveCSS("opacity", "0.5");
    });

    test("localStorage stores expected state fields", async ({ page }) => {
      await toggleLayer(page, "heatmap");
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
      await toggleLayer(page, "heatmap");
      await expect
        .poll(async () => (await readSavedState(page))["heatmapVisible"])
        .toBe(false);

      await gotoApp(page, "/?v=100100000");

      await expect(layerButton(page, "heatmap")).toHaveCSS("opacity", "1");
    });

    test("URL year parameter overrides localStorage year", async ({ page }) => {
      const yearSelect = page.locator("#year-select");
      expect(await yearSelect.locator("option").count()).toBe(
        KNOWN_YEARS.length + 1,
      );
      const [year1, year2] = KNOWN_YEARS as [string, string];

      await setYearFilter(page, year1);
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
      await setAircraftFilter(page, "all");
      await waitForAircraftFilter(page, "all");

      await gotoApp(page, `/?a=${aircraft}`);

      await expect(aircraftSelect).toHaveValue(aircraft);
    });

    test("URL visibility overrides localStorage visibility", async ({
      page,
    }) => {
      await toggleLayer(page, "heatmap");
      await expect
        .poll(async () => (await readSavedState(page))["heatmapVisible"])
        .toBe(false);

      await gotoApp(page, "/?v=010100000");

      await expect(layerButton(page, "heatmap")).toHaveCSS("opacity", "0.5");
      await expect(layerButton(page, "altitude")).toHaveCSS("opacity", "1");
    });

    test("a legacy shared link keeps its flags and drops the hide-controls bit", async ({
      page,
    }) => {
      // The 8th slot of the visibility string carried the hide-controls
      // flag. The feature is gone but links minted before it went away
      // still set the bit, and the isolate flag behind it has to survive
      // the slot being ignored rather than shifting by one.
      await gotoApp(page, "/?v=100100011");

      await expect(page.locator("#isolate-btn")).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      expect(await page.evaluate(() => window.mapApp!.isolateSelection)).toBe(
        true,
      );

      for (const [layer, pressed] of [
        ["heatmap", "true"],
        ["altitude", "false"],
        ["airspeed", "false"],
        ["airports", "true"],
      ] as const) {
        await expect(layerButton(page, layer), layer).toHaveAttribute(
          "aria-pressed",
          pressed,
        );
      }
      await expect(page.locator("#stats-panel")).toBeHidden();
      await expect(page.locator("#wrapped-modal")).toBeHidden();

      // The chrome the legacy bit used to hide is on screen either way
      const controls = (await usesMobileBar(page))
        ? "#mobile-bar"
        : "#left-buttons";
      await expect(page.locator(controls)).toBeVisible();

      // And the link the app writes back no longer carries the bit
      await expect
        .poll(() => new URL(page.url()).searchParams.get("v"))
        .toBe("100100001");
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
      await toggleLayer(page, "heatmap");
      await expect
        .poll(async () => (await readSavedState(page))["heatmapVisible"])
        .toBe(false);

      await gotoApp(page, "/");

      await expect(layerButton(page, "heatmap")).toHaveCSS("opacity", "0.5");
    });

    test("URL updates when state changes", async ({ page }) => {
      await toggleLayer(page, "heatmap");

      await expect.poll(() => page.url()).toContain("v=");
    });

    test("combined URL params are applied together", async ({ page }) => {
      const year = KNOWN_YEARS[0]!;

      await gotoApp(page, `/?y=${year}&v=000100000`);

      await expect(page.locator("#year-select")).toHaveValue(year);
      await expect(layerButton(page, "heatmap")).toHaveCSS("opacity", "0.5");
      await expect(layerButton(page, "airports")).toHaveCSS("opacity", "1");
    });
  });
});
