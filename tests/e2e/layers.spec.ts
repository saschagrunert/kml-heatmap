import { test, expect, type Locator, type Page } from "./fixtures";
import {
  findSegmentFarFromAirports,
  gotoApp,
  setAircraftFilter,
  toggleLayer,
  waitForAircraftFilter,
  waitForPathData,
} from "./helpers";
import {
  aviationOnMap,
  baseMapStyleRequest,
  expectAviationTiles,
  expectHeatUnderPaths,
  heatmapOnMap,
  heatmapOpacity,
  mapPopup,
  mapPopupCloseButton,
  mapPopupContent,
  pathCount,
  setZoom,
} from "./map";

/** The Layers group of the right column, addressed by its own heading */
const LAYERS_GROUP =
  '#right-buttons .control-group[aria-labelledby="layers-group-title"]';

function refreshAirportMarkerSizes(page: Page): Promise<void> {
  return page.evaluate(() => {
    window.mapApp!.airportManager.updateAirportMarkerSizes();
  });
}

/** Set the zoom level and refresh marker sizes, then wait for the class */
async function zoomAndWaitForMarkerSize(
  page: Page,
  zoom: number,
  expected: string,
): Promise<void> {
  await setZoom(page, zoom);
  await refreshAirportMarkerSizes(page);

  await page.waitForFunction(
    (size) => document.getElementById("map")?.dataset["zoomSize"] === size,
    expected,
    { timeout: 5000 },
  );
}

test.describe("Layers", () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
  });

  test("heatmap button toggles heatmap layer", async ({ page, isMobile }) => {
    test.skip(
      isMobile,
      "The Layers sheet drives this below the breakpoint; see mobile.spec.ts",
    );
    // Addressed through the named group rather than a position: the button
    // has to be the one under the Layers heading, carrying its own icon
    const btn = page.locator(`${LAYERS_GROUP} #heatmap-btn`);
    await expect(btn.locator("svg.icon")).toHaveCount(1);

    await btn.click();
    await expect(btn).toHaveCSS("opacity", "0.5");
    await expect(btn).toHaveAttribute("aria-pressed", "false");

    await btn.click();
    await expect(btn).toHaveCSS("opacity", "1");
    await expect(btn).toHaveAttribute("aria-pressed", "true");
  });

  test("altitude toggle shows altitude layer and legend", async ({
    page,
    isMobile,
  }) => {
    test.skip(
      isMobile,
      "The Layers sheet drives this below the breakpoint; see mobile.spec.ts",
    );
    const altBtn = page.locator(`${LAYERS_GROUP} #altitude-btn`);
    const altLegend = page.locator("#altitude-legend");

    // The row shows the ramp the layer colours by, next to its button
    await expect(altBtn.locator("svg.icon")).toHaveCount(1);
    await expect(
      page
        .locator(`${LAYERS_GROUP} .control-row:has(#altitude-btn)`)
        .locator(".ramp-chip-altitude"),
    ).toHaveCount(1);

    await expect(altBtn).toHaveCSS("opacity", "0.5");
    await expect(altLegend).toBeHidden();

    await altBtn.click();
    await expect(altBtn).toHaveCSS("opacity", "1");
    await expect(altLegend).toBeVisible();

    await expect(page.locator("#legend-min")).toBeVisible();
    await expect(page.locator("#legend-max")).toBeVisible();

    await altBtn.click();
    await expect(altBtn).toHaveCSS("opacity", "0.5");
    await expect(altLegend).toBeHidden();
  });

  test("airspeed toggle shows airspeed layer and legend", async ({
    page,
    isMobile,
  }) => {
    test.skip(
      isMobile,
      "The Layers sheet drives this below the breakpoint; see mobile.spec.ts",
    );
    const airspeedBtn = page.locator(`${LAYERS_GROUP} #airspeed-btn`);
    const airspeedLegend = page.locator("#airspeed-legend");

    await expect(airspeedBtn.locator("svg.icon")).toHaveCount(1);
    await expect(
      page
        .locator(`${LAYERS_GROUP} .control-row:has(#airspeed-btn)`)
        .locator(".ramp-chip-speed"),
    ).toHaveCount(1);

    await expect(airspeedBtn).toHaveCSS("opacity", "0.5");
    await expect(airspeedLegend).toBeHidden();

    await airspeedBtn.click();
    await expect(airspeedBtn).toHaveCSS("opacity", "1");
    await expect(airspeedLegend).toBeVisible();

    await expect(page.locator("#airspeed-legend-min")).toBeVisible();
    await expect(page.locator("#airspeed-legend-max")).toBeVisible();

    await airspeedBtn.click();
    await expect(airspeedBtn).toHaveCSS("opacity", "0.5");
    await expect(airspeedLegend).toBeHidden();
  });

  test("altitude and airspeed are mutually exclusive", async ({
    page,
    isMobile,
  }) => {
    test.skip(
      isMobile,
      "The Layers sheet drives this below the breakpoint; see mobile.spec.ts",
    );
    const altBtn = page.locator("#altitude-btn");
    const airspeedBtn = page.locator("#airspeed-btn");

    await altBtn.click();
    await expect(altBtn).toHaveCSS("opacity", "1");
    await expect(airspeedBtn).toHaveCSS("opacity", "0.5");

    await airspeedBtn.click();
    await expect(airspeedBtn).toHaveCSS("opacity", "1");
    await expect(altBtn).toHaveCSS("opacity", "0.5");
  });

  test("airports button toggles airport markers", async ({
    page,
    isMobile,
  }) => {
    test.skip(
      isMobile,
      "The Layers sheet drives this below the breakpoint; see mobile.spec.ts",
    );
    const btn = page.locator(`${LAYERS_GROUP} #airports-btn`);
    await expect(btn.locator("svg.icon")).toHaveCount(1);
    // The separator splits the on/off overlays from the colour layers
    await expect(page.locator(`${LAYERS_GROUP} .control-sep`)).toHaveCount(1);
    await expect(page.locator("#layers-group-title")).toHaveText("Layers");

    await expect(btn).toHaveCSS("opacity", "1");

    await btn.click();
    await expect(btn).toHaveCSS("opacity", "0.5");
    await expect(page.locator(".airport-marker").first()).toBeHidden();

    await btn.click();
    await expect(btn).toHaveCSS("opacity", "1");
    await expect(page.locator(".airport-marker").first()).toBeAttached();
  });

  test("the aviation button toggles the open flightmaps layer", async ({
    page,
    isMobile,
  }) => {
    test.skip(
      isMobile,
      "The Layers sheet drives this below the breakpoint; see mobile.spec.ts",
    );
    const btn = page.locator(`${LAYERS_GROUP} #aviation-btn`);

    await expect(btn).toBeVisible();
    await expect(btn.locator("svg.icon")).toHaveCount(1);
    await expect(btn).toHaveCSS("opacity", "0.5");

    await btn.click();
    await expect(btn).toHaveCSS("opacity", "1");
    expect(await page.evaluate(() => window.mapApp!.aviationVisible)).toBe(
      true,
    );
    await expectAviationTiles(page);

    await btn.click();
    await expect(btn).toHaveCSS("opacity", "0.5");
    await expect.poll(() => aviationOnMap(page)).toBe(false);
  });

  test("the base map is asked for with the CARTO key only when there is one", async ({
    page,
  }) => {
    const key = await page.evaluate(() => window.MAP_CONFIG?.cartoApiKey ?? "");

    const style = await baseMapStyleRequest(page);

    expect(style.pathname).toContain("dark-matter-gl-style");
    expect(style.searchParams.get("key")).toBe(key || null);
  });

  test("airport marker sizes change with zoom level", async ({ page }) => {
    await expect(
      page.locator(".airport-marker-container").first(),
    ).toBeAttached({ timeout: 15000 });

    await zoomAndWaitForMarkerSize(page, 12, "large");
    const largeSize = await page
      .locator(".airport-marker")
      .first()
      .evaluate((el) => el.getBoundingClientRect().width);

    await zoomAndWaitForMarkerSize(page, 6, "small");
    const smallSize = await page
      .locator(".airport-marker")
      .first()
      .evaluate((el) => el.getBoundingClientRect().width);

    expect(smallSize).toBeLessThan(largeSize);
  });

  async function expectSegmentDetails(details: Locator): Promise<void> {
    await expect(details).toBeVisible({ timeout: 5000 });
    await expect(details).toContainText(/Altitude/);
    await expect(details).toContainText(/ft/);
    await expect(details).toContainText(/Groundspeed/);
    await expect(details).toContainText(/kt/);
  }

  test("hovering over path segment shows tooltip with flight data", async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile, "Touch devices have no hover; see the tap test");
    await waitForPathData(page);

    const pos = await findSegmentFarFromAirports(page);
    expect(pos).not.toBeNull();

    await page.mouse.move(pos!.x, pos!.y);

    await expectSegmentDetails(page.locator(".segment-tooltip").first());
  });

  test("tapping a path segment shows a popup with flight data", async ({
    page,
    isMobile,
  }) => {
    test.skip(!isMobile, "Pointer devices show a hover tooltip instead");
    await waitForPathData(page);

    const pos = await findSegmentFarFromAirports(page);
    expect(pos).not.toBeNull();

    await page.locator("#map").click({ position: { x: pos!.x, y: pos!.y } });

    await expectSegmentDetails(mapPopupContent(page).first());
  });

  test("the popup of a tapped path can be closed without touching the flight (regression)", async ({
    page,
    isMobile,
  }) => {
    test.skip(!isMobile, "Pointer devices show a hover tooltip instead");
    await waitForPathData(page);
    const pos = await findSegmentFarFromAirports(page);
    expect(pos).not.toBeNull();
    await page.locator("#map").click({ position: { x: pos!.x, y: pos!.y } });
    await expectSegmentDetails(mapPopupContent(page).first());
    const selected = (): Promise<number> =>
      page.evaluate(() => window.mapApp!.selectedPathIds.size);
    expect(await selected()).toBe(1);

    // The popup stands on the flight that was tapped. It shared the hover
    // tooltip's rule of taking no pointer events, so a tap on its close
    // button went through to that flight and toggled the selection off,
    // and the button itself could not be pressed at all.
    await mapPopupCloseButton(page).click();

    await expect(mapPopup(page)).toHaveCount(0);
    expect(await selected()).toBe(1);
  });

  test("airport labels hidden at low zoom", async ({ page }) => {
    await expect(
      page.locator(".airport-marker-container").first(),
    ).toBeAttached({ timeout: 15000 });

    await setZoom(page, 4);
    await refreshAirportMarkerSizes(page);
    await page.waitForFunction(
      () =>
        document.getElementById("map")?.classList.contains("zoom-hide-labels"),
      { timeout: 5000 },
    );
    await expect(page.locator(".airport-label").first()).toBeHidden();

    await setZoom(page, 8);
    await refreshAirportMarkerSizes(page);
    await page.waitForFunction(
      () =>
        !document.getElementById("map")?.classList.contains("zoom-hide-labels"),
      { timeout: 5000 },
    );
  });

  test("the colour layers follow the filter while the heatmap is off (regression)", async ({
    page,
  }) => {
    await waitForPathData(page);
    await toggleLayer(page, "heatmap");
    await expect.poll(() => heatmapOnMap(page)).toBe(false);

    // An aircraft that flew fewer than all the loaded flights
    const aircraft = await page.evaluate(() => {
      const info = window.mapApp!.fullPathInfo!;
      const counts = new Map<string, number>();
      for (const path of info) {
        const registration = path.aircraft_registration;
        if (registration) {
          counts.set(registration, (counts.get(registration) ?? 0) + 1);
        }
      }
      for (const [registration, count] of counts) {
        if (count < info.length) return registration;
      }
      return null;
    });
    test.skip(aircraft === null, "the site has a single aircraft");
    const before = await pathCount(page, "altitude");

    await setAircraftFilter(page, aircraft!);
    await waitForAircraftFilter(page, aircraft!);

    // The heat layer off the map threw on its new points, and the
    // altitude layer kept every polyline of the previous filter
    await expect.poll(() => pathCount(page, "altitude")).toBeLessThan(before);
  });

  test("the heat canvas stays under the paths across a heatmap toggle", async ({
    page,
  }) => {
    await waitForPathData(page);
    await expectHeatUnderPaths(page);

    await toggleLayer(page, "heatmap");
    await toggleLayer(page, "heatmap");

    // Re-added, the heat canvas is the last child of the pane
    await expectHeatUnderPaths(page);
  });

  test.describe("Heatmap emphasis", () => {
    test("the heatmap steps back while a colour layer is over it", async ({
      page,
    }) => {
      expect(await heatmapOnMap(page)).toBe(true);
      expect(await heatmapOpacity(page)).toBe(1);

      // waitForPathData switches the altitude layer on
      await waitForPathData(page);

      // Its bloom under the gradient washed out the scale just switched on
      await expect.poll(() => heatmapOpacity(page)).toBeLessThan(1);
      expect(await heatmapOpacity(page)).toBeGreaterThan(0);
    });

    test("it comes back to full strength when the layer goes", async ({
      page,
    }) => {
      await waitForPathData(page);
      await expect.poll(() => heatmapOpacity(page)).toBeLessThan(1);

      await toggleLayer(page, "altitude");

      await expect.poll(() => heatmapOpacity(page)).toBe(1);
    });
  });
});
