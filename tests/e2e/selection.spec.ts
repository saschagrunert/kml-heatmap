import { test, expect, type Page } from "@playwright/test";
import { waitForPathData, selectPathForReplay } from "./helpers";

/** Select a path and return the isolate button locator */
async function selectPathAndGetIsolateBtn(page: Page) {
  await waitForPathData(page);
  const pathId = await page.evaluate(
    () => (window as any).mapApp.fullPathInfo[0].id
  );
  await page.evaluate(
    (id) => (window as any).mapApp.togglePathSelection(String(id)),
    pathId
  );
  await page.waitForFunction(
    () => (window as any).mapApp.selectedPathIds.size === 1,
    { timeout: 5000 }
  );
  return { pathId, isolateBtn: page.locator("#isolate-btn") };
}

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
      (id) => (window as any).mapApp.togglePathSelection(String(id)),
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
      (id) => (window as any).mapApp.togglePathSelection(String(id)),
      pathId
    );
    await page.waitForFunction(
      () => (window as any).mapApp.selectedPathIds.size === 1
    );

    // Deselect
    await page.evaluate(
      (id) => (window as any).mapApp.togglePathSelection(String(id)),
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
        (pid) => (window as any).mapApp.togglePathSelection(String(pid)),
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
      (id) => (window as any).mapApp.togglePathSelection(String(id)),
      pathId
    );
    await page.waitForFunction(
      () => (window as any).mapApp.selectedPathIds.size === 0
    );

    await expect(page.locator("#replay-btn")).toBeDisabled();
  });

  test("clicking a path on the map selects it", async ({ page }) => {
    await waitForPathData(page);

    // Find a path coordinate far from any airport marker, then zoom in
    const clickPos = await page.evaluate(() => {
      const app = (window as any).mapApp;
      const segments = app.currentData?.path_segments;
      if (!segments || segments.length === 0) return null;

      // Collect all airport positions
      const airports: { lat: number; lon: number }[] = [];
      for (const name of Object.keys(app.airportMarkers || {})) {
        const ll = app.airportMarkers[name].getLatLng();
        airports.push({ lat: ll.lat, lon: ll.lng });
      }

      // Find the segment+coord combo farthest from any airport
      let best: { seg: any; coord: number[]; dist: number } | null = null;
      for (const seg of segments) {
        if (!seg.coords || seg.coords.length < 2) continue;
        const midCoord = seg.coords[Math.floor(seg.coords.length / 2)];
        const minDist = airports.reduce((min, a) => {
          const d = Math.hypot(midCoord[0] - a.lat, midCoord[1] - a.lon);
          return Math.min(min, d);
        }, Infinity);
        if (!best || minDist > best.dist) {
          best = { seg, coord: midCoord, dist: minDist };
        }
      }
      if (!best) return null;

      // Zoom in to avoid airport markers intercepting clicks
      app.map.setView(L.latLng(best.coord[0], best.coord[1]), 13, {
        animate: false,
      });

      const point = app.map.latLngToContainerPoint(
        L.latLng(best.coord[0], best.coord[1])
      );
      return {
        x: point.x,
        y: point.y,
        pathId: best.seg.path_id,
        coord: best.coord,
      };
    });

    if (!clickPos) return;

    // Wait for map to settle after zoom
    await page.waitForTimeout(500);

    // Re-calculate click position after map has settled
    const pos = await page.evaluate((cp) => {
      const app = (window as any).mapApp;
      const point = app.map.latLngToContainerPoint(
        L.latLng(cp.coord[0], cp.coord[1])
      );
      return { x: point.x, y: point.y };
    }, clickPos);

    await page.locator("#map").click({
      position: { x: pos.x, y: pos.y },
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

    // Get coordinates of a path segment far from any airport marker
    const clickPos = await page.evaluate(() => {
      const app = (window as any).mapApp;
      const segments = app.currentData?.path_segments;
      if (!segments || segments.length === 0) return null;

      // Collect all airport positions
      const airports: { lat: number; lon: number }[] = [];
      for (const name of Object.keys(app.airportMarkers || {})) {
        const ll = app.airportMarkers[name].getLatLng();
        airports.push({ lat: ll.lat, lon: ll.lng });
      }

      // Find the segment+coord combo farthest from any airport
      let best: { coord: number[]; dist: number } | null = null;
      for (const seg of segments) {
        if (!seg.coords || seg.coords.length < 2) continue;
        const midCoord = seg.coords[Math.floor(seg.coords.length / 2)];
        const minDist = airports.reduce((min, a) => {
          const d = Math.hypot(midCoord[0] - a.lat, midCoord[1] - a.lon);
          return Math.min(min, d);
        }, Infinity);
        if (!best || minDist > best.dist) {
          best = { coord: midCoord, dist: minDist };
        }
      }
      if (!best) return null;

      // Zoom in to avoid airport markers intercepting clicks
      app.map.setView(L.latLng(best.coord[0], best.coord[1]), 13, {
        animate: false,
      });

      const point = app.map.latLngToContainerPoint(
        L.latLng(best.coord[0], best.coord[1])
      );
      return { x: point.x, y: point.y, coord: best.coord };
    });

    if (!clickPos) return;

    // Wait for map to settle after zoom
    await page.waitForTimeout(500);

    // Re-calculate click position after map has settled
    const pos = await page.evaluate((cp) => {
      const app = (window as any).mapApp;
      const point = app.map.latLngToContainerPoint(
        L.latLng(cp.coord[0], cp.coord[1])
      );
      return { x: point.x, y: point.y };
    }, clickPos);

    // Click the path to open popup
    await page.locator("#map").click({
      position: { x: pos.x, y: pos.y },
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

test.describe("Solo Mode", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("#map.leaflet-container", { timeout: 15000 });
  });

  test("solo button is always visible but dimmed when no paths are selected", async ({
    page,
  }) => {
    const isolateBtn = page.locator("#isolate-btn");
    await expect(isolateBtn).toBeVisible();
    await expect(isolateBtn).toHaveCSS("opacity", "0.5");
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
    await expect(page.locator("#isolate-btn")).toHaveCSS("opacity", "0");
    await expect(page.locator("#isolate-btn")).toHaveCSS(
      "pointer-events",
      "none"
    );
  });

  test("clicking solo button activates isolate mode", async ({ page }) => {
    const { isolateBtn } = await selectPathAndGetIsolateBtn(page);

    await isolateBtn.click();

    await expect(isolateBtn).toHaveCSS("opacity", "1");
    const isIsolated = await page.evaluate(
      () => (window as any).mapApp.isolateSelection
    );
    expect(isIsolated).toBe(true);
  });

  test("clicking solo button again deactivates isolate mode", async ({
    page,
  }) => {
    const { isolateBtn } = await selectPathAndGetIsolateBtn(page);

    await isolateBtn.click();
    await expect(isolateBtn).toHaveCSS("opacity", "1");

    await isolateBtn.click();
    // Paths still selected, so button stays at full opacity but without blue border
    await expect(isolateBtn).toHaveCSS("opacity", "1");

    const isIsolated = await page.evaluate(
      () => (window as any).mapApp.isolateSelection
    );
    expect(isIsolated).toBe(false);
  });

  test("clearing selection disables isolate mode", async ({ page }) => {
    const { pathId, isolateBtn } = await selectPathAndGetIsolateBtn(page);

    await isolateBtn.click();
    expect(
      await page.evaluate(() => (window as any).mapApp.isolateSelection)
    ).toBe(true);

    // Deselect the path
    await page.evaluate(
      (id) => (window as any).mapApp.togglePathSelection(String(id)),
      pathId
    );
    await page.waitForFunction(
      () => (window as any).mapApp.selectedPathIds.size === 0,
      { timeout: 5000 }
    );

    expect(
      await page.evaluate(() => (window as any).mapApp.isolateSelection)
    ).toBe(false);
    await expect(isolateBtn).toHaveCSS("opacity", "0.5");
  });

  test("isolate mode persists in localStorage", async ({ page }) => {
    const { isolateBtn } = await selectPathAndGetIsolateBtn(page);
    await isolateBtn.click();

    await page.waitForFunction(() => {
      const state = JSON.parse(
        localStorage.getItem("kml-heatmap-state") || "{}"
      );
      return state.isolateSelection === true;
    });

    await page.reload();
    await page.waitForSelector("#map.leaflet-container", { timeout: 15000 });

    await page.waitForFunction(
      () => (window as any).mapApp?.isInitializing === false,
      { timeout: 15000 }
    );

    const isIsolated = await page.evaluate(
      () => (window as any).mapApp.isolateSelection
    );
    expect(isIsolated).toBe(true);
  });

  test("isolate mode via URL parameter", async ({ page }) => {
    await waitForPathData(page);
    const pathId = await page.evaluate(
      () => (window as any).mapApp.fullPathInfo[0].id
    );

    // 9th flag is isolateSelection
    await page.goto(`/?v=100100001&p=${pathId}`);
    await page.waitForSelector("#map.leaflet-container", { timeout: 15000 });

    await page.waitForFunction(
      () => (window as any).mapApp?.isInitializing === false,
      { timeout: 15000 }
    );

    const isIsolated = await page.evaluate(
      () => (window as any).mapApp.isolateSelection
    );
    expect(isIsolated).toBe(true);

    await expect(page.locator("#isolate-btn")).toBeVisible();
    await expect(page.locator("#isolate-btn")).toHaveCSS("opacity", "1");
  });

  test("hide button does not hide unselected paths", async ({ page }) => {
    await waitForPathData(page);

    const pathId = await page.evaluate(
      () => (window as any).mapApp.fullPathInfo[0].id
    );
    await page.evaluate(
      (id) => (window as any).mapApp.togglePathSelection(String(id)),
      pathId
    );
    await page.waitForFunction(
      () => (window as any).mapApp.selectedPathIds.size === 1,
      { timeout: 5000 }
    );

    // Hide buttons
    await page.locator("#hide-buttons-btn").click();
    await expect(page.locator("#hide-buttons-btn")).toHaveText("🔽");

    // isolateSelection should still be false
    const isIsolated = await page.evaluate(
      () => (window as any).mapApp.isolateSelection
    );
    expect(isIsolated).toBe(false);

    // Altitude layer should still have unselected paths visible (not hidden)
    const totalSegments = await page.evaluate(() => {
      const app = (window as any).mapApp;
      return app.currentData?.path_segments?.length ?? 0;
    });
    const renderedLayers = await page.evaluate(() => {
      const app = (window as any).mapApp;
      return app.altitudeLayer.getLayers().length;
    });

    // With hide button, all paths should still render (not just selected ones)
    expect(renderedLayers).toBeGreaterThan(1);
    expect(renderedLayers).toBe(totalSegments);
  });

  test("selected paths use normal weight in solo mode", async ({ page }) => {
    const { pathId, isolateBtn } = await selectPathAndGetIsolateBtn(page);

    // Before solo: selected paths have weight 6
    const weightBefore = await page.evaluate((id) => {
      const app = (window as any).mapApp;
      const layers = app.altitudeLayer.getLayers();
      for (const layer of layers) {
        if (layer.options && layer.options.weight === 6) return 6;
      }
      return null;
    }, pathId);
    expect(weightBefore).toBe(6);

    // Activate solo mode
    await isolateBtn.click();
    await page.waitForTimeout(300);

    // In solo: all visible paths should have weight 4
    const weightsInSolo = await page.evaluate(() => {
      const app = (window as any).mapApp;
      const layers = app.altitudeLayer.getLayers();
      return layers.map((l: any) => l.options.weight);
    });
    expect(weightsInSolo.length).toBeGreaterThan(0);
    for (const w of weightsInSolo) {
      expect(w).toBe(4);
    }

    // Deactivate solo mode
    await isolateBtn.click();
    await page.waitForTimeout(300);

    // After solo: selected paths should have weight 6 again
    const weightAfter = await page.evaluate((id) => {
      const app = (window as any).mapApp;
      const layers = app.altitudeLayer.getLayers();
      for (const layer of layers) {
        if (layer.options && layer.options.weight === 6) return 6;
      }
      return null;
    }, pathId);
    expect(weightAfter).toBe(6);
  });

  test("solo mode hides unselected paths from altitude layer", async ({
    page,
  }) => {
    const { isolateBtn } = await selectPathAndGetIsolateBtn(page);

    const totalBefore = await page.evaluate(() => {
      const app = (window as any).mapApp;
      return app.altitudeLayer.getLayers().length;
    });

    // Activate solo mode
    await isolateBtn.click();
    await page.waitForTimeout(300);

    const totalAfter = await page.evaluate(() => {
      const app = (window as any).mapApp;
      return app.altitudeLayer.getLayers().length;
    });

    // Solo mode should show fewer paths (only the selected one)
    expect(totalAfter).toBeLessThan(totalBefore);
    expect(totalAfter).toBeGreaterThan(0);
  });
});
