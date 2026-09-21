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
import { test, expect, type Locator, type Page } from "./fixtures";
import {
  activateReplay,
  expectNoA11yViolations,
  gotoApp,
  openWrapped,
  waitForPathData,
} from "./helpers";
import {
  airportPosition,
  centerOnAirport,
  coveredMarkers,
  dragRotate,
  focusAirportMarker,
  getOrientation,
  libraryOrientationControls,
  mapMarkers,
  mapPopup,
  mapSurface,
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
    // The needle points to where north went: the other way round
    const { bearing } = await getOrientation(page);
    expect(await needleTurn(page)).toBeCloseTo(-bearing, 3);

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
