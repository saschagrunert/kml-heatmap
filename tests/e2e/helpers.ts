/**
 * Shared helper functions for e2e tests
 */
import { expect, type Page } from "@playwright/test";

/** Enable altitude layer and wait for path data to load */
export async function waitForPathData(page: Page): Promise<void> {
  await page.locator("#altitude-btn").click();
  await expect(page.locator("#altitude-btn")).toHaveCSS("opacity", "1");
  await page.waitForFunction(
    () => (window as any).mapApp?.fullPathInfo?.length > 0,
    { timeout: 15000 }
  );
}

/** Select a single path with timing data for replay */
export async function selectPathForReplay(page: Page): Promise<number> {
  await waitForPathData(page);

  const pathId = await page.evaluate(() => {
    const app = (window as any).mapApp;
    const segments = app.fullPathSegments || [];
    const pathIdsWithTime = new Set<number>();
    for (const seg of segments) {
      if (seg.time !== undefined && seg.time !== null) {
        pathIdsWithTime.add(seg.path_id);
      }
    }
    return pathIdsWithTime.values().next().value;
  });

  await page.evaluate(
    (id) => (window as any).togglePathSelection(String(id)),
    pathId
  );
  await page.waitForFunction(
    () => (window as any).mapApp.selectedPathIds.size === 1,
    { timeout: 5000 }
  );

  return pathId;
}

/** Activate replay mode (select path + toggle replay) */
export async function activateReplay(page: Page): Promise<number> {
  const pathId = await selectPathForReplay(page);
  await page.locator("#replay-btn").click();
  await expect(page.locator("#replay-controls")).toBeVisible({
    timeout: 5000,
  });
  return pathId;
}
