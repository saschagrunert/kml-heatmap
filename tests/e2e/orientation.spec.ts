/**
 * Turning and tilting the map, and the globe.
 *
 * The gestures are MapLibre's own; what is the page's is the way back (the
 * compass), the switch to the globe, and everything that used to assume a
 * flat map with north at the top: the airplane of a replay, the overview of
 * the year in review, the markers on the far side of a globe. The shared
 * link and the phone layout are covered in state.spec.ts and mobile.spec.ts,
 * which the mobile project runs as well.
 */
import {
  test,
  expect,
  slopeElevationM,
  TERRAIN_ELEVATION_M,
  type Locator,
  type Page,
} from "./fixtures";
import {
  activateReplay,
  expectNoA11yViolations,
  findSegmentFarFromAirports,
  gotoApp,
  openWrapped,
  toggleLayer,
  waitForPathData,
} from "./helpers";
import {
  airportPosition,
  centerOnAirport,
  coveredMarkers,
  dragRotate,
  focusAirportMarker,
  getOrientation,
  jumpToView,
  libraryOrientationControls,
  mapMarkers,
  mapPopup,
  mapSurface,
  segmentDetails,
  setOrientation,
  setView,
  zoomControl,
} from "./map";

const compass = (page: Page): Locator => page.locator("#compass-btn");
const globe = (page: Page): Locator => page.locator("#globe-btn");

/** Degrees the compass needle is turned by, clockwise */
function needleTurn(page: Page): Promise<number> {
  return compass(page).evaluate((button) =>
    parseFloat(button.style.getPropertyValue("--compass-turn")),
  );
}

/** Degrees the airplane of the replay is drawn at, clockwise from the top */
function airplaneRotation(page: Page): Promise<number> {
  return page.locator(".replay-airplane-icon").evaluate((icon) => {
    const match = /rotate\((-?[\d.]+)deg\)/.exec(icon.style.transform);
    if (!match) throw new Error("the airplane has no rotation yet");
    return ((Number(match[1]) % 360) + 360) % 360;
  });
}

/**
 * The relief of the 3D view in software WebGL draws a frame in half a
 * second to two and a half on one core, where the flat map takes a tenth
 * of that, and the map asks for the tiles of the view as it draws: with a
 * browser per core of the CI runner a frame took four seconds, and a view
 * with the relief a minute to complete. Cutting the flights anew on the
 * other ground holds the page up for seconds there as well. A smaller map
 * (RELIEF_VIEWPORT) without the heat draws a frame a third faster.
 */
const RELIEF_TIMEOUT_MS = 60000;
/**
 * What the relief's specs wait for: any step may wait on a frame of the
 * relief, which took up to 16 s with a browser per core
 */
const reliefExpect = expect.configure({ timeout: RELIEF_TIMEOUT_MS });
/** A test that enters the relief, three waits of RELIEF_TIMEOUT_MS */
const RELIEF_TEST_TIMEOUT_MS = 180000;
/** Still the desktop layout (MOBILE_BREAKPOINT_PX), half the pixels of 720p */
const RELIEF_VIEWPORT = { width: 800, height: 500 };

/** The relief the map draws, null for none */
function relief(page: Page): Promise<unknown> {
  return page.evaluate(() => window.mapApp!.map!.getTerrain());
}

/**
 * The ground the relief stands on in the middle of the map, exaggerated;
 * null until its elevation tile landed
 */
function ground(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const map = window.mapApp!.map!;
    return map.queryTerrainElevation(map.getCenter());
  });
}

/** Whether the shading of the relief shows, "absent" before it exists */
function hillshade(page: Page): Promise<unknown> {
  return page.evaluate(() => {
    const map = window.mapApp!.map!;
    return map.getLayer("terrain-hillshade")
      ? map.getLayoutProperty("terrain-hillshade", "visibility")
      : "absent";
  });
}

/**
 * Whether the ribbons show and their tiles have all been drawn.
 * ui/terrain.ts shows the ribbons once they have, or after a few seconds
 * at most, which a slow frame in software WebGL takes. Not every elevation
 * tile in view: towards the horizon of the tilted map they are many, and
 * with a browser per core they took up to a minute to land after the
 * ribbons had, while what is checked is in the middle of the map. The
 * specs poll for the relief there instead.
 */
function ribbonsSettled(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const app = window.mapApp!;
    const map = app.map!;
    return (
      app.layerManager.ribbonsShown === 1 &&
      Object.keys(map.getStyle().sources)
        .filter((id) => id.endsWith("-3d"))
        .every((id) => map.isSourceLoaded(id))
    );
  });
}

/**
 * Move to `coord` at map zoom 11 (the state's 12), where the relief is
 * drawn from the deepest elevation tiles, on a smaller map
 * (RELIEF_VIEWPORT) without the heat, which none of the relief's specs
 * look at, turn the 3D view on and wait until the ribbons stand on the
 * relief (ribbonsSettled)
 */
async function enterRelief(
  page: Page,
  coord: readonly [number, number],
): Promise<void> {
  await page.setViewportSize(RELIEF_VIEWPORT);
  await toggleLayer(page, "heatmap");
  // Zoomed in first, the flights are cut for the 3D view once, on the
  // relief, rather than for the whole map and then again
  await jumpToView(page, coord, 12);
  await page.locator("#three-d-btn").click();
  await reliefExpect(page.locator("#three-d-btn")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await reliefExpect
    .poll(() => relief(page))
    .toMatchObject({ source: "terrain" });
  await reliefExpect.poll(() => ribbonsSettled(page)).toBe(true);
}

/**
 * Find a point of the map where a ribbon of one flight alone is drawn, put
 * the pointer there, and expect the tooltip of that flight: the hit test
 * looks for the ribbon through `unproject`, which meets the relief. Tried
 * again until it holds: the elevation tiles still landing move the ribbons
 * on the screen between the search and the pointer.
 */
async function expectRibbonUnderPointer(page: Page): Promise<void> {
  await expect(() => ribbonUnderPointer(page)).toPass({
    timeout: RELIEF_TIMEOUT_MS,
  });
}

async function ribbonUnderPointer(page: Page): Promise<void> {
  const ribbon = await page.evaluate(() => {
    const map = window.mapApp!.map!;
    const layers = ["paths-altitude-3d", "paths-altitude-selected-3d"];
    const { clientWidth: width, clientHeight: height } = map.getContainer();
    // From the middle out: towards the horizon the ribbons are thin, and
    // the hit test measures their lift by the middle of the map
    const rows = [];
    for (let y = 20; y < height - 20; y += 6) rows.push(y);
    rows.sort((a, b) => Math.abs(a - height / 2) - Math.abs(b - height / 2));
    for (const y of rows) {
      for (let x = width / 4; x < (width * 3) / 4; x += 6) {
        if (map.queryRenderedFeatures([x, y], { layers }).length === 0) {
          continue;
        }
        const around = map.queryRenderedFeatures(
          [
            [x - 10, y - 10],
            [x + 10, y + 10],
          ],
          { layers },
        );
        const pathIds = new Set(
          around.map((feature) => feature.properties["pathId"] as number),
        );
        if (pathIds.size === 1) return { x, y, pathId: [...pathIds][0]! };
      }
    }
    return null;
  });
  expect(ribbon).not.toBeNull();
  const box = (await mapSurface(page).boundingBox())!;
  await page.mouse.move(box.x + ribbon!.x, box.y + ribbon!.y);
  await expect(segmentDetails(page).first()).toBeVisible();
  const hit = await page.evaluate(
    ({ x, y }) => window.mapApp!.layerManager.hitTest({ x, y } as never),
    ribbon!,
  );
  expect(hit).toMatchObject({ pathId: ribbon!.pathId });
}

test.describe("Map orientation", () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
  });

  test("opens north up, flat and in Mercator, with the page's own controls", async ({
    page,
  }) => {
    expect(await getOrientation(page)).toEqual({
      bearing: 0,
      pitch: 0,
      projection: "mercator",
    });
    await expect(compass(page)).toBeVisible();
    await expect(globe(page)).toHaveAttribute("aria-pressed", "false");
    // The floating compass belongs to the phone layout
    await expect(page.locator("#compass-float-btn")).toBeHidden();
    await expect(libraryOrientationControls(page)).toHaveCount(0);
    await expect(zoomControl(page)).toHaveCount(0);
  });

  test("a drag with the right button turns the map, and the compass turns it back", async ({
    page,
  }) => {
    await dragRotate(page, 200);

    await expect
      .poll(async () => Math.abs((await getOrientation(page)).bearing))
      .toBeGreaterThan(10);
    // The needle points to where north went: the other way round. The map
    // may still be turning from the drag (WebKit carries it on), so the
    // bearing and the needle are read again until they agree
    await expect
      .poll(async () => {
        const { bearing } = await getOrientation(page);
        return Math.abs((await needleTurn(page)) + bearing);
      })
      .toBeLessThan(0.001);

    await compass(page).click();

    await expect
      .poll(() => getOrientation(page))
      .toMatchObject({ bearing: 0, pitch: 0 });
    expect(await needleTurn(page)).toBe(0);
  });

  test("the compass lays a tilted map flat as well", async ({ page }) => {
    await setOrientation(page, { bearing: 0, pitch: 50 });

    await compass(page).click();

    await expect.poll(() => getOrientation(page)).toMatchObject({ pitch: 0 });
  });

  test("the globe switch changes the projection and back", async ({ page }) => {
    await globe(page).click();

    await expect(globe(page)).toHaveAttribute("aria-pressed", "true");
    await expect
      .poll(() => getOrientation(page))
      .toMatchObject({ projection: "globe" });

    await globe(page).click();

    await expect(globe(page)).toHaveAttribute("aria-pressed", "false");
    await expect
      .poll(() => getOrientation(page))
      .toMatchObject({ projection: "mercator" });
  });

  test.describe("on the relief", () => {
    // One after the other in one worker, not side by side: a frame of the
    // relief takes seconds in software WebGL, and with two of them drawn
    // at once besides the other specs of the run, a step took as long as
    // their waits allow
    test.describe.configure({ mode: "default" });

    test("the 3D view draws the relief, the flights on it stay under the pointer, and the globe only shades it", async ({
      page,
    }) => {
      test.setTimeout(RELIEF_TEST_TIMEOUT_MS);
      // A flight well away from the airports, whose markers lie over it
      const at = await findSegmentFarFromAirports(page);
      expect(at).not.toBeNull();
      const coord = [at!.coord[0]!, at!.coord[1]!] as const;
      await enterRelief(page, coord);
      // The relief stands on the elevation tiles: the flat ground of the
      // fixture, exaggerated
      const { exaggeration } = (await relief(page)) as { exaggeration: number };
      await reliefExpect
        .poll(() => ground(page))
        .toBeCloseTo(TERRAIN_ELEVATION_M * exaggeration, 0);
      await reliefExpect.poll(() => hillshade(page)).not.toBe("none");
      expect(await hillshade(page)).not.toBe("absent");
      expect(
        await page.evaluate(() => window.mapApp!.map!.getPitch()),
      ).toBeGreaterThan(20);
      // The flat ground of the fixture is 500 m up, 1 km with the
      // exaggeration: a ribbon is found only where it is drawn over it
      await expectRibbonUnderPointer(page);

      // The globe shades the relief but leaves it out, and the flights stand
      // on the line between their fields there
      await globe(page).click();
      await reliefExpect
        .poll(() => getOrientation(page))
        .toMatchObject({ projection: "globe" });
      await reliefExpect.poll(() => relief(page)).toBeNull();
      expect(await hillshade(page)).not.toBe("none");
      expect(
        await page.evaluate(() => window.mapApp!.store.get("reliefShaded")),
      ).toBe(true);
      await globe(page).click();
      await reliefExpect
        .poll(() => relief(page))
        .toMatchObject({ source: "terrain" });
    });

    // A test of its own: every step on the relief waits on its frames, and
    // with the one above this took longer than RELIEF_TEST_TIMEOUT_MS
    test("zoomed out, the 3D view still draws the relief, exaggerated more and the flights as much", async ({
      page,
    }) => {
      test.setTimeout(RELIEF_TEST_TIMEOUT_MS);
      const at = await findSegmentFarFromAirports(page);
      expect(at).not.toBeNull();
      const coord = [at!.coord[0]!, at!.coord[1]!] as const;
      await enterRelief(page, coord);
      const { exaggeration } = (await relief(page)) as { exaggeration: number };

      // Asked for one by one rather than by waiting for the map to be idle,
      // which takes the base map and the heat of the whole view along (see
      // jumpToView)
      await jumpToView(page, coord, 8);
      await reliefExpect
        .poll(
          async () =>
            ((await relief(page)) as { exaggeration: number } | null)
              ?.exaggeration,
        )
        .toBeGreaterThan(exaggeration);
      await reliefExpect.poll(() => ribbonsSettled(page)).toBe(true);
      const lifted = await page.evaluate(() => {
        const map = window.mapApp!.map!;
        return {
          relief: map.getTerrain()!.exaggeration ?? 1,
          ribbons: [
            ...new Set(
              map
                .querySourceFeatures("paths-altitude-3d")
                .map((feature) => feature.properties["e"] as number),
            ),
          ],
        };
      });
      expect(lifted.ribbons).toEqual([lifted.relief]);
      await reliefExpect
        .poll(() => ground(page))
        .toBeCloseTo(TERRAIN_ELEVATION_M * lifted.relief, 0);
      expect(await hillshade(page)).not.toBe("none");

      // Out of the 3D view: no relief, and no shading
      await page.locator("#three-d-btn").click();
      await reliefExpect.poll(() => relief(page)).toBeNull();
      expect(await hillshade(page)).toBe("none");
      expect(
        await page.evaluate(() => window.mapApp!.store.get("terrainActive")),
      ).toBe(false);
    });

    test.describe("on a slope", () => {
      // Elevation tiles that rise and fall with the longitude (see
      // slopeElevationM). The ribbons stand on the ground the build sampled
      // from the real elevation tiles, so they do not follow this one; what
      // is checked is what uses the relief the page draws: the elevation the
      // map reads from it, the markers on it, and the pointer finding the
      // flights over it.
      test.use({ terrain: "slope" });

      test("the relief rises and falls with the ground, and the airports and the flights stand where it is drawn", async ({
        page,
      }) => {
        test.setTimeout(RELIEF_TEST_TIMEOUT_MS);
        const at = await findSegmentFarFromAirports(page);
        expect(at).not.toBeNull();
        const coord = [at!.coord[0]!, at!.coord[1]!] as const;
        await enterRelief(page, coord);

        // Two points on the same flank, a tenth of a degree apart, near the
        // middle of the map where the elevation tiles are loaded
        const flank = Math.floor(coord[1] * 2) / 2;
        const west = Math.min(
          Math.max(coord[1] - 0.05, flank + 0.01),
          flank + 0.39,
        );
        const east = west + 0.1;
        const readRelief = (): Promise<{
          exaggeration: number;
          elevations: (number | null)[];
        }> =>
          page.evaluate(
            ([lat, lngs]) => {
              const map = window.mapApp!.map!;
              return {
                exaggeration: map.getTerrain()!.exaggeration ?? 1,
                elevations: lngs.map((lng) =>
                  map.queryTerrainElevation([lng, lat]),
                ),
              };
            },
            [coord[0], [west, east]] as const,
          );
        // Until the elevation tile under a point has landed, the map answers
        // from a coarser one or not at all, so the reading is polled
        const offBy = async (): Promise<number> => {
          const { exaggeration, elevations } = await readRelief();
          const [westM, eastM] = elevations;
          if (westM == null || eastM == null) return Infinity;
          return Math.max(
            Math.abs(westM - slopeElevationM(west) * exaggeration),
            Math.abs(eastM - slopeElevationM(east) * exaggeration),
          );
        };
        const { exaggeration } = await readRelief();
        // 200 m either way on the ground, twice that with the exaggeration
        expect(
          Math.abs(
            (slopeElevationM(east) - slopeElevationM(west)) * exaggeration,
          ),
        ).toBeGreaterThan(300);
        await reliefExpect.poll(offBy).toBeLessThan(10);

        // The pointer finds a flight over the slope, the one drawn there
        await expectRibbonUnderPointer(page);

        // An airport off the middle of the map, on ground a few hundred
        // metres higher or lower than the middle: its marker is where the
        // relief under it is drawn, so pointing there finds the airport
        const name = await page.evaluate(
          () => Object.keys(window.mapApp!.airportMarkers)[0]!,
        );
        const [lat, lng] = await airportPosition(page, name);
        const side = Math.floor(lng * 2) / 2 + 0.25 > lng ? 0.1 : -0.1;
        await jumpToView(page, [lat - 0.02, lng + side], 12);
        const measure = (): Promise<{ ground: number[]; rise: number }> =>
          page.evaluate((airport) => {
            const map = window.mapApp!.map!;
            const marker = window.mapApp!.airportMarkers[airport]!;
            const box = marker.getElement().getBoundingClientRect();
            const container = map.getContainer().getBoundingClientRect();
            const point: [number, number] = [
              box.x + box.width / 2 - container.x,
              box.y + box.height / 2 - container.y,
            ];
            const { lat, lng } = marker.getLatLng();
            const ground = map.unproject(point);
            // Null until the tile under a point has landed: no rise yet
            const at = map.queryTerrainElevation([lng, lat]);
            const middle = map.queryTerrainElevation(map.getCenter());
            return {
              ground: [ground.lat, ground.lng],
              rise: at === null || middle === null ? NaN : at - middle,
            };
          }, name);
        // The elevation tiles under the airport and the middle land one by one,
        // and in software WebGL the whole map is not loaded for minutes, so the
        // placement itself is polled rather than map.loaded()
        const off = (p: { ground: number[]; rise: number }): number =>
          Math.abs(p.rise) > 150
            ? Math.max(
                Math.abs(p.ground[0]! - lat) / 0.0005,
                Math.abs(p.ground[1]! - lng) / 0.0008,
              )
            : Infinity;
        await reliefExpect
          .poll(async () => off(await measure()))
          .toBeLessThan(1);
        const placed = await measure();
        expect(Math.abs(placed.rise)).toBeGreaterThan(150);
        // About 50 m; a marker at the height of the middle of the map would
        // point at ground a kilometre or more away
        expect(Math.abs(placed.ground[0]! - lat)).toBeLessThan(0.0005);
        expect(Math.abs(placed.ground[1]! - lng)).toBeLessThan(0.0008);
      });
    });
  });

  test("the controls and the map itself work by keyboard", async ({ page }) => {
    // Both are buttons in the tab order, named for what they do
    for (const control of [globe(page), compass(page)]) {
      expect(await control.evaluate((el) => (el as HTMLElement).tabIndex)).toBe(
        0,
      );
    }
    await expect(globe(page)).toHaveAccessibleName(/globe/i);
    await expect(compass(page)).toHaveAccessibleName(/north up/i);

    await globe(page).focus();
    await page.keyboard.press("Space");
    await expect(globe(page)).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Enter");
    await expect(globe(page)).toHaveAttribute("aria-pressed", "false");

    // Shift with the arrow keys turns and tilts the focused map
    await mapSurface(page).focus();
    await page.keyboard.press("Shift+ArrowRight");
    await page.keyboard.press("Shift+ArrowUp");
    await expect
      .poll(async () => (await getOrientation(page)).bearing)
      .not.toBe(0);
    await expect
      .poll(async () => (await getOrientation(page)).pitch)
      .toBeGreaterThan(0);

    await compass(page).focus();
    await page.keyboard.press("Enter");
    await expect
      .poll(() => getOrientation(page))
      .toMatchObject({ bearing: 0, pitch: 0 });
    await expect(compass(page)).toBeFocused();
  });

  test("a globe hides the markers on its far side and shows them again", async ({
    page,
  }) => {
    await globe(page).click();
    const total = await mapMarkers(page).count();
    expect(total, "airports on the map").toBeGreaterThan(0);

    // The other side of the world from the flights
    const bounds = await page.evaluate(() => window.MAP_CONFIG!.bounds);
    const lat = (bounds[0][0] + bounds[1][0]) / 2;
    const lng = (bounds[0][1] + bounds[1][1]) / 2;
    await setView(page, [-lat, lng > 0 ? lng - 180 : lng + 180], 3);

    await expect(coveredMarkers(page)).toHaveCount(total);
    // Hidden for good, not faded: no click and no tab stop for such a place
    await expect(mapMarkers(page).first()).toBeHidden();

    await setView(page, [lat, lng], 5);

    await expect(coveredMarkers(page)).toHaveCount(0);
    await expect(mapMarkers(page).first()).toBeVisible();
  });

  test("a globe that turns an airport away closes its popup and takes its focus", async ({
    page,
  }) => {
    await globe(page).click();
    await waitForPathData(page);
    const name = await page.evaluate(
      () => Object.keys(window.mapApp!.airportMarkers)[0]!,
    );
    await centerOnAirport(page, name, 4);
    await focusAirportMarker(page, name);
    await page.keyboard.press("Enter");
    await expect(mapPopup(page)).toBeVisible();
    // Focus is in the popup now; back on the marker, as after a Shift+Tab
    await focusAirportMarker(page, name);

    // MapLibre would leave the popup over whatever is drawn there now, and
    // a marker that is hidden while it has focus drops the focus to <body>
    const [lat, lng] = await airportPosition(page, name);
    await setView(page, [-lat, lng > 0 ? lng - 180 : lng + 180], 4);

    await expect(mapPopup(page)).toHaveCount(0);
    await expect(mapSurface(page)).toBeFocused();
    await expect(coveredMarkers(page)).not.toHaveCount(0);
  });

  test("a turned, tilted globe has no WCAG A/AA violations", async ({
    page,
  }) => {
    await globe(page).click();
    await setOrientation(page, { bearing: 60, pitch: 40 });

    await expectNoA11yViolations(page, "turned globe");
  });

  test("the airplane of a replay points along its track on screen", async ({
    page,
  }) => {
    await activateReplay(page);
    const northUp = await airplaneRotation(page);

    // The replay leaves the orientation to the user, and the icon follows
    // it without a frame of the replay to say so
    await setOrientation(page, { bearing: 90, pitch: 0 });

    await expect
      .poll(async () => {
        const turned = await airplaneRotation(page);
        return (((northUp - turned) % 360) + 360) % 360;
      })
      // To half a degree: the heading is measured over a few pixels
      .toBeCloseTo(90, 0);
    expect(await getOrientation(page)).toMatchObject({ bearing: 90 });
  });

  test("the year in review lays the map flat and gives the view back", async ({
    page,
  }) => {
    await setOrientation(page, { bearing: 120, pitch: 45 });

    const modal = await openWrapped(page);
    await expect
      .poll(() => getOrientation(page))
      .toMatchObject({ bearing: 0, pitch: 0 });
    // The link keeps saying where the user was
    await expect
      .poll(() => new URL(page.url()).searchParams.get("b"))
      .toBe("120");

    await modal.locator(".close-btn").click();

    await expect
      .poll(() => getOrientation(page))
      .toMatchObject({ bearing: 120, pitch: 45 });
  });
});
