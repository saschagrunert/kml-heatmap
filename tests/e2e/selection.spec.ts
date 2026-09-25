import { test, expect, type Page } from "./fixtures";
import {
  findSegmentFarFromAirports,
  firstPathId,
  gotoApp,
  readSavedState,
  selectionParams,
  selectPathForReplay,
  toggleLayer,
  togglePathSelection,
  waitForAppReady,
  waitForPathData,
} from "./helpers";
import {
  PATH_POLL,
  airportMarkerCenter,
  centerOnAirport,
  focusAirportMarker,
  heatmapOnMap,
  heatmapOpacity,
  pathCount,
  pathWeights,
  segmentDetails,
  selectionHighlightOnMap,
  setZoom,
} from "./map";

/** Select a path and return the isolate button locator */
async function selectPathAndGetIsolateBtn(page: Page) {
  const pathId = await firstPathId(page);
  await togglePathSelection(page, pathId, 1);
  return { pathId, isolateBtn: page.locator("#isolate-btn") };
}

function selectedCount(page: Page): Promise<number> {
  return page.evaluate(() => window.mapApp!.selectedPathIds.size);
}

/** The first airport the app files paths under, with those paths */
function firstAirportWithPaths(
  page: Page,
): Promise<{ name: string; pathIds: number[] } | null> {
  return page.evaluate(() => {
    const app = window.mapApp!;
    const name = Object.keys(app.airportToPaths)[0];
    if (!name || !app.airportMarkers[name]) return null;
    return {
      name,
      pathIds: [...app.airportToPaths[name]!].sort((a, b) => a - b),
    };
  });
}

test.describe("Path Selection", () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
  });

  test("selecting a path updates selectedPathIds", async ({ page }) => {
    const pathId = await firstPathId(page);
    await togglePathSelection(page, pathId, 1);

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
    const pathId = await firstPathId(page);
    await togglePathSelection(page, pathId, 1);
    await togglePathSelection(page, pathId, 0);

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

    for (const [index, id] of pathIds.entries()) {
      await togglePathSelection(page, id, index + 1);
    }

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

    await togglePathSelection(page, pathId, 0);

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
    await setZoom(page, 3);

    const mapBox = (await page.locator("#map").boundingBox())!;
    await page.mouse.click(mapBox.x + 10, mapBox.y + mapBox.height - 10);

    await page.waitForFunction(
      () => window.mapApp!.selectedPathIds.size === 0,
      { timeout: 5000 },
    );
  });

  test("clicking airport marker selects associated paths", async ({ page }) => {
    await waitForPathData(page);

    // Pick an airport, centre the map on its marker and note which paths
    // the app files under it, so the click can be checked against them
    const airport = await firstAirportWithPaths(page);
    expect(airport).not.toBeNull();
    expect(airport!.pathIds.length).toBeGreaterThan(0);
    await centerOnAirport(page, airport!.name, 12);

    const marker = await airportMarkerCenter(page, airport!.name);
    await page.mouse.click(marker.x, marker.y);

    await expect
      .poll(() =>
        page.evaluate(() =>
          [...window.mapApp!.selectedPathIds].sort((a, b) => a - b),
        ),
      )
      .toEqual(airport!.pathIds);
  });

  test("an airport's flights are drawn over the dimmed heatmap until a colour layer does", async ({
    page,
  }) => {
    // Heatmap and airports only, as the page opens
    await page.waitForFunction(
      () => (window.mapApp?.fullPathInfo?.length ?? 0) > 0,
      { timeout: 15000 },
    );
    expect(await heatmapOnMap(page)).toBe(true);
    expect(await selectionHighlightOnMap(page)).toEqual({
      shown: false,
      lines: 0,
    });
    expect(await heatmapOpacity(page)).toBe(1);

    const airport = await firstAirportWithPaths(page);
    expect(airport).not.toBeNull();
    await centerOnAirport(page, airport!.name, 12);
    const marker = await airportMarkerCenter(page, airport!.name);
    await page.mouse.click(marker.x, marker.y);
    await expect.poll(() => selectedCount(page)).toBe(airport!.pathIds.length);

    await expect
      .poll(async () => (await selectionHighlightOnMap(page)).shown)
      .toBe(true);
    expect((await selectionHighlightOnMap(page)).lines).toBeGreaterThanOrEqual(
      airport!.pathIds.length,
    );
    await expect.poll(() => heatmapOpacity(page)).toBeLessThan(1);

    // The colour layer draws the selection itself
    await toggleLayer(page, "altitude");
    await expect
      .poll(async () => (await selectionHighlightOnMap(page)).shown)
      .toBe(false);

    // Back without it, and with the selection cleared the heatmap is whole
    await toggleLayer(page, "altitude");
    await expect
      .poll(async () => (await selectionHighlightOnMap(page)).shown)
      .toBe(true);
    await page.locator("#selection-clear-btn").click();
    await expect
      .poll(() => selectionHighlightOnMap(page))
      .toEqual({
        shown: false,
        lines: 0,
      });
    await expect.poll(() => heatmapOpacity(page)).toBe(1);
  });

  test("Enter on a focused airport marker selects its paths", async ({
    page,
  }) => {
    await waitForPathData(page);

    const airport = await firstAirportWithPaths(page);
    expect(airport).not.toBeNull();
    expect(airport!.pathIds.length).toBeGreaterThan(0);
    await centerOnAirport(page, airport!.name, 12);
    await focusAirportMarker(page, airport!.name);

    // Leaflet reports Enter as keypress, not click: the popup opened but
    // nothing was selected
    await page.keyboard.press("Enter");

    await expect
      .poll(() =>
        page.evaluate(() =>
          [...window.mapApp!.selectedPathIds].sort((a, b) => a - b),
        ),
      )
      .toEqual(airport!.pathIds);
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
    const details = segmentDetails(page).first();
    await expect(details).toBeVisible({ timeout: 5000 });
    await expect(details).toContainText(/Altitude/);
    await expect(details).toContainText(/ft/);
    // The colour reaches the metric through the CSSOM, since the CSP
    // blocks the style attribute it used to be written in
    const colored = details.locator(".kh-popup-metric-colored").first();
    await expect
      .poll(() =>
        colored.evaluate((el) =>
          (el as HTMLElement).style.getPropertyValue("--kh-metric-color"),
        ),
      )
      .toMatch(/^rgb/);
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
    // Scoped to the View group: isolate belongs with the other controls
    // that change what the map shows, not with the layers
    const isolateBtn = page.locator(
      '#left-buttons .control-group[aria-labelledby="view-group-title"] #isolate-btn',
    );
    await expect(isolateBtn).toBeVisible();
    await expect(isolateBtn).toHaveCSS("opacity", "0.5");
    await expect(isolateBtn).toHaveAttribute("title", "Isolate selected paths");
    await expect(isolateBtn.locator("svg.icon")).toHaveCount(1);
    await expect(isolateBtn.locator(".control-label")).toHaveText("Isolate");
  });

  test("solo button becomes active when a path is selected", async ({
    page,
  }) => {
    const { isolateBtn } = await selectPathAndGetIsolateBtn(page);
    await expect(isolateBtn).toBeVisible();
    await expect(isolateBtn).toHaveCSS("opacity", "1");
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

    await togglePathSelection(page, pathId, 0);

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
    const pathId = await firstPathId(page);

    // 9th flag is isolateSelection
    await gotoApp(page, `/?v=100100001&${selectionParams(pathId)}`);

    expect(await page.evaluate(() => window.mapApp!.isolateSelection)).toBe(
      true,
    );
    await expect(page.locator("#isolate-btn")).toBeVisible();
    await expect(page.locator("#isolate-btn")).toHaveCSS("opacity", "1");
  });

  test("selected paths use normal weight in solo mode", async ({ page }) => {
    const { isolateBtn } = await selectPathAndGetIsolateBtn(page);

    // Before solo: the selected path is drawn with weight 6
    expect(await pathWeights(page, "altitude")).toContain(6);

    await isolateBtn.click();
    await expect
      .poll(() => page.evaluate(() => window.mapApp!.isolateSelection))
      .toBe(true);

    // In solo: only the selected path is visible with the normal weight
    await expect
      .poll(() => pathWeights(page, "altitude"), PATH_POLL)
      .not.toContain(6);
    const weightsInSolo = await pathWeights(page, "altitude");
    expect(weightsInSolo.length).toBeGreaterThan(0);
    for (const w of weightsInSolo) {
      expect(w).toBe(4);
    }

    await isolateBtn.click();
    await expect
      .poll(() => page.evaluate(() => window.mapApp!.isolateSelection))
      .toBe(false);

    await expect
      .poll(() => pathWeights(page, "altitude"), PATH_POLL)
      .toContain(6);
  });

  test("solo mode hides unselected paths from altitude layer", async ({
    page,
  }) => {
    const { isolateBtn } = await selectPathAndGetIsolateBtn(page);

    const totalBefore = await pathCount(page, "altitude");

    await isolateBtn.click();
    await expect
      .poll(() => page.evaluate(() => window.mapApp!.isolateSelection))
      .toBe(true);

    await expect
      .poll(() => pathCount(page, "altitude"), PATH_POLL)
      .toBeLessThan(totalBefore);
    expect(await pathCount(page, "altitude")).toBeGreaterThan(0);
  });
});
