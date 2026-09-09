/**
 * Shared helper functions for e2e tests
 */
import { expect, type Page } from "@playwright/test";

interface SegmentClickPosition {
  x: number;
  y: number;
  coord: number[];
  pathId?: number;
}

/**
 * Find a path segment coordinate far from any airport marker, zoom to it,
 * and return its container position. Useful for clicking/hovering on paths
 * without hitting airport markers.
 */
export async function findSegmentFarFromAirports(
  page: Page,
  options?: { includePathId?: boolean },
): Promise<SegmentClickPosition | null> {
  const includePathId = options?.includePathId ?? false;

  const pos = await page.evaluate((wantPathId) => {
    const app = (window as any).mapApp;
    const segments = app.currentData?.path_segments;
    if (!segments || segments.length === 0) return null;

    const airports: { lat: number; lon: number }[] = [];
    for (const name of Object.keys(app.airportMarkers || {})) {
      const ll = app.airportMarkers[name].getLatLng();
      airports.push({ lat: ll.lat, lon: ll.lng });
    }

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

    app.map.setView(L.latLng(best.coord[0], best.coord[1]), 13, {
      animate: false,
    });

    const point = app.map.latLngToContainerPoint(
      L.latLng(best.coord[0], best.coord[1]),
    );
    return {
      x: point.x,
      y: point.y,
      coord: best.coord,
      pathId: wantPathId ? best.seg.path_id : undefined,
    };
  }, includePathId);

  if (!pos) return null;

  await page.waitForTimeout(500);

  const settled = await page.evaluate((cp) => {
    const app = (window as any).mapApp;
    const point = app.map.latLngToContainerPoint(
      L.latLng(cp.coord[0], cp.coord[1]),
    );
    return { x: point.x, y: point.y };
  }, pos);

  return { ...settled, coord: pos.coord, pathId: pos.pathId };
}

/** Enable altitude layer and wait for path data to load */
export async function waitForPathData(page: Page): Promise<void> {
  await page.locator("#altitude-btn").click();
  await expect(page.locator("#altitude-btn")).toHaveCSS("opacity", "1");
  await page.waitForFunction(
    () => (window as any).mapApp?.fullPathInfo?.length > 0,
    { timeout: 15000 },
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
    (id) => (window as any).mapApp.togglePathSelection(String(id)),
    pathId,
  );
  await page.waitForFunction(
    () => (window as any).mapApp.selectedPathIds.size === 1,
    { timeout: 5000 },
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
