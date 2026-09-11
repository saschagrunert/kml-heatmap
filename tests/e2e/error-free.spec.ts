import { test, expect, type Page } from "./fixtures";
import {
  activateReplay,
  attachErrorCollectors,
  gotoApp,
  openWrapped,
  readSavedState,
  relevantConsoleErrors,
  selectPathForReplay,
  toggleLayer,
  togglePathSelection,
  waitForAircraftFilter,
  waitForAppReady,
  waitForPathData,
  waitForYearFilter,
  type ErrorCollector,
  type LayerName,
} from "./helpers";

/** Hex or rgb(a) as Leaflet writes it into the polyline options */
const COLOR_PATTERN = /^(#[0-9a-f]{6}|rgba?\(.+\))$/i;

/** Stroke colour of every polyline in a colour layer, in layer order */
function layerColors(
  page: Page,
  layer: "altitudeLayer" | "airspeedLayer",
): Promise<string[]> {
  return page.evaluate(
    (name) =>
      window
        .mapApp![name].getLayers()
        .map((polyline) => String((polyline as L.Polyline).options.color)),
    layer,
  );
}

/** The layer carries a gradient of valid colours */
function expectColorRamp(colors: string[]): void {
  expect(colors.length).toBeGreaterThan(0);
  for (const color of colors) expect(color).toMatch(COLOR_PATTERN);
  // A ramp, not one colour for every run
  expect(new Set(colors).size).toBeGreaterThan(1);
}

/** The heatmap is on the map and its canvas has a size to paint into */
async function expectHeatmapPainted(page: Page): Promise<void> {
  const heat = await page.evaluate(() => {
    const app = window.mapApp!;
    const canvas = document.querySelector<HTMLCanvasElement>(
      "canvas.leaflet-heatmap-layer",
    );
    return {
      onMap: !!app.heatmapLayer && app.map!.hasLayer(app.heatmapLayer),
      width: canvas?.width ?? 0,
      height: canvas?.height ?? 0,
    };
  });
  expect(heat.onMap).toBe(true);
  expect(heat.width).toBeGreaterThan(0);
  expect(heat.height).toBeGreaterThan(0);
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
      const layers: LayerName[] = [
        "heatmap",
        "altitude",
        "airspeed",
        "airports",
      ];
      for (const layer of layers) await toggleLayer(page, layer);
      for (const layer of layers) await toggleLayer(page, layer);

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

      await togglePathSelection(page, pathId, 0);

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
      const modal = await openWrapped(page);

      await modal.locator(".close-btn").click();
      await expect(modal).toBeHidden();

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

      await expectHeatmapPainted(page);
      expectClean(errors);
    });

    test("zooming out updates heatmap without errors", async ({ page }) => {
      const zoom = await page.evaluate(() => window.mapApp!.map!.getZoom());
      await setZoom(page, Math.max(1, zoom - 3));

      await expectHeatmapPainted(page);
      expectClean(errors);
    });

    test("zooming preserves altitude path colors", async ({ page }) => {
      await waitForPathData(page);

      const before = await layerColors(page, "altitudeLayer");
      expectColorRamp(before);

      const zoom = await page.evaluate(() => window.mapApp!.map!.getZoom());
      await setZoom(page, zoom + 2);

      expect(await page.evaluate(() => window.mapApp!.altitudeVisible)).toBe(
        true,
      );
      // Zooming must redraw the same runs in the same colours
      expect(await layerColors(page, "altitudeLayer")).toEqual(before);
      expectClean(errors);
    });

    test("zooming preserves airspeed path colors", async ({ page }) => {
      await toggleLayer(page, "airspeed");
      await page.waitForFunction(
        () => window.mapApp!.airspeedLayer.getLayers().length > 0,
      );

      const before = await layerColors(page, "airspeedLayer");
      expectColorRamp(before);

      const zoom = await page.evaluate(() => window.mapApp!.map!.getZoom());
      await setZoom(page, zoom + 2);

      expect(await page.evaluate(() => window.mapApp!.airspeedVisible)).toBe(
        true,
      );
      expect(await layerColors(page, "airspeedLayer")).toEqual(before);
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
