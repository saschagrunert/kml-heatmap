/**
 * Shared helper functions for e2e tests
 */
/// <reference types="leaflet" />
import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page } from "@playwright/test";
// Type-only import so the window.mapApp / MAP_CONFIG globals are declared
import type {} from "../../kml_heatmap/frontend/globals";

/**
 * The years the built site carries, as the year filter spells them. Read
 * from the exported metadata so the specs follow the data set instead of
 * breaking when another year of flights is committed.
 */
export async function knownYears(page: Page): Promise<string[]> {
  const years = await page.evaluate(() =>
    (window.KML_METADATA?.available_years ?? []).map(String),
  );
  expect(years.length, "the site exports no years").toBeGreaterThan(0);
  return years;
}

interface SegmentClickPosition {
  x: number;
  y: number;
  coord: number[];
  pathId?: number | undefined;
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

/**
 * Every console error. The fixture in fixtures.ts answers all CDN and tile
 * requests locally, so a failed resource load is a defect of the page or of
 * the test setup, never a network hiccup to filter out.
 */
export function relevantConsoleErrors(collector: ErrorCollector): string[] {
  return collector.consoleErrors;
}

/**
 * Wait until every running CSS animation and transition below `target` has
 * finished. Animations that never end (spinners) are left alone.
 *
 * The control surfaces slide and fade in, so anything that measures
 * geometry or scans the page for contrast has to let that settle first: a
 * box read part-way through moves on its own, and axe sees the colours of
 * the half-faded frame.
 */
export async function settleAnimations(target: Page | Locator): Promise<void> {
  const root = "goto" in target ? target.locator(":root") : target;
  await root.evaluate((el) =>
    Promise.all(
      el
        .getAnimations({ subtree: true })
        .filter((animation) =>
          Number.isFinite(
            Number(animation.effect?.getComputedTiming().endTime ?? 0),
          ),
        )
        // A cancelled animation rejects; it is over either way
        .map((animation) => animation.finished.catch(() => undefined)),
    ),
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

/* ==========================================================================
   Mobile bar and sheet

   Below the breakpoint the two control columns are replaced by the bottom
   bar, so the specs that are about behaviour rather than desktop chrome
   drive whichever control the viewport actually offers.
   ========================================================================== */

/** Matches MOBILE_BAR_BREAKPOINT_PX in ui/mobileBar.ts */
export const MOBILE_BAR_BREAKPOINT_PX = 768;

/** Whether this viewport gets the bottom bar instead of the columns */
export function usesMobileBar(page: Page): Promise<boolean> {
  return page.evaluate(
    (limit) => window.innerWidth < limit,
    MOBILE_BAR_BREAKPOINT_PX,
  );
}

/** Bar tabs that open the sheet */
export type SheetTab = "layers" | "filter" | "more";

/** Open a sheet-backed tab and wait until the sheet is showing */
export async function openMobileSheet(
  page: Page,
  tab: SheetTab,
): Promise<void> {
  await page.locator(`#mobile-tab-${tab}`).click();
  await expect(page.locator("#mobile-sheet")).toBeVisible();
  // The tab carries no aria-expanded: the sheet is modal and covers the
  // whole bar, so the tab is not an operable disclosure while it is open.
  // The class is what says which tab the sheet belongs to.
  await expect(page.locator(`#mobile-tab-${tab}`)).toHaveClass(/\bactive\b/);
}

/** Dismiss the sheet through its own close control */
export async function closeMobileSheet(page: Page): Promise<void> {
  const sheet = page.locator("#mobile-sheet");
  if (!(await sheet.isVisible())) return;
  await page.locator(".sheet-close").click();
  await expect(sheet).toBeHidden();
}

/** The desktop button and the sheet row that drive the same layer */
const LAYER_CONTROLS = {
  heatmap: { buttonId: "heatmap-btn", rowId: "heatmap" },
  airports: { buttonId: "airports-btn", rowId: "airports" },
  altitude: { buttonId: "altitude-btn", rowId: "altitude" },
  airspeed: { buttonId: "airspeed-btn", rowId: "speed" },
  aviation: { buttonId: "aviation-btn", rowId: "aviation" },
} as const;

export type LayerName = keyof typeof LAYER_CONTROLS;

/**
 * The button in the desktop column. It stays in the document below the
 * breakpoint, where it is the state the bar mirrors rather than a control.
 */
export function layerButton(page: Page, layer: LayerName): Locator {
  return page.locator("#" + LAYER_CONTROLS[layer].buttonId);
}

/** The switch the mobile Layers sheet carries for a layer */
export function layerSwitch(page: Page, layer: LayerName): Locator {
  return page.locator(`.sheet-row[data-row="${LAYER_CONTROLS[layer].rowId}"]`);
}

/**
 * Toggle a layer through whichever control this viewport offers, and wait
 * until it took. Without the post-condition a click the sheet swallowed
 * only shows up much later, in whatever the caller asserts next.
 */
export async function toggleLayer(page: Page, layer: LayerName): Promise<void> {
  const button = layerButton(page, layer);
  const wasPressed = (await button.getAttribute("aria-pressed")) === "true";

  if (await usesMobileBar(page)) {
    await openMobileSheet(page, "layers");
    await layerSwitch(page, layer).click();
    await closeMobileSheet(page);
  } else {
    await button.click();
  }

  await expect(button, `${layer} did not toggle`).toHaveAttribute(
    "aria-pressed",
    String(!wasPressed),
  );
}

/**
 * Choose a filter value. The sheet mirrors the page's own dropdown and
 * writes the choice back to it, so both paths end in the same handler.
 */
async function selectFilter(
  page: Page,
  rowId: string,
  sourceId: string,
  value: string,
): Promise<void> {
  if (!(await usesMobileBar(page))) {
    await page.locator("#" + sourceId).selectOption(value);
    return;
  }
  await openMobileSheet(page, "filter");
  await page
    .locator(`.sheet-row[data-row="${rowId}"] select`)
    .selectOption(value);
  await closeMobileSheet(page);
}

/** Filter by year through the column dropdown or the Filter sheet */
export function setYearFilter(page: Page, year: string): Promise<void> {
  return selectFilter(page, "year", "year-select", year);
}

/** Filter by aircraft through the column dropdown or the Filter sheet */
export function setAircraftFilter(page: Page, aircraft: string): Promise<void> {
  return selectFilter(page, "aircraft", "aircraft-select", aircraft);
}

/** Toggle the statistics panel from the bar or the desktop button */
export async function toggleStatsPanel(page: Page): Promise<void> {
  const mobile = await usesMobileBar(page);
  await page.locator(mobile ? "#mobile-tab-stats" : "#stats-btn").click();
}

/**
 * Open the year in review from the bar or the desktop button and wait until
 * the dialog is showing. Returns the dialog.
 */
export async function openWrapped(page: Page): Promise<Locator> {
  const mobile = await usesMobileBar(page);
  await page.locator(mobile ? "#mobile-tab-wrapped" : "#wrapped-btn").click();
  const modal = page.locator("#wrapped-modal");
  await expect(modal).toBeVisible({ timeout: 5000 });
  return modal;
}

/** The id of the first path of the loaded data set */
export async function firstPathId(page: Page): Promise<number> {
  await waitForPathData(page);
  return page.evaluate(() => window.mapApp!.fullPathInfo![0]!.id);
}

/**
 * Toggle one path in or out of the selection and wait until the selection
 * has the expected size, so the change has taken before the caller asserts
 * on anything that follows from it.
 */
export async function togglePathSelection(
  page: Page,
  pathId: number,
  expectedSize: number,
): Promise<void> {
  await page.evaluate(
    (id) => window.mapApp!.togglePathSelection(String(id)),
    pathId,
  );
  await page.waitForFunction(
    (size) => window.mapApp!.selectedPathIds.size === size,
    expectedSize,
    { timeout: 5000 },
  );
}

/** Enable altitude layer and wait for path data to load */
export async function waitForPathData(page: Page): Promise<void> {
  const altBtn = layerButton(page, "altitude");
  if ((await altBtn.getAttribute("aria-pressed")) !== "true") {
    await toggleLayer(page, "altitude");
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

  await togglePathSelection(page, pathId!, 1);

  return pathId!;
}

/** Activate replay mode (select path + toggle replay) */
export async function activateReplay(page: Page): Promise<number> {
  const pathId = await selectPathForReplay(page);
  await expect(page.locator("#replay-btn")).toHaveAttribute(
    "title",
    "Replay selected flight path",
  );
  await startReplay(page);
  await expect(page.locator("#replay-controls")).toBeVisible({
    timeout: 5000,
  });
  return pathId;
}

/**
 * Start replay from the More sheet on mobile, the column button otherwise.
 * The sheet row closes the sheet itself before toggling replay.
 */
async function startReplay(page: Page): Promise<void> {
  if (!(await usesMobileBar(page))) {
    await page.locator("#replay-btn").click();
    return;
  }
  await openMobileSheet(page, "more");
  await page.locator('.sheet-row[data-row="replay"]').click();
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

/**
 * Run an axe-core scan and fail on WCAG A/AA violations. The scan waits for
 * the page's animations first: a panel caught mid-fade has not reached its
 * final colours, and the contrast check reported that as a violation once
 * in a while.
 */
export async function expectNoA11yViolations(
  page: Page,
  label: string,
  configure?: (builder: AxeBuilder) => AxeBuilder,
): Promise<void> {
  await settleAnimations(page);
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
