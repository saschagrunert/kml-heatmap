import { test, expect } from "./fixtures";
import {
  activateReplay,
  attachErrorCollectors,
  expectNoA11yViolations,
  gotoApp,
  openWrapped,
  relevantConsoleErrors,
  toggleStatsPanel,
  usesMobileBar,
} from "./helpers";
import {
  attributionControl,
  mapMarkers,
  mapSurface,
  waitForMapReady,
  zoomControl,
} from "./map";

test.describe("Core", () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
  });

  test("page loads without errors or CSP violations", async ({ page }) => {
    const errors = await attachErrorCollectors(page);

    await gotoApp(page);

    expect(errors.pageErrors).toEqual([]);
    expect(errors.cspViolations).toEqual([]);
    expect(relevantConsoleErrors(errors)).toEqual([]);
  });

  test("content security policy is declared", async ({ page }) => {
    const csp = await page
      .locator('meta[http-equiv="Content-Security-Policy"]')
      .getAttribute("content");
    expect(csp).toContain("default-src 'self'");
    // Scripts and styles come from the site itself; the map tiles are the
    // only third party the page is allowed to reach
    expect(csp).toContain("script-src 'self';");
    expect(csp).toContain("style-src 'self';");
    expect(csp).not.toContain("file:");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unpkg.com");
    expect(csp).not.toContain("jsdelivr");
    expect(csp).toContain("base-uri 'none'");
  });

  test("the map library takes over the map container", async ({ page }) => {
    const mapContainer = page.locator("#map");
    await expect(mapContainer).toBeVisible();
    await waitForMapReady(page);
  });

  test("the map has a surface to draw on", async ({ page }) => {
    await expect(mapSurface(page)).toBeAttached();
  });

  test("control buttons are present", async ({ page, isMobile }) => {
    test.skip(
      isMobile,
      "The bottom bar replaces the columns; see mobile.spec.ts",
    );
    const buttons = [
      "#heatmap-btn",
      "#altitude-btn",
      "#airspeed-btn",
      "#airports-btn",
      "#stats-btn",
      "#export-btn",
      "#share-btn",
      "#wrapped-btn",
      "#replay-btn",
      "#isolate-btn",
    ];

    for (const selector of buttons) {
      await expect(page.locator(selector)).toBeVisible();
    }

    // Above the breakpoint the columns are the interface; the bar must not
    // also be up, offering the same controls twice
    await expect(page.locator("#mobile-bar")).toHaveCount(0);
  });

  test("icon-only buttons have matching title and aria-label", async ({
    page,
  }) => {
    for (const selector of [
      "#isolate-btn",
      "#stats-collapse-btn",
      "#replay-play-btn",
      "#replay-pause-btn",
      "#replay-stop-btn",
    ]) {
      const button = page.locator(selector);
      const title = await button.getAttribute("title");
      expect(title, selector).toBeTruthy();
      await expect(button).toHaveAttribute("aria-label", title!);
    }
  });

  test("every labelled control is named by its label (WCAG 2.5.3)", async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile, "The columns are hidden below the breakpoint");
    // Speech input users say what they see: "click Airports" found nothing
    // in "Toggle airport markers"
    const controls = await page
      .locator(".control-btn:has(> .control-label)")
      .evaluateAll((buttons) =>
        buttons.map((button) => ({
          label: (
            button.querySelector(".control-label")?.textContent ?? ""
          ).trim(),
          name: button.getAttribute("aria-label") ?? "",
        })),
      );
    expect(controls.length).toBeGreaterThan(5);
    for (const { label, name } of controls) {
      expect(name, label).toMatch(new RegExp(`\\b${label}\\b`, "i"));
    }
  });

  test("heatmap is active by default", async ({ page }) => {
    const btn = page.locator("#heatmap-btn");
    await expect(btn).toHaveAttribute("aria-pressed", "true");
    await expect(btn).toHaveCSS("opacity", "1");
  });

  test("replay button is enabled but marked unavailable initially", async ({
    page,
    isMobile,
  }) => {
    test.skip(
      isMobile,
      "The More sheet carries replay and its hint; see mobile.spec.ts",
    );
    const replayBtn = page.locator("#replay-btn");
    await expect(replayBtn).toBeVisible();
    // The button stays actionable so clicking it can explain why
    expect(
      await replayBtn.evaluate((el) => (el as HTMLButtonElement).disabled),
    ).toBe(false);
    await expect(replayBtn).toHaveAttribute(
      "title",
      "Select exactly one flight with timing data to replay",
    );
    // Announced as unavailable, but still in the tab order
    await expect(replayBtn).toHaveAttribute("aria-disabled", "true");
    await expect(replayBtn).toHaveAttribute("aria-pressed", "false");
  });

  test("replay controls are hidden by default", async ({ page }) => {
    await expect(page.locator("#replay-controls")).toBeHidden();
  });

  test("the focus ring of a row on a group's corner is not clipped", async ({
    page,
    isMobile,
  }) => {
    // A group clips its children to its own radius, so a row sitting against
    // one of its ends needs the matching radius or the ring drawn around it
    // runs into the rounded corner and comes back square.
    test.skip(isMobile, "the columns are replaced by the bar below 768px");

    const corners = await page.evaluate(() =>
      [...document.querySelectorAll(".control-group")].map((group) => {
        // The row that is *shown* last, not the one written last: reading
        // a hidden row would let the radius look present while the row on
        // the corner had none
        const shown = [...group.querySelectorAll(":scope > .control-row")]
          .filter((row) => row.checkVisibility())
          .map((row) => {
            const style = getComputedStyle(row);
            return {
              id: row.querySelector("button, .filter-dropdown")?.id ?? "?",
              bottomLeft: style.borderBottomLeftRadius,
              bottomRight: style.borderBottomRightRadius,
            };
          });
        return shown.at(-1) ?? null;
      }),
    );

    const measured = corners.filter((corner) => corner !== null);
    expect(measured.length).toBeGreaterThan(0);
    for (const corner of measured) {
      expect(corner.bottomLeft, corner.id).not.toBe("0px");
      expect(corner.bottomRight, corner.id).not.toBe("0px");
    }
  });

  test("loading indicator is a status region and hidden after initialization", async ({
    page,
  }) => {
    const loading = page.locator("#loading");
    await expect(loading).toBeHidden();
    await expect(loading).toHaveAttribute("role", "status");
    await expect(page.locator("#loading-text")).toBeAttached();
  });

  test("the zoom control is gone", async ({ page }) => {
    // Pinch, scroll and double tap cover zooming
    await expect(zoomControl(page)).toHaveCount(0);
  });

  test("a country group carries the flag the site published", async ({
    page,
  }) => {
    await toggleStatsPanel(page);
    const group = page.locator(".kh-stats-group").first();
    await expect(group).toBeVisible();

    // The site publishes an SVG per country it visited, so the mark is the
    // same on every platform, Windows included
    const flag = group.locator("img.kh-stats-group-flag");
    await expect(flag).toHaveAttribute("src", /^flags\/[a-z]{2}\.svg$/);
    const src = await flag.getAttribute("src");
    const response = await page.request.get(new URL(src!, page.url()).href);
    expect(response.status()).toBe(200);
    expect(await response.text()).toContain("<svg");
  });

  test("the attribution is shown at every width", async ({ page }) => {
    const attribution = attributionControl(page);
    await expect(attribution).toBeVisible();
    await expect(attribution).toContainText("OpenStreetMap");
  });

  test("page title is set correctly", async ({ page }) => {
    await expect(page).toHaveTitle("KML Heatmap");
  });

  test("map config is loaded with correct structure", async ({ page }) => {
    const config = await page.evaluate(() => window.MAP_CONFIG);
    expect(config).toBeTruthy();
    expect(config!.center).toHaveLength(2);
    expect(config!.bounds).toHaveLength(2);
    expect(config!.dataDir).toBe("data");
  });

  test("metadata is loaded", async ({ page }) => {
    const metadata = await page.evaluate(() => window.KML_METADATA);
    expect(metadata).toBeTruthy();
    // The statistics are computed in the browser, not exported
    expect(metadata).not.toHaveProperty("stats");
    expect(metadata!.aircraft_models).toEqual(expect.any(Object));
    expect(metadata!.aircraft_models).not.toBeNull();
    const years = metadata!.available_years;
    expect(years.length).toBeGreaterThan(0);
    expect(years).toEqual([...years].sort((a, b) => a - b));
    for (const year of years) {
      expect(Number.isInteger(year)).toBe(true);
      expect(year).toBeGreaterThanOrEqual(1990);
      expect(year).toBeLessThanOrEqual(new Date().getFullYear() + 1);
    }
  });

  test("airports data is loaded", async ({ page }) => {
    const airports = await page.evaluate(() => window.KML_AIRPORTS);
    expect(airports).toBeTruthy();
    expect(Array.isArray(airports!.airports)).toBe(true);
    expect(airports!.airports.length).toBeGreaterThan(0);
  });

  test("airport markers are rendered on the map", async ({ page }) => {
    const markers = mapMarkers(page);
    await expect(markers.first()).toBeAttached({ timeout: 15000 });
    expect(await markers.count()).toBeGreaterThan(0);
  });

  test("github footer is visible and labelled on desktop", async ({ page }) => {
    test.skip(
      await usesMobileBar(page),
      "The More sheet carries the GitHub link; see mobile.spec.ts",
    );
    const footer = page.locator("#github-footer");
    await expect(footer).toBeVisible();

    const link = footer.locator("a");
    await expect(link).toHaveAttribute(
      "href",
      "https://github.com/saschagrunert/kml-heatmap",
    );
    await expect(link).toHaveAttribute("aria-label", "View on GitHub");
  });

  test.describe("Accessibility", () => {
    test("initial page has no WCAG A/AA violations", async ({ page }) => {
      await expectNoA11yViolations(page, "initial page");
    });

    test("open stats panel has no WCAG A/AA violations", async ({ page }) => {
      await toggleStatsPanel(page);
      await expect(page.locator("#stats-panel")).toBeVisible();

      await expectNoA11yViolations(page, "stats panel");
    });

    test("replay controls have no WCAG A/AA violations", async ({ page }) => {
      await activateReplay(page);

      await expectNoA11yViolations(page, "replay controls");
    });

    test("wrapped dialog has no WCAG A/AA violations", async ({ page }) => {
      await openWrapped(page);
      await expect(page.locator("#wrapped-card-airports")).toBeVisible();

      await expectNoA11yViolations(page, "wrapped dialog");
    });
  });
});
