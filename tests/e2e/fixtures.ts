/**
 * Hermetic Playwright test fixture.
 *
 * The page carries its own JavaScript and CSS (see scripts/vendor.js), so
 * the only third parties left are CARTO, for the base map, and the open
 * flightmaps tile server. An outage of either used to fail the whole suite
 * and a slow one made timings unpredictable, so neither is ever reached: the
 * base style is answered with one that draws a background and asks for
 * nothing else, and every tile with a transparent pixel.
 *
 * Any other cross-origin request fails the test that made it. The page is
 * meant to need nothing but its own host; a dependency that creeps back
 * onto a CDN would otherwise only show up as a blank map for visitors.
 *
 * Every spec imports `test` and `expect` from here instead of
 * "@playwright/test" so the fixture is active everywhere.
 */
import { test as base, expect } from "@playwright/test";
import type { BrowserContext, Route } from "@playwright/test";

/**
 * A 1x1 transparent PNG, served for every map tile. A well-formed one: the
 * map decodes its tiles with createImageBitmap, which refuses a file whose
 * checksums are off where an <img> would still draw it.
 */
const TRANSPARENT_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII=",
  "base64",
);

/**
 * The base style the page gets in place of CARTO's: a background and one
 * raster layer whose tiles the fixture answers itself. Without glyphs or a
 * sprite the map is ready after this one answer. The raster source is there
 * for its credit: the map shows the attribution of the sources it draws, so
 * a style without one would leave the tile credit, which the specs check,
 * empty. The colour is the one of the real style's background, so
 * screenshots keep their dark map.
 */
const STUB_STYLE = {
  version: 8,
  name: "hermetic",
  sources: {
    base: {
      type: "raster",
      tiles: ["https://tiles.basemaps.cartocdn.com/stub/{z}/{x}/{y}.png"],
      tileSize: 512,
      attribution:
        '&copy; <a href="https://carto.com/about-carto/">CARTO</a>, &copy; <a href="http://www.openstreetmap.org/about/">OpenStreetMap</a> contributors',
    },
  },
  layers: [
    {
      id: "background",
      type: "background",
      paint: { "background-color": "#0e0e0e" },
    },
    { id: "base", type: "raster", source: "base" },
  ],
};

/** The origins the page is allowed to reach */
const CARTO_STYLE_HOST = "basemaps.cartocdn.com";
const TILE_HOSTS = [
  // Vector tiles come from tiles-a to tiles-d, glyphs and the sprite from
  // tiles; the stub style asks for none of them, but a request that does
  // get out is answered rather than failing the test for CARTO's layout
  /^tiles(-[a-d])?\.basemaps\.cartocdn\.com$/,
  /^nwy-tiles-api\.prod\.newaydata\.com$/,
];

/** The site under test, served by the webServer in playwright.config.ts */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isBaseStyle(url: URL): boolean {
  return (
    url.hostname === CARTO_STYLE_HOST &&
    url.pathname.endsWith("/dark-matter-gl-style/style.json")
  );
}

function isTile(url: URL): boolean {
  return TILE_HOSTS.some((host) => host.test(url.hostname));
}

function isSite(url: URL): boolean {
  return LOCAL_HOSTS.has(url.hostname);
}

async function serveTransparentTile(route: Route): Promise<void> {
  await route.fulfill({
    body: TRANSPARENT_PNG,
    contentType: "image/png",
    // MapLibre fetches its tiles, so they are subject to CORS
    headers: { "access-control-allow-origin": "*" },
  });
}

async function serveStubStyle(route: Route): Promise<void> {
  await route.fulfill({
    json: STUB_STYLE,
    headers: { "access-control-allow-origin": "*" },
  });
}

/**
 * Install the routes on a browser context.
 *
 * Returns the list that collects forbidden requests, so a caller can assert
 * on it; the fixture below fails the test when it is not empty. The
 * predicates are mutually exclusive, so it does not matter in which order
 * Playwright matches them.
 */
async function installHermeticRoutes(
  context: BrowserContext,
): Promise<string[]> {
  const offSite: string[] = [];
  await context.route(isBaseStyle, serveStubStyle);
  await context.route(isTile, serveTransparentTile);
  await context.route(
    (url) => !isSite(url) && !isTile(url) && !isBaseStyle(url),
    async (route) => {
      offSite.push(route.request().url());
      await route.abort("blockedbyclient");
    },
  );
  return offSite;
}

export const test = base.extend<{ hermetic: void }>({
  hermetic: [
    async ({ context }, use) => {
      const offSite = await installHermeticRoutes(context);
      await use();
      expect(
        offSite,
        "the page requested a third-party URL; it is meant to carry its " +
          "own assets and work offline",
      ).toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
export type { Locator, Page } from "@playwright/test";
