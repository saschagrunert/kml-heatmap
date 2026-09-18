/**
 * Hermetic Playwright test fixture.
 *
 * The page carries its own JavaScript and CSS (see scripts/vendor.js), so
 * the only third parties left are the CARTO and OpenAIP tile servers. An
 * outage of either used to fail the whole suite and a slow one made timings
 * unpredictable, so every tile is answered with a transparent pixel.
 *
 * Any other cross-origin request fails the test that made it. The page is
 * meant to work offline and from `file://`; a dependency that creeps back
 * onto a CDN would otherwise only show up as a blank map for visitors.
 *
 * Every spec imports `test` and `expect` from here instead of
 * "@playwright/test" so the fixture is active everywhere.
 */
import { test as base, expect } from "@playwright/test";
import type { BrowserContext, Route } from "@playwright/test";

/** A 1x1 transparent PNG, served for every map tile */
const TRANSPARENT_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

/** The origins the page is allowed to reach, tiles only */
const TILE_HOSTS = [
  /^[a-d]\.basemaps\.cartocdn\.com$/,
  /^[a-z]\.api\.tiles\.openaip\.net$/,
];

/** The site under test, served by the webServer in playwright.config.ts */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isTile(url: URL): boolean {
  return TILE_HOSTS.some((host) => host.test(url.hostname));
}

function isSite(url: URL): boolean {
  // file:// has an empty hostname; the file-protocol spec loads the page
  // straight off disk
  return url.protocol === "file:" || LOCAL_HOSTS.has(url.hostname);
}

async function serveTransparentTile(route: Route): Promise<void> {
  await route.fulfill({ body: TRANSPARENT_PNG, contentType: "image/png" });
}

/**
 * Install the routes on a browser context.
 *
 * Returns the list that collects forbidden requests, so a caller can assert
 * on it; the fixture below fails the test when it is not empty. The two
 * predicates are mutually exclusive, so it does not matter in which order
 * Playwright matches them.
 */
export async function installHermeticRoutes(
  context: BrowserContext,
): Promise<string[]> {
  const offSite: string[] = [];
  await context.route(isTile, serveTransparentTile);
  await context.route(
    (url) => !isSite(url) && !isTile(url),
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
export type { BrowserContext, Locator, Page } from "@playwright/test";
