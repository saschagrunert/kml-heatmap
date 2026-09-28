/**
 * The base map's style is fetched behind the flights' back: the map starts
 * on a plain background, the flights are drawn on it at once, and CARTO's
 * style goes under them whenever it answers, if it ever does.
 */
import {
  BASE_STYLE_LABELS,
  expect,
  failBaseStyle,
  holdBaseStyle,
  test,
  type Page,
} from "./fixtures";
import {
  activateReplay,
  attachErrorCollectors,
  findSegmentFarFromAirports,
  firstPathId,
  gotoApp,
  playUntilProgress,
  relevantConsoleErrors,
  toggleLayer,
  togglePathSelection,
  waitForPathData,
} from "./helpers";
import {
  attributionControl,
  expectHeatmapPainted,
  flightsOnMap,
  segmentDetails,
} from "./map";

/** The layers of the flights, bottom to top (MAP_LAYERS in constants.ts) */
const FLIGHT_LAYERS = [
  "aviation",
  "heat",
  "heat-isolated",
  "heat-lines-glow",
  "heat-lines-core",
  "selection-highlight",
  "replay-route",
  "paths-altitude",
  "paths-airspeed",
  "paths-altitude-selected",
  "paths-airspeed-selected",
  "replay-trail",
  "paths-altitude-3d",
  "paths-airspeed-3d",
  "paths-altitude-selected-3d",
  "paths-airspeed-selected-3d",
  "selection-highlight-3d",
  "replay-trail-3d",
];

/** The airport codes, a label layer on top of all (ui/airportLabels.ts) */
const AIRPORT_LABELS = "airport-labels";

/** Flights on the map in every way the app changes a layer at runtime */
async function drawFlights(page: Page): Promise<void> {
  await gotoApp(page);
  await waitForPathData(page);
  await expectHeatmapPainted(page);
  // A selection fills a second source and dims the layer of the others
  await togglePathSelection(page, await firstPathId(page), 1);
  await toggleLayer(page, "aviation");
}

async function expectSegmentUnderPointer(page: Page): Promise<void> {
  const at = await findSegmentFarFromAirports(page);
  expect(at).not.toBeNull();
  await page.mouse.move(at!.x, at!.y);
  await expect(segmentDetails(page).first()).toBeVisible();
}

test.describe("Base style", () => {
  test("arrives late: the flights are there before it, and unchanged and in order after it", async ({
    page,
  }) => {
    const errors = await attachErrorCollectors(page);
    const release = await holdBaseStyle(page);

    await drawFlights(page);
    const before = await flightsOnMap(page);

    expect(before.layers).toEqual([
      "background",
      ...FLIGHT_LAYERS,
      AIRPORT_LABELS,
    ]);
    expect(before.drawn.heat).toBeGreaterThan(0);
    expect(before.drawn.paths).toBeGreaterThan(0);
    expect(before.features["paths-altitude-selected"]).toBeGreaterThan(0);
    // Not worked out while the colour layer draws the selection itself
    // (ui/selectionHighlight.ts)
    expect(before.features["selection-highlight"]).toBe(0);
    await expect(attributionControl(page)).not.toContainText("CARTO");

    release();
    await expect
      .poll(async () => (await flightsOnMap(page)).layers)
      .toContain(BASE_STYLE_LABELS);
    // Also fails when the map made one of the flights' sources anew
    const after = await flightsOnMap(page);

    expect(after.layers).toEqual([
      "background",
      "base",
      ...FLIGHT_LAYERS,
      BASE_STYLE_LABELS,
      AIRPORT_LABELS,
    ]);
    expect(after.looks).toEqual(before.looks);
    expect(after.features).toEqual(before.features);
    expect(after.drawn).toEqual(before.drawn);
    await expect(attributionControl(page)).toContainText("CARTO");
    // The tiles still answer for the flights, and not as out of date
    await expectSegmentUnderPointer(page);
    // Zoomed in to where the overlay is drawn, which is when it is credited
    await expect(attributionControl(page)).toContainText("open flightmaps");
    expect(relevantConsoleErrors(errors)).toEqual([]);
  });

  test("arrives during a replay: the trail, the route and the airplane stay", async ({
    page,
  }) => {
    const release = await holdBaseStyle(page);
    const pause = page.locator("#replay-pause-btn");
    const clock = (): Promise<number> =>
      page.evaluate(() => window.mapApp!.replayState.currentTime);

    await gotoApp(page);
    await activateReplay(page);
    await playUntilProgress(page);
    await pause.click();
    const before = await flightsOnMap(page);
    expect(before.features["replay-route"]).toBeGreaterThan(0);
    expect(before.features["replay-trail"]).toBeGreaterThan(0);

    // Released while the replay runs and writes its trail every frame
    await page.locator("#replay-play-btn").click();
    const releasedAt = await clock();
    release();
    await page.waitForFunction(
      (labels) => !!window.mapApp!.map!.getLayer(labels),
      BASE_STYLE_LABELS,
    );
    await expect.poll(clock).toBeGreaterThan(releasedAt);
    await pause.click();
    const after = await flightsOnMap(page);

    expect(after.layers).toEqual([
      "background",
      "base",
      ...FLIGHT_LAYERS,
      BASE_STYLE_LABELS,
      AIRPORT_LABELS,
    ]);
    expect(after.features["replay-route"]).toBe(
      before.features["replay-route"],
    );
    expect(after.features["replay-trail"]).toBeGreaterThanOrEqual(
      before.features["replay-trail"]!,
    );
    await expect(page.locator(".replay-airplane-root")).toBeVisible();
  });

  test("never arrives: the app is all there on the plain background", async ({
    page,
  }) => {
    await failBaseStyle(page);

    await drawFlights(page);
    const flights = await flightsOnMap(page);

    expect(flights.layers).toEqual([
      "background",
      ...FLIGHT_LAYERS,
      AIRPORT_LABELS,
    ]);
    expect(flights.drawn.heat).toBeGreaterThan(0);
    expect(flights.drawn.paths).toBeGreaterThan(0);
    await expectSegmentUnderPointer(page);
    await expect(attributionControl(page)).toContainText("open flightmaps");
    await toggleLayer(page, "heatmap");
    expect((await flightsOnMap(page)).looks).not.toEqual(flights.looks);
  });
});
