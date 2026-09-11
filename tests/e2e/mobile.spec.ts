/**
 * Mobile bottom bar and sheet.
 *
 * Below the breakpoint the two control columns are replaced by the bar from
 * ui/mobileBar.ts and the sheet from ui/mobileSheet.ts. These specs drive
 * that interface; the behaviour the columns cover on wider viewports is
 * exercised here through the bar instead.
 */
import { test, expect, type Page } from "./fixtures";
import {
  activateReplay,
  attachErrorCollectors,
  closeMobileSheet,
  expectNoA11yViolations,
  gotoApp,
  knownYears,
  layerButton,
  layerSwitch,
  openMobileSheet,
  playUntilProgress,
  relevantConsoleErrors,
  selectPathForReplay,
  waitForAircraftFilter,
  waitForYearFilter,
  type ErrorCollector,
} from "./helpers";

/** The smallest comfortable touch target on both mobile platforms */
const MIN_TAP_TARGET_PX = 44;

const TABS = [
  { id: "layers", label: "Layers" },
  { id: "filter", label: "Filter" },
  { id: "stats", label: "Stats" },
  { id: "wrapped", label: "Wrapped" },
  { id: "more", label: "More" },
] as const;

/** Whether the heatmap overlay is on the map right now */
function heatmapOnMap(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const app = window.mapApp!;
    return !!app.heatmapLayer && app.map!.hasLayer(app.heatmapLayer);
  });
}

/** Whether the airport marker layer is on the map right now */
function airportsOnMap(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const app = window.mapApp!;
    return app.map!.hasLayer(app.airportLayer);
  });
}

/** Every tap target of a locator set is big enough to hit */
async function expectTapTargets(page: Page, selector: string): Promise<void> {
  const targets = page.locator(selector);
  const count = await targets.count();
  expect(count, `no tap targets matched ${selector}`).toBeGreaterThan(0);
  for (let index = 0; index < count; index++) {
    const target = targets.nth(index);
    const box = (await target.boundingBox())!;
    const name = (await target.getAttribute("id")) ?? selector + " " + index;
    expect(box.width, `${name} width`).toBeGreaterThanOrEqual(
      MIN_TAP_TARGET_PX,
    );
    expect(box.height, `${name} height`).toBeGreaterThanOrEqual(
      MIN_TAP_TARGET_PX,
    );
  }
}

test.describe("Mobile bar", () => {
  test.skip(
    ({ isMobile }) => !isMobile,
    "The bar is only built below the 768px breakpoint",
  );

  // The bar and the sheet are built at runtime and are the only interface
  // this viewport has, so every flow below is also a smoke test for them:
  // error-free.spec.ts drives the columns, which are not here.
  let errors: ErrorCollector;

  test.beforeEach(async ({ page }) => {
    errors = await attachErrorCollectors(page);
    await gotoApp(page);
  });

  test.afterEach(() => {
    expect(errors.pageErrors).toEqual([]);
    expect(errors.cspViolations).toEqual([]);
    expect(relevantConsoleErrors(errors)).toEqual([]);
  });

  test("the bar replaces the control columns with five tabs", async ({
    page,
  }) => {
    const bar = page.locator("#mobile-bar");
    await expect(bar).toBeVisible();
    await expect(bar).toHaveAttribute("aria-label", "Map controls");

    const tabs = page.locator(".mobile-tab");
    await expect(tabs).toHaveCount(TABS.length);
    for (const [index, spec] of TABS.entries()) {
      const tab = tabs.nth(index);
      await expect(tab).toHaveAttribute("id", `mobile-tab-${spec.id}`);
      await expect(tab).toHaveText(spec.label);
    }

    // The columns the bar stands in for are gone, and out of the tab order
    // with them, so the same controls are not offered twice
    await expect(page.locator("#left-buttons")).toBeHidden();
    await expect(page.locator("#right-buttons")).toBeHidden();
  });

  test("every tab is a large enough tap target", async ({ page }) => {
    await expectTapTargets(page, ".mobile-tab");
  });

  test("tapping a sheet tab again closes the sheet", async ({ page }) => {
    for (const id of ["layers", "filter", "more"] as const) {
      await openMobileSheet(page, id);
      await expect(page.locator("#mobile-sheet")).toBeVisible();

      await page.locator(`#mobile-tab-${id}`).click();
      await expect(page.locator("#mobile-sheet")).toBeHidden();
      await expect(page.locator(`#mobile-tab-${id}`)).not.toHaveClass(
        /\bactive\b/,
      );
    }
  });

  test("swapping between sheet tabs highlights the new tab", async ({
    page,
  }) => {
    const sheet = page.locator("#mobile-sheet");
    for (const [from, to] of [
      ["filter", "layers"],
      ["layers", "more"],
      ["more", "filter"],
    ] as const) {
      await openMobileSheet(page, from);
      await page.locator(`#mobile-tab-${to}`).click();
      await expect(sheet).toBeVisible();
      await expect(page.locator(`#mobile-tab-${to}`)).toHaveClass(/\bactive\b/);
      await expect(page.locator(`#mobile-tab-${from}`)).not.toHaveClass(
        /\bactive\b/,
      );
      await page.locator(`#mobile-tab-${to}`).click();
      await expect(sheet).toBeHidden();
    }
  });

  test("the tabs that open the sheet say so", async ({ page }) => {
    for (const id of ["layers", "filter", "more"]) {
      const tab = page.locator(`#mobile-tab-${id}`);
      await expect(tab).toHaveAttribute("aria-haspopup", "dialog");
      await expect(tab).toHaveAttribute("aria-controls", "mobile-sheet");
      // Not a disclosure: the sheet covers the bar and traps focus, so the
      // tab can never be operated while its sheet is open
      await expect(tab).not.toHaveAttribute("aria-expanded", /.*/);
      await expect(tab).not.toHaveClass(/\bactive\b/);
    }
    // The panel tabs are toggles, not disclosures
    for (const id of ["stats", "wrapped"]) {
      await expect(page.locator(`#mobile-tab-${id}`)).toHaveAttribute(
        "aria-pressed",
        "false",
      );
    }
  });

  test.describe("Layers sheet", () => {
    test("opens with a switch for every layer", async ({ page }) => {
      await openMobileSheet(page, "layers");

      const sheet = page.locator("#mobile-sheet");
      await expect(sheet).toHaveAttribute("role", "dialog");
      await expect(sheet).toHaveAttribute("aria-modal", "true");
      await expect(page.locator("#mobile-sheet-title")).toHaveText("Layers");

      for (const layer of ["heatmap", "airports", "altitude", "speed"]) {
        await expect(
          page.locator(`.sheet-row[data-row="${layer}"]`),
        ).toHaveAttribute("role", "switch");
      }

      await expectTapTargets(page, ".sheet-row");
      await expectTapTargets(page, ".sheet-close");
    });

    test("a switch toggles the heatmap and the button stays in step", async ({
      page,
    }) => {
      const button = layerButton(page, "heatmap");
      await expect(button).toHaveAttribute("aria-pressed", "true");
      expect(await heatmapOnMap(page)).toBe(true);

      await openMobileSheet(page, "layers");
      const row = layerSwitch(page, "heatmap");
      await expect(row).toHaveAttribute("aria-checked", "true");

      await row.click();

      await expect(row).toHaveAttribute("aria-checked", "false");
      await expect(button).toHaveAttribute("aria-pressed", "false");
      await expect.poll(() => heatmapOnMap(page)).toBe(false);

      await row.click();

      await expect(row).toHaveAttribute("aria-checked", "true");
      await expect(button).toHaveAttribute("aria-pressed", "true");
      await expect.poll(() => heatmapOnMap(page)).toBe(true);
    });

    test("a switch toggles the airport markers", async ({ page }) => {
      const button = layerButton(page, "airports");
      await expect(button).toHaveAttribute("aria-pressed", "true");
      expect(await airportsOnMap(page)).toBe(true);

      await openMobileSheet(page, "layers");
      const row = layerSwitch(page, "airports");

      await row.click();

      await expect(row).toHaveAttribute("aria-checked", "false");
      await expect(button).toHaveAttribute("aria-pressed", "false");
      await expect.poll(() => airportsOnMap(page)).toBe(false);

      await row.click();

      await expect(button).toHaveAttribute("aria-pressed", "true");
      await expect.poll(() => airportsOnMap(page)).toBe(true);
    });

    test("the colour layers drive their legends and stay exclusive", async ({
      page,
    }) => {
      const altitudeLegend = page.locator("#altitude-legend");
      const airspeedLegend = page.locator("#airspeed-legend");
      await expect(altitudeLegend).toBeHidden();
      await expect(airspeedLegend).toBeHidden();

      await openMobileSheet(page, "layers");
      const altitude = layerSwitch(page, "altitude");
      const speed = layerSwitch(page, "airspeed");

      await altitude.click();
      await expect(altitude).toHaveAttribute("aria-checked", "true");
      await expect(layerButton(page, "altitude")).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await expect(altitudeLegend).toBeVisible();
      await expect(page.locator("#legend-min")).toBeVisible();
      await expect(page.locator("#legend-max")).toBeVisible();

      // Only one colour layer at a time
      await speed.click();
      await expect(speed).toHaveAttribute("aria-checked", "true");
      await expect(altitude).toHaveAttribute("aria-checked", "false");
      await expect(layerButton(page, "airspeed")).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await expect(airspeedLegend).toBeVisible();
      await expect(altitudeLegend).toBeHidden();
    });

    test("aviation data follows the API key configuration", async ({
      page,
    }) => {
      const hasApiKey = await page.evaluate(
        () => !!window.MAP_CONFIG?.openaipApiKey,
      );
      await openMobileSheet(page, "layers");
      const row = layerSwitch(page, "aviation");

      if (!hasApiKey) {
        await expect(row).toHaveCount(0);
        return;
      }

      await expect(row).toHaveAttribute("aria-checked", "false");

      await row.click();

      await expect(row).toHaveAttribute("aria-checked", "true");
      await expect(layerButton(page, "aviation")).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      expect(await page.evaluate(() => window.mapApp!.aviationVisible)).toBe(
        true,
      );
    });
  });

  test.describe("Filter sheet", () => {
    test("changing the year moves the map data with it", async ({ page }) => {
      const years = await knownYears(page);
      const year = years[0]!;
      const source = page.locator("#year-select");

      await openMobileSheet(page, "filter");
      const row = page.locator('.sheet-row[data-row="year"]');
      const select = row.locator("select");

      // The sheet mirrors the page's own dropdown, minus its filter name
      await expect(select.locator("option")).toHaveCount(years.length + 1);
      await expect(select.locator("option").first()).toHaveText("All");
      await expect(select).toHaveValue(await source.inputValue());

      await select.selectOption(year);

      await waitForYearFilter(page, year);
      await expect(source).toHaveValue(year);
      await expect(row.locator(".sheet-row-value")).toHaveText(year);
    });

    test("changing the aircraft writes back to the page dropdown", async ({
      page,
    }) => {
      const source = page.locator("#aircraft-select");
      const options = source.locator("option");
      const aircraft = (await options.nth(1).getAttribute("value"))!;

      await openMobileSheet(page, "filter");
      const select = page.locator('.sheet-row[data-row="aircraft"] select');
      await expect(select.locator("option")).toHaveCount(await options.count());

      await select.selectOption(aircraft);

      await waitForAircraftFilter(page, aircraft);
      await expect(source).toHaveValue(aircraft);
    });
  });

  test("the Stats tab opens and closes the statistics panel", async ({
    page,
  }) => {
    const tab = page.locator("#mobile-tab-stats");
    const panel = page.locator("#stats-panel");
    await expect(panel).toBeHidden();

    await tab.click();

    await expect(panel).toBeVisible();
    await expect(panel).toContainText("Flights");
    await expect(tab).toHaveAttribute("aria-pressed", "true");
    // The tab is the way back, so the rail drops its own collapse control
    // The title stays; only the collapse control is redundant on mobile
    await expect(page.locator("#stats-rail-header")).toBeVisible();
    await expect(page.locator("#stats-collapse-btn")).toBeHidden();

    await tab.click();

    await expect(panel).toBeHidden();
    await expect(tab).toHaveAttribute("aria-pressed", "false");
  });

  test("the Wrapped tab opens the year in review", async ({ page }) => {
    const tab = page.locator("#mobile-tab-wrapped");
    const modal = page.locator("#wrapped-modal");
    await expect(modal).toBeHidden();

    await tab.click();

    await expect(modal).toBeVisible();
    await expect(page.locator("#wrapped-card-airports")).toBeVisible();
    await expect(tab).toHaveAttribute("aria-pressed", "true");

    await page.locator("[data-action=closeWrapped]").click();

    await expect(modal).toBeHidden();
    await expect(tab).toHaveAttribute("aria-pressed", "false");
  });

  test.describe("More sheet", () => {
    test("explains why replay is unavailable and what needs a selection", async ({
      page,
    }) => {
      await openMobileSheet(page, "more");

      // The row stays actionable so tapping it can explain itself
      const replay = page.locator('.sheet-row[data-row="replay"]');
      await expect(replay).toBeEnabled();
      await expect(replay.locator(".sheet-row-hint")).toHaveText(
        "Select one flight with timing data",
      );
      await expect(page.locator("#replay-btn")).toHaveAttribute(
        "aria-pressed",
        "false",
      );
      await expect(page.locator("#replay-btn")).toHaveAttribute(
        "title",
        "Select exactly one flight with timing data to replay",
      );

      // Isolating needs something to isolate
      await expect(
        page.locator('.sheet-row[data-row="isolate"]'),
      ).toBeDisabled();

      await expect(page.locator('.sheet-row[data-row="export"]')).toBeEnabled();
      await expect(page.locator('.sheet-row[data-row="share"]')).toBeEnabled();
    });

    test("isolate becomes available once a path is selected", async ({
      page,
    }) => {
      await selectPathForReplay(page);

      await openMobileSheet(page, "more");
      const isolate = page.locator('.sheet-row[data-row="isolate"]');
      await expect(isolate).toBeEnabled();
      await expect(isolate).toHaveAttribute("aria-checked", "false");

      await isolate.click();

      await expect(isolate).toHaveAttribute("aria-checked", "true");
      await expect(page.locator("#isolate-btn")).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      expect(await page.evaluate(() => window.mapApp!.isolateSelection)).toBe(
        true,
      );
    });
  });

  test.describe("Sheet dismissal and focus", () => {
    test("focus enters the sheet, Escape closes it and focus returns", async ({
      page,
    }) => {
      const tab = page.locator("#mobile-tab-layers");
      const sheet = page.locator("#mobile-sheet");

      await tab.click();

      await expect(sheet).toBeVisible();
      await expect(sheet).toBeFocused();

      await page.keyboard.press("Escape");

      await expect(sheet).toBeHidden();
      await expect(tab).toBeFocused();
      await expect(tab).not.toHaveClass(/\bactive\b/);
    });

    test("Tab stays inside the open sheet", async ({ page }) => {
      await openMobileSheet(page, "layers");
      const sheet = page.locator("#mobile-sheet");
      const rows = sheet.locator(".sheet-row");
      const close = sheet.locator(".sheet-close");

      // The close control leads the sheet, the rows follow it
      await rows.last().focus();
      await page.keyboard.press("Tab");
      await expect(close).toBeFocused();

      await page.keyboard.press("Shift+Tab");
      await expect(rows.last()).toBeFocused();
    });

    test("a tap on the scrim dismisses the sheet", async ({ page }) => {
      await openMobileSheet(page, "layers");

      // Away from the sheet itself, which covers the lower part of the scrim
      await page
        .locator("#mobile-sheet-scrim")
        .click({ position: { x: 10, y: 10 } });

      await expect(page.locator("#mobile-sheet")).toBeHidden();
      await expect(page.locator("#mobile-tab-layers")).not.toHaveClass(
        /\bactive\b/,
      );
    });

    test("the close control dismisses the sheet", async ({ page }) => {
      await openMobileSheet(page, "more");

      await closeMobileSheet(page);

      await expect(page.locator("#mobile-tab-more")).not.toHaveClass(
        /\bactive\b/,
      );
    });

    test("the open sheet sits above the bar and tabs stay reachable", async ({
      page,
    }) => {
      await openMobileSheet(page, "filter");

      // The sheet sits above the bar so bar tabs remain tappable for
      // swapping between sheets. Polled: the sheet slides into place.
      await expect
        .poll(
          () =>
            page.evaluate(() => {
              const sheet = document.getElementById("mobile-sheet")!;
              const bar = document.getElementById("mobile-bar")!;
              const sheetBox = sheet.getBoundingClientRect();
              const barBox = bar.getBoundingClientRect();
              return sheetBox.bottom <= barBox.top + 1;
            }),
          { message: "the sheet should not overlap the bar" },
        )
        .toBe(true);
      await expect(page.locator("#mobile-sheet")).toBeVisible();

      // Tabs remain reachable while the sheet is open
      const tab = page.locator("#mobile-tab-layers");
      await expect(tab).toBeVisible();
      await tab.click();
      await expect(page.locator("#mobile-tab-layers")).toHaveClass(
        /\bactive\b/,
      );
    });
  });

  test("replay does not leave the open statistics sheet painting under it", async ({
    page,
  }) => {
    // The sheet's offsets are keyed on the bar, which replay removes from the
    // document, so the opaque panel used to cover its lower third and the
    // collapse control reappeared against the design
    await selectPathForReplay(page);
    await page.locator("#mobile-tab-stats").click();
    const rail = page.locator("#stats-rail");
    await expect(rail).toBeVisible();

    await openMobileSheet(page, "more");
    await page.locator('.sheet-row[data-row="replay"]').click();
    await expect(page.locator("#replay-controls")).toBeVisible();

    // Still the open sheet, just not painting over the replay panel
    const during = await page.evaluate(() => {
      const el = document.getElementById("stats-rail")!;
      return {
        hidden: el.hidden,
        visibility: getComputedStyle(el).visibility,
        height: el.getBoundingClientRect().height,
      };
    });
    expect(during.hidden).toBe(false);
    expect(during.height).toBeGreaterThan(200);
    expect(during.visibility).toBe("hidden");

    await page.locator("#replay-exit-btn").click();
    await expect(page.locator("#mobile-bar")).toHaveCount(1);
    await expect(rail).toBeVisible();
    // The collapse control stays hidden: the Stats tab is what closes it
    await expect(page.locator("#stats-collapse-btn")).toBeHidden();
  });

  test("replay takes the bottom edge and the bar leaves the document", async ({
    page,
  }) => {
    await selectPathForReplay(page);

    await openMobileSheet(page, "more");
    const replay = page.locator('.sheet-row[data-row="replay"]');
    // The hint is gone once a single timed flight is selected
    await expect(replay.locator(".sheet-row-hint")).toBeHidden();

    await replay.click();

    await expect(page.locator("#mobile-sheet")).toBeHidden();
    await expect(page.locator("#replay-controls")).toBeVisible();
    // The bar leaves rather than hiding in place, so it cannot keep
    // reserving the height the replay panel and attribution need
    await expect(page.locator("#mobile-bar")).toHaveCount(0);

    // The panel is usable where the bar used to be
    await playUntilProgress(page);

    const exit = page.locator("#replay-exit-btn");
    await expect(exit).toBeVisible();
    await expect(exit).toHaveAttribute("aria-label", "Close replay");
    await expectTapTargets(page, "#replay-exit-btn");

    await exit.click();

    await expect(page.locator("#replay-controls")).toBeHidden();
    // And the bar comes back once replay releases the bottom edge
    await expect(page.locator("#mobile-bar")).toHaveCount(1);
    await expect(page.locator("#mobile-bar")).toBeVisible();
  });

  test("attribution and github are in the More sheet", async ({ page }) => {
    await openMobileSheet(page, "more");
    await expect(
      page.locator('.sheet-row[data-row="attribution"]'),
    ).toBeVisible();
    await expect(page.locator('.sheet-row[data-row="github"]')).toBeVisible();
    // The map attribution and footer are hidden on mobile
    await expect(page.locator(".leaflet-control-attribution")).toBeHidden();
    await expect(page.locator("#github-footer")).toBeHidden();
  });

  test.describe("Accessibility", () => {
    test("the idle page has no WCAG A/AA violations", async ({ page }) => {
      await expect(page.locator("#mobile-bar")).toBeVisible();

      await expectNoA11yViolations(page, "mobile idle");
    });

    test("the open sheet has no WCAG A/AA violations", async ({ page }) => {
      await openMobileSheet(page, "layers");

      await expectNoA11yViolations(page, "mobile sheet");
    });

    test("the filter sheet has no WCAG A/AA violations", async ({ page }) => {
      // The Layers sheet holds no <select>, so scanning only that one left
      // the mirrored dropdowns and their labels unscanned
      await openMobileSheet(page, "filter");
      await expect(page.locator("#mobile-sheet select")).not.toHaveCount(0);

      await expectNoA11yViolations(page, "mobile filter sheet");
    });

    test("every mirrored dropdown is named by its own row label", async ({
      page,
    }) => {
      await openMobileSheet(page, "filter");

      const named = await page.evaluate(() =>
        Array.from(
          document.querySelectorAll<HTMLSelectElement>("#mobile-sheet select"),
        ).map((select) => {
          const id = select.getAttribute("aria-labelledby");
          const label = id ? document.getElementById(id) : null;
          return {
            labelled: !!id,
            resolves: !!label,
            text: label?.textContent?.trim() ?? null,
          };
        }),
      );

      expect(named.length).toBeGreaterThan(0);
      for (const entry of named) {
        expect(entry.labelled).toBe(true);
        expect(entry.resolves).toBe(true);
        expect(entry.text).toBeTruthy();
      }
    });

    test("leaving replay hands focus back to a control that is on screen", async ({
      page,
    }) => {
      // The desktop replay button lives inside the hidden left column here,
      // so returning focus to it would drop focus to the body
      await activateReplay(page);
      await page.locator("#replay-exit-btn").click();
      await expect(page.locator("#mobile-bar")).toHaveCount(1);

      const focused = await page.evaluate(() => {
        const el = document.activeElement;
        return {
          id: el?.id ?? null,
          onScreen: !!el && (el as HTMLElement).offsetParent !== null,
        };
      });
      expect(focused.id).toBe("mobile-tab-more");
      expect(focused.onScreen).toBe(true);
    });
  });
});
