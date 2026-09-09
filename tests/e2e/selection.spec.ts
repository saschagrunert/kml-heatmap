import { test, expect, type Page } from "@playwright/test";
import {
  findSegmentFarFromAirports,
  gotoApp,
  readSavedState,
  selectPathForReplay,
  waitForAppReady,
  waitForPathData,
} from "./helpers";

/** Select a path and return the isolate button locator */
async function selectPathAndGetIsolateBtn(page: Page) {
  await waitForPathData(page);
  const pathId = await page.evaluate(() => window.mapApp!.fullPathInfo![0]!.id);
  await page.evaluate(
    (id) => window.mapApp!.togglePathSelection(String(id)),
    pathId,
  );
  await page.waitForFunction(() => window.mapApp!.selectedPathIds.size === 1, {
    timeout: 5000,
  });
  return { pathId, isolateBtn: page.locator("#isolate-btn") };
}

function selectedCount(page: Page): Promise<number> {
  return page.evaluate(() => window.mapApp!.selectedPathIds.size);
}

function altitudeLayerCount(page: Page): Promise<number> {
  return page.evaluate(() => window.mapApp!.altitudeLayer.getLayers().length);
}

function altitudeWeights(page: Page): Promise<number[]> {
  return page.evaluate(() =>
    window
      .mapApp!.altitudeLayer.getLayers()
      .map((layer) => (layer as L.Polyline).options.weight ?? 0),
  );
}

test.describe("Path Selection", () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
  });

  test("selecting a path updates selectedPathIds", async ({ page }) => {
    await waitForPathData(page);

    const pathId = await page.evaluate(
      () => window.mapApp!.fullPathInfo![0]!.id,
    );
    await page.evaluate(
      (id) => window.mapApp!.togglePathSelection(String(id)),
      pathId,
    );

    const hasPath = await page.evaluate(
      (id) => window.mapApp!.selectedPathIds.has(id),
      pathId,
    );
    expect(hasPath).toBe(true);
    expect(await selectedCount(page)).toBe(1);
  });

  test("deselecting a path removes it from selectedPathIds", async ({
    page,
  }) => {
    await waitForPathData(page);

    const pathId = await page.evaluate(
      () => window.mapApp!.fullPathInfo![0]!.id,
    );

    await page.evaluate(
      (id) => window.mapApp!.togglePathSelection(String(id)),
      pathId,
    );
    await page.waitForFunction(() => window.mapApp!.selectedPathIds.size === 1);

    await page.evaluate(
      (id) => window.mapApp!.togglePathSelection(String(id)),
      pathId,
    );

    expect(await selectedCount(page)).toBe(0);
  });

  test("selecting a path marks the replay button available", async ({
    page,
  }) => {
    const replayBtn = page.locator("#replay-btn");
    await expect(replayBtn).toHaveAttribute(
      "title",
      "Select exactly one flight with timing data to replay",
    );

    await selectPathForReplay(page);

    await expect(replayBtn).toBeEnabled();
    await expect(replayBtn).toHaveAttribute(
      "title",
      "Replay selected flight path",
    );
    await expect(replayBtn).toHaveCSS("opacity", "1");
  });

  test("selecting multiple paths marks the replay button unavailable", async ({
    page,
  }) => {
    await waitForPathData(page);

    const pathIds = await page.evaluate(() =>
      window.mapApp!.fullPathInfo!.slice(0, 2).map((p) => p.id),
    );
    expect(pathIds).toHaveLength(2);

    for (const id of pathIds) {
      await page.evaluate(
        (pid) => window.mapApp!.togglePathSelection(String(pid)),
        id,
      );
    }

    await page.waitForFunction(() => window.mapApp!.selectedPathIds.size === 2);
    await expect(page.locator("#replay-btn")).toHaveAttribute(
      "title",
      "Select exactly one flight with timing data to replay",
    );
    await expect(page.locator("#replay-btn")).toHaveCSS("opacity", "0.5");
  });

  test("deselecting all paths marks the replay button unavailable", async ({
    page,
  }) => {
    const pathId = await selectPathForReplay(page);
    await expect(page.locator("#replay-btn")).toHaveAttribute(
      "title",
      "Replay selected flight path",
    );

    await page.evaluate(
      (id) => window.mapApp!.togglePathSelection(String(id)),
      pathId,
    );
    await page.waitForFunction(() => window.mapApp!.selectedPathIds.size === 0);

    await expect(page.locator("#replay-btn")).toHaveAttribute(
      "title",
      "Select exactly one flight with timing data to replay",
    );
  });

  test("clicking a path on the map selects it", async ({ page }) => {
    await waitForPathData(page);

    const pos = await findSegmentFarFromAirports(page, {
      includePathId: true,
    });
    expect(pos).not.toBeNull();

    await page.locator("#map").click({
      position: { x: pos!.x, y: pos!.y },
    });
    await page.waitForFunction(
      () => window.mapApp!.selectedPathIds.size === 1,
      { timeout: 5000 },
    );

    const hasPath = await page.evaluate(
      (id) => window.mapApp!.selectedPathIds.has(id!),
      pos!.pathId,
    );
    expect(hasPath).toBe(true);
  });

  test("clicking empty map area clears path selection", async ({ page }) => {
    await selectPathForReplay(page);
    expect(await selectedCount(page)).toBe(1);

    // Zoom out so the bottom-left corner of the map shows open sea
    await page.evaluate(() => {
      window.mapApp!.map!.setZoom(3, { animate: false });
    });
    await expect
      .poll(() => page.evaluate(() => window.mapApp!.map!.getZoom()))
      .toBe(3);

    const mapBox = (await page.locator("#map").boundingBox())!;
    await page.mouse.click(mapBox.x + 10, mapBox.y + mapBox.height - 10);

    await page.waitForFunction(
      () => window.mapApp!.selectedPathIds.size === 0,
      { timeout: 5000 },
    );
  });

  test("clicking airport marker selects associated paths", async ({ page }) => {
    await waitForPathData(page);

    const airportInfo = await page.evaluate(() => {
      const app = window.mapApp!;
      const airportNames = Object.keys(app.airportToPaths);
      const name = airportNames[0];
      if (!name) return null;
      return { name, pathCount: app.airportToPaths[name]!.size };
    });
    expect(airportInfo).not.toBeNull();
    expect(airportInfo!.pathCount).toBeGreaterThan(0);

    await page.locator(".airport-marker").first().click();

    await page.waitForFunction(() => window.mapApp!.selectedPathIds.size > 0, {
      timeout: 5000,
    });
  });

  test("clicking a path shows its altitude data and selects it", async ({
    page,
  }) => {
    await waitForPathData(page);

    const pos = await findSegmentFarFromAirports(page);
    expect(pos).not.toBeNull();

    await page.locator("#map").click({
      position: { x: pos!.x, y: pos!.y },
    });

    // Pointer devices get a sticky tooltip, touch devices a popup
    const details = page
      .locator(".segment-tooltip, .leaflet-popup-content")
      .first();
    await expect(details).toBeVisible({ timeout: 5000 });
    await expect(details).toContainText(/Altitude/);
    await expect(details).toContainText(/ft/);
    await page.waitForFunction(
      () => window.mapApp!.selectedPathIds.size === 1,
      { timeout: 5000 },
    );
  });
});

test.describe("Solo Mode", () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
  });

  test("solo button is always visible but dimmed when no paths are selected", async ({
    page,
  }) => {
    const isolateBtn = page.locator("#isolate-btn");
    await expect(isolateBtn).toBeVisible();
    await expect(isolateBtn).toHaveCSS("opacity", "0.5");
    await expect(isolateBtn).toHaveAttribute("title", "Isolate selected paths");
  });

  test("solo button becomes active when a path is selected", async ({
    page,
  }) => {
    const { isolateBtn } = await selectPathAndGetIsolateBtn(page);
    await expect(isolateBtn).toBeVisible();
    await expect(isolateBtn).toHaveCSS("opacity", "1");
  });

  test("solo button is hidden by hide buttons toggle", async ({ page }) => {
    await page.locator("#hide-buttons-btn").click();
    await expect(page.locator("#isolate-btn")).toHaveCSS(
      "visibility",
      "hidden",
    );
    await expect(page.locator("#isolate-btn")).toHaveCSS(
      "pointer-events",
      "none",
    );
  });

  test("clicking solo button activates isolate mode", async ({ page }) => {
    const { isolateBtn } = await selectPathAndGetIsolateBtn(page);

    await isolateBtn.click();

    await expect(isolateBtn).toHaveCSS("opacity", "1");
    await expect
      .poll(() => page.evaluate(() => window.mapApp!.isolateSelection))
      .toBe(true);
  });

  test("clicking solo button again deactivates isolate mode", async ({
    page,
  }) => {
    const { isolateBtn } = await selectPathAndGetIsolateBtn(page);

    await isolateBtn.click();
    await expect
      .poll(() => page.evaluate(() => window.mapApp!.isolateSelection))
      .toBe(true);

    await isolateBtn.click();
    await expect(isolateBtn).toHaveCSS("opacity", "1");
    await expect
      .poll(() => page.evaluate(() => window.mapApp!.isolateSelection))
      .toBe(false);
  });

  test("clearing selection disables isolate mode", async ({ page }) => {
    const { pathId, isolateBtn } = await selectPathAndGetIsolateBtn(page);

    await isolateBtn.click();
    await expect
      .poll(() => page.evaluate(() => window.mapApp!.isolateSelection))
      .toBe(true);

    await page.evaluate(
      (id) => window.mapApp!.togglePathSelection(String(id)),
      pathId,
    );
    await page.waitForFunction(
      () => window.mapApp!.selectedPathIds.size === 0,
      { timeout: 5000 },
    );

    expect(await page.evaluate(() => window.mapApp!.isolateSelection)).toBe(
      false,
    );
    await expect(isolateBtn).toHaveCSS("opacity", "0.5");
  });

  test("isolate mode persists in localStorage", async ({ page }) => {
    const { isolateBtn } = await selectPathAndGetIsolateBtn(page);
    await isolateBtn.click();

    await expect
      .poll(async () => (await readSavedState(page))["isolateSelection"])
      .toBe(true);

    await page.reload();
    await waitForAppReady(page);

    expect(await page.evaluate(() => window.mapApp!.isolateSelection)).toBe(
      true,
    );
  });

  test("isolate mode via URL parameter", async ({ page }) => {
    await waitForPathData(page);
    const pathId = await page.evaluate(
      () => window.mapApp!.fullPathInfo![0]!.id,
    );

    // 9th flag is isolateSelection
    await gotoApp(page, `/?v=100100001&p=${pathId}&sv=2`);

    expect(await page.evaluate(() => window.mapApp!.isolateSelection)).toBe(
      true,
    );
    await expect(page.locator("#isolate-btn")).toBeVisible();
    await expect(page.locator("#isolate-btn")).toHaveCSS("opacity", "1");
  });

  test("hide button does not hide unselected paths", async ({ page }) => {
    await waitForPathData(page);

    const pathId = await page.evaluate(
      () => window.mapApp!.fullPathInfo![0]!.id,
    );
    await page.evaluate(
      (id) => window.mapApp!.togglePathSelection(String(id)),
      pathId,
    );
    await page.waitForFunction(
      () => window.mapApp!.selectedPathIds.size === 1,
      { timeout: 5000 },
    );
    // Consecutive segments with equal colour are merged into one polyline,
    // so compare the rendered count before and after instead of per segment
    const layersBefore = await altitudeLayerCount(page);
    expect(layersBefore).toBeGreaterThan(1);

    await page.locator("#hide-buttons-btn").click();
    await expect(page.locator("#hide-buttons-btn")).toHaveText("🔽");

    expect(await page.evaluate(() => window.mapApp!.isolateSelection)).toBe(
      false,
    );
    expect(await altitudeLayerCount(page)).toBe(layersBefore);
  });

  test("selected paths use normal weight in solo mode", async ({ page }) => {
    const { isolateBtn } = await selectPathAndGetIsolateBtn(page);

    // Before solo: the selected path is drawn with weight 6
    expect(await altitudeWeights(page)).toContain(6);

    await isolateBtn.click();
    await expect
      .poll(() => page.evaluate(() => window.mapApp!.isolateSelection))
      .toBe(true);

    // In solo: only the selected path is visible with the normal weight
    await expect.poll(() => altitudeWeights(page)).not.toContain(6);
    const weightsInSolo = await altitudeWeights(page);
    expect(weightsInSolo.length).toBeGreaterThan(0);
    for (const w of weightsInSolo) {
      expect(w).toBe(4);
    }

    await isolateBtn.click();
    await expect
      .poll(() => page.evaluate(() => window.mapApp!.isolateSelection))
      .toBe(false);

    await expect.poll(() => altitudeWeights(page)).toContain(6);
  });

  test("solo mode hides unselected paths from altitude layer", async ({
    page,
  }) => {
    const { isolateBtn } = await selectPathAndGetIsolateBtn(page);

    const totalBefore = await altitudeLayerCount(page);

    await isolateBtn.click();
    await expect
      .poll(() => page.evaluate(() => window.mapApp!.isolateSelection))
      .toBe(true);

    await expect.poll(() => altitudeLayerCount(page)).toBeLessThan(totalBefore);
    expect(await altitudeLayerCount(page)).toBeGreaterThan(0);
  });
});
