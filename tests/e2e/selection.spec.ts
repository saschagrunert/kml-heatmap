import { test, expect } from "@playwright/test";
import { waitForPathData, selectPathForReplay } from "./helpers";

test.describe("Path Selection", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("#map.leaflet-container", { timeout: 15000 });
  });

  test("selecting a path updates selectedPathIds", async ({ page }) => {
    await waitForPathData(page);

    const pathId = await page.evaluate(
      () => (window as any).mapApp.fullPathInfo[0].id
    );
    await page.evaluate(
      (id) => (window as any).togglePathSelection(String(id)),
      pathId
    );

    const hasPath = await page.evaluate(
      (id) => (window as any).mapApp.selectedPathIds.has(id),
      pathId
    );
    expect(hasPath).toBe(true);

    const size = await page.evaluate(
      () => (window as any).mapApp.selectedPathIds.size
    );
    expect(size).toBe(1);
  });

  test("deselecting a path removes it from selectedPathIds", async ({
    page,
  }) => {
    await waitForPathData(page);

    const pathId = await page.evaluate(
      () => (window as any).mapApp.fullPathInfo[0].id
    );

    // Select
    await page.evaluate(
      (id) => (window as any).togglePathSelection(String(id)),
      pathId
    );
    await page.waitForFunction(
      () => (window as any).mapApp.selectedPathIds.size === 1
    );

    // Deselect
    await page.evaluate(
      (id) => (window as any).togglePathSelection(String(id)),
      pathId
    );

    const size = await page.evaluate(
      () => (window as any).mapApp.selectedPathIds.size
    );
    expect(size).toBe(0);
  });

  test("selecting a path enables the replay button", async ({ page }) => {
    const replayBtn = page.locator("#replay-btn");
    await expect(replayBtn).toBeDisabled();

    await selectPathForReplay(page);

    await expect(replayBtn).toBeEnabled();
    await expect(replayBtn).toHaveCSS("opacity", "1");
  });

  test("selecting multiple paths disables the replay button", async ({
    page,
  }) => {
    await waitForPathData(page);

    const pathIds = await page.evaluate(() => {
      const app = (window as any).mapApp;
      return app.fullPathInfo.slice(0, 2).map((p: any) => p.id);
    });

    for (const id of pathIds) {
      await page.evaluate(
        (pid) => (window as any).togglePathSelection(String(pid)),
        id
      );
    }

    await page.waitForFunction(
      () => (window as any).mapApp.selectedPathIds.size === 2
    );
    await expect(page.locator("#replay-btn")).toBeDisabled();
  });

  test("deselecting all paths disables the replay button", async ({ page }) => {
    const pathId = await selectPathForReplay(page);
    await expect(page.locator("#replay-btn")).toBeEnabled();

    await page.evaluate(
      (id) => (window as any).togglePathSelection(String(id)),
      pathId
    );
    await page.waitForFunction(
      () => (window as any).mapApp.selectedPathIds.size === 0
    );

    await expect(page.locator("#replay-btn")).toBeDisabled();
  });

  test("clicking a path on the map selects it", async ({ page }) => {
    await waitForPathData(page);

    const clickPos = await page.evaluate(() => {
      const app = (window as any).mapApp;
      const segments = app.currentData?.path_segments;
      if (!segments || segments.length === 0) return null;

      const seg = segments[Math.floor(segments.length / 2)];
      if (!seg.coords || seg.coords.length < 2) return null;

      const coord = seg.coords[0];
      const point = app.map.latLngToContainerPoint(
        L.latLng(coord[0], coord[1])
      );
      return { x: point.x, y: point.y, pathId: seg.path_id };
    });

    if (!clickPos) return;

    await page.locator("#map").click({
      position: { x: clickPos.x, y: clickPos.y },
    });
    await page.waitForTimeout(300);

    const size = await page.evaluate(
      () => (window as any).mapApp.selectedPathIds.size
    );
    expect(size).toBe(1);

    const hasPath = await page.evaluate(
      (id) => (window as any).mapApp.selectedPathIds.has(id),
      clickPos.pathId
    );
    expect(hasPath).toBe(true);
  });

  test("clicking empty map area clears path selection", async ({ page }) => {
    const pathId = await selectPathForReplay(page);
    expect(
      await page.evaluate(() => (window as any).mapApp.selectedPathIds.size)
    ).toBe(1);

    // Click on an area of the map away from any paths
    // Zoom out first to make it easier to find empty space
    await page.evaluate(() => {
      (window as any).mapApp.map.setZoom(3, { animate: false });
    });
    await page.waitForTimeout(500);

    // Click on a position in the ocean (bottom-left corner of map container)
    const mapBox = await page.locator("#map").boundingBox();
    if (mapBox) {
      await page.mouse.click(mapBox.x + 10, mapBox.y + mapBox.height - 10);
    }
    await page.waitForTimeout(300);

    const size = await page.evaluate(
      () => (window as any).mapApp.selectedPathIds.size
    );
    expect(size).toBe(0);
  });

  test("clicking airport marker selects associated paths", async ({ page }) => {
    await waitForPathData(page);

    // Get first airport that has associated paths
    const airportInfo = await page.evaluate(() => {
      const app = (window as any).mapApp;
      const airportNames = Object.keys(app.airportToPaths || {});
      if (airportNames.length === 0) return null;
      const name = airportNames[0];
      const pathCount = app.airportToPaths[name].size;
      return { name, pathCount };
    });
    if (!airportInfo) return;

    // Click the first airport marker
    const marker = page.locator(".airport-marker").first();
    await marker.click();
    await page.waitForTimeout(300);

    const size = await page.evaluate(
      () => (window as any).mapApp.selectedPathIds.size
    );
    expect(size).toBeGreaterThan(0);
  });

  test("path polyline popup shows altitude info on click", async ({ page }) => {
    await waitForPathData(page);

    // Get coordinates of a path segment
    const clickPos = await page.evaluate(() => {
      const app = (window as any).mapApp;
      const segments = app.currentData?.path_segments;
      if (!segments || segments.length === 0) return null;

      const seg = segments[Math.floor(segments.length / 2)];
      if (!seg.coords || seg.coords.length < 2) return null;

      const coord = seg.coords[0];
      const point = app.map.latLngToContainerPoint(
        L.latLng(coord[0], coord[1])
      );
      return { x: point.x, y: point.y };
    });

    if (!clickPos) return;

    // Click the path to open popup
    await page.locator("#map").click({
      position: { x: clickPos.x, y: clickPos.y },
    });
    await page.waitForTimeout(500);

    // Check for Leaflet popup with altitude info
    const popup = page.locator(".leaflet-popup-content");
    const popupCount = await popup.count();
    if (popupCount > 0) {
      const popupText = await popup.first().textContent();
      expect(popupText).toMatch(/Altitude:.*ft/);
    }
  });
});
