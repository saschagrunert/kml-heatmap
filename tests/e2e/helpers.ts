/**
 * Shared helper functions for e2e tests
 */
/// <reference types="leaflet" />
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";
// Type-only import so the window.mapApp / MAP_CONFIG globals are declared
import type {} from "../../kml_heatmap/frontend/globals";

/** Data set committed to the repository: two years of flights */
export const KNOWN_YEARS = ["2025", "2026"];

interface SegmentClickPosition {
  x: number;
  y: number;
  coord: number[];
  pathId?: number;
}

export interface ErrorCollector {
  pageErrors: string[];
  consoleErrors: string[];
  cspViolations: string[];
}

/**
 * Collect uncaught errors, console errors and Content Security Policy
 * violations for the lifetime of the page. Call before page.goto().
 */
export async function attachErrorCollectors(
  page: Page,
): Promise<ErrorCollector> {
  const collector: ErrorCollector = {
    pageErrors: [],
    consoleErrors: [],
    cspViolations: [],
  };
  page.on("pageerror", (err) => collector.pageErrors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") collector.consoleErrors.push(msg.text());
  });
  await page.exposeFunction("__reportCspViolation", (text: string) => {
    collector.cspViolations.push(text);
  });
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      const report = `${event.violatedDirective}: ${event.blockedURI}`;
      (
        window as unknown as { __reportCspViolation: (t: string) => void }
      ).__reportCspViolation(report);
    });
  });
  return collector;
}

/** Console errors that are not caused by the page itself (network hiccups) */
export function relevantConsoleErrors(collector: ErrorCollector): string[] {
  return collector.consoleErrors.filter(
    (text) => !/net::ERR_|Failed to load resource/.test(text),
  );
}

/** Open the app and wait until initialization (data loading) has finished */
export async function gotoApp(page: Page, path = "/"): Promise<void> {
  await page.goto(path);
  await waitForAppReady(page);
}

/**
 * Wait for the app to finish initializing (also after a reload). Leaflet
 * ignores setZoom/setView while its zoom animation from the restored view is
 * still running, so the map must be idle as well.
 */
export async function waitForAppReady(page: Page): Promise<void> {
  await page.waitForSelector("#map.leaflet-container", { timeout: 15000 });
  await page.waitForFunction(
    () => {
      const app = window.mapApp;
      if (!app || app.isInitializing || !app.map) return false;
      const map = app.map as unknown as { _animatingZoom?: boolean };
      return map._animatingZoom !== true;
    },
    { timeout: 20000 },
  );
}

/** Read the persisted app state from localStorage */
export function readSavedState(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(
    () =>
      JSON.parse(localStorage.getItem("kml-heatmap-state") || "{}") as Record<
        string,
        unknown
      >,
  );
}

/** Wait until the year filter has been applied and its data is loaded */
export async function waitForYearFilter(
  page: Page,
  year: string,
): Promise<void> {
  await page.waitForFunction(
    (y) => {
      const app = window.mapApp;
      if (!app || app.selectedYear !== y) return false;
      const data = app.currentData;
      if (!data) return false;
      if (y === "all") return true;
      return data.path_info.every((p) => String(p.year) === y);
    },
    year,
    { timeout: 15000 },
  );
}

/** Wait until the aircraft filter has been applied */
export async function waitForAircraftFilter(
  page: Page,
  aircraft: string,
): Promise<void> {
  await page.waitForFunction(
    (a) => window.mapApp?.selectedAircraft === a,
    aircraft,
    { timeout: 15000 },
  );
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
    const app = window.mapApp;
    const segments = app?.currentData?.path_segments;
    if (!app?.map || !segments || segments.length === 0) return null;

    const airports: { lat: number; lon: number }[] = [];
    for (const name of Object.keys(app.airportMarkers)) {
      const ll = app.airportMarkers[name]!.getLatLng();
      airports.push({ lat: ll.lat, lon: ll.lng });
    }

    let best: { pathId: number; coord: number[]; dist: number } | null = null;
    for (const seg of segments) {
      if (!seg.coords || seg.coords.length < 2) continue;
      const midCoord = seg.coords[Math.floor(seg.coords.length / 2)]!;
      const minDist = airports.reduce((min, a) => {
        const d = Math.hypot(midCoord[0] - a.lat, midCoord[1] - a.lon);
        return Math.min(min, d);
      }, Infinity);
      if (!best || minDist > best.dist) {
        best = { pathId: seg.path_id, coord: midCoord, dist: minDist };
      }
    }
    if (!best) return null;

    app.map.setView(L.latLng(best.coord[0]!, best.coord[1]!), 13, {
      animate: false,
    });

    const point = app.map.latLngToContainerPoint(
      L.latLng(best.coord[0]!, best.coord[1]!),
    );
    return {
      x: point.x,
      y: point.y,
      coord: best.coord,
      pathId: wantPathId ? best.pathId : undefined,
    };
  }, includePathId);

  if (!pos) return null;

  // Wait until the view has settled on the requested position
  await page.waitForFunction(
    (cp) => {
      const app = window.mapApp;
      if (!app?.map) return false;
      const center = app.map.getCenter();
      return (
        Math.abs(center.lat - cp.coord[0]!) < 1e-6 &&
        Math.abs(center.lng - cp.coord[1]!) < 1e-6 &&
        app.map.getZoom() === 13
      );
    },
    pos,
    { timeout: 5000 },
  );

  const settled = await page.evaluate((cp) => {
    const app = window.mapApp!;
    const point = app.map!.latLngToContainerPoint(
      L.latLng(cp.coord[0]!, cp.coord[1]!),
    );
    return { x: point.x, y: point.y };
  }, pos);

  return { ...settled, coord: pos.coord, pathId: pos.pathId };
}

/** Enable altitude layer and wait for path data to load */
export async function waitForPathData(page: Page): Promise<void> {
  const altBtn = page.locator("#altitude-btn");
  if ((await altBtn.getAttribute("aria-pressed")) !== "true") {
    await altBtn.click();
  }
  await expect(altBtn).toHaveAttribute("aria-pressed", "true");
  await page.waitForFunction(
    () => {
      const app = window.mapApp;
      return (
        !!app &&
        (app.fullPathInfo?.length ?? 0) > 0 &&
        app.altitudeLayer.getLayers().length > 0
      );
    },
    { timeout: 15000 },
  );
}

/** Select a single path with timing data for replay */
export async function selectPathForReplay(page: Page): Promise<number> {
  await waitForPathData(page);

  const pathId = await page.evaluate(() => {
    const app = window.mapApp!;
    const segments = app.fullPathSegments || [];
    for (const seg of segments) {
      if (seg.time !== undefined && seg.time !== null) return seg.path_id;
    }
    return null;
  });
  expect(pathId).not.toBeNull();

  await page.evaluate(
    (id) => window.mapApp!.togglePathSelection(String(id)),
    pathId,
  );
  await page.waitForFunction(() => window.mapApp!.selectedPathIds.size === 1, {
    timeout: 5000,
  });

  return pathId!;
}

/** Activate replay mode (select path + toggle replay) */
export async function activateReplay(page: Page): Promise<number> {
  const pathId = await selectPathForReplay(page);
  await expect(page.locator("#replay-btn")).toHaveAttribute(
    "title",
    "Replay selected flight path",
  );
  await page.locator("#replay-btn").click();
  await expect(page.locator("#replay-controls")).toBeVisible({
    timeout: 5000,
  });
  return pathId;
}

/** Start playback and wait until the replay clock has advanced */
export async function playUntilProgress(page: Page): Promise<void> {
  await page.locator("#replay-play-btn").click();
  await expect(page.locator("#replay-pause-btn")).toBeVisible();
  await page.waitForFunction(
    () => window.mapApp!.replayManager.state.currentTime > 0,
    { timeout: 5000 },
  );
}

const A11Y_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

/** Run an axe-core scan and fail on WCAG A/AA violations */
export async function expectNoA11yViolations(
  page: Page,
  label: string,
  configure?: (builder: AxeBuilder) => AxeBuilder,
): Promise<void> {
  let builder = new AxeBuilder({ page }).withTags(A11Y_TAGS);
  if (configure) builder = configure(builder);
  const results = await builder.analyze();
  const summary = results.violations
    .map(
      (violation) =>
        `${violation.id} (${violation.impact ?? "n/a"}): ${violation.help}\n` +
        violation.nodes.map((node) => "  " + node.target.join(" ")).join("\n"),
    )
    .join("\n");
  expect(results.violations, `${label}\n${summary}`).toEqual([]);
}
