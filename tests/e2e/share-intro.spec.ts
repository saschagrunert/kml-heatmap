/**
 * The intro of a link to shared flights: Copy link in share mode marks the
 * link, which opens with the shared flights drawn in one after another as
 * the camera frames them, once. The mark is gone from the address bar as
 * the page opens, so a reload does not play the intro again.
 */
import { test, expect } from "./fixtures";
import type { Page } from "./fixtures";
import { gotoApp, waitForAppReady } from "./helpers";

/** The id of the intro's layer on the map */
const LAYER = "share-intro";

/**
 * Note from the start of every page load the most frames the intro's layer
 * has drawn, in `window.introFrames`: the intro may well be over by the time
 * the app says it is ready in software WebGL
 */
async function watchIntro(page: Page): Promise<void> {
  await page.addInitScript((layer) => {
    const w = window as unknown as { introFrames: number };
    w.introFrames = 0;
    setInterval(() => {
      const drawn = window.mapApp?.map?.getLayer(layer) as
        { implementation?: { frames: number } } | undefined;
      w.introFrames = Math.max(
        w.introFrames,
        drawn?.implementation?.frames ?? 0,
      );
    }, 50);
  }, LAYER);
}

function introFrames(page: Page): Promise<number> {
  return page.evaluate(
    () => (window as unknown as { introFrames: number }).introFrames,
  );
}

/** Whether every fix of the shared flights is on the map */
function sharedFlightsFramed(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const app = window.mapApp!;
    const map = app.map!;
    const { width, height } = map.getContainer().getBoundingClientRect();
    return app
      .currentData!.path_segments.filter((s) =>
        app.selectedPathIds.has(s.path_id),
      )
      .every((segment) =>
        segment.coords.every(([lat, lng]) => {
          const { x, y } = map.project([lng, lat]);
          return x >= 0 && x <= width && y >= 0 && y <= height;
        }),
      );
  });
}

/**
 * Share the first two flights, move the view off them, as a link may be
 * copied from anywhere, and hand on the link Copy link copies
 */
async function copyShareLink(page: Page): Promise<string> {
  await page.evaluate(() => {
    const app = window.mapApp!;
    app.store.batch(() => {
      for (const path of app.fullPathInfo!.slice(0, 2)) {
        app.selectedPathIds.add(path.id);
      }
      app.store.notifyMutation("selectedPathIds");
      app.isolateSelection = true;
    });
    app.map!.jumpTo({ zoom: 3 });
    const w = window as unknown as { copied: string };
    Object.defineProperty(navigator.clipboard, "writeText", {
      value: (text: string) => {
        w.copied = text;
        return Promise.resolve();
      },
    });
  });
  await page.locator("#selection-link-btn").click();
  return page.evaluate(() => (window as unknown as { copied: string }).copied);
}

/** Where the camera of the map is */
function camera(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const map = window.mapApp!.map!;
    const { lng, lat } = map.getCenter();
    return [lng, lat, map.getZoom(), map.getBearing(), map.getPitch()];
  });
}

test.describe("The intro of a link to shared flights", () => {
  // The intro is motion, which the projects turn off (playwright.config.ts):
  // under reduced motion the flights are only framed
  test.use({ reducedMotion: "no-preference" });

  test("plays once from a link copied in share mode, framing the flights @desktop", async ({
    page,
  }) => {
    test.slow();
    await watchIntro(page);
    await gotoApp(page);

    const link = await copyShareLink(page);
    expect(new URL(link).searchParams.get("i")).toBe("1");
    // The address bar never carries it
    expect(new URL(page.url()).searchParams.has("i")).toBe(false);

    await page.goto(link);
    // Taken off the link as the page opens
    await expect
      .poll(() => page.evaluate(() => location.search))
      .not.toContain("i=1");
    await expect
      .poll(() => introFrames(page), { timeout: 20000 })
      .toBeGreaterThan(0);
    // Played to the end, or skipped by a click on the map by its right
    // edge, below the column of controls: the trails give way to the lines
    // of the flights, which are framed
    const { width, height } = page.viewportSize()!;
    await page.mouse.click(width - 8, height * 0.6);
    await expect
      .poll(
        () =>
          page.evaluate(
            (layer) => !!window.mapApp!.map!.getLayer(layer),
            LAYER,
          ),
        { timeout: 15000 },
      )
      .toBe(false);
    expect(await sharedFlightsFramed(page)).toBe(true);
    expect(
      await page.evaluate(() =>
        window.mapApp!.map!.getLayoutProperty(
          "selection-highlight",
          "visibility",
        ),
      ),
    ).toBe("visible");
    expect(await page.evaluate(() => window.mapApp!.isolateSelection)).toBe(
      true,
    );

    // A reload plays nothing: the feature bundle is in (the profile of the
    // shared flights fetches it), and no intro started with it
    await page.reload();
    await waitForAppReady(page);
    await expect(page.locator("#flight-profile")).toBeVisible({
      timeout: 15000,
    });
    await page.waitForTimeout(1000);
    expect(await introFrames(page)).toBe(0);
    expect(new URL(page.url()).searchParams.has("i")).toBe(false);
  });

  test("does not play over a view the visitor moved before it could start @desktop", async ({
    page,
  }) => {
    test.slow();
    await watchIntro(page);
    await gotoApp(page);
    const link = await copyShareLink(page);

    // The feature bundle, which the intro is in, held back as on a slow
    // line, while the visitor turns the wheel over the map
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route("**/features.bundle.js*", async (route) => {
      await held;
      await route.continue();
    });
    await page.goto(link, { waitUntil: "domcontentloaded" });
    await expect
      .poll(() => page.evaluate(() => location.search))
      .not.toContain("i=1");
    const { width, height } = page.viewportSize()!;
    await page.mouse.move(width / 2, height / 2);
    await page.mouse.wheel(0, -400);
    await waitForAppReady(page);
    const view = await camera(page);

    // In comes the bundle (the profile of the shared flights fetches it
    // too), and the view stays the visitor's
    release();
    await expect(page.locator("#flight-profile")).toBeVisible({
      timeout: 15000,
    });
    await page.waitForTimeout(1000);
    expect(await introFrames(page)).toBe(0);
    expect(await camera(page)).toEqual(view);
  });
});
