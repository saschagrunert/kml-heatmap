import { test, expect, type Locator, type Page } from "./fixtures";
import {
  findSegmentFarFromAirports,
  expectToggle,
  gotoApp,
  setAircraftFilter,
  toggleLayer,
  waitForAircraftFilter,
  waitForPathData,
} from "./helpers";
import {
  PATH_POLL,
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

/**
 * The features a GeoJSON source of the app holds, as handed to the map: a
 * heat source is given a Blob URL of its GeoJSON (services/heatSource.ts),
 * which stays valid while the source holds it. Null for none, and for one
 * the source let go of while it was being read.
 */
function sourceFeatures(
  page: Page,
  id: string,
): Promise<{ w?: unknown }[] | null> {
  return page.evaluate(async (id) => {
    const source = window.mapApp!.map!.getStyle().sources[id];
    if (source?.type !== "geojson") return null;
    let data: unknown = source.data;
    if (typeof data === "string") {
      try {
        data = await ((await fetch(data)).json() as Promise<unknown>);
      } catch {
        return null;
      }
    }
    return (data as GeoJSON.FeatureCollection).features.map((feature) => ({
      w: feature.properties?.["w"] as unknown,
    }));
  }, id);
}

/** How many points a GeoJSON source of the app holds, as handed to the map */
async function sourcePoints(page: Page, id: string): Promise<number> {
  return (await sourceFeatures(page, id))?.length ?? 0;
}

/** The heat a GeoJSON source of the app holds, its points' `w` added up */
async function sourceHeat(page: Page, id: string): Promise<number> {
  return ((await sourceFeatures(page, id)) ?? []).reduce(
    (sum, feature) => sum + Number(feature.w ?? 0),
    0,
  );
}

/** The airport codes drawn, beside their dots (ui/airportLabels.ts) */
const SHOWN_CODES = ".airport-code-arm:not(.is-hidden) .airport-code";

/** How many airport codes are drawn in view */
function placedAirportLabels(page: Page): Promise<number> {
  return page.locator(SHOWN_CODES).count();
}

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

// Outside the describe below, whose beforeEach loads the page: WebKit did
// not draw the heat after a second load of the same page (see core.spec.ts)
test("a link of the heat counted by distance opens with the heat", async ({
  page,
}) => {
  // The switch is gone, and its flag in the links shared so far with it
  await gotoApp(page, "/?r=1");
  await expect.poll(() => sourcePoints(page, "heat")).toBeGreaterThan(0);
  await expect.poll(() => sourceHeat(page, "heat")).toBeGreaterThan(0);
});

test.describe("Layers", () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
  });

  test("heatmap button toggles heatmap layer @desktop", async ({
    page,
    isMobile,
  }) => {
    test.skip(
      isMobile,
      "The Layers sheet drives this below the breakpoint; see mobile.spec.ts",
    );
    // Addressed through the named group rather than a position: the button
    // has to be the first under the Layers heading, carrying its own icon
    const btn = page.locator(`${LAYERS_GROUP} #heatmap-btn`);
    await expect(btn.locator("svg.icon")).toHaveCount(1);
    await expect(
      page.locator(`${LAYERS_GROUP} .control-row`).first().locator("button"),
    ).toHaveId("heatmap-btn");
    await expect(page.locator("#by-distance-btn")).toHaveCount(0);

    await btn.click();
    await expectToggle(btn, false);

    await btn.click();
    await expectToggle(btn, true);
  });

  test("the heat legend shows with the heatmap and says what its colours stand for @desktop", async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile, "A phone's map has no legends; see mobile.spec.ts");
    const legend = page.locator("#heat-legend");
    await expect(legend).toBeVisible();
    // One row: which way the time grows, on either side of the bar
    await expect(legend.locator(".labels > *")).toHaveText([
      "Time spent",
      "Less",
      "",
      "More",
    ]);
    // What the ends stand for, under the exposure of the site's flights:
    // about so many passes' worth of time, the last 64 times the first
    const said =
      /^Time spent: blue for about (\d+) pass(es)? of a flight, light cyan for about (\d+), white for many more$/;
    const bar = legend.locator(".gradient-bar");
    await expect(bar).toHaveAttribute("aria-label", said);
    const [, first, , last] = said.exec(
      (await bar.getAttribute("aria-label"))!,
    )!;
    expect(Number(last)).toBe(Number(first) * 64);
    await expect(legend.locator(".labels")).toHaveAttribute(
      "title",
      (await bar.getAttribute("aria-label"))!,
    );
    // Small beside the map: one line of text high
    const box = (await legend.boundingBox())!;
    expect(box.height).toBeLessThan(56);
    await expect(bar).toHaveAttribute("role", "img");
    await expect(bar).toHaveCSS("background-image", /linear-gradient/);
    // What the cloud shows is said in the 3D view only
    await expect(legend.locator("details")).toBeHidden();

    await toggleLayer(page, "heatmap");
    await expect(legend).toBeHidden();
    await toggleLayer(page, "heatmap");
    await expect(legend).toBeVisible();

    // A colour layer brings its own legend in its place
    await toggleLayer(page, "altitude");
    await expect(page.locator("#altitude-legend")).toBeVisible();
    await expect(legend).toBeHidden();
    await toggleLayer(page, "altitude");
    await expect(legend).toBeVisible();
  });

  test("altitude toggle shows altitude layer and legend @desktop", async ({
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

    await expectToggle(altBtn, false);
    await expect(altLegend).toBeHidden();

    await altBtn.click();
    await expectToggle(altBtn, true);
    await expect(altLegend).toBeVisible();

    await expect(page.locator("#legend-min")).toBeVisible();
    await expect(page.locator("#legend-max")).toBeVisible();

    await altBtn.click();
    await expectToggle(altBtn, false);
    await expect(altLegend).toBeHidden();
  });

  test("airspeed toggle shows airspeed layer and legend @desktop", async ({
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

    await expectToggle(airspeedBtn, false);
    await expect(airspeedLegend).toBeHidden();

    await airspeedBtn.click();
    await expectToggle(airspeedBtn, true);
    await expect(airspeedLegend).toBeVisible();

    await expect(page.locator("#airspeed-legend-min")).toBeVisible();
    await expect(page.locator("#airspeed-legend-max")).toBeVisible();

    await airspeedBtn.click();
    await expectToggle(airspeedBtn, false);
    await expect(airspeedLegend).toBeHidden();
  });

  test("altitude and airspeed are mutually exclusive @desktop", async ({
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
    await expectToggle(altBtn, true);
    await expectToggle(airspeedBtn, false);

    await airspeedBtn.click();
    await expectToggle(airspeedBtn, true);
    await expectToggle(altBtn, false);
  });

  test("airports button toggles airport markers @desktop", async ({
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

    await expectToggle(btn, true);

    await btn.click();
    await expectToggle(btn, false);
    await expect(page.locator(".airport-marker").first()).toBeHidden();

    await btn.click();
    await expectToggle(btn, true);
    await expect(page.locator(".airport-marker").first()).toBeAttached();
  });

  test("the aviation button toggles the open flightmaps layer @desktop", async ({
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
    await expectToggle(btn, false);

    await btn.click();
    await expectToggle(btn, true);
    expect(await page.evaluate(() => window.mapApp!.aviationVisible)).toBe(
      true,
    );
    await expectAviationTiles(page);

    await btn.click();
    await expectToggle(btn, false);
    await expect.poll(() => aviationOnMap(page)).toBe(false);
  });

  test("the base map is asked for with the CARTO key only when there is one @keys", async ({
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

  test("hovering over path segment shows tooltip with flight data @desktop", async ({
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

  test("tapping a path segment shows a popup with flight data @touch", async ({
    page,
    isMobile,
  }) => {
    test.skip(!isMobile, "Pointer devices show a hover tooltip instead");
    await waitForPathData(page);

    const pos = await findSegmentFarFromAirports(page);
    expect(pos).not.toBeNull();

    // A tap: a click with the mouse of a touch laptop toggles the flight
    await page.locator("#map").tap({ position: { x: pos!.x, y: pos!.y } });

    await expectSegmentDetails(mapPopupContent(page).first());
  });

  test("the popup of a tapped path can be closed without touching the flight (regression) @touch", async ({
    page,
    isMobile,
  }) => {
    test.skip(!isMobile, "Pointer devices show a hover tooltip instead");
    await waitForPathData(page);
    const pos = await findSegmentFarFromAirports(page);
    expect(pos).not.toBeNull();
    await page.locator("#map").tap({ position: { x: pos!.x, y: pos!.y } });
    await expectSegmentDetails(mapPopupContent(page).first());
    const selected = (): Promise<number> =>
      page.evaluate(() => window.mapApp!.selectedPathIds.size);
    // Looking at a flight does not select it
    expect(await selected()).toBe(0);

    // The popup stands on the flight that was tapped. It shared the hover
    // tooltip's rule of taking no pointer events, so a tap on its close
    // button went through to that flight and toggled the selection,
    // and the button itself could not be pressed at all.
    await mapPopupCloseButton(page).click();

    await expect(mapPopup(page)).toHaveCount(0);
    expect(await selected()).toBe(0);
  });

  test("a tapped path is selected with the button of its popup @touch", async ({
    page,
    isMobile,
  }) => {
    test.skip(!isMobile, "Pointer devices select with a click");
    await waitForPathData(page);
    const pos = await findSegmentFarFromAirports(page);
    expect(pos).not.toBeNull();
    await page.locator("#map").tap({ position: { x: pos!.x, y: pos!.y } });

    const select = mapPopup(page).locator(".segment-action");
    await expect(select).toHaveText("Select flight");
    await select.tap();

    await expect(mapPopup(page)).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() => window.mapApp!.selectedPathIds.size))
      .toBe(1);
  });

  test("airport codes are drawn beside their dots, and none zoomed out", async ({
    page,
  }) => {
    await expect(
      page.locator(".airport-marker-container").first(),
    ).toBeAttached({ timeout: 15000 });

    // State zoom: one above the map's
    await setZoom(page, 8);
    await expect.poll(() => placedAirportLabels(page)).toBeGreaterThan(0);

    // Below the zoom of the codes
    await setZoom(page, 4);
    await expect.poll(() => placedAirportLabels(page)).toBe(0);
  });

  test("a click on an airport's code opens its popup, as the marker does", async ({
    page,
  }) => {
    await expect(
      page.locator(".airport-marker-container").first(),
    ).toBeAttached({ timeout: 15000 });
    await setZoom(page, 8);
    await expect.poll(() => placedAirportLabels(page)).toBeGreaterThan(0);

    // A code that has come to rest: it glides while the map settles
    const code = page.locator(SHOWN_CODES).first();
    const icao = (await code.textContent())!;
    await code.click();

    await expect(mapPopupContent(page)).toContainText(icao);
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
    await expect
      .poll(() => pathCount(page, "altitude"), PATH_POLL)
      .toBeLessThan(before);
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
