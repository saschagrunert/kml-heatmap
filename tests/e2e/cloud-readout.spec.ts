/**
 * The readout of the heat cloud of the 3D view under the pointer
 * (ui/cloudReadout.ts): the time spent around the place pointed at, the
 * flights that were there and the height most of it was spent at.
 *
 * The numbers come from the flights, not from the pixels, so the spec
 * checks the shape of the words and not their values: the readout comes up
 * near the home field once the cloud is on the map, beside the ribbons
 * coloured by altitude and the markers, stands clear of the values of a
 * ribbon, and goes with Escape. What the words
 * say for given flights is the unit tests' (tests/frontend/unit/
 * calculations/cloudReadout.test.ts).
 */
import { test, expect, HEAVY, type Page } from "./fixtures";
import { gotoApp, layerButton } from "./helpers";
import {
  airportPosition,
  containerPoint,
  heatCloudOnMap,
  jumpToView,
  mapSurface,
} from "./map";

/**
 * The 3D view draws a frame in software WebGL in up to seconds on CI, and
 * cuts the flights anew for the relief on the way (see 3d-relief.spec.ts):
 * a single look into the page took up to 26 s there, so every check after
 * the 3D view comes on waits this long
 */
const RELIEF_TIMEOUT_MS = 60000;
const reliefExpect = expect.configure({ timeout: RELIEF_TIMEOUT_MS });

/** The name of the home field's marker: the field most flights start at */
function homeField(page: Page): Promise<string> {
  return page.evaluate(() => {
    const app = window.mapApp!;
    const starts = new Map<string, number>();
    for (const info of app.store.get("currentData")!.path_info) {
      const name = info.start_airport;
      if (name && app.airportMarkers[name]) {
        starts.set(name, (starts.get(name) ?? 0) + 1);
      }
    }
    const [home] = [...starts].sort((a, b) => b[1] - a[1])[0]!;
    return home;
  });
}

/**
 * A place a flight passed low over, 600 m to 1.5 km from `field`: well off
 * its marker, and where the line of sight through it meets the flight at
 * the ground under the pointer, however tilted the map is. The middle of
 * the first segment of the year shown that was less than 300 ft above its
 * ground there (the build's, or the lowest the flight was).
 */
function lowPassNear(
  page: Page,
  [lat, lng]: readonly [number, number],
): Promise<[number, number] | null> {
  return page.evaluate(
    ([fieldLat, fieldLng]) => {
      const segments = window.mapApp!.store.get("currentData")!.path_segments;
      const lowest = new Map<number, number>();
      for (const { path_id, altitude_ft } of segments) {
        lowest.set(
          path_id,
          Math.min(lowest.get(path_id) ?? Infinity, altitude_ft),
        );
      }
      const across = Math.cos((fieldLat * Math.PI) / 180);
      for (const segment of segments) {
        const [[lat0, lng0], [lat1, lng1]] = segment.coords;
        const middle: [number, number] = [(lat0 + lat1) / 2, (lng0 + lng1) / 2];
        const metres =
          111195 *
          Math.hypot(middle[0] - fieldLat, (middle[1] - fieldLng) * across);
        const ground = segment.ground_ft ?? lowest.get(segment.path_id)!;
        if (
          metres > 600 &&
          metres < 1500 &&
          segment.altitude_ft - ground < 300
        ) {
          return middle;
        }
      }
      return null;
    },
    [lat, lng] as const,
  );
}

/** Whether the readout and the values of a ribbon overlap on the screen */
function readoutOverValues(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const readout = document
      .querySelector(".cloud-readout:not([hidden])")
      ?.getBoundingClientRect();
    const values = document
      .querySelector(".segment-tooltip")
      ?.getBoundingClientRect();
    return (
      !!readout &&
      !!values &&
      readout.left < values.right &&
      values.left < readout.right &&
      readout.top < values.bottom &&
      values.top < readout.bottom
    );
  });
}

test.describe("the readout of the heat cloud", HEAVY, () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
  });

  test("resting the pointer near the home field in the 3D view, beside the ribbons, tells the time spent there, the flights and the height", async ({
    page,
  }) => {
    test.setTimeout(5 * RELIEF_TIMEOUT_MS);
    // Still the desktop layout, with fewer pixels to draw in software
    await page.setViewportSize({ width: 800, height: 500 });
    const field = await airportPosition(page, await homeField(page));
    const place = await lowPassNear(page, field);
    expect(place, "a flight low near the home field").not.toBeNull();
    // Zoomed in first, the flights are cut for the 3D view once. The 3D
    // button leaves the heatmap alone, which it draws as the cloud, and
    // the ribbons come with the altitude colours, turned on before: over
    // a busy field their values show nearly everywhere, and the readout
    // has to work beside them and the markers
    await jumpToView(page, field, 12);
    await layerButton(page, "altitude").click();
    await expect(layerButton(page, "altitude")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await page.locator("#three-d-btn").click();
    await reliefExpect
      .poll(() => heatCloudOnMap(page))
      .toMatchObject({ onMap: true, stepsIn: true });
    await reliefExpect(layerButton(page, "altitude")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await reliefExpect(layerButton(page, "airports")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // Tilted by now (the specs run with reduced motion), and at rest. Not
    // map.loaded(): in software WebGL the whole map is not loaded for
    // minutes (see 3d-relief.spec.ts), and the readout needs none of it
    await reliefExpect
      .poll(() =>
        page.evaluate(() => {
          const map = window.mapApp!.map!;
          return map.getPitch() > 0 && !map.isMoving();
        }),
      )
      .toBe(true);

    const readout = page.locator(".cloud-readout");
    const surface = (await mapSurface(page).boundingBox())!;
    let pointer = { x: 0, y: 0 };
    // The relief can land later and move the place on the screen: it is
    // looked for anew until the box shows
    await expect(async () => {
      const at = await containerPoint(page, place!);
      pointer = { x: surface.x + at.x, y: surface.y + at.y };
      await page.mouse.move(pointer.x - 5, pointer.y);
      await page.mouse.move(pointer.x, pointer.y);
      await expect(readout).toBeVisible({ timeout: RELIEF_TIMEOUT_MS / 3 });
    }).toPass({ timeout: RELIEF_TIMEOUT_MS });

    // "About 42 min within 1 km" over "17 flights · mostly 800 to 1,200 ft
    // AGL": the time, never a date or an hour
    await reliefExpect(readout.locator("b")).toHaveText(
      /^(Under a minute|About [\d,]+ (min|h)( \d+ min)?) within [\d,]+ k?m$/,
    );
    await reliefExpect(readout.locator("div")).toHaveText(
      /^[\d,]+ flights? · (mostly|most often) [\d,]+ to [\d,]+ ft AGL$/,
    );
    // Beside the pointer, not over what it points at
    const box = (await readout.boundingBox())!;
    const covers =
      pointer.x >= box.x &&
      pointer.x <= box.x + box.width &&
      pointer.y >= box.y &&
      pointer.y <= box.y + box.height;
    expect(covers, "the readout covers the pointer").toBe(false);
    // Nor over the values of a ribbon the pointer is on, which may come
    // up a moment later (a look once the map is idle)
    await reliefExpect.poll(() => readoutOverValues(page)).toBe(false);
    // It takes no pointer events: the map under it keeps its gestures
    await reliefExpect(readout).toHaveCSS("pointer-events", "none");

    await page.keyboard.press("Escape");
    await reliefExpect(readout).toBeHidden();
    // Back once the pointer moves on
    await page.mouse.move(pointer.x + 20, pointer.y);
    await page.mouse.move(pointer.x, pointer.y);
    await reliefExpect(readout).toBeVisible();

    // Out of the 3D view there is no readout
    await page.locator("#three-d-btn").click();
    await reliefExpect(readout).toBeHidden();
  });
});
